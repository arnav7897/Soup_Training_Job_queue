#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const batch = `batch-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
const directory = path.join(root, 'runs', batch);
fs.mkdirSync(directory, { recursive: true });
const results = [];
for (let seed = 1; seed <= 10; seed++) {
  console.log(`Starting full chaos run ${seed}/10`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'chaos.cjs')], { cwd: root, env: { ...process.env, CHAOS_RUN_ROOT: directory, CHAOS_SEED: String(seed), CHAOS_JOBS: '10000', CHAOS_WORKERS: '8', CHAOS_KILLS: '0' }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  fs.writeFileSync(path.join(directory, `seed-${seed}.stdout.log`), result.stdout || '', { flag: 'wx' });
  fs.writeFileSync(path.join(directory, `seed-${seed}.stderr.log`), result.stderr || '', { flag: 'wx' });
  results.push({ seed, exitCode: result.status, error: result.error ? String(result.error) : null });
  console.log(`Finished seed ${seed}: exit ${result.status}`);
}
fs.writeFileSync(path.join(directory, 'batch-summary.json'), JSON.stringify({ batch, results }, null, 2) + '\n', { flag: 'wx' });
console.log(`Evidence: ${directory}`);
if (results.some(result => result.exitCode !== 0)) process.exitCode = 1;
