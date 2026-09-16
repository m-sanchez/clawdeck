import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const root = resolve(process.argv[2] || "../.ocelin-smoke");
const dataDir = join(root, "data"),
  codex = join(root, "codex"),
  claude = join(root, "claude");
const projects = [
  join(root, "Ocelin sample project"),
  join(root, "Proyecto español"),
];
for (const dir of [dataDir, codex, claude, ...projects])
  await mkdir(dir, { recursive: true });
const stamp = new Date().toISOString();
await writeFile(
  join(codex, "rollout.jsonl"),
  [
    {
      type: "session_meta",
      timestamp: stamp,
      payload: { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", cwd: projects[0] },
    },
    {
      type: "event_msg",
      timestamp: stamp,
      payload: { type: "task_started", turn_id: "turn-1" },
    },
  ]
    .map(JSON.stringify)
    .join("\n") + "\n",
);
for (const [id, cwd, stop] of [
  ["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", projects[0], false],
  ["cccccccc-cccc-cccc-cccc-cccccccccccc", projects[1], true],
]) {
  const rows = [
    {
      type: "user",
      sessionId: id,
      cwd,
      timestamp: stamp,
      message: { content: "Sample task" },
    },
  ];
  if (stop)
    rows.push({
      type: "assistant",
      sessionId: id,
      cwd,
      timestamp: stamp,
      message: { content: [], stop_reason: "end_turn" },
    });
  await writeFile(
    join(claude, `${id}.jsonl`),
    rows.map(JSON.stringify).join("\n") + "\n",
  );
}
await writeFile(
  join(dataDir, "preferences.json"),
  JSON.stringify({
    sources: [
      { provider: "codex", root: codex },
      { provider: "claude", root: claude },
    ],
    tray: true,
    dashboard: true,
    bar: true,
    quiet: true,
    motion: "none",
    theme: "dark",
  }),
);
console.log(dataDir);
