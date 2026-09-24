-- Where a thread was written, so it can be scoped to its branch and
-- archived once its code lands. Threads from before this migration keep
-- the empty defaults: no origin.
ALTER TABLE threads ADD COLUMN branch TEXT NOT NULL DEFAULT ''; -- '' on a detached HEAD
ALTER TABLE threads ADD COLUMN head TEXT NOT NULL DEFAULT '';   -- HEAD when the thread was written
ALTER TABLE threads ADD COLUMN base TEXT NOT NULL DEFAULT '';   -- merge base of HEAD and the default branch then
ALTER TABLE threads ADD COLUMN args TEXT NOT NULL DEFAULT '[]'; -- git-diff arguments, JSON
ALTER TABLE threads ADD COLUMN archived_at TEXT;                -- NULL while visible
ALTER TABLE threads ADD COLUMN archived_head TEXT NOT NULL DEFAULT ''; -- HEAD when archived
ALTER TABLE threads ADD COLUMN kept INTEGER NOT NULL DEFAULT 0;       -- unarchived by hand: never lands again

CREATE INDEX idx_threads_archived ON threads (archived_at);
CREATE INDEX idx_threads_history ON threads (branch, archived_head);

-- Per-repository settings, JSON values.
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
