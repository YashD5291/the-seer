import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type ExecFailure, execFileAsync, isExecFailure } from './exec';

const TEX_FILE = 'resume.tex';
const PDF_FILE = 'resume.pdf';
const LOG_FILE = 'resume.log';
// A cold compile fetches the TeX files one by one (about two minutes on a typical connection), and the first
// real resume is cold when the install's warm-up failed or was skipped. A warm compile takes a few seconds.
export const COMPILE_TIMEOUT_MS = 5 * 60_000;
const SYSTEM_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
const TAIL_LINES = 30;
// Context lines TeX prints after a "!" error: the source line and where it stopped.
const ERROR_CONTEXT_LINES = 2;
// Matches "Output written on resume.xdv (2 pages, 41532 bytes)." and the one-page form.
const PAGE_COUNT_LINE = /Output written on \S+ \((\d+) pages?,/;

// timeoutMs: how long tectonic may run (default COMPILE_TIMEOUT_MS).
export type CompileOptions = { tectonicPath: string; workDir: string; timeoutMs?: number };
export type CompileResult = { pdf: Uint8Array; pages: number };

// excerpt is the part of the compiler output worth showing the user.
export class CompileError extends Error {
  readonly excerpt: string;

  constructor(message: string, excerpt: string = message) {
    super(message);
    this.name = 'CompileError';
    this.excerpt = excerpt;
  }
}

// The PDF is object-stream compressed, so its pages cannot be counted from the bytes.
export function parsePageCount(log: string): number | null {
  const match = PAGE_COUNT_LINE.exec(log);
  return match ? Number(match[1]) : null;
}

export async function compileLatex(
  tex: string,
  { tectonicPath, workDir, timeoutMs = COMPILE_TIMEOUT_MS }: CompileOptions,
): Promise<CompileResult> {
  await writeFile(join(workDir, TEX_FILE), tex, 'utf-8');
  // A log from an earlier compile must not pass for this one's when tectonic dies before writing its own.
  await rm(join(workDir, LOG_FILE), { force: true });
  await runTectonic(tectonicPath, workDir, timeoutMs);

  const log = await readLog(workDir);
  const pages = parsePageCount(log);
  if (pages === null) {
    throw new CompileError('tectonic finished without reporting a page count', lastLines(log));
  }
  return { pdf: await readFile(join(workDir, PDF_FILE)), pages };
}

async function runTectonic(tectonicPath: string, workDir: string, timeoutMs: number): Promise<void> {
  try {
    await execFileAsync(tectonicPath, ['--keep-logs', '--outdir', workDir, TEX_FILE], {
      cwd: workDir,
      timeout: timeoutMs,
      env: { ...process.env, PATH: `${dirname(tectonicPath)}:${SYSTEM_PATH}` },
    });
  } catch (error) {
    if (!isExecFailure(error)) throw error;
    throw await compileFailure(error, tectonicPath, workDir, timeoutMs);
  }
}

async function compileFailure(
  error: ExecFailure,
  tectonicPath: string,
  workDir: string,
  timeoutMs: number,
): Promise<CompileError> {
  if (error.code === 'ENOENT') return new CompileError(`tectonic not found at ${tectonicPath}`);
  const log = await readLog(workDir);
  const excerpt = errorBlocks(log) || lastLines(error.stderr ?? '') || error.message;
  return new CompileError(failureMessage(error, timeoutMs), excerpt);
}

function failureMessage(error: ExecFailure, timeoutMs: number): string {
  return error.killed
    ? `tectonic timed out after ${timeoutMs / 1000}s`
    : 'tectonic failed to compile the resume';
}

async function readLog(workDir: string): Promise<string> {
  const path = join(workDir, LOG_FILE);
  return existsSync(path) ? readFile(path, 'utf-8') : '';
}

// Each line TeX flags with "!" plus the lines that locate it.
function errorBlocks(log: string): string {
  const lines = log.trimEnd().split('\n');
  return lines
    .flatMap((line, index) =>
      line.startsWith('!') ? [lines.slice(index, index + 1 + ERROR_CONTEXT_LINES).join('\n')] : [],
    )
    .join('\n');
}

function lastLines(text: string): string {
  return text.trimEnd().split('\n').slice(-TAIL_LINES).join('\n');
}
