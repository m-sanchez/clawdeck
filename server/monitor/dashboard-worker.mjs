import { setMonitorSnapshot } from "./shared.mjs";
process.env.ELECTRON_RUN_AS_NODE = "1";
process.parentPort.on("message", ({ data }) => {
  if (data.type === "snapshot") setMonitorSnapshot(data.snapshot);
  if (data.type === "stop") process.emit("SIGTERM");
});
await import("../start.mjs");
