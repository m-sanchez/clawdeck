"""SQLite + FTS5 index: schema, connection helpers, and small meta accessors.

The text lives in an FTS5 *external-content* table mirrored from ``messages`` via
triggers, so we get BM25 ranking and ``snippet()`` highlighting essentially for
free while still keeping structured columns (agent, role, ts) on ``messages``.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from . import config

SCHEMA_VERSION = 1

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY,
    agent       TEXT NOT NULL,
    source_id   TEXT NOT NULL,
    source_path TEXT NOT NULL,
    project     TEXT,
    title       TEXT,
    started_at  INTEGER,
    ended_at    INTEGER,
    msg_count   INTEGER NOT NULL DEFAULT 0,
    fingerprint TEXT NOT NULL,
    UNIQUE (agent, source_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL DEFAULT 0,
    role       TEXT,
    ts         INTEGER,
    text       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    text,
    content='messages',
    content_rowid='id',
    tokenize='porter unicode61'
);

-- Keep the FTS index in sync with the messages table.
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""


def _readonly_uri(path: Path) -> str:
    return f"{path.expanduser().resolve().as_uri()}?mode=ro"


def connect(db_path: Path | None = None, *, read_only: bool = False) -> sqlite3.Connection:
    """Open (and, on first use, initialize) the index database."""
    path = db_path or config.INDEX_DB
    if read_only:
        conn = sqlite3.connect(_readonly_uri(path), uri=True)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(path)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    if not read_only:
        init_schema(conn)
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(_SCHEMA)
    set_meta(conn, "schema_version", str(SCHEMA_VERSION))
    conn.commit()


def get_meta(conn: sqlite3.Connection, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
