import { errorMessage } from '../shared/error-message.js';
import { SCORE_EFFORT, SCORE_MODEL } from '../shared/fit.js';
import type { HostJobFacts, WriteRequest, WriteResult, WriteStage } from '../shared/host-protocol.js';
import { normalizeJobUrl } from '../shared/job-page.js';
import type { pickJobText } from '../shared/job-text.js';
import type { HostOutcome } from '../shared/native-writer.js';
import { WriterError } from '../shared/native-writer.js';
import { WRITER_EFFORT } from '../shared/settings-normalize.js';
import type {
  CombinedResult,
  ExtractionResult,
  FitAnalysis,
  JobData,
  SeerSettings,
  TabMessage,
} from '../shared/types.js';

/**
 * One job per FAB click: the native host scores the job with Claude Code and writes the resume
 * only when the fit score reaches the fit bar (`settings.minScore`). Jobs are independent, so
 * several tabs (or several pages in one tab) can run at once.
 * No chrome.* here — every side effect goes through the deps.
 */

/** How long the native host may take to score one job (up to 2 min) and write, compile and fit its resume. */
export const HOST_JOB_TIMEOUT_MS = 10 * 60_000;

const TAG = '[Seer BG]';

export interface CrawlContent {
  iframeTexts: string[];
}

/** One host job: the tab it reports to, its id, the page URL it was started on and its page budget. */
export interface JobRef {
  tabId: number;
  jobId: string;
  jobUrl: string;
  /** The page budget of the settings this job was started with. */
  maxPages: 1 | 2;
}

/** What the host reports while a job runs. */
export interface HostJobEvents {
  onProgress: (stage: WriteStage) => void;
  onScore: (analysis: FitAnalysis, job: HostJobFacts) => void;
}

export interface JobRunnerDeps {
  newJobId: () => string;
  pickJobText: typeof pickJobText;
  /** Runs one host job: it scores the job, then writes the resume only if the score passes. */
  write: (req: WriteRequest, events: HostJobEvents) => Promise<HostOutcome>;
  toTab: (tabId: number, msg: TabMessage) => void;
  /** Called once when the host starts writing; every such job later ends in `onResult` or `onWriteError`. */
  onWriteStart: (job: JobRef) => void;
  /** Called once the resume is written, with the host's analysis and job. */
  onResult: (job: JobRef, result: WriteResult, analysis: FitAnalysis, jobData: JobData) => Promise<void>;
  /** A failure after the score; one before it rejects `run()` instead. */
  onWriteError: (job: JobRef, err: WriterError, jobData: JobData) => void;
}

export interface JobRunner {
  /**
   * Starts the host job and resolves with its score as soon as the host sends it (rejects if the
   * host fails before that). The job then goes on alone: a written resume ends in `onResult`, a
   * skipped job tells the tab `SEER_WRITER_SKIPPED`, and a later failure ends in `onWriteError`.
   * While this tab still has a job for the same page, a run re-uses that job's score.
   */
  run(
    tabId: number,
    extraction: ExtractionResult,
    content: CrawlContent,
    settings: SeerSettings,
  ): Promise<CombinedResult>;
}

function toWriterError(err: unknown): WriterError {
  return err instanceof WriterError ? err : new WriterError(errorMessage(err));
}

/**
 * Runs `fn` and logs "Could not <what>" instead of throwing or rejecting: a throw inside the host's
 * callbacks would leave the job to time out. A synchronous `fn` has run (and any throw is logged)
 * by the time this returns.
 */
async function guarded(what: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.log(`${TAG} Could not ${what}: ${errorMessage(err)}`);
  }
}

/** Calls `start` right away; a synchronous throw becomes a rejection. */
function startNow<T>(start: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => resolve(start()));
}

/** Jobs are deduplicated per tab and page; a #fragment, a trailing slash or tracking parameters do not make another page. */
function jobKey(tabId: number, url: string): string {
  return `${tabId} ${normalizeJobUrl(url)}`;
}

function writeRequest(jobText: string, extraction: ExtractionResult, settings: SeerSettings): WriteRequest {
  return {
    job: { text: jobText, url: extraction.url, title: extraction.pageTitle },
    model: settings.claudeModel,
    effort: WRITER_EFFORT,
    maxPages: settings.maxPages,
    scoreModel: SCORE_MODEL,
    scoreEffort: SCORE_EFFORT,
    minScore: settings.minScore,
    writerNotes: settings.writerNotes,
  };
}

/** The host's job facts plus what the extension knows: the job text it sent and the page URL. */
function toCombined(
  analysis: FitAnalysis,
  facts: HostJobFacts,
  jobText: string,
  url: string,
  threshold: number,
): CombinedResult {
  return { job: { ...facts, description: jobText, url }, analysis, model: `claude-${SCORE_MODEL}`, threshold };
}

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

