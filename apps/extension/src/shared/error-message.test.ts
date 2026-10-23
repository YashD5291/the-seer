import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { errorMessage } from './error-message.ts';

describe('errorMessage', () => {
  it("is an Error's message", () => {
    assert.equal(errorMessage(new TypeError('boom')), 'boom');
  });

  it('is the text of anything else that was thrown', () => {
    assert.equal(errorMessage('plain text'), 'plain text');
    assert.equal(errorMessage(42), '42');
    assert.equal(errorMessage(undefined), 'undefined');
  });
});
