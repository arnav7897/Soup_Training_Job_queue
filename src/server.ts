import { Pool } from 'pg';
import { loadConfig } from './config';
import { buildApp } from './app';
import { redisClient } from './events';
async function main() {
  const config = loadConfig(process.env);
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  const redis = redisClient(config.REDIS_URL);
  const app = buildApp(pool, redis);
  app.addHook('onClose', async () => { redis.disconnect(); await pool.end(); });
  await app.listen({ port: config.PORT, host: config.HOST });
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
