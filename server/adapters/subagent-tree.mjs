// @ts-check
/**
 * The subagent hierarchy of one session: who spawned whom, what each was asked
 * to do, and what it actually reported back.
 *
 * Everything here comes from records Claude Code already wrote - a sidecar
 * `agent-<id>.meta.json` next to a full `agent-<id>.jsonl` transcript. Edges are
 * only emitted where a record proves them: a depth-1 agent was spawned by the
 * session, and a deeper one is linked to its parent only when exactly one
 * transcript contains the Task call that created it. An unprovable parent is
 * reported as unknown rather than guessed into the tree.
 *
 * The agent's closing message is carried verbatim and labelled as the agent's
 * own words. Nothing here summarizes it: a generated summary would be a
 * different kind of claim, and the panel does not make that one.
 *
 * IO is bounded. These transcripts run to hundreds of kilobytes each, so the
 * first line and a tail slice are read, never the whole file.
 */
import {
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const MAX_AGENTS = 60;
const META_MAX_BYTES = 4096;
const TAIL_BYTES = 96 * 1024;
const RESULT_CAP = 4000;

/** Last `bytes` of a file as text, with a partial first line dropped. */
function tailText(path, bytes) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return { text: "", size: 0 };
  }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString("utf8");
    return {
      text: len < size ? text.slice(text.indexOf("\n") + 1) : text,
      size,
    };
  } finally {
    closeSync(fd);
  }
}

/** First line of a file, for the opening timestamp. */
function headLine(path, bytes = 8192) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const len = Math.min(bytes, fstatSync(fd).size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 0);
    const text = buf.toString("utf8");
    const nl = text.indexOf("\n");
    return nl === -1 ? text : text.slice(0, nl);
  } finally {
    closeSync(fd);
  }
}

function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Text blocks of an assistant message, joined. */
function assistantText(record) {
  const blocks = record?.message?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function usageOf(record) {
  const u = record?.message?.usage;
  if (!u) return null;
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheCreate: u.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Read one agent's sidecar pair into a node. Only what the records say: an
 * agent still running has no end time, and that is reported as such.
 */
function readAgent(dir, metaFile, now) {
  const id = basename(metaFile, ".meta.json");
  let meta = {};
  try {
    const raw = readFileSync(join(dir, metaFile), "utf8").slice(
      0,
      META_MAX_BYTES,
    );
    meta = JSON.parse(raw) || {};
  } catch {
    return null;
  }

  const transcript = join(dir, `${id}.jsonl`);
  let size = 0;
  let startedAt = null;
  let endedAt = null;
  let result = null;
  let usage = null;
  let model = null;
  let closed = false;
  try {
    size = statSync(transcript).size;
    const first = parse(headLine(transcript));
    startedAt = first?.timestamp ?? null;

    const { text } = tailText(transcript, TAIL_BYTES);
    const lines = text.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const rec = parse(lines[i]);
      if (!rec) continue;
      if (!endedAt && rec.timestamp) endedAt = rec.timestamp;
      if (rec.type === "assistant") {
        model = model ?? rec.message?.model ?? null;
        if (!usage) usage = usageOf(rec);
        const body = assistantText(rec);
        // The closing report is the last end_turn message; anything earlier is
        // mid-work narration and would misrepresent the agent's conclusion.
        if (!result && rec.message?.stop_reason === "end_turn" && body) {
          result =
            body.length > RESULT_CAP ? `${body.slice(0, RESULT_CAP)}…` : body;
          closed = true;
        }
      }
      if (result && usage && startedAt) break;
    }
  } catch {
    /* transcript unreadable: the meta still describes the agent */
  }

  const durMs =
    startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : null;
  return {
    id,
    agentType: meta.agentType ?? null,
    description: meta.description ?? null,
    toolUseId: meta.toolUseId ?? null,
    spawnDepth: Number.isFinite(meta.spawnDepth) ? meta.spawnDepth : null,
    startedAt,
    endedAt,
    durMs: Number.isFinite(durMs) ? durMs : null,
    model,
    usage,
    transcriptBytes: size,
    // `closed` distinguishes "the agent finished and said this" from "this is
    // simply the newest thing it said".
    result: result
      ? { text: result, source: "actual agent message", closed }
      : null,
    parentId: null,
    parentKnown: false,
  };
}

/**
 * Link each agent to its parent, but only on evidence. Depth 1 is the session
 * itself. Deeper agents are matched by finding the single transcript that
 * contains the Task call which created them; zero or several matches leave the
 * parent unknown.
 */
function linkParents(agents, dir) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const needsParent = agents.filter((a) => a.spawnDepth !== 1 && a.toolUseId);

  for (const child of needsParent) {
    const holders = [];
    for (const candidate of agents) {
      if (candidate.id === child.id) continue;
      const { text } = tailText(join(dir, `${candidate.id}.jsonl`), TAIL_BYTES);
      if (text.includes(child.toolUseId)) holders.push(candidate.id);
      if (holders.length > 1) break;
    }
    if (holders.length === 1) {
      child.parentId = holders[0];
      child.parentKnown = true;
    }
  }
  for (const a of agents) {
    if (a.spawnDepth === 1) {
      a.parentId = null;
      a.parentKnown = true; // the session spawned it
    }
  }
  return byId;
}

/**
 * @param {string} transcriptPath the SESSION transcript; its sidecar dir is
 *   `<dir>/<sessionId>/subagents`
 * @param {{now?: number, maxAgents?: number}} [opts]
 */
export function getSubagentTree(transcriptPath, opts = {}) {
  const now = opts.now ?? Date.now();
  const maxAgents = opts.maxAgents ?? MAX_AGENTS;
  const sessionId = basename(transcriptPath, ".jsonl");
  const dir = join(dirname(transcriptPath), sessionId, "subagents");

  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".meta.json"));
  } catch {
    return {
      session: sessionId,
      missing: true,
      agents: [],
      edges: [],
      truncated: false,
      computedAt: new Date(now).toISOString(),
    };
  }

  const truncated = files.length > maxAgents;
  const agents = files
    .slice(0, maxAgents)
    .map((f) => readAgent(dir, f, now))
    .filter(Boolean)
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));

  linkParents(agents, dir);

  // One edge type today, because it is the only one the records prove. Others
  // (reported-to, produced-commit) need evidence this data does not carry.
  const edges = agents
    .filter((a) => a.parentKnown)
    .map((a) => ({ from: a.parentId ?? "session", to: a.id, kind: "spawned" }));

  const totals = agents.reduce(
    (acc, a) => ({
      input: acc.input + (a.usage?.input ?? 0),
      output: acc.output + (a.usage?.output ?? 0),
      cacheRead: acc.cacheRead + (a.usage?.cacheRead ?? 0),
    }),
    { input: 0, output: 0, cacheRead: 0 },
  );

  return {
    session: sessionId,
    agents,
    edges,
    truncated,
    maxDepth: agents.reduce((m, a) => Math.max(m, a.spawnDepth ?? 0), 0),
    unknownParents: agents.filter((a) => !a.parentKnown).length,
    totals,
    computedAt: new Date(now).toISOString(),
  };
}
