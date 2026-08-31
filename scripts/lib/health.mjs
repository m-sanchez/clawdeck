import http from "node:http";

function requestHealth(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 1200 }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 400);
    });
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

export async function isHealthy(url) {
  return requestHealth(url);
}

/** Fetch and parse the JSON health body, or null on any failure. */
export function readHealth(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 1500 }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        return resolve(null);
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (c) => (body += c));
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    request.on("timeout", () => {
      request.destroy();
      resolve(null);
    });
    request.on("error", () => resolve(null));
  });
}

/**
 * Prove a recorded service is still the SAME process we launched: its live /health
 * must return the matching ownership nonce. A reused PID, or a different service on
 * the port, fails this. Legacy registries without a nonce fall back to a plain
 * health probe on the checkout-specific port.
 */
export async function ownsService(service) {
  const health = await readHealth(service.healthUrl);
  if (!health) return false;
  if (service.nonce) return health.nonce === service.nonce;
  return health.status === "ok"; // legacy record: best-effort port-identity
}

export async function waitForHealth(
  url,
  { timeoutMs = 20000, intervalMs = 250 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}
