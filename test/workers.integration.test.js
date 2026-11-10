const { Pool } = require('pg');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { claim, heartbeat, complete, reap } = require('../dist/queue');
const { buildApp } = require('../dist/app');

test('concurrent claims, stale fences, cancellation and exhausted retries', async () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}`, max: 60 });
  const app = buildApp(pool);
  const insert = async (attempts = 0, max = 3) => {
    const id = randomUUID();
    await pool.query(`INSERT INTO jobs(id,idempotency_key,request_hash,name,model,params,attempts,max_attempts)
      VALUES($1,$2,'hash','job','gpt2-small','{"durationMs":0}',$3,$4)`, [id, id, attempts, max]);
    return id;
  };
  try {
    await pool.query(readFileSync('migrations/001_initial.sql', 'utf8'));
    await pool.query(readFileSync('migrations/002_metrics.sql', 'utf8'));
    const id = await insert();
    const claims = (await Promise.all(Array.from({ length: 50 }, (_, i) => claim(pool, `w${i}`, 10000)))).filter(Boolean);
    expect(claims).toHaveLength(1);
    const first = claims[0];
    const owner = (await pool.query('SELECT lease_owner FROM jobs WHERE id=$1', [id])).rows[0].lease_owner;
    const initialVersion = (await pool.query('SELECT version FROM jobs WHERE id=$1', [id])).rows[0].version;
    expect(await heartbeat(pool, first, owner, 10000)).toBe(true);
    expect((await pool.query('SELECT version FROM jobs WHERE id=$1', [id])).rows[0].version).toBe(initialVersion + 1);
    await pool.query("UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [id]);
    expect(await heartbeat(pool, first, owner, 10000)).toBe(false);
    expect(await complete(pool, first, owner)).toBe(false);
    expect(await reap(pool)).toBe(1);
    expect(await reap(pool)).toBe(0);
    const second = await claim(pool, 'new', 10000);
    expect(second.lease_epoch).toBeGreaterThan(first.lease_epoch);
    expect(await complete(pool, first, owner)).toBe(false);
    expect(await complete(pool, second, 'new')).toBe(true);
    expect((await pool.query('SELECT count(*)::int AS n FROM effects WHERE job_id=$1', [id])).rows[0].n).toBe(1);

    const cancelId = await insert();
    const running = await claim(pool, 'cancel-worker', 10000);
    const cancelled = await app.inject({ method: 'POST', url: `/jobs/${cancelId}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect(await complete(pool, running, 'cancel-worker')).toBe(false);
    expect((await pool.query('SELECT count(*)::int AS n FROM effects WHERE job_id=$1', [cancelId])).rows[0].n).toBe(0);

    for (let i = 0; i < 500; i++) {
      const raceId = await insert();
      const raceJob = await claim(pool, 'racer', 10000);
      const [finish, cancel] = await Promise.all([
        complete(pool, raceJob, 'racer'),
        app.inject({ method: 'POST', url: `/jobs/${raceId}/cancel` }),
      ]);
      const row = (await pool.query('SELECT status FROM jobs WHERE id=$1', [raceId])).rows[0];
      const effects = (await pool.query('SELECT count(*)::int AS n FROM effects WHERE job_id=$1', [raceId])).rows[0].n;
      expect(row.status).toBe(finish ? 'succeeded' : 'cancelled');
      expect(effects).toBe(finish ? 1 : 0);
      expect(cancel.statusCode).toBe(finish ? 409 : 200);
    }

    const rollbackId = await insert();
    const rollbackJob = await claim(pool, 'rollback', 10000);
    await pool.query('INSERT INTO effects(job_id,worker_id,lease_epoch) VALUES($1,$2,$3)', [rollbackId, 'existing', 1]);
    await expect(complete(pool, rollbackJob, 'rollback')).rejects.toThrow();
    expect((await pool.query('SELECT status FROM jobs WHERE id=$1', [rollbackId])).rows[0].status).toBe('running');
    await pool.query('DELETE FROM effects WHERE job_id=$1', [rollbackId]);
    await app.inject({ method: 'POST', url: `/jobs/${rollbackId}/cancel` });

    await Promise.all(Array.from({ length: 200 }, () => insert()));
    const claimed = [];
    await Promise.all(Array.from({ length: 50 }, async (_, i) => {
      const worker = `load-${i}`;
      for (;;) {
        const job = await claim(pool, worker, 30000);
        if (!job) break;
        claimed.push(job.id);
        expect(await complete(pool, job, worker)).toBe(true);
      }
    }));
    expect(claimed).toHaveLength(200);
    expect(new Set(claimed).size).toBe(200);

    const exhausted = await insert(0, 1);
    await claim(pool, 'dead', 10000);
    await pool.query("UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [exhausted]);
    await reap(pool);
    expect((await pool.query('SELECT status FROM jobs WHERE id=$1', [exhausted])).rows[0].status).toBe('failed');
    const response = await app.inject({ url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('queue_lease_expiries_total 2');
    const rejected = response.body.match(/queue_fence_rejections_total ([0-9]+)/);
    expect(Number(rejected?.[1])).toBeGreaterThanOrEqual(3);
    expect(response.body).toMatch(/queue_claims_total [0-9]+/);
    expect(response.body).toContain('queue_jobs{state="failed"} 1');
    expect(response.body).toMatch(/queue_outbox_oldest_age_seconds [0-9.]+/);
  } finally {
    await app.close();
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}, 30000);
