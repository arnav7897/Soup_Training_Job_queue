import { Pool } from 'pg';
import { loadConfig } from './config';
import { buildApp } from './app';
async function main() {
  const config = loadConfig(process.env);
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  const app = buildApp(pool);
  app.addHook('onClose', async () => { await pool.end(); });
  await app.listen({ port: config.PORT, host: config.HOST });
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
