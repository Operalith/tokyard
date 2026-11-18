import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { getAdapter } from "./db/driver.js";

export class WorkspaceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const fail = (message, status) => { throw new WorkspaceError(message, status); };
export const hashWorkspaceKey = (key) => `sha256:${createHash("sha256").update(key).digest("hex")}`;
export const currentPeriod = (date = new Date()) => date.toISOString().slice(0, 7);
export const currentDay = (date = new Date()) => date.toISOString().slice(0, 10);
const nextReset = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();
const nextDailyReset = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString();

function text(value, label, max = 120) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) fail(`${label} is required (maximum ${max} characters)`);
  return value.trim();
}

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} must be an integer between ${min} and ${max}`);
  return value;
}

function password(value) {
  if (typeof value !== "string" || value.length < 12 || Buffer.byteLength(value) > 72) fail("Password must contain at least 12 characters and at most 72 UTF-8 bytes");
  return value;
}

function audit(db, actor, action, subjectId, details = {}) {
  db.run("INSERT INTO workspaceAudit(id, actor, action, subjectId, details, createdAt) VALUES(?, ?, ?, ?, ?, ?)", [randomUUID(), actor, action, subjectId, JSON.stringify(details), new Date().toISOString()]);
}

export async function ensureWorkspace() {
  const db = await getAdapter();
  globalThis._tokyardRecoveredDbs ||= new WeakSet();
  if (!globalThis._tokyardRecoveredDbs.has(db)) {
    db.run("UPDATE workspaceRequests SET status = 'uncertain', note = 'Server restarted before usage was settled' WHERE status = 'reserved'");
    globalThis._tokyardRecoveredDbs.add(db);
  }
  db.run("INSERT OR IGNORE INTO workspaceProfiles(id, name, tokenLimit, maxConcurrent, maxOutputTokens, allowedModels, createdAt) VALUES('standard', 'Standard', 1000000, 2, 4096, '[]', ?)", [new Date().toISOString()]);
  return db;
}

function profile(row) { return row ? { ...row, allowedModels: JSON.parse(row.allowedModels) } : null; }

export async function listProfiles() {
  const db = await ensureWorkspace();
  const now = new Date();
  return db.all("SELECT * FROM workspaceProfiles ORDER BY createdAt, name").map(row => ({ ...profile(row), budget: sharedBudget(db, row.id, row, now) }));
}

export async function saveProfile(input, id = null, actor = "owner") {
  const db = await ensureWorkspace();
  const existing = id ? db.get("SELECT * FROM workspaceProfiles WHERE id = ?", [id]) : null;
  if (id && !existing) fail("Profile not found", 404);
  const data = { ...(existing ? profile(existing) : { tokenLimit: 1000000, dailyTokenLimit: null, quotaMode: "fixed", sharedTokenLimit: null, sharedDailyTokenLimit: null, maxConcurrent: 2, maxOutputTokens: 4096, allowedModels: [] }), ...input };
  const name = text(data.name, "Profile name", 60);
  const tokenLimit = integer(data.tokenLimit, "Token allowance", 0, 1_000_000_000_000);
  const dailyTokenLimit = data.dailyTokenLimit === null ? null : integer(data.dailyTokenLimit, "Daily token allowance", 0, 1_000_000_000_000);
  const { quotaMode } = data;
  if (!["fixed", "shared"].includes(quotaMode)) fail("Quota mode must be fixed or shared");
  const sharedTokenLimit = data.sharedTokenLimit === null ? null : integer(data.sharedTokenLimit, "Shared monthly token allowance", 0, 1_000_000_000_000);
  const sharedDailyTokenLimit = data.sharedDailyTokenLimit === null ? null : integer(data.sharedDailyTokenLimit, "Shared daily token allowance", 0, 1_000_000_000_000);
  if (quotaMode === "shared" && sharedTokenLimit === null && sharedDailyTokenLimit === null) fail("Set a shared monthly or daily allowance");
  const maxConcurrent = integer(data.maxConcurrent, "Concurrent requests", 1, 20);
  const maxOutputTokens = integer(data.maxOutputTokens, "Output token limit", 1, 32768);
  if (!Array.isArray(data.allowedModels) || data.allowedModels.length > 200 || data.allowedModels.some(m => typeof m !== "string" || !m.trim() || m.length > 256)) fail("Allowed models must contain at most 200 model identifiers");
  const allowedModels = [...new Set(data.allowedModels.map(m => m.trim()))];
  if (db.get("SELECT id FROM workspaceProfiles WHERE name = ? AND id != ?", [name, id || ""])) fail("Profile name already exists", 409);
  const profileId = id || randomUUID();
  db.transaction(() => {
    if (id) db.run("UPDATE workspaceProfiles SET name = ?, tokenLimit = ?, dailyTokenLimit = ?, quotaMode = ?, sharedTokenLimit = ?, sharedDailyTokenLimit = ?, maxConcurrent = ?, maxOutputTokens = ?, allowedModels = ? WHERE id = ?", [name, tokenLimit, dailyTokenLimit, quotaMode, sharedTokenLimit, sharedDailyTokenLimit, maxConcurrent, maxOutputTokens, JSON.stringify(allowedModels), id]);
    else db.run("INSERT INTO workspaceProfiles(id, name, tokenLimit, dailyTokenLimit, quotaMode, sharedTokenLimit, sharedDailyTokenLimit, maxConcurrent, maxOutputTokens, allowedModels, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [profileId, name, tokenLimit, dailyTokenLimit, quotaMode, sharedTokenLimit, sharedDailyTokenLimit, maxConcurrent, maxOutputTokens, JSON.stringify(allowedModels), new Date().toISOString()]);
    audit(db, actor, id ? "profile.updated" : "profile.created", profileId, { name, tokenLimit, dailyTokenLimit, quotaMode, sharedTokenLimit, sharedDailyTokenLimit, allowedModels });
  });
  return profile(db.get("SELECT * FROM workspaceProfiles WHERE id = ?", [profileId]));
}

export async function getWorkspaceUser(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT u.*, p.name AS profileName, p.tokenLimit AS profileTokenLimit, p.dailyTokenLimit AS profileDailyTokenLimit,
    p.allowedModels, p.maxConcurrent, p.maxOutputTokens, p.quotaMode, p.sharedTokenLimit, p.sharedDailyTokenLimit FROM workspaceUsers u
    JOIN workspaceProfiles p ON p.id = u.profileId WHERE u.id = ?`, [id]);
  if (!row) return null;
  const { passwordHash, ...user } = row;
  return { ...user, isActive: !!row.isActive, tokenLimit: row.tokenLimit ?? row.profileTokenLimit, tokenLimitOverride: row.tokenLimit, dailyTokenLimit: row.dailyTokenLimit ?? row.profileDailyTokenLimit, dailyTokenLimitOverride: row.dailyTokenLimit, allowedModels: JSON.parse(row.allowedModels) };
}

