/** Type guards for untrusted values: replies from the helper and messages from Chrome. */

export type UnknownRecord = Record<string, unknown>;

/** A plain JSON object: not null, not an array. */
export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return allowed.some((item) => item === value);
}
