import { spawn } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import { isRecord, type JsonObject } from './json-validation';
import { extractResumeDoc, type ResumeDoc, validateResumeDoc } from './resume-doc';
import { withTempDir } from './temp-dir';
import type { WriterRequest } from './writer/request';

// The levels `claude -p --effort` accepts.
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ClaudeOptions {
  claudePath: string;
  model: string;
  effort: Effort;
  fallbackModel: string | null;
  timeoutMs: number;
  signal?: AbortSignal; // aborting stops claude, e.g. when Chrome closes the port
  task?: string; // names the run in its timeout message; "Resume writing" when left out
}

export interface LoginCheckOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

// What `readClaudeAuth` found; `problem` is null when Claude Code can write resumes.
export interface ClaudeAuth {
  loggedIn: boolean; // claude's own flag: a login with an API key is signed in, but `problem` says it is unusable
  plan: string | null; // the subscription, e.g. "pro" or "max"
  problem: 'not-logged-in' | 'not-subscription' | null;
}

type ClaudeRunErrorKind = 'not-installed' | 'not-logged-in' | 'timeout' | 'cancelled' | 'failed' | 'bad-output';

// The message is shown to the owner in the extension panel.
export class ClaudeRunError extends Error {
  readonly kind: ClaudeRunErrorKind;

  constructor(kind: ClaudeRunErrorKind, message: string) {
    super(message);
    this.name = 'ClaudeRunError';
    this.kind = kind;
  }
}

const TAG = '[theseer-pdf]';
// Variables that move `claude -p` off the Max subscription: API keys and tokens, a proxy base URL,
// Bedrock/Vertex/Foundry. CLAUDE_CODE_OAUTH_TOKEN is the subscription token and does not match.
const BILLING_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_USE_'] as const;
// Homebrew on Apple silicon, then Homebrew (and npm's usual global folder) on Intel: an npm-installed claude
// needs the node beside it.
const HOMEBREW_BINS = ['/opt/homebrew/bin', '/usr/local/bin'];
const TEMP_PREFIX = 'theseer-claude-';
const KILL_GRACE_MS = 5_000;
const AUTH_TIMEOUT_MS = 30_000;
const EXCERPT_CHARS = 300;
// Chrome caps a host-to-extension message at 1 MB.
const MAX_FAILURE_CHARS = 500;
const NOT_LOGGED_IN = "Claude Code isn't logged in with your Claude subscription — run `claude` and `/login`.";
export const CLAUDE_NOT_INSTALLED = "Claude Code not found — install it, then open The Seer's setup page";
export const NOT_SUBSCRIPTION =
  'Claude Code is signed in with an API key or a cloud provider — The Seer only uses your Claude subscription. Run claude, type /login and choose your Claude account.';
const DEFAULT_TASK = 'Resume writing';

type StopReason = 'timeout' | 'cancelled';
type ProcessOptions = {
  input: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  cwd?: string;
};
type ProcessRun = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stopped: StopReason | null;
};

// The fields of `claude -p --output-format json` that The Seer reads.
type ClaudeReply = {
  type?: unknown;
  is_error?: unknown;
  subtype?: unknown;
  result?: unknown;
  structured_output?: unknown;
  num_turns?: unknown;
};

export function claudeArgs(req: WriterRequest, opts: ClaudeOptions): string[] {
  const { model, effort, fallbackModel } = opts;
  return [
    '-p',
    '--safe-mode',
    '--tools',
    '',
    '--no-session-persistence',
    '--model',
    model,
    '--effort',
    effort,
    ...(fallbackModel && fallbackModel !== model ? ['--fallback-model', fallbackModel] : []),
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(req.schema),
    '--system-prompt',
    req.systemPrompt,
  ];
}

// Chrome starts the host with a minimal PATH, so claude's own directory and Homebrew's go first.
export function childEnv(parent: NodeJS.ProcessEnv, claudePath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parent)) {
    if (!isBillingVar(name)) env[name] = value;
  }
  env.PATH = [dirname(claudePath), ...HOMEBREW_BINS, parent.PATH].filter(Boolean).join(':');
  return env;
}

