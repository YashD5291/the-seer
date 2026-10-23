import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isOneOf, isRecord } from './guards.ts';

describe('isRecord', () => {
  it('accepts a plain object', () => {
    assert.equal(isRecord({ a: 1 }), true);
  });

  it('refuses null, arrays and primitives', () => {
    for (const value of [null, [], 'text', 1, undefined]) assert.equal(isRecord(value), false);
  });
});

describe('isOneOf', () => {
  it('accepts an allowed value and refuses anything else', () => {
    const sizes = ['small', 'large'] as const;
    assert.equal(isOneOf('small', sizes), true);
    assert.equal(isOneOf('medium', sizes), false);
    assert.equal(isOneOf(undefined, sizes), false);
  });
});
