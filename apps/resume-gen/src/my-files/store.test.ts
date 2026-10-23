import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileError, SetupError } from '../setup-error';
import {
  addMyFile,
  assertFileWithinLimit,
  inspectMyFiles,
  listMyFiles,
  MAX_FILE_BYTES,
  MAX_PROFILE_BYTES,
  MAX_PROFILE_CHARS,
  type MyFile,
  readDocuments,
  removeMyFile,
  safeFileName,
  SLOTS,
} from './store';
import { minimalPdf } from './test-pdf';

const NO_READABLE_FILES = "No readable files in My files — open The Seer's setup page and add your resume";

let root: string;
let dir: string;
let errorLog: ReturnType<typeof spyOn<Console, 'error'>>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'seer-myfiles-'));
  dir = join(root, 'My files');
  mkdirSync(dir);
  errorLog = spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorLog.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

function put(name: string, content: string | Uint8Array): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function logged(): string {
  return errorLog.mock.calls.map((args) => args.join(' ')).join('\n');
}

function cachePath(name: string): string {
  return join(dir, '.seer', `${name}.json`);
}

function readCache(name: string): { size: number; mtimeMs: number; text: string } {
  return JSON.parse(readFileSync(cachePath(name), 'utf8'));
}

async function rejection(promise: Promise<unknown>): Promise<ProfileError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProfileError) return error;
    throw error;
  }
  throw new Error('expected a ProfileError');
}

function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function slotsPath(): string {
  return join(dir, '.seer', 'slots.json');
}

function readSlotMap(): unknown {
  return JSON.parse(readFileSync(slotsPath(), 'utf8'));
}

function byName(files: MyFile[], name: string): MyFile {
  const file = files.find((candidate) => candidate.name === name);
  if (file === undefined) throw new Error(`${name} is not in the list`);
  return file;
}

describe('listMyFiles', () => {
  it('lists the top-level files sorted by name', async () => {
    put('b.md', 'Second file');
    put('a.txt', 'First file here');
    put('c.md', 'Third');

    const files = await listMyFiles(dir);

    expect(files.map((file) => file.name)).toEqual(['a.txt', 'b.md', 'c.md']);
  });

  it('skips hidden files and subfolders, and counts a symlinked file', async () => {
    put('.hidden.md', 'hidden');
    put('._AppleDouble.md', 'junk');
    put('resume.md', 'Alex Rivera');
    mkdirSync(join(dir, 'archive'));
    writeFileSync(join(dir, 'archive', 'old.md'), 'old');
    writeFileSync(join(root, 'outside.md'), 'Linked resume text');
    symlinkSync(join(root, 'outside.md'), join(dir, 'link.md'));
    symlinkSync(join(dir, 'archive'), join(dir, 'link-to-folder'));

    const files = await listMyFiles(dir);

    expect(files.map((file) => file.name)).toEqual(['link.md', 'resume.md']);
    expect(byName(files, 'link.md')).toMatchObject({ status: 'read', words: 3 });
  });

  it('lists a file named resume-prompt.md like any other file', async () => {
    put('resume-prompt.md', 'Write tighter bullets.');
    put('resume.md', 'Alex Rivera');

    const files = await listMyFiles(dir);

    expect(files.map((file) => file.name)).toEqual(['resume-prompt.md', 'resume.md']);
    expect(byName(files, 'resume-prompt.md')).toMatchObject({ status: 'read', words: 3 });
  });

  it('returns an empty list for a folder that does not exist yet', async () => {
    expect(await listMyFiles(join(root, 'not-created'))).toEqual([]);
  });

  it('explains a profile folder that is not a folder', async () => {
    const error = await rejection(listMyFiles(put('plain-file', 'x')));

    expect(error.message).toContain("Can't read");
    expect(error.message).toContain('plain-file');
    expect(error.message).toContain('ENOTDIR');
  });

  it('skips a link whose target is gone and says so', async () => {
    symlinkSync(join(root, 'gone.md'), join(dir, 'dangling.md'));
    put('real.md', 'Real text');

    const files = await listMyFiles(dir);

    expect(files.map((file) => file.name)).toEqual(['real.md']);
    expect(logged()).toContain('[theseer-pdf]');
    expect(logged()).toContain('dangling.md');
  });

  it('reports the kind, word count, status and local modified date of a readable file', async () => {
    const path = put('story.md', 'Built   things\nat\tscale  ');
    utimesSync(path, new Date(2026, 2, 5, 12, 30), new Date(2026, 2, 5, 12, 30));

    const [file] = await listMyFiles(dir);

    expect(file).toEqual({
      name: 'story.md',
      kind: 'text',
      words: 4,
      status: 'read',
      modified: '2026-03-05',
      slot: null,
    });
  });

  it('reads the text of a PDF', async () => {
    put('cv.pdf', minimalPdf('Alex Rivera Staff Engineer'));

    const [file] = await listMyFiles(dir);

    expect(file).toMatchObject({ name: 'cv.pdf', kind: 'pdf', status: 'read', words: 4 });
  });

  it('marks a PDF without text as no-text', async () => {
    put('scan.pdf', minimalPdf(null));

    const [file] = await listMyFiles(dir);

    expect(file).toMatchObject({ name: 'scan.pdf', kind: 'pdf', status: 'no-text', words: 0 });
  });

  it('marks a text file with only whitespace as no-text', async () => {
    put('blank.md', ' \n\t \n');

    const [file] = await listMyFiles(dir);

    expect(file).toMatchObject({ kind: 'text', status: 'no-text', words: 0 });
  });

  it('marks a file of an unknown type as unsupported with kind other', async () => {
    put('photo.png', new Uint8Array([137, 80, 78, 71]));

    const [file] = await listMyFiles(dir);

    expect(file).toMatchObject({ name: 'photo.png', kind: 'other', status: 'unsupported', words: 0 });
  });

  it('marks a file over 10 MB as too-big without reading it', async () => {
    truncateSync(put('huge.pdf', ''), MAX_FILE_BYTES + 1);

    const [file] = await listMyFiles(dir);

    expect(file).toMatchObject({ name: 'huge.pdf', kind: 'pdf', status: 'too-big', words: 0 });
    expect(existsSync(cachePath('huge.pdf'))).toBe(false);
    expect(logged()).toBe('');
  });

  it('reads a file of exactly 10 MB', async () => {
    put('limit.md', 'a'.repeat(MAX_FILE_BYTES));

    const [file] = await listMyFiles(dir);

    expect(file).toMatchObject({ status: 'read', words: 1 });
  });

  it('marks a Word file textutil cannot read as no-text and logs why', async () => {
    put('corrupt.docx', crypto.getRandomValues(new Uint8Array(300)));

    const [file] = await listMyFiles(dir);

    expect(file).toMatchObject({ name: 'corrupt.docx', kind: 'word', status: 'no-text', words: 0 });
    expect(logged()).toContain('[theseer-pdf]');
    expect(logged()).toContain('corrupt.docx');
    expect(existsSync(cachePath('corrupt.docx'))).toBe(false);
  });
});

