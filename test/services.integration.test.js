const { Client } = require('pg');

test('connects to PostgreSQL', async () => {
  const postgres = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await postgres.connect();
    expect((await postgres.query('SELECT 1 AS value')).rows[0].value).toBe(1);
  } finally {
    await postgres.end();
  }
});
