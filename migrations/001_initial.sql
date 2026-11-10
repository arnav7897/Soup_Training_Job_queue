CREATE TABLE IF NOT EXISTS jobs (
 id uuid PRIMARY KEY, idempotency_key text NOT NULL UNIQUE, request_hash text NOT NULL,
 name text NOT NULL, model text NOT NULL, params jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 3,
 lease_owner text, lease_expires_at timestamptz, lease_epoch integer NOT NULL DEFAULT 0,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_queued_idx ON jobs (created_at, id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS jobs_expiry_idx ON jobs (lease_expires_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs (created_at, id);
CREATE TABLE IF NOT EXISTS effects (job_id uuid PRIMARY KEY REFERENCES jobs(id), worker_id text NOT NULL, lease_epoch integer NOT NULL, written_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS executions (id bigserial PRIMARY KEY, job_id uuid NOT NULL REFERENCES jobs(id), worker_id text NOT NULL, lease_epoch integer NOT NULL, started_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS outbox (id bigserial PRIMARY KEY, type text NOT NULL, job_id uuid NOT NULL REFERENCES jobs(id), payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz);
