import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isHelperStatus, isMyFile, isMyFileList } from './helper-types.ts';

const file = { name: 'resume.pdf', kind: 'pdf', words: 412, status: 'read', modified: '2026-10-23' };

const status = {
  version: '1.0.0',
  claude: { path: '/opt/homebrew/bin/claude', loggedIn: true, plan: 'max', problem: null },
  tectonic: { path: '/Users/alex/.theseer/bin/tectonic' },
  template: { path: '/Users/alex/.theseer/templates/default.tex' },
  profileDir: '/Users/alex/TheSeer/My files',
  outputDir: '/Users/alex/TheSeer/Resumes',
  files: [file],
  profileProblem: null,
};

describe('isMyFile', () => {
  it('accepts every kind and status the helper reports', () => {
    for (const kind of ['pdf', 'word', 'text', 'other']) {
      assert.equal(isMyFile({ ...file, kind }), true, kind);
    }
    for (const fileStatus of ['read', 'no-text', 'unsupported', 'too-big']) {
      assert.equal(isMyFile({ ...file, status: fileStatus }), true, fileStatus);
    }
  });

  it('rejects an unknown kind or status', () => {
    assert.equal(isMyFile({ ...file, kind: 'image' }), false);
    assert.equal(isMyFile({ ...file, status: 'locked' }), false);
  });

  it('rejects a field of the wrong type or a missing field', () => {
    assert.equal(isMyFile({ ...file, name: 7 }), false);
    assert.equal(isMyFile({ ...file, words: '412' }), false);
    assert.equal(isMyFile({ ...file, words: Number.NaN }), false);
    assert.equal(isMyFile({ ...file, modified: undefined }), false);
    const { name: _name, ...withoutName } = file;
    assert.equal(isMyFile(withoutName), false);
  });

  it('rejects values that are not objects', () => {
    for (const value of [null, undefined, 'resume.pdf', 42, [file]]) {
      assert.equal(isMyFile(value), false);
    }
  });
});

describe('isMyFileList', () => {
  it('accepts an empty list and a list of files', () => {
    assert.equal(isMyFileList([]), true);
    assert.equal(isMyFileList([file, file]), true);
  });

  it('rejects a list with a bad entry and values that are not lists', () => {
    assert.equal(isMyFileList([file, { name: 'x' }]), false);
    assert.equal(isMyFileList(file), false);
    assert.equal(isMyFileList(undefined), false);
  });
});

describe('isHelperStatus', () => {
  it('accepts a complete status', () => {
    assert.equal(isHelperStatus(status), true);
  });

  it('accepts a helper that has found nothing yet', () => {
    const empty = {
      version: '1.0.0',
      claude: { path: null, loggedIn: false, plan: null, problem: 'not-installed' },
      tectonic: { path: null },
      template: { path: null },
      profileDir: null,
      outputDir: null,
      files: [],
      profileProblem: "My files folder not set — re-run the install command from The Seer's setup page",
    };
    assert.equal(isHelperStatus(empty), true);
  });

  it('accepts a profile problem as text, and rejects one that is not text', () => {
    const overCap = 'Your files hold 320,004 characters of text, over the 300,000 limit';
    assert.equal(isHelperStatus({ ...status, profileProblem: overCap }), true);
    for (const profileProblem of [5, true, undefined, ['too long']]) {
      assert.equal(isHelperStatus({ ...status, profileProblem }), false, String(profileProblem));
    }
  });

  it('accepts every Claude problem', () => {
    for (const problem of ['not-installed', 'not-logged-in', 'not-subscription', 'unreadable', null]) {
      assert.equal(isHelperStatus({ ...status, claude: { ...status.claude, problem } }), true, String(problem));
    }
  });

  it('accepts a Claude section with a detail, with or without one', () => {
    const unreadable = { path: '/Users/alex/.local/bin/claude', loggedIn: false, plan: null, problem: 'unreadable' };
    assert.equal(isHelperStatus({ ...status, claude: { ...unreadable, detail: 'timed out after 10 s' } }), true);
    assert.equal(isHelperStatus({ ...status, claude: unreadable }), true);
    assert.equal(isHelperStatus({ ...status, claude: { ...unreadable, detail: '' } }), true);
  });

  it('rejects a Claude detail that is not text', () => {
    for (const detail of [5, null, true, ['timed out'], { reason: 'timed out' }]) {
      assert.equal(isHelperStatus({ ...status, claude: { ...status.claude, detail } }), false, String(detail));
    }
  });

  it('rejects an unknown Claude problem', () => {
    assert.equal(isHelperStatus({ ...status, claude: { ...status.claude, problem: 'expired' } }), false);
  });

  it('rejects a status missing a field', () => {
    for (const field of ['version', 'claude', 'tectonic', 'template', 'profileDir', 'outputDir', 'files', 'profileProblem']) {
      const { [field]: _removed, ...rest } = status as Record<string, unknown>;
      assert.equal(isHelperStatus(rest), false, field);
    }
  });

  it('rejects a Claude, PDF-builder or template section with a wrong field', () => {
    assert.equal(isHelperStatus({ ...status, claude: { ...status.claude, loggedIn: 'yes' } }), false);
    assert.equal(isHelperStatus({ ...status, claude: { ...status.claude, path: 5 } }), false);
    assert.equal(isHelperStatus({ ...status, claude: { ...status.claude, plan: undefined } }), false);
    assert.equal(isHelperStatus({ ...status, tectonic: { path: 5 } }), false);
    assert.equal(isHelperStatus({ ...status, tectonic: null }), false);
    assert.equal(isHelperStatus({ ...status, template: { path: 5 } }), false);
    assert.equal(isHelperStatus({ ...status, template: null }), false);
  });

  it('rejects a status whose files are not all files', () => {
    assert.equal(isHelperStatus({ ...status, files: [file, { name: 'x' }] }), false);
  });

  it('rejects values that are not objects', () => {
    for (const value of [null, undefined, 'ok', 1, [status]]) {
      assert.equal(isHelperStatus(value), false);
    }
  });
});
