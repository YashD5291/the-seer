import { afterAll, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ClaudeAuth, ClaudeRunError } from './claude-runner';
import { type HostContext, loadConfig } from './config';
import { SetupError } from './setup-error';
import {
  addFile,
  chooseFolderWithDialog,
  type HelperStatus,
  helperStatus,
  openFolder,
  openInFinder,
  removeFile,
  type SetupDeps,
  setOutputDir,
} from './setup-commands';
import { HELPER_VERSION } from './version';

const tempRoot = mkdtempSync(join(tmpdir(), 'seer-setup-commands-'));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SUBSCRIBED: ClaudeAuth = { loggedIn: true, plan: 'max', problem: null };

// A fresh home with nothing set up; nothing below touches the real HOME.
function newHome(): string {
  return mkdtempSync(join(tempRoot, 'home-'));
}

function configPathOf(home: string): string {
  return join(home, '.theseer', 'config.json');
}

function context(home: string, overrides: Partial<HostContext> = {}): HostContext {
  return {
    config: {},
    outputBase: '',
    templatePath: join(home, 'template.tex'),
    baseDir: join(home, '.theseer'),
    home,
    env: {},
    ...overrides,
  };
}

function unexpected(name: string): () => never {
  return () => {
    throw new Error(`${name} should not be called`);
  };
}

function deps(ctx: HostContext, overrides: Partial<SetupDeps> = {}): SetupDeps {
  return {
    context: () => ctx,
    readClaudeAuth: unexpected('readClaudeAuth'),
    chooseFolder: unexpected('chooseFolder'),
    openPath: unexpected('openPath'),
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error)) throw new Error(`Expected a rejection with an Error, got ${String(error)}`);
  return error;
}

