import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allGreen, checkRows, CLAUDE_INSTALL_COMMAND, INSTALL_COMMAND } from './checks.ts';
import type { CheckRow } from './checks.ts';
import { HELPER_MISSING, HelperError } from '../shared/helper-client.ts';
import type { ClaudeProblem, HelperStatus } from '../shared/helper-types.ts';

const VERSION = '1.0.0';

const STATUS: HelperStatus = {
  version: VERSION,
  claude: { path: '/Users/alex/.local/bin/claude', loggedIn: true, plan: 'max', problem: null },
  tectonic: { path: '/Users/alex/.theseer/bin/tectonic' },
  template: { path: '/Users/alex/.theseer/templates/default.tex' },
  profileDir: '/Users/alex/TheSeer/My files',
  outputDir: '/Users/alex/TheSeer/Resumes',
  files: [{ name: 'resume.pdf', kind: 'pdf', words: 412, status: 'read', modified: '2026-10-23' }],
  profileProblem: null,
};

function withClaude(problem: ClaudeProblem, path: string | null = STATUS.claude.path): HelperStatus {
  return { ...STATUS, claude: { path, loggedIn: problem === null, plan: problem === null ? 'max' : null, problem } };
}

function rowsFor(status: HelperStatus): CheckRow[] {
  return checkRows({ status, helperError: null, extensionVersion: VERSION });
}

function row(rows: CheckRow[], id: CheckRow['id']): CheckRow {
  const found = rows.find((r) => r.id === id);
  return found ?? assert.fail(`no ${id} row`);
}

describe('install commands', () => {
  it('INSTALL_COMMAND downloads install.sh from the latest release of this repo', () => {
    // Tests run without esbuild's define, so the repo is the placeholder.
    assert.equal(INSTALL_COMMAND, 'curl -fsSL https://github.com/OWNER/REPO/releases/latest/download/install.sh | bash');
  });

  it("CLAUDE_INSTALL_COMMAND is Claude Code's official macOS install command", () => {
    assert.equal(CLAUDE_INSTALL_COMMAND, 'curl -fsSL https://claude.ai/install.sh | bash');
  });
});

