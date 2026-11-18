import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, test, expect, vi } from "vitest";

vi.mock("@/sse/services/model.js", () => ({ getModelInfo: async model => ({ provider: model === "smart" ? "systemone" : "openai", model }), getComboModels: async model => model === "combo" ? ["openai/test"] : null }));
vi.mock("@/sse/services/keyAccess.js", async () => ({
  extractClientApiKey: request => request.headers.get("authorization")?.slice(7),
  getKeyAccessContext: async () => null, enforceKeyAccess: async () => null,
}));
let dir, w, db, key, user, meter, bound;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokyard-meter-"));
  process.env.DATA_DIR = dir;
  delete global._dbAdapter;
  vi.resetModules();
  w = await import("@/lib/workspace.js");
  db = await w.ensureWorkspace();
  user = await w.createWorkspaceUser({ name: "Member", email: "member@example.com", password: "test-password-123" });
  key = await w.createWorkspaceKey(user.id, "Test");
  ({ meterWorkspaceChat: meter, inputTokenBound: bound } = await import("@/lib/workspaceMetering.js"));
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
  expect(await w.getUserBudget(user.id)).toMatchObject({ consumed: 42, reserved: 0 });
});

test("output fits the smaller daily/monthly balance and daily exhaustion blocks before dispatch", async () => {
  await w.saveProfile({ dailyTokenLimit: 3000 }, "standard");
  for (const monthlyLimit of [1000000, 2500]) {
    await w.updateWorkspaceUser(user.id, { tokenLimit: monthlyLimit });
    const before = await w.getUserBudget(user.id);
    const req = request(key.key, { max_tokens: 99999 });
    const inputBound = bound(await req.clone().text());
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

test("insufficient balance explains the updated limit, used tokens and minimum reservation", async () => {
  await w.saveProfile({ tokenLimit: 10000 }, "standard");
  const previous = await w.reserveWorkspaceTokens(key.id, 10000, "openai/test");
  await w.settleWorkspaceTokens(previous.id, 10000);
  await w.saveProfile({ tokenLimit: 25000 }, "standard");
  const req = request(key.key, { messages: [{ role: "user", content: "x".repeat(30000) }] });
  const required = bound(await req.clone().text()) + 1;
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
  const req = request(key.key, { messages: [{ role: "user", content: "x".repeat(20000) }] });
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
  expect(capOutputTokens({ request: { generationConfig: { maxOutputTokens: 64000, thinkingConfig: { thinkingBudget: -1 } } } }, 4096))
    .toEqual({ request: { generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 4096 } } } });
  expect(capOutputTokens({ max_output_tokens: 10 }, 4096)).toEqual({ max_output_tokens: 10 });
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

test("persistent ledger unavailable refuses dispatch", async () => {
  const real = db.driver;
  db.driver = "sql.js";
  const dispatch = vi.fn();
  expect((await meter(request(key.key), dispatch)).status).toBe(503);
  expect(dispatch).not.toHaveBeenCalled();
  db.driver = real;
});