describe('the text cache', () => {
  it('stores the size, mtime and text under .seer/<name>.json', async () => {
    const path = put('story.md', 'Built things at scale');

    await listMyFiles(dir);

    const stats = statSync(path);
    expect(readCache('story.md')).toEqual({ size: stats.size, mtimeMs: stats.mtimeMs, text: 'Built things at scale' });
  });

  it('leaves the cache file untouched on the next listing', async () => {
    put('cv.pdf', minimalPdf('Alex Rivera'));
    await listMyFiles(dir);
    const past = new Date(2020, 0, 1);
    utimesSync(cachePath('cv.pdf'), past, past);

    await listMyFiles(dir);

    expect(statSync(cachePath('cv.pdf')).mtimeMs).toBe(past.getTime());
  });

  it('reads from the cache while the size and mtime match', async () => {
    put('cv.pdf', minimalPdf('Alex Rivera'));
    await listMyFiles(dir);
    writeFileSync(cachePath('cv.pdf'), JSON.stringify({ ...readCache('cv.pdf'), text: 'one two three' }));

    const [file] = await listMyFiles(dir);

    expect(file).toMatchObject({ status: 'read', words: 3 });
  });

  it('caches a PDF without text so it is not opened again', async () => {
    put('scan.pdf', minimalPdf(null));
    await listMyFiles(dir);

    expect(readCache('scan.pdf').text).toBe('');
  });

  it('refreshes the cached text when the file is rewritten', async () => {
    const path = put('story.md', 'old text');
    await listMyFiles(dir);

    writeFileSync(path, 'brand new text that is longer');
    const [file] = await listMyFiles(dir);

    expect(file.words).toBe(6);
    expect(readCache('story.md').text).toBe('brand new text that is longer');
  });

  it('refreshes the cached text when the mtime changes but the size does not', async () => {
    const path = put('story.md', 'aaaa bbbb');
    await listMyFiles(dir);

    writeFileSync(path, 'cccc dddd eeee'.slice(0, 9));
    const later = new Date(Date.now() + 60_000);
    utimesSync(path, later, later);
    await listMyFiles(dir);

    expect(readCache('story.md').text).toBe('cccc dddd');
  });

  it('re-reads the file when its cache entry is corrupt', async () => {
    put('story.md', 'Built things');
    await listMyFiles(dir);
    writeFileSync(cachePath('story.md'), '{not json');

    const [file] = await listMyFiles(dir);

    expect(file).toMatchObject({ status: 'read', words: 2 });
    expect(readCache('story.md').text).toBe('Built things');
  });

  it('re-reads the file when its cache entry has the wrong shape', async () => {
    put('story.md', 'Built things');
    await listMyFiles(dir);
    writeFileSync(cachePath('story.md'), JSON.stringify({ size: 'big' }));

    const [file] = await listMyFiles(dir);

    expect(file).toMatchObject({ status: 'read', words: 2 });
  });

  it('still lists the files when the cache cannot be written, and logs it', async () => {
    put('.seer', 'a file where the cache folder should be');
    put('story.md', 'Built things');

    const [file] = await listMyFiles(dir);

    expect(file).toMatchObject({ name: 'story.md', status: 'read', words: 2 });
    expect(logged()).toContain('[theseer-pdf]');
    expect(logged()).toContain("Couldn't cache");
  });
});

