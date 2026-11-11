import { Pool } from 'pg';

export async function metrics(pool: Pool): Promise<string> {
  const result = await pool.query(`SELECT
    (SELECT count(*) FROM jobs WHERE status='queued') AS queued,
    (SELECT count(*) FROM jobs WHERE status='running') AS running,
    (SELECT count(*) FROM jobs WHERE status='succeeded') AS succeeded,
    (SELECT count(*) FROM jobs WHERE status='failed') AS failed,
    (SELECT count(*) FROM jobs WHERE status='cancelled') AS cancelled,
    (SELECT count(*) FROM executions) AS claims,
    (SELECT COALESCE(value,0) FROM queue_counters WHERE name='fence_rejections') AS fence_rejections,
    (SELECT COALESCE(value,0) FROM queue_counters WHERE name='lease_expiries') AS lease_expiries,
    (SELECT count(*) FROM outbox WHERE published_at IS NULL) AS outbox_pending,
    (SELECT COALESCE(EXTRACT(EPOCH FROM (now()-min(created_at))),0) FROM outbox WHERE published_at IS NULL) AS outbox_lag`);
  const row = result.rows[0];
  const states = ['queued','running','succeeded','failed','cancelled'];
  return [
    '# HELP queue_jobs Current jobs by state.', '# TYPE queue_jobs gauge',
    ...states.map(state => `queue_jobs{state="${state}"} ${row[state]}`),
    '# HELP queue_claims_total Total committed job claims.', '# TYPE queue_claims_total counter', `queue_claims_total ${row.claims}`,
    '# HELP queue_fence_rejections_total Rejected heartbeat and completion attempts.', '# TYPE queue_fence_rejections_total counter', `queue_fence_rejections_total ${row.fence_rejections}`,
    '# HELP queue_lease_expiries_total Recovered expired leases.', '# TYPE queue_lease_expiries_total counter', `queue_lease_expiries_total ${row.lease_expiries}`,
    '# HELP queue_outbox_pending Unpublished outbox events.', '# TYPE queue_outbox_pending gauge', `queue_outbox_pending ${row.outbox_pending}`,
    '# HELP queue_outbox_oldest_age_seconds Age of oldest unpublished outbox event.', '# TYPE queue_outbox_oldest_age_seconds gauge', `queue_outbox_oldest_age_seconds ${row.outbox_lag}`,
    '',
  ].join('\n');
}
