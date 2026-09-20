-- The 0.x review model (reviews, rounds, per-round anchors, submissions
-- with verdicts) is replaced by threads on a live diff; its data is
-- dropped, see docs/plans/2026-09-20-002-feat-live-diff-plan.md.
-- Children before parents: foreign keys are enforced while the old
-- rows go.
DROP TABLE IF EXISTS thread_anchors;
DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS submissions;
DROP TABLE IF EXISTS threads;
DROP TABLE IF EXISTS round_files;
DROP TABLE IF EXISTS rounds;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS reviews;
DROP TABLE IF EXISTS blobs;

-- Content-addressed file contents; a thread's snapshot points here and
-- files repeat across threads.
CREATE TABLE blobs (
    hash    TEXT PRIMARY KEY, -- sha256 hex
    content BLOB NOT NULL
);

-- A thread is anchored where the comment was written: the path and
-- side, the line (or range), the hash and start of the hunk it sat in
-- (empty hash when it sat outside any hunk), and the file's old and new
-- contents at that moment. Its position in any later diff is computed
-- from these, never stored.
CREATE TABLE threads (
    id         INTEGER PRIMARY KEY,
    path       TEXT NOT NULL,
    old_path   TEXT NOT NULL DEFAULT '', -- set when status = 'renamed'
    status     TEXT NOT NULL CHECK (status IN ('added', 'modified', 'deleted', 'renamed')),
    side       TEXT NOT NULL CHECK (side IN ('additions', 'deletions')),
    start_line INTEGER, -- NULL unless the comment spans a range
    line       INTEGER NOT NULL,
    hunk_hash  TEXT NOT NULL DEFAULT '',
    hunk_start INTEGER NOT NULL DEFAULT 0,
    old_blob   TEXT REFERENCES blobs (hash),
    new_blob   TEXT REFERENCES blobs (hash),
    resolved   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

-- One Send publishes every reviewer draft at once, with a note.
CREATE TABLE sends (
    id         INTEGER PRIMARY KEY,
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE comments (
    id          INTEGER PRIMARY KEY,
    thread_id   INTEGER NOT NULL REFERENCES threads (id),
    author_role TEXT NOT NULL CHECK (author_role IN ('reviewer', 'agent')),
    body        TEXT NOT NULL,
    draft       INTEGER NOT NULL DEFAULT 0,
    send_id     INTEGER REFERENCES sends (id),
    created_at  TEXT NOT NULL
);

-- Monotonic event log: the cursor primitive. AUTOINCREMENT guarantees
-- ids never reuse, so "since" cursors stay valid forever.
CREATE TABLE events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,
    payload    TEXT NOT NULL, -- JSON
    created_at TEXT NOT NULL
);

CREATE INDEX idx_comments_thread ON comments (thread_id);
CREATE INDEX idx_comments_draft ON comments (draft);
