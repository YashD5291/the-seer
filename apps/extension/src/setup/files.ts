import type { MyFile, MyFileStatus, Slot } from '../shared/helper-types.js';
import { plural } from '../shared/resume-status.js';

/** The file picker's `accept`: the types the helper can read text from. */
export const ACCEPTED_TYPES = '.pdf,.docx,.doc,.rtf,.odt,.txt,.md';

/** The helper refuses bigger files, so the page never sends them. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Why a file over MAX_FILE_BYTES is not sent. */
export const TOO_BIG_TEXT = 'Too big — the limit is 10 MB';

const STATUS_TEXT: Record<Exclude<MyFileStatus, 'read'>, string> = {
  'no-text': 'No readable text — export it as Word or text',
  unsupported: 'Not supported — use PDF, Word, text or Markdown',
  'too-big': TOO_BIG_TEXT,
};

const RESUME_HINT = 'A resume you already use.';

/** The places on the setup page, in the order shown. */
const SLOT_ROWS: readonly { slot: Slot; label: string; hint: string }[] = [
  {
    slot: 'career-story',
    label: 'Career story',
    hint: 'Your work history in your own words — the fullest record of what you did.',
  },
  { slot: 'resume-1', label: 'Base resume 1', hint: RESUME_HINT },
  { slot: 'resume-2', label: 'Base resume 2', hint: RESUME_HINT },
  { slot: 'resume-3', label: 'Base resume 3', hint: RESUME_HINT },
];

/** One place on the setup page and the file that fills it; `null` while it is empty. */
export interface SlotRow {
  slot: Slot;
  label: string;
  hint: string;
  file: MyFile | null;
}

/** One row per place on the setup page, in the order shown, each with the file that fills it. */
export function slotRows(files: MyFile[]): SlotRow[] {
  return SLOT_ROWS.map((row) => ({ ...row, file: files.find((f) => f.slot === row.slot) ?? null }));
}

/** The files that fill no slot. */
export function otherFiles(files: MyFile[]): MyFile[] {
  return files.filter((f) => f.slot === null);
}

/** `files` plus `added`, sorted by name. A file added to a slot takes the place of the one that held it (the helper replaces it). */
export function withFile(files: MyFile[], added: MyFile): MyFile[] {
  const kept = added.slot === null ? files : files.filter((f) => f.slot !== added.slot);
  return [...kept, added].sort((a, b) => a.name.localeCompare(b.name));
}

/** One line under a file's name saying whether Claude gets its text. */
export function fileStatusText(file: MyFile): string {
  if (file.status !== 'read') return STATUS_TEXT[file.status];
  return `Read · ${plural(file.words, 'word')}`;
}

function anyRead(files: MyFile[]): boolean {
  return files.some((file) => file.status === 'read');
}

/** The user may move on once Claude has at least one file it can read and nothing about My files stops a resume. */
export function canLeaveFilesStep(files: MyFile[], profileProblem: string | null): boolean {
  return profileProblem === null && anyRead(files);
}

/**
 * The helper's profile problem (e.g. too much text, naming the largest files) to show under the list.
 * While no file is read, the list or its empty note already says why, so nothing more is shown.
 */
export function profileProblemText(files: MyFile[], profileProblem: string | null): string | undefined {
  return profileProblem !== null && anyRead(files) ? profileProblem : undefined;
}

/** The error line for a folder dropped on the drop zone; only files can be sent to the helper. */
export function folderFailure(name: string): string {
  return `${name}: Folders can't be added — drop the files inside it`;
}

export function isTooBig(bytes: number): boolean {
  return bytes > MAX_FILE_BYTES;
}

function localDate(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The list entry for a dropped file that was too big to send; the helper never saw it, so its kind is unknown. */
export function tooBigFile(file: { name: string; lastModified: number }): MyFile {
  return { name: file.name, kind: 'other', words: 0, status: 'too-big', modified: localDate(file.lastModified), slot: null };
}

/** Bytes read in each step; small enough for `String.fromCharCode`'s argument limit. */
const CHUNK = 0x8000;

/** Base64 of `bytes`, for the helper's `add-file` command. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(start, start + CHUNK));
  }
  return btoa(binary);
}
