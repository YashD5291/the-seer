import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HostJobEvents, JobRef, JobRunner, JobRunnerDeps } from './job-runner.ts';
import { createJobRunner, HOST_JOB_TIMEOUT_MS } from './job-runner.ts';
import type { HostOutcome } from '../shared/native-writer.ts';
import { WriterError } from '../shared/native-writer.ts';
import type { HostJobFacts, WriteRequest, WriteResult, WriteStage } from '../shared/host-protocol.ts';
import type { CombinedResult, ExtractionResult, FitAnalysis, JobData, SeerSettings, TabMessage } from '../shared/types.ts';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets pending promise callbacks run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const SETTINGS: SeerSettings = {
  claudeModel: 'opus',
  maxPages: 2,
  minScore: 55,
  writerNotes: '',
};

const CRAWL = { iframeTexts: [] };

function urlFor(page: number): string {
  return `https://jobs.test/${page}`;
}

function jobTextFor(page: number): string {
  return `job text for ${urlFor(page)}`;
}

/** The page scraped for job `page` (one page per job unless a test says otherwise). */
function extractionFor(page: number, overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    success: true,
    jobData: null,
    rawText: `page ${page}`,
    jsonLd: { '@type': 'JobPosting' },
    url: urlFor(page),
    pageTitle: `Job ${page}`,
    extractionMethod: 'page-text',
    ...overrides,
  };
}

function analysisFor(page: number, fitScore = 70 + page): FitAnalysis {
  return {
    fit_score: fitScore,
    confidence: 80,
    recommended_base: 'mle',
    base_reasoning: '',
    key_matches: [],
    gaps: [],
    gap_mitigation: [],
    tailoring_priorities: [],
    ats_keywords: ['python'],
    red_flags: [],
    estimated_competition: 'medium',
    apply_recommendation: 'yes',
  };
}

/** The job facts the host's scorer copied from page `page`. */
function factsFor(page: number): HostJobFacts {
  return { title: `Role ${page}`, company: 'Acme', location: 'Remote', requirements: ['Python'], nice_to_haves: [] };
}

function jobDataFor(page: number): JobData {
  return { ...factsFor(page), description: jobTextFor(page), url: urlFor(page) };
}

/** What a run resolves with once the host scored job `page`. */
function scoredFor(page: number, fitScore = 70 + page, threshold = SETTINGS.minScore): CombinedResult {
  return { job: jobDataFor(page), analysis: analysisFor(page, fitScore), model: 'claude-haiku', threshold };
}

function resultFor(page: number): WriteResult {
  return {
    success: true,
    folderName: `Acme - Role ${page}`,
    folderPath: `/out/${page}`,
    texPath: `/out/${page}/resume.tex`,
    pdfPath: `/out/${page}/resume.pdf`,
    uploadPdfPath: `/out/${page}/Alex_Rivera_Resume.pdf`,
    pages: 1,
    fits: true,
    trimmedBullets: 0,
    latexSource: '\\documentclass{article}',
    pdfBase64: 'JVBERi0=',
    pdfSizeBytes: 5,
    resumeText: 'Alex Rivera',
    keywords: ['python'],
  };
}

function written(page: number): HostOutcome {
  return { kind: 'written', result: resultFor(page) };
}

interface HostCall {
  req: WriteRequest;
  events: HostJobEvents;
  done: Deferred<HostOutcome>;
}

interface Harness {
  deps: JobRunnerDeps;
  calls: HostCall[];
  started: JobRef[];
  sent: Array<{ tabId: number; msg: TabMessage }>;
  results: Array<{ job: JobRef; result: WriteResult; analysis: FitAnalysis; jobData: JobData }>;
  errors: Array<{ job: JobRef; err: WriterError; jobData: JobData }>;
}

function harness(overrides: Partial<JobRunnerDeps> = {}): Harness {
  let nextId = 0;
  const h: Harness = {
    calls: [],
    started: [],
    sent: [],
    results: [],
    errors: [],
    deps: {
      newJobId: () => `job-${++nextId}`,
      pickJobText: ({ extraction }) => `job text for ${extraction.url}`,
      write: (req, events) => {
        const done = deferred<HostOutcome>();
        h.calls.push({ req, events, done });
        return done.promise;
      },
      toTab: (tabId, msg) => {
        h.sent.push({ tabId, msg });
      },
      onWriteStart: (job) => {
        h.started.push(job);
      },
      onResult: async (job, result, analysis, jobData) => {
        h.results.push({ job, result, analysis, jobData });
      },
      onWriteError: (job, err, jobData) => {
        h.errors.push({ job, err, jobData });
      },
      ...overrides,
    },
  };
  return h;
}

