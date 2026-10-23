#!/usr/bin/env bun
/**
 * The Seer — resume host, compiled to ~/.theseer/bin/theseer-pdf.
 *
 * Modes:
 *   1. Write:       theseer-pdf --write <job.txt>     Claude Code scores the job, writes the resume if it fits, then PDF
 *      Score:       theseer-pdf --score <job.txt>     Claude Code scores the job; prints the score JSON
 *   2. Generate:    theseer-pdf <reply-file>          a saved reply (resume JSON or old markdown) to PDF
 *   3. Native host: theseer-pdf --native-host         Chrome native messaging (write / recompile / generate)
 *   4. Setup:       theseer-pdf --setup [--no-warm-up], --set-output <dir>, --set-profile <dir>
 *      Version:     theseer-pdf --version             prints the helper version (the extension manifest's)
 *
 * In native-host mode stdout carries only framed messages; every log goes to stderr.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { configPathFor, type HostContext, loadConfig, updateConfig } from './src/config';
import {
  type GenerateResult,
  generateResume,
  type HostMessage,
  pageCount,
  toNativeError,
  writeResume,
} from './src/generate';
import {
  buildOptions,
  DEFAULT_MAX_PAGES,
  DEFAULT_MIN_SCORE,
  DEFAULT_SCORE_EFFORT,
  DEFAULT_SCORE_MODEL,
  hostHandlers,
  parseMaxPages,
  parseScoreRequest,
  parseWriteRequest,
  runNativeHost,
  scoreOnce,
  writeDeps,
} from './src/native';
import { loadProfile } from './src/profile';
import type { FitAnalysis } from './src/scorer/request';
import type { WriterJob } from './src/writer/request';
import { runSetup } from './src/setup';
import { HELPER_VERSION } from './src/version';

const TAG = '[theseer-pdf]';
// The CLI's defaults match the extension's: Opus at medium effort; the page budget and scoring defaults are the host's.
const DEFAULT_MODEL = 'opus';
const DEFAULT_EFFORT = 'medium';
const NO_REPLY = 'No reply to read — pass a reply file or pipe the reply on stdin';
// Flags that take a value; that value is never the reply file.
const VALUE_FLAGS = new Set([
  '--name',
  '--max-pages',
  '--write',
  '--score',
  '--min-score',
  '--url',
  '--title',
  '--model',
  '--effort',
  '--set-output',
  '--set-profile',
]);

// ============================================================
// Paths — resolve relative to binary location or script dir
// ============================================================

function getBaseDir(): string {
  // When compiled with `bun build --compile`, import.meta.dir points to /$bunfs/root/
  // In that case, use the actual binary location on disk.
  const metaDir = import.meta.dir || '';
  if (metaDir.startsWith('/$bunfs') || metaDir === '') {
    const binDir = dirname(process.execPath);
    // If installed in ~/.theseer/bin/, go up to ~/.theseer/ as root
    if (binDir.endsWith('/bin') && existsSync(join(binDir, '..', 'templates'))) {
      return resolve(binDir, '..');
    }
    return binDir;
  }
  return metaDir;
}

const BASE_DIR = getBaseDir();

// Detect dev mode: running from source with GEN/ directory present
const IS_DEV = existsSync(join(BASE_DIR, 'GEN', 'GEN-V3.tex'));

const SEER_DIR = join(homedir(), '.theseer');
const CONFIG_PATH = configPathFor(homedir());

// Read per call, so a config change made while the host runs is picked up by the next request.
function hostContext(): HostContext {
  const config = loadConfig(CONFIG_PATH);
  return {
    config,
    outputBase: process.env.THESEER_OUTPUT || config.outputDir || (IS_DEV ? join(BASE_DIR, 'Experimental') : ''),
    templatePath:
      process.env.THESEER_TEMPLATE ||
      (IS_DEV ? join(BASE_DIR, 'GEN', 'GEN-V3.tex') : join(BASE_DIR, 'templates', 'default.tex')),
    baseDir: BASE_DIR,
    home: homedir(),
    env: process.env,
  };
}

// ============================================================
// Detect mode from argv
// ============================================================

const args = process.argv.slice(2);

await main();

async function main(): Promise<void> {
  if (has('--version')) return console.log(HELPER_VERSION);
  if (has('--help') || has('-h')) return printUsage();
  if (has('--native-host')) return runNative();
  try {
    if (has('--setup')) return await runSetupCli();
    if (has('--set-output')) return setOutput();
    if (has('--set-profile')) return await setProfile();
    if (has('--score')) return await runScoreCli();
    if (has('--write')) return await runWriteCli();
    return await runGenerateCli();
  } catch (error) {
    exitWithError(error);
  }
}

function has(flag: string): boolean {
  return args.includes(flag);
}

// The token after `flag`, or undefined when the flag is absent or nothing follows it.
function peekValue(flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

// Like peekValue, but a flag given without its value is an error rather than a silent default.
function argValue(flag: string): string | undefined {
  const value = peekValue(flag);
  if (value === undefined && has(flag)) throw new Error(`${flag} needs a value`);
  return value;
}

function requiredArg(flag: string): string {
  const value = argValue(flag);
  if (value === undefined) throw new Error(`${flag} needs a value`);
  return value;
}

function replyFileArg(): string | undefined {
  return args.find((arg, index) => !arg.startsWith('-') && !VALUE_FLAGS.has(args[index - 1] ?? ''));
}

function maxPagesArg(): number {
  const value = argValue('--max-pages');
  return parseMaxPages(value === undefined ? DEFAULT_MAX_PAGES : Number(value));
}

function exitWithError(error: unknown): never {
  const { error: message, details } = toNativeError(error);
  console.error(`${TAG} Error: ${message}`);
  if (details !== undefined) console.error(details);
  process.exit(1);
}

// ============================================================
// MODE 1: Write — Claude Code writes the resume from a job file
// ============================================================

function jobArg(flag: string): WriterJob {
  const jobFile = requiredArg(flag);
  if (!existsSync(jobFile)) throw new Error(`File not found: ${jobFile}`);
  return { text: readFileSync(jobFile, 'utf-8'), url: argValue('--url') ?? '', title: argValue('--title') ?? '' };
}

function minScoreArg(): number {
  const value = argValue('--min-score');
  return value === undefined ? DEFAULT_MIN_SCORE : Number(value);
}

async function runWriteCli(): Promise<void> {
  const req = parseWriteRequest({
    job: jobArg('--write'),
    model: argValue('--model') ?? DEFAULT_MODEL,
    effort: argValue('--effort') ?? DEFAULT_EFFORT,
    maxPages: maxPagesArg(),
    minScore: minScoreArg(),
  });

  let failed = false;
  await writeResume(req, writeDeps(hostContext(), req), (message) => {
    if (message.type === 'error') failed = true;
    printWriteMessage(message);
  });
  if (failed) process.exit(1);
}

function printWriteMessage(message: HostMessage): void {
  if (message.type === 'progress') console.log(`${TAG} ${message.stage}…`);
  else if (message.type === 'score') printScore(message.analysis);
  else if (message.type === 'skipped') {
    console.log(`${TAG} Skipped: fit ${message.score} is below ${message.threshold}, no resume written (--min-score 0 writes anyway)`);
  } else if (message.type === 'result') printResult(message);
  else {
    console.error(`${TAG} Error: ${message.error}`);
    if (message.details !== undefined) console.error(message.details);
  }
}

function printScore(analysis: FitAnalysis): void {
  console.log(
    `${TAG} Fit score: ${analysis.fit_score}/100 (${analysis.apply_recommendation}), base: ${analysis.recommended_base}`,
  );
  if (analysis.red_flags.length > 0) console.log(`${TAG} Red flags: ${analysis.red_flags.join('; ')}`);
}

// ============================================================
// Score — Claude Code scores a job file; the JSON goes to stdout
// ============================================================

async function runScoreCli(): Promise<void> {
  const req = parseScoreRequest({
    job: jobArg('--score'),
    model: argValue('--model') ?? DEFAULT_SCORE_MODEL,
    effort: argValue('--effort') ?? DEFAULT_SCORE_EFFORT,
  });
  const fit = await scoreOnce(hostContext(), req);
  process.stdout.write(`${JSON.stringify(fit, null, 2)}\n`);
}

function printResult(result: GenerateResult): void {
  const fit = result.fits ? 'fits' : 'over the page budget';
  console.log(`${TAG} Done: ${pageCount(result.pages)} (${fit}), ${result.trimmedBullets} bullet(s) trimmed`);
  console.log(`  ${result.texPath}\n  ${result.pdfPath}\n  ${result.uploadPdfPath}`);
}

// ============================================================
// MODE 2: Generate — a saved reply (resume JSON or old markdown) to PDF
// ============================================================

async function runGenerateCli(): Promise<void> {
  const json = has('--json');
  try {
    const reply = await readReply();
    if (reply === null) {
      if (json) throw new Error(NO_REPLY);
      printUsage();
      process.exit(1);
    }
    const name = argValue('--name');
    const result = await generateResume(reply.text, {
      ...buildOptions(hostContext(), maxPagesArg()),
      fallbackTitle: reply.fallbackTitle,
      ...(name !== undefined && { folderNameOverride: name }),
    });
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else printResult(result);
  } catch (error) {
    if (!json) throw error;
    const { error: message, details } = toNativeError(error);
    process.stdout.write(`${JSON.stringify({ success: false, error: message, ...(details !== undefined && { details }) })}\n`);
    process.exit(1);
  }
}

// The reply file's name is the folder name of last resort for old markdown replies without a title.
async function readReply(): Promise<{ text: string; fallbackTitle: string | null } | null> {
  const file = replyFileArg();
  if (file !== undefined) {
    if (!existsSync(file)) throw new Error(`File not found: ${file}`);
    return { text: readFileSync(file, 'utf-8'), fallbackTitle: basename(file, extname(file)) };
  }
  if (process.stdin.isTTY) return null;
  return { text: await Bun.stdin.text(), fallbackTitle: null };
}

// ============================================================
// MODE 3: Native Messaging Host
// ============================================================

// One request per process; exits once the last message has been written.
async function runNative(): Promise<void> {
  await runNativeHost({ stdin: process.stdin, stdout: process.stdout }, hostHandlers(hostContext));
  process.exit(0);
}

// ============================================================
// MODE 4: Settings and Setup
// ============================================================

function setOutput(): void {
  const dir = peekValue('--set-output');
  if (dir === undefined) {
    console.log(`${TAG} Current output directory: ${hostContext().outputBase || '(not set)'}`);
    console.log(`${TAG} Usage: theseer-pdf --set-output /path/to/folder`);
    return;
  }
  const resolved = resolve(dir);
  mkdirSync(resolved, { recursive: true });
  updateConfig(CONFIG_PATH, { outputDir: resolved });
  console.log(`${TAG} Output directory set to: ${resolved}`);
}

// Loads the profile before saving it, so a folder the writer cannot use is never configured.
async function setProfile(): Promise<void> {
  const dir = peekValue('--set-profile');
  if (dir === undefined) {
    console.log(`${TAG} Current profile folder: ${loadConfig(CONFIG_PATH).profileDir ?? '(not set)'}`);
    console.log(`${TAG} Usage: theseer-pdf --set-profile /path/to/profile`);
    return;
  }
  const resolved = resolve(dir);
  const profile = await loadProfile(resolved);
  updateConfig(CONFIG_PATH, { profileDir: resolved });
  console.log(`${TAG} Profile folder set to: ${resolved}`);
  console.log(`${TAG} Documents: ${profile.documents.map((source) => source.name).join(', ')}`);
}

function printUsage(): void {
  console.log(`
The Seer — Resume Host

Usage:
  theseer-pdf --write <job.txt> [options]       # Claude Code scores the job, writes a resume if it fits, then PDF
  theseer-pdf --score <job.txt> [options]       # Claude Code scores the job; prints the score JSON
  theseer-pdf <reply-file>                      # A saved reply (resume JSON or old markdown) to PDF
  pbpaste | theseer-pdf --name "Folder Name"    # Same, from the clipboard
  theseer-pdf --native-host                     # Chrome native messaging mode
  theseer-pdf --setup [--no-warm-up]            # Register the helper with Chrome, find Claude Code, make folders
  theseer-pdf --set-output ~/Resumes            # Change output directory
  theseer-pdf --set-profile <dir>               # Set the My files folder (your resumes and other documents)

Write options:
  --url <url>         Job posting URL
  --title <title>     Job page title
  --model <model>     Claude model: opus, sonnet, haiku, fable or a full id (default: ${DEFAULT_MODEL})
  --effort <level>    low, medium, high, xhigh or max (default: ${DEFAULT_EFFORT})
  --max-pages <n>     Page budget (default: ${DEFAULT_MAX_PAGES})
  --min-score <n>     Write only at a fit score of n or more, 0 to 100; 0 always writes (default: ${DEFAULT_MIN_SCORE})
                      (scoring itself runs on ${DEFAULT_SCORE_MODEL} at ${DEFAULT_SCORE_EFFORT} effort)

Score options:
  --url, --title      As for --write
  --model <model>     Claude model for scoring (default: ${DEFAULT_SCORE_MODEL})
  --effort <level>    low, medium, high, xhigh or max (default: ${DEFAULT_SCORE_EFFORT})

Reply options:
  --name <name>       Folder name instead of "<Company> - <Role>"
  --json              Print the result as JSON
  --max-pages <n>     Page budget (default: ${DEFAULT_MAX_PAGES})

Setup options:
  --no-warm-up        Skip compiling a sample resume (which downloads the PDF builder's TeX files)

Other:
  --version           Print the helper version
  --help, -h          Show this help
`);
}

async function runSetupCli(): Promise<void> {
  console.log(`${TAG} Setting up The Seer...`);
  await runSetup({
    seerDir: SEER_DIR,
    home: homedir(),
    configPath: CONFIG_PATH,
    env: process.env,
    warmUp: !has('--no-warm-up'),
    log: (line) => console.log(`${TAG} ${line}`),
  });
}
