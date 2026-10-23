import { afterAll, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeHostManifestPath } from './setup';
import { VALID_FIT } from './test-fixtures';

const MAIN = fileURLToPath(new URL('../main.ts', import.meta.url));

// Runs the CLI with a terminal on stdin, as when someone types the command without a reply file.
// A terminal carries stdout and stderr together, so `output` holds both.
async function runOnTerminal(args: string[]): Promise<{ output: string; exitCode: number }> {
  const decoder = new TextDecoder();
  let output = '';
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    terminal: {
      cols: 200,
      rows: 50,
      data: (_terminal, data) => {
        output += decoder.decode(data);
      },
    },
  });
  const exitCode = await proc.exited;
  return { output, exitCode };
}

function jsonLines(output: string): unknown[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith('{'))
    .map((line): unknown => JSON.parse(line));
}

describe.skipIf(process.platform === 'win32')('theseer-pdf with no reply to read', () => {
  it('prints a JSON error, not the usage text, when --json is given', async () => {
    const { output, exitCode } = await runOnTerminal(['--json']);

    expect(jsonLines(output)).toEqual([{ success: false, error: expect.stringContaining('No reply') }]);
    expect(output).not.toContain('Usage:');
    expect(exitCode).toBe(1);
  });

  it('prints the usage text without --json', async () => {
    const { output, exitCode } = await runOnTerminal([]);

    expect(output).toContain('Usage:');
    expect(jsonLines(output)).toEqual([]);
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// --score and --write's threshold, against a stand-in for `claude`
// ---------------------------------------------------------------------------

const cliRoot = mkdtempSync(join(tmpdir(), 'seer-cli-'));
afterAll(() => rmSync(cliRoot, { recursive: true, force: true }));

const LOGGED_IN = '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}';
const JOB_TEXT = 'Acme AI is hiring an ML Engineer to build RAG systems.';

type CliHome = { home: string; jobFile: string; outDir: string; claudeLog: string; scorerArgs: string; scorerStdin: string };

// A HOME whose ~/.theseer/config.json points at a fake claude and a two-document My files folder. The fake logs
// each call as auth, scorer or writer, saves the scorer's args and stdin, and scores VALID_FIT.
function cliHome(fitScore = VALID_FIT.fit_score): CliHome {
  const home = mkdtempSync(join(cliRoot, 'home-'));
  const claudeLog = join(home, 'claude.log');
  const scorerArgs = join(home, 'scorer-args');
  const scorerStdin = join(home, 'scorer-stdin');
  const scoreReply = join(home, 'score-reply.json');
  const claudePath = join(home, 'claude');
  const structured = { ...VALID_FIT, recommended_base: 'mle', fit_score: fitScore };
  writeFileSync(scoreReply, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: structured }));
  writeFileSync(
    claudePath,
    [
      '#!/bin/sh',
      'case "$*" in',
      '  auth*) call=auth ;;',
      `  *fit_score*) call=scorer; printf '%s\\n' "$@" > "${scorerArgs}"; cat > "${scorerStdin}" ;;`,
      '  *) call=writer ;;',
      'esac',
      `echo "$call" >> "${claudeLog}"`,
      `if [ "$call" = auth ]; then echo '${LOGGED_IN}'; fi`,
      `if [ "$call" = scorer ]; then cat "${scoreReply}"; fi`,
    ].join('\n'),
    'utf-8',
  );
  chmodSync(claudePath, 0o755);

  const profileDir = join(home, 'profile');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, 'career-story.md'), 'I build retrieval systems.');
  writeFileSync(join(profileDir, 'resume.md'), 'MLE resume');
  mkdirSync(join(home, '.theseer'));
  writeFileSync(join(home, '.theseer', 'config.json'), JSON.stringify({ claudePath, profileDir }));
  const jobFile = join(home, 'job.txt');
  writeFileSync(jobFile, JOB_TEXT);
  return { home, jobFile, outDir: join(home, 'out'), claudeLog, scorerArgs, scorerStdin };
}