/** The host sends its score for job `page` on host call `call`. */
function score(call: HostCall, page: number, fitScore = 70 + page): void {
  call.events.onScore(analysisFor(page, fitScore), factsFor(page));
}

/** Runs job `page` in `tabId` and lets the host score it; resolves once the run has the score. */
function runScored(
  runner: JobRunner,
  h: Harness,
  tabId: number,
  page: number,
  extraction: ExtractionResult = extractionFor(page),
  settings: SeerSettings = SETTINGS,
): Promise<CombinedResult> {
  const run = runner.run(tabId, extraction, CRAWL, settings);
  score(h.calls[h.calls.length - 1], page);
  return run;
}

/** The job a run with SETTINGS (a 2-page budget) reports. */
function jobRef(tabId: number, jobId: string, page: number): JobRef {
  return { tabId, jobId, jobUrl: urlFor(page), maxPages: SETTINGS.maxPages };
}

function progress(jobId: string, page: number, stage: WriteStage): TabMessage {
  return { type: 'SEER_WRITER_PROGRESS', jobId, jobUrl: urlFor(page), stage };
}

function loggedLine(log: { mock: { calls: Array<{ arguments: unknown[] }> } }, pattern: RegExp): boolean {
  return log.mock.calls.some((call) => pattern.test(String(call.arguments[0])));
}