describe('safeFileName', () => {
  it.each([
    ['My CV.pdf', 'My CV.pdf'],
    ['../evil.md', 'evil.md'],
    ['/etc/passwd', 'passwd'],
    ['..\\..\\evil.md', 'evil.md'],
    ['C:\\Users\\alex\\cv.docx', 'cv.docx'],
    ['a/b\\c/d.md', 'd.md'],
    ['.hidden.md', 'hidden.md'],
    ['..twice.md', 'twice.md'],
    ['  . spaced.md', 'spaced.md'],
    ['\u00a0.nbsp.md', 'nbsp.md'],
    ['\u3000.ideographic.md', 'ideographic.md'],
    ['\ufeff.bom.md', 'bom.md'],
    [' \u00a0.\u3000..mixed.md', 'mixed.md'],
    ['trailing.md  ', 'trailing.md'],
    ['a\u0000b\tc\u007f.md', 'abc.md'],
    ['résumé 🚀.md', 'résumé 🚀.md'],
    ['', ''],
    ['...', ''],
    ['..', ''],
    ['   ', ''],
    ['dir/', ''],
    ['dir/..', ''],
  ])('turns %p into %p', (name, expected) => {
    expect(safeFileName(name)).toBe(expected);
  });

  it('caps a long name at 120 characters and keeps the extension', () => {
    const name = safeFileName(`${'x'.repeat(300)}.pdf`);

    expect(Array.from(name)).toHaveLength(120);
    expect(name.endsWith('x.pdf')).toBe(true);
  });

  it('counts an emoji as one character when capping', () => {
    const name = safeFileName(`${'🚀'.repeat(200)}.md`);

    expect(Array.from(name)).toHaveLength(120);
    expect(name.endsWith('🚀.md')).toBe(true);
    expect(name).not.toContain('\uFFFD');
  });

  it('caps a name whose extension is absurdly long without an extension of its own', () => {
    const name = safeFileName(`a.${'e'.repeat(300)}`);

    expect(Array.from(name)).toHaveLength(120);
  });

  it('leaves a name of exactly 120 characters alone', () => {
    const name = `${'y'.repeat(116)}.txt`;

    expect(safeFileName(name)).toBe(name);
  });
});

