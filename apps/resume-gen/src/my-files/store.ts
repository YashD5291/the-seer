import type { Stats } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { isRecord } from '../json-validation';
import { failureReason, fileProblem, hasErrnoCode, ProfileError } from '../setup-error';
import { ExtractError, extractText, type FileKind, fileKind } from './extract';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_PROFILE_CHARS = 300_000;
// Claude Code gets the documents as a command-line argument, and macOS caps those (with the environment) at 1 MiB.
export const MAX_PROFILE_BYTES = 600_000;

const TAG = '[theseer-pdf]';
const CACHE_DIR = '.seer';
const MAX_NAME_CHARS = 120;
const LARGEST_FILES_SHOWN = 3;
const NO_READABLE_FILES = "No readable files in My files — open The Seer's setup page and add your resume";

export interface MyFile {
  name: string;
  kind: FileKind | 'other';
  words: number;
  status: 'read' | 'no-text' | 'unsupported' | 'too-big';
  modified: string; // YYYY-MM-DD, local time
}

export interface SourceDocument {
  name: string;
  modified: string;
  text: string;
}

// text is '' unless the file's status is 'read'.
interface LoadedFile {
  file: MyFile;
  text: string;
}

interface Candidate {
  name: string;
  stats: Stats;
}

// Extracted text, reused while the file keeps the same size and modification time.
interface CacheEntry {
  size: number;
  mtimeMs: number;
  text: string;
}

// The files, and why readDocuments would fail on them (null when it would not).
export interface MyFilesReport {
  files: MyFile[];
  problem: string | null;
}

export async function listMyFiles(profileDir: string): Promise<MyFile[]> {
  return (await loadFiles(profileDir)).map(({ file }) => file);
}

// One read of the folder answers both, so the setup page can show what would stop a resume.
export async function inspectMyFiles(profileDir: string): Promise<MyFilesReport> {
  const loaded = await loadFiles(profileDir);
  return { files: loaded.map(({ file }) => file), problem: profileProblem(readableOf(loaded)) };
}

// lastModifiedMs is the dropped file's own date, so `modified` says when the user last changed it, not when it
// was dropped.
export async function addMyFile(
  profileDir: string,
  name: string,
  bytes: Uint8Array,
  lastModifiedMs?: number,
): Promise<MyFile> {
  const safeName = safeFileName(name);
  if (safeName === '') {
    throw new ProfileError(`Can't add a file named ${JSON.stringify(name)} — rename it and add it again`);
  }
  assertFileWithinLimit(safeName, bytes.byteLength);
  await attempt('create', profileDir, () => mkdir(profileDir, { recursive: true }));
  const storedName = await saveWithUniqueName(profileDir, safeName, bytes);
  await keepFileDate(join(profileDir, storedName), lastModifiedMs);
  const stats = await attempt('read', join(profileDir, storedName), () => stat(join(profileDir, storedName)));
  return (await loadFile(profileDir, { name: storedName, stats })).file;
}

// The one size limit for a file added to My files; `name` is the file's name in the message.
export function assertFileWithinLimit(name: string, byteLength: number): void {
  if (byteLength > MAX_FILE_BYTES) {
    throw new ProfileError(`${name} is over ${MAX_FILE_BYTES / (1024 * 1024)} MB — add a smaller file`);
  }
}

export async function removeMyFile(profileDir: string, name: string): Promise<MyFile[]> {
  const candidates = await listCandidates(profileDir);
  if (!candidates.some((candidate) => candidate.name === name)) {
    throw new ProfileError(`No file named ${JSON.stringify(name)} in My files`);
  }
  const cache = cachePath(profileDir, name);
  await attempt('remove', cache, () => rm(cache, { force: true }));
  const path = join(profileDir, name);
  await attempt('remove', path, () => unlink(path));
  return listMyFiles(profileDir);
}

// Every readable file's text, ready for the prompt. Fails when there is nothing to read or too much of it.
export async function readDocuments(profileDir: string): Promise<SourceDocument[]> {
  const readable = readableOf(await loadFiles(profileDir));
  const problem = profileProblem(readable);
  if (problem !== null) throw new ProfileError(problem);
  return readable.map(({ file, text }) => ({ name: file.name, modified: file.modified, text }));
}

