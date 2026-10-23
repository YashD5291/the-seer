import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { readDocuments, type SourceDocument } from './my-files/store';
import { fileProblem, hasErrnoCode, ProfileError } from './setup-error';

// ENOTDIR: some part of the path is a file, so nothing can be below it.
const MISSING = ['ENOENT', 'ENOTDIR'];

export interface Profile {
  documents: SourceDocument[];
}

export async function loadProfile(profileDir: string): Promise<Profile> {
  if (!(await statIfPresent(profileDir))?.isDirectory()) {
    throw new ProfileError(
      `My files folder not found: ${profileDir} — open The Seer's setup page and add your resume`,
    );
  }
  return { documents: await readDocuments(profileDir) };
}

// null when nothing is there; stat follows symlinks, so a linked file counts as a file.
async function statIfPresent(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if (MISSING.some((code) => hasErrnoCode(error, code))) return null;
    throw fileProblem('read', path, error);
  }
}
