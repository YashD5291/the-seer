import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeRunError } from './claude-runner';
import { CompileError } from './compile';
import { CONFIG_FIX, ConfigError } from './config';
import {
  type BuildOptions,
  buildResume,
  type GenerateResult,
  generateResume,
  type HostMessage,
  recompileTex,
  toNativeError,
  type WriteDeps,
  type WriteRequest,
  writeResume,
} from './generate';
import { resumeNotes } from './notes';
import type { Profile } from './profile';
import { type ResumeDoc, ResumeFormatError } from './resume-doc';
import { type FitResult, ScoreFormatError } from './scorer/request';
import { ProfileError, SetupError } from './setup-error';
import {
  onePageTectonic,
  REAL_TEMPLATE,
  VALID,
  VALID_ANALYSIS,
  VALID_CHANGELOG,
  VALID_FIT,
  waitUntil,
} from './test-fixtures';
import type { WriterRequest } from './writer/request';

const TECTONIC = Bun.which('tectonic') ?? '';
const FOLDER = 'Acme AI - ML Engineer';
const UPLOAD = 'Alex_Rivera_Resume.pdf';
const REFUSAL = 'Refusing to write outside the output folder';

const tempDir = mkdtempSync(join(tmpdir(), 'seer-generate-'));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

function newDir(prefix: string): string {
  return mkdtempSync(join(tempDir, prefix));
}

// A stand-in for tectonic. It logs each run to `runs`, reports 2 pages while the resume still has
// the priority 3 "Mentored" bullet and 1 page without it, and writes a small fake PDF.
function fakeTectonic(): { path: string; runs: () => number } {
  const dir = newDir('bin-');
  const runsFile = join(dir, 'runs');
  const path = join(dir, 'tectonic');
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      `echo run >> "${runsFile}"`,
      'if grep -q Mentored resume.tex; then n=2; else n=1; fi',
      'printf "Output written on resume.xdv (%s pages, 10 bytes).\\n" "$n" > resume.log',
      'printf "%%PDF-fake-$n" > resume.pdf',
    ].join('\n'),
    'utf-8',
  );
  chmodSync(path, 0o755);
  const runs = (): number =>
    existsSync(runsFile) ? readFileSync(runsFile, 'utf-8').trim().split('\n').length : 0;
  return { path, runs };
}

function failingTectonic(): string {
  const path = join(newDir('bin-'), 'tectonic');
  writeFileSync(path, '#!/bin/sh\necho "! Undefined control sequence." > resume.log\nexit 1\n', 'utf-8');
  chmodSync(path, 0o755);
  return path;
}

