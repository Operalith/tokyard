import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test, expect, vi } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);

test("app and standalone MITM resolve the same TokYard data directory", async () => {
  const previous = process.env.DATA_DIR;
  delete process.env.DATA_DIR;
  try {
    vi.resetModules();
    const { getDataDir } = await import("@/lib/dataDir.js");
    const mitmPaths = path.join(root, "src/mitm/paths.js");
    delete require.cache[mitmPaths];
    const { DATA_DIR, MITM_DIR } = require(mitmPaths);
    expect(path.basename(getDataDir())).toMatch(/^\.?tokyard$/);
    expect(DATA_DIR).toBe(getDataDir());
    expect(MITM_DIR).toBe(path.join(getDataDir(), "mitm"));
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
  }
});

// Upstream 9router merges reintroduce these; TokYard runs alongside 9router and must not share its directory or port.
test("no code builds a 9router data path or defaults to port 20128", () => {
  const hits = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(c|m)?js$/.test(entry.name)) {
        fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
          if (/["'`]\.9router|AppData", "Roaming"\), "9router"|APPDATA[^)]*\), "9router"|APPDATA \|\| "", "9router"|\b20128\b/.test(line)) hits.push(`${path.relative(root, file)}:${i + 1}`);
        });
      }
    }
  };
  for (const dir of ["src", "open-sse", "cli"]) walk(path.join(root, dir));
  expect(hits).toEqual([]);
});