describe('createJobRunner', () => {
  it('gives the host 10 minutes to score and write one job', () => {
    assert.equal(HOST_JOB_TIMEOUT_MS, 10 * 60_000);
  });

  it('starts the host job right away with the job text, the writer settings and the score gate', () => {
    const h = harness();
    void createJobRunner(h.deps).run(1, extractionFor(1), CRAWL, SETTINGS);

    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0].req, {
      job: { text: jobTextFor(1), url: urlFor(1), title: 'Job 1' },
      model: 'opus',
      effort: 'medium',
      maxPages: 2,
      scoreModel: 'haiku',
      scoreEffort: 'low',
      minScore: 55,
      writerNotes: '',
    });
  });

  it('sends the saved extra instructions for the writer with the job', () => {
    const h = harness();
    const settings = { ...SETTINGS, writerNotes: 'Keep my publications section.' };
    void createJobRunner(h.deps).run(1, extractionFor(1), CRAWL, settings);

    assert.equal(h.calls[0].req.writerNotes, 'Keep my publications section.');
  });

  it('sends empty extra instructions when none are saved', () => {
    const h = harness();
    void createJobRunner(h.deps).run(1, extractionFor(1), CRAWL, SETTINGS);

    assert.equal(h.calls[0].req.writerNotes, '');
  });

  it('sends the fit bar of the settings the run was given', () => {
    const h = harness();
    const runner = createJobRunner(h.deps);
    void runner.run(1, extractionFor(1), CRAWL, { ...SETTINGS, minScore: 0 });
    void runner.run(2, extractionFor(2), CRAWL, { ...SETTINGS, minScore: 85 });

    assert.deepEqual(h.calls.map((call) => call.req.minScore), [0, 85]);
  });

  it('always writes at medium effort, whatever the model', () => {
    const h = harness();
    void createJobRunner(h.deps).run(1, extractionFor(1), CRAWL, { ...SETTINGS, claudeModel: 'sonnet' });

    assert.equal(h.calls[0].req.model, 'sonnet');
    assert.equal(h.calls[0].req.effort, 'medium');
  });

  it('resolves with the score as soon as the host sends it, before any resume is written', async () => {
    const h = harness();
    const run = createJobRunner(h.deps).run(1, extractionFor(1), CRAWL, SETTINGS);
    score(h.calls[0], 1);

    assert.deepEqual(await run, scoredFor(1));
    assert.deepEqual(h.results, [], 'the resume is still being written');
  });

  it('leaves out job facts the host did not send', async () => {
    const h = harness();
    const run = createJobRunner(h.deps).run(1, extractionFor(1), CRAWL, SETTINGS);
    h.calls[0].events.onScore(analysisFor(1), { title: 'Role 1', company: 'Acme', requirements: [], nice_to_haves: [] });

    const { job } = await run;
    assert.deepEqual(job, {
      title: 'Role 1',
      company: 'Acme',
      requirements: [],
      nice_to_haves: [],
      description: jobTextFor(1),
      url: urlFor(1),
    });
  });

  it('carries the fit bar of the settings the run was given in the result', async () => {
    const h = harness();
    const runner = createJobRunner(h.deps);
    const first = runner.run(1, extractionFor(1), CRAWL, { ...SETTINGS, minScore: 0 });
    const second = runner.run(2, extractionFor(2), CRAWL, { ...SETTINGS, minScore: 85 });
    score(h.calls[0], 1);
    score(h.calls[1], 2);

    assert.equal((await first).threshold, 0);
    assert.equal((await second).threshold, 85);
  });

  it('names the scoring model in the result', async () => {
    const h = harness();
    const { model } = await runScored(createJobRunner(h.deps), h, 1, 1);
    assert.equal(model, 'claude-haiku');
  });

  it('rejects when the host fails before the score, and reports nothing else', async () => {
    const h = harness();
    const run = createJobRunner(h.deps).run(1, extractionFor(1), CRAWL, SETTINGS);
    h.calls[0].events.onProgress('checking-login');

    const failure = new WriterError('Claude Code is not logged in', { details: 'run claude /login' });
    h.calls[0].done.reject(failure);
    await assert.rejects(run, failure);
    await flush();
    assert.deepEqual(h.started, []);
    assert.deepEqual(h.results, []);
    assert.deepEqual(h.errors, [], 'the panel shows this error, no notification');
  });

  it('rejects with a WriterError when the host fails before the score with a plain Error', async () => {
    const h = harness();
    const run = createJobRunner(h.deps).run(1, extractionFor(1), CRAWL, SETTINGS);
    h.calls[0].done.reject(new Error('Specified native messaging host not found.'));

    await assert.rejects(run, (err: unknown) => {
      assert.ok(err instanceof WriterError);
      assert.equal(err.message, 'Specified native messaging host not found.');
      return true;
    });
  });

  it('rejects when starting the host job throws', async () => {
    const h = harness({
      write: () => {
        throw new Error('connectNative failed');
      },
    });
    await assert.rejects(createJobRunner(h.deps).run(1, extractionFor(1), CRAWL, SETTINGS), /connectNative failed/);
    assert.deepEqual(h.errors, []);
  });

  it('rejects when the host job ends without a score', async () => {
    const h = harness();
    const run = createJobRunner(h.deps).run(1, extractionFor(1), CRAWL, SETTINGS);
    h.calls[0].done.resolve(written(1));

    await assert.rejects(run, (err: unknown) => {
      assert.ok(err instanceof WriterError);
      assert.equal(err.message, 'The helper ended the job without a fit score');
      return true;
    });
    await flush();
    assert.deepEqual(h.results, []);
  });

  it("reports the written resume with the host's analysis and job", async () => {
    const h = harness();
    await runScored(createJobRunner(h.deps), h, 1, 1);

    h.calls[0].done.resolve(written(1));
    await flush();
    assert.deepEqual(h.results, [
      { job: jobRef(1, 'job-1', 1), result: resultFor(1), analysis: analysisFor(1), jobData: jobDataFor(1) },
    ]);
    assert.deepEqual(h.errors, []);
  });

  it('tags the job with the page budget the run was given', async () => {
    const h = harness();
    await runScored(createJobRunner(h.deps), h, 1, 1, extractionFor(1), { ...SETTINGS, maxPages: 1 });

    h.calls[0].done.resolve(written(1));
    await flush();
    assert.equal(h.results[0].job.maxPages, 1);
  });

  it('tells the tab when the host skipped the job, and writes nothing', async () => {
    const h = harness();
    const run = createJobRunner(h.deps).run(1, extractionFor(1), CRAWL, SETTINGS);
    score(h.calls[0], 1, 32);
    assert.deepEqual(await run, scoredFor(1, 32), 'the score is still returned');

    h.calls[0].done.resolve({ kind: 'skipped', score: 32, threshold: 40 });
    await flush();
    assert.deepEqual(h.sent, [
      { tabId: 1, msg: { type: 'SEER_WRITER_SKIPPED', jobUrl: urlFor(1), score: 32, threshold: 40 } },
    ]);
    assert.deepEqual(h.started, [], 'no badge flash');
    assert.deepEqual(h.results, [], 'no notification');
    assert.deepEqual(h.errors, []);
  });

  it("reports the host's threshold in the skip", async () => {
    const h = harness();
    await runScored(createJobRunner(h.deps), h, 1, 1);
    h.calls[0].done.resolve({ kind: 'skipped', score: 49, threshold: 50 });
    await flush();
    assert.deepEqual(h.sent, [
      { tabId: 1, msg: { type: 'SEER_WRITER_SKIPPED', jobUrl: urlFor(1), score: 49, threshold: 50 } },
    ]);
  });

  it('logs a skip it could not send to the tab', async (t) => {
    const log = t.mock.method(console, 'log', () => undefined);
    const h = harness({
      toTab: () => {
        throw new Error('No tab with id: 1');
      },
    });
    await runScored(createJobRunner(h.deps), h, 1, 1);
    h.calls[0].done.resolve({ kind: 'skipped', score: 10, threshold: 40 });
    await flush();
    assert.ok(loggedLine(log, /^\[Seer BG\].*No tab with id: 1/), 'the failed send is logged');
  });

  it("reports a failure after the score as the job's write error with the host's job", async () => {
    const h = harness();
    await runScored(createJobRunner(h.deps), h, 1, 1);

    const failure = new WriterError('Compile failed', { details: 'tectonic output' });
    h.calls[0].done.reject(failure);
    await flush();
    assert.deepEqual(h.errors, [{ job: jobRef(1, 'job-1', 1), err: failure, jobData: jobDataFor(1) }]);
    assert.deepEqual(h.results, []);
  });

  it('wraps a non-WriterError failure after the score in a WriterError', async () => {
    const h = harness();
    await runScored(createJobRunner(h.deps), h, 1, 1);

    h.calls[0].done.reject(new Error('Native host has exited.'));
    await flush();
    assert.equal(h.errors.length, 1);
    assert.ok(h.errors[0].err instanceof WriterError);
    assert.equal(h.errors[0].err.message, 'Native host has exited.');
  });

  it('announces the write once, when the host starts writing', async () => {
    const h = harness();
    await runScored(createJobRunner(h.deps), h, 1, 1);
    const { events } = h.calls[0];

    events.onProgress('checking-login');
    events.onProgress('scoring');
    assert.deepEqual(h.started, [], 'no badge flash while checking login or scoring');
    events.onProgress('writing');
    events.onProgress('compiling');
    events.onProgress('fitting');
    assert.deepEqual(h.started, [jobRef(1, 'job-1', 1)]);
  });

  it('does not announce a write that starts before the host sent a score', () => {
    const h = harness();
    void createJobRunner(h.deps).run(1, extractionFor(1), CRAWL, SETTINGS);

    h.calls[0].events.onProgress('writing');

    assert.deepEqual(h.started, [], 'no badge flash for a job that has no score yet');
    assert.deepEqual(h.sent, [{ tabId: 1, msg: progress('job-1', 1, 'writing') }], 'the stage is still forwarded');
  });

  it('forwards every progress stage to the right tab, tagged with the job', async () => {
    const h = harness();
    const runner = createJobRunner(h.deps);
    void runner.run(1, extractionFor(1), CRAWL, SETTINGS);
    void runner.run(2, extractionFor(2), CRAWL, SETTINGS);

    h.calls[0].events.onProgress('checking-login');
    h.calls[0].events.onProgress('scoring');
    h.calls[1].events.onProgress('writing');
    h.calls[0].events.onProgress('writing');

    const sentTo = (tabId: number): TabMessage[] => h.sent.filter((s) => s.tabId === tabId).map((s) => s.msg);
    assert.deepEqual(sentTo(1), [
      progress('job-1', 1, 'checking-login'),
      progress('job-1', 1, 'scoring'),
      progress('job-1', 1, 'writing'),
    ]);
    assert.deepEqual(sentTo(2), [progress('job-2', 2, 'writing')]);
  });

  it('keeps going when sending progress to the tab throws', async (t) => {
    const log = t.mock.method(console, 'log', () => undefined);
    const h = harness({
      toTab: () => {
        throw new Error('No tab with id: 1');
      },
    });
    await runScored(createJobRunner(h.deps), h, 1, 1);

    assert.doesNotThrow(() => h.calls[0].events.onProgress('writing'));
    assert.ok(loggedLine(log, /^\[Seer BG\].*No tab with id: 1/), 'the failed send is logged');
    h.calls[0].done.resolve(written(1));
    await flush();
    assert.equal(h.results.length, 1);
  });

  it("re-uses the in-flight job's score for a re-click on the same page in the same tab", async () => {
    const h = harness();
    const runner = createJobRunner(h.deps);
    const first = runner.run(1, extractionFor(1), CRAWL, SETTINGS);
    const second = runner.run(1, extractionFor(1, { url: `${urlFor(1)}#apply` }), CRAWL, SETTINGS);
    assert.equal(h.calls.length, 1, 'one host job for the page');

    score(h.calls[0], 1);
    assert.deepEqual(await first, scoredFor(1));
    assert.deepEqual(await second, scoredFor(1));
  });

  it('answers a re-click with the known score while the resume is being written', async () => {
    const h = harness();
    const runner = createJobRunner(h.deps);
    await runScored(runner, h, 1, 1);

    assert.deepEqual(await runner.run(1, extractionFor(1), CRAWL, SETTINGS), scoredFor(1));
    assert.equal(h.calls.length, 1);
    h.calls[0].done.resolve(written(1));
    await flush();
    assert.equal(h.results.length, 1, 'one resume');
  });

  it('treats a trailing slash and tracking parameters as the same page', async () => {
    const h = harness();
    const runner = createJobRunner(h.deps);
    await runScored(runner, h, 1, 1);
    void runner.run(1, extractionFor(1, { url: `${urlFor(1)}/?utm_source=x&refId=y` }), CRAWL, SETTINGS);
    assert.equal(h.calls.length, 1);
  });

  it('starts a new job for the same page once the earlier one has ended', async () => {
    for (const end of [
      (call: HostCall) => call.done.resolve(written(1)),
      (call: HostCall) => call.done.resolve({ kind: 'skipped', score: 30, threshold: 40 }),
      (call: HostCall) => call.done.reject(new WriterError('Compile failed')),
    ]) {
      const h = harness();
      const runner = createJobRunner(h.deps);
      await runScored(runner, h, 1, 1);
      end(h.calls[0]);
      await flush();

      void runner.run(1, extractionFor(1), CRAWL, SETTINGS);
      assert.equal(h.calls.length, 2);
    }
  });

  it('starts a new job for the same page after a failure before the score', async () => {
    const h = harness();
    const runner = createJobRunner(h.deps);
    const run = runner.run(1, extractionFor(1), CRAWL, SETTINGS);
    h.calls[0].done.reject(new WriterError('Claude Code is not logged in'));
    await assert.rejects(run);

    void runner.run(1, extractionFor(1), CRAWL, SETTINGS);
    assert.equal(h.calls.length, 2);
  });

  it('runs the same page in another tab as its own job', () => {
    const h = harness();
    const runner = createJobRunner(h.deps);
    void runner.run(1, extractionFor(1), CRAWL, SETTINGS);
    void runner.run(2, extractionFor(1), CRAWL, SETTINGS);
    assert.equal(h.calls.length, 2);
  });

  it('keeps jobs in different tabs independent', async () => {
    const h = harness();
    const runner = createJobRunner(h.deps);
    await runScored(runner, h, 1, 1);
    await runScored(runner, h, 2, 2);

    const failure = new WriterError('Compile failed');
    h.calls[1].done.resolve(written(2));
    h.calls[0].done.reject(failure);
    await flush();
    assert.deepEqual(h.results, [
      { job: jobRef(2, 'job-2', 2), result: resultFor(2), analysis: analysisFor(2), jobData: jobDataFor(2) },
    ]);
    assert.deepEqual(h.errors, [{ job: jobRef(1, 'job-1', 1), err: failure, jobData: jobDataFor(1) }]);
  });

  it('keeps two jobs in one tab apart when the tab moved to another page', async () => {
    const h = harness();
    const runner = createJobRunner(h.deps);
    await runScored(runner, h, 1, 1);
    await runScored(runner, h, 1, 2);
    assert.equal(h.calls.length, 2, 'the new page gets its own job');

    h.calls[1].done.resolve(written(2));
    h.calls[0].done.resolve(written(1));
    await flush();
    assert.deepEqual(
      h.results.map((r) => r.job),
      [jobRef(1, 'job-2', 2), jobRef(1, 'job-1', 1)],
    );
  });

  it('logs a failure in onResult instead of leaving it unhandled', async (t) => {
    const log = t.mock.method(console, 'log', () => undefined);
    const h = harness({
      onResult: async () => {
        throw new Error('storage quota exceeded');
      },
    });
    await runScored(createJobRunner(h.deps), h, 1, 1);

    h.calls[0].done.resolve(written(1));
    await flush();
    assert.ok(loggedLine(log, /^\[Seer BG\].*storage quota exceeded/), 'the failure is logged');
  });

  it('logs a failure in onWriteError instead of leaving it unhandled', async (t) => {
    const log = t.mock.method(console, 'log', () => undefined);
    const h = harness({
      onWriteError: () => {
        throw new Error('No tab with id: 1');
      },
    });
    await runScored(createJobRunner(h.deps), h, 1, 1);

    h.calls[0].done.reject(new WriterError('Compile failed'));
    await flush();
    assert.ok(loggedLine(log, /^\[Seer BG\].*No tab with id: 1/), 'the failure is logged');
  });
});
