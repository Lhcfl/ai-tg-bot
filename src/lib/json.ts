import type z from "zod";

export function parseJSONSafe(
  str: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(str) };
  } catch {
    return { ok: false };
  }
}

export function safeJsonParseAsync<T extends z.ZodType>(
  schema: T,
  str: string,
) {
  const parsed = parseJSONSafe(str);
  if (!parsed.ok) {
    return schema.safeParseAsync(undefined);
  }
  return schema.safeParseAsync(parsed.value);
}
