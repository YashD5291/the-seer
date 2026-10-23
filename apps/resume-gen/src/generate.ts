import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { cancelledError, ClaudeRunError, type Effort } from './claude-runner';
import { CompileError, compileLatex, type CompileOptions, type CompileResult } from './compile';
import { CONFIG_FIX, ConfigError } from './config';
import { type FitResult, fitToPages } from './fit';
import { readPreamble, renderResumeLatex } from './latex';
import { parseLegacyMarkdown } from './legacy-markdown';
import { isPathInside, nextFreeFolder, safeFolderName, uploadPdfName } from './output';
import type { Profile } from './profile';
import { extractResumeDoc, type ResumeDoc, ResumeFormatError, resumePlainText } from './resume-doc';
import { sortExperienceNewestFirst } from './resume-order';
import {
  buildScoreRequest,
  type FitAnalysis,
  type FitJob,
  type FitResult as JobFit, // ./fit's FitResult is the page fit
  ScoreFormatError,
} from './scorer/request';
import { hasErrnoCode, SetupError } from './setup-error';
import { withTempDir } from './temp-dir';
import { buildWriterRequest, type WriterJob, type WriterRequest } from './writer/request';

export type BuildStage = 'compiling' | 'fitting';
export type WriteStage = 'checking-login' | 'scoring' | 'writing' | BuildStage;

export interface BuildOptions {
  outputBase: string;
  templatePath: string;
  tectonicPath: string; // absolute: Chrome starts the host with a minimal PATH
  maxPages: number;
  folderNameOverride?: string; // the CLI's --name, used instead of "<Company> - <Role>"
  onStage?: (stage: BuildStage) => void;
  signal?: AbortSignal; // aborting stops the build before it creates the job folder
}

export interface GenerateResult {
  success: true;
  folderName: string;
  folderPath: string;
  texPath: string;
  pdfPath: string;
  uploadPdfPath: string;
  pages: number;
  fits: boolean;
  trimmedBullets: number;
  latexSource: string;
  pdfBase64: string;
  pdfSizeBytes: number;
  resumeText: string;
  keywords: string[];
}

// `details` is left out rather than null: the extension rejects a details that is not a string.
// `needsSetup` is set when the setup page can fix the problem; the extension then offers "Open setup".
export type NativeError = { type: 'error'; error: string; details?: string; needsSetup?: true };

// `score` is sent once the job is scored; `skipped` (score below the threshold), `result` and
// `error` end the job.
export type HostMessage =
  | { type: 'progress'; stage: WriteStage }
  | { type: 'score'; analysis: FitAnalysis; job: FitJob }
  | { type: 'skipped'; score: number; threshold: number }
  | ({ type: 'result' } & GenerateResult)
  | NativeError;

export interface WriteRequest {
  command: 'write';
  job: WriterJob;
  model: string;
  effort: Effort;
  maxPages: number;
  scoreModel: string;
  scoreEffort: Effort;
  minScore: number; // whole number 0 to 100; the resume is written only at a fit score this high or higher
  writerNotes?: string; // the person's extra instructions for the writer, up to MAX_WRITER_NOTES characters
}

export interface WriteDeps {
  loadProfile: () => Promise<Profile>;
  checkLogin: () => Promise<void>;
  runScorer: (request: WriterRequest) => Promise<{ value: JobFit }>;
  runWriter: (request: WriterRequest) => Promise<{ doc: ResumeDoc }>;
  build: (doc: ResumeDoc, onStage: (stage: BuildStage) => void) => Promise<GenerateResult>;
}

export interface RecompileRequest {
  texSource: string;
  texPath: string;
  folderPath: string;
  uploadPdfPath?: string;
}

export interface RecompileResult {
  success: true;
  pdfBase64: string;
  pdfSizeBytes: number;
  pages: number;
}

type Compiler = {
  compiled: (doc: ResumeDoc) => Promise<CompileResult>;
  measure: (doc: ResumeDoc) => Promise<number>;
};

const TAG = '[theseer-pdf]';
const WORK_DIR_PREFIX = 'theseer-compile-';
const LEGACY_MARKER = 'TAILORED RESUME';
const REFUSAL = 'Refusing to write outside the output folder';
// The extension panel shows details as-is; the first LaTeX errors are the useful ones.
const MAX_DETAIL_LINES = 40;
const MAX_DETAIL_CHARS = 4_000;
const UNKNOWN_ERROR = 'Unknown error in the helper';
// The scorer asks for 10 to 20 keywords; this caps what reaches the writer if it returns more.
const MAX_SCREENING_TERMS = 25;

// ---------------------------------------------------------------------------
// Build: doc → LaTeX → PDF, fitted to the page budget, written to a new job folder
// ---------------------------------------------------------------------------