export async function createWorkspaceUser(input, actor = "owner") {
  const db = await ensureWorkspace();
  const name = text(input.name, "Name");
  const email = text(input.email, "Email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("Enter a valid email address");
  const profileId = text(input.profileId || "standard", "Profile");
  if (!db.get("SELECT id FROM workspaceProfiles WHERE id = ?", [profileId])) fail("Profile not found", 404);
  if (db.get("SELECT id FROM workspaceUsers WHERE email = ?", [email])) fail("Email already exists", 409);
  const hash = await bcrypt.hash(password(input.password), 12);
  const id = randomUUID();
  db.transaction(() => {
    db.run("INSERT INTO workspaceUsers(id, name, email, passwordHash, profileId, createdAt) VALUES(?, ?, ?, ?, ?, ?)", [id, name, email, hash, profileId, new Date().toISOString()]);
    audit(db, actor, "user.created", id, { name, email, profileId });
  });
  return getWorkspaceUser(id);
}

export async function updateWorkspaceUser(id, input, actor = "owner") {
  const db = await getAdapter();
  const user = await getWorkspaceUser(id);
  if (!user) fail("User not found", 404);
  const name = input.name === undefined ? user.name : text(input.name, "Name");
  const profileId = input.profileId === undefined ? user.profileId : text(input.profileId, "Profile");
  if (!db.get("SELECT id FROM workspaceProfiles WHERE id = ?", [profileId])) fail("Profile not found", 404);
  if (input.isActive !== undefined && typeof input.isActive !== "boolean") fail("isActive must be a boolean");
  const active = input.isActive === undefined ? user.isActive : input.isActive;
  const override = input.tokenLimit === undefined ? user.tokenLimitOverride : input.tokenLimit === null ? null : integer(input.tokenLimit, "Token allowance", 0, 1_000_000_000_000);
  const dailyOverride = input.dailyTokenLimit === undefined ? user.dailyTokenLimitOverride : input.dailyTokenLimit === null ? null : integer(input.dailyTokenLimit, "Daily token allowance", 0, 1_000_000_000_000);
  const hash = input.password === undefined ? null : await bcrypt.hash(password(input.password), 12);
  db.transaction(() => {
    db.run("UPDATE workspaceUsers SET name = ?, profileId = ?, tokenLimit = ?, dailyTokenLimit = ?, isActive = ?, passwordHash = COALESCE(?, passwordHash), authVersion = authVersion + ? WHERE id = ?", [name, profileId, override, dailyOverride, active ? 1 : 0, hash, hash || input.isActive !== undefined ? 1 : 0, id]);
    audit(db, actor, "user.updated", id, { name, profileId, tokenLimit: override, dailyTokenLimit: dailyOverride, isActive: active, passwordChanged: !!hash });
  });
  return getWorkspaceUser(id);
}

const dummyPasswordHash = bcrypt.hashSync("tokyard-dummy-password-never-used", 12);
export async function authenticateWorkspaceUser(email, secret) {
  if (typeof email !== "string" || typeof secret !== "string" || email.length > 254 || Buffer.byteLength(secret) > 72) return null;
  const db = await getAdapter();
  const row = db.get("SELECT id, passwordHash, isActive FROM workspaceUsers WHERE email = ?", [email.trim().toLowerCase()]);
  const valid = await bcrypt.compare(secret, row?.passwordHash || dummyPasswordHash);
  return valid && row?.isActive ? getWorkspaceUser(row.id) : null;
}

function ledgerUsage(db, column, id, period, day = null) {
  // ponytail: scan one indexed monthly ledger; add daily/profile rollups if request volume makes this expensive.
  return db.get(`SELECT COALESCE(SUM(CASE WHEN status = 'settled' THEN actualTokens ELSE 0 END), 0) AS consumed,
    COALESCE(SUM(CASE WHEN status != 'settled' THEN reservedTokens ELSE 0 END), 0) AS reserved
    FROM workspaceRequests WHERE ${column} = ? AND period = ?${day ? " AND substr(createdAt, 1, 10) = ?" : ""}`, [id, period, ...(day ? [day] : [])]);
}

const dailyUsage = (db, userId, day) => ledgerUsage(db, "userId", userId, day.slice(0, 7), day);
const balance = (usage, limit, period, resetsAt) => ({ ...usage, limit, remaining: limit === null ? null : Math.max(0, limit - usage.consumed - usage.reserved), period, resetsAt });

function sharedBudget(db, profileId, policy, now, period = currentPeriod(now)) {
  if (policy.quotaMode !== "shared") return null;
  const day = currentDay(now);
  return { ...balance(ledgerUsage(db, "profileId", profileId, period), policy.sharedTokenLimit, period, nextReset(now)),
    daily: balance(ledgerUsage(db, "profileId", profileId, day.slice(0, 7), day), policy.sharedDailyTokenLimit, day, nextDailyReset(now)) };
}

export async function getUserBudget(id, period = null) {
  const now = new Date();
  period ??= currentPeriod(now);
  const db = await getAdapter();
  const user = await getWorkspaceUser(id);
  if (!user) fail("User not found", 404);
  const counter = db.get("SELECT consumed, reserved FROM workspacePeriods WHERE userId = ? AND period = ?", [id, period]) || { consumed: 0, reserved: 0 };
  const day = currentDay(now), daily = dailyUsage(db, id, day);
  const budget = { ...balance(counter, user.tokenLimit, period, nextReset(now)), daily: balance(daily, user.dailyTokenLimit, day, nextDailyReset(now)),
    shared: sharedBudget(db, user.profileId, user, now, period) };
  return { ...budget, available: Math.min(budget.remaining, budget.daily.remaining ?? Infinity, budget.shared?.remaining ?? Infinity, budget.shared?.daily.remaining ?? Infinity) };
}

export async function listWorkspaceUsers() {
  const db = await ensureWorkspace();
  return Promise.all(db.all("SELECT id FROM workspaceUsers ORDER BY createdAt").map(async ({ id }) => ({ ...await getWorkspaceUser(id), budget: await getUserBudget(id) })));
}

export async function createWorkspaceKey(userId, name, actor = "owner") {
  const db = await getAdapter();
  const user = await getWorkspaceUser(userId);
  if (!user?.isActive) fail("User is unavailable", 404);
  const label = text(name, "Key name", 80);
  if (db.get("SELECT COUNT(*) AS n FROM apiKeys WHERE userId = ? AND isActive = 1", [userId]).n >= 20) fail("Revoke an existing key before creating another", 409);
  const key = `ty_${randomBytes(32).toString("base64url")}`;
  const id = randomUUID(), prefix = `${key.slice(0, 10)}…${key.slice(-4)}`;
  db.transaction(() => {
    db.run("INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow, userId, prefix) VALUES(?, ?, ?, 'tokyard', 1, ?, 0, '[]', ?, ?)", [id, hashWorkspaceKey(key), label, new Date().toISOString(), userId, prefix]);
    audit(db, actor, "key.created", id, { userId, name: label, prefix });
  });
  return { id, name: label, prefix, key };
}

export async function listWorkspaceKeys(userId) {
  const db = await getAdapter();
  return db.all("SELECT id, name, prefix, isActive, createdAt FROM apiKeys WHERE userId = ? ORDER BY createdAt DESC", [userId]).map(k => ({ ...k, isActive: !!k.isActive }));
}

export async function revokeWorkspaceKey(userId, id, actor = "owner") {
  const db = await getAdapter();
  if (!db.get("SELECT id FROM apiKeys WHERE id = ? AND userId = ?", [id, userId])) fail("Key not found", 404);
  db.transaction(() => { db.run("UPDATE apiKeys SET isActive = 0 WHERE id = ? AND userId = ?", [id, userId]); audit(db, actor, "key.revoked", id, { userId }); });
}

export async function reserveWorkspaceTokens(keyId, tokens, model) {
  integer(tokens, "Reserved tokens", 1, 1_000_000_000_000);
  const db = await ensureWorkspace();
  if (db.driver === "sql.js") fail("Token budgets require a persistent SQLite driver", 503);
  const key = db.get("SELECT userId, isActive FROM apiKeys WHERE id = ?", [keyId]);
  if (!key?.isActive || !key.userId) fail("Invalid API key", 401);
  const id = randomUUID(), now = new Date().toISOString(), period = now.slice(0, 7);
  db.transaction(() => {
    const user = db.get("SELECT u.isActive, u.profileId, COALESCE(u.tokenLimit, p.tokenLimit) AS tokenLimit, COALESCE(u.dailyTokenLimit, p.dailyTokenLimit) AS dailyTokenLimit, p.maxConcurrent, p.quotaMode, p.sharedTokenLimit, p.sharedDailyTokenLimit FROM workspaceUsers u JOIN workspaceProfiles p ON p.id = u.profileId WHERE u.id = ?", [key.userId]);
    if (!user?.isActive) fail("User access is disabled", 403);
    // ponytail: one server instance; use a shared transactional DB before adding replicas.
    const pending = db.get("SELECT COUNT(*) AS n FROM workspaceRequests WHERE userId = ? AND status = 'reserved'", [key.userId]).n;
    if (pending >= user.maxConcurrent) fail("Concurrent request limit reached", 429);
    if (user.dailyTokenLimit !== null) {
      const daily = dailyUsage(db, key.userId, now.slice(0, 10));
      if (daily.consumed + daily.reserved + tokens > user.dailyTokenLimit) fail("Daily token allowance exhausted or insufficient for this request", 429);
    }
    const shared = sharedBudget(db, user.profileId, user, new Date(now));
    if (shared && shared.daily.remaining !== null && tokens > shared.daily.remaining) fail("Shared daily token allowance exhausted or insufficient for this request", 429);
    if (shared && shared.remaining !== null && tokens > shared.remaining) fail("Shared monthly token allowance exhausted or insufficient for this request", 429);
    db.run("INSERT OR IGNORE INTO workspacePeriods(userId, period) VALUES(?, ?)", [key.userId, period]);
    const result = db.run("UPDATE workspacePeriods SET reserved = reserved + ? WHERE userId = ? AND period = ? AND consumed + reserved + ? <= ?", [tokens, key.userId, period, tokens, user.tokenLimit]);
    if (!result.changes) fail("Monthly token allowance exhausted or insufficient for this request", 429);
    db.run("INSERT INTO workspaceRequests(id, userId, profileId, keyId, period, model, reservedTokens, status, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?, 'reserved', ?)", [id, key.userId, user.profileId, keyId, period, model, tokens, now]);
  });
  return { id, userId: key.userId, tokens, period };
}

export async function settleWorkspaceTokens(id, actualTokens, source = "provider", note = null, actor = null) {
  integer(actualTokens, "Actual tokens", 0, 1_000_000_000_000);
  const db = await getAdapter();
  return db.transaction(() => {
    const row = db.get("SELECT * FROM workspaceRequests WHERE id = ?", [id]);
    if (!row) fail("Request not found", 404);
    if (row.status === "settled") return row;
    if (actor && row.status !== "uncertain") fail("Only held requests can be reconciled", 409);
    db.run("UPDATE workspacePeriods SET reserved = reserved - ?, consumed = consumed + ? WHERE userId = ? AND period = ?", [row.reservedTokens, actualTokens, row.userId, row.period]);
    db.run("UPDATE workspaceRequests SET status = 'settled', actualTokens = ?, source = ?, note = ?, settledAt = ? WHERE id = ?", [actualTokens, source, note, new Date().toISOString(), id]);
    if (actor) audit(db, actor, "request.reconciled", id, { actualTokens, note });
    return db.get("SELECT * FROM workspaceRequests WHERE id = ?", [id]);
  });
}

export async function markWorkspaceUncertain(id, note) {
  const db = await getAdapter();
  db.run("UPDATE workspaceRequests SET status = 'uncertain', note = ? WHERE id = ? AND status = 'reserved'", [note, id]);
}

export async function recoverWorkspaceReservations() {
  const db = await getAdapter();
  // A server boot cannot prove abandoned requests were free. Keep their budget held.
  db.run("UPDATE workspaceRequests SET status = 'uncertain', note = 'Server restarted before usage was settled' WHERE status = 'reserved'");
}

export async function listWorkspaceRequests(userId = null) {
  const db = await getAdapter();
  return userId ? db.all("SELECT * FROM workspaceRequests WHERE userId = ? ORDER BY createdAt DESC LIMIT 100", [userId]) : db.all("SELECT r.*, u.name AS userName FROM workspaceRequests r JOIN workspaceUsers u ON u.id = r.userId ORDER BY r.createdAt DESC LIMIT 100");
}
