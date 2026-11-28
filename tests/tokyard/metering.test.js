import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, test, expect, vi } from "vitest";

vi.mock("@/sse/services/model.js", () => ({ getModelInfo: async model => ({ provider: model === "smart" ? "systemone" : "openai", model: model.startsWith("openai/") ? model.slice(7) : model }), getComboModels: async model => model === "combo" ? ["openai/test"] : null }));
vi.mock("@/sse/services/keyAccess.js", async () => ({
  extractClientApiKey: request => request.headers.get("authorization")?.slice(7),
  getKeyAccessContext: async () => null, enforceKeyAccess: async () => null,
}));
let dir, w, db, key, user, meter;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokyard-meter-"));
  process.env.DATA_DIR = dir;
  delete global._dbAdapter;
  vi.resetModules();
  w = await import("@/lib/workspace.js");
  db = await w.ensureWorkspace();
  user = await w.createWorkspaceUser({ name: "Member", email: "member@example.com", password: "test-password-123" });
  key = await w.createWorkspaceKey(user.id, "Test");
  meter = (await import("@/lib/workspaceMetering.js")).meterWorkspaceChat;
});
afterEach(() => { db?.close(); delete global._dbAdapter; fs.rmSync(dir, { recursive: true, force: true }); });
const request = (key, body = {}, url = "/v1/chat/completions") => new Request(`http://localhost${url}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: "openai/test", messages: [{ role: "user", content: "Hello" }], ...body }) });

test("JSON response settles raw usage and clamps output before dispatch", async () => {
  const response = await meter(request(key.key, { max_tokens: 99999 }), async req => {
    expect((await req.json()).max_tokens).toBe(4096);
    expect(req.tokyardMeter.keyId).toBe(key.id);
    req.tokyardMeter.onDispatch();
    req.tokyardMeter.onUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 7 });
    return Response.json({ choices: [{ message: { content: "Hi" } }] });
  });
  expect(response.status).toBe(200);
  expect((await response.json()).choices[0].message.content).toBe("Hi");
  expect(response.headers.get("x-tokyard-request-id")).toBeTruthy();
  expect(await w.getUserBudget(user.id)).toMatchObject({ consumed: 42, inputTokens: 37, outputTokens: 5, unclassifiedTokens: 0, reserved: 0 });
});

test.each(["/v1/chat/completions", "/v1/messages", "/v1/responses"])("usage-only %s tracks usage with exhausted personal and shared limits", async url => {
  await w.saveProfile({ usageOnly: true, tokenLimit: 0, dailyTokenLimit: 0, quotaMode: "shared", sharedTokenLimit: 0, sharedDailyTokenLimit: 0 }, "standard");
  await w.updateWorkspaceUser(user.id, { tokenLimit: 0, dailyTokenLimit: 0 });
  for (const clientKey of [key, await w.createWorkspaceKey(user.id, "Another client")]) {
    const response = await meter(request(clientKey.key, { max_tokens: 131072 }, url), async req => {
      const body = await req.json();
      expect(body.max_output_tokens ?? body.max_tokens).toBe(131072);
      expect(req.tokyardMeter.outputCap).toBe(131072);
      req.tokyardMeter.onDispatch();
      req.tokyardMeter.onUsage({ prompt_tokens: 700000, completion_tokens: 7 });
      return Response.json({});
    });
    expect(response.status).toBe(200);
  }
  expect(await w.getUserBudget(user.id)).toMatchObject({ consumed: 1400014, reserved: 0, limit: null, remaining: null, available: null, shared: null, daily: { limit: null, consumed: 1400014 } });
  await w.saveProfile({ usageOnly: false }, "standard");
  const dispatch = vi.fn();
  expect((await meter(request(key.key), dispatch)).status).toBe(429);
  expect(dispatch).not.toHaveBeenCalled();
});

test.each(["/v1/chat/completions", "/v1/messages", "/v1/responses"])("usage-only %s leaves omitted output limits unset and settles actual usage", async url => {
  await w.saveProfile({ usageOnly: true, maxOutputTokens: 1 }, "standard");
  const original = request(key.key, {}, url);
  const inputBound = Buffer.byteLength(await original.clone().text()) + 2048;
  const response = await meter(original, async req => {
    const body = await req.json();
    for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) expect(body[field]).toBeUndefined();
    expect(req.tokyardMeter.outputCap).toBeNull();
    expect((await w.getUserBudget(user.id)).reserved).toBe(inputBound);
    req.tokyardMeter.onDispatch();
    req.tokyardMeter.onUsage({ prompt_tokens: 20, completion_tokens: 65536 });
    return Response.json({});
  });
  expect(response.status).toBe(200);
  expect(await w.getUserBudget(user.id)).toMatchObject({ consumed: 65556, reserved: 0 });
});

test.each(["fixed", "shared"])("%s profiles enforce configured output caps above 32K", async quotaMode => {
  await w.saveProfile({ maxOutputTokens: 131072, quotaMode, sharedTokenLimit: 1000000 }, "standard");
  const response = await meter(request(key.key, { max_completion_tokens: 200000 }), async req => {
    expect((await req.json()).max_completion_tokens).toBe(131072);
    expect(req.tokyardMeter.outputCap).toBe(131072);
    req.tokyardMeter.onDispatch();
    req.tokyardMeter.onUsage({ prompt_tokens: 10, completion_tokens: 65536 });
    return Response.json({});
  });
  expect(response.status).toBe(200);
  expect(await w.getUserBudget(user.id)).toMatchObject({ consumed: 65546, reserved: 0 });
});

test("usage-only streams settle, missing usage stays visible, and revoked keys cannot dispatch", async () => {
  await w.saveProfile({ usageOnly: true, tokenLimit: 0, dailyTokenLimit: 0 }, "standard");
  const response = await meter(request(key.key, { stream: true }), async req => {
    expect((await req.json()).stream_options.include_usage).toBe(true);
    req.tokyardMeter.onDispatch();
    req.tokyardMeter.onUsage({ prompt_tokens: 15, completion_tokens: 5 });
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  await response.text();
  const missing = await meter(request(key.key), async req => { req.tokyardMeter.onDispatch(); return Response.json({}); });
  expect(missing.status).toBe(200);
  expect(await w.getUserBudget(user.id)).toMatchObject({ consumed: 20, inputTokens: 15, outputTokens: 5, limit: null });
  expect((await w.listWorkspaceRequests(user.id)).some(row => row.status === "uncertain")).toBe(true);
  await w.revokeWorkspaceKey(user.id, key.id);
  const dispatch = vi.fn();
  expect((await meter(request(key.key), dispatch)).status).toBe(401);
  expect(dispatch).not.toHaveBeenCalled();
});

test("output fits the smaller daily/monthly balance and daily exhaustion blocks before dispatch", async () => {
  await w.saveProfile({ dailyTokenLimit: 3000 }, "standard");
  for (const monthlyLimit of [1000000, 2500]) {
    await w.updateWorkspaceUser(user.id, { tokenLimit: monthlyLimit });
    const before = await w.getUserBudget(user.id);
    const req = request(key.key, { max_tokens: 99999 });
    const inputBound = Buffer.byteLength(await req.clone().text()) + 2048;
    const response = await meter(req, async metered => {
      expect((await metered.json()).max_tokens).toBe(Math.min(before.remaining, before.daily.remaining) - inputBound);
      metered.tokyardMeter.onDispatch();
      metered.tokyardMeter.onUsage({ input_tokens: 30, output_tokens: 7 });
      return Response.json({});
    });
    expect(response.status).toBe(200);
  }
  expect(await w.getUserBudget(user.id)).toMatchObject({ consumed: 74, reserved: 0, daily: { consumed: 74, reserved: 0 } });
  await w.updateWorkspaceUser(user.id, { dailyTokenLimit: 0 });
  const dispatch = vi.fn();
  const denied = await meter(request(key.key), dispatch);
  expect(denied.status).toBe(429);
  expect((await denied.json()).error.message).toContain("daily");
  expect(dispatch).not.toHaveBeenCalled();
});

test.each(["tokenLimit", "dailyTokenLimit"])("increasing profile %s immediately unblocks an exhausted existing key", async field => {
  await w.saveProfile({ [field]: 10000 }, "standard");
  const dispatch = vi.fn(async req => {
    req.tokyardMeter.onDispatch();
    req.tokyardMeter.onUsage({ input_tokens: 9990, output_tokens: 10 });
    return Response.json({});
  });
  expect((await meter(request(key.key), dispatch)).status).toBe(200);
  expect((await meter(request(key.key), dispatch)).status).toBe(429);
  expect(dispatch).toHaveBeenCalledTimes(1);
  await w.saveProfile({ [field]: 25000 }, "standard");
  expect((await meter(request(key.key), dispatch)).status).toBe(200);
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(await w.getUserBudget(user.id)).toMatchObject({ consumed: 20000, reserved: 0 });
});

test.each(["sharedTokenLimit", "sharedDailyTokenLimit"])("output fits %s and pool rejection explains the limiting balance", async field => {
  await w.saveProfile({ quotaMode: "shared", sharedTokenLimit: 5000, sharedDailyTokenLimit: 5000, [field]: 3000 }, "standard");
  const other = await w.createWorkspaceUser({ name: "Other", email: "other@example.test", password: "test-password-123" });
  const otherKey = await w.createWorkspaceKey(other.id, "Other client");
  const previous = await w.reserveWorkspaceTokens(otherKey.id, 500, "openai/test");
  await w.settleWorkspaceTokens(previous.id, 500);
  const before = await w.getUserBudget(user.id);
  expect(before.available).toBe(2500);
  const req = request(key.key, { max_tokens: 99999 });
  const inputBound = Buffer.byteLength(await req.clone().text()) + 2048;
  const response = await meter(req, async metered => {
    expect((await metered.json()).max_tokens).toBe(2500 - inputBound);
    metered.tokyardMeter.onDispatch();
    metered.tokyardMeter.onUsage({ prompt_tokens: 20, completion_tokens: 10 });
    return Response.json({});
  });
  expect(response.status).toBe(200);
  expect((await w.getUserBudget(user.id)).available).toBe(2470);
  const dispatch = vi.fn();
  const denied = await meter(request(key.key, { messages: [{ role: "user", content: "x".repeat(1000) }] }), dispatch);
  expect(denied.status).toBe(429);
  const message = (await denied.json()).error.message;
  for (const detail of [field === "sharedTokenLimit" ? "monthly" : "daily", "shared profile pool", "3000", "530", "2470"]) expect(message).toContain(detail);
  expect(dispatch).not.toHaveBeenCalled();
});

test("insufficient balance explains the updated limit, used tokens and minimum reservation", async () => {
  await w.saveProfile({ tokenLimit: 10000 }, "standard");
  const previous = await w.reserveWorkspaceTokens(key.id, 10000, "openai/test");
  await w.settleWorkspaceTokens(previous.id, 10000);
  await w.saveProfile({ tokenLimit: 25000 }, "standard");
  const req = request(key.key, { messages: [{ role: "user", content: "x".repeat(14000) }] });
  const required = Buffer.byteLength(await req.clone().text()) + 2048 + 1;
  const dispatch = vi.fn();
  const response = await meter(req, dispatch);
  expect(response.status).toBe(429);
  const message = (await response.json()).error.message;
  for (const detail of ["monthly", "25000", "10000", "15000", String(required), "profile"]) expect(message).toContain(detail);
  expect(dispatch).not.toHaveBeenCalled();
  expect(await w.getUserBudget(user.id)).toMatchObject({ limit: 25000, consumed: 10000, reserved: 0, remaining: 15000 });
});

test.each(["tokenLimit", "dailyTokenLimit"])("a personal %s override stays explicit after increasing its profile", async field => {
  await w.updateWorkspaceUser(user.id, { [field]: 10000 });
  await w.saveProfile({ [field]: 25000 }, "standard");
  const req = request(key.key, { messages: [{ role: "user", content: "x".repeat(10000) }] });
  const dispatch = vi.fn();
  const response = await meter(req, dispatch);
  expect(response.status).toBe(429);
  expect((await response.json()).error.message).toContain("10000 personal override limit");
  expect(dispatch).not.toHaveBeenCalled();
  await w.updateWorkspaceUser(user.id, { [field]: null });
  expect((await meter(request(key.key), async () => Response.json({}))).status).toBe(200);
});

test("stream settles at EOF; estimated or missing usage stays held", async () => {
  const response = await meter(request(key.key, { stream: true }), async req => {
    req.tokyardMeter.onDispatch();
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); req.tokyardMeter.onUsage({ prompt_tokens: 15, completion_tokens: 5 }); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
  });
  await response.text();
  expect(await w.getUserBudget(user.id)).toMatchObject({ consumed: 20, reserved: 0 });
  const unknown = await meter(request(key.key), async req => { req.tokyardMeter.onDispatch(); req.tokyardMeter.onUsage({ prompt_tokens: 15, completion_tokens: 5, estimated: true }); return Response.json({}); });
  expect(unknown.status).toBe(200);
  expect((await w.getUserBudget(user.id)).reserved).toBeGreaterThan(0);
  expect((await w.listWorkspaceRequests(user.id)).some(r => r.status === "uncertain")).toBe(true);
});

test("disconnect never refunds unknown upstream usage", async () => {
  const response = await meter(request(key.key, { stream: true }), async req => { req.tokyardMeter.onDispatch(); return new Response(new ReadableStream({ pull() {} }), { headers: { "content-type": "text/event-stream" } }); });
  await response.body.cancel();
  expect((await w.getUserBudget(user.id)).reserved).toBeGreaterThan(0);
  expect((await w.listWorkspaceRequests(user.id))[0].status).toBe("uncertain");
});

test("output cap survives translator bumps for tools, Claude thinking and Gemini bodies", async () => {
  const { adjustMaxTokens, capOutputTokens } = await import("open-sse/translator/formats/maxTokens.js");
  // Why the cap must run after translation: tools alone lift 4096 to 32000.
  expect(adjustMaxTokens({ max_tokens: 4096, tools: [{}] }, 128000)).toBe(32000);
  expect(capOutputTokens({ max_tokens: 32000, max_completion_tokens: 32000 }, 4096)).toEqual({ max_tokens: 4096, max_completion_tokens: 4096 });
  expect(capOutputTokens({ max_tokens: 101024, thinking: { type: "enabled", budget_tokens: 100000 } }, 4096)).toEqual({ max_tokens: 4096, thinking: { type: "enabled", budget_tokens: 3072 } });
  expect(capOutputTokens({ max_tokens: 64000, thinking: { type: "enabled", budget_tokens: 10000 } }, 1024)).toEqual({ max_tokens: 1024 });
  // Gemini's maxOutputTokens includes thinking, so the budget is left as sent (forcing it could undercut model minimums).
  expect(capOutputTokens({ request: { generationConfig: { maxOutputTokens: 64000, thinkingConfig: { thinkingBudget: -1 } } } }, 4096))
    .toEqual({ request: { generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: -1 } } } });
  expect(capOutputTokens({ max_output_tokens: 10 }, 4096)).toEqual({ max_output_tokens: 10 });
});

test("a metered cap sent as max_completion_tokens reaches Gemini, Antigravity and Ollama", async () => {
  const { openaiToGeminiRequest, openaiToAntigravityRequest } = await import("open-sse/translator/request/openai-to-gemini.js");
  const { openaiToOllamaRequest } = await import("open-sse/translator/request/openai-to-ollama.js");
  // Metering keeps the client's field name; these translators used to read only max_tokens and send no limit at all.
  const body = () => ({ model: "gemini-2.5-flash", messages: [{ role: "user", content: "Hi" }], max_completion_tokens: 100 });
  expect(openaiToGeminiRequest("gemini-2.5-flash", body(), false).generationConfig.maxOutputTokens).toBe(100);
  expect(openaiToAntigravityRequest("gemini-2.5-flash", body(), false, { email: "member@example.com" }).request.generationConfig.maxOutputTokens).toBe(100);
  expect(openaiToOllamaRequest("llama3", body(), false).options.num_predict).toBe(100);
  expect(openaiToGeminiRequest("gemini-2.5-flash", { ...body(), max_tokens: 50 }, false).generationConfig.maxOutputTokens).toBe(50);
});

test("token-dense input is rejected at admission instead of overspending the allowance", async () => {
  await w.saveProfile({ tokenLimit: 25000 }, "standard");
  // "aA" never merges under cl100k_base: 40,000 content bytes are 40,000 tokens, so only a byte bound is safe.
  const dispatch = vi.fn();
  const response = await meter(request(key.key, { model: "openai/gpt-4-turbo", messages: [{ role: "user", content: "aA".repeat(20000) }], max_tokens: 1 }), dispatch);
  expect(response.status).toBe(429);
  expect(dispatch).not.toHaveBeenCalled();
  expect(await w.getUserBudget(user.id)).toMatchObject({ consumed: 0, reserved: 0 });
});

test("local rejection releases reservation; failed or retried upstream stays held", async () => {
  await meter(request(key.key), async () => Response.json({ error: "No credentials" }, { status: 404 }));
  expect(await w.getUserBudget(user.id)).toMatchObject({ consumed: 0, reserved: 0 });
  const response = await meter(request(key.key), async req => { req.tokyardMeter.onDispatch(); throw new Error("network failed"); });
  expect(response.status).toBe(503);
  expect((await w.getUserBudget(user.id)).reserved).toBeGreaterThan(0);
  await meter(request(key.key), async req => { req.tokyardMeter.onDispatch(); req.tokyardMeter.onDispatch(); req.tokyardMeter.onUsage({ prompt_tokens: 10, completion_tokens: 2 }); return Response.json({}); });
  expect((await w.listWorkspaceRequests(user.id)).filter(r => r.status === "uncertain")).toHaveLength(2);
});

test("invalid, multimodal, stateful and smart requests fail before dispatch", async () => {
  const dispatch = vi.fn();
  for (const body of [{ n: 2 }, { max_tokens: -1 }, { model: "combo" }, { model: "smart" }, { tools: [{ type: "web_search" }] }, { previous_response_id: "resp_old" }, { messages: [{ content: [{ type: "input_image", image_url: "https://example.com/x" }] }] }]) {
    const res = await meter(request(key.key, body), dispatch);
    expect(res.status).toBeGreaterThanOrEqual(400);
  }
  expect(dispatch).not.toHaveBeenCalled();
  expect(await w.getUserBudget(user.id)).toMatchObject({ consumed: 0, reserved: 0 });
});

const pngUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
const jpegUrl = "data:image/jpeg;base64,/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpAB//Z";
const imageBody = (url = pngUrl) => ({ model: "openai/gpt-4o", messages: [{ role: "user", content: [{ type: "text", text: "Describe" }, { type: "image_url", image_url: { url, detail: "low" } }] }], max_tokens: 10 });

test("low-detail image reserves text bound plus 85 and settles provider usage", async () => {
  const original = request(key.key, imageBody());
  const raw = await original.clone().text();
  const inputBound = Buffer.byteLength(raw) - Buffer.byteLength(JSON.stringify(pngUrl)) + 2048 + 85;
  const response = await meter(original, async req => {
    expect(req.tokyardMeter.vision).toEqual({ url: pngUrl, model: "gpt-4o", inputBound });
    expect((await w.getUserBudget(user.id)).reserved).toBe(inputBound + 10);
    expect((await req.json()).messages[0].content[1].image_url.url).toBe(pngUrl);
    req.tokyardMeter.onDispatch();
    req.tokyardMeter.onUsage({ prompt_tokens: 100, completion_tokens: 3 });
    return Response.json({});
  });
  expect(response.status).toBe(200);
  expect(await w.getUserBudget(user.id)).toMatchObject({ consumed: 103, reserved: 0 });
});

test("usage-only accepts a 4 MiB image, normalizes missing detail, and settles through direct transport", async () => {
  await w.saveProfile({ usageOnly: true, tokenLimit: 0 }, "standard");
  const bytes = Buffer.alloc(4 * 1024 * 1024);
  Buffer.from(pngUrl.split(",")[1], "base64").copy(bytes);
  const body = imageBody(`data:image/png;base64,${bytes.toString("base64")}`);
  delete body.max_tokens;
  delete body.messages[0].content[1].image_url.detail;
  const { dispatchMeteredVision } = await import("@/sse/handlers/meteredVision.js");
  const transport = vi.fn(async (_url, opts) => {
    const sent = JSON.parse(opts.body);
    expect(sent.messages[0].content[1].image_url.detail).toBe("low");
    expect(sent).not.toHaveProperty("max_tokens");
    return Response.json({ usage: { prompt_tokens: 98, completion_tokens: 2 } });
  });
  const dispatch = async req => dispatchMeteredVision({ body: await req.json(), meter: req.tokyardMeter, credentials: { apiKey: "fixture" }, transport });
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) vi.stubEnv(name, "");
  try {
    expect((await meter(request(key.key, body), dispatch)).status).toBe(200);
    expect(await w.getUserBudget(user.id)).toMatchObject({ inputTokens: 98, outputTokens: 2, reserved: 0 });
    const tooBig = `data:image/png;base64,${Buffer.concat([bytes, Buffer.alloc(1)]).toString("base64")}`;
    expect((await meter(request(key.key, imageBody(tooBig)), dispatch)).status).toBe(413);
    expect(transport).toHaveBeenCalledOnce();
  } finally { vi.unstubAllEnvs(); }
});

test("JPEG missing usage remains held and insufficient balance blocks admission", async () => {
  const response = await meter(request(key.key, imageBody(jpegUrl)), async req => {
    expect(req.tokyardMeter.vision.url).toBe(jpegUrl);
    req.tokyardMeter.onDispatch();
    return Response.json({});
  });
  expect(response.status).toBe(200);
  expect((await w.listWorkspaceRequests(user.id))[0].status).toBe("uncertain");
  expect((await w.getUserBudget(user.id)).reserved).toBeGreaterThan(85);
  await w.updateWorkspaceUser(user.id, { tokenLimit: 0 });
  const dispatch = vi.fn();
  expect((await meter(request(key.key, imageBody(jpegUrl)), dispatch)).status).toBe(429);
  expect(dispatch).not.toHaveBeenCalled();
});

test("unsupported image shapes, models, endpoints and framing never reserve", async () => {
  const invalid = [
    { ...imageBody(), model: "openai/gpt-4o-mini" },
    { ...imageBody(), messages: [{ role: "assistant", content: imageBody().messages[0].content }] },
    { ...imageBody(), messages: [{ role: "user", content: [...imageBody().messages[0].content, imageBody().messages[0].content[1]] }] },
    imageBody("https://example.com/image.png"), imageBody(pngUrl.replace("image/png", "image/jpeg")),
    imageBody(pngUrl + "A"), { ...imageBody(), tools: [] },
    { ...imageBody(), messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: pngUrl, detail: "high" } }] }] },
  ];
  const dispatch = vi.fn();
  for (const body of invalid) expect((await meter(request(key.key, body), dispatch)).status).toBeGreaterThanOrEqual(400);
  expect((await meter(request(key.key, imageBody(), "/v1/responses"), dispatch)).status).toBe(403);
  expect(dispatch).not.toHaveBeenCalled();
  expect(await w.getUserBudget(user.id)).toMatchObject({ consumed: 0, reserved: 0 });
});

test("bounded wire, non-image bytes and encoding fail before reservation", async () => {
  const dispatch = vi.fn();
  const huge = request(key.key, { messages: [{ role: "user", content: "x".repeat(7 * 1024 * 1024) }] });
  expect((await meter(huge, dispatch)).status).toBe(413);
  const extra = imageBody();
  extra.messages[0].content[0].text = "x".repeat(1024 * 1024);
  expect((await meter(request(key.key, extra), dispatch)).status).toBe(413);
  const compressed = request(key.key, imageBody());
  compressed.headers.set("content-encoding", "gzip");
  expect((await meter(compressed, dispatch)).status).toBe(415);
  expect(dispatch).not.toHaveBeenCalled();
  expect(await w.getUserBudget(user.id)).toMatchObject({ consumed: 0, reserved: 0 });
});

test("persistent ledger unavailable refuses dispatch", async () => {
  const real = db.driver;
  db.driver = "sql.js";
  const dispatch = vi.fn();
  expect((await meter(request(key.key), dispatch)).status).toBe(503);
  expect(dispatch).not.toHaveBeenCalled();
  db.driver = real;
});
