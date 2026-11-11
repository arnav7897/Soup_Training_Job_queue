import { Pool } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { loadConfig } from './config';
import path from 'node:path';

export async function migrate(pool: Pool, directory = 'migrations') {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(731902451)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const files = (await readdir(directory)).filter(file => /^\d+.*\.sql$/.test(file)).sort();
    for (const file of files) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [file]);
      if (applied.rowCount) continue;
      await client.query(await readFile(path.join(directory, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES($1) ON CONFLICT DO NOTHING', [file]);
    }
  } finally {
    try { await client.query('ROLLBACK'); } catch { /* No transaction may be active. */ }
    try { await client.query('SELECT pg_advisory_unlock(731902451)'); }
    finally { client.release(); }
  }
}

async function main() {
  const pool = new Pool({ connectionString: loadConfig(process.env).DATABASE_URL });
  try { await migrate(pool); }
  finally { await pool.end(); }
}
if (require.main === module) main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
