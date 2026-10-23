import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { execFileAsync, isExecFailure, oneLine } from '../exec';
import { failureReason } from '../setup-error';

export type FileKind = 'pdf' | 'word' | 'text';

// The file could not be read; the message names it and says why.
export class ExtractError extends Error {}

const TEXTUTIL = '/usr/bin/textutil';
const OSASCRIPT = '/usr/bin/osascript';
const TOOL_TIMEOUT_MS = 30_000;
// Node's default of 1 MB would fail a long document; extracted text is capped per profile elsewhere.
const MAX_TOOL_OUTPUT_BYTES = 64 * 1024 * 1024;

const KINDS_BY_EXTENSION: ReadonlyMap<string, FileKind> = new Map([
  ['.pdf', 'pdf'],
  ['.docx', 'word'],
  ['.doc', 'word'],
  ['.rtf', 'word'],
  ['.odt', 'word'],
  ['.txt', 'text'],
  ['.md', 'text'],
]);

// PDFKit hands back '' for a missing, scanned (image-only) or password-protected PDF.
const PDF_TEXT_SCRIPT = `function run(argv) {
  ObjC.import('PDFKit');
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (doc.isNil() || doc.isLocked) return '';
  const text = doc.string;
  return text.isNil() ? '' : ObjC.unwrap(text);
}`;

type ToolOutput = { stdout: string; stderr: string };

export function fileKind(name: string): FileKind | null {
  return KINDS_BY_EXTENSION.get(extname(name).toLowerCase()) ?? null;
}

// Rejects with an ExtractError when the file cannot be read or the tool fails; '' means it holds no text.
export async function extractText(path: string, kind: FileKind, timeoutMs = TOOL_TIMEOUT_MS): Promise<string> {
  const absolute = resolve(path);
  switch (kind) {
    case 'text':
      return readTextFile(absolute);
    case 'word':
      return extractWord(absolute, timeoutMs);
    case 'pdf':
      return extractPdf(absolute, timeoutMs);
  }
}

async function readTextFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new ExtractError(`Can't read ${basename(path)}: ${failureReason(error)}`, { cause: error });
  }
}

async function extractWord(path: string, timeoutMs: number): Promise<string> {
  const args = ['-convert', 'txt', ...inputFormat(path), '-stdout', path];
  const { stdout, stderr } = await runTool(path, TEXTUTIL, args, timeoutMs);
  // textutil reports a file it cannot open on stderr but still exits 0, with nothing on stdout.
  if (stdout.trim() === '' && stderr.trim() !== '') {
    throw new ExtractError(`Can't read ${basename(path)}: textutil: ${oneLine(stderr)}`);
  }
  return stdout.trim();
}

// Told what the file claims to be, textutil refuses a corrupt one (or an Office lock file, ~$name.docx)
// instead of reading its bytes as plain text.
function inputFormat(path: string): string[] {
  return fileKind(path) === 'word' ? ['-format', extname(path).slice(1).toLowerCase()] : [];
}

async function extractPdf(path: string, timeoutMs: number): Promise<string> {
  const args = ['-l', 'JavaScript', '-e', PDF_TEXT_SCRIPT, path];
  const { stdout } = await runTool(path, OSASCRIPT, args, timeoutMs);
  return stdout.trim();
}

async function runTool(file: string, command: string, args: string[], timeoutMs: number): Promise<ToolOutput> {
  try {
    return await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: MAX_TOOL_OUTPUT_BYTES,
      encoding: 'utf8',
    });
  } catch (error) {
    const reason = toolFailure(basename(command), error, timeoutMs);
    throw new ExtractError(`Can't read ${basename(file)}: ${reason}`, { cause: error });
  }
}

function toolFailure(tool: string, error: unknown, timeoutMs: number): string {
  if (!isExecFailure(error)) return String(error);
  if (error.killed) return `${tool} timed out after ${timeoutMs / 1000}s`;
  if (typeof error.code === 'number') return `${tool} exited with code ${error.code}`;
  return `${tool}: ${failureReason(error)}`;
}
