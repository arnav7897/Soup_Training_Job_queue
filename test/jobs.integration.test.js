const { Pool } = require('pg');
const { buildApp } = require('../dist/app');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { setTimeout: sleep } = require('node:timers/promises');

test('job creation, replay, validation, pagination and cancellation', async () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
  await pool.query(readFileSync('migrations/001_initial.sql', 'utf8'));
    await pool.query(readFileSync('migrations/002_metrics.sql', 'utf8'));
    await pool.query(readFileSync('migrations/003_commit_order_and_outbox_index.sql', 'utf8'));
  const app = buildApp(pool);
  const key = randomUUID();
  const payload = { name: 'test', model: 'gpt2-small', params: { epochs: 1, batchSize: 4, learningRate: 0.01, durationMs: 0 } };
  try {
    const create = () => app.inject({ method: 'POST', url: '/jobs', headers: { 'idempotency-key': key }, payload });
    const results = await Promise.all(Array.from({ length: 100 }, create));
    expect(results.filter(r => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter(r => r.statusCode === 200)).toHaveLength(99);
    const job = results[0].json();
    expect(new Set(results.map(r => r.json().id)).size).toBe(1);
    expect((await app.inject({ method: 'POST', url: '/jobs', headers: { 'idempotency-key': key }, payload: { ...payload, name: 'different' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/jobs', headers: { 'idempotency-key': key }, payload: { ...payload, extra: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ url: `/jobs/${job.id}` })).json().id).toBe(job.id);
    expect((await app.inject({ url: '/jobs?limit=1' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/jobs?cursor=invalid' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/jobs/${job.id}/cancel` })).json().status).toBe('cancelled');
    expect((await app.inject({ method: 'POST', url: `/jobs/${job.id}/cancel` })).statusCode).toBe(200);
    const events = await pool.query('SELECT type FROM outbox WHERE job_id=$1 ORDER BY id', [job.id]);
    expect(events.rows.map(row => row.type)).toEqual(['job.queued', 'job.cancelled']);
    const delayed = await pool.connect();
    let pending;
    try {
      const firstId = randomUUID();
      await delayed.query('BEGIN');
      await delayed.query(`INSERT INTO jobs(id,idempotency_key,request_hash,name,model,params) VALUES($1,$2,'hash','delayed','custom','{}')`, [firstId, firstId]);
      let finished = false;
      pending = Promise.all([0, 1].map(() => app.inject({ method: 'POST', url: '/jobs', headers: { 'idempotency-key': randomUUID() }, payload })));
      pending.then(() => { finished = true; });
      await sleep(200);
      expect(finished).toBe(false);
      await delayed.query('COMMIT');
      const later = await pending;
      expect(later.map(r => r.statusCode)).toEqual([201, 201]);
      const expected = new Set([firstId, ...later.map(r => r.json().id)]);
      const seen = [];
      let cursor;
      do {
        const page = (await app.inject({ url: `/jobs?status=queued&limit=1${cursor ? `&cursor=${cursor}` : ''}` })).json();
        seen.push(...page.jobs.map(row => row.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(new Set(seen)).toEqual(expected);
      expect(seen).toHaveLength(expected.size);
    } finally {
      await delayed.query('ROLLBACK');
      delayed.release();
      if (pending) await pending;
    }

  } finally { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
});
