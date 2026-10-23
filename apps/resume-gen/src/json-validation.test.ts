import { describe, expect, it } from 'bun:test';
import {
  asRecord,
  isRecord,
  omitNullOptionals,
  optionalString,
  requireString,
  requireStringArray,
  requireText,
} from './json-validation';

// The problems one check adds for `value`.
function problemsOf(check: (value: unknown, path: string, problems: string[]) => void, value: unknown): string[] {
  const problems: string[] = [];
  check(value, 'field', problems);
  return problems;
}

describe('isRecord and asRecord', () => {
  it('accepts a plain object only', () => {
    expect(isRecord({ a: 1 })).toBe(true);
    for (const value of [null, [], 'text', 1, undefined]) expect(isRecord(value)).toBe(false);
  });

  it('reads anything that is not an object as an empty one', () => {
    const object = { a: 1 };
    expect(asRecord(object)).toBe(object);
    expect(asRecord([1])).toEqual({});
    expect(asRecord(null)).toEqual({});
  });
});

describe('requireText', () => {
  it('accepts a string with text in it', () => {
    expect(problemsOf(requireText, 'Acme')).toEqual([]);
  });

  it('calls a missing or blank string required', () => {
    expect(problemsOf(requireText, undefined)).toEqual(['field is required']);
    expect(problemsOf(requireText, '  ')).toEqual(['field is required']);
  });

  it('calls anything else the wrong type', () => {
    expect(problemsOf(requireText, 3)).toEqual(['field must be a string']);
    expect(problemsOf(requireText, null)).toEqual(['field must be a string']);
  });
});

describe('requireString and optionalString', () => {
  it('accepts any string, even an empty one', () => {
    expect(problemsOf(requireString, '')).toEqual([]);
    expect(problemsOf(optionalString, '')).toEqual([]);
  });

  it('requires a string unless it is optional and left out', () => {
    expect(problemsOf(requireString, undefined)).toEqual(['field must be a string']);
    expect(problemsOf(optionalString, undefined)).toEqual([]);
    expect(problemsOf(optionalString, 1)).toEqual(['field must be a string']);
  });
});

describe('requireStringArray', () => {
  it('accepts an array of strings, an empty one included', () => {
    expect(problemsOf(requireStringArray, ['a', 'b'])).toEqual([]);
    expect(problemsOf(requireStringArray, [])).toEqual([]);
  });

  it('refuses anything else', () => {
    expect(problemsOf(requireStringArray, ['a', 1])).toEqual(['field must be an array of strings']);
    expect(problemsOf(requireStringArray, 'a')).toEqual(['field must be an array of strings']);
  });
});

describe('omitNullOptionals', () => {
  it('deletes the named keys that are null and nothing else', () => {
    const entry: Record<string, unknown> = { link: null, name: null, location: 'Remote' };

    omitNullOptionals(entry, ['link', 'location', 'absent']);

    expect(entry).toEqual({ name: null, location: 'Remote' });
  });
});
