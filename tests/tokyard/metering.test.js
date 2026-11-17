import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, test, expect, vi } from "vitest";

vi.mock("@/sse/services/model.js", () => ({ getModelInfo: async model => ({ provider: model === "smart" ? "systemone" : "openai", model }), getComboModels: async model => model === "combo" ? ["openai/test"] : null }));
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
  expect(await w.getUserBudget(user.id)).toMatchObject({ consumed: 42, reserved: 0 });
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
