type Fields = Record<string, string | number | boolean | null>;
export function log(level: 'info' | 'warn' | 'error', component: string, event: string, fields: Fields = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, component, event, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
