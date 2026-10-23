import { afterAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPILE_TIMEOUT_MS, CompileError, compileLatex, parsePageCount } from './compile';
import { readPreamble, renderResumeLatex } from './latex';
import type { Bullet } from './resume-doc';
import { VALID } from './test-fixtures';

const REAL_TEMPLATE = fileURLToPath(new URL('../GEN/GEN-V3.tex', import.meta.url));
const TECTONIC = Bun.which('tectonic') ?? '';
const [JOB] = VALID.experience;

// Email, phone, LinkedIn and GitHub: the longest header a resume can have.
const ALEX = {
  name: 'Alex Rivera',
  contact: {
    email: 'alex.rivera@example.com',
    phone: '+1 (555) 010-0199',
    linkedin: 'linkedin.com/in/alex-rivera-example',
    github: 'github.com/alex-rivera-example',
  },
};

const tempDir = mkdtempSync(join(tmpdir(), 'seer-compile-'));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

function newWorkDir(): string {
  return mkdtempSync(join(tempDir, 'work-'));
}

// A stand-in for tectonic: a shell script that runs inside the work directory like the real one.
function fakeTectonic(body: string): string {
  const path = join(mkdtempSync(join(tempDir, 'bin-')), 'tectonic');
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf-8');
  chmodSync(path, 0o755);
  return path;
}

async function compileError(
  tex: string,
  tectonicPath: string,
  workDir: string = newWorkDir(),
  timeoutMs?: number,
): Promise<CompileError> {
  const error = await compileLatex(tex, { tectonicPath, workDir, timeoutMs }).then(
    () => null,
    (rejection: unknown) => rejection,
  );
  if (!(error instanceof CompileError)) throw new Error(`Expected a CompileError, got ${String(error)}`);
  return error;
}

describe('compileLatex timeout', () => {
  it('gives every compile five minutes by default, enough for a first run that downloads TeX files', () => {
    expect(COMPILE_TIMEOUT_MS).toBe(5 * 60_000);
  });

  it('stops tectonic after the timeout it was given and says how long that was', async () => {
    const error = await compileError('x', fakeTectonic('exec sleep 5'), newWorkDir(), 200);

    expect(error.message).toBe('tectonic timed out after 0.2s');
  });
});

describe('parsePageCount', () => {
  it('reads the plural form', () => {
    expect(parsePageCount('Output written on resume.xdv (2 pages, 41532 bytes).')).toBe(2);
  });

  it('reads the singular form', () => {
    expect(parsePageCount('Output written on resume.xdv (1 page, 9 bytes).')).toBe(1);
  });

  it('finds the line among the rest of a log', () => {
    const log = 'Overfull \\hbox (3.2pt too wide)\nOutput written on resume.xdv (3 pages, 70 bytes).\nSee you.';

    expect(parsePageCount(log)).toBe(3);
  });

  it('returns null when the log has no output line', () => {
    expect(parsePageCount('! Undefined control sequence.\nNo pages of output.')).toBeNull();
  });
});

describe('compileLatex failures that need no real tectonic', () => {
  it('rejects with the path when the binary does not exist', async () => {
    const missing = join(tempDir, 'no-such-dir', 'tectonic');

    const error = await compileError('\\relax', missing);

    expect(error.message).toBe(`tectonic not found at ${missing}`);
    expect(error.excerpt).toContain(missing);
  });

  it('falls back to the last 30 lines of stderr when the log has no error line', async () => {
    const tectonic = fakeTectonic('for i in $(seq 1 40); do echo "stderr line $i" >&2; done\nexit 1');

    const { excerpt } = await compileError('\\relax', tectonic);

    expect(excerpt).toContain('stderr line 40');
    expect(excerpt).toContain('stderr line 11');
    expect(excerpt).not.toContain('stderr line 10');
    expect(excerpt.split('\n')).toHaveLength(30);
  });

  it('ignores a log left in the work directory by an earlier compile', async () => {
    const workDir = newWorkDir();
    writeFileSync(join(workDir, 'resume.log'), '! Stale problem.\nl.1 old\n', 'utf-8');
    const tectonic = fakeTectonic('echo "fresh stderr" >&2\nexit 1');

    const { excerpt } = await compileError('\\relax', tectonic, workDir);

    expect(excerpt).toBe('fresh stderr');
  });

  it('takes each "!" line from the log with the two lines after it', async () => {
    const tectonic = fakeTectonic(
      'printf "fine\\n! First problem.\\nl.3 context\\n   more context\\nunrelated\\n! Second problem.\\nl.9 other\\n" > resume.log\nexit 1',
    );

    const { excerpt } = await compileError('\\relax', tectonic);

    expect(excerpt).toBe(
      '! First problem.\nl.3 context\n   more context\n! Second problem.\nl.9 other',
    );
  });

  it('runs tectonic with its own directory first on PATH', async () => {
    const tectonic = fakeTectonic('echo "PATH=$PATH" >&2\nexit 1');

    const { excerpt } = await compileError('\\relax', tectonic);

    expect(excerpt).toContain(`PATH=${dirname(tectonic)}:/opt/homebrew/bin:`);
  });

  it('rejects when tectonic succeeds but its log has no page count', async () => {
    const tectonic = fakeTectonic('printf "%%PDF-1.5" > resume.pdf\necho "nothing useful" > resume.log');

    const error = await compileError('\\relax', tectonic);

    expect(error.message).toBe('tectonic finished without reporting a page count');
    expect(error.excerpt).toContain('nothing useful');
  });

  it('returns the pdf and the page count from the log', async () => {
    const tectonic = fakeTectonic(
      'printf "%%PDF-1.5" > resume.pdf\necho "Output written on resume.xdv (4 pages, 1 bytes)." > resume.log',
    );

    const result = await compileLatex('\\relax', { tectonicPath: tectonic, workDir: newWorkDir() });

    expect(result.pages).toBe(4);
    expect(new TextDecoder().decode(result.pdf)).toBe('%PDF-1.5');
  });
});

describe.skipIf(!TECTONIC)('compileLatex with tectonic', () => {
  it('compiles a resume with every special character to one page', async () => {
    const bullets: Bullet[] = [
      { text: '[x] shipped', priority: 1 },
      { text: 'Cut p95 latency 40% for C++ & CUDA_kernels at $0 cost — {fast} ~ ^ é “quoted”', priority: 2 },
    ];
    const doc = { ...VALID, ...ALEX, experience: [{ ...JOB, bullets }] };
    const tex = renderResumeLatex(doc, readPreamble(REAL_TEMPLATE));

    const { pdf, pages } = await compileLatex(tex, { tectonicPath: TECTONIC, workDir: newWorkDir() });

    expect(pages).toBe(1);
    expect(new TextDecoder().decode(pdf.slice(0, 4))).toBe('%PDF');
  }, 120_000);

  it('rejects with the TeX error when the document uses an undefined macro', async () => {
    const tex = '\\documentclass{article}\n\\begin{document}\nhi \\undefinedmacro there\n\\end{document}\n';

    const error = await compileError(tex, TECTONIC);

    expect(error.excerpt).toContain('Undefined control sequence');
    expect(error.excerpt).toContain('\\undefinedmacro');
  }, 120_000);
});
