import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACCEPTED_TYPES,
  canLeaveFilesStep,
  fileStatusText,
  folderFailure,
  profileProblemText,
  isTooBig,
  MAX_FILE_BYTES,
  toBase64,
  tooBigFile,
} from './files.ts';
import type { MyFile, MyFileStatus } from '../shared/helper-types.ts';

function file(status: MyFileStatus, words = 0, name = 'resume.pdf'): MyFile {
  return { name, kind: 'pdf', words, status, modified: '2026-10-23' };
}

describe('ACCEPTED_TYPES', () => {
  it('lists PDF, Word, text and Markdown extensions for the file picker', () => {
    assert.equal(ACCEPTED_TYPES, '.pdf,.docx,.doc,.rtf,.odt,.txt,.md');
  });
});

describe('fileStatusText', () => {
  it('read → word count', () => {
    assert.equal(fileStatusText(file('read', 412)), 'Read · 412 words');
  });

  it('read with one word → singular', () => {
    assert.equal(fileStatusText(file('read', 1)), 'Read · 1 word');
  });

  it('read with thousands of words → grouped digits', () => {
    assert.equal(fileStatusText(file('read', 12345)), 'Read · 12,345 words');
  });

  it('no-text → asks for a Word or text export', () => {
    assert.equal(fileStatusText(file('no-text')), 'No readable text — export it as Word or text');
  });

  it('unsupported → names the types that work', () => {
    assert.equal(fileStatusText(file('unsupported')), 'Not supported — use PDF, Word, text or Markdown');
  });

  it('too-big → names the limit', () => {
    assert.equal(fileStatusText(file('too-big')), 'Too big — the limit is 10 MB');
  });
});

const OVER_CAP = 'Your files hold 320,004 characters of text, over the 300,000 limit — remove or shorten some in My files.';

describe('canLeaveFilesStep', () => {
  it('is false with no files', () => {
    assert.equal(canLeaveFilesStep([], null), false);
  });

  it('is false when no file could be read', () => {
    assert.equal(canLeaveFilesStep([file('no-text'), file('unsupported'), file('too-big')], null), false);
  });

  it('is true when at least one file is read', () => {
    assert.equal(canLeaveFilesStep([file('no-text'), file('read', 300)], null), true);
  });

  it('is false while My files has a problem, even with a file read', () => {
    assert.equal(canLeaveFilesStep([file('read', 300)], OVER_CAP), false);
  });
});

describe('profileProblemText', () => {
  it('shows the problem once a file is read', () => {
    assert.equal(profileProblemText([file('read', 300)], OVER_CAP), OVER_CAP);
  });

  it('shows nothing without a problem', () => {
    assert.equal(profileProblemText([file('read', 300)], null), undefined);
  });

  it('shows nothing while no file is read: the list or its empty note already says why', () => {
    const noReadable = "No readable files in My files — open The Seer's setup page and add your resume";
    assert.equal(profileProblemText([], noReadable), undefined);
    assert.equal(profileProblemText([file('no-text')], noReadable), undefined);
  });
});

describe('folderFailure', () => {
  it('names the dropped folder and says to drop the files inside it', () => {
    assert.equal(folderFailure('Resumes'), "Resumes: Folders can't be added — drop the files inside it");
  });
});

describe('isTooBig', () => {
  it('allows exactly 10 MB and refuses one byte more', () => {
    assert.equal(MAX_FILE_BYTES, 10 * 1024 * 1024);
    assert.equal(isTooBig(MAX_FILE_BYTES), false);
    assert.equal(isTooBig(MAX_FILE_BYTES + 1), true);
  });
});

describe('tooBigFile', () => {
  it('marks a file that is never sent to the helper as too big, dated by its last change', () => {
    const lastModified = new Date(2026, 9, 23, 12, 0).getTime();
    assert.deepEqual(tooBigFile({ name: 'scan.pdf', lastModified }), {
      name: 'scan.pdf',
      kind: 'other',
      words: 0,
      status: 'too-big',
      modified: '2026-10-23',
    });
  });
});

describe('toBase64', () => {
  it('encodes every byte value like Buffer does', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'));
  });

  it('encodes 100,000 bytes like Buffer does', () => {
    const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 31 + 7) % 256);
    assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'));
  });

  it('encodes no bytes as an empty string', () => {
    assert.equal(toBase64(new Uint8Array(0)), '');
  });
});
