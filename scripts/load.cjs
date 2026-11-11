#!/usr/bin/env node
'use strict';
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setTimeout: sleep } = require('node:timers/promises');
const exec = promisify(execFile);
const root = path.resolve(__dirname, '..');
const seconds = Number(process.env.LOAD_SECONDS || 600);
const rate = Number(process.env.LOAD_RPS || 100);
const seed = Number(process.env.LOAD_SEED || 1);
if (!Number.isSafeInteger(seconds) || seconds < 1 || !Number.isSafeInteger(rate) || rate < 1 || rate > 1000 || !Number.isSafeInteger(seed) || seed < 0 || seed > 4294967295) throw Error('Invalid load configuration');
let state = seed >>> 0;
function random() { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; }
const run = `load-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
const dir = path.join(root, 'runs', run);
const project = `soupload${crypto.randomBytes(6).toString('hex')}`;
fs.mkdirSync(path.dirname(dir), { recursive: true }); fs.mkdirSync(dir);
const raw = fs.createWriteStream(path.join(dir, 'events.ndjson'), { flags: 'wx' });
function record(type, fields = {}) { raw.write(JSON.stringify({ time: new Date().toISOString(), type, ...fields }) + '\n'); }
const override = path.join(dir, 'compose.override.yml');
fs.writeFileSync(override, "services:\n  api:\n    ports: !override\n      - '127.0.0.1::3000'\n");
const composeArgs = ['compose', '-p', project, '-f', path.join(root, 'compose.yaml'), '-f', override];
async function docker(...args) { const result = await exec('docker', [...composeArgs, ...args], { cwd: root, timeout: 300000, maxBuffer: 64 * 1024 * 1024 }); record('docker', { args, stdout: result.stdout, stderr: result.stderr }); return result.stdout.trim(); }
function gauge(text, pattern) { const match = text.match(pattern); return match ? Number(match[1]) : null; }
function percentile(sorted, fraction) { return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null; }
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
  const summary = { run, seed, project, seconds, targetRps: rate, status: 'failed', startedAt: new Date().toISOString(), errors: [], limits: ['Workload uses simulated 20ms jobs, 70% creates, 20% reads, 10% cancels; target distribution may differ while no IDs exist.', 'Seed fixes operation choices; request completion order and selected job IDs depend on scheduling.', 'The assessment specifies 100 requests/second but no latency limit; the 200 ms p99 check is a project target.'] };
  const ids = []; const latencies = []; const pending = new Set(); const samples = [];
  let sent = 0; let succeeded = 0; let dropped = 0; let stopSampling = false; let sampler; let started = false;
  try {
    started = true; await docker('up', '-d', '--build');
    const port = (await docker('port', 'api', '3000')).match(/:(\d+)$/);
    if (!port) throw Error('Cannot determine API port');
    const base = `http://127.0.0.1:${port[1]}`;
    async function sample() {
      try {
        const response = await fetch(`${base}/metrics`, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw Error(`metrics ${response.status}`);
        const text = await response.text();
        const sample = { queued: gauge(text, /queue_jobs\{state="queued"\} ([0-9.]+)/), running: gauge(text, /queue_jobs\{state="running"\} ([0-9.]+)/) };
        if (Object.values(sample).some(value => value === null)) throw Error('missing metrics');
        samples.push(sample); record('sample', sample);
      } catch (error) { summary.errors.push(`sample: ${error}`); record('sample_error', { error: String(error) }); }
    }
    sampler = (async () => { while (!stopSampling) { await sample(); await sleep(5000); } })();
    const start = performance.now();
    const total = seconds * rate;
    for (let i = 0; i < total; i++) {
      const delay = start + i * 1000 / rate - performance.now();
      if (delay > 0) await sleep(delay);
      if (pending.size >= 1000) { dropped++; record('dropped', { index: i, reason: 'in-flight limit' }); continue; }
      const pick = random(); const chosen = ids.length ? ids[Math.floor(random() * ids.length)] : null;
      const operation = !chosen || pick < 0.7 ? 'create' : pick < 0.9 ? 'get' : 'cancel';
      const url = operation === 'create' ? `${base}/jobs` : `${base}/jobs/${chosen}${operation === 'cancel' ? '/cancel' : ''}`;
      const opts = operation === 'create' ? { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `${run}-${i}` }, body: JSON.stringify({ name: `load-${i}`, model: 'gpt2-small', params: { epochs: 1, batchSize: 1, learningRate: 0.01, durationMs: 20 } }) } : { method: operation === 'get' ? 'GET' : 'POST' };
      sent++; const requestStart = performance.now();
      const task = (async () => {
        try {
          const response = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
          const body = await response.text(); const latencyMs = performance.now() - requestStart;
          latencies.push(latencyMs); record('request', { index: i, operation, status: response.status, latencyMs, body });
          if (operation === 'create' && response.status === 201) ids.push(JSON.parse(body).id);
          if ((operation === 'create' && response.status === 201) || (operation === 'get' && response.status === 200) || (operation === 'cancel' && [200,409].includes(response.status))) succeeded++;
          else summary.errors.push(`${operation} ${i}: HTTP ${response.status}`);
        } catch (error) { record('request_error', { index: i, operation, error: String(error) }); summary.errors.push(`${operation} ${i}: ${error}`); }
      })();
      pending.add(task); task.finally(() => pending.delete(task));
    }
    const sendingSeconds = (performance.now() - start) / 1000;
    await Promise.all([...pending]);
    await sample();
    const atEnd = samples.at(-1);
    const drainStart = performance.now();
    while (performance.now() - drainStart < 120000) {
      await sample(); const current = samples.at(-1);
      if (current && current.queued === 0 && current.running === 0) break;
      await sleep(2000);
    }
    const final = samples.at(-1);
    const sorted = latencies.sort((a, b) => a - b);
    summary.results = { plannedRequests: total, sent, succeeded, dropped, sendingSeconds, actualRps: sent / sendingSeconds, p50Ms: percentile(sorted, 0.5), p99Ms: percentile(sorted, 0.99), atEnd, final, drainSeconds: (performance.now() - drainStart) / 1000, sampleCount: samples.length };
    summary.checks = { allRequestsCompleted: sent === total && succeeded === total && dropped === 0, p99Under200ms: summary.results.p99Ms !== null && summary.results.p99Ms < 200, reachedTargetRps: summary.results.actualRps >= rate * 0.99, queueDrained: !!final && final.queued === 0 && final.running === 0, noErrors: summary.errors.length === 0 };
    summary.status = Object.values(summary.checks).every(Boolean) ? 'requires_review' : 'failed';
    summary.manualReview = 'Review latency distribution and queue drain against the project target before a ship verdict.';
  } catch (error) { summary.errors.push(String(error)); record('run_error', { error: String(error) }); }
  finally {
    stopSampling = true; if (sampler) await sampler;
    if (started) {
      try { await saveComposeLogs(); } catch (error) { summary.errors.push(`logs: ${error}`); }
      try { await docker('down', '--remove-orphans'); } catch (error) { summary.errors.push(`cleanup: ${error}`); }
    }
    if (summary.errors.length) summary.status = 'failed'; summary.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' }); record('summary', summary);
    await new Promise(resolve => raw.end(resolve)); console.log(JSON.stringify(summary, null, 2));
    if (summary.status === 'failed') process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
