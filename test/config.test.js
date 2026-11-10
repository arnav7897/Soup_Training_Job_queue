const { loadConfig } = require('../dist/config');
test('validates required configuration and defaults', () => {
  expect(loadConfig({ DATABASE_URL: 'postgres://db/test', REDIS_URL: 'redis://redis:6379' }).PORT).toBe(3000);
  expect(() => loadConfig({})).toThrow();
  expect(() => loadConfig({ DATABASE_URL: 'postgres://db/test', REDIS_URL: 'redis://redis:6379', PORT: '0' })).toThrow();
});
