BEGIN;
DROP TRIGGER IF EXISTS jobs_assign_creation_time ON jobs;
DROP FUNCTION IF EXISTS assign_job_creation_time();
DROP TABLE IF EXISTS job_creation_clock;
DROP INDEX IF EXISTS outbox_unpublished_id_idx;
-- Remove an unused empty table, but retain historical rows if any were written.
DO $$ BEGIN
  IF to_regclass('outbox') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM outbox LIMIT 1) THEN
    DROP TABLE outbox;
  END IF;
END $$;
COMMIT;
