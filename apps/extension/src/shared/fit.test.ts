import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_MIN_SCORE, scorePasses } from './fit.ts';

describe('DEFAULT_MIN_SCORE', () => {
  it('is 40: the fit bar until the user sets another', () => {
    assert.equal(DEFAULT_MIN_SCORE, 40);
  });
});

describe('scorePasses', () => {
  it('passes a score equal to the bar', () => {
    assert.equal(scorePasses(40, 40), true);
  });

  it('fails a score just below the bar', () => {
    assert.equal(scorePasses(39, 40), false);
  });

  it('passes a score above the bar', () => {
    assert.equal(scorePasses(41, 40), true);
  });

  it('follows the bar it is given', () => {
    assert.equal(scorePasses(60, 70), false);
    assert.equal(scorePasses(70, 70), true);
  });

  it('passes everything at a bar of 0', () => {
    assert.equal(scorePasses(0, 0), true);
  });
});
