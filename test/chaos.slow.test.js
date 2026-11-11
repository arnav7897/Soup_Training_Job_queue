const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

test('chaos smoke: 500 jobs, four workers and three kills', async () => {
  const result = await run(process.execPath, ['scripts/chaos.cjs'], {
    env: { ...process.env, CHAOS_SEED: '2', CHAOS_JOBS: '500', CHAOS_WORKERS: '4', CHAOS_KILLS: '3', CHAOS_TIMEOUT_MS: '180000' },
    timeout: 300000,
    maxBuffer: 1024 * 1024,
  });
  expect(JSON.parse(result.stdout).status).toBe('passed');
}, 300000);
