const { Pool } = require('pg');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');

test('migration preserves existing jobs and installs commit-order and outbox indexes idempotently', async () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
  try {
    for (const file of ['001_initial.sql', '002_metrics.sql']) await pool.query(readFileSync(`migrations/${file}`, 'utf8'));
    const id = randomUUID();
    await pool.query(`INSERT INTO jobs(id,idempotency_key,request_hash,name,model,params,created_at)
      VALUES($1,$2,'hash','existing','custom','{}','2035-01-01T00:00:00Z')`, [id,id]);
    const migration = readFileSync('migrations/003_commit_order_and_outbox_index.sql', 'utf8');
    await pool.query(migration);
    await pool.query(migration);
    const nextId = randomUUID();
    const inserted = await pool.query(`INSERT INTO jobs(id,idempotency_key,request_hash,name,model,params)
      VALUES($1,$2,'hash','new','custom','{}') RETURNING created_at`, [nextId,nextId]);
    const existing = await pool.query('SELECT created_at FROM jobs WHERE id=$1', [id]);
    expect(existing.rows[0].created_at.toISOString()).toBe('2035-01-01T00:00:00.000Z');
    const ordered = await pool.query('SELECT created_at > (SELECT created_at FROM jobs WHERE id=$1) AS later FROM jobs WHERE id=$2', [id,nextId]);
    expect(ordered.rows[0].later).toBe(true);
    expect(inserted.rowCount).toBe(1);
    const index = await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='outbox_unpublished_id_idx'", [schema]);
    expect(index.rows[0].indexdef).toContain('WHERE (published_at IS NULL)');
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
});
