const { buildApp } = require('../dist/app');

test('health remains live while metrics report database failure', async () => {
  const app = buildApp({ query: async () => { throw new Error('database offline'); } });
  try {
    expect((await app.inject({ url: '/health' })).json()).toEqual({ status: 'ok' });
    const response = await app.inject({ url: '/metrics' });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('UNAVAILABLE');
  } finally { await app.close(); }
});
