import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

export async function readJson(path, fallback = undefined) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (fallback !== undefined && error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(path, value) {
  await ensureDir(dirname(path));
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

export async function safeRemove(path) {
  await rm(path, { recursive: true, force: true });
}
