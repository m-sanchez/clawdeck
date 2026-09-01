// @ts-check
/**
 * GitLab review threads, read-only.
 *
 * GitLab's `/discussions` is the better fit: one discussion IS a thread and it
 * carries `resolvable` / `resolved` directly, so resolution needs no second
 * call. A discussion whose notes are not resolvable is a conversation note, not
 * a review thread, and resolution there stays unknown rather than false.
 *
 * GitLab REST exposes no per-thread `outdated` flag, so that stays null and the
 * head-sha comparison is recorded separately as a heuristic.
 */
import { makeThread, makeNote, coverage } from "../core/review-inbox/model.mjs";

const TIMEOUT_MS = 8000;
const PER_PAGE = 100;
const MAX_PAGES = 5;

/** Pages are constructed locally; a `next` link from the response is ignored. */
async function getAll(fetchImpl, apiBase, path, token, signal) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${apiBase}${path}${sep}per_page=${PER_PAGE}&page=${page}`;
    const res = await fetchImpl(url, {
      headers: { "PRIVATE-TOKEN": token },
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const batch = await res.json();
    if (!Array.isArray(batch)) throw new Error("unexpected payload");
    items.push(...batch);
    if (batch.length < PER_PAGE) return { items, complete: true };
  }
  return { items, complete: false };
}

/**
 * Resolution for a discussion: true only when every resolvable note is
 * resolved. A discussion with nothing resolvable has no resolution state at
 * all, which is unknown - never false.
 */
function resolutionOf(notes) {
  const resolvable = notes.filter((n) => n?.resolvable === true);
  if (!resolvable.length) return { resolvable: false, resolved: null };
  return {
    resolvable: true,
    resolved: resolvable.every((n) => n.resolved === true),
  };
}

/**
 * @param {{provider:string, apiBase:string, webBase:string, project:string}} forge
 * @param {string|null} token
 * @param {{iid:number|string}} mr
 * @param {{fetchImpl?:Function, now?:number}} [opts]
 */
export async function gitlabReviewThreads(forge, token, mr, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const now = opts.now ?? Date.now();
  const observedAt = new Date(now).toISOString();
  const iid = mr?.iid;

  if (!token) {
    return {
      ok: false,
      reason: "no-token",
      provider: "gitlab",
      threads: [],
      notes: [],
      coverage: { threads: coverage(false, "a GitLab token is required") },
    };
  }
  if (iid == null) {
    return {
      ok: false,
      reason: "no-change",
      provider: "gitlab",
      threads: [],
      notes: [],
      coverage: { threads: coverage(false, "no merge request") },
    };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const project = encodeURIComponent(forge.project);
  try {
    const { items, complete } = await getAll(
      fetchImpl,
      forge.apiBase,
      `/projects/${project}/merge_requests/${iid}/discussions`,
      token,
      ctrl.signal,
    );

    const threads = [];
    const notes = [];
    let systemNoteCount = 0;
    // The newest anchor seen across the MR, used only for the stale heuristic.
    let latestHeadSha = null;
    for (const d of items) {
      const all = Array.isArray(d?.notes) ? d.notes : [];
      const human = all.filter((n) => n?.system !== true);
      if (!human.length) {
        systemNoteCount += all.length;
        continue;
      }
      const head = human[0];
      const sha = head?.position?.head_sha ?? null;
      if (sha && !latestHeadSha) latestHeadSha = sha;
    }

    for (const d of items) {
      const all = Array.isArray(d?.notes) ? d.notes : [];
      const human = all.filter((n) => n?.system !== true);
      if (!human.length) continue;

      const head = human[0];
      const { resolvable, resolved } = resolutionOf(human);
      const comments = human.map((n) => ({
        author: n.author?.username ?? null,
        createdAt: n.created_at ?? null,
        body: n.body ?? "",
      }));
      const base = {
        provider: "gitlab",
        repository: forge.project,
        changeId: String(iid),
        remoteThreadId: String(d.id),
        remoteUrl: `${forge.webBase}/${forge.project}/-/merge_requests/${iid}#note_${head.id}`,
        author: head.author?.username ?? null,
        createdAt: head.created_at ?? null,
        updatedAt: human[human.length - 1]?.updated_at ?? head.updated_at,
        observedAt,
        comments,
      };

      if (!resolvable) {
        notes.push(makeNote(base));
        continue;
      }

      const pos = head.position || {};
      const anchorSha = pos.head_sha ?? null;
      threads.push(
        makeThread({
          ...base,
          location:
            pos.new_path || pos.old_path
              ? {
                  file: pos.new_path ?? pos.old_path,
                  line: pos.new_line ?? pos.old_line ?? null,
                  side: pos.new_line != null ? "new" : "old",
                  anchorCommitSha: anchorSha,
                }
              : null,
          remote: {
            resolved,
            resolvable: true,
            // GitLab REST has no per-thread outdated flag.
            outdated: null,
            // Not every resolved note names the resolver; take the first that
            // does rather than the first that is merely resolved.
            resolvedBy:
              human.find((n) => n.resolved_by?.username)?.resolved_by
                ?.username ?? null,
            source: "rest",
          },
          anchorOutdatedInferred:
            anchorSha && latestHeadSha ? anchorSha !== latestHeadSha : null,
        }),
      );
    }

    return {
      ok: true,
      provider: "gitlab",
      changeId: String(iid),
      threads,
      notes,
      systemNoteCount,
      degraded: [],
      observedAt,
      coverage: {
        threads: coverage(complete, complete ? undefined : "pagination cap"),
        notes: coverage(complete),
        // Discussions carry resolution inline, so knowing the list is knowing
        // the resolutions.
        resolution: coverage(complete, complete ? undefined : "pagination cap"),
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: "fetch-failed",
      provider: "gitlab",
      error: String(error?.message || error),
      threads: [],
      notes: [],
      coverage: { threads: coverage(false, "fetch failed") },
    };
  } finally {
    clearTimeout(timer);
  }
}
