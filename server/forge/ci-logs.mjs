// @ts-check
/**
 * The tail of a failed job's log, read-only and bounded.
 *
 * A CI log is arbitrary text a third party's build printed: it can be tens of
 * megabytes, it can contain terminal escapes, and it can contain something that
 * reads like an instruction. So only the tail is kept, at a fixed byte bound,
 * and the caller secret-scans what comes back before it reaches a person or a
 * packet. Nothing here decides anything - it returns text and says how much of
 * the log it is.
 */

const TIMEOUT_MS = 12000;
export const TAIL_BYTES = 32768;

/** Keep the end of the log: a failure's cause is at the bottom, not the top. */
function tail(text, limit = TAIL_BYTES) {
  const s = String(text ?? "");
  if (s.length <= limit) return { text: s, truncated: false };
  // Start at the first line break after the cut so the first line is whole.
  const cut = s.slice(s.length - limit);
  const nl = cut.indexOf("\n");
  return { text: nl === -1 ? cut : cut.slice(nl + 1), truncated: true };
}

/** Strip ANSI colour and carriage-return overwrites that render as noise. */
export function cleanLog(text) {
  return String(text ?? "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n");
}

/**
 * GitHub Actions job log. The endpoint answers a redirect to signed storage;
 * fetch follows it, and the body is plain text rather than JSON.
 *
 * @param {{apiBase:string, project:string}} forge
 * @param {string|null} token
 * @param {string|number} jobId
 * @param {{fetchImpl?:Function}} [opts]
 */
export async function githubJobLog(forge, token, jobId, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  if (!jobId) return { ok: false, reason: "no job id" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(
      `${forge.apiBase}/repos/${forge.project}/actions/jobs/${jobId}/logs`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: ctrl.signal,
      },
    );
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const raw = cleanLog(await res.text());
    const cut = tail(raw);
    return {
      ok: true,
      provider: "github",
      jobId: String(jobId),
      text: cut.text,
      truncated: cut.truncated,
      totalChars: raw.length,
    };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GitLab job trace. Same bound, same contract.
 *
 * @param {{apiBase:string, project:string}} forge
 * @param {string|null} token
 * @param {string|number} jobId
 * @param {{fetchImpl?:Function}} [opts]
 */
export async function gitlabJobLog(forge, token, jobId, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  if (!jobId) return { ok: false, reason: "no job id" };
  if (!token) return { ok: false, reason: "a GitLab token is required" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(
      `${forge.apiBase}/projects/${encodeURIComponent(forge.project)}/jobs/${jobId}/trace`,
      { headers: { "PRIVATE-TOKEN": token }, signal: ctrl.signal },
    );
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const raw = cleanLog(await res.text());
    const cut = tail(raw);
    return {
      ok: true,
      provider: "gitlab",
      jobId: String(jobId),
      text: cut.text,
      truncated: cut.truncated,
      totalChars: raw.length,
    };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}
