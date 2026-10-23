import type { HelperError } from '../shared/helper-client.js';
import type { HelperStatus } from '../shared/helper-types.js';
import { SEER_REPO } from '../shared/repo.js';

/** Installs (or updates) the helper and the PDF builder from the latest release. */
export const INSTALL_COMMAND = `curl -fsSL https://github.com/${SEER_REPO}/releases/latest/download/install.sh | bash`;

/** Claude Code's native macOS installer (https://code.claude.com/docs/en/setup). */
export const CLAUDE_INSTALL_COMMAND = 'curl -fsSL https://claude.ai/install.sh | bash';

export type CheckId = 'helper' | 'claude' | 'login' | 'pdf';

export interface CheckRow {
  id: CheckId;
  label: string;
  ok: boolean;
  /** What is wrong, when the row is red. */
  problem?: string;
  /** A command to copy into Terminal that fixes it. */
  fix?: string;
  /** What to do, in words. */
  hint?: string;
}

export interface CheckInput {
  status: HelperStatus | null;
  helperError: HelperError | null;
  /** This extension's `manifest.json` version; the helper must report the same one. */
  extensionVersion: string;
}

const LABELS: Record<CheckId, string> = {
  helper: 'Helper connected',
  claude: 'Claude Code installed',
  login: 'Signed in with your Claude subscription',
  pdf: 'PDF builder ready',
};

const UNREADABLE_HINT = "Open Terminal and run claude. If it doesn't start, reinstall Claude Code.";
const PASTE_HINT = 'Open Terminal, paste this command and press Return. Then click Check again.';
const WAITING_FOR_HELPER = 'Waiting for the helper';

function green(id: CheckId): CheckRow {
  return { id, label: LABELS[id], ok: true };
}

function red(id: CheckId, problem: string, extra: { fix?: string; hint?: string } = {}): CheckRow {
  return { id, label: LABELS[id], ok: false, problem, ...extra };
}

function helperProblem(helperError: HelperError | null): string {
  if (helperError === null) return 'The helper has not answered yet';
  if (helperError.notInstalled) return "The Seer's helper isn't installed on this Mac";
  return helperError.message;
}

/** What to do about a helper that cannot report its status; a helper that said how to fix it (e.g. a broken config.json) is followed. */
function helperHint(helperError: HelperError | null): string {
  if (helperError === null || helperError.notInstalled) return PASTE_HINT;
  return helperError.details ?? 'Re-run the install command to update the helper, then click Check again.';
}

/** Rows when there is no status to read: only the helper row can say anything. */
function withoutHelper(helperError: HelperError | null): CheckRow[] {
  const hint = helperHint(helperError);
  return [
    red('helper', helperProblem(helperError), { fix: INSTALL_COMMAND, hint }),
    red('claude', WAITING_FOR_HELPER),
    red('login', WAITING_FOR_HELPER),
    red('pdf', WAITING_FOR_HELPER),
  ];
}

function helperRow(status: HelperStatus, extensionVersion: string): CheckRow {
  if (status.version === extensionVersion) return green('helper');
  return red('helper', `The helper is version ${status.version}, but The Seer is version ${extensionVersion}.`, {
    fix: INSTALL_COMMAND,
    hint: 'Re-run the install command, then reload The Seer in chrome://extensions.',
  });
}

/** Claude Code is installed and told the helper where it stands; the login row can only judge it then. */
function claudeAnswered(status: HelperStatus): boolean {
  const { path, problem } = status.claude;
  return path !== null && problem !== 'not-installed' && problem !== 'unreadable';
}

function unreadableProblem(detail: string | undefined): string {
  const problem = "Couldn't get Claude Code's status";
  return detail === undefined || detail === '' ? problem : `${problem}: ${detail}`;
}

function claudeRow(status: HelperStatus): CheckRow {
  if (status.claude.problem === 'unreadable') {
    return red('claude', unreadableProblem(status.claude.detail), { fix: CLAUDE_INSTALL_COMMAND, hint: UNREADABLE_HINT });
  }
  if (claudeAnswered(status)) return green('claude');
  return red('claude', "Claude Code isn't installed on this Mac", { fix: CLAUDE_INSTALL_COMMAND, hint: PASTE_HINT });
}

function loginRow(status: HelperStatus): CheckRow {
  if (!claudeAnswered(status)) return red('login', 'Waiting for Claude Code');
  if (status.claude.problem === 'not-subscription') {
    return red(
      'login',
      'Claude Code is signed in with an API key or a cloud provider. The Seer only uses your Claude subscription, not an API key.',
      { hint: 'Open Terminal, run claude, type /login and choose your Claude account.' },
    );
  }
  if (status.claude.problem === 'not-logged-in' || !status.claude.loggedIn) {
    return red('login', "Claude Code isn't signed in", { hint: 'Open Terminal, run claude, then type /login' });
  }
  return green('login');
}

/** The PDF builder needs both the program and the resume template the installer puts next to it. */
function pdfRow(status: HelperStatus): CheckRow {
  if (status.tectonic.path !== null && status.template.path !== null) return green('pdf');
  const problem = status.tectonic.path === null
    ? 'The PDF builder is missing'
    : "The PDF builder's resume template is missing";
  return red('pdf', problem, { fix: INSTALL_COMMAND, hint: 'Re-run the install command, then click Check again.' });
}

/** The setup checks, always in the order helper, claude, login, pdf. */
export function checkRows({ status, helperError, extensionVersion }: CheckInput): CheckRow[] {
  if (status === null) return withoutHelper(helperError);
  return [helperRow(status, extensionVersion), claudeRow(status), loginRow(status), pdfRow(status)];
}

export function allGreen(rows: CheckRow[]): boolean {
  return rows.every((row) => row.ok);
}
