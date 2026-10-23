import type { MyFile, MyFileStatus } from '../shared/helper-types.js';
import { plural } from '../shared/resume-status.js';

/** The file picker's `accept`: the types the helper can read text from. */
export const ACCEPTED_TYPES = '.pdf,.docx,.doc,.rtf,.odt,.txt,.md';

/** The helper refuses bigger files, so the page never sends them. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

const STATUS_TEXT: Record<Exclude<MyFileStatus, 'read'>, string> = {
  'no-text': 'No readable text — export it as Word or text',
  unsupported: 'Not supported — use PDF, Word, text or Markdown',
  'too-big': 'Too big — the limit is 10 MB',
};

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
  return { name: file.name, kind: 'other', words: 0, status: 'too-big', modified: localDate(file.lastModified) };
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