describe('helperStatus', () => {
  it('reports the version, Claude Code, the PDF builder, both folders and the files', async () => {
    const home = newHome();
    const claudePath = join(home, 'claude');
    writeFileSync(claudePath, '');
    const profileDir = join(home, 'My files');
    mkdirSync(profileDir);
    writeFileSync(join(profileDir, 'resume.md'), 'Alex Rivera built search systems');
    const outputDir = join(home, 'Resumes');
    const templatePath = join(home, 'template.tex');
    writeFileSync(templatePath, '\\documentclass{article}');
    const asked: Array<string | null> = [];
    const ctx = context(home, {
      config: { claudePath, profileDir, outputDir },
      outputBase: outputDir,
      templatePath,
      env: { THESEER_TECTONIC: '/tools/tectonic' },
    });

    const status = await helperStatus(
      deps(ctx, {
        readClaudeAuth: async (path) => {
          asked.push(path);
          return SUBSCRIBED;
        },
      }),
    );

    expect(asked).toEqual([claudePath]);
    expect(status).toEqual({
      version: HELPER_VERSION,
      claude: { path: claudePath, loggedIn: true, plan: 'max', problem: null },
      tectonic: { path: '/tools/tectonic' },
      template: { path: templatePath },
      profileDir,
      outputDir,
      files: [
        { name: 'resume.md', kind: 'text', words: 5, status: 'read', modified: expect.stringMatching(DATE), slot: null },
      ],
      profileProblem: null,
    });
  });

  it('reports a missing resume template as no path', async () => {
    const ctx = context(newHome());

    const status = await helperStatus(deps(ctx, { readClaudeAuth: async () => SUBSCRIBED }));

    expect(status.template).toEqual({ path: null });
  });

  it('reports why a resume could not be written from My files: no readable file', async () => {
    const home = newHome();
    const profileDir = join(home, 'My files');
    mkdirSync(profileDir);
    writeFileSync(join(profileDir, 'blank.txt'), '   ');
    const ctx = context(home, { config: { profileDir } });

    const status = await helperStatus(deps(ctx, { readClaudeAuth: async () => SUBSCRIBED }));

    expect(status.files.map((file) => file.status)).toEqual(['no-text']);
    expect(status.profileProblem).toBe(
      "No readable files in My files — open The Seer's setup page and add your resume",
    );
  });

  it('reports why a resume could not be written from My files: over the text limit, naming the largest files', async () => {
    const home = newHome();
    const profileDir = join(home, 'My files');
    mkdirSync(profileDir);
    writeFileSync(join(profileDir, 'big.md'), 'word '.repeat(60_001));
    writeFileSync(join(profileDir, 'cv.md'), 'Alex Rivera');
    const ctx = context(home, { config: { profileDir } });

    const status = await helperStatus(deps(ctx, { readClaudeAuth: async () => SUBSCRIBED }));

    expect(status.files.map((file) => file.status)).toEqual(['read', 'read']);
    expect(status.profileProblem).toContain('over the 300,000 limit');
    expect(status.profileProblem).toContain('Largest: big.md (60,001 words), cv.md (2 words)');
  });

  it('reports a Claude Code that is signed in the wrong way', async () => {
    const home = newHome();
    const claudePath = join(home, 'claude');
    writeFileSync(claudePath, '');
    const ctx = context(home, { config: { claudePath } });

    const status = await helperStatus(
      deps(ctx, { readClaudeAuth: async () => ({ loggedIn: true, plan: null, problem: 'not-subscription' }) }),
    );

    expect(status.claude).toEqual({ path: claudePath, loggedIn: true, plan: null, problem: 'not-subscription' });
  });

  it('reports no folders and no files while none is set', async () => {
    const ctx = context(newHome());

    const status = await helperStatus(deps(ctx, { readClaudeAuth: async () => SUBSCRIBED }));

    expect(status.profileDir).toBeNull();
    expect(status.outputDir).toBeNull();
    expect(status.files).toEqual([]);
    expect(status.profileProblem).toBe("My files folder not set — re-run the install command from The Seer's setup page");
  });

  it('lists no files, and does not throw, when the My files folder is not there yet', async () => {
    const home = newHome();
    const profileDir = join(home, 'My files');
    const ctx = context(home, { config: { profileDir } });

    const status = await helperStatus(deps(ctx, { readClaudeAuth: async () => SUBSCRIBED }));

    expect(status.profileDir).toBe(profileDir);
    expect(status.files).toEqual([]);
    expect(status.profileProblem).toBe(
      "No readable files in My files — open The Seer's setup page and add your resume",
    );
    expect(existsSync(profileDir)).toBe(false);
  });

  // findClaude also looks in the machine's own /opt/homebrew/bin and /usr/local/bin.
  const claudeOnThisMachine = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'].some(existsSync);

  it.skipIf(claudeOnThisMachine)('reports Claude Code as not installed when there is none, without asking it', async () => {
    const ctx = context(newHome());

    const status = await helperStatus(deps(ctx));

    expect(status.claude).toEqual({ path: null, loggedIn: false, plan: null, problem: 'not-installed' });
  });

  it('asks Claude Code with a 10 s limit', async () => {
    const home = newHome();
    const claudePath = join(home, 'claude');
    writeFileSync(claudePath, '');
    const limits: Array<number | undefined> = [];
    const ctx = context(home, { config: { claudePath } });

    await helperStatus(
      deps(ctx, {
        readClaudeAuth: async (_path, opts) => {
          limits.push(opts?.timeoutMs);
          return SUBSCRIBED;
        },
      }),
    );

    expect(limits).toEqual([10_000]);
  });
});

