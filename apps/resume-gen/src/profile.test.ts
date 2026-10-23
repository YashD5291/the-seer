import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDocuments } from './my-files/store';
import { loadProfile } from './profile';
import { ProfileError } from './setup-error';

let profileDir: string;

beforeEach(() => {
  profileDir = mkdtempSync(join(tmpdir(), 'seer-profile-'));
});

afterEach(() => {
  rmSync(profileDir, { recursive: true, force: true });
});

function writeProfileFile(name: string, text: string): string {
  const path = join(profileDir, name);
  writeFileSync(path, text);
  return path;
}

function writeDocuments(): void {
  writeProfileFile('resume.md', '# Alex Rivera\nMachine learning engineer.');
  writeProfileFile('career-notes.txt', 'Built a search service at Example Corp.');
}

async function loadError(dir: string): Promise<ProfileError> {
  const error = await loadProfile(dir).then(
    () => null,
    (reason: unknown) => reason,
  );
  if (error instanceof ProfileError) return error;
  throw new Error(`expected loadProfile to reject with a ProfileError, got ${String(error)}`);
}

describe('loadProfile', () => {
  it('takes its documents from the My files store', async () => {
    writeDocuments();

    const profile = await loadProfile(profileDir);

    expect(profile.documents).toEqual(await readDocuments(profileDir));
    expect(profile.documents.map((source) => source.name)).toEqual(['career-notes.txt', 'resume.md']);
    expect(profile.documents.map((source) => source.text)).toEqual([
      'Built a search service at Example Corp.',
      '# Alex Rivera\nMachine learning engineer.',
    ]);
  });

  it('is only the documents: no instructions come from the folder', async () => {
    writeDocuments();

    expect(Object.keys(await loadProfile(profileDir))).toEqual(['documents']);
  });

  it('reads a file named resume-prompt.md like any other document', async () => {
    writeDocuments();
    writeProfileFile('resume-prompt.md', 'Write tighter bullets.');

    const profile = await loadProfile(profileDir);

    expect(profile.documents.map((source) => source.name)).toEqual([
      'career-notes.txt',
      'resume-prompt.md',
      'resume.md',
    ]);
    expect(profile.documents.find((source) => source.name === 'resume-prompt.md')?.text).toBe('Write tighter bullets.');
  });
});

describe('loadProfile errors', () => {
  it('names a missing folder', async () => {
    const missing = join(profileDir, 'nope');

    const error = await loadError(missing);

    expect(error.message).toContain('My files folder not found');
    expect(error.message).toContain(missing);
  });

  it('treats a path that is a file as a missing folder', async () => {
    const file = writeProfileFile('plain-file', 'text');

    expect((await loadError(file)).message).toContain('My files folder not found');
  });

  it('passes on the store error when no file is readable', async () => {
    writeProfileFile('photo.png', 'not text');

    expect((await loadError(profileDir)).message).toContain('No readable files in My files');
  });
});