function isBillingVar(name: string): boolean {
  return BILLING_PREFIXES.some((prefix) => name.startsWith(prefix));
}

// Runs `claude auth status`. A claude that cannot answer (timeout, unreadable output) is an error, not a problem.
export async function readClaudeAuth(claudePath: string, opts: LoginCheckOptions = {}): Promise<ClaudeAuth> {
  requireAbsolute(claudePath);
  const timeoutMs = opts.timeoutMs ?? AUTH_TIMEOUT_MS;
  const run = await runProcess(claudePath, ['auth', 'status'], {
    input: '',
    env: childEnv(process.env, claudePath),
    timeoutMs,
    signal: opts.signal,
  });
  if (run.stopped === 'cancelled') throw cancelledError();
  if (run.stopped === 'timeout') {
    throw new ClaudeRunError('timeout', `Claude Code login check timed out after ${timeoutMs / 1000} s`);
  }
  const status = parseJsonObject(run.stdout);
  if (!status) throw badOutput('`claude auth status`', run);
  return authFromStatus(status);
}

function authFromStatus(status: JsonObject): ClaudeAuth {
  if (status.loggedIn !== true) return { loggedIn: false, plan: null, problem: 'not-logged-in' };
  if (status.authMethod !== 'claude.ai' || status.apiProvider !== 'firstParty') {
    return { loggedIn: true, plan: null, problem: 'not-subscription' };
  }
  const plan = typeof status.subscriptionType === 'string' ? status.subscriptionType : null;
  return { loggedIn: true, plan, problem: null };
}

export async function checkClaudeLogin(claudePath: string, opts: LoginCheckOptions = {}): Promise<void> {
  const { problem } = await readClaudeAuth(claudePath, opts);
  if (problem !== null) throw authProblemError(problem);
}

function authProblemError(problem: NonNullable<ClaudeAuth['problem']>): ClaudeRunError {
  return new ClaudeRunError('not-logged-in', problem === 'not-subscription' ? NOT_SUBSCRIPTION : NOT_LOGGED_IN);
}

// Reads a reply: the structured output when claude gave one (else undefined) and the result text.
export type ReplyParser<T> = (structured: unknown, resultText: string) => T;

export async function runClaudeWriter(
  req: WriterRequest,
  opts: ClaudeOptions,
): Promise<{ doc: ResumeDoc; durationMs: number }> {
  const { value, durationMs } = await runClaudeJson(req, opts, resumeFromReply);
  return { doc: value, durationMs };
}

function resumeFromReply(structured: unknown, resultText: string): ResumeDoc {
  return structured === undefined ? extractResumeDoc(resultText) : validateResumeDoc(structured);
}

// One headless `claude -p` run against the request's JSON schema; `parse` turns the reply into T.
export async function runClaudeJson<T>(
  req: WriterRequest,
  opts: ClaudeOptions,
  parse: ReplyParser<T>,
): Promise<{ value: T; durationMs: number }> {
  requireAbsolute(opts.claudePath);
  return withTempDir(TEMP_PREFIX, async (cwd) => {
    const started = Date.now();
    const run = await runProcess(opts.claudePath, claudeArgs(req, opts), {
      input: req.userMessage,
      env: childEnv(process.env, opts.claudePath),
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      cwd,
    });
    const durationMs = Date.now() - started;
    const reply = run.stopped ? null : parseJsonObject(run.stdout);
    logRun(opts, durationMs, reply?.num_turns);
    return { value: replyValue(run, reply, opts, parse), durationMs };
  });
}