function options(tectonicPath: string, overrides: Partial<BuildOptions> = {}): BuildOptions {
  return {
    outputBase: newDir('out-'),
    templatePath: REAL_TEMPLATE,
    tectonicPath,
    maxPages: 1,
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

// ---------------------------------------------------------------------------
// writeResume
// ---------------------------------------------------------------------------

const PROFILE: Profile = {
  documents: [
    { name: 'resume.pdf', modified: '2026-05-01', text: 'Alex Rivera\nI build retrieval systems.', kind: 'resume' },
  ],
};
const DOCUMENT_TAG = '<document name="resume.pdf" kind="resume" modified="2026-05-01">';

const REQUEST: WriteRequest = {
  command: 'write',
  job: { text: 'We need an ML engineer who knows RAG.', url: 'https://jobs.example.com/1', title: 'ML Engineer' },
  model: 'haiku',
  effort: 'low',
  maxPages: 2,
  scoreModel: 'haiku',
  scoreEffort: 'low',
  minScore: 40,
};

const { job: FIT_JOB, ...FIT_ANALYSIS } = VALID_FIT;
const SCORE_MESSAGE: HostMessage = { type: 'score', analysis: FIT_ANALYSIS, job: FIT_JOB };

const RESULT: GenerateResult = {
  success: true,
  folderName: FOLDER,
  folderPath: `/out/${FOLDER}`,
  texPath: `/out/${FOLDER}/${FOLDER}.tex`,
  pdfPath: `/out/${FOLDER}/${FOLDER}.pdf`,
  uploadPdfPath: `/out/${FOLDER}/${UPLOAD}`,
  pages: 1,
  fits: true,
  trimmedBullets: 0,
  latexSource: '\\documentclass{article}',
  pdfBase64: 'JVBERg==',
  pdfSizeBytes: 4,
  resumeText: 'Built a RAG pipeline answering 2M queries per month.',
  keywords: ['RAG'],
};

function fakeDeps(overrides: Partial<WriteDeps> = {}): WriteDeps {
  return {
    loadProfile: async () => PROFILE,
    checkLogin: async () => undefined,
    runScorer: async () => ({ value: VALID_FIT }),
    runWriter: async () => ({ doc: VALID }),
    build: async (_doc, onStage) => {
      onStage('compiling');
      onStage('fitting');
      return RESULT;
    },
    ...overrides,
  };
}

async function messagesOf(deps: WriteDeps, req: WriteRequest = REQUEST): Promise<HostMessage[]> {
  const sent: HostMessage[] = [];
  await writeResume(req, deps, (message) => sent.push(message));
  return sent;
}

function scoring(fitScore: number): Pick<WriteDeps, 'runScorer'> {
  return { runScorer: async () => ({ value: { ...VALID_FIT, fit_score: fitScore } }) };
}

function never(name: string): () => never {
  return () => {
    throw new Error(`${name} should not be called`);
  };
}

describe('writeResume', () => {
  it('checks the login, scores, sends the score, then writes and builds', async () => {
    expect(await messagesOf(fakeDeps())).toStrictEqual([
      { type: 'progress', stage: 'checking-login' },
      { type: 'progress', stage: 'scoring' },
      SCORE_MESSAGE,
      { type: 'progress', stage: 'writing' },
      { type: 'progress', stage: 'compiling' },
      { type: 'progress', stage: 'fitting' },
      { type: 'result', ...RESULT },
    ]);
  });

  it('builds the score request from the profile and the job', async () => {
    const requests: WriterRequest[] = [];
    await messagesOf(
      fakeDeps({
        runScorer: async (req) => {
          requests.push(req);
          return { value: VALID_FIT };
        },
      }),
    );
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.systemPrompt).toContain(`${DOCUMENT_TAG}\nAlex Rivera\nI build retrieval systems.`);
    expect(request.userMessage).toContain(REQUEST.job.text);
    expect(request.userMessage).not.toContain('Page budget');
    expect(JSON.stringify(request.schema)).toContain('fit_score');
  });

  it('skips the job when the score is below the threshold: no writer, no build', async () => {
    const low: FitResult = { ...VALID_FIT, fit_score: 39 };
    const { job, ...analysis } = low;
    const sent = await messagesOf(
      fakeDeps({ runScorer: async () => ({ value: low }), runWriter: never('runWriter'), build: never('build') }),
    );
    expect(sent).toStrictEqual([
      { type: 'progress', stage: 'checking-login' },
      { type: 'progress', stage: 'scoring' },
      { type: 'score', analysis, job },
      { type: 'skipped', score: 39, threshold: 40 },
    ]);
  });

  it('writes when the score equals the threshold', async () => {
    const sent = await messagesOf(fakeDeps(scoring(40)));
    expect(sent.at(-1)).toStrictEqual({ type: 'result', ...RESULT });
  });

  it('honors the request threshold', async () => {
    const sent = await messagesOf(fakeDeps({ ...scoring(78), runWriter: never('runWriter') }), { ...REQUEST, minScore: 90 });
    expect(sent.at(-1)).toStrictEqual({ type: 'skipped', score: 78, threshold: 90 });
  });

  it('always writes with a threshold of 0', async () => {
    const sent = await messagesOf(fakeDeps(scoring(0)), { ...REQUEST, minScore: 0 });
    expect(sent.at(-1)).toStrictEqual({ type: 'result', ...RESULT });
  });

  it('ends with the scorer error and never writes when scoring fails', async () => {
    const sent = await messagesOf(
      fakeDeps({
        runScorer: async () => {
          throw new ScoreFormatError('invalid', 'Fit score JSON failed validation: gaps must be an array of strings', [
            'gaps must be an array of strings',
          ]);
        },
        runWriter: never('runWriter'),
        build: never('build'),
      }),
    );
    expect(sent).toStrictEqual([
      { type: 'progress', stage: 'checking-login' },
      { type: 'progress', stage: 'scoring' },
      {
        type: 'error',
        error: 'Fit score JSON failed validation: gaps must be an array of strings',
        details: 'gaps must be an array of strings',
      },
    ]);
  });

  describe('notes.md', () => {
    // A build that leaves a real, empty job folder, as buildResume does before the files go in.
    function folderBuild(): { folder: string; build: WriteDeps['build'] } {
      const folder = newDir('job-');
      return { folder, build: async () => ({ ...RESULT, folderPath: folder }) };
    }

    it('writes the analysis and the changelog to notes.md in the job folder before the result', async () => {
      const { folder, build } = folderBuild();
      const doc: ResumeDoc = { ...VALID, analysis: VALID_ANALYSIS, changelog: VALID_CHANGELOG };
      const notesPath = join(folder, 'notes.md');
      let notesAtResult = false;

      await writeResume(REQUEST, fakeDeps({ runWriter: async () => ({ doc }), build }), (message) => {
        if (message.type === 'result') notesAtResult = existsSync(notesPath);
      });

      expect(notesAtResult).toBe(true);
      expect(readFileSync(notesPath, 'utf-8')).toBe(resumeNotes(doc) ?? '');
      expect(readFileSync(notesPath, 'utf-8')).toContain('## Tone calibration');
      expect(readFileSync(notesPath, 'utf-8')).toContain(`- ${VALID_CHANGELOG[0]}`);
    });

    it('writes no notes.md for a reply without an analysis or a changelog', async () => {
      const { folder, build } = folderBuild();

      const sent = await messagesOf(fakeDeps({ build }));

      expect(sent.at(-1)).toMatchObject({ type: 'result' });
      expect(readdirSync(folder)).toEqual([]);
    });

    it('still sends the finished resume when notes.md cannot be written, and logs why', async () => {
      const doc: ResumeDoc = { ...VALID, analysis: VALID_ANALYSIS, changelog: VALID_CHANGELOG };
      const missing = join(newDir('job-'), 'gone');
      const result = { ...RESULT, folderPath: missing };
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

      try {
        const sent = await messagesOf(fakeDeps({ runWriter: async () => ({ doc }), build: async () => result }));
        const logged = errorSpy.mock.calls.map((args) => args.join(' '));
        const notesLine = logged.find((line) => line.includes('notes.md'));

        expect(sent.at(-1)).toStrictEqual({ type: 'result', ...result });
        expect(sent.some((message) => message.type === 'error')).toBe(false);
        expect(notesLine).toBeDefined();
        expect(notesLine).toStartWith(`[theseer-pdf] notes.md not written to ${missing}:`);
        expect(notesLine).toContain('ENOENT');
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  it('builds the writer request from the profile, the job and the page budget', async () => {
    let request: WriterRequest | null = null;
    await messagesOf(
      fakeDeps({
        runWriter: async (req) => {
          request = req;
          return { doc: VALID };
        },
      }),
    );
    const { systemPrompt, userMessage } = request ?? { systemPrompt: '', userMessage: '' };
    expect(systemPrompt).toContain(`${DOCUMENT_TAG}\nAlex Rivera\nI build retrieval systems.`);
    expect(userMessage).toContain(REQUEST.job.text);
    expect(userMessage).toContain('Page budget: 2 page(s).');
  });

  it('adds the extra instructions to the writer request only, not to the scorer request', async () => {
    const scorerRequests: WriterRequest[] = [];
    const writerRequests: WriterRequest[] = [];
    await messagesOf(
      fakeDeps({
        runScorer: async (req) => {
          scorerRequests.push(req);
          return { value: VALID_FIT };
        },
        runWriter: async (req) => {
          writerRequests.push(req);
          return { doc: VALID };
        },
      }),
      { ...REQUEST, writerNotes: 'Keep my publications section.' },
    );
    expect(writerRequests[0].systemPrompt).toContain('<extra_instructions>\nKeep my publications section.\n</extra_instructions>');
    expect(scorerRequests[0].systemPrompt).not.toContain('extra_instructions');
  });

  it('writes without an extra_instructions block when the request has no writerNotes', async () => {
    const writerRequests: WriterRequest[] = [];
    await messagesOf(
      fakeDeps({
        runWriter: async (req) => {
          writerRequests.push(req);
          return { doc: VALID };
        },
      }),
    );
    expect(writerRequests[0].systemPrompt).not.toContain('\n<extra_instructions>\n');
  });

  it("gives the writer the score's ats_keywords as screening terms", async () => {
    const writerRequests: WriterRequest[] = [];
    await messagesOf(
      fakeDeps({
        runWriter: async (req) => {
          writerRequests.push(req);
          return { doc: VALID };
        },
      }),
    );
    expect(writerRequests[0].userMessage).toContain('<screening_terms>\nRAG\nLLM\nPyTorch\n</screening_terms>');
  });

  it('trims the screening terms, drops empty and repeated ones and keeps at most 25', async () => {
    const many = Array.from({ length: 30 }, (_, index) => `term ${index + 1}`);
    const keywords = ['  RAG ', 'RAG', '', '   ', 'PyTorch', 'RAG', ...many];
    const writerRequests: WriterRequest[] = [];
    await messagesOf(
      fakeDeps({
        runScorer: async () => ({ value: { ...VALID_FIT, ats_keywords: keywords } }),
        runWriter: async (req) => {
          writerRequests.push(req);
          return { doc: VALID };
        },
      }),
    );
    const expected = ['RAG', 'PyTorch', ...many.slice(0, 23)];
    expect(writerRequests[0].userMessage).toContain(`<screening_terms>\n${expected.join('\n')}\n</screening_terms>`);
  });

  it('sends no screening_terms block when the score has no keywords', async () => {
    const writerRequests: WriterRequest[] = [];
    await messagesOf(
      fakeDeps({
        runScorer: async () => ({ value: { ...VALID_FIT, ats_keywords: ['', '  '] } }),
        runWriter: async (req) => {
          writerRequests.push(req);
          return { doc: VALID };
        },
      }),
    );
    expect(writerRequests[0].userMessage).not.toContain('screening_terms');
  });

  it('hands the doc Claude wrote to the build', async () => {
    const built: ResumeDoc[] = [];
    await messagesOf(
      fakeDeps({
        build: async (doc) => {
          built.push(doc);
          return RESULT;
        },
      }),
    );
    expect(built).toEqual([VALID]);
  });

  it('ends with the writer error and no result when writing fails', async () => {
    const sent = await messagesOf(
      fakeDeps({
        runWriter: async () => {
          throw new ClaudeRunError('failed', 'Claude Code failed: usage limit');
        },
      }),
    );
    expect(sent).toStrictEqual([
      { type: 'progress', stage: 'checking-login' },
      { type: 'progress', stage: 'scoring' },
      SCORE_MESSAGE,
      { type: 'progress', stage: 'writing' },
      { type: 'error', error: 'Claude Code failed: usage limit' },
    ]);
  });

  it('loads the profile first: a profile error is the only message', async () => {
    const message = "My files folder not set — re-run the install command from The Seer's setup page";
    const sent = await messagesOf(
      fakeDeps({
        loadProfile: async () => {
          throw new ProfileError(message);
        },
      }),
    );
    expect(sent).toStrictEqual([{ type: 'error', error: message, needsSetup: true }]);
  });

  it('stops after checking-login when the login check fails', async () => {
    const sent = await messagesOf(
      fakeDeps({
        checkLogin: async () => {
          throw new ClaudeRunError('not-logged-in', 'not logged in');
        },
        runScorer: never('runScorer'),
      }),
    );
    expect(sent).toStrictEqual([
      { type: 'progress', stage: 'checking-login' },
      { type: 'error', error: 'not logged in', needsSetup: true },
    ]);
  });

  it('sends the LaTeX excerpt as details when the compile fails', async () => {
    const sent = await messagesOf(
      fakeDeps({
        build: async (_doc, onStage) => {
          onStage('compiling');
          throw new CompileError('tectonic failed to compile the resume', '! Undefined control sequence.');
        },
      }),
    );
    expect(sent.at(-1)).toStrictEqual({
      type: 'error',
      error: 'tectonic failed to compile the resume',
      details: '! Undefined control sequence.',
    });
  });
});

// ---------------------------------------------------------------------------
// toNativeError
// ---------------------------------------------------------------------------

describe('toNativeError', () => {
  it('says "Unknown error in the helper" for a failure with no words', () => {
    expect(toNativeError(new Error('  '))).toStrictEqual({ type: 'error', error: 'Unknown error in the helper' });
    expect(toNativeError(undefined)).toStrictEqual({ type: 'error', error: 'Unknown error in the helper' });
  });

  it('puts the fix for a broken config.json in details and needs setup', () => {
    const error = new ConfigError('/home/.theseer/config.json must hold a JSON object');
    expect(toNativeError(error)).toStrictEqual({
      type: 'error',
      error: '/home/.theseer/config.json must hold a JSON object',
      details: CONFIG_FIX,
      needsSetup: true,
    });
  });

  it('joins the problems of a ResumeFormatError into details', () => {
    const error = new ResumeFormatError('invalid', 'The resume JSON failed validation', ['name is empty', 'no jobs']);
    expect(toNativeError(error)).toStrictEqual({
      type: 'error',
      error: 'The resume JSON failed validation',
      details: 'name is empty\nno jobs',
    });
  });

  it('caps a compile excerpt at 40 lines', () => {
    const excerpt = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n');
    const { details } = toNativeError(new CompileError('tectonic failed to compile the resume', excerpt));
    expect(details?.split('\n')).toHaveLength(40);
    expect(details?.startsWith('line 1\n')).toBe(true);
  });

  it('caps details at 4000 characters and marks the cut with an ellipsis', () => {
    const problems = ['x'.repeat(2500), 'y'.repeat(2500)];
    const { details } = toNativeError(new ResumeFormatError('invalid', 'The resume JSON failed validation', problems));
    expect(details).toHaveLength(4001);
    expect(details?.endsWith('…')).toBe(true);
    expect(details?.startsWith(problems[0])).toBe(true);
  });

  it('keeps details of exactly 4000 characters whole', () => {
    const problem = 'z'.repeat(4000);
    const { details } = toNativeError(new ResumeFormatError('invalid', 'The resume JSON failed validation', [problem]));
    expect(details).toBe(problem);
  });

  it('flags a setup problem so the extension can offer "Open setup"', () => {
    expect(toNativeError(new SetupError('no folder'))).toStrictEqual({
      type: 'error',
      error: 'no folder',
      needsSetup: true,
    });
    expect(toNativeError(new ProfileError('no profile'))).toStrictEqual({
      type: 'error',
      error: 'no profile',
      needsSetup: true,
    });
  });

  it('flags Claude Code that is missing or not logged in', () => {
    expect(toNativeError(new ClaudeRunError('not-installed', 'no claude'))).toStrictEqual({
      type: 'error',
      error: 'no claude',
      needsSetup: true,
    });
    expect(toNativeError(new ClaudeRunError('not-logged-in', 'log in'))).toStrictEqual({
      type: 'error',
      error: 'log in',
      needsSetup: true,
    });
  });

  it('sends only the message for errors that setup cannot fix', () => {
    expect(toNativeError(new ClaudeRunError('timeout', 'timed out'))).toStrictEqual({ type: 'error', error: 'timed out' });
    expect(toNativeError(new ClaudeRunError('failed', 'usage limit'))).toStrictEqual({
      type: 'error',
      error: 'usage limit',
    });
    expect(toNativeError(new CompileError('tectonic failed', 'tectonic failed'))).toStrictEqual({
      type: 'error',
      error: 'tectonic failed',
    });
  });

  it('leaves details out when they only repeat the message', () => {
    expect(toNativeError(new ResumeFormatError('missing', 'No resume JSON found'))).toStrictEqual({
      type: 'error',
      error: 'No resume JSON found',
    });
  });

  it('always has a non-empty error', () => {
    expect(toNativeError(new Error('')).error).not.toBe('');
    expect(toNativeError('boom').error).toBe('boom');
    expect(toNativeError(undefined).error).not.toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildResume with a fake tectonic: stages, fitting, caching, failures
// ---------------------------------------------------------------------------

describe('buildResume (fake tectonic)', () => {
  it('reports compiling, then fitting', async () => {
    const stages: string[] = [];
    await buildResume(VALID, { ...options(fakeTectonic().path), onStage: (stage) => stages.push(stage) });
    expect(stages).toEqual(['compiling', 'fitting']);
  });

  it('trims to fit and compiles no doc twice', async () => {
    const tectonic = fakeTectonic();
    const result = await buildResume(VALID, options(tectonic.path));
    expect(result).toMatchObject({ pages: 1, fits: true, trimmedBullets: 1 });
    expect(result.resumeText).not.toContain('Mentored');
    expect(readFileSync(result.texPath, 'utf-8')).not.toContain('Mentored');
    expect(readFileSync(result.pdfPath, 'utf-8')).toBe('%PDF-fake-1');
    // The full doc and the trimmed doc, once each.
    expect(tectonic.runs()).toBe(2);
  });

  it('sets the PDF author from the name on the resume and leaves the dates as written', async () => {
    const doc: ResumeDoc = {
      ...VALID,
      experience: [{ ...VALID.experience[0], end: 'Jul 2025' }],
    };
    const result = await buildResume(doc, options(fakeTectonic().path));
    expect(result.latexSource).toContain(`pdfauthor={${VALID.name}}`);
    expect(result.latexSource).toContain('Jul 2025');
  });

  it('renders and fits the roles newest first, whatever order the doc lists them in', async () => {
    const older = {
      title: 'Data Scientist',
      company: 'Contoso Analytics',
      start: 'Jun 2020',
      end: 'Dec 2022',
      bullets: [
        { text: 'Shipped churn models for 40 retail clients.', priority: 1 as const },
        { text: 'Built a feature store used by 6 teams.', priority: 2 as const },
        { text: 'Automated weekly reporting in Airflow.', priority: 3 as const },
      ],
    };
    const doc: ResumeDoc = { ...VALID, experience: [older, VALID.experience[0]] };

    const result = await buildResume(doc, options(fakeTectonic().path));

    expect(result.latexSource.indexOf('Northwind Labs')).toBeLessThan(result.latexSource.indexOf('Contoso Analytics'));
    expect(result.resumeText.indexOf('RAG pipeline')).toBeLessThan(result.resumeText.indexOf('churn models'));
    // The fit cuts the last (oldest) role's priority 3 bullet first, so the page only fits once the
    // newer role's "Mentored" bullet goes too. Fitted in the given order, one cut would have done.
    expect(result.trimmedBullets).toBe(2);
    expect(result.resumeText).not.toContain('Automated weekly reporting');
  });

  it('uses the folder name override instead of company and role', async () => {
    const result = await buildResume(VALID, options(fakeTectonic().path, { folderNameOverride: 'My: Custom/Name' }));
    expect(result.folderName).toBe('My Custom Name');
    expect(result.texPath.endsWith('/My Custom Name/My Custom Name.tex')).toBe(true);
  });

  it('creates no folder when the job is cancelled during the compile', async () => {
    const tectonic = onePageTectonic(newDir('bin-'), true);
    const controller = new AbortController();
    const opts = options(tectonic.path, { signal: controller.signal });

    const build = rejection(buildResume(VALID, opts));
    await waitUntil(tectonic.started, 'tectonic to start');
    controller.abort();
    tectonic.release();
    const error = await build;

    expect(error).toBeInstanceOf(ClaudeRunError);
    expect(error).toMatchObject({ kind: 'cancelled', message: 'Resume writing was cancelled.' });
    expect(existsSync(opts.outputBase) ? readdirSync(opts.outputBase) : []).toEqual([]);
  });

  it('does not even compile when the job was cancelled before the build', async () => {
    const tectonic = onePageTectonic(newDir('bin-'));
    const controller = new AbortController();
    controller.abort();
    const opts = options(tectonic.path, { signal: controller.signal });

    const error = await rejection(buildResume(VALID, opts));

    expect(error).toMatchObject({ kind: 'cancelled' });
    expect(tectonic.started()).toBe(false);
    expect(existsSync(opts.outputBase) ? readdirSync(opts.outputBase) : []).toEqual([]);
  });

  it('creates no folder and removes its work dir when the compile fails', async () => {
    const workRoot = newDir('tmp-');
    const savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = workRoot;
    try {
      const opts = options(failingTectonic());
      const error = await rejection(buildResume(VALID, opts));
      expect(error).toBeInstanceOf(CompileError);
      expect(existsSync(opts.outputBase) ? readdirSync(opts.outputBase) : []).toEqual([]);
      expect(readdirSync(workRoot)).toEqual([]);
    } finally {
      process.env.TMPDIR = savedTmp;
    }
  });
});

// ---------------------------------------------------------------------------
// The real pipeline (needs tectonic)
// ---------------------------------------------------------------------------

const FENCED_REPLY = `Here is the resume.\n\n\`\`\`json\n${JSON.stringify(VALID, null, 2)}\n\`\`\`\n`;

const LEGACY_REPLY = [
  '# CHAT TITLE',
  '**Globex - Data Engineer Resume Analysis**',
  '',
  '---',
  '## TAILORED RESUME',
  '',
  '# Alex Rivera',
  '',
  '**Email:** alex.rivera@example.com  ',
  '**Phone:** +1 (555) 010-0199  ',
  '**GitHub:** github.com/alex-rivera-example',
  '',
  'Data engineer who builds streaming pipelines.',
  '',
  '## Skills',
  '',
  '**Languages:** Python, Go, SQL',
  '',
  '## Experience',
  '',
  '**Data Engineer** | Globex -- Charlotte, NC  ',
  'Jun 2020 - Dec 2021',
  '',
  '- Built Kafka pipelines for real-time analytics.',
  '- Reduced month-end processing from 8 hours to 3.',
  '',
  '## Education',
  '',
  '**State University**  ',
  'May 2018  ',
  'Master of Science, Computer Science',
].join('\n');

describe.skipIf(!TECTONIC)('buildResume (tectonic)', () => {
  it('writes the .tex, the .pdf and the upload copy into "<Company> - <Role>"', async () => {
    const opts = options(TECTONIC);
    const result = await buildResume(VALID, opts);
    const folderPath = join(opts.outputBase, FOLDER);

    expect(result).toMatchObject({
      success: true,
      folderName: FOLDER,
      folderPath,
      texPath: join(folderPath, `${FOLDER}.tex`),
      pdfPath: join(folderPath, `${FOLDER}.pdf`),
      uploadPdfPath: join(folderPath, UPLOAD),
      pages: 1,
      fits: true,
      trimmedBullets: 0,
      keywords: VALID.keywords,
    });
    expect(result.resumeText).toContain('Built a RAG pipeline answering 2M queries per month.');
    expect(readFileSync(result.texPath, 'utf-8')).toBe(result.latexSource);
    const pdf = readFileSync(result.pdfPath);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(Buffer.from(result.pdfBase64, 'base64').equals(pdf)).toBe(true);
    expect(result.pdfSizeBytes).toBe(pdf.length);
    expect(readFileSync(result.uploadPdfPath).equals(pdf)).toBe(true);
  }, { timeout: 60_000 });

  it('never overwrites: a second run gets " (2)"', async () => {
    const opts = options(TECTONIC);
    await buildResume(VALID, opts);
    const second = await buildResume(VALID, opts);
    expect(second.folderName).toBe(`${FOLDER} (2)`);
    expect(second.texPath).toBe(join(opts.outputBase, `${FOLDER} (2)`, `${FOLDER} (2).tex`));
    expect(existsSync(second.pdfPath)).toBe(true);
  }, { timeout: 60_000 });
});

describe.skipIf(!TECTONIC)('generateResume (tectonic)', () => {
  it('builds from a fenced JSON reply', async () => {
    const result = await generateResume(FENCED_REPLY, { ...options(TECTONIC), fallbackTitle: null });
    expect(result).toMatchObject({ folderName: FOLDER, pages: 1, fits: true });
    expect(existsSync(result.pdfPath)).toBe(true);
  }, { timeout: 60_000 });

  it('renders an old markdown reply through the legacy adapter', async () => {
    const result = await generateResume(LEGACY_REPLY, { ...options(TECTONIC), fallbackTitle: 'Ignored - Title' });
    expect(result.folderName).toBe('Globex - Data Engineer');
    expect(result.resumeText).toContain('Built Kafka pipelines for real-time analytics.');
    expect(result.pages).toBe(1);
    expect(existsSync(result.pdfPath)).toBe(true);
  }, { timeout: 60_000 });
});

describe('generateResume (no compile needed)', () => {
  it('rejects a reply with neither a resume JSON nor a TAILORED RESUME section', async () => {
    const error = await rejection(
      generateResume('Sorry, I cannot help with that.', { ...options(fakeTectonic().path), fallbackTitle: null }),
    );
    expect(error).toBeInstanceOf(ResumeFormatError);
  });
});

// ---------------------------------------------------------------------------
// recompileTex
// ---------------------------------------------------------------------------

describe('recompileTex path checks', () => {
  const TEX = '\\documentclass{article}\\begin{document}x\\end{document}';

  async function refusal(req: Parameters<typeof recompileTex>[0], outputBase: string): Promise<string> {
    const error = await rejection(recompileTex(req, { outputBase, tectonicPath: fakeTectonic().path }));
    return error.message;
  }

  it('refuses a .tex outside the output folder and writes nothing', async () => {
    const outputBase = newDir('out-');
    const texPath = join(outputBase, '..', 'evil.tex');
    const message = await refusal({ texSource: TEX, texPath, folderPath: join(outputBase, '..') }, outputBase);
    expect(message).toBe(REFUSAL);
    expect(existsSync(texPath)).toBe(false);
  });

  it('refuses a path that does not end in .tex', async () => {
    const outputBase = newDir('out-');
    const folderPath = join(outputBase, 'A');
    const message = await refusal({ texSource: TEX, texPath: join(folderPath, 'A.sh'), folderPath }, outputBase);
    expect(message).toBe(REFUSAL);
  });

  it('refuses a .tex that is not directly in folderPath', async () => {
    const outputBase = newDir('out-');
    const texPath = join(outputBase, 'A', 'A.tex');
    const message = await refusal({ texSource: TEX, texPath, folderPath: join(outputBase, 'B') }, outputBase);
    expect(message).toBe(REFUSAL);
  });

  it('refuses an upload copy outside folderPath', async () => {
    const outputBase = newDir('out-');
    const folderPath = join(outputBase, 'A');
    const uploadPdfPath = join(outputBase, '..', 'Alex_Rivera_Resume.pdf');
    const message = await refusal(
      { texSource: TEX, texPath: join(folderPath, 'A.tex'), folderPath, uploadPdfPath },
      outputBase,
    );
    expect(message).toBe(REFUSAL);
    expect(existsSync(uploadPdfPath)).toBe(false);
  });
});

describe('recompileTex (fake tectonic)', () => {
  it('leaves the existing .tex and PDFs untouched when the compile fails', async () => {
    const opts = options(fakeTectonic().path);
    const built = await buildResume(VALID, opts);
    const files = [built.texPath, built.pdfPath, built.uploadPdfPath];
    const before = files.map((file) => readFileSync(file));

    const error = await rejection(
      recompileTex(
        {
          texSource: '\\documentclass{article}\\broken',
          texPath: built.texPath,
          folderPath: built.folderPath,
          uploadPdfPath: built.uploadPdfPath,
        },
        { outputBase: opts.outputBase, tectonicPath: failingTectonic() },
      ),
    );

    expect(error).toBeInstanceOf(CompileError);
    expect(files.map((file) => readFileSync(file))).toEqual(before);
    expect(readdirSync(built.folderPath).sort()).toEqual([`${FOLDER}.pdf`, `${FOLDER}.tex`, UPLOAD].sort());
  });
});

describe.skipIf(!TECTONIC)('recompileTex (tectonic)', () => {
  it('compiles the edited source and rewrites the .tex, the .pdf and the upload copy', async () => {
    const opts = options(TECTONIC);
    const built = await buildResume(VALID, opts);
    const texSource = built.latexSource.replace(
      'Built a RAG pipeline answering 2M queries per month.',
      'Built a RAG pipeline answering 3M queries per month.',
    );
    expect(texSource).not.toBe(built.latexSource);

    const result = await recompileTex(
      { texSource, texPath: built.texPath, folderPath: built.folderPath, uploadPdfPath: built.uploadPdfPath },
      { outputBase: opts.outputBase, tectonicPath: TECTONIC },
    );

    expect(result).toMatchObject({ success: true, pages: 1 });
    expect(readFileSync(built.texPath, 'utf-8')).toBe(texSource);
    const pdf = readFileSync(built.pdfPath);
    expect(Buffer.from(result.pdfBase64, 'base64').equals(pdf)).toBe(true);
    expect(result.pdfSizeBytes).toBe(pdf.length);
    expect(readFileSync(built.uploadPdfPath).equals(pdf)).toBe(true);
  }, { timeout: 60_000 });
});
