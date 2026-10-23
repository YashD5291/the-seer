import { isOneOf, isRecord } from './guards.js';
import type { UnknownRecord } from './guards.js';
import type { ClaudeEffort, FitAnalysis } from './types.js';

/** Messages exchanged with the native resume host (`com.theseer.resumegen`) over a long-lived port. */

export type WriteStage = 'checking-login' | 'scoring' | 'writing' | 'compiling' | 'fitting';

const WRITE_STAGES: readonly WriteStage[] = ['checking-login', 'scoring', 'writing', 'compiling', 'fitting'];

/** The host scores the job with `scoreModel` and writes it with `model` only when the score is at least `minScore`. */
export interface WriteRequest {
  job: { text: string; url: string; title: string };
  model: string;
  effort: ClaudeEffort;
  maxPages: 1 | 2;
  scoreModel: string;
  scoreEffort: ClaudeEffort;
  minScore: number;
  /** The person's extra instructions for the writer (at most MAX_WRITER_NOTES characters); the writer only. */
  writerNotes?: string;
}

/** The job facts the scorer copied from the posting. */
export interface HostJobFacts {
  title: string;
  company: string;
  location?: string;
  salary_range?: string;
  job_type?: string;
  requirements: string[];
  nice_to_haves: string[];
}

export interface WriteResult {
  success: true;
  folderName: string;
  folderPath: string;
  texPath: string;
  pdfPath: string;
  uploadPdfPath: string;
  pages: number;
  fits: boolean;
  trimmedBullets: number;
  latexSource: string;
  pdfBase64: string;
  pdfSizeBytes: number;
  resumeText: string;
  keywords: string[];
}

export interface HostProgressMessage {
  type: 'progress';
  stage: WriteStage;
}

export interface HostResultMessage extends WriteResult {
  type: 'result';
}

/** The fit score; not terminal — `skipped`, `result` or `error` follows. */
export interface HostScoreMessage {
  type: 'score';
  analysis: FitAnalysis;
  job: HostJobFacts;
}

/** The score was below the request's `minScore`, so nothing was written. */
export interface HostSkippedMessage {
  type: 'skipped';
  score: number;
  threshold: number;
}

export interface HostErrorMessage {
  type: 'error';
  error: string;
  details?: string;
  /** The fix is on the setup page (e.g. no readable files, Claude Code signed out). */
  needsSetup?: boolean;
}

export type HostMessage =
  | HostProgressMessage
  | HostScoreMessage
  | HostSkippedMessage
  | HostResultMessage
  | HostErrorMessage;

const COMPETITION_LEVELS: readonly FitAnalysis['estimated_competition'][] = ['low', 'medium', 'high'];
const RECOMMENDATIONS: readonly FitAnalysis['apply_recommendation'][] = ['strong_yes', 'yes', 'maybe', 'no'];

function hasStrings(msg: UnknownRecord, fields: readonly string[]): boolean {
  return fields.every((field) => typeof msg[field] === 'string');
}

function hasNumbers(msg: UnknownRecord, fields: readonly string[]): boolean {
  return fields.every((field) => typeof msg[field] === 'number');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isResultMessage(msg: UnknownRecord): boolean {
  return (
    msg.success === true &&
    hasStrings(msg, [
      'folderName',
      'folderPath',
      'texPath',
      'pdfPath',
      'uploadPdfPath',
      'latexSource',
      'pdfBase64',
      'resumeText',
    ]) &&
    hasNumbers(msg, ['pages', 'trimmedBullets', 'pdfSizeBytes']) &&
    typeof msg.fits === 'boolean' &&
    isStringArray(msg.keywords)
  );
}

function hasStringArrays(msg: UnknownRecord, fields: readonly string[]): boolean {
  return fields.every((field) => isStringArray(msg[field]));
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isAnalysis(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasNumbers(value, ['fit_score', 'confidence']) &&
    typeof value.recommended_base === 'string' &&
    value.recommended_base !== '' &&
    typeof value.base_reasoning === 'string' &&
    hasStringArrays(value, ['key_matches', 'gaps', 'gap_mitigation', 'tailoring_priorities', 'ats_keywords', 'red_flags']) &&
    isOneOf(value.estimated_competition, COMPETITION_LEVELS) &&
    isOneOf(value.apply_recommendation, RECOMMENDATIONS)
  );
}

function isJobFacts(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasStrings(value, ['title', 'company']) &&
    hasStringArrays(value, ['requirements', 'nice_to_haves']) &&
    isOptionalString(value.location) &&
    isOptionalString(value.salary_range) &&
    isOptionalString(value.job_type)
  );
}

function isErrorMessage(msg: UnknownRecord): boolean {
  return (
    typeof msg.error === 'string' &&
    (msg.details === undefined || typeof msg.details === 'string') &&
    (msg.needsSetup === undefined || typeof msg.needsSetup === 'boolean')
  );
}

export function isHostMessage(value: unknown): value is HostMessage {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'progress':
      return isOneOf(value.stage, WRITE_STAGES);
    case 'score':
      return isAnalysis(value.analysis) && isJobFacts(value.job);
    case 'skipped':
      return hasNumbers(value, ['score', 'threshold']);
    case 'result':
      return isResultMessage(value);
    case 'error':
      return isErrorMessage(value);
    default:
      return false;
  }
}
