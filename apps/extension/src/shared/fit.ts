import type { ClaudeEffort } from './types.js';

/** The fit bar until the user sets another: the lowest fit score (0–100) that gets a resume written. */
export const DEFAULT_MIN_SCORE = 40;

/** True when `score` reaches the fit bar `threshold`. */
export function scorePasses(score: number, threshold: number): boolean {
  return score >= threshold;
}

/** The Claude Code model and effort the native host scores each job with (cheap and quick). */
export const SCORE_MODEL = 'haiku';
export const SCORE_EFFORT: ClaudeEffort = 'low';
