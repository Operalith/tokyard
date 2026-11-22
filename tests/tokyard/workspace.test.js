import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, test, expect, vi } from "vitest";

let dir, w, db, user, key;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokyard-test-"));
  process.env.DATA_DIR = dir;
  delete global._dbAdapter;
  vi.resetModules();
  w = await import("@/lib/workspace.js");
  db = await w.ensureWorkspace();
  user = await w.createWorkspaceUser({ name: "Member", email: "member@example.com", password: "test-password-123" });
  key = await w.createWorkspaceKey(user.id, "Laptop");
});
afterEach(() => {
  vi.useRealTimers();
  db?.close();
  delete global._dbAdapter;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("secrets stay hashed; a stored hash cannot authenticate as a bearer key", async () => {
  const { getApiKeyByKey, validateApiKey, getApiKeys } = await import("@/lib/db/repos/apiKeysRepo.js");
  const stored = db.get("SELECT key FROM apiKeys WHERE id = ?", [key.id]).key;
  expect(stored).toBe(w.hashWorkspaceKey(key.key));
  expect(await validateApiKey(stored)).toBe(false);
  expect((await getApiKeyByKey(key.key)).userId).toBe(user.id);
  expect(await getApiKeys()).toEqual([]);
  expect(JSON.stringify(await w.listWorkspaceKeys(user.id))).not.toContain(stored);
  expect(user.passwordHash).toBeUndefined();
  expect(await w.authenticateWorkspaceUser("MEMBER@example.com", "wrong-password")).toBeNull();
  expect((await w.authenticateWorkspaceUser("MEMBER@example.com", "test-password-123")).id).toBe(user.id);
});

test("validation rejects weak passwords, invalid budgets and duplicate emails", async () => {
  await expect(w.createWorkspaceUser({ name: "X", email: "x@example.com", password: "123" })).rejects.toThrow("Password");
  await expect(w.createWorkspaceUser({ name: "X", email: user.email.toUpperCase(), password: "test-password-123" })).rejects.toThrow("Email already exists");
  await expect(w.saveProfile({ name: "Invalid", tokenLimit: -1 })).rejects.toThrow("Token allowance");
  await expect(w.updateWorkspaceUser(user.id, { isActive: "false" })).rejects.toThrow("boolean");
  await expect(w.updateWorkspaceUser(user.id, { tokenLimit: 1.5 })).rejects.toThrow("integer");
  for (const dailyTokenLimit of [-1, 1.5, "100", true, 1_000_000_000_001]) {
    await expect(w.saveProfile({ dailyTokenLimit }, "standard")).rejects.toThrow("Daily token allowance");
    await expect(w.updateWorkspaceUser(user.id, { dailyTokenLimit })).rejects.toThrow("Daily token allowance");
  }
});

test("members change only their password, invalidate every old session and preserve keys and usage", async () => {
  const { createDashboardAuthToken, getDashboardAuthSession } = await import("@/lib/auth/dashboardSession.js");
  const { validateApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
  const claims = { role: "member", userId: user.id, authVersion: user.authVersion };
  const sessions = await Promise.all([createDashboardAuthToken(claims), createDashboardAuthToken({ ...claims, device: "other" })]);
  const owner = await createDashboardAuthToken();
  const held = await w.reserveWorkspaceTokens(key.id, 100, "openai/test");
  await w.settleWorkspaceTokens(held.id, 30);
  const budget = await w.getUserBudget(user.id);
  await w.changeWorkspacePassword(user.id, "test-password-123", "new-password-456", user.authVersion);
  expect(await w.authenticateWorkspaceUser(user.email, "test-password-123")).toBeNull();
  expect((await w.authenticateWorkspaceUser(user.email, "new-password-456")).id).toBe(user.id);
  for (const token of sessions) expect(await getDashboardAuthSession(token)).toBeNull();
  expect((await getDashboardAuthSession(owner)).role).toBe("admin");
  expect(await validateApiKey(key.key)).toBe(true);
  expect(await w.getUserBudget(user.id)).toEqual(budget);
  expect(await w.getWorkspaceUser(user.id)).toEqual({ ...user, authVersion: user.authVersion + 1 });
  const events = db.all("SELECT actor, action, subjectId, details FROM workspaceAudit WHERE action = 'user.password.changed'");
  expect(events).toEqual([{ actor: `member:${user.id}`, action: "user.password.changed", subjectId: user.id, details: "{}" }]);
});

test("invalid, identical, oversized and stale password changes leave credentials untouched", async () => {
  for (const [current, next, version, status] of [
    ["wrong-password-123", "new-password-456", user.authVersion, 401],
    [null, "new-password-456", user.authVersion, 400],
    ["a".repeat(73), "new-password-456", user.authVersion, 400],
    ["test-password-123", "short", user.authVersion, 400],
    ["test-password-123", "a".repeat(73), user.authVersion, 400],
    ["test-password-123", "ژ".repeat(37), user.authVersion, 400],
    ["test-password-123", "test-password-123", user.authVersion, 400],
    ["test-password-123", "new-password-456", user.authVersion + 1, 401],
  ]) await expect(w.changeWorkspacePassword(user.id, current, next, version)).rejects.toMatchObject({ status });
  expect((await w.authenticateWorkspaceUser(user.email, "test-password-123")).authVersion).toBe(user.authVersion);
  expect(db.get("SELECT COUNT(*) AS n FROM workspaceAudit WHERE action = 'user.password.changed'").n).toBe(0);
});

test("concurrent password changes accept one winner without overwriting it", async () => {
  const results = await Promise.allSettled(["new-password-one", "new-password-two"].map(next => w.changeWorkspacePassword(user.id, "test-password-123", next, user.authVersion)));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find(result => result.status === "rejected").reason.status).toBe(409);
  const winner = results[0].status === "fulfilled" ? "new-password-one" : "new-password-two";
  expect((await w.authenticateWorkspaceUser(user.email, winner)).authVersion).toBe(user.authVersion + 1);
  expect(db.get("SELECT COUNT(*) AS n FROM workspaceAudit WHERE action = 'user.password.changed'").n).toBe(1);
});

test.each(["pause", "reset"])("a concurrent owner %s prevents an in-flight member password change", async action => {
  const { default: bcrypt } = await import("bcryptjs");
  const compare = bcrypt.compare;
  let resume, started;
  const gate = new Promise(resolve => { resume = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const spy = vi.spyOn(bcrypt, "compare").mockImplementationOnce(async (...args) => { started(); await gate; return compare(...args); });
  const pending = w.changeWorkspacePassword(user.id, "test-password-123", "member-password-456", user.authVersion);
  try {
    await entered;
    await w.updateWorkspaceUser(user.id, action === "pause" ? { isActive: false } : { password: "owner-reset-password" });
    resume();
    await expect(pending).rejects.toMatchObject({ status: 409 });
    await expect(w.changeWorkspacePassword(user.id, "test-password-123", "other-password-456", user.authVersion)).rejects.toMatchObject({ status: 401 });
    if (action === "reset") expect((await w.authenticateWorkspaceUser(user.email, "owner-reset-password")).id).toBe(user.id);
    else expect((await w.getWorkspaceUser(user.id)).isActive).toBe(false);
  } finally { resume(); spy.mockRestore(); }
});

test("password endpoint enforces member ownership, CSRF, confirmation and cookie isolation", async () => {
  const removed = [];
  vi.doMock("next/headers", () => ({ cookies: async () => ({ delete: name => removed.push(name) }) }));
  try {
    const { POST } = await import("@/app/api/workspace/password/route.js");
    const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
    const member = await createDashboardAuthToken({ role: "member", userId: user.id, authVersion: user.authVersion });
    const owner = await createDashboardAuthToken();
    const body = { currentPassword: "test-password-123", newPassword: "new-password-456", confirmPassword: "new-password-456" };
    const send = (input, token = member, headers = {}) => POST(new Request("http://localhost/api/workspace/password", { method: "POST", headers: { "content-type": "application/json", cookie: `tokyard_auth_token=${token}`, ...headers }, body: JSON.stringify(input) }));
    expect((await send(body, "")).status).toBe(401);
    expect((await send(body, owner)).status).toBe(403);
    expect((await send(body, member, { origin: "https://evil.example" })).status).toBe(403);
    expect((await send(body, member, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await send({ ...body, userId: "someone-else" })).status).toBe(400);
    expect((await send({ ...body, profileId: "standard" })).status).toBe(400);
    expect((await send({ ...body, confirmPassword: "different-password" })).status).toBe(400);
    const response = await send(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(removed).toEqual(["tokyard_auth_token"]);
    expect((await send(body)).status).toBe(401);
  } finally { vi.doUnmock("next/headers"); }
});

test("password guessing is bounded even in parallel and cannot reset a login lock", async () => {
  vi.doMock("next/headers", () => ({ cookies: async () => ({ delete() {} }) }));
  try {
    const { POST } = await import("@/app/api/workspace/password/route.js");
    const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
    const { recordFail, checkLock } = await import("@/lib/auth/loginLimiter.js");
    const member = await createDashboardAuthToken({ role: "member", userId: user.id, authVersion: user.authVersion });
    const send = currentPassword => POST(new Request("http://localhost/api/workspace/password", { method: "POST", headers: { "content-type": "application/json", cookie: `tokyard_auth_token=${member}` }, body: JSON.stringify({ currentPassword, newPassword: "new-password-456", confirmPassword: "new-password-456" }) }));
    for (let i = 0; i < 5; i++) recordFail("owner-login-test");
    const responses = await Promise.all(Array.from({ length: 8 }, () => send("wrong-password-123")));
    expect(responses.filter(response => response.status === 401)).toHaveLength(5);
    expect(responses.filter(response => response.status === 429)).toHaveLength(3);
    const locked = await send("test-password-123");
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(checkLock("owner-login-test").locked).toBe(true);
    expect((await w.authenticateWorkspaceUser(user.email, "test-password-123")).authVersion).toBe(user.authVersion);
  } finally { vi.doUnmock("next/headers"); }
});

test("usage-only profiles ignore all token budgets and personal overrides without losing attribution", async () => {
  expect((await w.listProfiles())[0].usageOnly).toBe(false);
  for (const usageOnly of [null, 1, "true"]) await expect(w.saveProfile({ usageOnly }, "standard")).rejects.toThrow("boolean");
  await w.saveProfile({ usageOnly: true, tokenLimit: 0, dailyTokenLimit: 0, quotaMode: "shared", sharedTokenLimit: 0, sharedDailyTokenLimit: 0 }, "standard");
  await w.updateWorkspaceUser(user.id, { tokenLimit: 0, dailyTokenLimit: 0 });
  const other = await w.createWorkspaceUser({ name: "Other", email: "other@example.test", password: "test-password-123" });
  const rotated = await w.createWorkspaceKey(user.id, "Second client");
  const first = await w.reserveWorkspaceTokens(key.id, 2000000, "openai/test");
  await w.settleWorkspaceTokens(first.id, 1500000);
  const next = await w.reserveWorkspaceTokens(rotated.id, 100, "claude/test");
  await w.settleWorkspaceTokens(next.id, 80);
  expect(await w.getWorkspaceUser(user.id)).toMatchObject({ usageOnly: true, tokenLimit: null, dailyTokenLimit: null, tokenLimitOverride: 0, dailyTokenLimitOverride: 0 });
  expect(await w.getUserBudget(user.id)).toMatchObject({ limit: null, consumed: 1500080, reserved: 0, remaining: null, available: null, shared: null, daily: { limit: null, consumed: 1500080, remaining: null } });
  expect((await w.getUserBudget(other.id)).consumed).toBe(0);
  expect(await w.listWorkspaceRequests(user.id)).toHaveLength(2);
  await w.saveProfile({ usageOnly: false }, "standard");
  expect((await w.getUserBudget(user.id)).consumed).toBe(1500080);
  await expect(w.reserveWorkspaceTokens(key.id, 1, "openai/test")).rejects.toMatchObject({ status: 429 });
});

test("usage-only keeps access and concurrency controls, and uncertain usage never blocks the token budget", async () => {
  await w.saveProfile({ usageOnly: true, maxConcurrent: 1 }, "standard");
  const held = await w.reserveWorkspaceTokens(key.id, 100, "openai/test");
  await expect(w.reserveWorkspaceTokens(key.id, 100, "openai/test")).rejects.toThrow("Concurrent");
  await w.markWorkspaceUncertain(held.id, "Missing provider usage");
  const next = await w.reserveWorkspaceTokens(key.id, 100, "openai/test");
  await w.settleWorkspaceTokens(next.id, 30);
  expect(await w.getUserBudget(user.id)).toMatchObject({ consumed: 30, reserved: 100, remaining: null });
  await w.updateWorkspaceUser(user.id, { isActive: false });
  await expect(w.reserveWorkspaceTokens(key.id, 1, "openai/test")).rejects.toMatchObject({ status: 403 });
});

test("schema 5 upgrade preserves existing quotas, keys, consumption and held usage", async () => {
  const settled = await w.reserveWorkspaceTokens(key.id, 100, "openai/test");
  await w.settleWorkspaceTokens(settled.id, 80);
  await w.reserveWorkspaceTokens(key.id, 50, "openai/test");
  db.exec("ALTER TABLE workspaceProfiles DROP COLUMN usageOnly");
  db.run("UPDATE _meta SET value = '5' WHERE key = 'backupSchemaVersion'");
  db.run("UPDATE _meta SET value = '2' WHERE key = 'schemaVersion'");
  db.close(); delete global._dbAdapter; vi.resetModules();
  w = await import("@/lib/workspace.js"); db = await w.ensureWorkspace();
  expect((await w.listProfiles())[0]).toMatchObject({ usageOnly: false, tokenLimit: 1000000 });
  expect(await w.getUserBudget(user.id)).toMatchObject({ limit: 1000000, consumed: 80, reserved: 50 });
  expect(db.get("SELECT key FROM apiKeys WHERE id = ?", [key.id]).key).toBe(w.hashWorkspaceKey(key.key));
  expect(fs.readdirSync(path.join(dir, "db/backups")).some(name => name.startsWith("schema-5-to-6-"))).toBe(true);
});

test("daily allowance is atomic across keys and providers; monthly cap still applies", async () => {
  await w.saveProfile({ dailyTokenLimit: 100 }, "standard");
  const second = await w.createWorkspaceKey(user.id, "Desktop");
  const results = await Promise.allSettled([w.reserveWorkspaceTokens(key.id, 60, "openai/test"), w.reserveWorkspaceTokens(second.id, 60, "claude/test")]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect((await w.getUserBudget(user.id)).daily).toMatchObject({ limit: 100, consumed: 0, reserved: 60, remaining: 40 });
  const reservation = results.find(r => r.status === "fulfilled").value;
  await w.settleWorkspaceTokens(reservation.id, 45);
  await w.settleWorkspaceTokens(reservation.id, 45);
  expect((await w.getUserBudget(user.id)).daily).toMatchObject({ consumed: 45, reserved: 0, remaining: 55 });
  await expect(w.reserveWorkspaceTokens(second.id, 56, "claude/test")).rejects.toMatchObject({ status: 429, message: expect.stringContaining("Daily") });
  expect((await w.getUserBudget(user.id)).reserved).toBe(0);
  await w.updateWorkspaceUser(user.id, { tokenLimit: 50 });
  await expect(w.reserveWorkspaceTokens(second.id, 6, "claude/test")).rejects.toThrow("Monthly");
  expect((await w.getUserBudget(user.id)).daily.reserved).toBe(0);
});

test("daily profile changes preserve earlier usage and support per-person overrides and zero", async () => {
  const reservation = await w.reserveWorkspaceTokens(key.id, 100, "openai/test");
  await w.settleWorkspaceTokens(reservation.id, 80);
  expect((await w.getUserBudget(user.id)).daily).toMatchObject({ limit: null, consumed: 80, remaining: null });
  await w.saveProfile({ dailyTokenLimit: 75 }, "standard");
  expect((await w.getUserBudget(user.id)).daily.remaining).toBe(0);
  await expect(w.reserveWorkspaceTokens(key.id, 1, "openai/test")).rejects.toThrow("Daily");
  await w.updateWorkspaceUser(user.id, { dailyTokenLimit: 100 });
  expect((await w.getUserBudget(user.id)).daily.remaining).toBe(20);
  await w.saveProfile({ dailyTokenLimit: 90 }, "standard");
  expect((await w.getWorkspaceUser(user.id)).dailyTokenLimit).toBe(100);
  await w.updateWorkspaceUser(user.id, { dailyTokenLimit: null });
  expect((await w.getUserBudget(user.id)).daily).toMatchObject({ limit: 90, remaining: 10 });
  await w.updateWorkspaceUser(user.id, { dailyTokenLimit: 0 });
  expect((await w.getUserBudget(user.id)).daily.limit).toBe(0);
  await expect(w.reserveWorkspaceTokens(key.id, 1, "openai/test")).rejects.toThrow("Daily");
  await w.saveProfile({ dailyTokenLimit: null }, "standard");
  await w.updateWorkspaceUser(user.id, { dailyTokenLimit: null });
  expect((await w.getUserBudget(user.id)).daily.limit).toBeNull();
});

test("UTC midnight resets daily usage; late settlement and uncertain holds stay on their original day", async () => {
  await w.saveProfile({ dailyTokenLimit: 100 }, "standard");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-17T23:59:59Z"));
  const old = await w.reserveWorkspaceTokens(key.id, 100, "openai/test");
  await w.recoverWorkspaceReservations();
  expect((await w.getUserBudget(user.id)).daily).toMatchObject({ reserved: 100, remaining: 0, resetsAt: "2026-11-18T00:00:00.000Z" });
  vi.setSystemTime(new Date("2026-11-18T00:00:01Z"));
  expect(await w.getUserBudget(user.id)).toMatchObject({ reserved: 100, daily: { consumed: 0, reserved: 0, remaining: 100, period: "2026-11-18" } });
  const today = await w.reserveWorkspaceTokens(key.id, 100, "claude/test");
  await w.settleWorkspaceTokens(old.id, 90, "manual", "Verified provider logs", "owner");
  expect((await w.getUserBudget(user.id)).daily).toMatchObject({ consumed: 0, reserved: 100 });
  await w.settleWorkspaceTokens(today.id, 120);
  expect(await w.getUserBudget(user.id)).toMatchObject({ consumed: 210, reserved: 0, daily: { consumed: 120, reserved: 0, remaining: 0 } });
  await expect(w.reserveWorkspaceTokens(key.id, 1, "openai/test")).rejects.toThrow("Daily");
  vi.setSystemTime(new Date("2026-11-17T23:59:59Z"));
  expect((await w.getUserBudget(user.id)).daily).toMatchObject({ consumed: 90, reserved: 0 });
});

test("schema 3 upgrade preserves keys, monthly counters and today's settled and held usage", async () => {
  const settled = await w.reserveWorkspaceTokens(key.id, 100, "openai/test");
  await w.settleWorkspaceTokens(settled.id, 80);
  await w.reserveWorkspaceTokens(key.id, 50, "claude/test");
  db.exec("ALTER TABLE workspaceProfiles DROP COLUMN dailyTokenLimit");
  db.exec("ALTER TABLE workspaceUsers DROP COLUMN dailyTokenLimit");
  db.run("UPDATE _meta SET value = '3' WHERE key = 'backupSchemaVersion'");
  db.close();
  delete global._dbAdapter;
  vi.resetModules();
  w = await import("@/lib/workspace.js");
  db = await w.ensureWorkspace();
  expect(await w.getUserBudget(user.id)).toMatchObject({ consumed: 80, reserved: 50, daily: { limit: null, consumed: 80, reserved: 50 } });
  expect(db.get("SELECT value FROM _meta WHERE key = 'backupSchemaVersion'").value).toBe("6");
  expect(db.get("SELECT key FROM apiKeys WHERE id = ?", [key.id]).key).toBe(w.hashWorkspaceKey(key.key));
  await w.saveProfile({ dailyTokenLimit: 130 }, "standard");
  await expect(w.reserveWorkspaceTokens(key.id, 1, "openai/test")).rejects.toThrow("Daily");
});

test("parallel reservations and rotated keys share a single atomic allowance", async () => {
  await w.updateWorkspaceUser(user.id, { tokenLimit: 100 });
  const second = await w.createWorkspaceKey(user.id, "Desktop");
  const results = await Promise.allSettled([w.reserveWorkspaceTokens(key.id, 60, "openai/test"), w.reserveWorkspaceTokens(second.id, 60, "openai/test")]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(await w.getUserBudget(user.id)).toMatchObject({ reserved: 60, remaining: 40 });
  const reservation = results.find(r => r.status === "fulfilled").value;
  await w.settleWorkspaceTokens(reservation.id, 45);
  await w.settleWorkspaceTokens(reservation.id, 45);
  expect(await w.getUserBudget(user.id)).toMatchObject({ consumed: 45, reserved: 0, remaining: 55 });
  await expect(w.reserveWorkspaceTokens(second.id, 56, "openai/test")).rejects.toThrow("allowance");
});

test("concurrency cap rolls back without leaking reserved tokens", async () => {
  await w.saveProfile({ maxConcurrent: 1 }, "standard");
  await w.reserveWorkspaceTokens(key.id, 100, "openai/test");
  await expect(w.reserveWorkspaceTokens(key.id, 200, "openai/test")).rejects.toThrow("Concurrent");
  expect((await w.getUserBudget(user.id)).reserved).toBe(100);
});

test("pause and revoke immediately reject inference and invalidate sessions", async () => {
  const { getDashboardAuthSession, createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  const token = await createDashboardAuthToken({ role: "member", userId: user.id, authVersion: user.authVersion });
  expect((await getDashboardAuthSession(token)).role).toBe("member");
  await w.updateWorkspaceUser(user.id, { isActive: false });
  expect(await getDashboardAuthSession(token)).toBeNull();
  await expect(w.reserveWorkspaceTokens(key.id, 1, "openai/test")).rejects.toThrow("disabled");
  await w.updateWorkspaceUser(user.id, { isActive: true });
  await w.revokeWorkspaceKey(user.id, key.id);
  await expect(w.reserveWorkspaceTokens(key.id, 1, "openai/test")).rejects.toThrow("Invalid API key");
});

test("dashboard login, authorization and logout leave 9router cookies untouched", async () => {
  const { createDashboardAuthToken, setDashboardAuthCookie, clearDashboardAuthCookie } = await import("@/lib/auth/dashboardSession.js");
  const { requireWorkspaceSession } = await import("@/lib/workspaceHttp.js");
  const { proxy } = await import("@/dashboardGuard.js");
  const values = new Map([["auth_token", "9router-session"], ["oidc_state", "9router-state"]]);
  const store = {
    get: name => values.has(name) ? { value: values.get(name) } : undefined,
    set: (name, value) => values.set(name, value),
    delete: name => values.delete(name),
  };
  const request = new Request("http://localhost/api/workspace");
  await setDashboardAuthCookie(store, request);
  expect(values.get("auth_token")).toBe("9router-session");
  expect(values.get("tokyard_auth_token")).toBeTruthy();
  const legacy = await createDashboardAuthToken();
  await expect(requireWorkspaceSession(new Request(request.url, { headers: { cookie: `auth_token=${legacy}` } }))).rejects.toMatchObject({ status: 401 });
  const own = values.get("tokyard_auth_token");
  expect((await requireWorkspaceSession(new Request(request.url, { headers: { cookie: `auth_token=other; tokyard_auth_token=${own}` } }))).role).toBe("admin");
  const dashboard = { url: "http://localhost/dashboard", nextUrl: new URL("http://localhost/dashboard"), method: "GET", headers: new Headers(), cookies: store };
  expect((await proxy(dashboard)).status).toBe(200);
  values.set("auth_token", "another-9router-login");
  expect((await proxy(dashboard)).status).toBe(200);
  clearDashboardAuthCookie(store);
  expect(values.has("tokyard_auth_token")).toBe(false);
  expect(values.get("auth_token")).toBe("another-9router-login");
  expect(values.get("oidc_state")).toBe("9router-state");
  expect((await proxy(dashboard)).status).toBe(307);
});

test("member logins cannot reset the owner lockout and respect tunnel blocking", async () => {
  vi.doMock("next/headers", () => ({ cookies: async () => ({ get() {}, set() {}, delete() {} }) }));
  const previous = process.env.INITIAL_PASSWORD;
  process.env.INITIAL_PASSWORD = "owner-password-123";
  try {
    const { POST } = await import("@/app/api/auth/login/route.js");
    const login = (body, host = "localhost") => POST(new Request(`http://${host}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", host }, body: JSON.stringify(body) }));
    for (let i = 0; i < 4; i++) expect((await login({ password: "wrong-password-xyz" })).status).toBe(401);
    expect((await login({ email: "member@example.com", password: "test-password-123" })).status).toBe(200);
    expect((await login({ password: "wrong-password-xyz" })).status).toBe(429);
    expect((await login({ password: "owner-password-123" })).status).toBe(429);
    const { updateSettings } = await import("@/lib/localDb");
    await updateSettings({ tunnelUrl: "https://tunnel.example.com", tunnelDashboardAccess: false });
    expect((await login({ email: "member@example.com", password: "test-password-123" }, "tunnel.example.com")).status).toBe(403);
  } finally {
    if (previous === undefined) delete process.env.INITIAL_PASSWORD; else process.env.INITIAL_PASSWORD = previous;
    vi.doUnmock("next/headers");
  }
});

test("profile edits apply to existing keys and individual overrides remain explicit", async () => {
  const { getApiKeyByKey } = await import("@/lib/db/repos/apiKeysRepo.js");
  await w.saveProfile({ tokenLimit: 500, allowedModels: ["openai/test"] }, "standard");
  expect((await getApiKeyByKey(key.key)).access).toEqual({ restricted: true, allow: ["openai/test"] });
  expect((await w.getUserBudget(user.id)).limit).toBe(500);
  await w.updateWorkspaceUser(user.id, { tokenLimit: 20 });
  expect((await w.getUserBudget(user.id)).limit).toBe(20);
  await w.updateWorkspaceUser(user.id, { tokenLimit: null });
  expect((await w.getUserBudget(user.id)).limit).toBe(500);
});

test("unknown and restarted requests keep their hold until audited reconciliation", async () => {
  const first = await w.reserveWorkspaceTokens(key.id, 100, "openai/test");
  await expect(w.settleWorkspaceTokens(first.id, 0, "manual", "review", "owner")).rejects.toThrow("Only held");
  await w.recoverWorkspaceReservations();
  expect((await w.listWorkspaceRequests(user.id))[0].status).toBe("uncertain");
  expect((await w.getUserBudget(user.id)).reserved).toBe(100);
  await w.settleWorkspaceTokens(first.id, 30, "manual", "Checked provider logs", "owner");
  expect(await w.getUserBudget(user.id)).toMatchObject({ consumed: 30, reserved: 0 });
  expect(db.get("SELECT COUNT(*) AS n FROM workspaceAudit WHERE action = 'request.reconciled'").n).toBe(1);
});

test("UTC month reset keeps late settlement in its original period", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-30T23:59:59Z"));
  const reservation = await w.reserveWorkspaceTokens(key.id, 100, "openai/test");
  vi.setSystemTime(new Date("2026-12-01T00:00:01Z"));
  expect(await w.getUserBudget(user.id)).toMatchObject({ consumed: 0, reserved: 0, period: "2026-12" });
  await w.settleWorkspaceTokens(reservation.id, 90);
  expect(await w.getUserBudget(user.id, "2026-11")).toMatchObject({ consumed: 90, reserved: 0 });
});

test("HTTP boundary enforces ownership, role and same-origin mutations", async () => {
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  const { requireWorkspaceSession } = await import("@/lib/workspaceHttp.js");
  const token = await createDashboardAuthToken({ role: "member", userId: user.id, authVersion: user.authVersion });
  const request = (route, options = {}) => new Request(`http://localhost${route}`, { ...options, headers: { cookie: `tokyard_auth_token=${token}`, ...options.headers } });
  await expect(requireWorkspaceSession(request("/api/workspace"), true)).rejects.toMatchObject({ status: 403 });
  await expect(requireWorkspaceSession(request("/api/workspace/keys", { method: "POST", headers: { origin: "https://evil.example" } }))).rejects.toMatchObject({ status: 403 });
  const rewritten = new Request("http://localhost:20120/api/workspace/keys", { method: "POST", headers: { cookie: `tokyard_auth_token=${token}`, host: "127.0.0.1:20120", origin: "http://127.0.0.1:20120" } });
  expect((await requireWorkspaceSession(rewritten)).userId).toBe(user.id);
  const keysApi = await import("@/app/api/workspace/keys/route.js");
  expect((await keysApi.GET(request("/api/workspace/keys?userId=someone-else"))).status).toBe(403);
  expect((await keysApi.POST(request("/api/workspace/keys", { method: "POST", body: JSON.stringify({ userId: "someone-else", name: "stolen" }) }))).status).toBe(403);
});

test("member keys cannot use native, media or system routing aliases, even locally", async () => {
  const { __test__, proxy } = await import("@/dashboardGuard.js");
  const request = (url, method = "POST", withKey = true) => ({ url: `http://localhost${url}`, nextUrl: new URL(`http://localhost${url}`), method, headers: new Headers(withKey ? { Authorization: `Bearer ${key.key}`, host: "localhost" } : { host: "localhost" }), cookies: { get: () => null } });
  for (const url of ["/v1/images/generations", "/v1/embeddings", "/v1beta/models/test:generateContent", "/systemone", "/api/v1/audio/speech"]) expect(await __test__.canAccessPublicLlmApi(request(url))).toBe(false);
  for (const url of ["/v1/chat/completions", "/api/v1/messages", "/v1/v1/responses", "/responses", "/codex/responses"]) expect(await __test__.canAccessPublicLlmApi(request(url))).toBe(true);
  expect(await __test__.canAccessPublicLlmApi(request("/v1/chat/completions", "POST", false))).toBe(false);
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  const token = await createDashboardAuthToken({ role: "member", userId: user.id, authVersion: user.authVersion });
  const memberRequest = request("/api/providers");
  memberRequest.cookies.get = () => ({ value: token });
  expect((await proxy(memberRequest)).status).toBe(403);
});
