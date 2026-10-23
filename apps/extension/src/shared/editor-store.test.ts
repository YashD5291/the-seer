import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EDITOR_JOB_PARAM, EDITOR_JOBS_KEY, editorPagePath, editorPayloadKey } from './editor-store.ts';

describe('editor store', () => {
  it('keys each job’s resume apart from the job list', () => {
    assert.equal(editorPayloadKey('abc'), 'seer_editor_abc');
    assert.notEqual(editorPayloadKey('abc'), EDITOR_JOBS_KEY);
  });

  it('names the job in the editor page’s query, so the page can read it back', () => {
    const path = editorPagePath('a b&c');
    assert.equal(path, 'editor.html?job=a%20b%26c');
    assert.equal(new URLSearchParams(path.split('?')[1]).get(EDITOR_JOB_PARAM), 'a b&c');
  });
});
