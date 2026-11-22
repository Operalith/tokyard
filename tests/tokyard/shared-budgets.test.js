import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, test, expect, vi } from "vitest";

let dir, w, db, first, second, firstKey, secondKey;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokyard-shared-"));
  process.env.DATA_DIR = dir;
  delete global._dbAdapter;
  vi.resetModules();
  w = await import("@/lib/workspace.js");
  db = await w.ensureWorkspace();
  first = await w.createWorkspaceUser({ name: "First", email: "first@example.test", password: "test-password-123" });
  second = await w.createWorkspaceUser({ name: "Second", email: "second@example.test", password: "test-password-123" });
  firstKey = await w.createWorkspaceKey(first.id, "First client");
  secondKey = await w.createWorkspaceKey(second.id, "Second client");
});
afterEach(() => { vi.useRealTimers(); db?.close(); delete global._dbAdapter; fs.rmSync(dir, { recursive: true, force: true }); });

test("fixed is the default; shared mode requires validated pool limits", async () => {
  expect((await w.listProfiles())[0]).toMatchObject({ quotaMode: "fixed", sharedTokenLimit: null, sharedDailyTokenLimit: null, budget: null });
  for (const quotaMode of [null, "other", true]) await expect(w.saveProfile({ quotaMode }, "standard")).rejects.toThrow("Quota mode");
  await expect(w.saveProfile({ quotaMode: "shared" }, "standard")).rejects.toThrow("Set a shared");
  for (const field of ["sharedTokenLimit", "sharedDailyTokenLimit"]) {
    for (const value of [-1, 1.5, "100", true, 1_000_000_000_001]) await expect(w.saveProfile({ [field]: value }, "standard")).rejects.toThrow("allowance");
  }
  await w.saveProfile({ quotaMode: "shared", sharedDailyTokenLimit: 0 }, "standard");
  await expect(w.reserveWorkspaceTokens(firstKey.id, 1, "openai/test")).rejects.toThrow("Shared daily");
});

test("one member can use the unused pool while every member keeps a personal maximum", async () => {
  await w.saveProfile({ quotaMode: "shared", tokenLimit: 20000, sharedTokenLimit: 20000 }, "standard");
  const small = await w.reserveWorkspaceTokens(firstKey.id, 2000, "openai/test");
  await w.settleWorkspaceTokens(small.id, 2000);
  const large = await w.reserveWorkspaceTokens(secondKey.id, 18000, "claude/test");
  await w.settleWorkspaceTokens(large.id, 18000);
  expect(await w.getUserBudget(second.id)).toMatchObject({ consumed: 18000, remaining: 2000, shared: { consumed: 20000, reserved: 0, remaining: 0 } });
  await expect(w.reserveWorkspaceTokens(firstKey.id, 1, "openai/test")).rejects.toThrow("Shared monthly");
  await w.saveProfile({ sharedTokenLimit: 25000 }, "standard");
  await w.updateWorkspaceUser(second.id, { tokenLimit: 18000 });
  await expect(w.reserveWorkspaceTokens(secondKey.id, 1, "claude/test")).rejects.toThrow("Monthly token allowance");
  await w.updateWorkspaceUser(first.id, { dailyTokenLimit: 2000 });
  await expect(w.reserveWorkspaceTokens(firstKey.id, 1, "openai/test")).rejects.toThrow("Daily token allowance");
});