function readableOf(files: LoadedFile[]): LoadedFile[] {
  return files.filter(({ file }) => file.status === 'read');
}

// A name that stays inside My files: no folders, no control characters, no leading dots or whitespace of any
// kind (a no-break space before a dot would otherwise leave a hidden file). '' means nothing usable is left.
export function safeFileName(name: string): string {
  const afterLastSeparator = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  const cleaned = afterLastSeparator.replace(/\p{Cc}/gu, '').replace(/^[.\s]+/u, '').trim();
  return capLength(cleaned);
}

// Counted in characters (not UTF-16 units) so an emoji is never cut in half; the extension survives.
function capLength(name: string): string {
  const characters = Array.from(name);
  if (characters.length <= MAX_NAME_CHARS) return name;
  const extension = Array.from(extname(name));
  if (extension.length >= MAX_NAME_CHARS) return characters.slice(0, MAX_NAME_CHARS).join('');
  const stem = characters.slice(0, characters.length - extension.length);
  return stem.slice(0, MAX_NAME_CHARS - extension.length).join('') + extension.join('');
}

// "My CV.pdf" -> "My CV (2).pdf"
function numbered(name: string, copy: number): string {
  const extension = extname(name);
  return `${name.slice(0, name.length - extension.length)} (${copy})${extension}`;
}

async function saveWithUniqueName(profileDir: string, safeName: string, bytes: Uint8Array): Promise<string> {
  for (let copy = 1; ; copy++) {
    const name = copy === 1 ? safeName : numbered(safeName, copy);
    if (await createIfNew(join(profileDir, name), bytes)) return name;
  }
}

// The 'wx' flag fails when the name is taken, even by a dangling link, so nothing is overwritten
// and nothing is written through a link.
async function createIfNew(path: string, bytes: Uint8Array): Promise<boolean> {
  try {
    await writeFile(path, bytes, { flag: 'wx' });
    return true;
  } catch (error) {
    if (hasErrnoCode(error, 'EEXIST')) return false;
    throw fileProblem('save', path, error);
  }
}

// A date that is missing or makes no sense leaves the copy dated now. The file is already saved, so a date
// that cannot be set is logged, not fatal.
async function keepFileDate(path: string, lastModifiedMs: number | undefined): Promise<void> {
  if (lastModifiedMs === undefined || !Number.isFinite(lastModifiedMs) || lastModifiedMs <= 0) return;
  const date = new Date(lastModifiedMs);
  try {
    await utimes(path, date, date);
  } catch (error) {
    console.error(`${TAG} Couldn't keep the file date of ${basename(path)}: ${failureReason(error)}`);
  }
}

async function loadFiles(profileDir: string): Promise<LoadedFile[]> {
  const loaded: LoadedFile[] = [];
  for (const candidate of await listCandidates(profileDir)) {
    loaded.push(await loadFile(profileDir, candidate));
  }
  return loaded;
}

// The top-level files of My files, by name. A missing folder is an empty one: nothing has been added yet.
async function listCandidates(profileDir: string): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const name of await listEntryNames(profileDir)) {
    if (name.startsWith('.')) continue;
    const stats = await statEntry(profileDir, name);
    if (stats?.isFile()) candidates.push({ name, stats });
  }
  return candidates.sort((a, b) => compareNames(a.name, b.name));
}

async function listEntryNames(profileDir: string): Promise<string[]> {
  try {
    return await readdir(profileDir);
  } catch (error) {
    if (hasErrnoCode(error, 'ENOENT')) return [];
    throw fileProblem('read', profileDir, error);
  }
}

// stat follows links, so a linked file counts as a file; a link to nothing is skipped.
async function statEntry(profileDir: string, name: string): Promise<Stats | null> {
  const path = join(profileDir, name);
  try {
    return await stat(path);
  } catch (error) {
    if (!hasErrnoCode(error, 'ENOENT')) throw fileProblem('read', path, error);
    console.error(`${TAG} Skipping ${name}: it is a link to a file that is gone`);
    return null;
  }
}

