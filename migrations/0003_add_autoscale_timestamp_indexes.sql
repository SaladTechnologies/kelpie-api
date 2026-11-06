-- Additive, idempotent indexes for the autoscaler's bounded timestamp branches.
-- Apply this migration before deploying the corresponding count query.
-- No Jobs rows are deleted or changed. Index construction still scans Jobs,
-- writes index pages, consumes D1 capacity and can delay other database work.
-- Check database/index storage headroom and schedule a low-traffic rollout.
--
-- Keep this separate from setup-db.sh: schemas/*.sql DROP existing tables and
-- are only appropriate for a fresh local/test database, never a production one.
-- Production application requires a separate explicit deployment approval.
--
-- The existing active-status partial index covers the active branch. These
-- indexes cover only non-null timestamps, with id included because Jobs.id
-- is a text primary key rather than the rowid. They preserve the original OR
-- semantics even when a job's current status differs from a terminal timestamp.
-- A job with multiple timestamps can appear in multiple indexes.
--
-- After applying, EXPLAIN QUERY PLAN should show indexed group/timestamp ranges
-- for all three terminal branches, and no SCAN Jobs. Verify real D1 rows_read
-- and p95 latency after a separately approved worker rollout.
CREATE INDEX IF NOT EXISTS idx_jobs_autoscale_completed
ON Jobs (container_group_id, completed, id) WHERE completed IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_autoscale_failed
ON Jobs (container_group_id, failed, id) WHERE failed IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_autoscale_canceled
ON Jobs (container_group_id, canceled, id) WHERE canceled IS NOT NULL;
