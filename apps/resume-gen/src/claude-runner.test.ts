import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  type ClaudeOptions,
  ClaudeRunError,
  CLAUDE_NOT_INSTALLED,
  checkClaudeLogin,
  childEnv,
  claudeArgs,
  NOT_SUBSCRIPTION,
  readClaudeAuth,
  runClaudeJson,
  runClaudeWriter,
} from './claude-runner';
import { ResumeFormatError } from './resume-doc';
import { fitResultFromReply, ScoreFormatError } from './scorer/request';
import { VALID, VALID_FIT } from './test-fixtures';
import type { WriterRequest } from './writer/request';

const REQUEST: WriterRequest = {
  systemPrompt: 'You write one-page resumes.',
  userMessage: 'Job: ML Engineer at Acme AI\nPage budget: 1 page(s).',
  schema: { type: 'object', required: ['version'] },
};

const USAGE_LIMIT = 'Claude AI usage limit reached. Your limit resets at 5pm.';
const LONG_ERROR = `API Error: overloaded ${'y'.repeat(600)}`;
const NOT_A_RESULT = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake-session' });
const GARBAGE_STDOUT = `not json ${'x'.repeat(400)}`;
const GARBAGE_STDERR = 'boom: something broke';
const CRASH_STDERR = "error: unknown option '--safe-mode'";
const NOT_LOGGED_IN = "Claude Code isn't logged in with your Claude subscription — run `claude` and `/login`.";
const NOT_SUBSCRIPTION_TEXT =
  'Claude Code is signed in with an API key or a cloud provider — The Seer only uses your Claude subscription. Run claude, type /login and choose your Claude account.';
const NOT_INSTALLED_TEXT = "Claude Code not found — install it, then open The Seer's setup page";
const CANCELLED = 'Resume writing was cancelled.';

type FakeCall = {
  argv: string[];
  hasApiKey: boolean;
  billingVars: string[];
  hasOauthToken: boolean;
  stdin: string;
  pid: number;
  cwd: string;
  path: string;
};

function successReply(fields: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 3500,
    num_turns: 1,
    session_id: 'fake-session',
    total_cost_usd: 0,
    ...fields,
  });
}

function errorReply(result: string): string {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result, num_turns: 1 });
}

function authReply(fields: Record<string, unknown>): string {
  return JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', ...fields });
}

// Built at test time from VALID so the fake follows whatever the fixture holds.
function cannedReplies(): Record<string, string> {
  return {
    structured: successReply({ result: 'The resume is in structured_output.', structured_output: VALID }),
    'structured-bad': successReply({ result: '', structured_output: { ...VALID, name: '' } }),
    text: successReply({ result: `Here is the resume.\n\n\`\`\`json\n${JSON.stringify(VALID, null, 2)}\n\`\`\`\n` }),
    'score-structured': successReply({ result: '', structured_output: VALID_FIT }),
    'score-text': successReply({ result: JSON.stringify(VALID_FIT), structured_output: null }),
    'score-invalid': successReply({ result: '', structured_output: { ...VALID_FIT, fit_score: 140 } }),
    error: errorReply(USAGE_LIMIT),
    'error-long': errorReply(LONG_ERROR),
    'max-turns': JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: false, num_turns: 3 }),
    'not-result': NOT_A_RESULT,
    garbage: GARBAGE_STDOUT,
    'auth-ok': authReply({ subscriptionType: 'max' }),
    'auth-pro': authReply({ subscriptionType: 'pro' }),
    'auth-no-plan': authReply({}),
    'auth-bare-out': JSON.stringify({ loggedIn: false }),
    'auth-api': authReply({ authMethod: 'api_key' }),
    'auth-out': authReply({ loggedIn: false }),
    'auth-bedrock': authReply({ apiProvider: 'bedrock' }),
  };
}

