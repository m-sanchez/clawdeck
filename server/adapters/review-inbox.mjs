// @ts-check
/**
 * The Review Inbox as the panel sees it: provider threads, the git facts around
 * their anchors, the human's local marks, and one derived state per thread with
 * the evidence behind it.
 *
 * Two shapes come out. `items` is the full view behind the token-gated route.
 * `summary` is the small counts object that rides in the snapshot - no bodies,
 * because the SSE stream carrying the snapshot is the one route without a
 * bearer, and because hashing large churning text every tick is waste.
 */
import { getReviewThreads } from "../forge/index.mjs";
import { git } from "../lib/git.mjs";
import { collectGitFacts } from "../core/review-inbox/git-facts.mjs";
import {
  deriveThreadDisplayState,
  summarizeStates,
} from "../core/review-inbox/derive.mjs";
import {
  draftIndex,
  readInboxStore,
  reconcileThreads,
  writeInboxStore,
} from "../core/review-inbox/store.mjs";
import { freshness } from "../core/review-inbox/model.mjs";

/** Data older than this is shown, but can never mint readiness. */
export const STALE_AFTER_MS = 6 * 60 * 1000;
const TOP_N = 5;

/** Files with uncommitted edits, so a change nobody committed still counts. */
async function dirtyFiles(cwd) {
  const [tracked, untracked] = await Promise.all([
    git(["diff", "--name-only", "HEAD"], cwd),
    git(["ls-files", "--others", "--exclude-standard"], cwd),
  ]);
  return new Set(
    `${tracked}\n${untracked}`
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

/**
 * Fetch, correlate and derive. Never throws: every failure becomes a reported
 * reason with `available:false`, because an inbox that silently shows nothing
 * reads exactly like an inbox with nothing in it.
 *
 * @param {{checkoutRoot:string, runtimeDir:string}} ctx
 * @param {{mr:{iid:number|string, state?:string}|null, enabled?:boolean}} input
 * @param {{now?:number, fetchImpl?:Function, gitResult?:Function}} [opts]
 */
export async function getReviewInbox(ctx, input, opts = {}) {
  const now = opts.now ?? Date.now();
  const mr = input?.mr ?? null;

  if (input?.enabled === false)
    return empty("disabled", null, now, "the review inbox is turned off");
  if (!mr?.iid)
    return empty("no-change", null, now, "no open change for this branch");

  const fetched = await getReviewThreads(ctx.checkoutRoot, mr, {
    fetchImpl: opts.fetchImpl,
    now,
  });
  if (!fetched.ok)
    return empty(
      fetched.reason || "fetch-failed",
      fetched.provider ?? null,
      now,
      fetched.error || reasonText(fetched.reason),
    );

  const threads = fetched.threads || [];
  const notes = fetched.notes || [];

  // Local marks first: they are what the human decided, and they survive
  // whatever the provider or git says next.
  let store = readInboxStore(ctx.runtimeDir);
  const reconciled = reconcileThreads(store, threads, now);
  store = reconciled.store;
  if (reconciled.changed) writeInboxStore(ctx.runtimeDir, store);
  const drafts = draftIndex(ctx.runtimeDir);

  const facts = await collectGitFacts(ctx.checkoutRoot, threads, {
    gitResult: opts.gitResult,
    dirtyFiles: await dirtyFiles(ctx.checkoutRoot),
  });

  const items = threads.map((thread) => {
    const local = {
      ...(store.threads[thread.id] || {}),
      draft: drafts.get(thread.id) || null,
    };
    const derived = deriveThreadDisplayState(
      thread,
      local,
      facts.get(thread.id) || null,
      { now, changeState: mr.state },
    );
    return {
      thread,
      derived,
      facts: facts.get(thread.id) || null,
      local: {
        mark: local.mark || "none",
        markAt: local.markAt || null,
        lastReadAt: local.lastReadAt ?? null,
        draftChars: local.draft?.chars ?? 0,
        assists: local.assists || [],
      },
    };
  });

  const counts = summarizeStates(items);
  const observedAt = fetched.observedAt || new Date(now).toISOString();
  return {
    available: true,
    reason: null,
    provider: fetched.provider,
    changeId: fetched.changeId ?? String(mr.iid),
    mrIid: mr.iid,
    reviewDecision: fetched.reviewDecision ?? null,
    observedAt,
    freshness: freshness(observedAt, now, STALE_AFTER_MS),
    coverage: fetched.coverage || {},
    capabilities: fetched.capabilities ?? null,
    degraded: fetched.degraded || [],
    noteCount: notes.length,
    items,
    notes,
    counts,
  };
}

/** The <1 KB projection that rides in the snapshot. No bodies, ever. */
export function summarizeInbox(inbox) {
  if (!inbox || inbox.available !== true) {
    return {
      configured: Boolean(inbox?.provider),
      available: false,
      provider: inbox?.provider ?? null,
      reason: inbox?.reason ?? "unavailable",
      detail: inbox?.detail ?? null,
      fetchedAt: inbox?.observedAt ?? null,
      freshness: "unknown",
      coverage: {
        threads: { complete: false },
        resolution: { complete: false },
      },
      counts: null,
      top: [],
    };
  }
  return {
    configured: true,
    available: true,
    provider: inbox.provider,
    mrIid: inbox.mrIid ?? null,
    reviewDecision: inbox.reviewDecision ?? null,
    fetchedAt: inbox.observedAt,
    freshness: inbox.freshness,
    coverage: {
      threads: inbox.coverage?.threads ?? { complete: false },
      resolution: inbox.coverage?.resolution ?? { complete: false },
    },
    degraded: inbox.degraded ?? [],
    capabilities: inbox.capabilities ?? null,
    noteCount: inbox.noteCount ?? 0,
    counts: inbox.counts,
    // Enough to point at a thread, never enough to leak what it says.
    top: inbox.items.slice(0, TOP_N).map((it) => ({
      id: it.thread.id,
      file: it.thread.location?.file ?? null,
      line: it.thread.location?.line ?? null,
      state: it.derived.state,
      authority: it.derived.authority,
      certainty: it.derived.certainty,
    })),
  };
}

function reasonText(reason) {
  switch (reason) {
    case "no-remote":
      return "no git forge detected for this checkout";
    case "unsupported":
      return "review threads are not supported for this provider yet";
    case "no-token":
      return "a provider token is required to read review threads";
    case "no-change":
      return "no open change for this branch";
    default:
      return "review threads could not be read";
  }
}

function empty(reason, provider, now, detail) {
  return {
    available: false,
    reason,
    detail: detail ?? reasonText(reason),
    provider,
    items: [],
    notes: [],
    noteCount: 0,
    counts: null,
    observedAt: new Date(now).toISOString(),
    freshness: "unknown",
    coverage: {
      threads: { complete: false, reason: reason },
      resolution: { complete: false, reason: reason },
    },
    degraded: [],
  };
}
