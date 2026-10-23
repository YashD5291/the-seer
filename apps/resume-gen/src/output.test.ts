import { describe, expect, it } from 'bun:test';
import { isPathInside, nextFreeFolder, safeFolderName, uploadPdfName } from './output';

const MAX_NAME_LENGTH = 80;

describe('safeFolderName', () => {
  it('replaces forbidden characters and joins company and role', () => {
    expect(safeFolderName('Acme/Corp | AI', 'ML Engineer: Agents*')).toBe(
      'Acme Corp AI - ML Engineer Agents',
    );
  });

  it('replaces every forbidden character', () => {
    expect(safeFolderName('a/b\\c:d*e?f"g<h>i|j', 'Role')).toBe('a b c d e f g h i j - Role');
  });

  it('falls back to Untitled when both parts are empty', () => {
    expect(safeFolderName('', '')).toBe('Untitled');
  });

  it('falls back to Untitled when both parts are only separators', () => {
    expect(safeFolderName(' / ', '..')).toBe('Untitled');
  });

  it('uses the single part that is present, without a dangling separator', () => {
    expect(safeFolderName('Acme', '')).toBe('Acme');
    expect(safeFolderName('', 'Engineer')).toBe('Engineer');
  });

  it('trims spaces, dots and dashes from both ends of each part', () => {
    expect(safeFolderName('  .-Acme-. ', '-.Engineer.- ')).toBe('Acme - Engineer');
  });

  it('collapses runs of whitespace', () => {
    expect(safeFolderName('Acme    Corp', 'ML \t  Engineer')).toBe('Acme Corp - ML Engineer');
  });

  it('removes control characters', () => {
    expect(safeFolderName('Ac\u0000me\nCorp', 'Eng\u0007ineer')).toBe('Ac me Corp - Eng ineer');
  });

  it('keeps emoji and accented letters', () => {
    expect(safeFolderName('Café 🚀 Labs', 'Ingénieur ML')).toBe('Café 🚀 Labs - Ingénieur ML');
  });

  it('cuts long input to 80 characters', () => {
    const name = safeFolderName('c'.repeat(100), 'r'.repeat(100));
    expect(name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    expect(name.length).toBeGreaterThan(0);
  });

  it('re-trims after cutting so the name never ends in a space, dot or dash', () => {
    const cutOnDash = safeFolderName('a'.repeat(79) + '-' + 'b'.repeat(100), '');
    expect(cutOnDash).toBe('a'.repeat(79));
    const cutOnSeparator = safeFolderName('a'.repeat(77), 'role');
    expect(cutOnSeparator).toBe('a'.repeat(77));
  });

  it('falls back to Untitled when cutting leaves nothing (a lone surrogate)', () => {
    expect(safeFolderName('\uD800', '')).toBe('Untitled');
  });

  it('does not split an emoji when cutting', () => {
    const name = safeFolderName('a'.repeat(79) + '🚀🚀', '');
    expect(name.isWellFormed()).toBe(true);
    expect(name).toBe('a'.repeat(79));
  });
});

describe('nextFreeFolder', () => {
  it('returns the plain name when it is free', () => {
    expect(nextFreeFolder('/out', 'X', () => false)).toBe('/out/X');
  });

  it('appends (2) when the plain name is taken', () => {
    expect(nextFreeFolder('/out', 'X', (p) => p === '/out/X')).toBe('/out/X (2)');
  });

  it('keeps counting to the first free suffix', () => {
    const taken = new Set(['/out/X', '/out/X (2)']);
    expect(nextFreeFolder('/out', 'X', (p) => taken.has(p))).toBe('/out/X (3)');
  });

  it('picks the first free suffix even when a later one is taken', () => {
    const taken = new Set(['/out/X', '/out/X (3)']);
    expect(nextFreeFolder('/out', 'X', (p) => taken.has(p))).toBe('/out/X (2)');
  });
});

describe('uploadPdfName', () => {
  it('joins the name with underscores', () => {
    expect(uploadPdfName('Alex Rivera')).toBe('Alex_Rivera_Resume.pdf');
  });

  it('trims and collapses whitespace, keeping accented letters', () => {
    expect(uploadPdfName('  José  de la Cruz ')).toBe('José_de_la_Cruz_Resume.pdf');
  });

  it('applies the folder forbidden-character rule', () => {
    expect(uploadPdfName('Al/ex: "Rivera"')).toBe('Al_ex_Rivera_Resume.pdf');
  });

  it('falls back to Resume.pdf for an empty name', () => {
    expect(uploadPdfName('')).toBe('Resume.pdf');
    expect(uploadPdfName('   ')).toBe('Resume.pdf');
    expect(uploadPdfName('/:*')).toBe('Resume.pdf');
  });
});

describe('isPathInside', () => {
  it('accepts a path strictly inside the parent', () => {
    expect(isPathInside('/out/A/a.tex', '/out')).toBe(true);
  });

  it('rejects a path that climbs out with ..', () => {
    expect(isPathInside('/out/../etc/x.tex', '/out')).toBe(false);
    expect(isPathInside('/out/A/../../etc/x.tex', '/out')).toBe(false);
  });

  it('accepts a path that goes up and back down inside the parent', () => {
    expect(isPathInside('/out/A/../B/a.tex', '/out')).toBe(true);
  });

  it('rejects a sibling that shares the parent prefix', () => {
    expect(isPathInside('/outside/a.tex', '/out')).toBe(false);
  });

  it('rejects the parent itself', () => {
    expect(isPathInside('/out', '/out')).toBe(false);
    expect(isPathInside('/out/', '/out')).toBe(false);
  });

  it('rejects the filesystem root and a path that climbs to the parent of the parent', () => {
    expect(isPathInside('/', '/out')).toBe(false);
    expect(isPathInside('/out/..', '/out')).toBe(false);
  });

  it('rejects an unrelated absolute path', () => {
    expect(isPathInside('/etc/passwd', '/out')).toBe(false);
  });

  it('accepts a child whose name merely starts with two dots', () => {
    expect(isPathInside('/out/..hidden/a.tex', '/out')).toBe(true);
  });

  it('resolves relative paths against the working directory', () => {
    expect(isPathInside('out/A/a.tex', 'out')).toBe(true);
    expect(isPathInside('out/../a.tex', 'out')).toBe(false);
  });
});
