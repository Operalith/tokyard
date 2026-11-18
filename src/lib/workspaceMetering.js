import { getApiKeyByKey } from "./db/repos/apiKeysRepo.js";
import { getWorkspaceUser, getUserBudget, reserveWorkspaceTokens, settleWorkspaceTokens, markWorkspaceUncertain, WorkspaceError } from "./workspace.js";
import { extractClientApiKey, getKeyAccessContext, enforceKeyAccess } from "@/sse/services/keyAccess.js";
import { getModelInfo, getComboModels } from "@/sse/services/model.js";
import { canonicalizeUsage } from "open-sse/utils/usageTracking.js";

const MAX_BODY_BYTES = 1024 * 1024;
const INPUT_OVERHEAD_TOKENS = 2048;
const UNSUPPORTED_CONTENT = new Set(["image_url", "input_image", "image", "input_audio", "audio", "video", "document", "file", "input_file"]);

function hasUnsupportedContent(value, depth = 0) {
  if (!value || typeof value !== "object") return false;
  if (depth > 32) throw new WorkspaceError("Request nesting exceeds 32 levels");
  if (UNSUPPORTED_CONTENT.has(value.type)) return true;
  return Object.values(value).some(v => typeof v === "object" && hasUnsupportedContent(v, depth + 1));
}

