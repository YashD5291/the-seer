import { afterAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtractError, extractText, type FileKind, fileKind } from './extract';
import { minimalPdf } from './test-pdf';

const TEXTUTIL = '/usr/bin/textutil';
const SAMPLE = 'Résumé of Alex Rivera — café, naïve, 日本語\nSecond line of the résumé.';

const tempDir = mkdtempSync(join(tmpdir(), 'seer-extract-'));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

function writeTemp(name: string, content: string | Uint8Array): string {
  const path = join(tempDir, name);
  writeFileSync(path, content);
  return path;
}

// A real Word/RTF/ODT file, made by the same macOS tool the helper reads them with.
function convertedFrom(text: string, format: 'docx' | 'doc' | 'rtf' | 'odt'): string {
  const source = writeTemp(`source-${format}.txt`, text);
  const target = join(tempDir, `converted.${format}`);
  execFileSync(TEXTUTIL, ['-convert', format, source, '-output', target]);
  return target;
}

async function failureOf(path: string, kind: FileKind, timeoutMs?: number): Promise<ExtractError> {
  try {
    await extractText(path, kind, timeoutMs);
  } catch (error) {
    if (error instanceof ExtractError) return error;
    throw error;
  }
  throw new Error('expected extractText to throw an ExtractError');
}

describe('fileKind', () => {
  it.each([
    ['CV.pdf', 'pdf'],
    ['CV.PDF', 'pdf'],
    ['cv.docx', 'word'],
    ['cv.DOC', 'word'],
    ['cv.rtf', 'word'],
    ['cv.odt', 'word'],
    ['notes.txt', 'text'],
    ['notes.MD', 'text'],
    ['my.resume.v2.md', 'text'],
  ] as const)('classifies %s as %s', (name, kind) => {
    expect(fileKind(name)).toBe(kind);
  });

  it.each(['notes.pages', 'photo.png', 'README', 'archive.pdf.zip', '.pdf', ''])('has no kind for %p', (name) => {
    expect(fileKind(name)).toBeNull();
  });
});

describe('extractText', () => {
  it('returns .txt text as written, accents intact', async () => {
    expect(await extractText(writeTemp('plain.txt', SAMPLE), 'text')).toBe(SAMPLE);
  });

  it('returns .md text as written', async () => {
    const markdown = '# Résumé\n\n- Built **things** at café scale\n';

    expect(await extractText(writeTemp('notes.md', markdown), 'text')).toBe(markdown);
  });

  it.each(['docx', 'doc', 'rtf', 'odt'] as const)('reads the text of a .%s made by textutil', async (format) => {
    const text = await extractText(convertedFrom(SAMPLE, format), 'word');

    expect(text).toBe(SAMPLE);
  });

  it('reads a Word file whatever the case of its extension', async () => {
    const upper = join(tempDir, 'UPPER.DOCX');
    execFileSync(TEXTUTIL, ['-convert', 'docx', writeTemp('upper.txt', SAMPLE), '-output', upper]);

    expect(await extractText(upper, 'word')).toBe(SAMPLE);
  });

  it('reads the text of a PDF', async () => {
    const text = await extractText(writeTemp('cv.pdf', minimalPdf('Alex Rivera Staff Engineer')), 'pdf');

    expect(text).toContain('Alex Rivera Staff Engineer');
  });

  it('reads a PDF whose text has parentheses and accents', async () => {
    const text = await extractText(writeTemp('accents.pdf', minimalPdf('Café (Paris) \\ Zürich')), 'pdf');

    expect(text).toContain('Café (Paris) \\ Zürich');
  });

  it('returns an empty string for a PDF page without text', async () => {
    expect(await extractText(writeTemp('scan.pdf', minimalPdf(null)), 'pdf')).toBe('');
  });

  it('returns an empty string for a .pdf that is not a PDF', async () => {
    const randomBytes = crypto.getRandomValues(new Uint8Array(2000));

    expect(await extractText(writeTemp('random.pdf', randomBytes), 'pdf')).toBe('');
  });

  it('returns an empty string for an empty Word file', async () => {
    expect(await extractText(convertedFrom('', 'docx'), 'word')).toBe('');
  });

  it('throws an ExtractError naming the file when a .docx is not a Word file', async () => {
    const path = writeTemp('corrupt.docx', crypto.getRandomValues(new Uint8Array(300)));

    const error = await failureOf(path, 'word');

    expect(error.message).toContain('corrupt.docx');
    expect(error.message).toContain('correct format');
  });

  it('throws an ExtractError naming the file when a Word file does not exist', async () => {
    const error = await failureOf(join(tempDir, 'missing.docx'), 'word');

    expect(error.message).toContain('missing.docx');
  });

  it.skipIf(process.getuid?.() === 0)('throws an ExtractError naming the file when it cannot be read', async () => {
    const path = writeTemp('locked.txt', 'secret');
    chmodSync(path, 0o000);

    const error = await failureOf(path, 'text');

    expect(error.message).toContain('locked.txt');
    expect(error.message).toContain('EACCES');
  });

  it('throws an ExtractError naming the file when the tool times out', async () => {
    const path = writeTemp('slow.pdf', minimalPdf('Alex Rivera'));

    const error = await failureOf(path, 'pdf', 1);

    expect(error.message).toContain('slow.pdf');
    expect(error.message).toContain('timed out');
  });
});
