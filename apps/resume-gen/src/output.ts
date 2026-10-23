import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_FOLDER_NAME_LENGTH = 80;
const FOLDER_SEPARATOR = ' - ';
const UNTITLED_FOLDER = 'Untitled';
const FALLBACK_UPLOAD_NAME = 'Resume.pdf';
// Path separators, Windows-reserved characters, and control characters.
const FORBIDDEN_CHARS = /[/\\:*?"<>|\p{Cc}]/gu;
const EDGE_JUNK = /^[\s.-]+|[\s.-]+$/g;
const HIGH_SURROGATE_AT_END = /[\uD800-\uDBFF]$/;

// Replaces forbidden characters with spaces, collapses whitespace, trims spaces, dots and dashes.
function sanitizePart(text: string): string {
  return text.replace(FORBIDDEN_CHARS, ' ').replace(/\s+/g, ' ').replace(EDGE_JUNK, '');
}

// Cutting by UTF-16 units can split an emoji, so drop a dangling half.
function truncate(text: string, maxLength: number): string {
  return text.slice(0, maxLength).replace(HIGH_SURROGATE_AT_END, '');
}

export function safeFolderName(company: string, role: string): string {
  const parts = [company, role].map(sanitizePart).filter((part) => part !== '');
  const joined = parts.join(FOLDER_SEPARATOR);
  // Cutting can leave nothing, e.g. when the whole name is a lone surrogate.
  return truncate(joined, MAX_FOLDER_NAME_LENGTH).replace(EDGE_JUNK, '') || UNTITLED_FOLDER;
}

export function nextFreeFolder(
  base: string,
  name: string,
  exists: (path: string) => boolean,
): string {
  let candidate = join(base, name);
  for (let suffix = 2; exists(candidate); suffix++) {
    candidate = join(base, `${name} (${suffix})`);
  }
  return candidate;
}

export function uploadPdfName(fullName: string): string {
  const cleaned = sanitizePart(fullName);
  return cleaned === '' ? FALLBACK_UPLOAD_NAME : `${cleaned.replace(/ /g, '_')}_Resume.pdf`;
}

// Lexical check: the paths are resolved but symlinks are not followed.
export function isPathInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  const escapes = rel === '..' || rel.startsWith(`..${sep}`);
  return rel !== '' && !escapes && !isAbsolute(rel);
}
