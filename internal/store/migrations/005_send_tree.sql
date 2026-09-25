-- The working tree a send approved, as a git tree hash, so feedback can
-- tell when the code changed after it. '' for sends from before.
ALTER TABLE sends ADD COLUMN tree TEXT NOT NULL DEFAULT '';
