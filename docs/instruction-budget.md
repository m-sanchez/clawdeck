# Instruction budget

What Claude Code actually loads into context for an observed project. The goal
is visibility: know what is _always_ loaded (a per-turn cost), what is
conditional, and where the cost concentrates. Clawdeck's Health view renders
this split live for the observed checkout.

## What is always loaded

Claude Code loads at session start: the root `CLAUDE.md`, plus every
`.claude/rules/*.md` that has NO `paths:` frontmatter (unconditional). A rule WITH
a `paths:` frontmatter is path-scoped and loads only when a file matching its
globs is touched. `AGENTS.md` is not auto-loaded: Claude Code reads `CLAUDE.md`,
not `AGENTS.md`, unless `AGENTS.md` is explicitly imported.

| Source                                | Loaded                                               |
| ------------------------------------- | ---------------------------------------------------- |
| `CLAUDE.md` (root)                    | Baseline (session start)                             |
| `.claude/rules/*.md` without `paths:` | Baseline (session start, unconditional)              |
| `.claude/rules/*.md` with `paths:`    | Conditional (loaded when a matching file is touched) |
| nested `CLAUDE.md` files              | Only when working under that directory               |
| `AGENTS.md`                           | On demand (Claude reads CLAUDE.md, not AGENTS.md)    |
| skills / slash commands               | On demand / invoked explicitly                       |

So the per-turn baseline is the root `CLAUDE.md` plus the unconditional rules;
path-scoped rules and a large `AGENTS.md` are NOT loaded every turn. The
instruction-budget adapter computes this split live from each rule's
frontmatter, so it stays accurate as the observed project's rules change.
`env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` can pull additional
`CLAUDE.md` files from other working directories.

## How rules load

A `.claude/rules/*.md` WITHOUT `paths:` frontmatter is unconditional: it loads at
session start and is part of the baseline. A rule WITH a `paths:` frontmatter
(glob patterns) is path-scoped: Claude Code loads it when a file matching those
globs is touched (`InstructionsLoaded` with `load_reason: path_glob_match`).

## Keeping the baseline lean

A useful guiding rule for any project: keep every load-bearing routing or
safety rule in the baseline, and move catalogs, long procedures, and reference
material to on-demand documents or skills. Never trade a correctness rule for
a smaller number.

## How it is measured live

Claude Code emits an `InstructionsLoaded` hook event. With the Clawdeck hooks
installed, the panel subscribes to it and shows the real loaded set per
session, with clearly-labelled character/token estimates (no tokenizer claim),
next to the static baseline computed from the files.
