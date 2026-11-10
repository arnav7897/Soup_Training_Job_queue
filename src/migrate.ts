import { Pool } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { loadConfig } from './config';
async function main() {
  const pool = new Pool({ connectionString: loadConfig(process.env).DATABASE_URL });
  try {
    const files = (await readdir('migrations')).filter(file => /^\d+.*\.sql$/.test(file)).sort();
    for (const file of files) await pool.query(await readFile(`migrations/${file}`, 'utf8')); 
  } finally { await pool.end(); }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
