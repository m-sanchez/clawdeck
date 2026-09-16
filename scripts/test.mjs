import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../tests/", import.meta.url));
const files = readdirSync(root)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join(root, name));
const result = spawnSync(
  process.execPath,
  ["--test", ...process.argv.slice(2), ...files],
  { stdio: "inherit", windowsHide: true },
);
process.exit(result.status ?? 1);
