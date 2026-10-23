import type { HostJobFacts, HostResultMessage, WriteRequest, WriteResult, WriteStage } from './host-protocol.js';
import { isHostMessage } from './host-protocol.js';
import { notInstalledMessage } from './helper-client.js';
import type { FitAnalysis } from './types.js';

/** The slice of chrome.runtime.Port the writer uses, so tests can pass a fake. */
export interface NativePortLike {
  postMessage(msg: unknown): void;
  onMessage: { addListener(cb: (msg: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
  disconnect(): void;
}

export interface WriterIo {
  connect: () => NativePortLike;
  /** Read inside the disconnect handler, where chrome.runtime.lastError is valid. */
  lastError: () => string | undefined;
  onProgress: (stage: WriteStage) => void;
  /** Called once with the host's fit score, before the run settles (unless it fails first). */
  onScore: (analysis: FitAnalysis, job: HostJobFacts) => void;
  timeoutMs: number;
}

/** How a host job ended: a resume was written, or the score was below the threshold. */
export type HostOutcome =
  | { kind: 'written'; result: WriteResult }
  | { kind: 'skipped'; score: number; threshold: number };

const STOPPED_UNEXPECTEDLY =
  'The helper stopped unexpectedly — re-run the install command from the setup page.';
const UNEXPECTED_MESSAGE = 'Unexpected message from the helper';
const OUT_OF_ORDER =
  'The helper answered out of order — it may be out of date; re-run the install command from the setup page.';
const MS_PER_MINUTE = 60_000;

interface WriterErrorOptions {
  details?: string;
  /** The fix is on the setup page: the helper is missing, or it said so in its error. */
  needsSetup?: boolean;
}

export class WriterError extends Error {
  details?: string;
  /** The fix is on the setup page: the helper is missing, or it said so in its error. */
  needsSetup: boolean;

  constructor(message: string, options: WriterErrorOptions = {}) {
    super(message);
    this.name = 'WriterError';
    this.details = options.details;
    this.needsSetup = options.needsSetup ?? false;
  }
}

function toWriteResult(msg: HostResultMessage): WriteResult {
  const { type: _type, ...result } = msg;
  return result;
}

/** An out-of-order reply means an outdated helper; the fix is on the setup page. */
function outOfOrder(): WriterError {
  return new WriterError(OUT_OF_ORDER, { needsSetup: true });
}

/**
 * Why the port closed before the job ended. A helper Chrome cannot find (or forbids) is "not
 * installed"; any other reason Chrome gives (e.g. "Failed to start native messaging host.") goes
 * in details, and both point at the setup page.
 */
function disconnectError(lastError: string | undefined): WriterError {
  if (!lastError) return new WriterError(STOPPED_UNEXPECTEDLY);
  const missing = notInstalledMessage(lastError);
  if (missing !== null) return new WriterError(missing, { needsSetup: true });
  return new WriterError(STOPPED_UNEXPECTEDLY, { details: lastError, needsSetup: true });
}

function timeoutMessage(timeoutMs: number): string {
  return `Resume writing timed out after ${Math.round(timeoutMs / MS_PER_MINUTE)} min.`;
}

/**
 * Asks the helper to score a job and, if the score passes, write its resume. Reports the
 * score through `io.onScore`, then resolves with the outcome, or rejects with a WriterError once
 * the host reports an error, stops, sends something unrecognised or out of order (a second
 * score, or an outcome before the score), or `io.timeoutMs` passes.
 */
export function writeResumeViaHost(req: WriteRequest, io: WriterIo): Promise<HostOutcome> {
  return new Promise<HostOutcome>((resolve, reject) => {
    const port = io.connect();
    let settled = false;
    let scored = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    /** Marks the run finished; returns false if it already was. */
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      return true;
    };

    // Settle the promise before disconnecting, so a throwing disconnect() cannot leave it pending.
    const succeed = (outcome: HostOutcome): void => {
      if (!settle()) return;
      resolve(outcome);
      port.disconnect();
    };

    const fail = (error: Error): void => {
      if (!settle()) return;
      reject(error);
      port.disconnect();
    };

    port.onMessage.addListener((msg) => {
      if (settled) return;
      if (!isHostMessage(msg)) {
        fail(new WriterError(UNEXPECTED_MESSAGE));
        return;
      }
      switch (msg.type) {
        case 'progress':
          io.onProgress(msg.stage);
          return;
        case 'score':
          if (scored) {
            fail(outOfOrder());
            return;
          }
          scored = true;
          io.onScore(msg.analysis, msg.job);
          return;
        case 'skipped':
          if (!scored) fail(outOfOrder());
          else succeed({ kind: 'skipped', score: msg.score, threshold: msg.threshold });
          return;
        case 'result':
          if (!scored) fail(outOfOrder());
          else succeed({ kind: 'written', result: toWriteResult(msg) });
          return;
        case 'error':
          fail(new WriterError(msg.error, { details: msg.details, needsSetup: msg.needsSetup === true }));
          return;
      }
    });

    port.onDisconnect.addListener(() => {
      if (!settle()) return;
      reject(disconnectError(io.lastError()));
    });

    timer = setTimeout(() => fail(new WriterError(timeoutMessage(io.timeoutMs))), io.timeoutMs);

    try {
      port.postMessage({ command: 'write', ...req });
    } catch (err) {
      fail(err instanceof Error ? err : new WriterError(String(err)));
    }
  });
}
