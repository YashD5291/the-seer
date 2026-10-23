import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeHtml } from './html.ts';

describe('escapeHtml', () => {
  it('escapes markup, ampersands and both quote kinds', () => {
    assert.equal(
      escapeHtml('<img src=x onerror="a">&\''),
      '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;',
    );
  });

  it('escapes an ampersand once, not again inside the entities it adds', () => {
    assert.equal(escapeHtml('a & <b>'), 'a &amp; &lt;b&gt;');
  });

  it('leaves plain text unchanged', () => {
    assert.equal(escapeHtml('Senior ML Engineer @ Acme, Remote (US)'), 'Senior ML Engineer @ Acme, Remote (US)');
  });

  it('returns an empty string for an empty string', () => {
    assert.equal(escapeHtml(''), '');
  });

  it('keeps an attribute value inside its quotes', () => {
    const attack = '" onmouseover="alert(1)';
    assert.equal(escapeHtml(attack).includes('"'), false);
  });
});
