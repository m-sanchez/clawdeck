const { execFile } = require("node:child_process");
const { join } = require("node:path");
function detectProviderApps() {
  if (process.platform !== "win32") return Promise.resolve({});
  const script =
    "$ErrorActionPreference='SilentlyContinue'; $claude=Get-ItemProperty 'Registry::HKEY_CLASSES_ROOT\\claude\\shell\\open\\command'; $codex=Get-AppxPackage -Name OpenAI.Codex; @{claude=[bool]$claude;codex=[bool]$codex} | ConvertTo-Json -Compress";
  return new Promise((resolve) =>
    execFile(
      join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, timeout: 15000, maxBuffer: 65536 },
      (error, stdout) => {
        try {
          resolve(error ? {} : JSON.parse(stdout));
        } catch {
          resolve({});
        }
      },
    ),
  );
}
module.exports = { detectProviderApps };
