const { Client } = require('pg');
const Redis = require('ioredis');

test('connects to Postgres and Redis', async () => {
  const postgres = new Client({ connectionString: process.env.DATABASE_URL });
  const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  try {
    await postgres.connect();
    expect((await postgres.query('SELECT 1 AS value')).rows[0].value).toBe(1);
    await redis.connect();
    expect(await redis.ping()).toBe('PONG');
  } finally {
    await postgres.end();
    redis.disconnect();
  }
});
