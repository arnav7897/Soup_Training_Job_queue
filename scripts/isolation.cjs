#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { claim, complete } = require('../dist/queue');
const { buildApp } = require('../dist/app');
const dir = path.join(__dirname, '..', 'runs', `isolation-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0,8)}`);
fs.mkdirSync(dir, { recursive: true });
const output = fs.createWriteStream(path.join(dir, 'events.ndjson'), { flags: 'wx' });
function record(type, fields = {}) { output.write(JSON.stringify({ time: new Date().toISOString(), type, ...fields }) + '\n'); }
async function scenario(level, admin) {
  const schema = `iso_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema} -c default_transaction_isolation=${level}`, max: 60 });
  const app = buildApp(pool);
  const counters = { claims: 0, retries: 0, serializationFailures: 0, deadlocks: 0, attempts: 0, errors: [], invariantFailures: 0, responseFailures: 0, duplicateClaims: 0 };
  async function retry(fn) {
    for (let attempt = 0; attempt < 200; attempt++) {
      counters.attempts++;
      try { return await fn(); }
      catch (error) {
        if (error.code !== '40001' && error.code !== '40P01') throw error;
        counters.retries++;
        if (error.code === '40001') counters.serializationFailures++; else counters.deadlocks++;
        record('retry', { level, code: error.code });
      }
    }
    throw Error('retry limit exceeded');
  }
  try {
    for (const file of ['001_initial.sql','002_metrics.sql','003_commit_order_and_outbox_index.sql','004_remove_global_creation_lock.sql']) await pool.query(fs.readFileSync(path.join(__dirname, '..', 'migrations', file), 'utf8'));
    counters.isolation = (await pool.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation;
    const expectedIsolation = level === 'serializable' ? 'serializable' : 'read committed';
    if (counters.isolation !== expectedIsolation) throw Error(`Expected ${expectedIsolation}, got ${counters.isolation}`);
    const insert = async () => { const id = randomUUID(); await pool.query("INSERT INTO jobs(id,idempotency_key,request_hash,name,model,params) VALUES($1,$2,'probe','probe','custom','{}')", [id,id]); return id; };
    await Promise.all(Array.from({ length: 200 }, insert));
    const claimed = [];
    await Promise.all(Array.from({ length: 50 }, async (_, index) => {
      const worker = `probe-${index}`;
      for (;;) {
        const job = await retry(() => claim(pool, worker, 30000));
        if (!job) break;
        claimed.push(job.id);
        if (!await retry(() => complete(pool, job, worker))) throw Error('unexpected completion rejection');
      }
    }));
    counters.claims = claimed.length; counters.duplicateClaims = claimed.length - new Set(claimed).size;
    for (let i = 0; i < 50; i++) {
      const id = await insert(); const job = await retry(() => claim(pool, 'race', 30000));
      const [completion, cancellation] = await Promise.all([
        retry(() => complete(pool, job, 'race')),
        (async () => { const result = await app.inject({ method: 'POST', url: `/jobs/${id}/cancel` }); if (![200,409].includes(result.statusCode)) record('cancel_error', { level, status: result.statusCode, body: result.body }); return result.statusCode; })(),
      ]);
      const result = await pool.query('SELECT status, (SELECT count(*) FROM effects WHERE job_id=jobs.id)::int AS effects FROM jobs WHERE id=$1', [id]);
      if (result.rows[0].status !== (completion ? 'succeeded' : 'cancelled') || result.rows[0].effects !== (completion ? 1 : 0)) counters.invariantFailures++;
      if (cancellation !== (completion ? 409 : 200)) counters.responseFailures++;
    }
    const remaining = await pool.query("SELECT count(*)::int AS n FROM jobs WHERE status IN ('queued','running')");
    counters.unfinished = remaining.rows[0].n;
    counters.retryRate = counters.attempts ? counters.retries / counters.attempts : 0;
    counters.status = counters.claims === 200 && counters.duplicateClaims === 0 && counters.invariantFailures === 0 && counters.responseFailures === 0 && counters.unfinished === 0 ? 'passed' : 'failed';
    return counters;
  } catch (error) { counters.errors.push(String(error)); counters.status = 'failed'; return counters; }
  finally { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
}
(async () => {
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  const summary = { startedAt: new Date().toISOString(), note: 'The service uses READ COMMITTED. SERIALIZABLE is not an application-supported mode and is not included in this probe.', results: {} };
  try {
    summary.results.read_committed = await scenario('read\\ committed', admin);
    summary.status = summary.results.read_committed.status;
  } catch (error) { summary.status = 'failed'; summary.error = String(error); }
  finally {
    await admin.end(); summary.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
    record('summary', summary); await new Promise(resolve => output.end(resolve));
    console.log(JSON.stringify(summary, null, 2)); if (summary.status !== 'passed') process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
