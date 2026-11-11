const { Pool } = require('pg');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');

test('migration preserves jobs and removes the global insert lock idempotently', async () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
  try {
    for (const file of ['001_initial.sql', '002_metrics.sql']) await pool.query(readFileSync(`migrations/${file}`, 'utf8'));
    const id = randomUUID();
    await pool.query(`INSERT INTO jobs(id,idempotency_key,request_hash,name,model,params,created_at)
      VALUES($1,$2,'hash','existing','custom','{}','2035-01-01T00:00:00Z')`, [id,id]);
    await pool.query(readFileSync('migrations/003_commit_order_and_outbox_index.sql', 'utf8'));
    await pool.query(`INSERT INTO outbox(type,job_id,payload) VALUES('legacy', $1, '{}')`, [id]);
    const migration = readFileSync('migrations/004_remove_global_creation_lock.sql', 'utf8');
    await pool.query(migration);
    await pool.query(migration);
    const nextId = randomUUID();
    const inserted = await pool.query(`INSERT INTO jobs(id,idempotency_key,request_hash,name,model,params)
      VALUES($1,$2,'hash','new','custom','{}') RETURNING created_at`, [nextId,nextId]);
    const existing = await pool.query('SELECT created_at FROM jobs WHERE id=$1', [id]);
    expect(existing.rows[0].created_at.toISOString()).toBe('2035-01-01T00:00:00.000Z');
    const ordered = await pool.query('SELECT created_at > (SELECT created_at FROM jobs WHERE id=$1) AS later FROM jobs WHERE id=$2', [id,nextId]);
    expect(ordered.rows[0].later).toBe(false);
    expect(inserted.rowCount).toBe(1);
    expect((await pool.query("SELECT to_regclass('job_creation_clock') AS clock")).rows[0].clock).toBeNull();
    expect((await pool.query("SELECT count(*)::int AS count FROM outbox WHERE job_id=$1", [id])).rows[0].count).toBe(1);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
});