export async function meterWorkspaceChat(request, dispatch) {
  const presented = extractClientApiKey(request);
  if (!presented?.startsWith("ty_")) return dispatch(request);
  let reservation, context;
  try {
    const key = await getApiKeyByKey(presented);
    if (!key?.isActive || !key.userId) throw new WorkspaceError("Invalid API key", 401);
    const user = await getWorkspaceUser(key.userId);
    const raw = await request.clone().text();
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new WorkspaceError("Text request exceeds 1 MiB", 413);
    let body;
    try { body = JSON.parse(raw); } catch { throw new WorkspaceError("Invalid JSON"); }
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.model !== "string" || !body.model || body.model.length > 256) throw new WorkspaceError("A valid model is required");
    if (hasUnsupportedContent(body) || body.audio || body.video || body.image || (body.modalities && (!Array.isArray(body.modalities) || body.modalities.some(m => m !== "text")))) throw new WorkspaceError("Metered keys currently support text requests only", 403);
    if (body.n !== undefined && body.n !== 1) throw new WorkspaceError("Metered requests require n = 1");
    if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some(t => !t || typeof t !== "object" || (t.type && t.type !== "function") || (!t.type && typeof t.name !== "string")))) throw new WorkspaceError("Only function tools are supported for metered keys", 403);
    if (body.stream !== undefined && typeof body.stream !== "boolean") throw new WorkspaceError("stream must be a boolean");
    if (body.previous_response_id || body.conversation || body.background) throw new WorkspaceError("Metered requests require explicit text history and synchronous execution", 403);
    const info = await getModelInfo(body.model);
    if (!info?.provider || info.provider === "systemone" || await getComboModels(body.model)) throw new WorkspaceError("Use a direct text model with metered keys; combo and smart routing are not yet supported", 403);
    const denied = await enforceKeyAccess(await getKeyAccessContext(request), body.model);
    if (denied) return denied;
    for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
      if (body[field] !== undefined && (!Number.isSafeInteger(body[field]) || body[field] < 1)) throw new WorkspaceError(`${field} must be a positive integer`);
    }
    // Conservative UTF-8 byte bound, not a claim about provider tokenization.
    const inputBound = Buffer.byteLength(raw) + INPUT_OVERHEAD_TOKENS;
    const budget = await getUserBudget(user.id);
    const requestedOutput = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens ?? user.maxOutputTokens;
    const balances = [
      ["monthly", user.tokenLimitOverride === null ? "profile" : "personal override", budget],
      ["daily", user.dailyTokenLimitOverride === null ? "profile" : "personal override", budget.daily],
      ...(budget.shared ? [["monthly", "shared profile pool", budget.shared], ["daily", "shared profile pool", budget.shared.daily]] : []),
    ].filter(([, , balance]) => balance.remaining !== null);
    const [period, source, limiting] = balances.reduce((smallest, entry) => entry[2].remaining <= smallest[2].remaining ? entry : smallest);
    const remaining = limiting.remaining;
    const output = Math.min(requestedOutput, user.maxOutputTokens, remaining - inputBound);
    if (output < 1) {
      const balance = limiting;
      throw new WorkspaceError(`Insufficient ${period} token allowance for this request: ${balance.remaining} remaining (${balance.limit} ${source} limit, ${balance.consumed} used, ${balance.reserved} held); at least ${inputBound + 1} required. Reduce request history or increase the ${period} ${source} limit.`, 429);
    }
    const path = new URL(request.url).pathname;
    const field = path.endsWith("/responses") || path.startsWith("/codex/") ? "max_output_tokens" : body.max_completion_tokens !== undefined ? "max_completion_tokens" : "max_tokens";
    for (const name of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) delete body[name];
    body[field] = output;
    if (body.stream === true && path.endsWith("/chat/completions")) body.stream_options = { ...body.stream_options, include_usage: true };
    reservation = await reserveWorkspaceTokens(key.id, inputBound + output, body.model);
    context = {
      keyId: key.id, dispatches: 0, usage: null,
      onDispatch() { this.dispatches += 1; },
      onUsage(usage) {
        if (usage?.estimated) return;
        if (!usage || ![usage.prompt_tokens ?? usage.input_tokens, usage.completion_tokens ?? usage.output_tokens].every(n => Number.isSafeInteger(n) && n >= 0)) return;
        const normalized = canonicalizeUsage(usage);
        if (!normalized) return;
        const input = normalized.prompt_tokens, output = normalized.completion_tokens;
        if ([input, output].every(n => Number.isSafeInteger(n) && n >= 0)) this.usage = Math.max(input + output, Number.isSafeInteger(usage.total_tokens) ? usage.total_tokens : 0);
      },
    };
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    const metered = new Request(request.url, { method: request.method, headers, body: JSON.stringify(body), signal: request.signal });
    metered.tokyardMeter = context;
    let finished = null;
    const finish = (reason) => finished ||= (async () => {
      if (context.usage !== null && context.dispatches <= 1) await settleWorkspaceTokens(reservation.id, context.usage);
      else if (context.dispatches === 0) await settleWorkspaceTokens(reservation.id, 0, "local");
      else await markWorkspaceUncertain(reservation.id, reason || "No reliable final usage; reservation remains held for reconciliation");
    })();
    const response = await dispatch(metered);
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("X-TokYard-Request-Id", reservation.id);
    responseHeaders.set("Cache-Control", "no-store");
    if (!response.body) { await finish(); return new Response(null, { status: response.status, headers: responseHeaders }); }
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      const bytes = await new Response(response.body).arrayBuffer().catch(() => null);
      await finish();
      if (!bytes) throw new Error("Could not read provider response");
      return new Response(bytes, { status: response.status, headers: responseHeaders });
    }
    const reader = response.body.getReader();
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { await finish(); controller.close(); }
          else controller.enqueue(value);
        } catch (error) {
          try { await finish("Stream failed before final usage was available"); } catch {}
          controller.error(error);
        }
      },
      async cancel(reason) {
        try { await reader.cancel(reason); }
        finally { await finish("Client disconnected before final usage was available"); }
      },
    });
    return new Response(stream, { status: response.status, headers: responseHeaders });
  } catch (error) {
    if (reservation) {
      try {
        if (context?.dispatches === 0) await settleWorkspaceTokens(reservation.id, 0, "local");
        else await markWorkspaceUncertain(reservation.id, "Request failed; usage requires reconciliation");
      } catch (ledgerError) { console.error("[TokYard] Reservation remains held", reservation.id, ledgerError.message); }
    }
    const status = error instanceof WorkspaceError ? error.status : 503;
    return Response.json({ error: { message: error instanceof WorkspaceError ? error.message : "Metered request failed; reserved tokens remain protected", type: "tokyard_error" } }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
