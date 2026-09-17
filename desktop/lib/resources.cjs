const { spawn } = require("node:child_process");
const { join } = require("node:path");
const { summarize } = require("./resource-model.cjs");

class Resources {
  constructor(onChange) {
    this.onChange = onChange;
    this.value = { status: "loading", groups: [], sampledAt: null };
  }
  start() {
    if (process.platform !== "win32")
      return this.fail("Memory sampling is available on Windows");
    const executable = join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    this.child = spawn(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(
          __dirname.replace(/app\.asar(?=[\\/])/, "app.asar.unpacked"),
          "resources.ps1",
        ),
        "-OwnerProcessId",
        String(process.pid),
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) {
        this.fail("Memory sample exceeded its limit");
        this.child.kill();
        return;
      }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const sample = JSON.parse(line);
          if (
            !Array.isArray(sample.processes) ||
            !Number.isFinite(sample.sampledAt)
          )
            continue;
          this.value = summarize(sample, this.previous);
          this.previous = sample;
          this.lastReceived = Date.now();
          this.onChange(this.value);
        } catch {}
      }
    });
    this.child.stderr.on("data", () => {});
    this.child.on("error", () =>
      this.fail("Windows process counters are unavailable"),
    );
    this.child.on("exit", () => {
      if (!this.stopped)
        this.fail("Memory sampler stopped; reopen Ocelin to retry");
    });
    this.watchdog = setInterval(() => {
      if (Date.now() - (this.lastReceived || this.started) > 35000)
        this.fail("Memory sample is delayed");
    }, 15000);
    this.started = Date.now();
  }
  fail(message) {
    this.value = { ...this.value, status: "unavailable", message };
    this.onChange(this.value);
  }
  stop() {
    this.stopped = true;
    clearInterval(this.watchdog);
    this.child?.kill();
  }
}
module.exports = { Resources };
