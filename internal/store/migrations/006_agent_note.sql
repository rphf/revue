-- The agent's note to the reviewer: one per branch ('' on a detached
-- HEAD), replaced as a whole on each write.
CREATE TABLE notes (
    branch     TEXT PRIMARY KEY,
    body       TEXT NOT NULL,
    tree       TEXT NOT NULL DEFAULT '', -- the working tree it describes, '' when unknown
    updated_at TEXT NOT NULL
);
