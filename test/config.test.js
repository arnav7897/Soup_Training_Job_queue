const { loadConfig } = require('../dist/config');
test('validates required configuration and defaults', () => {
  expect(loadConfig({ DATABASE_URL: 'postgres://db/test' }).PORT).toBe(3000);
  expect(() => loadConfig({})).toThrow();
  expect(() => loadConfig({ DATABASE_URL: 'postgres://db/test', PORT: '0' })).toThrow();
});