export function createJobRunner(deps: JobRunnerDeps): JobRunner {
  /** The score of each job still running, by `jobKey`. */
  const jobsInFlight = new Map<string, Promise<CombinedResult>>();

  function sendToTab(tabId: number, msg: TabMessage, what: string): void {
    void guarded(`send ${what} to tab ${tabId}`, () => deps.toTab(tabId, msg));
  }

  function sendProgress(job: JobRef, stage: WriteStage): void {
    const msg: TabMessage = { type: 'SEER_WRITER_PROGRESS', jobId: job.jobId, jobUrl: job.jobUrl, stage };
    sendToTab(job.tabId, msg, `writer progress "${stage}"`);
  }

  function announceWrite(job: JobRef): void {
    void guarded(`announce job ${job.jobId}'s write`, () => deps.onWriteStart(job));
  }

  function reportSkip(job: JobRef, score: number, threshold: number): void {
    console.log(`${TAG} Job ${job.jobId} (tab ${job.tabId}): fit ${score} is below ${threshold} — no resume for ${job.jobUrl}`);
    const msg: TabMessage = { type: 'SEER_WRITER_SKIPPED', jobUrl: job.jobUrl, score, threshold };
    sendToTab(job.tabId, msg, 'the skipped resume');
  }

  function reportWriteError(job: JobRef, err: WriterError, jobData: JobData): void {
    console.log(`${TAG} Job ${job.jobId} (tab ${job.tabId}): resume writing failed: ${err.message}`);
    void guarded(`report job ${job.jobId}'s write error`, () => deps.onWriteError(job, err, jobData));
  }

  function deliver(job: JobRef, result: WriteResult, scored: CombinedResult): Promise<void> {
    return guarded(`deliver job ${job.jobId}'s resume`, () => deps.onResult(job, result, scored.analysis, scored.job));
  }

  /** Waits for the host job to end, then reports how it ended. Never rejects. */
  async function finishJob(
    job: JobRef,
    hostJob: Promise<HostOutcome>,
    score: Deferred<CombinedResult>,
    scoredNow: () => CombinedResult | null,
  ): Promise<void> {
    const outcome = await hostJob.then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, err: toWriterError(err) }),
    );
    jobsInFlight.delete(jobKey(job.tabId, job.jobUrl));
    const scored = scoredNow();
    if (!scored) {
      // Before the score the run's caller (the panel) shows the error; nothing else is reported.
      const err = outcome.ok ? new WriterError('The helper ended the job without a fit score') : outcome.err;
      console.log(`${TAG} Job ${job.jobId} (tab ${job.tabId}): failed before the score: ${err.message}`);
      score.reject(err);
      return;
    }
    if (!outcome.ok) {
      reportWriteError(job, outcome.err, scored.job);
    } else if (outcome.value.kind === 'skipped') {
      reportSkip(job, outcome.value.score, outcome.value.threshold);
    } else {
      await deliver(job, outcome.value.result, scored);
    }
  }

  function startJob(job: JobRef, extraction: ExtractionResult, jobText: string, settings: SeerSettings): Promise<CombinedResult> {
    const score = deferred<CombinedResult>();
    let scored: CombinedResult | null = null;
    let writing = false;
    const events: HostJobEvents = {
      onProgress: (stage) => {
        if (stage === 'writing' && scored !== null && !writing) {
          writing = true;
          announceWrite(job);
        }
        sendProgress(job, stage);
      },
      onScore: (analysis, facts) => {
        scored = toCombined(analysis, facts, jobText, extraction.url, settings.minScore);
        console.log(`${TAG} Job ${job.jobId} (tab ${job.tabId}): fit ${analysis.fit_score}/100`);
        score.resolve(scored);
      },
    };
    console.log(
      `${TAG} Job ${job.jobId} (tab ${job.tabId}): scoring with ${SCORE_MODEL}, then writing with ` +
        `${settings.claudeModel}, ${WRITER_EFFORT} effort, ${settings.maxPages} page(s) if fit >= ${settings.minScore}`,
    );
    const hostJob = startNow(() => deps.write(writeRequest(jobText, extraction, settings), events));
    void finishJob(job, hostJob, score, () => scored);
    return score.promise;
  }

  function run(
    tabId: number,
    extraction: ExtractionResult,
    content: CrawlContent,
    settings: SeerSettings,
  ): Promise<CombinedResult> {
    const key = jobKey(tabId, extraction.url);
    const inFlight = jobsInFlight.get(key);
    if (inFlight) {
      console.log(`${TAG} Tab ${tabId} already has a job for ${extraction.url} — re-using its score`);
      return inFlight;
    }
    const jobText = deps.pickJobText({ extraction, ...content });
    const job: JobRef = { tabId, jobId: deps.newJobId(), jobUrl: extraction.url, maxPages: settings.maxPages };
    const scoring = startJob(job, extraction, jobText, settings);
    jobsInFlight.set(key, scoring);
    return scoring;
  }

  return { run };
}
