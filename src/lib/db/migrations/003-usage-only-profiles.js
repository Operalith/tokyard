import { TABLES } from "../schema.js";

const migration = {
  version: 3,
  name: "usage-only-profiles",
  up(db) {
    const columns = db.all("PRAGMA table_info(workspaceProfiles)");
    if (columns.length && !columns.some(column => column.name === "usageOnly")) {
      db.exec(`ALTER TABLE workspaceProfiles ADD COLUMN usageOnly ${TABLES.workspaceProfiles.columns.usageOnly}`);
    }
  },
};

export default migration;
