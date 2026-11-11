const { Pool } = require('pg');
const { randomUUID } = require('node:crypto');
const { migrate } = require('../dist/migrate');

test('applies migrations once and does not recreate removed locks on restart', async () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
  try {
    await migrate(pool);
    await migrate(pool);
    const result = await pool.query('SELECT name FROM schema_migrations ORDER BY name');
    expect(result.rows.map(row => row.name)).toEqual([
      '001_initial.sql', '002_metrics.sql', '003_commit_order_and_outbox_index.sql', '004_remove_global_creation_lock.sql',
    ]);
    expect((await pool.query("SELECT to_regclass('job_creation_clock') AS clock")).rows[0].clock).toBeNull();
    expect((await pool.query("SELECT count(*)::int AS count FROM pg_trigger WHERE tgname='jobs_assign_creation_time'")).rows[0].count).toBe(0);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