// A stand-in for `claude`: logs what it was given, then replies as FAKE_MODE says.
// `sleep` outlives any test timeout; `stubborn` also ignores SIGTERM; `crash` writes only to
// stderr and exits 1; `killed` dies by SIGKILL without a reply.
function fakeClaudeScript(): string {
  return `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const REPLIES = ${JSON.stringify(cannedReplies())};
const STDERR = ${JSON.stringify({ garbage: GARBAGE_STDERR, crash: CRASH_STDERR })};
const mode = process.env.FAKE_MODE ?? '';
if (mode === 'stubborn') process.on('SIGTERM', () => {});
const stdin = await Bun.stdin.text();
appendFileSync(process.env.FAKE_LOG, JSON.stringify({
  argv: process.argv.slice(2),
  hasApiKey: 'ANTHROPIC_API_KEY' in process.env,
  billingVars: Object.keys(process.env).filter((name) => /^(ANTHROPIC_|CLAUDE_CODE_USE_)/.test(name)),
  hasOauthToken: 'CLAUDE_CODE_OAUTH_TOKEN' in process.env,
  stdin,
  pid: process.pid,
  cwd: process.cwd(),
  path: process.env.PATH ?? '',
}) + '\\n');
if (mode === 'sleep' || mode === 'stubborn') await Bun.sleep(30_000);
if (mode === 'killed') process.kill(process.pid, 'SIGKILL');
process.stderr.write(STDERR[mode] ?? '');
process.stdout.write(REPLIES[mode] ?? '');
if (mode === 'crash') process.exitCode = 1;
`;
}

const tempDir = mkdtempSync(join(tmpdir(), 'seer-claude-runner-'));
const binDir = join(tempDir, 'bin');
const FAKE_CLAUDE = join(binDir, 'claude');
const FAKE_LOG = join(tempDir, 'calls.jsonl');
mkdirSync(binDir);
writeFileSync(FAKE_CLAUDE, fakeClaudeScript(), 'utf-8');
chmodSync(FAKE_CLAUDE, 0o755);
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

