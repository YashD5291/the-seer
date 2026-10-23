import { isOneOf, isRecord } from './guards.js';

/** What the local helper (`com.theseer.resumegen`) reports in reply to the one-shot setup commands. */

export type MyFileKind = 'pdf' | 'word' | 'text' | 'other';

/** `read`: its text reaches Claude. The others never do: no text in it, a type the helper cannot read, or over the size limit. */
export type MyFileStatus = 'read' | 'no-text' | 'unsupported' | 'too-big';

/** The places a file can fill on the setup page: the career story, or one of three base resumes. */
export type Slot = 'career-story' | 'resume-1' | 'resume-2' | 'resume-3';

/** One file in the user's "My files" folder. */
export interface MyFile {
  name: string;
  kind: MyFileKind;
  /** Words in the extracted text; 0 when none could be read. */
  words: number;
  status: MyFileStatus;
  /** Last change, `YYYY-MM-DD`. */
  modified: string;
  /** The place it fills; `null` for any other file. */
  slot: Slot | null;
}

/** Why Claude Code cannot be used; `null` when it can. `unreadable`: it is there, but did not say (see `detail`). */
export type ClaudeProblem = 'not-installed' | 'not-logged-in' | 'not-subscription' | 'unreadable' | null;

export interface HelperStatus {
  /** The helper's version; the extension's `manifest.json` version must match it. */
  version: string;
  claude: {
    path: string | null;
    loggedIn: boolean;
    plan: string | null;
    problem: ClaudeProblem;
    /** Why Claude Code could not be asked, on one line; only with `problem: 'unreadable'`. */
    detail?: string;
  };
  tectonic: { path: string | null };
  /** The resume template the PDF builder needs; `null` when it is missing. */
  template: { path: string | null };
  /** The "My files" folder; `null` until the helper has set one up. */
  profileDir: string | null;
  /** Where finished resumes are saved. */
  outputDir: string | null;
  files: MyFile[];
  /** Why no resume can be written from My files (e.g. over the text limit, naming the largest files); `null` when nothing stops it. */
  profileProblem: string | null;
}

const FILE_KINDS: readonly MyFileKind[] = ['pdf', 'word', 'text', 'other'];
const FILE_STATUSES: readonly MyFileStatus[] = ['read', 'no-text', 'unsupported', 'too-big'];
const SLOTS: readonly Slot[] = ['career-story', 'resume-1', 'resume-2', 'resume-3'];
const CLAUDE_PROBLEMS: readonly string[] = ['not-installed', 'not-logged-in', 'not-subscription', 'unreadable'];

function isStringOrNull(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

export function isMyFile(value: unknown): value is MyFile {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    isOneOf(value.kind, FILE_KINDS) &&
    typeof value.words === 'number' &&
    Number.isFinite(value.words) &&
    isOneOf(value.status, FILE_STATUSES) &&
    typeof value.modified === 'string' &&
    (value.slot === null || isOneOf(value.slot, SLOTS))
  );
}

export function isMyFileList(value: unknown): value is MyFile[] {
  return Array.isArray(value) && value.every(isMyFile);
}

/** `{ path: string | null }`, as the PDF builder and template sections are. */
function isPathSection(value: unknown): boolean {
  return isRecord(value) && isStringOrNull(value.path);
}

function isClaudeSection(value: unknown): boolean {
  return (
    isRecord(value) &&
    isStringOrNull(value.path) &&
    typeof value.loggedIn === 'boolean' &&
    isStringOrNull(value.plan) &&
    (value.problem === null || isOneOf(value.problem, CLAUDE_PROBLEMS)) &&
    (value.detail === undefined || typeof value.detail === 'string')
  );
}

export function isHelperStatus(value: unknown): value is HelperStatus {
  return (
    isRecord(value) &&
    typeof value.version === 'string' &&
    isClaudeSection(value.claude) &&
    isPathSection(value.tectonic) &&
    isPathSection(value.template) &&
    isStringOrNull(value.profileDir) &&
    isStringOrNull(value.outputDir) &&
    isMyFileList(value.files) &&
    isStringOrNull(value.profileProblem)
  );
}
