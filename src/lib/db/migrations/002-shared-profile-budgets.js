import { TABLES } from "../schema.js";

export default {
  version: 2,
  name: "shared-profile-budgets",
  up(db) {
    for (const [table, columns] of Object.entries({ workspaceProfiles: ["quotaMode", "sharedTokenLimit", "sharedDailyTokenLimit"], workspaceRequests: ["profileId"] })) {
      const existing = new Set(db.all(`PRAGMA table_info(${table})`).map(row => row.name));
      for (const column of columns) {
        if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${TABLES[table].columns[column]}`);
      }
    }
    // Old ledger rows have no profile snapshot; use membership at upgrade once.
    db.exec("UPDATE workspaceRequests SET profileId = (SELECT profileId FROM workspaceUsers WHERE id = workspaceRequests.userId) WHERE profileId IS NULL");
    db.exec("CREATE INDEX IF NOT EXISTS idx_wr_profile_period ON workspaceRequests(profileId, period)");
  },
};
