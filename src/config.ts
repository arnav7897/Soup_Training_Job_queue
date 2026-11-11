import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  DATABASE_URL: z.string().url(),
  LEASE_MS: z.coerce.number().int().min(300).max(3600000).default(9000),
});

export function loadConfig(env: NodeJS.ProcessEnv) {
  return schema.parse(env);
}
