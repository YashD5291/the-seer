import type { WriteStage } from './host-protocol.js';
import type { PdfReadyMessage } from './types.js';

/** The words the job page shows about a resume being written, finished, failed or skipped. Pure. */

/** The most missing keywords the panel lists; the rest are counted. */
export const MAX_MISSING_SHOWN = 12;

/** What the panel's status bar shows. */
export interface WriterStatus {
  state: 'working' | 'ready' | 'error' | 'skipped';
  text: string;
  /** A line under `text`, e.g. that the resume did not fit its page budget. */
  note: string | null;
  /** Keywords the resume lacks, at most `MAX_MISSING_SHOWN`. */
  missing: string[];
  /** How many more missing keywords are not listed. */
  moreMissing: number;
}

const STAGE_TEXT: Record<WriteStage, string> = {
  'checking-login': 'Checking Claude login…',
  scoring: 'Scoring fit…',
  writing: 'Writing resume…',
  compiling: 'Building PDF…',
  fitting: 'Fitting to page budget…',
};

/** `count` and `noun`, singular for one and plural otherwise, e.g. "1 page", "12,345 words". */
export function plural(count: number, noun: string): string {
  return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * "Resume ready · 2 pages · 9/12 keywords · trimmed 3 bullets"; the keyword part is left out
 * without a score and the trim part when no bullet was trimmed.
 */
export function readySummary(
  pages: number,
  coverage?: { matched: number; total: number },
  trimmedBullets = 0,
): string {
  const parts = ['Resume ready', plural(pages, 'page')];
  if (coverage) parts.push(`${coverage.matched}/${coverage.total} keywords`);
  if (trimmedBullets > 0) parts.push(`trimmed ${plural(trimmedBullets, 'bullet')}`);
  return parts.join(' · ');
}

function fitNote(msg: PdfReadyMessage): string | null {
  if (!msg.fits) return `Couldn't fit ${plural(msg.maxPages, 'page')}; trimmed ${plural(msg.trimmedBullets, 'bullet')}`;
  return msg.trimmedBullets > 0 ? `Trimmed ${plural(msg.trimmedBullets, 'bullet')} to fit` : null;
}

export function workingStatus(stage: WriteStage): WriterStatus {
  return { state: 'working', text: STAGE_TEXT[stage], note: null, missing: [], moreMissing: 0 };
}

export function readyStatus(msg: PdfReadyMessage): WriterStatus {
  const missing = msg.coverage?.missing ?? [];
  return {
    state: 'ready',
    text: readySummary(msg.pages, msg.coverage),
    note: fitNote(msg),
    missing: missing.slice(0, MAX_MISSING_SHOWN),
    moreMissing: Math.max(0, missing.length - MAX_MISSING_SHOWN),
  };
}

export function errorStatus(error: string): WriterStatus {
  return { state: 'error', text: `Resume failed: ${error}`, note: null, missing: [], moreMissing: 0 };
}

/** The host scored the job below the threshold, so no resume was written. */
export function skippedStatus(score: number, threshold: number): WriterStatus {
  return {
    state: 'skipped',
    text: `Fit ${score}/100 is below ${threshold} — no resume written.`,
    note: null,
    missing: [],
    moreMissing: 0,
  };
}

/** The toast for a failed resume: the error plus the first non-blank line of the host's details. */
export function errorToastText(error: string, details?: string): string {
  const firstLine = details
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '');
  return firstLine ? `${error} — ${firstLine}` : error;
}
