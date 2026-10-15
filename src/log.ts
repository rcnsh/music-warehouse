/**
 * Structured logging. Each line is one JSON object, `{ event, level, ...fields }`,
 * which Workers Logs indexes field by field, so `event = "poll"` or
 * `level = "error"` can be filtered on directly.
 */

type Level = 'info' | 'warn' | 'error';

/** Errors do not survive JSON serialisation; flatten them to plain fields. */
function plain(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

export function log(event: string, fields: Record<string, unknown> = {}, level: Level = 'info'): void {
  const entry: Record<string, unknown> = { event, level };
  for (const [key, value] of Object.entries(fields)) entry[key] = plain(value);
  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.log(entry);
}
