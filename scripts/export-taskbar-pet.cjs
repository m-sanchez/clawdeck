const { mkdir, readFile, writeFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const { resolve, join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");

const usage = `Export the approved Ocelin component into transparent taskbar assets.

OCELIN_SHARP_PATH must point to a build-only installation of sharp.
PowerShell:
  $env:OCELIN_SHARP_PATH = 'C:\\path\\to\\node_modules\\sharp'
  node scripts/export-taskbar-pet.cjs

Optional: --out <directory>, --frames <count>, --duration <milliseconds>.
Uses desktop/node_modules/electron; no dependency is added to the app.
Defaults: 104×84 pixels, 48 frames, 4800 ms, infinite GIF loop.
PNG files contain the first frame for reduced-motion presentation.`;

if (process.argv.includes("--help")) {
  console.log(usage);
  process.exit(0);
}
if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require("../desktop/node_modules/electron"), [__filename, ...process.argv.slice(2)], {
    env, windowsHide: true, stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = require("electron");
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

const root = resolve(__dirname, "..");
const allowed = new Set([
  "/ui/ocelin/ocelin-element.mjs", "/ui/ocelin/ocelot-art.mjs", "/ui/ocelin/ocelot-motion.mjs",
  "/ui/clawd/clawd-element.mjs", "/ui/clawd/clawd.styles.mjs",
]);
const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;width:160px;height:128px;background:transparent}body{font-family:system-ui,sans-serif}ocelin-assistant{width:140px;height:112px}</style>
<ocelin-assistant state="idle" motion="full" patrol="off" dock="off" bubble="off" badge="off" tooltip="off"></ocelin-assistant>
<script type="module">
import "/ui/ocelin/ocelin-element.mjs";
const pet = document.querySelector("ocelin-assistant");
const root = pet.shadowRoot;
const style = document.createElement("style");
style.textContent = ".assistant.clawd-assistant{left:0!important;top:0!important;bottom:auto!important;--travel-start:0px;--travel-end:0px}*,*::before,*::after{transition:none!important}";
root.append(style);
const painted = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
globalThis.sprite = {
  async state(value) {
    pet.setState(value, { initial: true });
    for (const timer of Object.values(pet._timers)) clearTimeout(timer);
    await document.fonts.ready;
    await painted();
    const limbs = root.querySelectorAll(".clawd-arm,.clawd-leg").length;
    if (limbs !== 4) throw new Error("Expected the approved four-limb artwork");
    this.animations = [...new Set([...root.querySelectorAll("*")].flatMap(node => node.getAnimations()))];
    for (const animation of this.animations) animation.pause();
    return { limbs, animations: this.animations.map(animation => animation.animationName) };
  },
  async seek(time) {
    for (const animation of this.animations) animation.currentTime = time;
    await painted();
  }
};
</script>`;

async function main() {
  const options = { out: join(root, "desktop/integrations/taskbar-widgets/assets"), frames: 48, duration: 4800 };
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i].slice(2), value = process.argv[i + 1];
    if (!Object.hasOwn(options, key) || !value) throw new Error(usage);
    options[key] = key === "out" ? resolve(value) : Number(value);
  }
  if (!Number.isInteger(options.frames) || options.frames < 2 || options.frames > 120 ||
      !Number.isInteger(options.duration) || options.duration < 1000 || options.duration > 30000 ||
      options.duration % (options.frames * 10) !== 0) throw new Error("Use 2–120 frames and a duration divisible by frames × 10 ms.");
  if (!process.env.OCELIN_SHARP_PATH) throw new Error(usage);
  const sharp = require(resolve(process.env.OCELIN_SHARP_PATH));
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== `127.0.0.1:${server.address().port}` || request.method !== "GET") {
        response.writeHead(403).end();
      } else if (request.url === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
      } else if (allowed.has(request.url)) {
        response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }).end(await readFile(join(root, request.url)));
      } else response.writeHead(404).end();
    } catch (error) { response.writeHead(500).end(error.message); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let window;
  try {
    await app.whenReady();
    window = new BrowserWindow({ width: 160, height: 128, show: false, frame: false,
      transparent: true, backgroundColor: "#00000000", useContentSize: true,
      webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    window.webContents.setFrameRate(60);
    await window.loadURL(`http://127.0.0.1:${server.address().port}/`);
    await mkdir(options.out, { recursive: true });
    const report = [];
    for (const state of ["idle", "coding", "attention", "sleeping"]) {
      const geometry = await window.webContents.executeJavaScript(`sprite.state(${JSON.stringify(state)})`);
      const crop = { x: state === "sleeping" ? 32 : 24, y: 8, width: 104, height: 84 };
      const frames = [];
      let first;
      for (let frame = 0; frame < options.frames; frame++) {
        await window.webContents.executeJavaScript(`sprite.seek(${frame * options.duration / options.frames})`);
        const png = (await window.webContents.capturePage(crop)).toPNG();
        first ||= png;
        const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        if (info.width !== crop.width || info.height !== crop.height || info.channels !== 4) throw new Error("Unexpected capture dimensions");
        frames.push(data);
      }
      const gif = await sharp(Buffer.concat(frames), {
        raw: { width: crop.width, height: crop.height * frames.length, channels: 4, pageHeight: crop.height },
      }).gif({ loop: 0, delay: Array(options.frames).fill(options.duration / options.frames), colours: 64, dither: 0, effort: 10 }).toBuffer();
      const encoded = await sharp(gif, { animated: true }).metadata();
      await writeFile(join(options.out, `${state}.png`), first);
      if (!encoded.hasAlpha || encoded.width !== 104 || encoded.pageHeight !== 84 ||
          encoded.delay.reduce((sum, delay) => sum + delay, 0) !== options.duration) throw new Error(`GIF verification failed: ${JSON.stringify(encoded)}`);
      for (const [extension, buffer] of [["png", first], ["gif", gif]]) {
        const file = join(options.out, `${state}.${extension}`);
        await writeFile(file, buffer);
        report.push({ file, width: 104, height: 84, bytes: buffer.length,
          sha256: createHash("sha256").update(buffer).digest("hex"),
          ...(extension === "gif" ? { pages: encoded.pages, duration: options.duration, limbs: geometry.limbs, crop } : {}),
        });
      }
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    window?.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}
main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
