import { DEFAULT_MIN_SCORE } from './fit.js';
import type { ClaudeEffort } from './types.js';

/** The models that can write a resume; the scorer's model is fixed (see SCORE_MODEL in fit.ts). */
export const CLAUDE_MODELS = [
  { id: 'opus', label: 'Opus — best' },
  { id: 'sonnet', label: 'Sonnet — faster, lighter on usage' },
] as const;

/** The writer always runs at this effort; it is not a setting. */
export const WRITER_EFFORT: ClaudeEffort = 'medium';

export const DEFAULT_CLAUDE_MODEL = 'opus';
export const DEFAULT_MAX_PAGES = 2;

/** The most characters of extra instructions the helper takes; the setup page's box has the same limit. */
export const MAX_WRITER_NOTES = 2000;

/** Stored values that are not an offered alias (a browser-era name such as 'Sonnet 4.5', or a retired model such as 'haiku') fall back to the default. */
export function normalizeClaudeModel(stored: unknown): string {
  const known = CLAUDE_MODELS.find((model) => model.id === stored);
  return known ? known.id : DEFAULT_CLAUDE_MODEL;
}

/** Only the numbers 1 and 2 are valid; a numeric string such as '1' is not. */
export function normalizeMaxPages(stored: unknown): 1 | 2 {
  return stored === 1 || stored === 2 ? stored : DEFAULT_MAX_PAGES;
}

/** Only whole numbers from 0 to 100 are valid; a numeric string such as '50' is not. */
export function normalizeMinScore(stored: unknown): number {
  const valid = typeof stored === 'number' && Number.isInteger(stored) && stored >= 0 && stored <= 100;
  return valid ? stored : DEFAULT_MIN_SCORE;
}

/** Trimmed text of at most MAX_WRITER_NOTES characters; anything else (nothing stored, a number) is ''. */
export function normalizeWriterNotes(stored: unknown): string {
  return typeof stored === 'string' ? stored.trim().slice(0, MAX_WRITER_NOTES) : '';
}
