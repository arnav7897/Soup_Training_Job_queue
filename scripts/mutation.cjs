#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const run = `mutation-${new Date().toISOString().replace(/[:.]/g, '-')}-${require('node:crypto').randomBytes(3).toString('hex')}`;
const evidence = path.join(root, 'runs', run);
fs.mkdirSync(evidence, { recursive: true });
const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'soup-mutation-'));
const excluded = new Set(['.git', 'node_modules', 'dist', 'runs', 'coverage']);
let outcome = { run, status: 'failed', mutation: 'Remove the epoch comparison from completion only; owner, status, expiry, and unique-effect protections remain.', error: null };
try {
  fs.cpSync(root, copy, { recursive: true, filter: source => !excluded.has(path.basename(source)) });
  const file = path.join(copy, 'src', 'queue.ts');
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf('export async function complete');
  const end = source.indexOf('export async function reap', start);
  if (start < 0 || end < 0) throw Error('Could not locate completion implementation');
  const section = source.slice(start, end);
  const changed = section.replace('AND lease_epoch=$2', 'AND $2::integer IS NOT NULL');
  if (section === changed) throw Error('Could not locate completion epoch predicate');
  fs.writeFileSync(file, source.slice(0, start) + changed + source.slice(end));
  fs.writeFileSync(path.join(evidence, 'mutated-queue.ts'), fs.readFileSync(file));
  const runRoot = path.join(evidence, 'runs');
  const result = spawnSync(process.execPath, [path.join(copy, 'scripts', 'chaos.cjs')], { cwd: copy, env: { ...process.env, CHAOS_RUN_ROOT: runRoot }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(path.join(evidence, 'stdout.log'), result.stdout || '');
  fs.writeFileSync(path.join(evidence, 'stderr.log'), result.stderr || '');
  const dirs = fs.existsSync(runRoot) ? fs.readdirSync(runRoot) : [];
  const summaryPath = dirs.length === 1 ? path.join(runRoot, dirs[0], 'summary.json') : '';
  const resultSummary = summaryPath && fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, 'utf8')) : null;
  outcome.harnessExit = result.status;
  outcome.harnessSummary = resultSummary;
  const checks = resultSummary?.checks || {};
  const invariantFailed = ['all_created_and_acknowledged', 'all_terminal', 'effects_match_states', 'legal_transitions', 'acknowledged_cancels_hold', 'stale_epoch_fenced'].some(key => checks[key] === false);
  outcome.status = invariantFailed ? 'mutation_detected' : resultSummary?.status === 'passed' ? 'mutation_survived' : 'inconclusive';
} catch (error) { outcome.error = String(error); }
finally {
  fs.writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify(outcome, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(outcome, null, 2));
  if (outcome.status !== 'mutation_detected') process.exitCode = 1;
}
