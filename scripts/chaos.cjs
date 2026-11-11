#!/usr/bin/env node
'use strict';
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const exec = promisify(execFile);
const root = path.resolve(__dirname, '..');
const seed = Number(process.env.CHAOS_SEED || 1);
const count = Number(process.env.CHAOS_JOBS || 10000);
const concurrency = Number(process.env.CHAOS_CONCURRENCY || 25);
const timeoutMs = Number(process.env.CHAOS_TIMEOUT_MS || 600000);
const workerCount = Number(process.env.CHAOS_WORKERS || 8);
const killLimit = Number(process.env.CHAOS_KILLS || 0);
if (!Number.isSafeInteger(seed) || seed < 0 || seed > 4294967295 || !Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 100 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || !Number.isSafeInteger(workerCount) || workerCount < 2 || workerCount > 32 || !Number.isSafeInteger(killLimit) || killLimit < 0) throw Error('Invalid chaos configuration');
let state = seed >>> 0;
function random() { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; }
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const run = `chaos-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
const dir = path.join(process.env.CHAOS_RUN_ROOT || path.join(root, 'runs'), run);
const project = `soupchaos${crypto.randomBytes(6).toString('hex')}`;
fs.mkdirSync(path.dirname(dir), { recursive: true });
fs.mkdirSync(dir, { recursive: false });
const raw = fs.createWriteStream(path.join(dir, 'events.ndjson'), { flags: 'wx' });
const override = path.join(dir, 'compose.override.yml');
fs.writeFileSync(override, "services:\n  api:\n    ports: !override\n      - '127.0.0.1::3000'\n  worker:\n    deploy:\n      replicas: ${workerCount}\n    environment:\n      LEASE_MS: '3000'\n".replace('${workerCount}', String(workerCount)));
function record(type, fields = {}) { raw.write(JSON.stringify({ time: new Date().toISOString(), type, ...fields }) + '\n'); }
const composeArgs = ['compose', '-p', project, '-f', path.join(root, 'compose.yaml'), '-f', override];
async function command(binary, args, options = {}) {
  const result = await exec(binary, args, { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: options.timeout || 300000 });
  if (options.log !== false) record('command', { binary, args, stdout: result.stdout, stderr: result.stderr });
  return result.stdout.trim();
}
const compose = (...args) => command('docker', [...composeArgs, ...args]);
async function sql(query) { return compose('exec', '-T', 'db', 'psql', '-U', 'queue', '-d', 'queue', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query); }
async function request(url, options, label) {
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
    const text = await response.text();
    record('http', { label, status: response.status, body: text });
    return { status: response.status, body: JSON.parse(text), replayed: response.headers.get('idempotent-replayed') };
  } catch (error) { record('http_error', { label, error: String(error) }); throw error; }
}
async function saveComposeLogs() {
  const fd = fs.openSync(path.join(dir, 'compose.log'), 'wx');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('docker', [...composeArgs, 'logs', '--no-color', '--timestamps'], { cwd: root, stdio: ['ignore', fd, fd] });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`docker logs exited ${code}`)));
    });
  } finally { fs.closeSync(fd); }
}
async function main() {
  const summary = { run, seed, requestedJobs: count, workerCount, killLimit, project, status: 'failed', startedAt: new Date().toISOString(), checks: {}, errors: [], limits: ['Seed controls inputs and fault choices; OS scheduling and interleavings are not deterministic.', 'Single-host run does not test database, Redis, disk or network failure, or external effects.'] };
  const acknowledged = new Map();
  const cancelled = new Set();
  let stopFaults = false;
  let paused = null;
  let faultTask;
  let started = false;
  record('start', { run, seed, count, concurrency, timeoutMs, project });
  try {
    // Build all choices before concurrent requests so scheduling cannot change inputs.
    const jobs = Array.from({ length: count }, (_, i) => ({ index: i, replay: random() < 0.30, cancel: random() < 0.05, duration: i < workerCount ? 9000 : Math.floor(random() * 10) }));
    const faultChoices = Array.from({ length: Math.ceil(timeoutMs / 2000) + 10 }, () => Math.floor(random() * workerCount));
    started = true;
    await compose('up', '-d', '--build');
    const port = await compose('port', 'api', '3000');
    const match = port.match(/:(\d+)$/);
    if (!match) throw Error(`Cannot determine API port: ${port}`);
    const base = `http://127.0.0.1:${match[1]}`;
    const workers = (await compose('ps', '-q', 'worker')).split('\n').filter(Boolean);
    if (workers.length !== workerCount) throw Error(`Expected ${workerCount} workers, got ${workers.length}`);
    let faultIndex = 0;
    let kills = 0;
    faultTask = (async () => {
      await sleep(1500);
      if (stopFaults) return;
      paused = workers[faultChoices[faultIndex++] % workers.length];
      await command('docker', ['kill', '--signal', 'STOP', paused]);
      record('freeze', { worker: paused, durationMs: 5000 });
      const thaw = (async () => { await sleep(5000); if (paused) { await command('docker', ['kill', '--signal', 'CONT', paused]); paused = null; } })();
      while (!stopFaults && (!killLimit || kills < killLimit)) {
        await sleep(2000);
        if (stopFaults) break;
        let target = workers[faultChoices[faultIndex++ % faultChoices.length] % workers.length];
        if (target === paused) target = workers[(workers.indexOf(target) + 1) % workers.length];
        await command('docker', ['kill', '--signal', 'KILL', target]);
        kills++;
        record('kill', { worker: target });
        await command('docker', ['start', target]);
        record('restart', { worker: target });
      }
      await thaw;
    })().catch(error => { summary.errors.push(`fault injection: ${error}`); record('fault_error', { error: String(error) }); });
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, count) }, async () => {
      for (;;) {
        const job = jobs[next++];
        if (!job) return;
        const key = `${run}-${job.index}`;
        const body = JSON.stringify({ name: `chaos-${job.index}`, model: 'gpt2-small', params: { epochs: 1, batchSize: 1, learningRate: 0.01, durationMs: job.duration } });
        const opts = { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body };
        try {
          const created = await request(`${base}/jobs`, opts, `create:${job.index}`);
          if (created.status !== 201 || !created.body.id) throw Error(`create returned ${created.status}`);
          acknowledged.set(key, created.body.id);
          if (job.replay) {
            const replay = await request(`${base}/jobs`, opts, `replay:${job.index}`);
            if (replay.status !== 200 || replay.replayed !== 'true' || replay.body.id !== created.body.id) throw Error(`replay returned ${replay.status}`);
          }
          if (job.cancel) {
            const result = await request(`${base}/jobs/${created.body.id}/cancel`, { method: 'POST' }, `cancel:${job.index}`);
            if (result.status === 200) cancelled.add(created.body.id);
            else if (result.status !== 409) throw Error(`cancel returned ${result.status}`);
          }
        } catch (error) { summary.errors.push(`job ${job.index}: ${error}`); }
      }
    }));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pending = Number(await sql("SELECT count(*) FROM jobs WHERE status IN ('queued','running')"));
      record('drain', { pending });
      if (!pending) break;
      if (Date.now() >= deadline) throw Error(`Timed out with ${pending} unfinished jobs`);
      await sleep(2000);
    }
    stopFaults = true;
    await faultTask;
    const cancelIds = [...cancelled].join(',');
    const query = `WITH history AS (SELECT job_id, payload->>'status' AS status, lag(payload->>'status') OVER (PARTITION BY job_id ORDER BY id) AS previous FROM outbox), invalid AS (SELECT * FROM history WHERE NOT ((previous IS NULL AND status='queued') OR (previous='queued' AND status IN ('running','cancelled')) OR (previous='running' AND status IN ('queued','succeeded','failed','cancelled')))) SELECT json_build_object('jobs',(SELECT count(*) FROM jobs),'distinct_keys',(SELECT count(DISTINCT idempotency_key) FROM jobs),'unfinished',(SELECT count(*) FROM jobs WHERE status IN ('queued','running')),'bad_effects',(SELECT count(*) FROM jobs j LEFT JOIN effects e ON e.job_id=j.id WHERE (j.status='succeeded' AND e.job_id IS NULL) OR (j.status IN ('cancelled','failed') AND e.job_id IS NOT NULL)),'illegal_transitions',(SELECT count(*) FROM invalid),'missing_initial_events',(SELECT count(*) FROM jobs j WHERE NOT EXISTS (SELECT 1 FROM outbox o WHERE o.job_id=j.id AND o.type='job.queued')),'bad_cancels',(SELECT count(*) FROM jobs WHERE id=ANY(string_to_array('${cancelIds}', ',')::uuid[]) AND status<>'cancelled'),'executions',(SELECT count(*) FROM executions),'duplicate_executions',(SELECT count(*) FROM executions)-(SELECT count(DISTINCT job_id) FROM executions),'fence_rejections',(SELECT value FROM queue_counters WHERE name='fence_rejections'),'lease_expiries',(SELECT value FROM queue_counters WHERE name='lease_expiries'))`;
    const observed = JSON.parse(await sql(query));
    const probeSource = fs.readFileSync(path.join(root, 'scripts', 'fence-probe.cjs'), 'utf8');
    const probe = JSON.parse(await compose('exec', '-T', 'api', 'node', '-e', probeSource));
    record('fence_probe', probe);
    const mapping = new Map(JSON.parse(await sql("SELECT COALESCE(json_agg(json_build_array(idempotency_key,id)), '[]'::json) FROM jobs")));
    const matchingAcks = [...acknowledged].every(([key, id]) => mapping.get(key) === id);
    summary.observed = { ...observed, kills, fenceProbe: probe }; 
    summary.checks = { all_created_and_acknowledged: observed.jobs === count && acknowledged.size === count && observed.distinct_keys === count && matchingAcks && new Set(acknowledged.values()).size === count, all_terminal: observed.unfinished === 0, effects_match_states: observed.bad_effects === 0, legal_transitions: observed.illegal_transitions === 0 && observed.missing_initial_events === 0, acknowledged_cancels_hold: observed.bad_cancels === 0, no_client_or_fault_errors: summary.errors.length === 0, requested_kills_exercised: !killLimit || kills === killLimit, stale_epoch_fenced: probe.accepted === false && probe.effects === 0, zombie_exercised: Number(observed.fence_rejections) > 0 };
    summary.status = Object.values(summary.checks).every(Boolean) ? 'passed' : 'failed';
  } catch (error) { summary.errors.push(String(error)); record('run_error', { error: String(error) }); }
  finally {
    stopFaults = true;
    if (faultTask) await faultTask;
    if (paused) { try { await command('docker', ['kill', '--signal', 'CONT', paused]); } catch (error) { summary.errors.push(`resume: ${error}`); } }
    if (started) {
      try { await saveComposeLogs(); } catch (error) { summary.errors.push(`logs: ${error}`); }
      try { await compose('down', '--remove-orphans'); } catch (error) { summary.errors.push(`cleanup: ${error}`); }
    }
    if (summary.errors.length) summary.status = 'failed';
    summary.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
    record('summary', summary);
    await new Promise(resolve => raw.end(resolve));
    console.log(JSON.stringify(summary, null, 2));
    if (summary.status !== 'passed') process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
