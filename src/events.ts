import Redis from 'ioredis';
import { Pool } from 'pg';
import { z } from 'zod';
import { log } from './log';

const eventSchema = z.object({ jobId: z.string().uuid(), status: z.enum(['queued','running','succeeded','failed','cancelled']), version: z.number().int().positive() }).strict();
const invalidateScript = `
local old = tonumber(redis.call('HGET', KEYS[1], 'version') or '0')
local incoming = tonumber(ARGV[1])
if incoming > old then
 redis.call('HSET', KEYS[1], 'version', incoming)
 redis.call('HDEL', KEYS[1], 'data')
 redis.call('PEXPIRE', KEYS[1], 3600000)
end
return 1`;

export function redisClient(url: string): Redis {
  const redis = new Redis(url, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 1000, commandTimeout: 1000, retryStrategy: () => 1000 });
  redis.on('error', error => log('error', 'redis', 'connection_error', { error: error.message }));
  return redis;
}

export async function publishOne(pool: Pool, redis: Redis): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT id,type,job_id,payload FROM outbox WHERE published_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1');
    if (!result.rowCount) { await client.query('COMMIT'); return false; }
    const row = result.rows[0];
    const payload = eventSchema.parse(row.payload);
    if (row.job_id !== payload.jobId || row.type !== `job.${payload.status}`) throw new Error('Invalid outbox event');
    await redis.xadd('jobs.events', '*', 'outboxId', String(row.id), 'type', row.type, 'payload', JSON.stringify(payload));
    await redis.eval(invalidateScript, 1, `job:${payload.jobId}`, String(payload.version));
    await client.query('UPDATE outbox SET published_at=now() WHERE id=$1', [row.id]);
    await client.query('COMMIT');
    return true;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