describe('addMyFile', () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it('stores the bytes and returns the file with its status', async () => {
    const file = await addMyFile(dir, 'story.md', bytes('Built things at scale'));

    expect(file).toMatchObject({ name: 'story.md', kind: 'text', status: 'read', words: 4 });
    expect(readFileSync(join(dir, 'story.md'), 'utf8')).toBe('Built things at scale');
  });

  it('reads a dropped PDF and reports a scanned one as no-text', async () => {
    const readable = await addMyFile(dir, 'cv.pdf', minimalPdf('Alex Rivera Staff Engineer'));
    const scanned = await addMyFile(dir, 'scan.pdf', minimalPdf(null));

    expect(readable).toMatchObject({ kind: 'pdf', status: 'read', words: 4 });
    expect(scanned).toMatchObject({ kind: 'pdf', status: 'no-text', words: 0 });
  });

  it('reports a dropped file of an unknown type as unsupported', async () => {
    const file = await addMyFile(dir, 'photo.png', new Uint8Array([137, 80, 78, 71]));

    expect(file).toMatchObject({ name: 'photo.png', kind: 'other', status: 'unsupported' });
  });

  it('creates the folder when it does not exist yet', async () => {
    const nested = join(root, 'new', 'My files');

    await addMyFile(nested, 'story.md', bytes('Built things'));

    expect(readdirSync(nested)).toContain('story.md');
  });

  it('numbers a second file with the same name and never overwrites', async () => {
    await addMyFile(dir, 'My CV.pdf', minimalPdf('first'));
    const second = await addMyFile(dir, 'My CV.pdf', minimalPdf('second'));
    const third = await addMyFile(dir, 'My CV.pdf', minimalPdf('third'));

    expect(second.name).toBe('My CV (2).pdf');
    expect(third.name).toBe('My CV (3).pdf');
    expect(readdirSync(dir).sort()).toEqual(['.seer', 'My CV (2).pdf', 'My CV (3).pdf', 'My CV.pdf']);
    expect(readFileSync(join(dir, 'My CV.pdf'))).toEqual(Buffer.from(minimalPdf('first')));
  });

  it('numbers a name without an extension before the end', async () => {
    await addMyFile(dir, 'README', bytes('one'));

    expect((await addMyFile(dir, 'README', bytes('two'))).name).toBe('README (2)');
  });

  it('numbers a name that differs only in case', async () => {
    await addMyFile(dir, 'cv.md', bytes('one'));

    expect((await addMyFile(dir, 'CV.md', bytes('two'))).name).toBe('CV (2).md');
  });

  it('keeps ../evil.md inside the folder', async () => {
    const file = await addMyFile(dir, '../evil.md', bytes('Alex Rivera'));

    expect(file.name).toBe('evil.md');
    expect(existsSync(join(dir, 'evil.md'))).toBe(true);
    expect(existsSync(join(root, 'evil.md'))).toBe(false);
  });

  it('drops the leading dot of a hidden name so the file shows up', async () => {
    const file = await addMyFile(dir, '.hidden.md', bytes('Alex Rivera'));

    expect(file.name).toBe('hidden.md');
    expect((await listMyFiles(dir)).map((listed) => listed.name)).toEqual(['hidden.md']);
  });

  it('keeps accents and emoji in the name', async () => {
    const file = await addMyFile(dir, 'résumé 🚀.md', bytes('Alex Rivera'));

    expect(file.name).toBe('résumé 🚀.md');
    expect(readdirSync(dir)).toContain('résumé 🚀.md');
  });

  it('never writes through an existing link', async () => {
    writeFileSync(join(root, 'target.md'), 'precious');
    symlinkSync(join(root, 'target.md'), join(dir, 'link.md'));
    symlinkSync(join(root, 'not-there.md'), join(dir, 'dangling.md'));

    const viaLink = await addMyFile(dir, 'link.md', bytes('dropped'));
    const viaDangling = await addMyFile(dir, 'dangling.md', bytes('dropped'));

    expect(viaLink.name).toBe('link (2).md');
    expect(viaDangling.name).toBe('dangling (2).md');
    expect(readFileSync(join(root, 'target.md'), 'utf8')).toBe('precious');
    expect(existsSync(join(root, 'not-there.md'))).toBe(false);
  });

  it('stores a file named resume-prompt.md under its own name, listed like any other', async () => {
    const file = await addMyFile(dir, 'resume-prompt.md', bytes('Alex Rivera'));

    expect(file.name).toBe('resume-prompt.md');
    expect(readFileSync(join(dir, 'resume-prompt.md'), 'utf8')).toBe('Alex Rivera');
    expect((await listMyFiles(dir)).map((listed) => listed.name)).toEqual(['resume-prompt.md']);
  });

  it.each(['', '...', '/', '   '])('rejects the unusable name %p', async (name) => {
    const error = await rejection(addMyFile(dir, name, bytes('x')));

    expect(error.message).toContain("Can't add a file named");
    expect(readdirSync(dir)).toEqual([]);
  });

  it('rejects a file over 10 MB and writes nothing', async () => {
    const error = await rejection(addMyFile(dir, 'huge.pdf', new Uint8Array(MAX_FILE_BYTES + 1)));

    expect(error.message).toContain('10 MB');
    expect(error.message).toContain('huge.pdf');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('accepts a file of exactly 10 MB', async () => {
    const file = await addMyFile(dir, 'limit.md', new Uint8Array(MAX_FILE_BYTES).fill(97));

    expect(file).toMatchObject({ name: 'limit.md', status: 'read' });
  });

  it("dates the stored copy with the user's own file date when one is given", async () => {
    const lastModifiedMs = new Date(2024, 2, 15, 9, 30).getTime();

    const added = await addMyFile(dir, 'story.md', bytes('Built things'), lastModifiedMs);

    expect(added.modified).toBe('2024-03-15');
    expect(byName(await listMyFiles(dir), 'story.md').modified).toBe('2024-03-15');
    expect(statSync(join(dir, 'story.md')).mtimeMs).toBe(lastModifiedMs);
  });

  it('dates the stored copy today without a file date', async () => {
    await addMyFile(dir, 'story.md', bytes('Built things'));

    expect(byName(await listMyFiles(dir), 'story.md').modified).toBe(localToday());
  });

  it('ignores a file date that is not a finite positive number', async () => {
    const bad = [0, -1, Number.NaN, Number.POSITIVE_INFINITY];

    const added = await Promise.all(bad.map((ms, index) => addMyFile(dir, `story-${index}.md`, bytes('x'), ms)));

    expect(added.map((file) => file.modified)).toEqual(bad.map(() => localToday()));
  });

  it('explains a profile folder it cannot create', async () => {
    const error = await rejection(addMyFile(join(put('plain-file', 'x'), 'My files'), 'a.md', bytes('x')));

    expect(error.message).toContain("Can't");
    expect(error.message).toContain('plain-file');
  });
});

describe('slots', () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it('has the four places on the setup page, in order', () => {
    expect(SLOTS).toEqual(['career-story', 'resume-1', 'resume-2', 'resume-3']);
  });

  it('records the slot of an added file in .seer/slots.json and reports it', async () => {
    const added = await addMyFile(dir, 'My CV.pdf', minimalPdf('Alex Rivera'), undefined, 'resume-2');

    expect(added).toMatchObject({ name: 'My CV.pdf', slot: 'resume-2' });
    expect(readSlotMap()).toEqual({ 'resume-2': 'My CV.pdf' });
    expect(byName(await listMyFiles(dir), 'My CV.pdf').slot).toBe('resume-2');
  });

  it('reports slot null for a file added without a slot and for a file put in Finder', async () => {
    const added = await addMyFile(dir, 'notes.md', bytes('Notes here'));
    put('finder.md', 'Dropped in Finder');

    const files = await listMyFiles(dir);

    expect(added.slot).toBeNull();
    expect(files.map((file) => file.slot)).toEqual([null, null]);
    expect(existsSync(slotsPath())).toBe(false);
  });

  it('keeps one file in each slot', async () => {
    await addMyFile(dir, 'story.md', bytes('Career story text'), undefined, 'career-story');
    await addMyFile(dir, 'a.md', bytes('First resume'), undefined, 'resume-1');
    await addMyFile(dir, 'c.md', bytes('Third resume'), undefined, 'resume-3');

    const files = await listMyFiles(dir);

    expect(files.map((file) => [file.name, file.slot])).toEqual([
      ['a.md', 'resume-1'],
      ['c.md', 'resume-3'],
      ['story.md', 'career-story'],
    ]);
  });

  it('deletes the earlier file and its cache entry when a slot gets a new upload', async () => {
    await addMyFile(dir, 'old.pdf', minimalPdf('Old resume'), undefined, 'resume-1');
    expect(existsSync(cachePath('old.pdf'))).toBe(true);

    const added = await addMyFile(dir, 'new.pdf', minimalPdf('New resume'), undefined, 'resume-1');

    expect(added.slot).toBe('resume-1');
    expect(readdirSync(dir).sort()).toEqual(['.seer', 'new.pdf']);
    expect(existsSync(cachePath('old.pdf'))).toBe(false);
    expect(readSlotMap()).toEqual({ 'resume-1': 'new.pdf' });
  });

  it('lets a same-name re-upload keep its name', async () => {
    await addMyFile(dir, 'My CV.pdf', minimalPdf('Old resume'), undefined, 'resume-1');

    const added = await addMyFile(dir, 'My CV.pdf', minimalPdf('New resume'), undefined, 'resume-1');

    expect(added.name).toBe('My CV.pdf');
    expect(readdirSync(dir).sort()).toEqual(['.seer', 'My CV.pdf']);
    expect(readCache('My CV.pdf').text).toContain('New resume');
    expect(readSlotMap()).toEqual({ 'resume-1': 'My CV.pdf' });
  });

  it('leaves the other slots and unslotted files alone', async () => {
    await addMyFile(dir, 'a.md', bytes('First resume'), undefined, 'resume-1');
    await addMyFile(dir, 'b.md', bytes('Second resume'), undefined, 'resume-2');
    put('extra.md', 'Extra notes');

    await addMyFile(dir, 'a2.md', bytes('First resume again'), undefined, 'resume-1');

    expect(readdirSync(dir).sort()).toEqual(['.seer', 'a2.md', 'b.md', 'extra.md']);
    expect(readSlotMap()).toEqual({ 'resume-1': 'a2.md', 'resume-2': 'b.md' });
  });

  it('numbers an upload to a slot after an unrelated file with the same name', async () => {
    put('cv.md', 'Dropped in Finder');

    const added = await addMyFile(dir, 'cv.md', bytes('Uploaded to a slot'), undefined, 'resume-1');

    expect(added).toMatchObject({ name: 'cv (2).md', slot: 'resume-1' });
    expect(byName(await listMyFiles(dir), 'cv.md').slot).toBeNull();
  });

  it('clears the slot when its file is removed', async () => {
    await addMyFile(dir, 'story.md', bytes('Career story text'), undefined, 'career-story');
    await addMyFile(dir, 'a.md', bytes('First resume'), undefined, 'resume-1');

    const rest = await removeMyFile(dir, 'story.md');

    expect(rest.map((file) => [file.name, file.slot])).toEqual([['a.md', 'resume-1']]);
    expect(readSlotMap()).toEqual({ 'resume-1': 'a.md' });
    put('story.md', 'A different file with the old name');
    expect(byName(await listMyFiles(dir), 'story.md').slot).toBeNull();
  });

  it('drops a slot whose file was deleted in Finder on the next listing', async () => {
    await addMyFile(dir, 'a.md', bytes('First resume'), undefined, 'resume-1');
    await addMyFile(dir, 'b.md', bytes('Second resume'), undefined, 'resume-2');
    rmSync(join(dir, 'a.md'));

    const files = await listMyFiles(dir);

    expect(files.map((file) => [file.name, file.slot])).toEqual([['b.md', 'resume-2']]);
    expect(readSlotMap()).toEqual({ 'resume-2': 'b.md' });
    put('a.md', 'A new file with the old name');
    expect(byName(await listMyFiles(dir), 'a.md').slot).toBeNull();
  });

  it('treats a corrupt slots.json as empty, logs it, and replaces it on the next add', async () => {
    put('story.md', 'Career story text');
    mkdirSync(join(dir, '.seer'));
    writeFileSync(slotsPath(), '{"career-story": "story.md"');

    const files = await listMyFiles(dir);

    expect(files.map((file) => file.slot)).toEqual([null]);
    expect(logged()).toContain('[theseer-pdf]');
    expect(logged()).toContain('slots.json');

    await addMyFile(dir, 'a.md', bytes('First resume'), undefined, 'resume-1');
    expect(readSlotMap()).toEqual({ 'resume-1': 'a.md' });
  });

  it.each([
    ['a list', '["story.md"]'],
    ['an unknown slot', '{"resume-9": "story.md"}'],
    ['a file name that is not text', '{"career-story": 7}'],
    ['null', 'null'],
  ])('treats a slots.json holding %s as empty and logs it', async (_label, content) => {
    put('story.md', 'Career story text');
    mkdirSync(join(dir, '.seer'));
    writeFileSync(slotsPath(), content);

    const files = await listMyFiles(dir);

    expect(files.map((file) => file.slot)).toEqual([null]);
    expect(logged()).toContain('slots.json');
  });

  it('never deletes outside My files for a slot map that names such a path', async () => {
    writeFileSync(join(root, 'outside.md'), 'precious');
    mkdirSync(join(dir, '.seer'));
    writeFileSync(slotsPath(), JSON.stringify({ 'resume-1': '../outside.md' }));

    await addMyFile(dir, 'a.md', bytes('First resume'), undefined, 'resume-1');

    expect(readFileSync(join(root, 'outside.md'), 'utf8')).toBe('precious');
    expect(readSlotMap()).toEqual({ 'resume-1': 'a.md' });
  });

  it('keeps the earlier file when the new upload is refused', async () => {
    await addMyFile(dir, 'old.md', bytes('Old resume'), undefined, 'resume-1');

    const tooBig = await rejection(addMyFile(dir, 'huge.md', new Uint8Array(MAX_FILE_BYTES + 1), undefined, 'resume-1'));
    const unnamed = await rejection(addMyFile(dir, '...', bytes('x'), undefined, 'resume-1'));

    expect(tooBig.message).toContain('over 10 MB');
    expect(unnamed.message).toContain("Can't add a file named");
    expect(readdirSync(dir).sort()).toEqual(['.seer', 'old.md']);
    expect(readSlotMap()).toEqual({ 'resume-1': 'old.md' });
  });

  it('survives two uploads to the same slot at once: one file holds it, the other is an unslotted file or gone', async () => {
    await addMyFile(dir, 'old.md', bytes('Old resume'), undefined, 'resume-1');

    await Promise.all([
      addMyFile(dir, 'one.md', bytes('First upload'), undefined, 'resume-1'),
      addMyFile(dir, 'two.md', bytes('Second upload'), undefined, 'resume-1'),
    ]);

    const files = await listMyFiles(dir);
    const slotted = files.filter((file) => file.slot === 'resume-1');
    expect(slotted).toHaveLength(1);
    expect(['one.md', 'two.md']).toContain(slotted[0].name);
    expect(files.some((file) => file.name === 'old.md')).toBe(false);
    expect(files.filter((file) => file.slot !== 'resume-1').every((file) => file.slot === null)).toBe(true);
    expect(readSlotMap()).toEqual({ 'resume-1': slotted[0].name });
  });

  it('keeps both slots when uploads to different slots land at once', async () => {
    await Promise.all([
      addMyFile(dir, 'a.md', bytes('First resume'), undefined, 'resume-1'),
      addMyFile(dir, 'b.md', bytes('Second resume'), undefined, 'resume-2'),
      addMyFile(dir, 'story.md', bytes('Career story text'), undefined, 'career-story'),
    ]);

    expect(readSlotMap()).toEqual({ 'resume-1': 'a.md', 'resume-2': 'b.md', 'career-story': 'story.md' });
  });

  it('writes slots.json through a temp file, leaving none behind', async () => {
    await addMyFile(dir, 'a.md', bytes('First resume'), undefined, 'resume-1');
    await addMyFile(dir, 'b.md', bytes('Second resume'), undefined, 'resume-2');

    expect(readdirSync(join(dir, '.seer')).sort()).toEqual(['a.md.json', 'b.md.json', 'slots.json']);
  });

  it('explains a slot map it cannot write', async () => {
    mkdirSync(join(dir, '.seer'));
    chmodSync(join(dir, '.seer'), 0o500);

    try {
      const error = await rejection(addMyFile(dir, 'a.md', bytes('First resume'), undefined, 'resume-1'));

      expect(error.message).toContain("Can't save");
      expect(error.message).toContain('slots.json');
    } finally {
      chmodSync(join(dir, '.seer'), 0o700);
    }
  });

  it('explains a slot map it cannot read', async () => {
    mkdirSync(join(dir, '.seer'));
    mkdirSync(slotsPath());

    const error = await rejection(listMyFiles(dir));

    expect(error.message).toContain("Can't read");
    expect(error.message).toContain('slots.json');
  });
});

