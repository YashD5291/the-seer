/** Pure helpers for delivering a finished (or failed) resume. No chrome.* here. */

import type { WriteResult } from '../shared/host-protocol.js';
import { keywordCoverage } from '../shared/keyword-score.js';
import { readySummary } from '../shared/resume-status.js';
import type { FitAnalysis, PdfReadyMessage, ResumeCoverage } from '../shared/types.js';
import type { JobRef } from './job-runner.js';

/** How many jobs keep their resume in session storage for the editor. */
export const MAX_EDITOR_JOBS = 20;

const NOTICE_MAX_CHARS = 150;
const FAILED_PREFIX = 'Resume failed — ';

/**
 * The job ids to keep after `newId` is added (oldest first, `newId` last) and the ids
 * whose stored resumes should be removed.
 */
export function retainRecentJobs(
  ids: readonly string[],
  newId: string,
  max: number = MAX_EDITOR_JOBS,
): { kept: string[]; dropped: string[] } {
  const ordered = [...ids.filter((id) => id !== newId), newId];
  const cut = Math.max(0, ordered.length - max);
  return { kept: ordered.slice(cut), dropped: ordered.slice(0, cut) };
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

/** Title and message for the system notification about a failed resume. */
export function failureNotice(
  job: { company: string; title: string } | null,
  error: string,
): { title: string; message: string } {
  const title = [job?.company, job?.title].filter(Boolean).join(' — ') || 'The Seer';
  return { title, message: truncate(`${FAILED_PREFIX}${error}`, NOTICE_MAX_CHARS) };
}

const EXPIRED_PREFIX = 'This resume is no longer in this session — ';

/**
 * Shown when a job's resume can no longer be opened in the editor (pruned or session over) nor
 * as a file; names the PDF's folder when its path is known.
 */
export function expiredResumeNotice(pdfPath?: string): { title: string; message: string } {
  const folder = pdfPath ? pdfPath.slice(0, pdfPath.lastIndexOf('/')) : '';
  const where = folder ? `open it from ${folder}` : 'find it in your output folder.';
  return { title: 'The Seer', message: `${EXPIRED_PREFIX}${where}` };
}

/** A file:// URL for an absolute POSIX path, each segment percent-encoded so spaces, # and ? survive. */
export function fileUrlFor(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** The scorer's ATS keywords scored against the resume; null when there is nothing to score against. */
export function resumeCoverage(resumeText: string, analysis: FitAnalysis | null): ResumeCoverage | null {
  const { matched, missing, pct } = keywordCoverage(resumeText, analysis?.ats_keywords ?? []);
  const total = matched.length + missing.length;
  if (total === 0) return null;
  return { matched: matched.length, total, pct, missing };
}

/** What a finished resume tells the job page and the user. */
export function readyDelivery(
  job: JobRef,
  result: WriteResult,
  analysis: FitAnalysis | null,
): { message: PdfReadyMessage; notificationText: string } {
  const coverage = resumeCoverage(result.resumeText, analysis);
  return {
    message: {
      type: 'SEER_PDF_READY',
      jobId: job.jobId,
      jobUrl: job.jobUrl,
      pdfPath: result.pdfPath,
      folderName: result.folderName,
      pages: result.pages,
      fits: result.fits,
      trimmedBullets: result.trimmedBullets,
      maxPages: job.maxPages,
      ...(coverage && { coverage }),
    },
    notificationText: `${readySummary(result.pages, coverage ?? undefined, result.trimmedBullets)} — click to open`,
  };
}

const READY_ID_PREFIX = 'seer-';
const FAILED_ID_PREFIX = 'seer-failed-';

/** The notification that a job's resume is ready (later replaced if it can no longer be opened). */
export function readyNotificationId(jobId: string): string {
  return `${READY_ID_PREFIX}${jobId}`;
}

/** The notification that a job's resume failed. Apart from the ready id, since no resume is stored for it. */
export function failedNotificationId(jobId: string): string {
  return `${FAILED_ID_PREFIX}${jobId}`;
}

/** Which job a Seer notification is about and whether it reports a ready or a failed resume. */
export function parseNotificationId(id: string): { kind: 'ready' | 'failed'; jobId: string } | null {
  // The failed prefix starts with the ready prefix, so it is checked first.
  const kinds = [
    { kind: 'failed', prefix: FAILED_ID_PREFIX },
    { kind: 'ready', prefix: READY_ID_PREFIX },
  ] as const;
  for (const { kind, prefix } of kinds) {
    if (!id.startsWith(prefix)) continue;
    const jobId = id.slice(prefix.length);
    return jobId === '' ? null : { kind, jobId };
  }
  return null;
}

/**
 * What opening a job's resume does: the editor while it is stored, else the PDF file if its
 * path is known, else a notice to the user. Something always happens.
 */
export function resumeOpenAction(hasStoredResume: boolean, pdfPath: string | undefined): 'editor' | 'file' | 'notice' {
  if (hasStoredResume) return 'editor';
  return pdfPath ? 'file' : 'notice';
}