export async function buildResume(doc: ResumeDoc, opts: BuildOptions): Promise<GenerateResult> {
  throwIfCancelled(opts.signal);
  // Before the fit, which cuts bullets from the last (oldest) role first.
  const ordered = sortExperienceNewestFirst(doc);
  const preamble = readPreamble(opts.templatePath);
  return withTempDir(WORK_DIR_PREFIX, async (workDir) => {
    const compiler = cachedCompiler(preamble, { tectonicPath: opts.tectonicPath, workDir });
    opts.onStage?.('compiling');
    await timed('compile', () => compiler.measure(ordered), pageCount);
    opts.onStage?.('fitting');
    const fit = await timed('fit', () => fitToPages(ordered, opts.maxPages, compiler.measure), fitSummary);
    const { pdf } = await compiler.compiled(fit.doc);
    // The folder is the first thing a build leaves behind, so a job cancelled during the compile stops here.
    throwIfCancelled(opts.signal);
    return writeJobFiles(fit, renderResumeLatex(fit.doc, preamble), pdf, opts);
  });
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledError();
}

// fitToPages measures the untrimmed doc again, so results are kept per doc: no doc compiles twice.
function cachedCompiler(preamble: string, compile: CompileOptions): Compiler {
  const results = new Map<string, Promise<CompileResult>>();
  const compiled = (doc: ResumeDoc): Promise<CompileResult> => {
    const key = JSON.stringify(doc);
    const cached = results.get(key);
    if (cached) return cached;
    const result = compileLatex(renderResumeLatex(doc, preamble), compile);
    results.set(key, result);
    return result;
  };
  return { compiled, measure: async (doc) => (await compiled(doc)).pages };
}

async function writeJobFiles(
  fit: FitResult,
  latexSource: string,
  pdf: Uint8Array,
  opts: BuildOptions,
): Promise<GenerateResult> {
  const { doc } = fit;
  const name =
    opts.folderNameOverride === undefined
      ? safeFolderName(doc.target.company, doc.target.role)
      : safeFolderName(opts.folderNameOverride, '');
  const folderPath = createJobFolder(opts.outputBase, name);
  const folderName = basename(folderPath);
  const texPath = join(folderPath, `${folderName}.tex`);
  const pdfPath = join(folderPath, `${folderName}.pdf`);
  const uploadPdfPath = join(folderPath, uploadPdfName(doc.name));

  await writeFile(texPath, latexSource, 'utf-8');
  await writeFile(pdfPath, pdf);
  await writeFile(uploadPdfPath, pdf);

  return {
    success: true,
    folderName,
    folderPath,
    texPath,
    pdfPath,
    uploadPdfPath,
    pages: fit.pages,
    fits: fit.fits,
    trimmedBullets: fit.removed,
    latexSource,
    pdfBase64: Buffer.from(pdf).toString('base64'),
    pdfSizeBytes: pdf.byteLength,
    resumeText: resumePlainText(doc),
    keywords: doc.keywords,
  };
}

// nextFreeFolder asks whether each candidate is taken; creating it (not recursively) answers
// atomically, so two jobs for the same role can never share a folder.
function createJobFolder(outputBase: string, name: string): string {
  mkdirSync(outputBase, { recursive: true });
  return nextFreeFolder(outputBase, name, (candidate) => !createdNew(candidate));
}

