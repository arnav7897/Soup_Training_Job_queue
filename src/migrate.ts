import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { loadConfig } from './config';
async function main() {
  const pool = new Pool({ connectionString: loadConfig(process.env).DATABASE_URL });
  try {
    const sql = await readFile('migrations/001_initial.sql', 'utf8');
    await pool.query(sql);
  } finally { await pool.end(); }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
