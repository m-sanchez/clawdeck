import net from "node:net";
import { createHash } from "node:crypto";

export function isPortAvailable(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function allocatePorts({
  checkoutId,
  count,
  preferredBase,
  searchSpan,
}) {
  const digest = createHash("sha256").update(checkoutId).digest();
  const offset = digest.readUInt16BE(0) % Math.max(1, searchSpan - count);
  const first = preferredBase + offset;

  for (let step = 0; step < searchSpan; step += 1) {
    const candidate =
      preferredBase + ((first - preferredBase + step) % searchSpan);
    const ports = Array.from(
      { length: count },
      (_, index) => candidate + index,
    );
    const available = await Promise.all(
      ports.map((port) => isPortAvailable(port)),
    );
    if (available.every(Boolean)) return ports;
  }

  throw new Error(
    `Unable to allocate ${count} local ports in the configured range`,
  );
}
