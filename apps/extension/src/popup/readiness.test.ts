import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isReady } from './readiness.ts';
import { HELPER_MISSING, HelperError } from '../shared/helper-client.ts';
import type { HelperStatus, MyFile } from '../shared/helper-types.ts';

const VERSION = '1.0.0';

const READ_FILE: MyFile = { name: 'resume.pdf', kind: 'pdf', words: 412, status: 'read', modified: '2026-10-23', slot: null };

const STATUS: HelperStatus = {
  version: VERSION,
  claude: { path: '/Users/alex/.local/bin/claude', loggedIn: true, plan: 'max', problem: null },
  tectonic: { path: '/Users/alex/.theseer/bin/tectonic' },
  template: { path: '/Users/alex/.theseer/templates/default.tex' },
  profileDir: '/Users/alex/TheSeer/My files',
  outputDir: '/Users/alex/TheSeer/Resumes',
  files: [READ_FILE],
  profileProblem: null,
};

function ready(status: HelperStatus | null, helperError: HelperError | null = null): boolean {
  return isReady({ status, helperError, extensionVersion: VERSION });
}

describe('isReady', () => {
  it('is true when every check is green and a file is read', () => {
    assert.equal(ready(STATUS), true);
  });

  it('is true when only one of several files is read', () => {
    const files: MyFile[] = [{ ...READ_FILE, name: 'scan.pdf', status: 'no-text', words: 0 }, READ_FILE];
    assert.equal(ready({ ...STATUS, files }), true);
  });

  it('is false without any file', () => {
    assert.equal(ready({ ...STATUS, files: [] }), false);
  });

  it('is false when no file can be read', () => {
    const files: MyFile[] = [
      { ...READ_FILE, status: 'no-text', words: 0 },
      { ...READ_FILE, name: 'big.pdf', status: 'too-big' },
      { ...READ_FILE, name: 'photo.png', kind: 'other', status: 'unsupported', words: 0 },
    ];
    assert.equal(ready({ ...STATUS, files }), false);
  });

  it('is false when the helper cannot be reached', () => {
    assert.equal(ready(null, new HelperError(HELPER_MISSING, { notInstalled: true })), false);
    assert.equal(ready(null, new HelperError('The helper did not answer')), false);
  });

  it('is false when the helper and the extension versions differ', () => {
    assert.equal(ready({ ...STATUS, version: '0.9.0' }), false);
  });

  it('is false when Claude Code is missing, signed out, not on a subscription or cannot be asked', () => {
    const problems = ['not-installed', 'not-logged-in', 'not-subscription', 'unreadable'] as const;
    for (const problem of problems) {
      const claude = { path: problem === 'not-installed' ? null : STATUS.claude.path, loggedIn: false, plan: null, problem };
      assert.equal(ready({ ...STATUS, claude }), false, problem);
    }
  });

  it('is false without the PDF builder or its template', () => {
    assert.equal(ready({ ...STATUS, tectonic: { path: null } }), false);
    assert.equal(ready({ ...STATUS, template: { path: null } }), false);
  });

  it('is false when My files has a problem, such as too much text, even with a file read', () => {
    const profileProblem = 'Your files hold 320,004 characters of text, over the 300,000 limit';
    assert.equal(ready({ ...STATUS, profileProblem }), false);
  });
});
