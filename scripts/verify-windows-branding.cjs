const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const { basename, dirname, join, resolve } = require("node:path");

const desktop = resolve(__dirname, "../desktop");
const requireBuild = createRequire(join(desktop, "package.json"));
const PE = requireBuild("pe-library");
const ResEdit = requireBuild("resedit");
const { version } = requireBuild("./package.json");
const hash = (bytes) =>
  createHash("sha256").update(Buffer.from(bytes)).digest("hex");
const ico = readFileSync(join(desktop, "assets/ocelin.ico"));
const expected = new Map();
for (let i = 0; i < ico.readUInt16LE(4); i++) {
  const entry = 6 + i * 16;
  const offset = ico.readUInt32LE(entry + 12);
  expected.set(
    ico[entry] || 256,
    hash(ico.subarray(offset, offset + ico.readUInt32LE(entry + 8))),
  );
}
assert.deepEqual([...expected.keys()], [16, 20, 24, 32, 40, 48, 64, 128, 256]);
const files = process.argv.slice(2);
if (!files.length)
  files.push(
    join(desktop, "dist/win-unpacked/Ocelin.exe"),
    join(desktop, `dist/Ocelin-${version}-x64-setup.exe`),
  );
for (const file of files) {
  if (basename(file) === "Ocelin.exe")
    assert.deepEqual(
      readFileSync(join(dirname(file), "resources/assets/ocelin.ico")),
      ico,
      `${file}: dedicated Windows shell icon`,
    );
  const exe = PE.NtExecutable.from(readFileSync(file), { ignoreCert: true });
  const resources = PE.NtExecutableResource.from(exe);
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
  assert.ok(groups.length, `${file}: icon group missing`);
  for (const group of groups) {
    const icons = group.icons;
    assert.equal(icons.length, expected.size, `${file}: wrong icon count`);
    for (const icon of icons) {
      const resource = resources.entries.find(
        (entry) =>
          entry.type === 3 &&
          entry.id === icon.iconID &&
          entry.lang === group.lang,
      );
      assert.ok(resource, `${file}: icon resource missing`);
      const size = icon.width || 256;
      assert.equal(
        hash(resource.bin),
        expected.get(size),
        `${file}: ${size}px icon is not Ocelin`,
      );
    }
  }
  const versions = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
  assert.ok(versions.length, `${file}: version metadata missing`);
  for (const info of versions) {
    for (const language of info.getAvailableLanguages()) {
      const strings = info.getStringValues(language);
      assert.equal(strings.ProductName, "Ocelin", `${file}: product name`);
      assert.match(
        strings.FileDescription,
        /^Ocelin/,
        `${file}: file description`,
      );
      assert.equal(
        /electron/i.test(JSON.stringify(strings)),
        false,
        `${file}: framework metadata`,
      );
    }
  }
  console.log(`${file}: Ocelin identity and all nine icon sizes verified`);
}
