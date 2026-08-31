// @ts-check
/**
 * Instruction-budget observability. Reports the instruction files that are
 * ACTUALLY always-loaded for this checkout with honest, clearly-labelled size
 * ESTIMATES (character/byte counts and a rough char/4 token estimate — NOT a
 * tokenizer count). Load-on-demand material (rules, docs, skills) is listed as
 * available-but-not-auto-loaded so the panel never overclaims what sits in the
 * baseline context.
 *
 * The always-loaded / on-demand baseline is derived from the filesystem + the
 * documented load model (a size ESTIMATE). The `observed` section is REAL: it is
 * aggregated from InstructionsLoaded hook events (file path + memory type + load
 * reason); the event carries no content and no size, so it is not an estimate.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Rough token estimate from characters (~4 chars/token). Labelled an estimate. */
function estTokens(chars) {
  return Math.round(chars / 4);
}

function fileEntry(root, rel, reason) {
  const abs = join(root, rel);
  try {
    const text = readFileSync(abs, "utf8");
    return {
      path: rel,
      loaded: true,
      chars: text.length,
      bytes: Buffer.byteLength(text, "utf8"),
      estTokens: estTokens(text.length),
      reason,
    };
  } catch {
    return {
      path: rel,
      loaded: false,
      chars: 0,
      bytes: 0,
      estTokens: 0,
      reason,
    };
  }
}

function countDir(root, rel, pattern) {
  try {
    const dir = join(root, rel);
    if (!existsSync(dir)) return { path: rel, files: 0, bytes: 0 };
    let files = 0;
    let bytes = 0;
    for (const name of readdirSync(dir)) {
      if (pattern && !pattern.test(name)) continue;
      try {
        const st = statSync(join(dir, name));
        if (st.isFile()) {
          files++;
          bytes += st.size;
        }
      } catch {
        /* skip */
      }
    }
    return { path: rel, files, bytes };
  } catch {
    return { path: rel, files: 0, bytes: 0 };
  }
}

/**
 * Stable serialized key over the non-secret observed metadata, used to break an
 * exact-timestamp tie deterministically (mirrors the per-session projection's
 * metadata high-water tiebreak) so the rollup never depends on session order.
 */
function observedMetaKey(loadReason, memoryType) {
  return JSON.stringify([loadReason ?? null, memoryType ?? null]);
}

/**
 * Aggregate the REAL InstructionsLoaded events the projection recorded per
 * session into a per-file rollup: how many loads, across how many sessions, the
 * last load ts, and the latest load reason + memory type. The event supplies no
 * content and no size, so there is no byte figure and this is observed evidence,
 * not an estimate. Newer load wins the metadata; an exact-timestamp tie is broken
 * by a stable serialized key so the same input multiset yields the same rollup
 * regardless of the order sessions are iterated.
 * @param {{ sessions?: any[] }} [events]
 */
function aggregateObserved(events) {
  const sessions = (events && events.sessions) || [];
  const byFile = new Map();
  for (const s of sessions) {
    const instr = (s && s.instructions) || {};
    for (const file of Object.keys(instr)) {
      const r = instr[file] || {};
      const cur = byFile.get(file) || {
        file,
        loads: 0,
        sessions: 0,
        lastAt: 0,
        loadReason: null,
        memoryType: null,
      };
      cur.loads += r.loads || 0;
      cur.sessions += 1;
      const at = r.lastAt || 0;
      const take =
        at > cur.lastAt ||
        (at === cur.lastAt &&
          observedMetaKey(r.loadReason ?? null, r.memoryType ?? null) <
            observedMetaKey(cur.loadReason, cur.memoryType));
      if (take) {
        cur.lastAt = at;
        cur.loadReason = r.loadReason ?? null;
        cur.memoryType = r.memoryType ?? null;
      }
      byFile.set(file, cur);
    }
  }
  const files = [...byFile.values()].sort(
    (a, b) =>
      b.lastAt - a.lastAt || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
  );
  return {
    files,
    fileCount: files.length,
    totalLoads: files.reduce((n, f) => n + f.loads, 0),
    source: "InstructionsLoaded hook events",
  };
}

