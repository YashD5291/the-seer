import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HostOutcome, NativePortLike } from './native-writer.ts';
import { WriterError, writeResumeViaHost } from './native-writer.ts';
import { HELPER_MISSING } from './helper-client.ts';
import type { HostJobFacts, WriteRequest, WriteResult, WriteStage } from './host-protocol.ts';
import type { FitAnalysis } from './types.ts';

const REQUEST: WriteRequest = {
  job: { text: 'We need an ML engineer', url: 'https://acme.test/jobs/1', title: 'ML Engineer' },
  model: 'opus',
  effort: 'medium',
  maxPages: 1,
  scoreModel: 'haiku',
  scoreEffort: 'low',
  minScore: 40,
};

const ANALYSIS: FitAnalysis = {
  fit_score: 72,
  confidence: 80,
  recommended_base: 'mle',
  base_reasoning: 'Production ML focus',
  key_matches: ['PyTorch'],
  gaps: [],
  gap_mitigation: [],
  tailoring_priorities: [],
  ats_keywords: ['PyTorch'],
  red_flags: [],
  estimated_competition: 'medium',
  apply_recommendation: 'yes',
};

const JOB: HostJobFacts = { title: 'ML Engineer', company: 'Acme', requirements: ['Python'], nice_to_haves: [] };

const SCORE = { type: 'score', analysis: ANALYSIS, job: JOB };

const RESULT: WriteResult = {
  success: true,
  folderName: 'Acme - ML Engineer',
  folderPath: '/out/Acme - ML Engineer',
  texPath: '/out/Acme - ML Engineer/resume.tex',
  pdfPath: '/out/Acme - ML Engineer/resume.pdf',
  uploadPdfPath: '/out/Acme - ML Engineer/Alex_Rivera_Resume.pdf',
  pages: 1,
  fits: true,
  trimmedBullets: 0,
  latexSource: '\\documentclass{article}',
  pdfBase64: 'JVBERi0=',
  pdfSizeBytes: 5,
  resumeText: 'Alex Rivera',
  keywords: ['python'],
};

const STOPPED_UNEXPECTEDLY =
  'The helper stopped unexpectedly — re-run the install command from the setup page.';
const OUT_OF_ORDER =
  'The helper answered out of order — it may be out of date; re-run the install command from the setup page.';
const UNEXPECTED_MESSAGE = 'Unexpected message from the helper';

class FakePort implements NativePortLike {
  posted: unknown[] = [];
  disconnectCalls = 0;
  /** When set, disconnect() throws it, as a port Chrome already closed can. */
  disconnectError: Error | null = null;
  private messageListeners: Array<(msg: unknown) => void> = [];
  private disconnectListeners: Array<() => void> = [];

  onMessage = {
    addListener: (cb: (msg: unknown) => void): void => {
      this.messageListeners.push(cb);
    },
  };
  onDisconnect = {
    addListener: (cb: () => void): void => {
      this.disconnectListeners.push(cb);
    },
  };

  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    if (this.disconnectError) throw this.disconnectError;
  }

  emit(msg: unknown): void {
    for (const cb of this.messageListeners) cb(msg);
  }

  hostDisconnects(): void {
    for (const cb of this.disconnectListeners) cb();
  }
}

interface Run {
  port: FakePort;
  stages: WriteStage[];
  scores: Array<{ analysis: FitAnalysis; job: HostJobFacts }>;
  promise: Promise<HostOutcome>;
}

function start(options: { timeoutMs?: number; lastError?: () => string | undefined } = {}): Run {
  const port = new FakePort();
  const stages: WriteStage[] = [];
  const scores: Run['scores'] = [];
  const promise = writeResumeViaHost(REQUEST, {
    connect: () => port,
    lastError: options.lastError ?? (() => undefined),
    onProgress: (stage) => stages.push(stage),
    onScore: (analysis, job) => scores.push({ analysis, job }),
    timeoutMs: options.timeoutMs ?? 60_000,
  });
  return { port, stages, scores, promise };
}

const WRITTEN: HostOutcome = { kind: 'written', result: RESULT };

async function assertWriterError(
  promise: Promise<unknown>,
  message: string,
  details?: string,
  needsSetup = false,
): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof WriterError, 'rejects with a WriterError');
    assert.equal(err.message, message);
    assert.equal(err.details, details);
    assert.equal(err.needsSetup, needsSetup);
    return true;
  });
}

