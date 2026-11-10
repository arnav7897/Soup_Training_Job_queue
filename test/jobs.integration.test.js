const { Pool } = require('pg');
const { buildApp } = require('../dist/app');
const { randomUUID } = require('node:crypto');

test('job creation, replay, validation, pagination and cancellation', async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
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
  } finally { await app.close(); await pool.end(); }
});
