import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { loadConfig } from './config';
import { claim, complete, heartbeat, reap } from './queue';
import { log, errorMessage } from './log';

async function main() {
  const config = loadConfig(process.env);
  const worker = randomUUID();
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  let stopping = false;
  let lastReap = 0;
  let idleMs = 50;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  try {
    while (!stopping) {
      try {
        if (performance.now() - lastReap >= 1000) {
          const recovered = await reap(pool);
          lastReap = performance.now();
          if (recovered) log('info', 'worker', 'leases_recovered', { worker, count: recovered });
        }
        const job = await claim(pool, worker, config.LEASE_MS);
        if (!job) {
          await sleep(idleMs);
          idleMs = Math.min(idleMs * 2, 500);
          continue;
        }
        idleMs = 50;
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
  } finally { await pool.end(); }
}
main().catch((error: unknown) => { log('error', 'worker', 'startup_failed', { error: errorMessage(error) }); process.exitCode = 1; });
