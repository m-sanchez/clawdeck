const { lstat, realpath, readdir, unlink, rmdir } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");

async function runtimeCaches(
  dataDir,
  activeDir,
  now = Date.now(),
  remove = false,
) {
  const dataRoot = await realpath(dataDir).catch(() => null);
  if (!dataRoot) return { bytes: 0, count: 0 };
  const root = join(dataRoot, "dashboard");
  const activeRoot = activeDir
    ? await realpath(activeDir).catch(() => resolve(activeDir))
    : null;
  const same = (a, b) =>
    process.platform === "win32"
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;
  const info = await lstat(root).catch(() => null);
  if (
    !info ||
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    !same(await realpath(root), root)
  )
    return { bytes: 0, count: 0 };
  const result = { bytes: 0, count: 0 };
  const allowed = new Set([
    "panel.token",
    "burn-history.json",
    "lifecycle.json",
  ]);
  for (const name of await readdir(root)) {
    if (!/^[a-f0-9]{48}$/.test(name)) continue;
    const dir = join(root, name);
    if (activeRoot && same(activeRoot, dir)) continue;
    try {
      const entry = await lstat(dir);
      if (
        entry.isSymbolicLink() ||
        !entry.isDirectory() ||
        !same(await realpath(dir), dir) ||
        now - entry.mtimeMs < 7 * 86400000
      )
        continue;
      const files = await readdir(dir);
      const selected = [];
      for (const file of files) {
        if (!allowed.has(file)) break;
        const path = join(dir, file),
          stat = await lstat(path);
        if (
          stat.isSymbolicLink() ||
          !stat.isFile() ||
          stat.nlink !== 1 ||
          !same(await realpath(path), path) ||
          now - stat.mtimeMs < 7 * 86400000
        )
          break;
        selected.push({
          path,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ino: stat.ino,
        });
      }
      if (selected.length !== files.length) continue;
      if (remove) {
        for (const file of selected) {
          const latest = await lstat(file.path);
          if (
            latest.isSymbolicLink() ||
            latest.size !== file.size ||
            latest.mtimeMs !== file.mtimeMs ||
            latest.ino !== file.ino ||
            !same(await realpath(file.path), file.path)
          )
            throw new Error("Cache changed");
          await unlink(file.path);
          result.bytes += file.size;
        }
        await rmdir(dir);
      } else result.bytes += selected.reduce((sum, f) => sum + f.size, 0);
      result.count++;
    } catch {}
  }
  return result;
}

function stopSelection(resources, provider, now = Date.now()) {
  if (!["codex", "claude"].includes(provider))
    throw new Error("Only Codex or Claude can be selected.");
  if (
    resources?.status !== "ready" ||
    !Number.isFinite(resources.sampledAt) ||
    now < resources.sampledAt ||
    now - resources.sampledAt >= 35000
  )
    throw new Error("Process data is stale. Refresh Doctor first.");
  const group = resources.groups.find((g) => g.provider === provider);
  const processes = (group?.processes || []).filter(
    (p) =>
      Number.isSafeInteger(p.pid) &&
      p.pid > 0 &&
      /^\d{17,19}$/.test(p.started) &&
      typeof p.path === "string" &&
      /^[A-Za-z]:[\\/]/.test(p.path),
  );
  if (!processes.length) throw new Error("No verified processes to stop.");
  return {
    provider,
    processes: processes.map((p) => ({
      pid: p.pid,
      started: p.started,
      path: p.path,
      name: p.name,
    })),
    memoryBytes: group.memoryBytes,
    skipped: group.processCount - processes.length,
  };
}

function terminateProcesses(selection) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      join(
        process.env.SystemRoot || "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(
          __dirname.replace(/app\.asar(?=[\\/])/, "app.asar.unpacked"),
          "stop-processes.ps1",
        ),
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          "Stop request timed out. Refresh to check which processes remain.",
        ),
      );
    }, 20000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 131072) child.kill();
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0)
          throw new Error(
            "Windows rejected the stop request. Refresh Doctor to check current processes.",
          );
        resolve(JSON.parse(output));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(selection.processes));
  });
}

class ProcessStops {
  constructor({ sample, sessions, stop = terminateProcesses, now = Date.now }) {
    Object.assign(this, { sample, sessions, stop, now });
    this.plans = new Map();
  }
  plan(provider) {
    const selection = stopSelection(this.sample(), provider, this.now());
    const id = randomBytes(20).toString("hex");
    this.plans.clear();
    this.plans.set(id, { ...selection, created: this.now() });
    return {
      id,
      provider,
      count: selection.processes.length,
      skipped: selection.skipped,
      memoryBytes: selection.memoryBytes,
      running: this.sessions().filter(
        (s) => s.provider === provider && s.execution === "running" && !s.stale,
      ).length,
    };
  }
  async apply(id) {
    const plan = this.plans.get(id);
    this.plans.delete(id);
    if (!plan || this.now() - plan.created > 60000)
      throw new Error("Stop preview expired. Review the app again.");
    const current = stopSelection(this.sample(), plan.provider, this.now());
    const processes = plan.processes.filter((p) =>
      current.processes.some(
        (c) => c.pid === p.pid && c.started === p.started && c.path === p.path,
      ),
    );
    const result = processes.length
      ? await this.stop({ ...plan, processes })
      : { stopped: 0, skipped: 0 };
    return {
      stopped: result.stopped,
      skipped: result.skipped + plan.processes.length - processes.length,
    };
  }
}
module.exports = {
  runtimeCaches,
  stopSelection,
  terminateProcesses,
  ProcessStops,
};
