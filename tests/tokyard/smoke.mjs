// Run after npm run build. Local mock only; no external AI credentials.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const root = process.cwd();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokyard-smoke-"));
const password = randomBytes(24).toString("base64url");
let server, logs = "", dispatched = 0;
const mock = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  dispatched++;
  const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 };
  if (body.stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const chunk of [
      { id: "smoke", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] },
      { id: "smoke", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { id: "smoke", choices: [], usage },
    ]) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end("data: [DONE]\n\n");
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "smoke", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }], ...(body.model === "no-usage" ? {} : { usage }) }));
  }
});
async function freePort() {
  const probe = net.createServer();
  await new Promise(r => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  return port;
}
try {
  await new Promise(r => mock.listen(0, "127.0.0.1", r));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(root, ".next/standalone/custom-server.js")], { cwd: root, env: { ...process.env, NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1", DATA_DIR: dataDir, INITIAL_PASSWORD: password, JWT_SECRET: randomBytes(32).toString("hex"), ENABLE_REQUEST_LOGS: "false", NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", bytes => { logs = (logs + bytes).slice(-12000); });
  server.stderr.on("data", bytes => { logs = (logs + bytes).slice(-12000); });
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (attempt >= 60 || server.exitCode !== null) throw new Error("Production server did not start");
    await delay(250);
  }
  async function call(url, options = {}, expected = 200) {
    const response = await fetch(`${base}${url}`, options);
    assert.equal(response.status, expected, `${url}: expected ${expected}, received ${response.status}`);
    return response;
  }
  const json = (body, cookie, method = "POST") => ({ method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const ownerLogin = await call("/api/auth/login", json({ password }));
  const owner = ownerLogin.headers.get("set-cookie").split(";")[0];
  const ownerGet = { headers: { cookie: owner } };
  await call("/v1/chat/completions", json({}), 401);
  const node = (await (await call("/api/provider-nodes", json({ name: "Local smoke provider", prefix: "smoke", apiType: "chat", baseUrl: `http://127.0.0.1:${mock.address().port}/v1` }, owner), 201)).json()).node;
  await call("/api/providers", json({ provider: node.id, name: "Mock account", apiKey: "local-test-only" }, owner), 201);
  await call("/api/workspace/profiles/standard", json({ tokenLimit: 50000, maxOutputTokens: 100, allowedModels: ["smoke/test-model", "smoke/no-usage"] }, owner, "PATCH"));
  const user = (await (await call("/api/workspace/users", json({ name: "Smoke member", email: "member@example.test", password }, owner), 201)).json()).user;
  const createKey = async name => (await (await call("/api/workspace/keys", json({ userId: user.id, name }, owner), 201)).json());
  const key = await createKey("First client"), key2 = await createKey("Second client");
  const inference = (token, stream = false, model = "test-model") => ({ method: "POST", headers: { "Content-Type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ model: `smoke/${model}`, messages: [{ role: "user", content: "Hello" }], max_tokens: 50, stream }) });
  const first = await call("/v1/chat/completions", inference(key.key));
  assert.equal((await first.json()).choices[0].message.content, "Hello");
  const second = await call("/v1/chat/completions", inference(key2.key, true));
  assert.match(await second.text(), /Hello/);
  const workspace = await (await call("/api/workspace", ownerGet)).json();
  assert.equal(workspace.users[0].budget.consumed, 60);
  assert.equal(workspace.users[0].budget.reserved, 0);
  assert.ok(workspace.requests.every(r => r.status === "settled"));
  await call(`/api/workspace/users/${user.id}`, json({ tokenLimit: 60 }, owner, "PATCH"));
  await call("/v1/chat/completions", inference(key2.key), 429);
  assert.equal(dispatched, 2, "Exhausted budget must block before the provider");
  await call(`/api/workspace/users/${user.id}`, json({ tokenLimit: null }, owner, "PATCH"));
  const memberLogin = await call("/api/auth/login", json({ email: user.email, password }));
  const member = memberLogin.headers.get("set-cookie").split(";")[0];
  await call("/api/providers", { headers: { cookie: member } }, 403);
  await call("/api/workspace/keys?userId=other-user", { headers: { cookie: member } }, 403);
  await call("/api/workspace/keys", { ...json({ name: "Cross-origin" }, member), headers: { ...json({}, member).headers, origin: "https://evil.example" } }, 403);
  await call("/v1/images/generations", inference(key.key), 401);
  await call("/v1beta/models/test:generateContent", inference(key.key), 401);
  const unknown = await call("/v1/chat/completions", inference(key2.key, false, "no-usage"));
  await unknown.json();
  const held = (await (await call("/api/workspace", ownerGet)).json()).requests.find(r => r.id === unknown.headers.get("x-tokyard-request-id"));
  assert.equal(held.status, "uncertain");
  await call(`/api/workspace/requests/${held.id}/reconcile`, json({ actualTokens: 30, reason: "Verified against local mock provider" }, owner));
  await call(`/api/workspace/keys/${key.id}`, { method: "DELETE", headers: { cookie: owner } });
  await call("/v1/chat/completions", inference(key.key), 401);
  await call(`/api/workspace/users/${user.id}`, json({ isActive: false }, owner, "PATCH"));
  await call("/v1/chat/completions", inference(key2.key), 401);
  await call("/api/workspace", { headers: { cookie: member } }, 401);
  assert.equal(dispatched, 3);
  console.log("TokYard smoke passed: production login, pooled provider, JSON + SSE usage, shared quota, rejection before dispatch, role/ownership/CSRF gates, held reconciliation, revoke and pause.");
} catch (error) {
  console.error(error.message);
  console.error(logs);
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([new Promise(r => server.once("exit", r)), delay(3000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  await new Promise(r => mock.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