async function runCli(
  args: string[],
  cli: CliHome,
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    env: {
      ...process.env,
      HOME: cli.home,
      THESEER_OUTPUT: cli.outDir,
      THESEER_TECTONIC: join(cli.home, 'tectonic'),
      ...extraEnv,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function claudeCalls(cli: CliHome): string[] {
  return existsSync(cli.claudeLog) ? readFileSync(cli.claudeLog, 'utf-8').trim().split('\n') : [];
}

function argAfter(cli: CliHome, flag: string): string | undefined {
  const args = readFileSync(cli.scorerArgs, 'utf-8').split('\n');
  return args[args.indexOf(flag) + 1];
}

describe.skipIf(process.platform === 'win32')('theseer-pdf --version', () => {
  it('prints the version and nothing else, exit code 0', async () => {
    const { stdout, stderr, exitCode } = await runCli(['--version'], cliHome());

    expect(stdout).toBe('1.0.0\n');
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });
});

describe.skipIf(process.platform === 'win32')('theseer-pdf --score', () => {
  it('prints the fit score JSON on stdout and exits 0', async () => {
    const cli = cliHome();

    const { stdout, exitCode } = await runCli(
      ['--score', cli.jobFile, '--url', 'https://jobs.example.com/9', '--title', 'ML Engineer'],
      cli,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ ...VALID_FIT, recommended_base: 'mle' });
    expect(claudeCalls(cli)).toEqual(['auth', 'scorer']);
    const stdin = readFileSync(cli.scorerStdin, 'utf-8');
    expect(stdin).toContain(JOB_TEXT);
    expect(stdin).toContain('url="https://jobs.example.com/9"');
    expect(stdin).toContain('title="ML Engineer"');
  });

  it('scores with Haiku at low effort unless told otherwise', async () => {
    const cli = cliHome();

    await runCli(['--score', cli.jobFile], cli);
    expect([argAfter(cli, '--model'), argAfter(cli, '--effort')]).toEqual(['haiku', 'low']);

    await runCli(['--score', cli.jobFile, '--model', 'sonnet', '--effort', 'medium'], cli);
    expect([argAfter(cli, '--model'), argAfter(cli, '--effort')]).toEqual(['sonnet', 'medium']);
  });

  it('fails with exit code 1 when the job file is missing', async () => {
    const cli = cliHome();

    const { stdout, stderr, exitCode } = await runCli(['--score', join(cli.home, 'gone.txt')], cli);

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('File not found');
    expect(claudeCalls(cli)).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('theseer-pdf --write scores first', () => {
  it('stops below --min-score without writing or creating a folder', async () => {
    const cli = cliHome(78);

    const { stdout, exitCode } = await runCli(['--write', cli.jobFile, '--min-score', '90'], cli);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Fit score: 78/100');
    expect(stdout).toContain('below 90');
    expect(claudeCalls(cli)).toEqual(['auth', 'scorer']);
    expect(existsSync(cli.outDir) ? readdirSync(cli.outDir) : []).toEqual([]);
  });

  it('skips below the default threshold of 40', async () => {
    const cli = cliHome(39);

    const { stdout } = await runCli(['--write', cli.jobFile], cli);

    expect(stdout).toContain('below 40');
    expect(claudeCalls(cli)).toEqual(['auth', 'scorer']);
  });

  it('goes on to the writer with --min-score 0', async () => {
    const cli = cliHome(0);

    const { exitCode } = await runCli(['--write', cli.jobFile, '--min-score', '0'], cli);

    expect(claudeCalls(cli)).toEqual(['auth', 'scorer', 'writer']);
    expect(exitCode).toBe(1); // the fake writer replies with nothing usable
  });

  it('rejects a --min-score outside 0 to 100', async () => {
    const cli = cliHome();

    const { stderr, exitCode } = await runCli(['--write', cli.jobFile, '--min-score', '150'], cli);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('minScore must be a whole number from 0 to 100');
    expect(claudeCalls(cli)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// --set-profile
// ---------------------------------------------------------------------------

function savedProfileDir(cli: CliHome): unknown {
  const config: unknown = JSON.parse(readFileSync(join(cli.home, '.theseer', 'config.json'), 'utf-8'));
  return typeof config === 'object' && config !== null && 'profileDir' in config ? config.profileDir : undefined;
}

describe('theseer-pdf --set-profile', () => {
  it('saves the folder and lists the documents it read', async () => {
    const cli = cliHome();
    const folder = mkdtempSync(join(cliRoot, 'my-files-'));
    writeFileSync(join(folder, 'resume.md'), '# Alex Rivera');
    writeFileSync(join(folder, 'notes.txt'), 'Built a search service.');

    const { stdout, exitCode } = await runCli(['--set-profile', folder], cli);

    expect(stdout).toContain('Documents: notes.txt, resume.md');
    expect(savedProfileDir(cli)).toBe(folder);
    expect(exitCode).toBe(0);
  });

  it('refuses a folder with no readable files and keeps the old one', async () => {
    const cli = cliHome();
    const before = savedProfileDir(cli);
    const folder = mkdtempSync(join(cliRoot, 'my-files-'));

    const { stderr, exitCode } = await runCli(['--set-profile', folder], cli);

    expect(stderr).toContain('No readable files in My files');
    expect(savedProfileDir(cli)).toBe(before);
    expect(exitCode).toBe(1);
  });
});

describe('theseer-pdf --setup', () => {
  // The PATH has no claude, so the one in the config stays; HOME is the temp folder, never the real one.
  const CLEAN_PATH = { PATH: '/usr/bin:/bin' };

  function savedOutputDir(cli: CliHome): unknown {
    const config: unknown = JSON.parse(readFileSync(join(cli.home, '.theseer', 'config.json'), 'utf-8'));
    return typeof config === 'object' && config !== null && 'outputDir' in config ? config.outputDir : undefined;
  }

  it('registers the helper under HOME and fills the default folders', async () => {
    const cli = cliHome();

    const { stdout, exitCode } = await runCli(['--setup', '--no-warm-up'], cli, CLEAN_PATH);

    expect(stdout).toContain(`[theseer-pdf] Helper registered with Chrome: ${chromeHostManifestPath(cli.home)}`);
    expect(existsSync(chromeHostManifestPath(cli.home))).toBe(true);
    expect(savedOutputDir(cli)).toBe(join(cli.home, 'TheSeer', 'Resumes'));
    expect(existsSync(join(cli.home, 'TheSeer', 'Resumes'))).toBe(true);
    expect(exitCode).toBe(0);
  });

  it('no longer takes an extension id or an output folder', async () => {
    const cli = cliHome();

    const { stdout } = await runCli(['--help'], cli);

    expect(stdout).not.toContain('--output-dir');
    expect(stdout).not.toContain('extension-id');
  });
});
