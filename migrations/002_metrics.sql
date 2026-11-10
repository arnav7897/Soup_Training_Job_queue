CREATE TABLE IF NOT EXISTS queue_counters (
 name text PRIMARY KEY,
 value bigint NOT NULL DEFAULT 0 CHECK (value >= 0)
);
INSERT INTO queue_counters(name) VALUES ('fence_rejections'), ('lease_expiries') ON CONFLICT DO NOTHING;
