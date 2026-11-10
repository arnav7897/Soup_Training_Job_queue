import { Pool, PoolClient } from 'pg';

export interface Claim { id: string; lease_epoch: number; params: { durationMs: number }; }

async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function event(client: PoolClient, job: { id: string; status: string; version: number }) {
  await client.query('INSERT INTO outbox(type,job_id,payload) VALUES($1,$2,$3)',
    [`job.${job.status}`, job.id, JSON.stringify({ jobId: job.id, status: job.status, version: job.version })]);
}

export async function claim(pool: Pool, worker: string, leaseMs: number): Promise<Claim | null> {
  return transaction(pool, async client => {
    const result = await client.query(`UPDATE jobs SET status='running', lease_owner=$1,
      lease_expires_at=now()+$2 * interval '1 millisecond', lease_epoch=lease_epoch+1,
      attempts=attempts+1, version=version+1, updated_at=now()
      WHERE id=(SELECT id FROM jobs WHERE status='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id,lease_epoch,params,status,version`, [worker, leaseMs]);
    if (!result.rowCount) return null;
    const job = result.rows[0];
    await client.query('INSERT INTO executions(job_id,worker_id,lease_epoch) VALUES($1,$2,$3)', [job.id, worker, job.lease_epoch]);
    await event(client, job);
    return job;
  });
}
