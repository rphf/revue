-- Reviews follow the KTD8 state machine: open -> approved | closed,
-- both reopenable to open. Rounds exist only under open.
CREATE TABLE reviews (
    id          INTEGER PRIMARY KEY,
    repo_root   TEXT NOT NULL,
    branch      TEXT NOT NULL DEFAULT '',
    source_args TEXT NOT NULL, -- JSON array of git-diff args
    state       TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'approved', 'closed')),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- Each round freezes the diff it was reviewed against (KTD4/KTD12).
CREATE TABLE rounds (
    id         INTEGER PRIMARY KEY,
    review_id  INTEGER NOT NULL REFERENCES reviews (id),
    seq        INTEGER NOT NULL,
    patch      TEXT NOT NULL, -- raw git patch text, verbatim
    created_at TEXT NOT NULL,
    UNIQUE (review_id, seq)
);

-- Content-addressed blob store; files repeat across rounds (KTD4).
CREATE TABLE blobs (
    hash    TEXT PRIMARY KEY, -- sha256 hex
    content BLOB NOT NULL
);

CREATE TABLE round_files (
    id        INTEGER PRIMARY KEY,
    round_id  INTEGER NOT NULL REFERENCES rounds (id),
    path      TEXT NOT NULL,
    old_path  TEXT NOT NULL DEFAULT '', -- set when status = 'renamed'
    status    TEXT NOT NULL CHECK (status IN ('added', 'modified', 'deleted', 'renamed')),
    old_blob  TEXT REFERENCES blobs (hash),
    new_blob  TEXT REFERENCES blobs (hash),
    is_binary INTEGER NOT NULL DEFAULT 0,
    UNIQUE (round_id, path)
);

CREATE TABLE threads (
    id              INTEGER PRIMARY KEY,
    review_id       INTEGER NOT NULL REFERENCES reviews (id),
    origin_round_id INTEGER NOT NULL REFERENCES rounds (id),
    resolved        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL
);

-- One anchor per (thread, round): where the thread sits in that round's
-- diff and whether it is still live there (KTD2/KTD3).
CREATE TABLE thread_anchors (
    id         INTEGER PRIMARY KEY,
    thread_id  INTEGER NOT NULL REFERENCES threads (id),
    round_id   INTEGER NOT NULL REFERENCES rounds (id),
    path       TEXT NOT NULL,
    side       TEXT NOT NULL CHECK (side IN ('additions', 'deletions')),
    start_line INTEGER, -- NULL unless the comment spans a range
    line       INTEGER NOT NULL,
    state      TEXT NOT NULL CHECK (state IN ('live', 'outdated')),
    hunk_hash  TEXT NOT NULL DEFAULT '',
    UNIQUE (thread_id, round_id)
);

CREATE TABLE submissions (
    id         INTEGER PRIMARY KEY,
    review_id  INTEGER NOT NULL REFERENCES reviews (id),
    round_id   INTEGER NOT NULL REFERENCES rounds (id),
    verdict    TEXT NOT NULL CHECK (verdict IN ('comment', 'request_changes', 'approve')),
    summary    TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE comments (
    id            INTEGER PRIMARY KEY,
    thread_id     INTEGER NOT NULL REFERENCES threads (id),
    author_role   TEXT NOT NULL CHECK (author_role IN ('reviewer', 'agent')),
    body          TEXT NOT NULL,
    draft         INTEGER NOT NULL DEFAULT 0,
    submission_id INTEGER REFERENCES submissions (id),
    created_at    TEXT NOT NULL
);

-- Monotonic event log: the cursor primitive (KTD6). AUTOINCREMENT
-- guarantees ids never reuse, so "since" cursors stay valid forever.
CREATE TABLE events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id  INTEGER NOT NULL REFERENCES reviews (id),
    type       TEXT NOT NULL,
    payload    TEXT NOT NULL, -- JSON
    created_at TEXT NOT NULL
);

CREATE INDEX idx_rounds_review ON rounds (review_id);
CREATE INDEX idx_round_files_round ON round_files (round_id);
CREATE INDEX idx_threads_review ON threads (review_id);
CREATE INDEX idx_anchors_thread ON thread_anchors (thread_id);
CREATE INDEX idx_anchors_round ON thread_anchors (round_id);
CREATE INDEX idx_comments_thread ON comments (thread_id);
CREATE INDEX idx_events_review ON events (review_id, id);