describe('writeResumeViaHost', () => {
  it('posts the write command with the request fields', () => {
    const { port, promise } = start();
    assert.deepEqual(port.posted, [{ command: 'write', ...REQUEST }]);
    port.emit({ type: 'error', error: 'stop' });
    return assert.rejects(promise);
  });

  it('forwards progress stages in order', async () => {
    const { port, stages, promise } = start();
    port.emit({ type: 'progress', stage: 'checking-login' });
    port.emit({ type: 'progress', stage: 'scoring' });
    port.emit(SCORE);
    port.emit({ type: 'progress', stage: 'writing' });
    port.emit({ type: 'progress', stage: 'compiling' });
    port.emit({ type: 'progress', stage: 'fitting' });
    port.emit({ type: 'result', ...RESULT });
    await promise;
    assert.deepEqual(stages, ['checking-login', 'scoring', 'writing', 'compiling', 'fitting']);
  });

  it('reports the score once, before the run settles', async () => {
    const { port, scores, promise } = start();
    port.emit({ type: 'progress', stage: 'scoring' });
    assert.deepEqual(scores, []);
    port.emit(SCORE);
    assert.deepEqual(scores, [{ analysis: ANALYSIS, job: JOB }]);
    port.emit({ type: 'progress', stage: 'writing' });
    port.emit({ type: 'result', ...RESULT });
    await promise;
    assert.equal(scores.length, 1);
  });

  it('resolves as written with the result (without the message type) and disconnects', async () => {
    const { port, promise } = start();
    port.emit(SCORE);
    port.emit({ type: 'result', ...RESULT });
    assert.deepEqual(await promise, WRITTEN);
    assert.equal(port.disconnectCalls, 1);
  });

  it('resolves as skipped with the score and threshold and disconnects', async () => {
    const { port, scores, promise } = start();
    port.emit({ ...SCORE, analysis: { ...ANALYSIS, fit_score: 32 } });
    port.emit({ type: 'skipped', score: 32, threshold: 40 });
    assert.deepEqual(await promise, { kind: 'skipped', score: 32, threshold: 40 });
    assert.equal(scores.length, 1);
    assert.equal(port.disconnectCalls, 1);
  });

  it('rejects an error before the score without reporting a score', async () => {
    const { port, scores, promise } = start();
    port.emit({ type: 'progress', stage: 'scoring' });
    port.emit({ type: 'error', error: 'Claude is not logged in' });
    await assertWriterError(promise, 'Claude is not logged in', undefined);
    assert.deepEqual(scores, []);
  });

  it('rejects an error after the score', async () => {
    const { port, scores, promise } = start();
    port.emit(SCORE);
    port.emit({ type: 'progress', stage: 'writing' });
    port.emit({ type: 'error', error: 'Compile failed' });
    await assertWriterError(promise, 'Compile failed', undefined);
    assert.equal(scores.length, 1);
  });

  it('rejects a result or a skip that comes before the score', async () => {
    for (const terminal of [{ type: 'result', ...RESULT }, { type: 'skipped', score: 32, threshold: 40 }]) {
      const { port, promise } = start();
      port.emit(terminal);
      await assertWriterError(promise, OUT_OF_ORDER, undefined, true);
      assert.equal(port.disconnectCalls, 1);
    }
  });

  it('rejects a second score', async () => {
    const { port, scores, promise } = start();
    port.emit(SCORE);
    port.emit(SCORE);
    await assertWriterError(promise, OUT_OF_ORDER, undefined, true);
    assert.equal(scores.length, 1);
  });

  it('rejects with a WriterError carrying the host details', async () => {
    const { port, promise } = start();
    port.emit({ type: 'error', error: 'Claude is not logged in', details: 'run claude /login' });
    await assertWriterError(promise, 'Claude is not logged in', 'run claude /login');
    assert.equal(port.disconnectCalls, 1);
  });

  it('rejects an error message without details', async () => {
    const { port, promise } = start();
    port.emit({ type: 'error', error: 'Compile failed' });
    await assertWriterError(promise, 'Compile failed', undefined);
  });

  it('puts Chrome\'s reason in details and needs setup when the port disconnects before a terminal message', async () => {
    const { port, promise } = start({ lastError: () => 'Native host has exited.' });
    port.emit({ type: 'progress', stage: 'writing' });
    port.hostDisconnects();
    await assertWriterError(promise, STOPPED_UNEXPECTEDLY, 'Native host has exited.', true);
  });

  it('says the helper is missing, without Chrome\'s raw reason, when Chrome cannot find the host', async () => {
    const { port, promise } = start({ lastError: () => 'Specified native messaging host not found.' });
    port.hostDisconnects();
    await assertWriterError(promise, HELPER_MISSING, undefined, true);
  });

  it('needs setup when the host says so in its error', async () => {
    const { port, promise } = start();
    port.emit({ type: 'error', error: 'No readable files', details: 'Add a resume', needsSetup: true });
    await assertWriterError(promise, 'No readable files', 'Add a resume', true);
    assert.equal(port.disconnectCalls, 1);
  });

  it('does not need setup when the host says it does not', async () => {
    const { port, promise } = start();
    port.emit({ type: 'error', error: 'Compile failed', needsSetup: false });
    await assertWriterError(promise, 'Compile failed', undefined, false);
  });

  it('says the helper is missing when Chrome forbids this extension from using the host', async () => {
    const { port, promise } = start({ lastError: () => 'Access to the specified native messaging host is forbidden.' });
    port.hostDisconnects();
    await assertWriterError(promise, HELPER_MISSING, undefined, true);
  });

  it('points at the setup page when Chrome cannot start the helper', async () => {
    const { port, promise } = start({ lastError: () => 'Failed to start native messaging host.' });
    port.hostDisconnects();
    await assertWriterError(promise, STOPPED_UNEXPECTEDLY, 'Failed to start native messaging host.', true);
  });

  it('says the helper stopped, without needing setup, when there is no lastError()', async () => {
    const { port, promise } = start();
    port.hostDisconnects();
    await assertWriterError(promise, STOPPED_UNEXPECTEDLY);
  });

  it('still resolves when disconnecting the port throws', async () => {
    const { port, promise } = start();
    port.emit(SCORE);
    port.disconnectError = new Error('Attempting to use a disconnected port object');
    assert.throws(() => port.emit({ type: 'result', ...RESULT }), /disconnected port/);
    assert.deepEqual(await promise, WRITTEN);
  });

  it('still rejects when disconnecting the port throws', async () => {
    const { port, promise } = start();
    port.disconnectError = new Error('Attempting to use a disconnected port object');
    assert.throws(() => port.emit({ type: 'error', error: 'Compile failed' }), /disconnected port/);
    await assertWriterError(promise, 'Compile failed', undefined);
  });

  it('rejects and disconnects when the timeout elapses', async () => {
    const { port, promise } = start({ timeoutMs: 20 });
    await assert.rejects(promise, (err: unknown) => {
      assert.ok(err instanceof WriterError);
      assert.match(err.message, /^Resume writing timed out after \d+ min\.$/);
      return true;
    });
    assert.equal(port.disconnectCalls, 1);
  });

  it('reports the timeout in whole minutes', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { port, promise } = start({ timeoutMs: 10 * 60_000 });
    t.mock.timers.tick(10 * 60_000);
    await assertWriterError(promise, 'Resume writing timed out after 10 min.');
    assert.equal(port.disconnectCalls, 1);
  });

  it('rejects an unrecognised message and disconnects', async () => {
    const { port, promise } = start();
    port.emit({ type: 'banana' });
    await assertWriterError(promise, UNEXPECTED_MESSAGE);
    assert.equal(port.disconnectCalls, 1);
  });

  it('rejects a malformed result', async () => {
    const { port, promise } = start();
    port.emit(SCORE);
    port.emit({ type: 'result', success: true });
    await assertWriterError(promise, UNEXPECTED_MESSAGE);
  });

  it('ignores messages and disconnects after it has settled', async () => {
    const { port, stages, scores, promise } = start();
    port.emit(SCORE);
    port.emit({ type: 'result', ...RESULT });
    port.emit({ type: 'progress', stage: 'writing' });
    port.emit(SCORE);
    port.emit({ type: 'error', error: 'late' });
    port.hostDisconnects();
    assert.deepEqual(await promise, WRITTEN);
    assert.deepEqual(stages, []);
    assert.equal(scores.length, 1);
    assert.equal(port.disconnectCalls, 1);
  });

  it('does not disconnect again when the timeout elapses after the result', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { port, promise } = start({ timeoutMs: 1_000 });
    port.emit(SCORE);
    port.emit({ type: 'result', ...RESULT });
    await promise;
    t.mock.timers.tick(5_000);
    assert.equal(port.disconnectCalls, 1);
  });
});

describe('WriterError', () => {
  it('is an Error with a name and optional details', () => {
    const err = new WriterError('boom', { details: 'more' });
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'WriterError');
    assert.equal(err.details, 'more');
    assert.equal(new WriterError('boom').details, undefined);
  });

  it('needs setup only when told so', () => {
    assert.equal(new WriterError('boom').needsSetup, false);
    assert.equal(new WriterError('boom', { details: 'more' }).needsSetup, false);
    assert.equal(new WriterError('boom', { details: 'more', needsSetup: true }).needsSetup, true);
  });
});
