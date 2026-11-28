import { Agent, fetch as directFetch } from "undici";
import { LOW_DETAIL_TOKENS, validateVision } from "@/lib/workspaceVision.js";

const dispatcher = new Agent();
const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const fail = (status, message) => Response.json({ error: { message, type: "tokyard_error" } }, { status, headers: { "Cache-Control": "no-store" } });

export async function dispatchMeteredVision({ body, meter, credentials, signal, transport = directFetch }) {
  const vision = meter?.vision;
  if (vision?.model !== "gpt-4o" || typeof vision.url !== "string" || !Number.isSafeInteger(vision.inputBound) || (meter.outputCap !== null && (!Number.isSafeInteger(meter.outputCap) || meter.outputCap < 1)) || !body || (body.n !== undefined && body.n !== 1) || (body.stream !== undefined && typeof body.stream !== "boolean")) return fail(403, "Unsupported metered vision request");
  const limits = [body.max_tokens, body.max_completion_tokens, body.max_output_tokens].filter(value => value !== undefined);
  if (meter.outputCap === null ? limits.length > 0 : limits.length !== 1 || limits[0] !== meter.outputCap) return fail(403, "Metered vision output limit mismatch");
  const data = credentials?.providerSpecificData || {};
  if (!credentials?.apiKey || (credentials.authType && credentials.authType !== "apikey") || data.baseUrl || data.connectionProxyEnabled || data.connectionProxyPoolId || data.vercelRelayUrl || data.strictProxy || (Array.isArray(data.enabledModels) && data.enabledModels.length && !data.enabledModels.includes(vision.model)) || ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].some(k => process.env[k])) return fail(403, "OpenAI connection configuration is incompatible with metered vision");
  // Check the actual wire body against admission before it can reach any upstream.
  let image;
  try { image = validateVision(body, "/v1/chat/completions", { provider: "openai", model: vision.model }); }
  catch { return fail(403, "Unsupported metered vision content"); }
  if (image.url !== vision.url) return fail(403, "Metered vision image changed after admission");
  const outbound = { ...body, model: vision.model };
  if (meter.outputCap !== null) outbound.max_tokens = meter.outputCap;
  delete outbound.max_completion_tokens;
  delete outbound.max_output_tokens;
  if (outbound.stream) outbound.stream_options = { include_usage: true };
  else delete outbound.stream_options;
  const wire = JSON.stringify(outbound);
  if (Buffer.byteLength(wire) - Buffer.byteLength(vision.url) + LOW_DETAIL_TOKENS > vision.inputBound) return fail(403, "Metered vision input exceeds reservation");
  let response;
  try {
    meter.onDispatch();
    response = await transport(ENDPOINT, { method: "POST", headers: { authorization: `Bearer ${credentials.apiKey}`, "content-type": "application/json" }, body: wire, signal, redirect: "manual", dispatcher });
  } catch { return fail(502, "OpenAI vision request failed"); }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); return fail(response.status >= 400 && response.status <= 599 ? response.status : 502, "OpenAI vision request failed"); }
  if (!outbound.stream) {
    let bytes;
    try { bytes = await response.arrayBuffer(); } catch { return fail(502, "OpenAI vision response failed"); }
    try { meter.onUsage(JSON.parse(new TextDecoder().decode(bytes)).usage); } catch {}
    return new Response(bytes, { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) { await response.body?.cancel().catch(() => {}); return fail(502, "Invalid OpenAI vision stream"); }
  const decoder = new TextDecoder();
  let pending = "";
  const stream = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop();
      if (pending.length > 1048576) pending = "";
      for (const line of lines) if (line.startsWith("data:")) {
        try { const parsed = JSON.parse(line.slice(5).trim()); if (parsed.usage) meter.onUsage(parsed.usage); } catch {}
      }
      controller.enqueue(chunk);
    },
  }));
  return new Response(stream, { status: response.status, headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}
