import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { loadConfig } from './config';
import { claim, complete, heartbeat, reap } from './queue';
import { redisClient } from './events';
import { log, errorMessage } from './log';

async function main() {
  const config = loadConfig(process.env);
  const worker = randomUUID();
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  const redis = redisClient(config.REDIS_URL);
  let cursor = '$';
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  try {
    while (!stopping) {
      try {
        const recovered = await reap(pool);
        if (recovered) log('info', 'worker', 'leases_recovered', { worker, count: recovered });
        const job = await claim(pool, worker, config.LEASE_MS);
        if (!job) {
          try {
            const messages = await redis.xread('BLOCK', 750, 'STREAMS', 'jobs.events', cursor);
            if (messages?.length) cursor = messages[0][1].at(-1)?.[0] ?? cursor;
          } catch { await sleep(500); }
          continue;
        }
        log('info', 'worker', 'job_claimed', { worker, job: job.id, epoch: job.lease_epoch });
        let active = true;
        let heartbeatTask: Promise<void> = Promise.resolve();
        const timer = setInterval(() => {
          heartbeatTask = heartbeatTask.then(async () => {
            if (active && !await heartbeat(pool, job, worker, config.LEASE_MS)) active = false;
          }).catch(error => { active = false; log('error', 'worker', 'heartbeat_failed', { worker, job: job.id, error: errorMessage(error) }); });
        }, Math.floor(config.LEASE_MS / 3));
        try {
          await sleep(job.params.durationMs);
          clearInterval(timer);
          await heartbeatTask;
          if (active) {
            const completed = await complete(pool, job, worker);
            log(completed ? 'info' : 'warn', 'worker', completed ? 'job_completed' : 'completion_rejected', { worker, job: job.id, epoch: job.lease_epoch });
          }
        } finally { active = false; clearInterval(timer); await heartbeatTask; }
      } catch (error) { log('error', 'worker', 'loop_failed', { worker, error: errorMessage(error) }); await sleep(1000); }
    }
  } finally { redis.disconnect(); await pool.end(); }
}
main().catch((error: unknown) => { log('error', 'worker', 'startup_failed', { error: errorMessage(error) }); process.exitCode = 1; });
