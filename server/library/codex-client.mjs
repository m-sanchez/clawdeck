import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import { homedir } from "node:os";

export function codexExecutable(env = process.env) {
  const candidates = [
    join(
      env.LOCALAPPDATA || "",
      "Programs",
      "OpenAI",
      "Codex",
      "bin",
      "codex.exe",
    ),
    join(homedir(), ".local", "bin", "codex.exe"),
    ...(env.PATH || "")
      .split(delimiter)
      .filter(Boolean)
      .map((p) =>
        join(p, process.platform === "win32" ? "codex.exe" : "codex"),
      ),
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

export class CodexClient {
  constructor({
    executable = codexExecutable(),
    env = process.env,
    timeout = 15000,
  } = {}) {
    Object.assign(this, { executable, env, timeout });
    this.pending = new Map();
    this.sequence = 0;
  }
  async start() {
    if (this.ready) return this.ready;
    if (!this.executable)
      throw new Error("Install the Codex CLI to manage native archives.");
    this.ready = (async () => {
      this.child = spawn(this.executable, ["app-server", "--stdio"], {
        env: this.env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
      const child = this.child;
      let buffer = "";
      this.child.stdout.setEncoding("utf8");
      this.child.stdout.on("data", (chunk) => {
        if (this.child !== child) return;
        buffer += chunk;
        if (buffer.length > 8 * 1024 * 1024) {
          this.stop();
          return;
        }
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const message = JSON.parse(line);
            const pending = this.pending.get(message.id);
            if (!pending) continue;
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            if (message.error)
              pending.reject(
                new Error(message.error.message || "Codex request failed"),
              );
            else pending.resolve(message.result);
          } catch {}
        }
      });
      child.on("error", (error) => {
        if (this.child === child) this.fail(error);
      });
      child.on("exit", () => {
        if (this.child === child)
          this.fail(new Error("Codex connection closed"));
      });
      child.stdin.on("error", (error) => {
        if (this.child === child) this.fail(error);
      });
      const initialized = await this.request("initialize", {
        clientInfo: {
          name: "ocelin",
          title: "Ocelin session library",
          version: "0.6.0",
        },
        capabilities: { experimentalApi: true },
      });
      this.child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
      return initialized;
    })().catch((error) => {
      this.stop();
      throw error;
    });
    return this.ready;
  }
  fail(error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.ready = null;
  }
  request(method, params) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(
          "Codex did not reply. The result is uncertain; refresh before retrying.",
        );
        error.code = "OUTCOME_UNKNOWN";
        reject(error);
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  async call(method, params) {
    clearTimeout(this.idle);
    await this.start();
    try {
      return await this.request(method, params);
    } finally {
      clearTimeout(this.idle);
      this.idle = setTimeout(() => {
        if (!this.pending.size) this.stop();
      }, 30000);
      this.idle.unref();
    }
  }
  stop() {
    clearTimeout(this.idle);
    this.child?.stdin.end();
    this.child?.kill();
    this.child = null;
    this.fail(new Error("Codex connection stopped"));
  }
}