function createdNew(path: string): boolean {
  try {
    mkdirSync(path);
    return true;
  } catch (error) {
    if (hasErrnoCode(error, 'EEXIST')) return false;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Generate: a pasted or legacy reply → build
// ---------------------------------------------------------------------------

export async function generateResume(
  responseText: string,
  opts: BuildOptions & { fallbackTitle: string | null },
): Promise<GenerateResult> {
  const { fallbackTitle, ...build } = opts;
  return buildResume(parseReply(responseText, fallbackTitle), build);
}

function parseReply(text: string, fallbackTitle: string | null): ResumeDoc {
  try {
    return extractResumeDoc(text);
  } catch (error) {
    const legacy = error instanceof ResumeFormatError && error.kind === 'missing' && text.includes(LEGACY_MARKER);
    if (!legacy) throw error;
    return parseLegacyMarkdown(text, fallbackTitle);
  }
}

// ---------------------------------------------------------------------------
// Write: profile → Claude Code → build, reported as progress messages
// ---------------------------------------------------------------------------

// Sends progress for each stage and the score once known, then exactly one skipped, result or
// error. A score below the threshold ends the job before the writer runs. Never throws for a
// pipeline failure; only a failing `send` escapes.
export async function writeResume(
  req: WriteRequest,
  deps: WriteDeps,
  send: (message: HostMessage) => void,
): Promise<void> {
  try {
    const profile = await deps.loadProfile();
    send(progress('checking-login'));
    await timed('login check', deps.checkLogin);
    send(progress('scoring'));
    const fit = await scoreJob(profile, req.job, deps);
    send(scoreMessage(fit));
    if (fit.fit_score < req.minScore) {
      send({ type: 'skipped', score: fit.fit_score, threshold: req.minScore });
      return;
    }
    send(progress('writing'));
    const request = buildWriterRequest({
      profile,
      job: req.job,
      maxPages: req.maxPages,
      writerNotes: req.writerNotes,
      screeningTerms: screeningTerms(fit.ats_keywords),
    });
    const { doc } = await timed('writing', () => deps.runWriter(request));
    const result = await deps.build(doc, (stage) => send(progress(stage)));
    send({ type: 'result', ...result });
  } catch (error) {
    send(toNativeError(error));
  }
}

function progress(stage: WriteStage): HostMessage {
  return { type: 'progress', stage };
}

async function scoreJob(profile: Profile, job: WriterJob, deps: WriteDeps): Promise<JobFit> {
  const request = buildScoreRequest({ profile, job });
  const { value } = await timed('scoring', () => deps.runScorer(request), (run) => `fit ${run.value.fit_score}`);
  return value;
}

function scoreMessage(fit: JobFit): HostMessage {
  const { job, ...analysis } = fit;
  return { type: 'score', analysis, job };
}

// The scorer's keywords, trimmed, without empty or repeated ones, at most MAX_SCREENING_TERMS of them.
function screeningTerms(keywords: string[]): string[] {
  const terms = new Set(keywords.map((keyword) => keyword.trim()).filter((keyword) => keyword !== ''));
  return [...terms].slice(0, MAX_SCREENING_TERMS);
}

// ---------------------------------------------------------------------------
// Recompile: the editor's edited LaTeX → PDF, in place
// ---------------------------------------------------------------------------

// The .tex and PDFs are written only after a successful compile, so they always match.
export async function recompileTex(
  req: RecompileRequest,
  opts: { outputBase: string; tectonicPath: string },
): Promise<RecompileResult> {
  const targets = recompileTargets(req, opts.outputBase);
  return withTempDir(WORK_DIR_PREFIX, async (workDir) => {
    const compile = { tectonicPath: opts.tectonicPath, workDir };
    const { pdf, pages } = await timed('compile', () => compileLatex(req.texSource, compile), (r) => pageCount(r.pages));
    await writeFile(targets.texPath, req.texSource, 'utf-8');
    await writeFile(targets.pdfPath, pdf);
    if (targets.uploadPdfPath !== undefined) await writeFile(targets.uploadPdfPath, pdf);
    return { success: true, pdfBase64: Buffer.from(pdf).toString('base64'), pdfSizeBytes: pdf.byteLength, pages };
  });
}

// The request comes from an extension page, so every path it names is checked before use.
function recompileTargets(
  req: RecompileRequest,
  outputBase: string,
): { texPath: string; pdfPath: string; uploadPdfPath?: string } {
  const folderPath = resolve(req.folderPath);
  const texPath = resolve(req.texPath);
  const uploadPdfPath = req.uploadPdfPath === undefined ? undefined : resolve(req.uploadPdfPath);
  const texAllowed = isPathInside(texPath, outputBase) && texPath.endsWith('.tex') && dirname(texPath) === folderPath;
  const uploadAllowed =
    uploadPdfPath === undefined || (uploadPdfPath.endsWith('.pdf') && dirname(uploadPdfPath) === folderPath);
  if (!texAllowed || !uploadAllowed) throw new Error(REFUSAL);
  return { texPath, pdfPath: `${texPath.slice(0, -'.tex'.length)}.pdf`, uploadPdfPath };
}

// ---------------------------------------------------------------------------
// Errors and logs
// ---------------------------------------------------------------------------

export function toNativeError(err: unknown): NativeError {
  const error = errorText(err);
  const details = errorDetails(err);
  const setup = needsSetup(err) ? { needsSetup: true as const } : {};
  if (!details || details === error) return { type: 'error', error, ...setup };
  return { type: 'error', error, details: capDetails(details), ...setup };
}

function needsSetup(err: unknown): boolean {
  if (err instanceof SetupError) return true;
  return err instanceof ClaudeRunError && (err.kind === 'not-installed' || err.kind === 'not-logged-in');
}

function capDetails(details: string): string {
  return details.length > MAX_DETAIL_CHARS ? `${details.slice(0, MAX_DETAIL_CHARS)}…` : details;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message.trim() || UNKNOWN_ERROR;
  if (typeof err === 'string' && err.trim() !== '') return err.trim();
  return UNKNOWN_ERROR;
}

function errorDetails(err: unknown): string | undefined {
  if (err instanceof ConfigError) return CONFIG_FIX;
  if (err instanceof ResumeFormatError || err instanceof ScoreFormatError) return err.problems.join('\n');
  if (err instanceof CompileError) return err.excerpt.split('\n').slice(0, MAX_DETAIL_LINES).join('\n');
  return undefined;
}

// One stderr line per stage: stdout is the native-messaging channel.
async function timed<T>(label: string, run: () => Promise<T>, summary?: (value: T) => string): Promise<T> {
  const started = Date.now();
  const value = await run();
  const extra = summary ? ` (${summary(value)})` : '';
  console.error(`${TAG} ${label}: ${Date.now() - started} ms${extra}`);
  return value;
}

// "1 page", "2 pages"
export function pageCount(pages: number): string {
  return pages === 1 ? '1 page' : `${pages} pages`;
}

function fitSummary(fit: FitResult): string {
  const trimmed = fit.removed === 1 ? '1 bullet' : `${fit.removed} bullets`;
  return `${pageCount(fit.pages)}, ${fit.fits ? 'fits' : 'does not fit'}, ${trimmed} trimmed`;
}