describe('removeMyFile', () => {
  it('deletes the file and its cache entry and returns the rest', async () => {
    await addMyFile(dir, 'My CV.pdf', minimalPdf('Alex Rivera'));
    await addMyFile(dir, 'notes.md', new TextEncoder().encode('Notes here'));
    expect(existsSync(cachePath('My CV.pdf'))).toBe(true);

    const rest = await removeMyFile(dir, 'My CV.pdf');

    expect(rest.map((file) => file.name)).toEqual(['notes.md']);
    expect(existsSync(join(dir, 'My CV.pdf'))).toBe(false);
    expect(existsSync(cachePath('My CV.pdf'))).toBe(false);
    expect(existsSync(cachePath('notes.md'))).toBe(true);
  });

  it('removes a file that was never cached', async () => {
    put('story.md', 'Built things');

    expect(await removeMyFile(dir, 'story.md')).toEqual([]);
  });

  it('removes a link without touching its target', async () => {
    writeFileSync(join(root, 'target.md'), 'precious');
    symlinkSync(join(root, 'target.md'), join(dir, 'link.md'));

    await removeMyFile(dir, 'link.md');

    expect(existsSync(join(dir, 'link.md'))).toBe(false);
    expect(readFileSync(join(root, 'target.md'), 'utf8')).toBe('precious');
  });

  it.each(['../x', 'unknown.md', '.hidden.md', 'archive', ''])('refuses %p', async (name) => {
    put('.hidden.md', 'hidden');
    put('keep.md', 'keep');
    writeFileSync(join(root, 'x'), 'outside');
    mkdirSync(join(dir, 'archive'));

    const error = await rejection(removeMyFile(dir, name));

    expect(error.message).toContain('No file named');
    expect(readdirSync(dir).sort()).toEqual(['.hidden.md', 'archive', 'keep.md']);
    expect(existsSync(join(root, 'x'))).toBe(true);
  });
});

