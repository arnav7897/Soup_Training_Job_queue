import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { loadConfig } from './config';
import { claim, complete, heartbeat, reap } from './queue';

async function main() {
  const config = loadConfig(process.env);
  const worker = randomUUID();
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  try {
    while (!stopping) {
      try {
        await reap(pool);
        const job = await claim(pool, worker, config.LEASE_MS);
        if (!job) { await sleep(500); continue; }
        let active = true;
        let heartbeatTask: Promise<void> = Promise.resolve();
        const timer = setInterval(() => {
          heartbeatTask = heartbeatTask.then(async () => {
            if (active && !await heartbeat(pool, job, worker, config.LEASE_MS)) active = false;
          }).catch(error => { active = false; console.error('heartbeat failed', error); });
        }, Math.floor(config.LEASE_MS / 3));
        try {
          await sleep(job.params.durationMs);
          clearInterval(timer);
          await heartbeatTask;
          if (active && !await complete(pool, job, worker)) console.warn('completion rejected', job.id);
        } finally { active = false; clearInterval(timer); await heartbeatTask; }
      } catch (error) { console.error('worker loop failed', error); await sleep(1000); }
    }
  } finally { await pool.end(); }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
