BEGIN;
-- Wait for existing writers before seeding the clock and installing the trigger.
LOCK TABLE jobs IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE IF NOT EXISTS job_creation_clock (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_created_at timestamptz NOT NULL
);
INSERT INTO job_creation_clock(singleton, last_created_at)
SELECT true, COALESCE(MAX(created_at), '-infinity'::timestamptz) FROM jobs
ON CONFLICT (singleton) DO UPDATE
  SET last_created_at = GREATEST(job_creation_clock.last_created_at, EXCLUDED.last_created_at);
CREATE OR REPLACE FUNCTION assign_job_creation_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE job_creation_clock
    SET last_created_at = GREATEST(clock_timestamp(), last_created_at + interval '1 microsecond')
    WHERE singleton = true
    RETURNING last_created_at INTO NEW.created_at;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS jobs_assign_creation_time ON jobs;
CREATE TRIGGER jobs_assign_creation_time BEFORE INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION assign_job_creation_time();
CREATE INDEX IF NOT EXISTS outbox_unpublished_id_idx ON outbox (id) WHERE published_at IS NULL;
COMMIT;
