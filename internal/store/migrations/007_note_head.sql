-- The commit a note was written on: once HEAD moves past it, the round
-- it describes is done. Notes from before get '', which matches no
-- commit once there is one: their round is over.
ALTER TABLE notes ADD COLUMN head TEXT NOT NULL DEFAULT '';
