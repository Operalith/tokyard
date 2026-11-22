import { TABLES } from "../schema.js";

const migration = {
  version: 4,
  name: "workspace-token-breakdown",
  up(db) {
    const existing = new Set(db.all("PRAGMA table_info(workspaceRequests)").map(column => column.name));
    if (!existing.size) return;
    // Historical totals have no reliable split; leave both fields NULL.
    for (const column of ["inputTokens", "outputTokens"]) {
      if (!existing.has(column)) db.exec(`ALTER TABLE workspaceRequests ADD COLUMN ${column} ${TABLES.workspaceRequests.columns[column]}`);
    }
  },
};

export default migration;
