'use strict';
const { Pool } = require('pg');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { complete } = require('./dist/queue');
(async () => {
  const schema = `probe_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
    for (const file of ['001_initial.sql', '002_metrics.sql', '003_commit_order_and_outbox_index.sql']) await pool.query(readFileSync(`migrations/${file}`, 'utf8'));
    const id = randomUUID();
    await pool.query(`INSERT INTO jobs(id,idempotency_key,request_hash,name,model,params,status,lease_owner,lease_epoch,lease_expires_at)
      VALUES($1,$2,'probe','probe','custom','{}','running','probe-worker',2,now()+interval '30 seconds')`, [id, id]);
    const accepted = await complete(pool, { id, lease_epoch: 1, params: { durationMs: 0 } }, 'probe-worker');
    const effects = Number((await pool.query('SELECT count(*) FROM effects WHERE job_id=$1', [id])).rows[0].count);
    console.log(JSON.stringify({ accepted, effects, expected: 'stale epoch rejected even if the worker ID matches' }));
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
