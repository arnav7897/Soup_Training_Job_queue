const { Pool } = require('pg');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { redisClient, publishOne } = require('../dist/events');
const { cacheJob, cachedJob } = require('../dist/cache');
const { buildApp } = require('../dist/app');

test('relay duplicates, stale cache writes and Redis outage fallback', async () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
  const redis = redisClient(process.env.REDIS_URL);
  const unavailable = redisClient('redis://127.0.0.1:1');
  const app = buildApp(pool, redis);
  const fallback = buildApp(pool, unavailable);
  const id = randomUUID();
  try {
    await redis.connect();
    await pool.query(readFileSync('migrations/001_initial.sql', 'utf8'));
    await pool.query(readFileSync('migrations/002_metrics.sql', 'utf8'));
    await pool.query(readFileSync('migrations/003_commit_order_and_outbox_index.sql', 'utf8'));
    await pool.query(`INSERT INTO jobs(id,idempotency_key,request_hash,name,model,params)
      VALUES($1,$2,'hash','test','gpt2-small','{}')`, [id, id]);
    const old = { id, version: 1, status: 'queued' };
    await cacheJob(redis, old);
    expect(await cachedJob(redis, id, 1)).toEqual(old);
    await pool.query("UPDATE jobs SET status='cancelled', version=2 WHERE id=$1", [id]);
    await pool.query('INSERT INTO outbox(type,job_id,payload) VALUES($1,$2,$3)', ['job.cancelled', id, JSON.stringify({ jobId: id, status: 'cancelled', version: 2 })]);
    expect(await publishOne(pool, redis)).toBe(true);
    expect(await cachedJob(redis, id, 1)).toBeNull();
    await cacheJob(redis, old);
    expect(await cachedJob(redis, id, 1)).toBeNull();
    await pool.query('UPDATE outbox SET published_at=NULL');
    expect(await publishOne(pool, redis)).toBe(true);
    expect((await app.inject({ url: `/jobs/${id}` })).json().status).toBe('cancelled');
    expect((await fallback.inject({ url: `/jobs/${id}` })).json().status).toBe('cancelled');
    await pool.query("UPDATE jobs SET status='failed', version=3 WHERE id=$1", [id]);
    expect((await app.inject({ url: `/jobs/${id}` })).json().status).toBe('failed');
  } finally {
    await app.close(); await fallback.close();
    await redis.del(`job:${id}`); redis.disconnect(); unavailable.disconnect();
    await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
  }
}, 30000);
