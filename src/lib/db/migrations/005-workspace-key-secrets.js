import { TABLES } from "../schema.js";

const migration = {
  version: 5,
  name: "workspace-key-secrets",
  up(db) {
    const columns = db.all("PRAGMA table_info(apiKeys)");
    if (columns.length && !columns.some(column => column.name === "encryptedKey")) {
      // Existing SHA-256 hashes cannot be reversed; preserve their authentication.
      db.exec(`ALTER TABLE apiKeys ADD COLUMN encryptedKey ${TABLES.apiKeys.columns.encryptedKey}`);
    }
  },
};

export default migration;