function replyValue<T>(run: ProcessRun, reply: ClaudeReply | null, opts: ClaudeOptions, parse: ReplyParser<T>): T {
  if (run.stopped === 'cancelled') throw cancelledError();
  if (run.stopped === 'timeout') throw timeoutError(opts.timeoutMs, opts.task ?? DEFAULT_TASK);
  if (!reply || reply.type !== 'result') throw badOutput('Claude Code', run);
  if (reply.is_error === true || reply.subtype !== 'success') {
    throw new ClaudeRunError('failed', `Claude Code failed: ${failureText(reply)}`);
  }
  const structured = reply.structured_output === null ? undefined : reply.structured_output;
  return parse(structured, typeof reply.result === 'string' ? reply.result : '');
}

// Claude's own result text carries usage-limit and overload messages; some error subtypes have none.
function failureText(reply: ClaudeReply): string {
  const text = typeof reply.result === 'string' ? reply.result.trim() : '';
  if (text === '') return typeof reply.subtype === 'string' ? reply.subtype : 'unknown error';
  return text.length > MAX_FAILURE_CHARS ? `${text.slice(0, MAX_FAILURE_CHARS)}…` : text;
}

// A relative path would resolve against wherever Chrome started the host.
function requireAbsolute(claudePath: string): void {
  if (!isAbsolute(claudePath)) {
    throw new ClaudeRunError('not-installed', `Claude Code path must be absolute: ${claudePath}`);
  }
}

export function cancelledError(): ClaudeRunError {
  return new ClaudeRunError('cancelled', 'Resume writing was cancelled.');
}

function timeoutError(timeoutMs: number, task: string): ClaudeRunError {
  const minutes = Math.round(timeoutMs / 6_000) / 10;
  return new ClaudeRunError('timeout', `${task} timed out after ${minutes} min`);
}

// Shows how the child ended and the start of each stream that has text.
function badOutput(source: string, run: ProcessRun): ClaudeRunError {
  const parts = [excerpt('stdout', run.stdout), excerpt('stderr', run.stderr)].filter((part) => part !== '');
  return new ClaudeRunError('bad-output', [`${source} gave no usable reply (${exitText(run)})`, ...parts].join(' — '));
}

function exitText(run: ProcessRun): string {
  return run.code === null ? `signal ${run.signal ?? 'unknown'}` : `exit code ${run.code}`;
}

function excerpt(name: string, text: string): string {
  const start = text.trim().slice(0, EXCERPT_CHARS);
  return start === '' ? '' : `${name}: ${start}`;
}

function parseJsonObject(text: string): JsonObject | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  return isRecord(value) ? value : null;
}

// stderr only: the host's stdout is the native-messaging channel.
function logRun(opts: ClaudeOptions, durationMs: number, turns: unknown): void {
  const turnCount = typeof turns === 'number' ? turns : '?';
  console.error(
    `${TAG} claude -p model=${opts.model} effort=${opts.effort} duration=${durationMs}ms turns=${turnCount}`,
  );
}

// Runs without a shell. Settles only once the child has exited, so a stopped child is gone.
function runProcess(command: string, args: string[], options: ProcessOptions): Promise<ProcessRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let stopped: StopReason | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    // SIGTERM first; SIGKILL if claude is still alive after the grace period.
    const stop = (reason: StopReason): void => {
      if (stopped) return;
      stopped = reason;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    };
    const onAbort = (): void => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const cleanUp = (): void => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      cleanUp();
      reject(spawnError(error, command));
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      cleanUp();
      resolve({ stdout, stderr, code, signal, stopped });
    });
    // A child that exits without reading stdin closes the pipe; its output still decides the run.
    child.stdin.on('error', (error: Error) => {
      console.error(`${TAG} claude stopped reading its input early: ${error.message}`);
    });
    child.stdin.end(options.input);
  });
}

function spawnError(error: NodeJS.ErrnoException, command: string): ClaudeRunError {
  if (error.code === 'ENOENT') return new ClaudeRunError('not-installed', `Claude Code not found at ${command}`);
  return new ClaudeRunError('failed', `Claude Code could not start: ${error.message}`);
}