test.each(["sharedTokenLimit", "sharedDailyTokenLimit"])("%s is atomic across members, keys and providers", async field => {
  await w.saveProfile({ quotaMode: "shared", [field]: 100 }, "standard");
  const rotated = await w.createWorkspaceKey(first.id, "Another client");
  const attempts = await Promise.allSettled([w.reserveWorkspaceTokens(firstKey.id, 60, "openai/test"), w.reserveWorkspaceTokens(secondKey.id, 60, "claude/test"), w.reserveWorkspaceTokens(rotated.id, 60, "openai/test")]);
  expect(attempts.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const reservation = attempts.find(r => r.status === "fulfilled").value;
  const pool = () => w.getUserBudget(first.id).then(b => field === "sharedTokenLimit" ? b.shared : b.shared.daily);
  expect(await pool()).toMatchObject({ consumed: 0, reserved: 60, remaining: 40 });
  expect(db.get("SELECT COUNT(*) AS n FROM workspaceRequests").n).toBe(1);
  await w.settleWorkspaceTokens(reservation.id, 45);
  await w.settleWorkspaceTokens(reservation.id, 45);
  expect(await pool()).toMatchObject({ consumed: 45, reserved: 0, remaining: 55 });
  await w.reserveWorkspaceTokens(secondKey.id, 55, "claude/test");
  expect(await pool()).toMatchObject({ consumed: 45, reserved: 55, remaining: 0 });
});

test("switching modes includes earlier usage and holds without resetting either", async () => {
  const settled = await w.reserveWorkspaceTokens(firstKey.id, 60, "openai/test");
  await w.settleWorkspaceTokens(settled.id, 40);
  const held = await w.reserveWorkspaceTokens(secondKey.id, 60, "claude/test");
  await w.recoverWorkspaceReservations();
  await w.saveProfile({ quotaMode: "shared", sharedTokenLimit: 100, sharedDailyTokenLimit: 100 }, "standard");
  expect((await w.listProfiles())[0].budget).toMatchObject({ consumed: 40, reserved: 60, remaining: 0, daily: { consumed: 40, reserved: 60, remaining: 0 } });
  await expect(w.reserveWorkspaceTokens(firstKey.id, 1, "openai/test")).rejects.toThrow("Shared daily");
  await w.settleWorkspaceTokens(held.id, 10, "manual", "Verified provider logs", "owner");
  expect((await w.getUserBudget(first.id)).shared).toMatchObject({ consumed: 50, reserved: 0, remaining: 50 });
  await w.saveProfile({ quotaMode: "fixed", sharedTokenLimit: 0, sharedDailyTokenLimit: 0 }, "standard");
  expect((await w.getUserBudget(first.id)).shared).toBeNull();
  const fixed = await w.reserveWorkspaceTokens(firstKey.id, 100, "openai/test");
  await w.settleWorkspaceTokens(fixed.id, 100);
  await w.saveProfile({ quotaMode: "shared", sharedTokenLimit: 100, sharedDailyTokenLimit: null }, "standard");
  expect((await w.getUserBudget(first.id)).shared).toMatchObject({ consumed: 150, remaining: 0 });
});

test("profile moves never erase or transfer an earlier pool reservation", async () => {
  await w.saveProfile({ quotaMode: "shared", sharedTokenLimit: 100 }, "standard");
  const other = await w.saveProfile({ name: "Other pool", quotaMode: "shared", sharedTokenLimit: 100 });
  const old = await w.reserveWorkspaceTokens(firstKey.id, 80, "openai/test");
  await w.updateWorkspaceUser(first.id, { profileId: other.id });
  expect(await w.getUserBudget(first.id)).toMatchObject({ reserved: 80, shared: { consumed: 0, reserved: 0, remaining: 100 } });
  expect((await w.getUserBudget(second.id)).shared).toMatchObject({ reserved: 80, remaining: 20 });
  await w.settleWorkspaceTokens(old.id, 30);
  expect((await w.getUserBudget(second.id)).shared).toMatchObject({ consumed: 30, reserved: 0, remaining: 70 });
  expect((await w.getUserBudget(first.id)).shared).toMatchObject({ consumed: 0, reserved: 0, remaining: 100 });
  expect(db.get("SELECT profileId FROM workspaceRequests WHERE id = ?", [old.id]).profileId).toBe("standard");
});

test("UTC day/month resets and late over-limit settlement stay in the original pool period", async () => {
  await w.saveProfile({ quotaMode: "shared", sharedTokenLimit: 100, sharedDailyTokenLimit: 100 }, "standard");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-30T23:59:59Z"));
  const old = await w.reserveWorkspaceTokens(firstKey.id, 100, "openai/test");
  await w.recoverWorkspaceReservations();
  vi.setSystemTime(new Date("2026-12-01T00:00:01Z"));
  expect((await w.getUserBudget(second.id)).shared).toMatchObject({ consumed: 0, reserved: 0, remaining: 100, daily: { remaining: 100 } });
  await w.reserveWorkspaceTokens(secondKey.id, 90, "claude/test");
  await w.settleWorkspaceTokens(old.id, 110, "manual", "Verified provider logs", "owner");
  expect((await w.getUserBudget(second.id)).shared).toMatchObject({ consumed: 0, reserved: 90, remaining: 10 });
  vi.setSystemTime(new Date("2026-11-30T23:59:59Z"));
  expect((await w.getUserBudget(second.id)).shared).toMatchObject({ consumed: 110, reserved: 0, remaining: 0, daily: { consumed: 110, remaining: 0 } });
  await expect(w.reserveWorkspaceTokens(secondKey.id, 1, "claude/test")).rejects.toThrow("Shared daily");
});

test("schema 4 upgrade preserves counters, keys and held rows, assigning old rows once", async () => {
  const settled = await w.reserveWorkspaceTokens(firstKey.id, 100, "openai/test");
  await w.settleWorkspaceTokens(settled.id, 80);
  await w.reserveWorkspaceTokens(secondKey.id, 50, "claude/test");
  db.exec("DROP INDEX idx_wr_profile_period");
  db.exec("ALTER TABLE workspaceRequests DROP COLUMN profileId");
  for (const column of ["quotaMode", "sharedTokenLimit", "sharedDailyTokenLimit"]) db.exec(`ALTER TABLE workspaceProfiles DROP COLUMN ${column}`);
  db.run("UPDATE _meta SET value = '4' WHERE key = 'backupSchemaVersion'");
  db.run("UPDATE _meta SET value = '1' WHERE key = 'schemaVersion'");
  db.close(); delete global._dbAdapter; vi.resetModules();
  w = await import("@/lib/workspace.js"); db = await w.ensureWorkspace();
  expect((await w.listProfiles())[0].quotaMode).toBe("fixed");
  expect(await w.getUserBudget(first.id)).toMatchObject({ consumed: 80, reserved: 0, shared: null });
  expect(await w.getUserBudget(second.id)).toMatchObject({ consumed: 0, reserved: 50 });
  expect(db.get("SELECT key FROM apiKeys WHERE id = ?", [firstKey.id]).key).toBe(w.hashWorkspaceKey(firstKey.key));
  expect(db.all("SELECT DISTINCT profileId FROM workspaceRequests").map(row => row.profileId)).toEqual(["standard"]);
  expect(fs.readdirSync(path.join(dir, "db/backups")).some(name => name.startsWith("schema-4-to-6-"))).toBe(true);
  await w.saveProfile({ quotaMode: "shared", sharedTokenLimit: 130 }, "standard");
  await expect(w.reserveWorkspaceTokens(firstKey.id, 1, "openai/test")).rejects.toThrow("Shared monthly");
});
