-- Send looks up the threads it published by send_id.
CREATE INDEX idx_comments_send ON comments (send_id);
