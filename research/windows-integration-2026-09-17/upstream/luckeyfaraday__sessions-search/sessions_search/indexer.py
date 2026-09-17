"""Incremental indexing: walk every adapter and upsert changed sessions only.

A session's ``fingerprint`` (file mtime+size, or opencode's ``time_updated``) is
stored alongside it; on the next run we skip any session whose fingerprint is
unchanged, so re-indexing after the initial build only touches new/edited
sessions and stays near-instant.
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from typing import Callable, Iterable

from . import db
from .adapters import build_adapters
from .adapters.base import Adapter
from .models import Session

ProgressFn = Callable[[str, int], None]


@dataclass
class IndexStats:
    added: int = 0
    updated: int = 0
    skipped: int = 0
    removed: int = 0

    @property
    def changed(self) -> int:
        return self.added + self.updated


def _upsert(conn: sqlite3.Connection, session: Session) -> None:
    meta = session.meta
    row = conn.execute(
        "SELECT id FROM sessions WHERE agent = ? AND source_id = ?",
        (meta.agent, meta.source_id),
    ).fetchone()
    values = (
        meta.source_path,
        meta.project,
        meta.title,
        meta.started_at,
        meta.ended_at,
        len(session.messages),
        meta.fingerprint,
    )
    if row:
        sid = row["id"]
        conn.execute("DELETE FROM messages WHERE session_id = ?", (sid,))
        conn.execute(
            "UPDATE sessions SET source_path=?, project=?, title=?, started_at=?, "
            "ended_at=?, msg_count=?, fingerprint=? WHERE id=?",
            (*values, sid),
        )
    else:
        cur = conn.execute(
            "INSERT INTO sessions(agent, source_id, source_path, project, title, "
            "started_at, ended_at, msg_count, fingerprint) VALUES (?,?,?,?,?,?,?,?,?)",
            (meta.agent, meta.source_id, *values),
        )
        sid = cur.lastrowid
    conn.executemany(
        "INSERT INTO messages(session_id, seq, role, ts, text) VALUES (?,?,?,?,?)",
        [(sid, m.seq, m.role, m.ts, m.text) for m in session.messages],
    )


def reindex_agent(
    conn: sqlite3.Connection,
    adapter: Adapter,
    *,
    full: bool = False,
    progress: ProgressFn | None = None,
) -> IndexStats:
    agent = adapter.agent
    existing = {
        r["source_id"]: r["fingerprint"]
        for r in conn.execute(
            "SELECT source_id, fingerprint FROM sessions WHERE agent = ?", (agent,)
        )
    }
    seen: set[str] = set()
    stats = IndexStats()
    processed = 0
    for key in adapter.iter_keys():
        seen.add(key.source_id)
        prev_fp = existing.get(key.source_id)
        if prev_fp is not None and not full and prev_fp == key.fingerprint:
            stats.skipped += 1  # unchanged — skipped without parsing
        else:
            session = adapter.load_one(key.source_path, key.source_id)
            if session is None or not session.messages:
                # No searchable conversation text; nothing to index.
                stats.skipped += 1
            else:
                _upsert(conn, session)
                if prev_fp is not None:
                    stats.updated += 1
                else:
                    stats.added += 1
        processed += 1
        if progress is not None:
            progress(agent, processed)
    # Prune sessions whose source has disappeared.
    for stale_id in set(existing) - seen:
        conn.execute(
            "DELETE FROM sessions WHERE agent = ? AND source_id = ?", (agent, stale_id)
        )
        stats.removed += 1
    conn.commit()
    return stats


def reindex(
    conn: sqlite3.Connection,
    adapters: Iterable[Adapter] | None = None,
    *,
    full: bool = False,
    progress: ProgressFn | None = None,
) -> dict[str, IndexStats]:
    """Reindex every adapter; returns per-agent stats."""
    adapters = list(adapters) if adapters is not None else build_adapters()
    results: dict[str, IndexStats] = {}
    for adapter in adapters:
        results[adapter.agent] = reindex_agent(conn, adapter, full=full, progress=progress)
    if any(r.changed or r.removed for r in results.values()):
        # Merge FTS segments so delete+reinsert churn doesn't bloat the index.
        conn.execute("INSERT INTO messages_fts(messages_fts) VALUES ('optimize')")
    db.set_meta(conn, "last_indexed", str(int(time.time())))
    conn.commit()
    if full:
        # A full rebuild rewrites every row; reclaim the freed pages to the OS.
        conn.execute("VACUUM")
    return results