describe('checkRows', () => {
  it('always returns helper, claude, login, pdf in that order with their labels', () => {
    const inputs = [
      { status: STATUS, helperError: null, extensionVersion: VERSION },
      { status: null, helperError: new HelperError(HELPER_MISSING, { notInstalled: true }), extensionVersion: VERSION },
      { status: withClaude('not-installed', null), helperError: null, extensionVersion: '2.0.0' },
    ];
    for (const input of inputs) {
      const rows = checkRows(input);
      assert.deepEqual(
        rows.map((r) => [r.id, r.label]),
        [
          ['helper', 'Helper connected'],
          ['claude', 'Claude Code installed'],
          ['login', 'Signed in with your Claude subscription'],
          ['pdf', 'PDF builder ready'],
        ],
      );
    }
  });

  it('everything present → four green rows with nothing to fix', () => {
    const rows = rowsFor(STATUS);
    assert.deepEqual(rows.map((r) => r.ok), [true, true, true, true]);
    for (const r of rows) {
      assert.equal(r.problem, undefined);
      assert.equal(r.fix, undefined);
    }
    assert.equal(allGreen(rows), true);
  });

  it('helper missing → red helper row with the install command; the rest wait for the helper', () => {
    const rows = checkRows({
      status: null,
      helperError: new HelperError(HELPER_MISSING, { notInstalled: true }),
      extensionVersion: VERSION,
    });
    const helper = row(rows, 'helper');
    assert.equal(helper.ok, false);
    assert.equal(helper.fix, INSTALL_COMMAND);
    assert.ok(helper.problem, 'the helper row says what is wrong');
    for (const id of ['claude', 'login', 'pdf'] as const) {
      assert.equal(row(rows, id).ok, false);
      assert.equal(row(rows, id).problem, 'Waiting for the helper');
    }
    assert.equal(allGreen(rows), false);
  });

  it('helper that answers with an error → red helper row showing that error and the install command', () => {
    const error = new HelperError('Unexpected reply from the helper to "status" — it may be out of date; run the install command from the setup page again.');
    const rows = checkRows({ status: null, helperError: error, extensionVersion: VERSION });
    const helper = row(rows, 'helper');
    assert.equal(helper.ok, false);
    assert.equal(helper.problem, error.message);
    assert.equal(helper.fix, INSTALL_COMMAND);
    assert.equal(row(rows, 'claude').problem, 'Waiting for the helper');
  });

  it('helper that cannot read its settings → red helper row with its error and its own fix, not the update hint', () => {
    const error = new HelperError('Config file is not valid JSON: /Users/alex/.theseer/config.json (Unexpected end)', {
      needsSetup: true,
      details: 'Fix or delete ~/.theseer/config.json, then re-run the install command',
    });
    const helper = row(checkRows({ status: null, helperError: error, extensionVersion: VERSION }), 'helper');
    assert.equal(helper.ok, false);
    assert.equal(helper.problem, error.message);
    assert.equal(helper.hint, 'Fix or delete ~/.theseer/config.json, then re-run the install command');
    assert.equal(helper.fix, INSTALL_COMMAND);
  });

  it('helper error without its own fix → the update hint', () => {
    const helper = row(
      checkRows({ status: null, helperError: new HelperError('The helper did not answer: boom'), extensionVersion: VERSION }),
      'helper',
    );
    assert.equal(helper.hint, 'Re-run the install command to update the helper, then click Check again.');
  });

  it('no status and no error yet → red helper row, the rest wait for the helper', () => {
    const rows = checkRows({ status: null, helperError: null, extensionVersion: VERSION });
    assert.equal(row(rows, 'helper').ok, false);
    assert.equal(row(rows, 'pdf').problem, 'Waiting for the helper');
  });

  it('helper 0.9.0 with extension 1.0.0 → red helper row naming both versions, telling to re-install and reload', () => {
    const rows = checkRows({ status: { ...STATUS, version: '0.9.0' }, helperError: null, extensionVersion: '1.0.0' });
    const helper = row(rows, 'helper');
    assert.equal(helper.ok, false);
    assert.match(helper.problem ?? '', /0\.9\.0/);
    assert.match(helper.problem ?? '', /1\.0\.0/);
    assert.match(helper.hint ?? '', /re-run the install command/i);
    assert.match(helper.hint ?? '', /reload The Seer in chrome:\/\/extensions/);
    assert.equal(helper.fix, INSTALL_COMMAND);
    assert.equal(allGreen(rows), false);
  });

  it('a version mismatch still reports the other checks from the status', () => {
    const rows = checkRows({ status: { ...STATUS, version: '1.1.0' }, helperError: null, extensionVersion: '1.0.0' });
    assert.deepEqual(rows.map((r) => r.ok), [false, true, true, true]);
  });

  it('Claude Code not installed → red claude row with its install command; login row red', () => {
    const rows = rowsFor(withClaude('not-installed', null));
    const claude = row(rows, 'claude');
    assert.equal(claude.ok, false);
    assert.equal(claude.fix, CLAUDE_INSTALL_COMMAND);
    assert.ok(claude.problem);
    assert.equal(row(rows, 'login').ok, false);
    assert.equal(row(rows, 'helper').ok, true);
    assert.equal(row(rows, 'pdf').ok, true);
  });

  it('not signed in → claude row green, login row red with the /login hint', () => {
    const rows = rowsFor(withClaude('not-logged-in'));
    assert.equal(row(rows, 'claude').ok, true);
    const login = row(rows, 'login');
    assert.equal(login.ok, false);
    assert.ok(login.problem);
    assert.equal(login.hint, 'Open Terminal, run claude, then type /login');
  });

  it('signed in with an API key or cloud provider → login row says only the subscription is used', () => {
    const login = row(rowsFor(withClaude('not-subscription')), 'login');
    assert.equal(login.ok, false);
    assert.match(login.problem ?? '', /The Seer only uses your Claude subscription, not an API key/);
  });

  describe('Claude Code that cannot be asked for its status', () => {
    function unreadable(detail?: string): HelperStatus {
      const claude = { path: STATUS.claude.path, loggedIn: false, plan: null, problem: 'unreadable' as const };
      return { ...STATUS, claude: detail === undefined ? claude : { ...claude, detail } };
    }

    it('turns the claude row red with the reason, the reinstall command and a hint to run claude', () => {
      const claude = row(rowsFor(unreadable('Claude Code login check timed out after 10 s')), 'claude');
      assert.equal(claude.ok, false);
      assert.equal(claude.problem, "Couldn't get Claude Code's status: Claude Code login check timed out after 10 s");
      assert.equal(claude.fix, CLAUDE_INSTALL_COMMAND);
      assert.equal(claude.hint, "Open Terminal and run claude. If it doesn't start, reinstall Claude Code.");
    });

    it('leaves out the reason when the helper gave none', () => {
      const claude = row(rowsFor(unreadable()), 'claude');
      assert.equal(claude.problem, "Couldn't get Claude Code's status");
    });

    it('turns the login row red, waiting for Claude Code', () => {
      const login = row(rowsFor(unreadable('timed out')), 'login');
      assert.equal(login.ok, false);
      assert.equal(login.problem, 'Waiting for Claude Code');
      assert.equal(login.fix, undefined);
    });

    it('leaves the helper and PDF builder rows alone', () => {
      const rows = rowsFor(unreadable('timed out'));
      assert.deepEqual(rows.map((r) => r.ok), [true, false, false, true]);
      assert.equal(allGreen(rows), false);
    });
  });

  it('no PDF builder → red pdf row with the install command', () => {
    const pdf = row(rowsFor({ ...STATUS, tectonic: { path: null } }), 'pdf');
    assert.equal(pdf.ok, false);
    assert.equal(pdf.problem, 'The PDF builder is missing');
    assert.equal(pdf.fix, INSTALL_COMMAND);
  });

  it('no resume template → red pdf row naming the template, with the install command', () => {
    const pdf = row(rowsFor({ ...STATUS, template: { path: null } }), 'pdf');
    assert.equal(pdf.ok, false);
    assert.equal(pdf.problem, "The PDF builder's resume template is missing");
    assert.equal(pdf.fix, INSTALL_COMMAND);
    assert.equal(pdf.hint, 'Re-run the install command, then click Check again.');
  });
});

describe('allGreen', () => {
  it('is false as soon as one row is red', () => {
    const rows = rowsFor({ ...STATUS, tectonic: { path: null } });
    assert.equal(allGreen(rows), false);
  });
});
