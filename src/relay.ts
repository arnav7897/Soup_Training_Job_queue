import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { loadConfig } from './config';
import { publishOne, redisClient } from './events';
import { log, errorMessage } from './log';

async function main() {
  const config = loadConfig(process.env);
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  const redis = redisClient(config.REDIS_URL);
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  try {
    while (!stopping) {
      try { if (!await publishOne(pool, redis)) await sleep(500); }
      catch (error) { log('error', 'relay', 'publish_failed', { error: errorMessage(error) }); await sleep(1000); }
    }
  } finally { redis.disconnect(); await pool.end(); }
}
main().catch((error: unknown) => { log('error', 'relay', 'startup_failed', { error: errorMessage(error) }); process.exitCode = 1; });