describe('helperStatus: what it can report when part of it fails', () => {
  // Captures what the helper logs to stderr while `run` works.
  async function logged<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      return { result: await run(), lines };
    } finally {
      console.error = original;
    }
  }

  function throwing(error: Error): SetupDeps['readClaudeAuth'] {
    return async () => {
      throw error;
    };
  }

  // A home with a Claude Code file, a My files folder holding one file, and a PDF builder.
  function homeWithClaude(): { ctx: HostContext; claudePath: string } {
    const home = newHome();
    const claudePath = join(home, 'claude');
    writeFileSync(claudePath, '');
    const profileDir = join(home, 'My files');
    mkdirSync(profileDir);
    writeFileSync(join(profileDir, 'resume.md'), 'Alex Rivera built search systems');
    const outputDir = join(home, 'Resumes');
    const ctx = context(home, {
      config: { claudePath, profileDir, outputDir },
      outputBase: outputDir,
      env: { THESEER_TECTONIC: '/tools/tectonic' },
    });
    return { ctx, claudePath };
  }

  it('reports Claude Code as unreadable, with the reason, when it times out, and still reports everything else', async () => {
    const { ctx, claudePath } = homeWithClaude();
    const timedOut = new ClaudeRunError('timeout', 'Claude Code login check timed out after 10 s');

    const { result: status, lines } = await logged(() =>
      helperStatus(deps(ctx, { readClaudeAuth: throwing(timedOut) })),
    );

    expect(status.claude).toEqual({
      path: claudePath,
      loggedIn: false,
      plan: null,
      problem: 'unreadable',
      detail: 'Claude Code login check timed out after 10 s',
    });
    expect(status.version).toBe(HELPER_VERSION);
    expect(status.tectonic).toEqual({ path: '/tools/tectonic' });
    expect(status.profileDir).toBe(ctx.config.profileDir ?? null);
    expect(status.outputDir).toBe(ctx.outputBase);
    expect(status.files.map((file) => file.name)).toEqual(['resume.md']);
    expect(lines).toEqual([expect.stringContaining('[theseer-pdf]')]);
    expect(lines[0]).toContain('timed out after 10 s');
  });

  it('reports unreadable for output it cannot use, and for a claude that cannot start', async () => {
    const { ctx } = homeWithClaude();
    const failures = [
      new ClaudeRunError('bad-output', 'Claude Code gave no usable reply (exit code 1) — stderr: error: unknown command auth'),
      new ClaudeRunError('failed', 'Claude Code could not start: spawn EACCES'),
    ];
    for (const failure of failures) {
      const { result } = await logged(() => helperStatus(deps(ctx, { readClaudeAuth: throwing(failure) })));
      expect(result.claude).toMatchObject({ problem: 'unreadable', detail: failure.message });
    }
  });

  it('puts the reason on one line', async () => {
    const { ctx } = homeWithClaude();
    const messy = new ClaudeRunError('bad-output', 'Claude Code gave no usable reply — stdout: line one\n  line two\n');

    const { result } = await logged(() => helperStatus(deps(ctx, { readClaudeAuth: throwing(messy) })));

    expect(result.claude.detail).toBe('Claude Code gave no usable reply — stdout: line one line two');
  });

  it('still fails when the check was cancelled, because nobody is waiting for the reply', async () => {
    const { ctx } = homeWithClaude();
    const cancelled = new ClaudeRunError('cancelled', 'Resume writing was cancelled.');

    const error = await rejection(helperStatus(deps(ctx, { readClaudeAuth: throwing(cancelled) })));

    expect(error).toBe(cancelled);
  });

  it('still fails on an error that is not Claude Code failing to answer', async () => {
    const { ctx } = homeWithClaude();
    const bug = new TypeError('something broke inside the helper');

    const error = await rejection(helperStatus(deps(ctx, { readClaudeAuth: throwing(bug) })));

    expect(error).toBe(bug);
  });

  it('lists no files, logs why, and still reports the rest, when My files is a file', async () => {
    const home = newHome();
    const claudePath = join(home, 'claude');
    writeFileSync(claudePath, '');
    const notAFolder = join(home, 'My files');
    writeFileSync(notAFolder, 'a file where the folder should be');
    const ctx = context(home, { config: { claudePath, profileDir: notAFolder }, outputBase: join(home, 'Resumes') });

    const { result: status, lines } = await logged(() =>
      helperStatus(deps(ctx, { readClaudeAuth: async () => SUBSCRIBED })),
    );

    expect(status.files).toEqual([]);
    expect(status.profileProblem).toContain(notAFolder);
    expect(status.profileDir).toBe(notAFolder);
    expect(status.outputDir).toBe(join(home, 'Resumes'));
    expect(status.claude).toEqual({ path: claudePath, loggedIn: true, plan: 'max', problem: null });
    expect(lines).toEqual([expect.stringContaining('[theseer-pdf]')]);
    expect(lines[0]).toContain(notAFolder);
  });

  it.skipIf(process.getuid?.() === 0)('lists no files, and logs why, when My files cannot be read', async () => {
    const home = newHome();
    const locked = join(home, 'My files');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    const ctx = context(home, { config: { profileDir: locked } });

    let outcome: Awaited<ReturnType<typeof logged<HelperStatus>>>;
    try {
      outcome = await logged(() => helperStatus(deps(ctx, { readClaudeAuth: async () => SUBSCRIBED })));
    } finally {
      chmodSync(locked, 0o700); // so the temp folder can be removed
    }
    const { result: status, lines } = outcome;

    expect(status.files).toEqual([]);
    expect(status.profileProblem).toContain('EACCES');
    expect(status.profileDir).toBe(locked);
    expect(lines).toEqual([expect.stringContaining('[theseer-pdf]')]);
    expect(lines[0]).toContain('EACCES');
  });

  it('reports both partial failures together', async () => {
    const home = newHome();
    const claudePath = join(home, 'claude');
    writeFileSync(claudePath, '');
    const notAFolder = join(home, 'My files');
    writeFileSync(notAFolder, 'x');
    const ctx = context(home, { config: { claudePath, profileDir: notAFolder } });
    const timedOut = new ClaudeRunError('timeout', 'Claude Code login check timed out after 10 s');

    const { result: status } = await logged(() => helperStatus(deps(ctx, { readClaudeAuth: throwing(timedOut) })));

    expect(status.claude.problem).toBe('unreadable');
    expect(status.files).toEqual([]);
  });
});

