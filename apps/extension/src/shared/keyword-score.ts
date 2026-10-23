/** How many of the scorer's ATS keywords the finished resume actually contains. */

export interface KeywordCoverage {
  /** Keywords found in the resume, in their first-seen spelling. */
  matched: string[];
  /** Keywords the resume lacks, in their first-seen spelling. */
  missing: string[];
  /** Matched share of all distinct keywords, rounded to a whole percent. 0 without keywords. */
  pct: number;
}

/** Characters that stay inside a word: C++, C#, Node.js, CI/CD. Anything else separates words. */
const NON_WORD_RUN = /[^a-z0-9+#./]+/g;
const TRAILING_DOTS_AND_SLASHES = /[./]+$/;
const HAS_LETTER_OR_DIGIT = /[a-z0-9]/;

/**
 * Lowercases and splits into words on everything but letters, digits and `+#./`. A word's
 * trailing `.` or `/` is dropped, so "PyTorch." at the end of a sentence still matches
 * "pytorch" while "Node.js" and ".NET" keep their dots.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(NON_WORD_RUN, ' ')
    .split(' ')
    .map((word) => word.replace(TRAILING_DOTS_AND_SLASHES, ''))
    .filter((word) => word !== '')
    .join(' ');
}

export function keywordCoverage(resumeText: string, keywords: readonly string[]): KeywordCoverage {
  const haystack = ` ${normalize(resumeText)} `;
  const seen = new Set<string>();
  const matched: string[] = [];
  const missing: string[] = [];

  for (const keyword of keywords) {
    const needle = normalize(keyword);
    if (!HAS_LETTER_OR_DIGIT.test(needle) || seen.has(needle)) continue;
    seen.add(needle);
    (haystack.includes(` ${needle} `) ? matched : missing).push(keyword);
  }

  const total = matched.length + missing.length;
  const pct = total === 0 ? 0 : Math.round((matched.length / total) * 100);
  return { matched, missing, pct };
}
