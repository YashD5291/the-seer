import type { WriteStage } from './host-protocol.js';

export interface JobData {
  title: string;
  company: string;
  url?: string;
  location?: string;
  salary_range?: string;
  job_type?: string;
  description: string;
  requirements: string[];
  nice_to_haves: string[];
  platform?: string;
}

/** The native host's fit score for a job (Claude Code scores it against the host profile). */
export interface FitAnalysis {
  fit_score: number;
  confidence: number;
  /** Id of the host profile's closest base resume. */
  recommended_base: string;
  base_reasoning: string;
  key_matches: string[];
  gaps: string[];
  gap_mitigation: string[];
  tailoring_priorities: string[];
  ats_keywords: string[];
  red_flags: string[];
  estimated_competition: 'low' | 'medium' | 'high';
  apply_recommendation: 'strong_yes' | 'yes' | 'maybe' | 'no';
}

/** The host's score for a job: what the panel, popup and badge show. */
export interface CombinedResult {
  /** The host's job facts plus the job text it was sent (`description`) and the page URL. */
  job: JobData;
  analysis: FitAnalysis;
  /** The scoring model, e.g. `claude-haiku`. */
  model: string;
  /** The fit bar this job was scored against: the `minScore` of the settings it was started with. */
  threshold: number;
}

// Extraction result from content script scrapers
export interface ExtractionResult {
  success: boolean;
  /** Structured job data if found via JSON-LD */
  jobData: JobData | null;
  /** Raw page text fallback */
  rawText: string;
  /** JSON-LD data if found */
  jsonLd: any | null;
  url: string;
  pageTitle: string;
  /** Which tier succeeded */
  extractionMethod: 'json-ld' | 'embedded' | 'page-text' | 'iframe' | 'none';
  /** Cross-origin iframe URLs found on page (for background to fetch) */
  iframeUrls?: string[];
}

// Extension-specific types

/** Effort levels accepted by `claude -p --effort`. */
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface SeerSettings {
  /** Claude Code model alias that writes the resume (see CLAUDE_MODELS in settings-normalize.ts). */
  claudeModel: string;
  maxPages: 1 | 2;
  /** The fit bar: the lowest fit score (0–100) that gets a resume written. */
  minScore: number;
  /** The person's own requests for the writer, added after the built-in instructions; '' when there are none. */
  writerNotes: string;
}

export interface ScrapedJob {
  job: JobData;
  extraction: ExtractionResult | null;
  deepAnalysis: FitAnalysis | null;
  scrapedAt: string;
}

// Messages between content script <-> background
export type MessageType =
  | { type: 'PAGE_EXTRACTED'; extraction: ExtractionResult }
  | { type: 'DEEP_ANALYSIS_RESULT'; result: FitAnalysis; job: JobData; model?: string; threshold: number }
  /** The tab moved to another page before the host scored the job; the content script shows nothing. */
  | { type: 'STALE_RESULT' }
  | { type: 'CURRENT_JOB_RESULT'; data: ScrapedJob | null }
  | { type: 'GET_JOB_FOR_TAB'; tabId: number }
  | { type: 'SEER_OPEN_PDF'; jobId: string; pdfPath: string }
  | {
      type: 'SEER_RECOMPILE';
      texSource: string;
      texPath: string;
      folderPath: string;
      /** The `<First>_<Last>_Resume.pdf` copy the host refreshes along with the PDF. */
      uploadPdfPath: string;
    }
  /** `needsSetup`: the fix is on the setup page, so the toast offers "Open setup". */
  | { type: 'ERROR'; message: string; needsSetup?: boolean }
  /** The content script asks the background to open the setup page (content scripts cannot). */
  | { type: 'OPEN_SETUP' }
  /** The popup tells each tab's content script to show or hide the FAB. */
  | { type: 'SEER_TOGGLE'; enabled: boolean };

// What the background posts to a job page's content script about its resume. `jobId` and
// `jobUrl` say which job (FAB click) it is about; a page ignores jobs started on another URL.
// A skipped job never started a write, so it has no `jobId`.
export type TabMessage =
  | { type: 'SEER_WRITER_PROGRESS'; jobId: string; jobUrl: string; stage: WriteStage }
  | PdfReadyMessage
  | { type: 'SEER_PDF_ERROR'; jobId: string; jobUrl: string; error: string; details?: string; needsSetup?: boolean }
  | { type: 'SEER_WRITER_SKIPPED'; jobUrl: string; score: number; threshold: number };

/** How many of the scorer's ATS keywords the finished resume contains. */
export interface ResumeCoverage {
  matched: number;
  /** Distinct keywords scored: `matched` plus `missing.length`. */
  total: number;
  /** `matched / total` as a whole percent. */
  pct: number;
  missing: string[];
}

export interface PdfReadyMessage {
  type: 'SEER_PDF_READY';
  jobId: string;
  jobUrl: string;
  pdfPath: string;
  folderName: string;
  pages: number;
  fits: boolean;
  trimmedBullets: number;
  /** The page budget this run was given. */
  maxPages: 1 | 2;
  /** Absent when the scorer gave no keywords to score against. */
  coverage?: ResumeCoverage;
}

// Editor page types
export interface EditorPayload {
  pdfPath: string;
  /** The `<First>_<Last>_Resume.pdf` copy to upload to job sites. */
  uploadPdfPath: string;
  texPath: string;
  folderPath: string;
  folderName: string;
  latexSource: string;
  pdfBase64: string;
  pdfSizeBytes: number;
}

export interface RecompileResponse {
  success: boolean;
  pdfBase64?: string;
  pdfSizeBytes?: number;
  error?: string;
  compilerOutput?: string;
}
