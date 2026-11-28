import fs from "node:fs";
import path from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { DATA_DIR } from "./dataDir.js";

function loadKey(create) {
  const file = path.join(DATA_DIR, "workspace-key-encryption.key");
  let key;
  try { key = fs.readFileSync(file); }
  catch (error) {
    if (error.code !== "ENOENT" || !create) throw error;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    let fd;
    try {
      fd = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(fd, randomBytes(32));
      fs.fsyncSync(fd);
    } catch (writeError) { if (writeError.code !== "EEXIST") throw writeError; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    key = fs.readFileSync(file);
  }
  if (key.length !== 32) throw new Error("Invalid workspace key encryption file");
  return key;
}

export function sealWorkspaceKey(secret, context, create) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", loadKey(create), nonce);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url")}`;
}

export function openWorkspaceKey(secret, context) {
  if (!secret.startsWith("v1:")) throw new Error("Unsupported workspace key format");
  const bytes = Buffer.from(secret.slice(3), "base64url");
  if (bytes.length <= 28) throw new Error("Invalid workspace key format");
  const decipher = createDecipheriv("aes-256-gcm", loadKey(false), bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
}