describe('addFile and removeFile', () => {
  it('stores the file in My files, dated with the lastModified it was given', async () => {
    const home = newHome();
    const profileDir = join(home, 'My files');
    const ctx = context(home, { config: { profileDir } });
    const lastModifiedMs = new Date(2024, 2, 5, 12, 0).getTime();

    const file = await addFile(deps(ctx), { name: 'cv.md', bytes: Buffer.from('Alex Rivera, engineer'), lastModifiedMs });

    expect(file).toEqual({ name: 'cv.md', kind: 'text', words: 3, status: 'read', modified: '2024-03-05', slot: null });
    expect(existsSync(join(profileDir, 'cv.md'))).toBe(true);
  });

  it('puts the file in the slot it was given, replacing the file that held it', async () => {
    const home = newHome();
    const profileDir = join(home, 'My files');
    const ctx = context(home, { config: { profileDir } });
    await addFile(deps(ctx), { name: 'old.md', bytes: Buffer.from('Old story'), slot: 'career-story' });

    const file = await addFile(deps(ctx), { name: 'new.md', bytes: Buffer.from('New story'), slot: 'career-story' });

    expect(file).toMatchObject({ name: 'new.md', slot: 'career-story' });
    expect(existsSync(join(profileDir, 'old.md'))).toBe(false);
    const status = await helperStatus(deps(ctx));
    expect(status.files.map((listed) => [listed.name, listed.slot])).toEqual([['new.md', 'career-story']]);
  });

  it('dates the file now when no lastModified comes with it', async () => {
    const home = newHome();
    const ctx = context(home, { config: { profileDir: join(home, 'My files') } });

    const file = await addFile(deps(ctx), { name: 'cv.md', bytes: Buffer.from('Alex Rivera') });

    expect(file.modified).toMatch(DATE);
    expect(file.modified).not.toBe('2024-03-05');
  });

  it('removes a file and answers with the files that are left', async () => {
    const home = newHome();
    const ctx = context(home, { config: { profileDir: join(home, 'My files') } });
    await addFile(deps(ctx), { name: 'old.md', bytes: Buffer.from('old') });
    await addFile(deps(ctx), { name: 'new.md', bytes: Buffer.from('new') });

    const files = await removeFile(deps(ctx), 'old.md');

    expect(files.map((file) => file.name)).toEqual(['new.md']);
  });

  it('fails with a setup error while My files is not set', async () => {
    const ctx = context(newHome());

    const added = await rejection(addFile(deps(ctx), { name: 'cv.md', bytes: Buffer.from('x') }));
    const removed = await rejection(removeFile(deps(ctx), 'cv.md'));

    expect(added).toBeInstanceOf(SetupError);
    expect(removed).toBeInstanceOf(SetupError);
  });
});

