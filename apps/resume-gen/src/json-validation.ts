// Checks for untrusted JSON: Claude's replies and messages from Chrome. The require* checks add a
// problem naming the field (`path`) instead of throwing, so one pass reports every problem.

export type JsonObject = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Anything that is not an object reads as {}, so its fields are reported as missing.
export function asRecord(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

// A string with more than whitespace in it.
export function requireText(value: unknown, path: string, problems: string[]): void {
  if (value !== undefined && typeof value !== 'string') {
    problems.push(`${path} must be a string`);
  } else if (!value?.trim()) {
    problems.push(`${path} is required`);
  }
}

export function requireString(value: unknown, path: string, problems: string[]): void {
  if (typeof value !== 'string') problems.push(`${path} must be a string`);
}

export function optionalString(value: unknown, path: string, problems: string[]): void {
  if (value !== undefined) requireString(value, path, problems);
}

export function requireStringArray(value: unknown, path: string, problems: string[]): void {
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === 'string')) {
    problems.push(`${path} must be an array of strings`);
  }
}

// Claude sometimes writes "key": null for an absent optional key, so null counts as absent: those keys are deleted.
export function omitNullOptionals(entry: JsonObject, keys: readonly string[]): void {
  for (const key of keys) if (entry[key] === null) delete entry[key];
}