// Every variable a test sets; each is put back after the test.
const ENV_KEYS = [
  'FAKE_MODE',
  'FAKE_LOG',
  'TMPDIR',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
let errorSpy: ReturnType<typeof spyOn<Console, 'error'>>;
let logSpy: ReturnType<typeof spyOn<Console, 'log'>>;

beforeEach(() => {
  writeFileSync(FAKE_LOG, '', 'utf-8');
  process.env.FAKE_LOG = FAKE_LOG;
  errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  logSpy = spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

function options(overrides: Partial<ClaudeOptions> = {}): ClaudeOptions {
  return {
    claudePath: FAKE_CLAUDE,
    model: 'opus',
    effort: 'medium',
    fallbackModel: 'sonnet',
    timeoutMs: 10_000,
    ...overrides,
  };
}

function setBillingVars(): void {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.ANTHROPIC_AUTH_TOKEN = 'token-test';
  process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com';
  process.env.CLAUDE_CODE_USE_BEDROCK = '1';
  process.env.CLAUDE_CODE_USE_VERTEX = '1';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test';
}

// Points os.tmpdir() at an empty directory so a test sees every temp dir the runner leaves behind.
function privateTmpdir(): string {
  const dir = mkdtempSync(join(tempDir, 'tmp-'));
  process.env.TMPDIR = dir;
  return dir;
}

function fakeCalls(): FakeCall[] {
  return readFileSync(FAKE_LOG, 'utf-8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as FakeCall);
}

function onlyCall(): FakeCall {
  const calls = fakeCalls();
  expect(calls).toHaveLength(1);
  return calls[0];
}

async function waitForCall(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (fakeCalls().length === 0) {
    if (Date.now() > deadline) throw new Error('the fake claude never started');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function loggedLines(): string[] {
  return errorSpy.mock.calls.map((call) => String(call[0]));
}

async function runError(run: Promise<unknown>): Promise<ClaudeRunError> {
  const error = await run.then(
    () => null,
    (rejection: unknown) => rejection,
  );
  if (!(error instanceof ClaudeRunError)) throw new Error(`Expected a ClaudeRunError, got ${String(error)}`);
  return error;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

describe('claudeArgs', () => {
  const schemaJson = JSON.stringify(REQUEST.schema);

  it('builds the exact headless command with a fallback model', () => {
    expect(claudeArgs(REQUEST, options())).toEqual([
      '-p',
      '--safe-mode',
      '--tools',
      '',
      '--no-session-persistence',
      '--model',
      'opus',
      '--effort',
      'medium',
      '--fallback-model',
      'sonnet',
      '--output-format',
      'json',
      '--json-schema',
      schemaJson,
      '--system-prompt',
      REQUEST.systemPrompt,
    ]);
  });

  it('leaves out the fallback when there is none', () => {
    expect(claudeArgs(REQUEST, options({ model: 'haiku', effort: 'max', fallbackModel: null }))).toEqual([
      '-p',
      '--safe-mode',
      '--tools',
      '',
      '--no-session-persistence',
      '--model',
      'haiku',
      '--effort',
      'max',
      '--output-format',
      'json',
      '--json-schema',
      schemaJson,
      '--system-prompt',
      REQUEST.systemPrompt,
    ]);
  });

  it('leaves out the fallback when it equals the model', () => {
    const args = claudeArgs(REQUEST, options({ model: 'sonnet', fallbackModel: 'sonnet' }));

    expect(args).not.toContain('--fallback-model');
    expect(args.slice(5, 9)).toEqual(['--model', 'sonnet', '--effort', 'medium']);
  });
});

describe('childEnv', () => {
  const parent: NodeJS.ProcessEnv = {
    HOME: '/Users/owner',
    PATH: '/usr/bin:/bin',
    ANTHROPIC_API_KEY: 'sk-test',
    ANTHROPIC_AUTH_TOKEN: 'token-test',
    ANTHROPIC_BASE_URL: 'https://proxy.example.com',
    ANTHROPIC_MODEL: 'claude-sonnet',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_USE_FOUNDRY: '1',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test',
    CLAUDE_CONFIG_DIR: '/Users/owner/.claude',
  };

  it('drops every ANTHROPIC_ and CLAUDE_CODE_USE_ variable and keeps the subscription token', () => {
    const env = childEnv(parent, '/Users/owner/.local/bin/claude');

    expect(Object.keys(env).sort()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'HOME', 'PATH']);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-test');
    expect(env.HOME).toBe('/Users/owner');
  });

  it("puts claude's directory and both Homebrew folders (Apple silicon, then Intel) in front of PATH", () => {
    const env = childEnv(parent, '/Users/owner/.local/bin/claude');

    expect(env.PATH).toBe('/Users/owner/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
  });

  it('builds a PATH when the parent has none', () => {
    const env = childEnv({ HOME: '/Users/owner' }, '/Users/owner/.local/bin/claude');

    expect(env.PATH).toBe('/Users/owner/.local/bin:/opt/homebrew/bin:/usr/local/bin');
  });

  it('leaves the parent untouched', () => {
    childEnv(parent, '/Users/owner/.local/bin/claude');

    expect(parent.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(parent.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(parent.PATH).toBe('/usr/bin:/bin');
  });
});

describe('runClaudeWriter', () => {
  it('runs claude with the exact args, the job on stdin and no billing variables', async () => {
    process.env.FAKE_MODE = 'structured';
    setBillingVars();

    await runClaudeWriter(REQUEST, options());

    const call = onlyCall();
    expect(call.argv).toEqual(claudeArgs(REQUEST, options()));
    expect(call.stdin).toBe(REQUEST.userMessage);
    expect(call.hasApiKey).toBe(false);
    expect(call.billingVars).toEqual([]);
    expect(call.hasOauthToken).toBe(true);
    expect(call.path.startsWith(`${binDir}:/opt/homebrew/bin:`)).toBe(true);
  });

  it('returns the structured output as the resume', async () => {
    process.env.FAKE_MODE = 'structured';

    const { doc, durationMs } = await runClaudeWriter(REQUEST, options());

    expect(doc).toEqual(VALID);
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });

  it('validates the structured output instead of trusting it', async () => {
    process.env.FAKE_MODE = 'structured-bad';

    const error = await runClaudeWriter(REQUEST, options()).then(
      () => null,
      (rejection: unknown) => rejection,
    );

    expect(error).toBeInstanceOf(ResumeFormatError);
  });

  it('falls back to the fenced JSON in the result text', async () => {
    process.env.FAKE_MODE = 'text';

    const { doc } = await runClaudeWriter(REQUEST, options());

    expect(doc).toEqual(VALID);
  });

  it('runs in a fresh temp directory and removes it afterwards', async () => {
    process.env.FAKE_MODE = 'structured';

    await runClaudeWriter(REQUEST, options());

    const { cwd } = onlyCall();
    expect(basename(cwd).startsWith('theseer-claude-')).toBe(true);
    expect(cwd).not.toBe(process.cwd());
    expect(existsSync(cwd)).toBe(false);
  });

  it("reports Claude's own message when the run is an error", async () => {
    process.env.FAKE_MODE = 'error';

    const error = await runError(runClaudeWriter(REQUEST, options()));

    expect(error.kind).toBe('failed');
    expect(error.message).toBe(`Claude Code failed: ${USAGE_LIMIT}`);
    expect(existsSync(onlyCall().cwd)).toBe(false);
  });

  it("cuts Claude's message to 500 characters", async () => {
    process.env.FAKE_MODE = 'error-long';

    const error = await runError(runClaudeWriter(REQUEST, options()));

    expect(error.kind).toBe('failed');
    expect(error.message).toBe(`Claude Code failed: ${LONG_ERROR.slice(0, 500)}…`);
  });

  it('treats a non-success subtype as a failure even without a result', async () => {
    process.env.FAKE_MODE = 'max-turns';

    const error = await runError(runClaudeWriter(REQUEST, options()));

    expect(error.kind).toBe('failed');
    expect(error.message).toBe('Claude Code failed: error_max_turns');
  });

  it('reports a JSON object that is not a result as unusable', async () => {
    process.env.FAKE_MODE = 'not-result';

    const error = await runError(runClaudeWriter(REQUEST, options()));

    expect(error.kind).toBe('bad-output');
    expect(error.message).toBe(`Claude Code gave no usable reply (exit code 0) — stdout: ${NOT_A_RESULT}`);
  });

  it('reports unreadable output with the exit code and the start of stdout and stderr', async () => {
    process.env.FAKE_MODE = 'garbage';

    const error = await runError(runClaudeWriter(REQUEST, options()));

    expect(error.kind).toBe('bad-output');
    expect(error.message).toContain('(exit code 0)');
    expect(error.message).toContain(GARBAGE_STDOUT.slice(0, 300));
    expect(error.message).not.toContain(GARBAGE_STDOUT.slice(0, 301));
    expect(error.message).toContain(GARBAGE_STDERR);
    expect(existsSync(onlyCall().cwd)).toBe(false);
    expect(loggedLines()).toHaveLength(1);
    expect(loggedLines()[0]).toMatch(/^\[theseer-pdf\] claude -p model=opus effort=medium duration=\d+ms turns=\?$/);
  });

  it('reports only the stream that has text when claude dies without a reply', async () => {
    process.env.FAKE_MODE = 'crash';

    const error = await runError(runClaudeWriter(REQUEST, options()));

    expect(error.kind).toBe('bad-output');
    expect(error.message).toBe(`Claude Code gave no usable reply (exit code 1) — stderr: ${CRASH_STDERR}`);
  });

  it('names the signal when claude is killed without a reply', async () => {
    process.env.FAKE_MODE = 'killed';

    const error = await runError(runClaudeWriter(REQUEST, options()));

    expect(error.kind).toBe('bad-output');
    expect(error.message).toBe('Claude Code gave no usable reply (signal SIGKILL)');
  });

  it('stops a run that takes too long, logs it and removes its temp directory', async () => {
    process.env.FAKE_MODE = 'sleep';

    const error = await runError(runClaudeWriter(REQUEST, options({ timeoutMs: 300 })));

    expect(error.kind).toBe('timeout');
    expect(error.message).toMatch(/^Resume writing timed out after [\d.]+ min$/);
    const { pid, cwd } = onlyCall();
    expect(isAlive(pid)).toBe(false);
    expect(existsSync(cwd)).toBe(false);
    expect(loggedLines()).toHaveLength(1);
    expect(loggedLines()[0]).toMatch(/^\[theseer-pdf\] claude -p model=opus effort=medium duration=\d+ms turns=\?$/);
  });

  it('kills a run that ignores SIGTERM after 5 seconds', async () => {
    process.env.FAKE_MODE = 'stubborn';
    const started = Date.now();

    const error = await runError(runClaudeWriter(REQUEST, options({ timeoutMs: 300 })));

    expect(error.kind).toBe('timeout');
    expect(Date.now() - started).toBeGreaterThanOrEqual(5_000);
    expect(isAlive(onlyCall().pid)).toBe(false);
  }, 15_000);

  it('cancels a running claude when the signal aborts', async () => {
    process.env.FAKE_MODE = 'sleep';
    const controller = new AbortController();

    const run = runClaudeWriter(REQUEST, options({ signal: controller.signal }));
    await waitForCall();
    controller.abort();
    const error = await runError(run);

    expect(error.kind).toBe('cancelled');
    expect(error.message).toBe(CANCELLED);
    const { pid, cwd } = onlyCall();
    expect(isAlive(pid)).toBe(false);
    expect(existsSync(cwd)).toBe(false);
  });

  it('cancels at once when the signal has already aborted', async () => {
    process.env.FAKE_MODE = 'sleep';
    const tmp = privateTmpdir();

    const error = await runError(runClaudeWriter(REQUEST, options({ signal: AbortSignal.abort() })));

    expect(error.kind).toBe('cancelled');
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('reports a missing claude binary and removes its temp directory', async () => {
    const tmp = privateTmpdir();

    const error = await runError(runClaudeWriter(REQUEST, options({ claudePath: '/nonexistent/claude' })));

    expect(error.kind).toBe('not-installed');
    expect(error.message).toBe('Claude Code not found at /nonexistent/claude');
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('refuses a relative claude path before doing anything', async () => {
    process.env.FAKE_MODE = 'structured';
    const tmp = privateTmpdir();

    const error = await runError(runClaudeWriter(REQUEST, options({ claudePath: 'bin/claude' })));

    expect(error.kind).toBe('not-installed');
    expect(error.message).toBe('Claude Code path must be absolute: bin/claude');
    expect(fakeCalls()).toEqual([]);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('logs one tagged line per run to stderr and nothing to stdout', async () => {
    process.env.FAKE_MODE = 'structured';

    await runClaudeWriter(REQUEST, options());

    expect(loggedLines()).toHaveLength(1);
    expect(loggedLines()[0]).toMatch(/^\[theseer-pdf\] claude -p model=opus effort=medium duration=\d+ms turns=1$/);
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe('runClaudeJson', () => {
  it('runs claude the same way as the writer and returns the parsed value', async () => {
    process.env.FAKE_MODE = 'score-structured';
    setBillingVars();

    const { value, durationMs } = await runClaudeJson(REQUEST, options({ model: 'haiku', effort: 'low' }), fitResultFromReply);

    expect(value).toEqual(VALID_FIT);
    expect(durationMs).toBeGreaterThanOrEqual(0);
    const call = onlyCall();
    expect(call.argv).toEqual(claudeArgs(REQUEST, options({ model: 'haiku', effort: 'low' })));
    expect(call.stdin).toBe(REQUEST.userMessage);
    expect(call.billingVars).toEqual([]);
    expect(existsSync(call.cwd)).toBe(false);
    expect(loggedLines()).toEqual([expect.stringMatching(/^\[theseer-pdf\] claude -p model=haiku effort=low duration=\d+ms turns=1$/)]);
  });

  it('hands parse the structured output and the result text', async () => {
    process.env.FAKE_MODE = 'structured';
    const seen: [unknown, string][] = [];

    await runClaudeJson(REQUEST, options(), (structured, text) => {
      seen.push([structured, text]);
      return 'parsed';
    });

    expect(seen).toEqual([[VALID, 'The resume is in structured_output.']]);
  });

  it('hands parse undefined when there is no structured output', async () => {
    process.env.FAKE_MODE = 'score-text';
    const seen: unknown[] = [];

    const { value } = await runClaudeJson(REQUEST, options(), (structured, text) => {
      seen.push(structured);
      return fitResultFromReply(structured, text);
    });

    expect(seen).toEqual([undefined]);
    expect(value).toEqual(VALID_FIT);
  });

  it('passes on the error parse throws', async () => {
    process.env.FAKE_MODE = 'score-invalid';

    const error = await runClaudeJson(REQUEST, options(), fitResultFromReply).then(
      () => null,
      (rejection: unknown) => rejection,
    );

    expect(error).toBeInstanceOf(ScoreFormatError);
    expect(existsSync(onlyCall().cwd)).toBe(false);
  });

  it("reports Claude's own message without calling parse", async () => {
    process.env.FAKE_MODE = 'error';

    const error = await runError(
      runClaudeJson(REQUEST, options(), () => {
        throw new Error('parse should not run');
      }),
    );

    expect(error.message).toBe(`Claude Code failed: ${USAGE_LIMIT}`);
  });

  it('names the task in the timeout message', async () => {
    process.env.FAKE_MODE = 'sleep';

    const error = await runError(runClaudeJson(REQUEST, options({ timeoutMs: 300, task: 'Job scoring' }), fitResultFromReply));

    expect(error.kind).toBe('timeout');
    expect(error.message).toMatch(/^Job scoring timed out after [\d.]+ min$/);
    expect(isAlive(onlyCall().pid)).toBe(false);
  });

  it('cancels a running claude when the signal aborts', async () => {
    process.env.FAKE_MODE = 'sleep';
    const controller = new AbortController();

    const run = runClaudeJson(REQUEST, options({ signal: controller.signal, task: 'Job scoring' }), fitResultFromReply);
    await waitForCall();
    controller.abort();
    const error = await runError(run);

    expect(error.kind).toBe('cancelled');
    expect(error.message).toBe(CANCELLED);
    expect(isAlive(onlyCall().pid)).toBe(false);
  });
});

describe('checkClaudeLogin', () => {
  it('passes when claude is logged in with the subscription, without billing variables', async () => {
    process.env.FAKE_MODE = 'auth-ok';
    setBillingVars();

    await checkClaudeLogin(FAKE_CLAUDE);

    const call = onlyCall();
    expect(call.argv).toEqual(['auth', 'status']);
    expect(call.hasApiKey).toBe(false);
    expect(call.billingVars).toEqual([]);
    expect(call.hasOauthToken).toBe(true);
  });

  it('rejects an API-key login with the subscription message', async () => {
    process.env.FAKE_MODE = 'auth-api';

    const error = await runError(checkClaudeLogin(FAKE_CLAUDE));

    expect(error.kind).toBe('not-logged-in');
    expect(error.message).toBe(NOT_SUBSCRIPTION_TEXT);
  });

  it('rejects a subscription login routed through another provider with the subscription message', async () => {
    process.env.FAKE_MODE = 'auth-bedrock';

    const error = await runError(checkClaudeLogin(FAKE_CLAUDE));

    expect(error.kind).toBe('not-logged-in');
    expect(error.message).toBe(NOT_SUBSCRIPTION_TEXT);
  });

  it('rejects a logged-out claude', async () => {
    process.env.FAKE_MODE = 'auth-out';

    const error = await runError(checkClaudeLogin(FAKE_CLAUDE));

    expect(error.kind).toBe('not-logged-in');
    expect(error.message).toBe(NOT_LOGGED_IN);
  });

  it('reports unreadable status output instead of guessing', async () => {
    process.env.FAKE_MODE = 'garbage';

    const error = await runError(checkClaudeLogin(FAKE_CLAUDE));

    expect(error.kind).toBe('bad-output');
    expect(error.message).toContain('(exit code 0)');
    expect(error.message).toContain(GARBAGE_STDERR);
  });

  it('reports a missing claude binary', async () => {
    const error = await runError(checkClaudeLogin('/nonexistent/claude'));

    expect(error.kind).toBe('not-installed');
    expect(error.message).toBe('Claude Code not found at /nonexistent/claude');
  });

  it('refuses a relative claude path', async () => {
    process.env.FAKE_MODE = 'auth-ok';

    const error = await runError(checkClaudeLogin('claude'));

    expect(error.kind).toBe('not-installed');
    expect(error.message).toBe('Claude Code path must be absolute: claude');
    expect(fakeCalls()).toEqual([]);
  });

  it('gives up on a status check that hangs', async () => {
    process.env.FAKE_MODE = 'sleep';

    const error = await runError(checkClaudeLogin(FAKE_CLAUDE, { timeoutMs: 300 }));

    expect(error.kind).toBe('timeout');
    expect(isAlive(onlyCall().pid)).toBe(false);
  });

  it('cancels a status check when the signal aborts', async () => {
    process.env.FAKE_MODE = 'sleep';
    const controller = new AbortController();

    const check = checkClaudeLogin(FAKE_CLAUDE, { signal: controller.signal });
    await waitForCall();
    controller.abort();
    const error = await runError(check);

    expect(error.kind).toBe('cancelled');
    expect(error.message).toBe(CANCELLED);
    expect(isAlive(onlyCall().pid)).toBe(false);
  });
});

describe('messages', () => {
  it('words the setup problems the way the setup page repeats them', () => {
    expect(CLAUDE_NOT_INSTALLED).toBe(NOT_INSTALLED_TEXT);
    expect(NOT_SUBSCRIPTION).toBe(NOT_SUBSCRIPTION_TEXT);
  });
});

describe('readClaudeAuth', () => {
  it('reports a logged-out claude as not logged in', async () => {
    process.env.FAKE_MODE = 'auth-bare-out';

    expect(await readClaudeAuth(FAKE_CLAUDE)).toEqual({ loggedIn: false, plan: null, problem: 'not-logged-in' });
  });

  it('reports an API-key login as not a subscription', async () => {
    process.env.FAKE_MODE = 'auth-api';

    expect(await readClaudeAuth(FAKE_CLAUDE)).toEqual({ loggedIn: true, plan: null, problem: 'not-subscription' });
  });

  it('reports a subscription login routed through another provider as not a subscription', async () => {
    process.env.FAKE_MODE = 'auth-bedrock';

    expect(await readClaudeAuth(FAKE_CLAUDE)).toEqual({ loggedIn: true, plan: null, problem: 'not-subscription' });
  });

  it('reports the plan of a subscription login', async () => {
    process.env.FAKE_MODE = 'auth-pro';

    expect(await readClaudeAuth(FAKE_CLAUDE)).toEqual({ loggedIn: true, plan: 'pro', problem: null });
  });

  it('leaves the plan empty when claude does not name one', async () => {
    process.env.FAKE_MODE = 'auth-no-plan';

    expect(await readClaudeAuth(FAKE_CLAUDE)).toEqual({ loggedIn: true, plan: null, problem: null });
  });

  it('runs `auth status` without billing variables', async () => {
    process.env.FAKE_MODE = 'auth-ok';
    setBillingVars();

    await readClaudeAuth(FAKE_CLAUDE);

    const call = onlyCall();
    expect(call.argv).toEqual(['auth', 'status']);
    expect(call.billingVars).toEqual([]);
  });

  it('reports unreadable status output instead of guessing', async () => {
    process.env.FAKE_MODE = 'garbage';

    expect((await runError(readClaudeAuth(FAKE_CLAUDE))).kind).toBe('bad-output');
  });

  it('gives up on a status check that hangs', async () => {
    process.env.FAKE_MODE = 'sleep';

    const error = await runError(readClaudeAuth(FAKE_CLAUDE, { timeoutMs: 300 }));

    expect(error.kind).toBe('timeout');
    expect(isAlive(onlyCall().pid)).toBe(false);
  });
});