describe('setOutputDir', () => {
  it('saves a folder it can write to in the config and answers with it', async () => {
    const home = newHome();
    const folder = join(home, 'Resumes');
    mkdirSync(folder);
    mkdirSync(join(home, '.theseer'));
    writeFileSync(configPathOf(home), JSON.stringify({ profileDir: '/somewhere/My files', claudePath: '/bin/claude' }));
    const ctx = context(home, { config: { profileDir: '/somewhere/My files', claudePath: '/bin/claude' } });

    const saved = await setOutputDir(deps(ctx), folder);

    expect(saved).toBe(folder);
    expect(loadConfig(configPathOf(home))).toEqual({
      profileDir: '/somewhere/My files',
      claudePath: '/bin/claude',
      outputDir: folder,
    });
  });

  it('creates the config file when there is none yet', async () => {
    const home = newHome();
    const folder = join(home, 'Resumes');
    mkdirSync(folder);

    await setOutputDir(deps(context(home)), folder);

    expect(loadConfig(configPathOf(home))).toEqual({ outputDir: folder });
  });

  it('answers with the tidied path when it ends in a slash', async () => {
    const home = newHome();
    const folder = join(home, 'Resumes');
    mkdirSync(folder);

    expect(await setOutputDir(deps(context(home)), `${folder}/`)).toBe(folder);
    expect(loadConfig(configPathOf(home)).outputDir).toBe(folder);
  });

  it('refuses a relative path and saves nothing', async () => {
    const home = newHome();

    const error = await rejection(setOutputDir(deps(context(home)), 'Resumes'));

    expect(error).toBeInstanceOf(SetupError);
    expect(error.message).toContain('Resumes');
    expect(existsSync(configPathOf(home))).toBe(false);
  });

  it('refuses a folder that is not there and saves nothing', async () => {
    const home = newHome();
    const missing = join(home, 'Gone');

    const error = await rejection(setOutputDir(deps(context(home)), missing));

    expect(error).toBeInstanceOf(SetupError);
    expect(error.message).toContain(missing);
    expect(existsSync(configPathOf(home))).toBe(false);
  });

  it('refuses a file and saves nothing', async () => {
    const home = newHome();
    const file = join(home, 'notes.txt');
    writeFileSync(file, 'x');

    const error = await rejection(setOutputDir(deps(context(home)), file));

    expect(error).toBeInstanceOf(SetupError);
    expect(error.message).toContain('not a folder');
    expect(existsSync(configPathOf(home))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)('refuses a folder it cannot write to and saves nothing', async () => {
    const home = newHome();
    const folder = join(home, 'Locked');
    mkdirSync(folder);
    chmodSync(folder, 0o500);

    const error = await rejection(setOutputDir(deps(context(home)), folder));
    chmodSync(folder, 0o700);

    expect(error).toBeInstanceOf(SetupError);
    expect(error.message).toContain(folder);
    expect(existsSync(configPathOf(home))).toBe(false);
  });
});

describe('openFolder', () => {
  // Records the folder and whether it existed by the time it was opened.
  function opener(opened: Array<{ path: string; existed: boolean }>): SetupDeps['openPath'] {
    return async (path) => {
      opened.push({ path, existed: existsSync(path) });
    };
  }

  it('opens My files, creating it first when it is missing', async () => {
    const home = newHome();
    const profileDir = join(home, 'TheSeer', 'My files');
    const opened: Array<{ path: string; existed: boolean }> = [];
    const ctx = context(home, { config: { profileDir } });

    await openFolder(deps(ctx, { openPath: opener(opened) }), 'files');

    expect(opened).toEqual([{ path: profileDir, existed: true }]);
  });

  it('opens the resumes folder, creating it first when it is missing', async () => {
    const home = newHome();
    const outputDir = join(home, 'TheSeer', 'Resumes');
    const opened: Array<{ path: string; existed: boolean }> = [];
    const ctx = context(home, { outputBase: outputDir });

    await openFolder(deps(ctx, { openPath: opener(opened) }), 'resumes');

    expect(opened).toEqual([{ path: outputDir, existed: true }]);
  });

  it('opens a folder that is already there', async () => {
    const home = newHome();
    const profileDir = join(home, 'My files');
    mkdirSync(profileDir);
    const opened: Array<{ path: string; existed: boolean }> = [];

    await openFolder(deps(context(home, { config: { profileDir } }), { openPath: opener(opened) }), 'files');

    expect(opened).toEqual([{ path: profileDir, existed: true }]);
  });

  it('fails with a setup error, and opens nothing, while the folder is not set', async () => {
    const ctx = context(newHome());

    expect(await rejection(openFolder(deps(ctx), 'files'))).toBeInstanceOf(SetupError);
    expect(await rejection(openFolder(deps(ctx), 'resumes'))).toBeInstanceOf(SetupError);
  });

  it('says so when the folder cannot be created', async () => {
    const home = newHome();
    const blocker = join(home, 'blocker');
    writeFileSync(blocker, 'a file where a folder should go');
    const ctx = context(home, { config: { profileDir: join(blocker, 'My files') } });

    const error = await rejection(openFolder(deps(ctx), 'files'));

    expect(error).toBeInstanceOf(SetupError);
    expect(error.message).toContain(join(blocker, 'My files'));
  });
});

describe('chooseFolderWithDialog', () => {
  type Call = { command: string; args: string[] };

  it("brings the dialog to the front, asks for a folder with the setup page's prompt and answers with the path, without its trailing slash", async () => {
    const calls: Call[] = [];

    const path = await chooseFolderWithDialog(async (command, args) => {
      calls.push({ command, args });
      return '/Users/alex/Documents/Resumes/\n';
    });

    expect(path).toBe('/Users/alex/Documents/Resumes');
    expect(calls).toEqual([
      {
        command: '/usr/bin/osascript',
        args: [
          '-e',
          'tell me to activate',
          '-e',
          'POSIX path of (choose folder with prompt "Choose where The Seer saves resumes")',
        ],
      },
    ]);
  });

  it('answers null when the user cancels the dialog', async () => {
    const path = await chooseFolderWithDialog(async () => {
      throw Object.assign(new Error('Command failed: /usr/bin/osascript'), {
        stderr: '0:17: execution error: User canceled. (-128)\n',
      });
    });

    expect(path).toBeNull();
  });

  it('fails rather than guessing when the dialog names no folder', async () => {
    const error = await rejection(chooseFolderWithDialog(async () => '\n'));

    expect(error.message).toContain('folder');
  });

  it('fails, saying why, when the dialog cannot be shown', async () => {
    const error = await rejection(
      chooseFolderWithDialog(async () => {
        throw Object.assign(new Error('Command failed: /usr/bin/osascript'), {
          stderr: 'execution error: Not authorized to send Apple events. (-1743)\n',
        });
      }),
    );

    expect(error.message).toContain('folder dialog');
    expect(error.message).toContain('-1743');
  });
});

describe('openInFinder', () => {
  it('runs /usr/bin/open with the absolute path', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    await openInFinder('/Users/alex/TheSeer/Resumes', async (command, args) => {
      calls.push({ command, args });
      return '';
    });

    expect(calls).toEqual([{ command: '/usr/bin/open', args: ['/Users/alex/TheSeer/Resumes'] }]);
  });

  it('fails, saying why, when the folder cannot be opened', async () => {
    const error = await rejection(
      openInFinder('/Users/alex/TheSeer/Resumes', async () => {
        throw Object.assign(new Error('Command failed: /usr/bin/open'), {
          stderr: 'The file /Users/alex/TheSeer/Resumes does not exist.\n',
        });
      }),
    );

    expect(error.message).toContain('/Users/alex/TheSeer/Resumes');
    expect(error.message).toContain('does not exist');
  });
});
