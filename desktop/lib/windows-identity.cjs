const { existsSync, mkdirSync, readFileSync, renameSync } = require("node:fs");
const { dirname, join, resolve, sep } = require("node:path");
const { randomUUID } = require("node:crypto");

const installedAppId = "uk.co.miguelsanchez.ocelin";

function applicationId(packaged, smokeTest) {
  return `${installedAppId}${smokeTest ? ".tests" : packaged ? "" : ".development"}`;
}

function repairLegacyShortcut(programsDir, backupDir, readShortcut) {
  const shortcut = join(programsDir, "Electron.lnk");
  if (!existsSync(shortcut)) return null;
  const details = readShortcut(shortcut);
  if (
    details.appUserModelId !== installedAppId ||
    !/[\\/]node_modules[\\/]electron[\\/]dist[\\/]electron\.exe$/i.test(
      details.target,
    )
  )
    return null;
  const desktop = resolve(
    dirname(details.target.replaceAll("\\", sep)),
    "../../..",
  );
  let name;
  try {
    name = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")).name;
  } catch {
    return null;
  }
  if (!["ocelin-desktop", "clawdeck-desktop"].includes(name)) return null;
  mkdirSync(backupDir, { recursive: true });
  const backup = join(backupDir, `Electron-${randomUUID()}.lnk`);
  renameSync(shortcut, backup);
  return backup;
}

module.exports = { installedAppId, applicationId, repairLegacyShortcut };
