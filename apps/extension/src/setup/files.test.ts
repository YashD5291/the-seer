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
  otherFiles,
  slotRows,
  TOO_BIG_TEXT,
  toBase64,
  tooBigFile,
  withFile,
} from './files.ts';
import type { MyFile, MyFileStatus, Slot } from '../shared/helper-types.ts';

function file(status: MyFileStatus, words = 0, name = 'resume.pdf', slot: Slot | null = null): MyFile {
  return { name, kind: 'pdf', words, status, modified: '2026-10-23', slot };
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

  it('too-big is the same line a slot upload reports for a file that is never sent', () => {
    assert.equal(TOO_BIG_TEXT, fileStatusText(file('too-big')));
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
      slot: null,
    });
  });
});

describe('slotRows', () => {
  it('lists the career story, then the three base resumes, in that order', () => {
    const rows = slotRows([]);
    assert.deepEqual(
      rows.map((row) => [row.slot, row.label]),
      [
        ['career-story', 'Career story'],
        ['resume-1', 'Base resume 1'],
        ['resume-2', 'Base resume 2'],
        ['resume-3', 'Base resume 3'],
      ],
    );
  });

  it('describes the career story, and each resume, in one line', () => {
    const rows = slotRows([]);
    assert.equal(rows[0].hint, 'Your work history in your own words — the fullest record of what you did.');
    for (const row of rows.slice(1)) assert.equal(row.hint, 'A resume you already use.');
  });

  it('leaves every row empty while no file fills a slot', () => {
    assert.deepEqual(
      slotRows([file('read', 300, 'notes.md')]).map((row) => row.file),
      [null, null, null, null],
    );
  });

  it('puts each file in the row of its slot, whatever order the files come in', () => {
    const story = file('read', 900, 'story.md', 'career-story');
    const second = file('no-text', 0, 'scan.pdf', 'resume-2');
    const rows = slotRows([second, file('read', 50, 'notes.md'), story]);
    assert.deepEqual(
      rows.map((row) => row.file),
      [story, null, second, null],
    );
  });
});

describe('otherFiles', () => {
  it('keeps only the files that fill no slot, in the order given', () => {
    const notes = file('read', 50, 'notes.md');
    const linkedin = file('read', 700, 'profile.pdf');
    const files = [notes, file('read', 900, 'story.md', 'career-story'), linkedin, file('read', 400, 'cv.pdf', 'resume-1')];
    assert.deepEqual(otherFiles(files), [notes, linkedin]);
  });

  it('is empty when every file fills a slot, and when there are no files', () => {
    assert.deepEqual(otherFiles([file('read', 400, 'cv.pdf', 'resume-1')]), []);
    assert.deepEqual(otherFiles([]), []);
  });
});

describe('withFile', () => {
  it('adds a file and keeps the list sorted by name', () => {
    const files = [file('read', 5, 'b.md'), file('read', 5, 'd.md')];
    assert.deepEqual(
      withFile(files, file('read', 5, 'c.md')).map((f) => f.name),
      ['b.md', 'c.md', 'd.md'],
    );
  });

  it('replaces the file that held the slot, as the helper does', () => {
    const old = file('read', 400, 'old-cv.pdf', 'resume-1');
    const other = file('read', 400, 'cv-2.pdf', 'resume-2');
    const added = file('read', 420, 'new-cv.pdf', 'resume-1');
    assert.deepEqual(withFile([old, other], added), [other, added]);
  });

  it('does not replace anything for a file without a slot', () => {
    const files = [file('read', 5, 'a.md'), file('read', 5, 'b.md')];
    assert.equal(withFile(files, file('read', 5, 'c.md')).length, 3);
  });

  it('leaves the list it was given as it was', () => {
    const files = [file('read', 400, 'old-cv.pdf', 'resume-1')];
    withFile(files, file('read', 420, 'new-cv.pdf', 'resume-1'));
    assert.deepEqual(files, [file('read', 400, 'old-cv.pdf', 'resume-1')]);
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