describe('readDocuments', () => {
  it('returns only the readable files with their text, sorted by name', async () => {
    const path = put('b-story.md', 'Built things');
    utimesSync(path, new Date(2026, 0, 31, 9), new Date(2026, 0, 31, 9));
    put('a-cv.pdf', minimalPdf('Alex Rivera Staff Engineer'));
    put('scan.pdf', minimalPdf(null));
    put('photo.png', new Uint8Array([137, 80, 78, 71]));
    truncateSync(put('huge.txt', ''), MAX_FILE_BYTES + 1);

    const documents = await readDocuments(dir);

    expect(documents.map((document) => document.name)).toEqual(['a-cv.pdf', 'b-story.md']);
    expect(documents[0].text).toContain('Alex Rivera Staff Engineer');
    expect(documents[1]).toEqual({ name: 'b-story.md', modified: '2026-01-31', text: 'Built things', kind: 'other' });
  });

  it('labels each document by its slot: career story, resume or other', async () => {
    await addMyFile(dir, 'story.md', new TextEncoder().encode('Built things'), undefined, 'career-story');
    await addMyFile(dir, 'cv-1.md', new TextEncoder().encode('Resume one'), undefined, 'resume-1');
    await addMyFile(dir, 'cv-3.md', new TextEncoder().encode('Resume three'), undefined, 'resume-3');
    put('linkedin.md', 'Profile text');

    const documents = await readDocuments(dir);

    expect(documents.map((document) => [document.name, document.kind])).toEqual([
      ['cv-1.md', 'resume'],
      ['cv-3.md', 'resume'],
      ['linkedin.md', 'other'],
      ['story.md', 'career story'],
    ]);
  });

  it('fails with the setup-pointing error when no file has readable text', async () => {
    put('scan.pdf', minimalPdf(null));
    put('photo.png', new Uint8Array([137, 80, 78, 71]));

    const error = await rejection(readDocuments(dir));

    expect(error.message).toBe(NO_READABLE_FILES);
    expect(error).toBeInstanceOf(SetupError);
  });

  it.each([
    ['empty', () => undefined],
    ['missing', () => rmSync(dir, { recursive: true })],
  ])('fails with the setup-pointing error for a %s folder', async (_label, prepare) => {
    prepare();

    expect((await rejection(readDocuments(dir))).message).toBe(NO_READABLE_FILES);
  });

  it('accepts text that is exactly at the limit', async () => {
    put('limit.md', 'a'.repeat(MAX_PROFILE_CHARS));

    const documents = await readDocuments(dir);

    expect(documents[0].text).toHaveLength(MAX_PROFILE_CHARS);
  });

  it('fails naming the limit and the three largest files when the text is too long', async () => {
    put('big.md', 'word '.repeat(40_000));
    put('mid.md', 'word '.repeat(20_000));
    put('small.md', 'word '.repeat(4_000));
    put('tiny.md', 'word');

    const error = await rejection(readDocuments(dir));

    expect(error.message).toContain('300,000');
    expect(error.message).toContain('320,004 characters');
    expect(error.message).toContain('big.md (40,000 words), mid.md (20,000 words), small.md (4,000 words)');
    expect(error.message).not.toContain('tiny.md');
  });

  it('counts the text of PDF and Word files toward the limit', async () => {
    put('notes.md', 'a'.repeat(MAX_PROFILE_CHARS));
    put('cv.pdf', minimalPdf('Alex Rivera'));

    expect((await rejection(readDocuments(dir))).message).toContain('300,000');
  });

  it('accepts text that is exactly at the byte limit', async () => {
    put('kanji.md', '漢'.repeat(MAX_PROFILE_BYTES / 3));

    const documents = await readDocuments(dir);

    expect(Buffer.byteLength(documents[0].text, 'utf8')).toBe(MAX_PROFILE_BYTES);
  });

  it('fails naming the byte limit and the largest files when text under the character limit is too many bytes', async () => {
    put('kanji.md', '漢'.repeat(MAX_PROFILE_BYTES / 3 + 1));
    put('notes.md', 'word');

    const error = await rejection(readDocuments(dir));

    expect(error.message).toContain('600,007 bytes');
    expect(error.message).toContain('600,000');
    expect(error.message).toContain('remove or shorten some in My files');
    expect(error.message).toContain('Largest: kanji.md (1 word), notes.md (1 word)');
  });

  it('exposes the limits from the global constraints', () => {
    expect(MAX_FILE_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_PROFILE_CHARS).toBe(300_000);
    expect(MAX_PROFILE_BYTES).toBe(600_000);
  });
});

