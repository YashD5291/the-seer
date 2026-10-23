import type { ExtractionResult } from './types.js';

/**
 * Turns scraped page content into the job text the native host scores and writes the
 * resume from. No DOM APIs: this runs in the service worker.
 */

/** Most characters of job text passed on. */
export const MAX_JOB_TEXT_CHARS = 20_000;

const HIDDEN_ELEMENT = /<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
const BLOCK_TAG = /<\/?(?:p|div|li|br|h[1-6]|tr|td|th|table|ul|ol|dl|dt|dd|section|article|pre|blockquote|hr)\b[^>]*>/gi;
const ANY_TAG = /<[^>]*>/g;
const ENTITY = /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi;
const MAX_CODE_POINT = 0x10ffff;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  ndash: '–',
  mdash: '—',
  bull: '•',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
};

function decodeEntity(match: string, body: string): string {
  if (body.startsWith('#')) {
    const isHex = body[1] === 'x' || body[1] === 'X';
    const codePoint = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return codePoint <= MAX_CODE_POINT ? String.fromCodePoint(codePoint) : match;
  }
  return NAMED_ENTITIES[body.toLowerCase()] ?? match;
}

/**
 * Plain text of an HTML fragment: script/style/noscript bodies and comments are removed, block
 * tags become line breaks, other tags are dropped. Only for real HTML — in plain text, `<` and
 * `>` are prose.
 */
export function htmlToText(html: string): string {
  return html
    .replace(HIDDEN_ELEMENT, '')
    .replace(COMMENT, '')
    .replace(BLOCK_TAG, '\n')
    .replace(ANY_TAG, '')
    .replace(ENTITY, decodeEntity)
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * The scraped page content as plain text. A scraped description and a successful scrape's
 * text are already plain; only a failed scrape (iframe-only page) leaves page HTML.
 */
function pageText(extraction: ExtractionResult): string {
  if (extraction.jobData) return extraction.jobData.description;
  return extraction.success ? extraction.rawText : htmlToText(extraction.rawText);
}

/**
 * The job text for this page: the longest of the scraped description or page text and each
 * fetched iframe's text (already plain; the caller converts them).
 * With job data, its description is the candidate (`rawText` holds the same text).
 */
export function pickJobText(input: {
  extraction: ExtractionResult;
  iframeTexts: string[];
}): string {
  const { extraction, iframeTexts } = input;

  const candidates: string[] = [pageText(extraction), ...iframeTexts];

  const longest = candidates.reduce((best, candidate) => (candidate.length > best.length ? candidate : best), '');
  return longest.slice(0, MAX_JOB_TEXT_CHARS);
}
