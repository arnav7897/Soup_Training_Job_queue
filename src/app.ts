import Fastify from 'fastify';
import { Pool } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

const bodySchema = z.object({ name: z.string().trim().min(1).max(100), model: z.enum(['resnet50', 'bert-base', 'gpt2-small', 'custom']), params: z.object({ epochs: z.number().int().min(1).max(10000), batchSize: z.number().int().min(1).max(4096), learningRate: z.number().gt(0).max(1), durationMs: z.number().int().min(0).max(60000) }).strict() }).strict();
const idSchema = z.string().uuid();
const keySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const listSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), status: z.enum(['queued','running','succeeded','failed','cancelled']).optional(), cursor: z.string().optional() }).strict();
const columns = `id, name, model, params, status, attempts, max_attempts, lease_epoch, version, created_at, updated_at, finished_at`;
const cursorTime = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time`;
function error(code: string, message: string, details: unknown = null) { return { error: { code, message, details } }; }

export function buildApp(pool: Pool) {
  const app = Fastify({ logger: true, bodyLimit: 16384 });
  app.setErrorHandler((err, _req, reply) => {
    const e = err as Error & { statusCode?: number };
    const status = e.statusCode && e.statusCode >= 400 && e.statusCode < 500 ? e.statusCode : 500;
    return reply.code(status).send(error(status === 500 ? 'INTERNAL' : 'VALIDATION', status === 500 ? 'Internal server error' : e.message));
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.post('/jobs', async (req, reply) => {
    const body = bodySchema.safeParse(req.body);
    const key = keySchema.safeParse(req.headers['idempotency-key']);
    if (!body.success || !key.success) return reply.code(400).send(error('VALIDATION', 'Invalid job or idempotency key'));
    const canonical = JSON.stringify([body.data.name, body.data.model, body.data.params.epochs, body.data.params.batchSize, body.data.params.learningRate, body.data.params.durationMs]);
    const hash = createHash('sha256').update(canonical).digest('hex');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(`INSERT INTO jobs(id,idempotency_key,request_hash,name,model,params) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(idempotency_key) DO NOTHING RETURNING ${columns}`, [randomUUID(), key.data, hash, body.data.name, body.data.model, JSON.stringify(body.data.params)]);
      if (inserted.rowCount) {
        const job = inserted.rows[0];
        await client.query('INSERT INTO outbox(type,job_id,payload) VALUES($1,$2,$3)', ['job.queued', job.id, JSON.stringify({ jobId: job.id, status: job.status, version: job.version })]);
        await client.query('COMMIT');
        return reply.code(201).send(job);
      }
      const existing = await client.query(`SELECT ${columns}, request_hash FROM jobs WHERE idempotency_key=$1`, [key.data]);
      await client.query('COMMIT');
      const { request_hash, ...job } = existing.rows[0];
      if (request_hash !== hash) return reply.code(422).send(error('KEY_REUSED', 'Idempotency key was used with a different request'));
      return reply.header('Idempotent-Replayed', 'true').code(200).send(job);
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  });
  app.get('/jobs/:id', async (req, reply) => {
    const id = idSchema.safeParse((req.params as { id: string }).id);
    if (!id.success) return reply.code(400).send(error('VALIDATION', 'Invalid job ID'));
    const result = await pool.query(`SELECT ${columns} FROM jobs WHERE id=$1`, [id.data]);
    return result.rowCount ? result.rows[0] : reply.code(404).send(error('NOT_FOUND', 'Job not found'));
  });
  app.get('/jobs', async (req, reply) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send(error('VALIDATION', 'Invalid query'));
    let cursor: { time: string; id: string } | null = null;
    if (parsed.data.cursor) {
      try {
        const token = parsed.data.cursor;
        if (!/^[A-Za-z0-9_-]+$/.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token) throw new Error();
        const value: unknown = JSON.parse(Buffer.from(token, 'base64url').toString());
        cursor = z.object({ time: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/).refine(v => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 19) === v.slice(0, 19)), id: idSchema }).strict().parse(value);
      } catch { return reply.code(400).send(error('VALIDATION', 'Invalid cursor')); }
    }
    const result = await pool.query(`SELECT ${columns}, ${cursorTime} FROM jobs WHERE ($1::text IS NULL OR status=$1) AND ($2::timestamptz IS NULL OR (created_at,id) > ($2::timestamptz,$3::uuid)) ORDER BY created_at,id LIMIT $4`, [parsed.data.status ?? null, cursor?.time ?? null, cursor?.id ?? null, parsed.data.limit + 1]);
    const hasMore = result.rows.length > parsed.data.limit;
    const rows = result.rows.slice(0, parsed.data.limit);
    const last = rows.at(-1);
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ time: last.cursor_time, id: last.id })).toString('base64url') : null;
    return { jobs: rows.map(row => { const job = { ...row }; delete job.cursor_time; return job; }), nextCursor };
  });
  app.post('/jobs/:id/cancel', async (req, reply) => {
    const id = idSchema.safeParse((req.params as { id: string }).id);
    if (!id.success) return reply.code(400).send(error('VALIDATION', 'Invalid job ID'));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`UPDATE jobs SET status='cancelled', lease_epoch=lease_epoch+1, version=version+1, updated_at=now(), finished_at=now() WHERE id=$1 AND status IN ('queued','running') RETURNING ${columns}`, [id.data]);
      if (result.rowCount) {
        const job = result.rows[0];
        await client.query('INSERT INTO outbox(type,job_id,payload) VALUES($1,$2,$3)', ['job.cancelled', job.id, JSON.stringify({ jobId: job.id, status: job.status, version: job.version })]);
        await client.query('COMMIT');
        return job;
      }
      const existing = await client.query(`SELECT ${columns} FROM jobs WHERE id=$1`, [id.data]);
      await client.query('COMMIT');
      if (!existing.rowCount) return reply.code(404).send(error('NOT_FOUND', 'Job not found'));
      if (existing.rows[0].status === 'cancelled') return existing.rows[0];
      return reply.code(409).send(error('ILLEGAL_TRANSITION', 'Job is already terminal'));
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  });
  return app;
}
