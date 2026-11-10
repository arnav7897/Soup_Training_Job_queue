import Redis from 'ioredis';

const setScript = `
local previous = tonumber(redis.call('HGET', KEYS[1], 'version') or '0')
local incoming = tonumber(ARGV[1])
if incoming < previous then return 0 end
redis.call('HSET', KEYS[1], 'version', incoming, 'data', ARGV[2])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1`;

type CachedJob = { id: string; version: number; status: string };
export async function cachedJob(redis: Redis, id: string, version: number): Promise<CachedJob | null> {
  try {
    const value = await redis.hget(`job:${id}`, 'data');
    if (!value) return null;
    const job = JSON.parse(value) as CachedJob;
    return job && job.id === id && job.version === version && typeof job.status === 'string' ? job : null;
  } catch { return null; }
}
export async function cacheJob(redis: Redis, job: CachedJob): Promise<void> {
  const ttl = ['succeeded', 'failed', 'cancelled'].includes(job.status) ? 3600000 : 2000;
  try { await redis.eval(setScript, 1, `job:${job.id}`, String(job.version), JSON.stringify(job), String(ttl)); }
  catch { /* Redis is a best-effort cache. */ }
}