/**
 * A `.claude/rules/*.md` file is PATH-SCOPED (conditional) when its YAML
 * frontmatter carries a `paths:` (or `globs:`) key; otherwise it is
 * UNCONDITIONAL and loads at session start (part of the baseline context).
 */
function hasPathScopeFrontmatter(text) {
  const m = /^\s*---\s*\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(text);
  if (!m) return false;
  return /^\s*(paths|globs)\s*:/m.test(m[1]);
}

/**
 * Classify every `.claude/rules/*.md` by its frontmatter into unconditional
 * (baseline) and path-scoped (conditional), with a labelled size estimate each.
 * @param {string} root
 */
function classifyRules(root) {
  const dir = join(root, ".claude", "rules");
  const unconditional = [];
  const pathScoped = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!/\.md$/.test(name)) continue;
      let text = "";
      try {
        text = readFileSync(join(dir, name), "utf8");
      } catch {
        continue;
      }
      const entry = {
        path: `.claude/rules/${name}`,
        loaded: true,
        chars: text.length,
        bytes: Buffer.byteLength(text, "utf8"),
        estTokens: estTokens(text.length),
      };
      if (hasPathScopeFrontmatter(text)) pathScoped.push(entry);
      else unconditional.push(entry);
    }
  } catch {
    /* no rules dir */
  }
  return { unconditional, pathScoped };
}

/**
 * @param {{ checkoutRoot: string }} ctx
 * @param {{ sessions?: any[] }} [events] event projection for the observed rollup
 * @returns {{ alwaysLoaded: any[], onDemand: any[], totalChars: number,
 *   totalEstTokens: number, estimated: true, observed: any, note: string }}
 */
export function getInstructionBudget(ctx, events) {
  const root = ctx.checkoutRoot;
  // Baseline (loaded at session start): the root CLAUDE.md PLUS every
  // .claude/rules/*.md WITHOUT `paths` frontmatter (unconditional). Path-scoped
  // rules (with `paths` frontmatter), AGENTS.md, docs, and skills are on-demand.
  const claudeMd = fileEntry(
    root,
    "CLAUDE.md",
    "Claude Code project instructions (loaded at session start)",
  );
  const { unconditional, pathScoped } = classifyRules(root);
  const alwaysLoaded = [
    ...(claudeMd.loaded ? [claudeMd] : []),
    ...unconditional.map((e) => ({
      ...e,
      reason:
        "unconditional rule (no paths frontmatter, loaded at session start)",
    })),
  ];

  // Load-on-demand material: present but NOT in the baseline context.
  const agentsMd = fileEntry(root, "AGENTS.md", "");
  const onDemand = [
    {
      path: "AGENTS.md",
      files: agentsMd.loaded ? 1 : 0,
      bytes: agentsMd.bytes,
      reason:
        "shared project manual; Claude Code loads CLAUDE.md, not AGENTS.md, unless it is imported",
    },
    {
      path: ".claude/rules (path-scoped)",
      files: pathScoped.length,
      bytes: pathScoped.reduce((n, e) => n + e.bytes, 0),
      reason:
        "path-scoped rules (paths frontmatter); loaded only when a matching file is touched",
    },
    {
      ...countDir(root, "docs/claude-code", /\.md$/),
      reason: "feature docs, loaded on demand",
    },
    {
      ...countDir(root, ".claude/skills", /.*/),
      reason: "skills, invoked explicitly",
    },
  ];

  const totalChars = alwaysLoaded.reduce((n, e) => n + (e.chars || 0), 0);
  return {
    alwaysLoaded,
    onDemand,
    totalChars,
    totalEstTokens: estTokens(totalChars),
    estimated: true,
    observed: aggregateObserved(events),
    note: "Character/byte-based estimate, not a tokenizer count. Baseline = the root CLAUDE.md plus the unconditional .claude/rules/*.md (no `paths` frontmatter, loaded at session start); path-scoped rules (with `paths` frontmatter), AGENTS.md, docs, and skills are on-demand, not baseline. Claude Code loads CLAUDE.md, not AGENTS.md, unless AGENTS.md is imported. The observed section is real InstructionsLoaded runtime evidence (path + memory type + load reason); instruction content is never stored.",
  };
}