describe('inspectMyFiles', () => {
  it('lists the files with no problem when readDocuments would succeed', async () => {
    put('cv.md', 'Alex Rivera');
    put('scan.pdf', minimalPdf(null));

    const report = await inspectMyFiles(dir);

    expect(report.files).toEqual(await listMyFiles(dir));
    expect(report.problem).toBeNull();
  });

  it('reports the no-readable-files problem readDocuments would throw', async () => {
    put('scan.pdf', minimalPdf(null));

    const report = await inspectMyFiles(dir);

    expect(report.files.map((file) => file.name)).toEqual(['scan.pdf']);
    expect(report.problem).toBe(NO_READABLE_FILES);
  });

  it('reports the no-readable-files problem for an empty folder', async () => {
    expect(await inspectMyFiles(dir)).toEqual({ files: [], problem: NO_READABLE_FILES });
  });

  it('reports the over-the-limit problem readDocuments would throw, naming the largest files', async () => {
    put('big.md', 'word '.repeat(40_000));
    put('mid.md', 'word '.repeat(20_000));
    put('tiny.md', 'word');

    const report = await inspectMyFiles(dir);

    expect(report.files.map((file) => file.status)).toEqual(['read', 'read', 'read']);
    expect(report.problem).toBe((await rejection(readDocuments(dir))).message);
    expect(report.problem).toContain('big.md (40,000 words), mid.md (20,000 words)');
  });

  it('reports the byte-limit problem readDocuments would throw', async () => {
    put('kanji.md', '漢'.repeat(MAX_PROFILE_BYTES / 3 + 1));

    expect((await inspectMyFiles(dir)).problem).toBe((await rejection(readDocuments(dir))).message);
  });

  it('reads each file once, reusing the text cache', async () => {
    put('cv.md', 'Alex Rivera');
    await inspectMyFiles(dir);
    const cached = statSync(cachePath('cv.md')).mtimeMs;

    await inspectMyFiles(dir);

    expect(statSync(cachePath('cv.md')).mtimeMs).toBe(cached);
  });
});

describe('assertFileWithinLimit', () => {
  it('accepts a file of exactly 10 MB', () => {
    expect(() => assertFileWithinLimit('limit.pdf', MAX_FILE_BYTES)).not.toThrow();
  });

  it('refuses a larger file with a ProfileError naming it', () => {
    const check = (): void => assertFileWithinLimit('huge.pdf', MAX_FILE_BYTES + 1);
    expect(check).toThrow(ProfileError);
    expect(check).toThrow('huge.pdf is over 10 MB — add a smaller file');
  });
});
