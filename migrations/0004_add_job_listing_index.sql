-- Additive only: run against the existing Jobs table, never the bootstrap schema.
-- User-scoped chronological listings can seek to one tenant and stop at LIMIT.
-- Admin-wide listings and deep OFFSET pages are not solved by this index.
CREATE INDEX IF NOT EXISTS idx_jobs_user_created ON Jobs (user_id, created);
