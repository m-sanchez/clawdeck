import { execFileSync } from "node:child_process";

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function stopProcessTree(pid) {
  if (!isProcessAlive(pid)) return { stopped: false, reason: "not-running" };

  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
    }
    return { stopped: true };
  } catch (error) {
    return { stopped: false, reason: error?.message ?? String(error) };
  }
}