function compareNames(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

async function loadFile(profileDir: string, { name, stats }: Candidate): Promise<LoadedFile> {
  const modified = localDate(stats.mtime);
  const kind = fileKind(name);
  if (stats.size > MAX_FILE_BYTES) return unread({ name, kind: kind ?? 'other', status: 'too-big', modified });
  if (kind === null) return unread({ name, kind: 'other', status: 'unsupported', modified });

  const text = await extractCached(profileDir, name, kind, stats);
  if (text.trim() === '') return unread({ name, kind, status: 'no-text', modified });
  return { file: { name, kind, words: countWords(text), status: 'read', modified }, text };
}

function unread(file: Omit<MyFile, 'words'>): LoadedFile {
  return { file: { ...file, words: 0 }, text: '' };
}

// A file the tools cannot read counts as having no text; the reason is logged, not cached.
async function extractCached(profileDir: string, name: string, kind: FileKind, stats: Stats): Promise<string> {
  const cache = cachePath(profileDir, name);
  const cached = await readCache(cache, stats);
  if (cached !== null) return cached;
  const text = await extractOrLog(join(profileDir, name), kind);
  if (text === null) return '';
  await writeCache(cache, stats, text);
  return text;
}

async function extractOrLog(path: string, kind: FileKind): Promise<string | null> {
  try {
    return await extractText(path, kind);
  } catch (error) {
    if (!(error instanceof ExtractError)) throw error;
    console.error(`${TAG} ${error.message}`);
    return null;
  }
}

function cachePath(profileDir: string, name: string): string {
  return join(profileDir, CACHE_DIR, `${name}.json`);
}

async function readCache(path: string, stats: Stats): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (!hasErrnoCode(error, 'ENOENT')) console.error(`${TAG} Ignoring cache ${path}: ${failureReason(error)}`);
    return null;
  }
  const entry = parseCacheEntry(raw);
  return entry !== null && entry.size === stats.size && entry.mtimeMs === stats.mtimeMs ? entry.text : null;
}

// The cache is ours to rewrite, so a file that is not valid JSON or has another shape is just a miss.
function parseCacheEntry(raw: string): CacheEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  return isCacheEntry(value) ? value : null;
}

function isCacheEntry(value: unknown): value is CacheEntry {
  return (
    isRecord(value) &&
    typeof value.size === 'number' &&
    typeof value.mtimeMs === 'number' &&
    typeof value.text === 'string'
  );
}

// The cache only saves time, so a folder that cannot hold it must not stop the listing.
async function writeCache(path: string, stats: Stats, text: string): Promise<void> {
  const entry: CacheEntry = { size: stats.size, mtimeMs: stats.mtimeMs, text };
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(entry));
  } catch (error) {
    console.error(`${TAG} Couldn't cache ${basename(path)}: ${failureReason(error)}`);
  }
}

// Nothing to read, or more text than Claude Code can be given; null when the readable files are fine.
function profileProblem(readable: LoadedFile[]): string | null {
  if (readable.length === 0) return NO_READABLE_FILES;
  const chars = readable.reduce((sum, { text }) => sum + text.length, 0);
  if (chars > MAX_PROFILE_CHARS) {
    return (
      `Your files hold ${formatCount(chars)} characters of text, over the ${formatCount(MAX_PROFILE_CHARS)} limit` +
      ` — remove or shorten some in My files. Largest: ${largestFiles(readable, (text) => text.length)}`
    );
  }
  const bytes = readable.reduce((sum, { text }) => sum + utf8Bytes(text), 0);
  if (bytes > MAX_PROFILE_BYTES) {
    return (
      `Your files' text takes ${formatCount(bytes)} bytes, over the ${formatCount(MAX_PROFILE_BYTES)}-byte limit` +
      ' (letters outside English take 2–4 bytes each) — remove or shorten some in My files.' +
      ` Largest: ${largestFiles(readable, utf8Bytes)}`
    );
  }
  return null;
}

// "big.md (40,000 words), mid.md (20,000 words)", the largest first by `size`.
function largestFiles(files: LoadedFile[], size: (text: string) => number): string {
  return [...files]
    .sort((a, b) => size(b.text) - size(a.text))
    .slice(0, LARGEST_FILES_SHOWN)
    .map(({ file }) => `${file.name} (${formatCount(file.words)} ${file.words === 1 ? 'word' : 'words'})`)
    .join(', ');
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}

function countWords(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

function localDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

async function attempt<T>(action: string, path: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw fileProblem(action, path, error);
  }
}
