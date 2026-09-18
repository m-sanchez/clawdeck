import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import identity from "../desktop/lib/windows-identity.cjs";

test("installed, development and smoke builds cannot share taskbar identity", () => {
  assert.equal(identity.applicationId(true, false), identity.installedAppId);
  assert.equal(
    identity.applicationId(false, false),
    `${identity.installedAppId}.development`,
  );
  assert.equal(
    identity.applicationId(true, true),
    `${identity.installedAppId}.tests`,
  );
  assert.equal(
    identity.applicationId(false, true),
    `${identity.installedAppId}.tests`,
  );
});

function fixture(t, name = "ocelin-desktop") {
  const root = mkdtempSync(join(tmpdir(), "ocelin-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const programs = join(root, "programs"),
    backups = join(root, "backups"),
    desktop = join(root, "desktop");
  mkdirSync(programs);
  mkdirSync(desktop);
  writeFileSync(join(desktop, "package.json"), JSON.stringify({ name }));
  const shortcut = join(programs, "Electron.lnk");
  writeFileSync(shortcut, "original shortcut bytes");
  const details = {
    appUserModelId: identity.installedAppId,
    target: join(desktop, "node_modules/electron/dist/electron.exe"),
  };
  return { programs, backups, shortcut, details };
}

test("legacy Ocelin development shortcut is backed up byte-for-byte and repair is idempotent", (t) => {
  const f = fixture(t);
  const backup = identity.repairLegacyShortcut(
    f.programs,
    f.backups,
    () => f.details,
  );
  assert.equal(existsSync(f.shortcut), false);
  assert.equal(readFileSync(backup, "utf8"), "original shortcut bytes");
  assert.equal(
    identity.repairLegacyShortcut(f.programs, f.backups, () => {
      throw new Error("missing shortcut read");
    }),
    null,
  );
});

test("unrelated Electron shortcuts and production executables are preserved", (t) => {
  const f = fixture(t);
  for (const details of [
    { ...f.details, appUserModelId: "another.app" },
    { ...f.details, appUserModelId: identity.applicationId(false, false) },
    { ...f.details, target: join(tmpdir(), "Ocelin.exe") },
  ]) {
    assert.equal(
      identity.repairLegacyShortcut(f.programs, f.backups, () => details),
      null,
    );
    assert.equal(readFileSync(f.shortcut, "utf8"), "original shortcut bytes");
  }
});

test("an ID match without a verified Ocelin development package does not remove a shortcut", (t) => {
  const f = fixture(t, "another-electron-app");
  assert.equal(
    identity.repairLegacyShortcut(f.programs, f.backups, () => f.details),
    null,
  );
  assert.equal(existsSync(f.shortcut), true);
});
