import { afterAll, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { CLAUDE_NOT_INSTALLED, ClaudeRunError } from './claude-runner';
import { CompileError } from './compile';
import { type HostContext, loadConfig } from './config';
import type { GenerateResult, WriteRequest } from './generate';
import { MAX_FILE_BYTES, type MyFile } from './my-files/store';
import {
  encodeNativeMessage,
  hostHandlers,
  MAX_INPUT_BYTES,
  type NativeHandlers,
  parseScoreRequest,
  parseWriteRequest,
  readNativeMessage,
  runNativeHost,
  scoreOnce,
  writeDeps,
} from './native';
import type { HelperStatus, SetupDeps } from './setup-commands';
import { ProfileError } from './setup-error';
import { onePageTectonic, REAL_TEMPLATE, VALID, VALID_FIT, waitUntil } from './test-fixtures';
import { MAX_WRITER_NOTES } from './writer/request';

const ONE_MB = 1024 * 1024;

const RESULT: GenerateResult = {
  success: true,
  folderName: 'Acme AI - ML Engineer',
  folderPath: '/out/Acme AI - ML Engineer',
  texPath: '/out/Acme AI - ML Engineer/Acme AI - ML Engineer.tex',
  pdfPath: '/out/Acme AI - ML Engineer/Acme AI - ML Engineer.pdf',
  uploadPdfPath: '/out/Acme AI - ML Engineer/Alex_Rivera_Resume.pdf',
  pages: 1,
  fits: true,
  trimmedBullets: 0,
  latexSource: '\\documentclass{article}',
  pdfBase64: 'JVBERg==',
  pdfSizeBytes: 4,
  resumeText: 'Built a RAG pipeline answering 2M queries per month.',
  keywords: ['RAG'],
};

const WRITE_INPUT = {
  command: 'write',
  job: { text: 'We need an ML engineer.', url: 'https://jobs.example.com/1', title: 'ML Engineer' },
  model: 'haiku',
  effort: 'low',
  maxPages: 1,
};

// Splits the host's stdout back into the JSON messages it framed.
function decodeFrames(bytes: Buffer): unknown[] {
  const messages: unknown[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const length = bytes.readUInt32LE(offset);
    messages.push(JSON.parse(bytes.subarray(offset + 4, offset + 4 + length).toString('utf8')));
    offset += 4 + length;
  }
  return messages;
}

function captureStdout(): { stdout: PassThrough; frames: () => unknown[] } {
  const stdout = new PassThrough();
  const chunks: Buffer[] = [];
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { stdout, frames: () => decodeFrames(Buffer.concat(chunks)) };
}

function unexpected(name: string): () => never {
  return () => {
    throw new Error(`${name} should not be called`);
  };
}

function handlers(overrides: Partial<NativeHandlers>): NativeHandlers {
  return {
    write: unexpected('write'),
    recompile: unexpected('recompile'),
    generate: unexpected('generate'),
    status: unexpected('status'),
    addFile: unexpected('addFile'),
    removeFile: unexpected('removeFile'),
    chooseFolder: unexpected('chooseFolder'),
    setOutput: unexpected('setOutput'),
    openFolder: unexpected('openFolder'),
    ...overrides,
  };
}

// Sends one framed message and closes stdin, as a one-shot sendNativeMessage call would.
async function runOnce(input: unknown, host: NativeHandlers): Promise<unknown[]> {
  const { stdout, frames } = captureStdout();
  await runNativeHost({ stdin: Readable.from([encodeNativeMessage(input)]), stdout }, host);
  return frames();
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error)) throw new Error(`Expected a rejection with an Error, got ${String(error)}`);
  return error;
}

// A 4-byte length header, as Chrome sends it.
function header(length: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(length, 0);
  return bytes;
}

// Chrome may send the host up to 16 MiB; encodeNativeMessage stops at the 1 MB Chrome allows the other way.
function frameFromChrome(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  return Buffer.concat([header(body.length), body]);
}

async function runFrame(frame: Buffer, host: NativeHandlers): Promise<unknown[]> {
  const { stdout, frames } = captureStdout();
  await runNativeHost({ stdin: Readable.from([frame]), stdout }, host);
  return frames();
}

describe('encodeNativeMessage', () => {
  it('prefixes the UTF-8 JSON with its byte length, little-endian', () => {
    const bytes = Buffer.from(encodeNativeMessage({ a: 'é' }));
    const body = Buffer.from('{"a":"é"}', 'utf8');
    expect(bytes.readUInt32LE(0)).toBe(body.length);
    expect(bytes.subarray(4).equals(body)).toBe(true);
  });

  it("refuses a message over Chrome's 1 MB limit", () => {
    expect(() => encodeNativeMessage({ text: 'x'.repeat(ONE_MB) })).toThrow('too large');
  });
});

describe('readNativeMessage', () => {
  it('reads one framed message', async () => {
    expect(await readNativeMessage(Readable.from([encodeNativeMessage({ a: 1 })]))).toEqual({ a: 1 });
  });

  it('reads a message split across three chunks', async () => {
    const bytes = Buffer.from(encodeNativeMessage({ text: 'split me' }));
    const chunks = [bytes.subarray(0, 2), bytes.subarray(2, 9), bytes.subarray(9)];
    expect(await readNativeMessage(Readable.from(chunks))).toEqual({ text: 'split me' });
  });

  it('reads a message that arrives one byte at a time, header included', async () => {
    const bytes = Buffer.from(encodeNativeMessage({ text: 'byte by byte' }));
    const chunks = [...bytes].map((byte) => Buffer.from([byte]));
    expect(await readNativeMessage(Readable.from(chunks))).toEqual({ text: 'byte by byte' });
  });

  it('reads a large message from many chunks, given as text or bytes', async () => {
    const bytes = frameFromChrome({ text: 'x'.repeat(3 * ONE_MB) });
    const chunks: Array<Buffer | string> = [bytes.subarray(0, 4)];
    for (let start = 4; start < bytes.length; start += 64 * 1024) {
      const piece = bytes.subarray(start, start + 64 * 1024);
      chunks.push(chunks.length % 2 === 0 ? piece.toString('utf8') : piece);
    }
    const message = await readNativeMessage(Readable.from(chunks));
    expect(message).toEqual({ text: 'x'.repeat(3 * ONE_MB) });
  });

  it('ignores bytes after the message in the same chunk', async () => {
    const bytes = Buffer.concat([encodeNativeMessage({ a: 1 }), Buffer.from('trailing')]);
    expect(await readNativeMessage(Readable.from([bytes]))).toEqual({ a: 1 });
  });

  it('reads a zero-length message as an empty object', async () => {
    expect(await readNativeMessage(Readable.from([Buffer.alloc(4)]))).toEqual({});
  });

  it('rejects when the input ends before the message is complete', async () => {
    const bytes = Buffer.from(encodeNativeMessage({ a: 1 }));
    const error = await rejection(readNativeMessage(Readable.from([bytes.subarray(0, 6)])));
    expect(error.message).toContain('ended');
  });

  it('rejects when there is no input at all', async () => {
    const error = await rejection(readNativeMessage(Readable.from([])));
    expect(error.message).toContain('No input');
  });

  it('rejects a body that is not JSON', async () => {
    const body = Buffer.from('{nope', 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    const error = await rejection(readNativeMessage(Readable.from([Buffer.concat([header, body])])));
    expect(error.message).toContain('not valid JSON');
  });

  it('rejects when no message arrives in time', async () => {
    const error = await rejection(readNativeMessage(new PassThrough(), 20));
    expect(error.message).toContain('No message');
  });
});

describe('readNativeMessage: the 16 MiB cap', () => {
  it('rejects a header that announces more than 16 MiB as soon as it arrives, without waiting for the body', async () => {
    const stdin = new PassThrough();
    stdin.write(header(MAX_INPUT_BYTES + 1));

    const error = await rejection(readNativeMessage(stdin));

    expect(error.message).toContain('too large');
    expect(error.message).toContain('16 MiB');
    expect(stdin.listenerCount('data')).toBe(0);
  });

  it('rejects an oversized header even when its first bytes arrive split', async () => {
    const stdin = new PassThrough();
    const announced = header(MAX_INPUT_BYTES + 1);
    stdin.write(announced.subarray(0, 2));
    const result = rejection(readNativeMessage(stdin));
    stdin.write(announced.subarray(2));

    expect((await result).message).toContain('too large');
  });

  it('still waits for the body of a message of exactly 16 MiB', async () => {
    const stdin = new PassThrough();
    stdin.write(header(MAX_INPUT_BYTES));

    const error = await rejection(readNativeMessage(stdin, 20));

    expect(error.message).toContain('No message');
  });
});

describe('runNativeHost: write', () => {
  it('passes the request on and frames every message the writer sends, in order', async () => {
    const received: WriteRequest[] = [];
    const frames = await runOnce(
      WRITE_INPUT,
      handlers({
        write: async (req, _signal, send) => {
          received.push(req);
          send({ type: 'progress', stage: 'checking-login' });
          send({ type: 'result', ...RESULT });
        },
      }),
    );
    expect(received).toStrictEqual([
      { ...WRITE_INPUT, scoreModel: 'haiku', scoreEffort: 'low', minScore: 40 } as WriteRequest,
    ]);
    expect(frames).toEqual([
      { type: 'progress', stage: 'checking-login' },
      { type: 'result', ...RESULT },
    ]);
  });

  it('answers an invalid write request with one error and never starts the writer', async () => {
    const frames = await runOnce({ ...WRITE_INPUT, effort: 'extreme' }, handlers({}));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: 'error' });
    expect((frames[0] as { error: string }).error).toContain('effort');
  });

  it('rejects a model name that could pass for a flag', async () => {
    const frames = await runOnce({ ...WRITE_INPUT, model: '--dangerously-skip-permissions' }, handlers({}));
    expect(frames).toEqual([{ type: 'error', error: expect.stringContaining('model') }]);
  });

  it('turns a writer that throws into one error message', async () => {
    const frames = await runOnce(
      WRITE_INPUT,
      handlers({
        write: async () => {
          throw new ClaudeRunError('failed', 'Claude Code failed: usage limit');
        },
      }),
    );
    expect(frames).toStrictEqual([{ type: 'error', error: 'Claude Code failed: usage limit' }]);
  });

  it('aborts the write when Chrome closes stdin', async () => {
    const stdin = new PassThrough();
    const { stdout, frames } = captureStdout();
    let started: () => void = () => undefined;
    const writerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const host = handlers({
      write: async (_req, signal, send) => {
        send({ type: 'progress', stage: 'writing' });
        started();
        await new Promise((resolve) => signal.addEventListener('abort', resolve));
        throw new ClaudeRunError('cancelled', 'Resume writing was cancelled.');
      },
    });

    const run = runNativeHost({ stdin, stdout }, host);
    stdin.write(encodeNativeMessage(WRITE_INPUT));
    await writerStarted;
    stdin.end();
    await run;

    expect(frames()).toStrictEqual([
      { type: 'progress', stage: 'writing' },
      { type: 'error', error: 'Resume writing was cancelled.' },
    ]);
  });
});

describe('parseWriteRequest: scoring fields', () => {
  it('defaults to Haiku at low effort with a threshold of 40', () => {
    expect(parseWriteRequest(WRITE_INPUT)).toMatchObject({ scoreModel: 'haiku', scoreEffort: 'low', minScore: 40 });
  });

  it('passes valid scoring fields through', () => {
    const req = parseWriteRequest({ ...WRITE_INPUT, scoreModel: 'claude-sonnet-4-5', scoreEffort: 'medium', minScore: 0 });
    expect(req).toMatchObject({ scoreModel: 'claude-sonnet-4-5', scoreEffort: 'medium', minScore: 0 });
    expect(parseWriteRequest({ ...WRITE_INPUT, minScore: 100 }).minScore).toBe(100);
  });

  it('rejects a score model that could pass for a flag', () => {
    expect(() => parseWriteRequest({ ...WRITE_INPUT, scoreModel: '--dangerously-skip-permissions' })).toThrow(
      'scoreModel must be a model name',
    );
    expect(() => parseWriteRequest({ ...WRITE_INPUT, scoreModel: null })).toThrow('scoreModel must be a model name');
  });

  it('rejects an unknown score effort', () => {
    expect(() => parseWriteRequest({ ...WRITE_INPUT, scoreEffort: 'extreme' })).toThrow(
      'scoreEffort must be one of low, medium, high, xhigh, max',
    );
  });

  it('rejects a threshold that is not a whole number from 0 to 100', () => {
    for (const minScore of [-1, 101, 40.5, '40', null, Number.NaN]) {
      expect(() => parseWriteRequest({ ...WRITE_INPUT, minScore })).toThrow(
        'minScore must be a whole number from 0 to 100',
      );
    }
  });

  it('answers an invalid threshold over the port with one error and never starts the writer', async () => {
    const frames = await runOnce({ ...WRITE_INPUT, minScore: 140 }, handlers({}));
    expect(frames).toEqual([{ type: 'error', error: 'minScore must be a whole number from 0 to 100' }]);
  });
});

describe('parseWriteRequest: writerNotes', () => {
  it('leaves writerNotes out when the request has none', () => {
    expect('writerNotes' in parseWriteRequest(WRITE_INPUT)).toBe(false);
  });

  it('passes a string through unchanged, including an empty one', () => {
    expect(parseWriteRequest({ ...WRITE_INPUT, writerNotes: 'Use British spelling.' }).writerNotes).toBe(
      'Use British spelling.',
    );
    expect(parseWriteRequest({ ...WRITE_INPUT, writerNotes: '' }).writerNotes).toBe('');
  });

  it('accepts notes of exactly 2,000 characters', () => {
    const notes = 'a'.repeat(MAX_WRITER_NOTES);
    expect(parseWriteRequest({ ...WRITE_INPUT, writerNotes: notes }).writerNotes).toBe(notes);
  });

  it('limits the notes to 2,000 characters', () => {
    expect(MAX_WRITER_NOTES).toBe(2000);
  });

  it('rejects notes over 2,000 characters', () => {
    expect(() => parseWriteRequest({ ...WRITE_INPUT, writerNotes: 'a'.repeat(MAX_WRITER_NOTES + 1) })).toThrow(
      '2,000',
    );
  });

  it('rejects notes that are not text', () => {
    for (const writerNotes of [42, null, ['a'], {}, true]) {
      expect(() => parseWriteRequest({ ...WRITE_INPUT, writerNotes })).toThrow('2,000');
    }
  });

  it('answers invalid notes over the port with one error and never starts the writer', async () => {
    const frames = await runOnce({ ...WRITE_INPUT, writerNotes: 'a'.repeat(MAX_WRITER_NOTES + 1) }, handlers({}));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: 'error' });
    expect((frames[0] as { error: string }).error).toContain('writerNotes');
  });
});

describe('runNativeHost: recompile', () => {
  const input = {
    command: 'recompile',
    texSource: '\\documentclass{article}',
    texPath: '/out/A/A.tex',
    folderPath: '/out/A',
    folderName: 'A',
  };

  it('sends the compiled PDF as one response', async () => {
    const response = { success: true as const, pdfBase64: 'JVBERg==', pdfSizeBytes: 4, pages: 1 };
    let received: unknown = null;
    const frames = await runOnce(
      input,
      handlers({
        recompile: async (req) => {
          received = req;
          return response;
        },
      }),
    );
    expect(received).toEqual({ texSource: input.texSource, texPath: input.texPath, folderPath: input.folderPath });
    expect(frames).toEqual([response]);
  });

  it("reports a LaTeX error the way the editor reads it (error + compilerOutput)", async () => {
    const frames = await runOnce(
      input,
      handlers({
        recompile: async () => {
          throw new CompileError('tectonic failed to compile the resume', '! Undefined control sequence.');
        },
      }),
    );
    expect(frames).toStrictEqual([
      {
        success: false,
        error: 'tectonic failed to compile the resume',
        compilerOutput: '! Undefined control sequence.',
      },
    ]);
  });

  it('rejects a request without a texPath', async () => {
    const frames = await runOnce({ ...input, texPath: undefined }, handlers({}));
    expect(frames).toEqual([{ success: false, error: expect.stringContaining('texPath') }]);
  });
});

describe('runNativeHost: generate', () => {
  it('treats a message without a command as generate, with chatTitle as the fallback title and two pages', async () => {
    let received: unknown = null;
    const frames = await runOnce(
      { responseText: '```json\n{}\n```', chatTitle: 'Acme - Engineer' },
      handlers({
        generate: async (req) => {
          received = req;
          return RESULT;
        },
      }),
    );
    expect(received).toEqual({ responseText: '```json\n{}\n```', fallbackTitle: 'Acme - Engineer', maxPages: 2 });
    expect(frames).toEqual([RESULT]);
  });

  it('passes maxPages and a null fallback title', async () => {
    let received: unknown = null;
    await runOnce(
      { command: 'generate', responseText: 'reply', maxPages: 3 },
      handlers({
        generate: async (req) => {
          received = req;
          return RESULT;
        },
      }),
    );
    expect(received).toEqual({ responseText: 'reply', fallbackTitle: null, maxPages: 3 });
  });

  it('rejects a request without responseText', async () => {
    const frames = await runOnce({ command: 'generate' }, handlers({}));
    expect(frames).toEqual([{ type: 'error', success: false, error: expect.stringContaining('responseText') }]);
  });
});

describe('runNativeHost: anything else', () => {
  it('answers an unknown command with one error', async () => {
    const frames = await runOnce({ command: 'format-disk' }, handlers({}));
    expect(frames).toEqual([{ type: 'error', success: false, error: 'Unknown command: format-disk' }]);
  });

  it('answers unreadable input with one error', async () => {
    const { stdout, frames } = captureStdout();
    await runNativeHost({ stdin: Readable.from([Buffer.from([1, 0])]), stdout }, handlers({}));
    expect(frames()).toEqual([{ type: 'error', success: false, error: expect.stringContaining('ended') }]);
  });

  it('answers a message that is not an object with one error', async () => {
    const frames = await runOnce(['write'], handlers({}));
    expect(frames).toEqual([{ type: 'error', success: false, error: expect.stringContaining('object') }]);
  });
});

describe('runNativeHost: a message that is too large', () => {
  it('answers a header over 16 MiB with one error, and starts nothing', async () => {
    const frames = await runFrame(header(MAX_INPUT_BYTES + 1), handlers({}));
    expect(frames).toEqual([{ type: 'error', success: false, error: expect.stringContaining('too large') }]);
  });
});

// ---------------------------------------------------------------------------
// Setup commands: one-shot, each answered with { success: true, ... }
// ---------------------------------------------------------------------------

const MY_FILE: MyFile = {
  name: 'resume.pdf',
  kind: 'pdf',
  words: 410,
  status: 'read',
  modified: '2026-10-01',
  slot: null,
};

const STATUS: HelperStatus = {
  version: '1.0.0',
  claude: { path: '/Users/alex/.local/bin/claude', loggedIn: true, plan: 'max', problem: null },
  tectonic: { path: '/Users/alex/.theseer/bin/tectonic' },
  template: { path: '/Users/alex/.theseer/templates/default.tex' },
  profileDir: '/Users/alex/TheSeer/My files',
  outputDir: '/Users/alex/TheSeer/Resumes',
  files: [MY_FILE],
  profileProblem: null,
};

const ADD_FILE_INPUT = { command: 'add-file', name: 'resume.pdf', dataBase64: Buffer.from('%PDF-1.4').toString('base64') };

describe('runNativeHost: status', () => {
  it('frames the helper status back', async () => {
    const frames = await runOnce({ command: 'status' }, handlers({ status: async () => STATUS }));
    expect(frames).toEqual([{ success: true, status: STATUS }]);
  });

  it('turns a failing status into one error', async () => {
    const frames = await runOnce(
      { command: 'status' },
      handlers({
        status: async () => {
          throw new ClaudeRunError('timeout', 'Claude Code login check timed out after 30 s');
        },
      }),
    );
    expect(frames).toEqual([{ type: 'error', success: false, error: 'Claude Code login check timed out after 30 s' }]);
  });
});

describe('runNativeHost: add-file', () => {
  it('hands the name and the decoded bytes to the handler and frames the file back', async () => {
    const received: Array<{ name: string; text: string; lastModifiedMs: number | undefined }> = [];
    const frames = await runOnce(
      ADD_FILE_INPUT,
      handlers({
        addFile: async (req) => {
          received.push({ name: req.name, text: Buffer.from(req.bytes).toString(), lastModifiedMs: req.lastModifiedMs });
          return MY_FILE;
        },
      }),
    );
    expect(received).toEqual([{ name: 'resume.pdf', text: '%PDF-1.4', lastModifiedMs: undefined }]);
    expect(frames).toEqual([{ success: true, file: MY_FILE }]);
  });

  it("passes the file's own date on as lastModifiedMs", async () => {
    const lastModified = new Date(2024, 2, 5, 12, 0).getTime();
    const received: Array<number | undefined> = [];
    await runOnce(
      { ...ADD_FILE_INPUT, lastModified },
      handlers({
        addFile: async (req) => {
          received.push(req.lastModifiedMs);
          return MY_FILE;
        },
      }),
    );
    expect(received).toEqual([lastModified]);
  });

  it.each(['career-story', 'resume-1', 'resume-2', 'resume-3'])('passes the slot %s on to the handler', async (slot) => {
    const received: Array<string | undefined> = [];
    await runOnce(
      { ...ADD_FILE_INPUT, slot },
      handlers({
        addFile: async (req) => {
          received.push(req.slot);
          return MY_FILE;
        },
      }),
    );
    expect(received).toEqual([slot]);
  });

  it('hands over no slot when the message carries none', async () => {
    const received: Array<{ hasSlot: boolean }> = [];
    await runOnce(
      ADD_FILE_INPUT,
      handlers({
        addFile: async (req) => {
          received.push({ hasSlot: 'slot' in req });
          return MY_FILE;
        },
      }),
    );
    expect(received).toEqual([{ hasSlot: false }]);
  });

  it('accepts a file of exactly 10 MB', async () => {
    const dataBase64 = Buffer.alloc(MAX_FILE_BYTES).toString('base64');
    const sizes: number[] = [];
    const frames = await runFrame(
      frameFromChrome({ ...ADD_FILE_INPUT, dataBase64 }),
      handlers({
        addFile: async (req) => {
          sizes.push(req.bytes.byteLength);
          return MY_FILE;
        },
      }),
    );
    expect(sizes).toEqual([MAX_FILE_BYTES]);
    expect(frames).toEqual([{ success: true, file: MY_FILE }]);
  });

  const BAD_REQUESTS: Array<[string, Record<string, unknown>, string]> = [
    ['no name', { ...ADD_FILE_INPUT, name: undefined }, 'name must be non-empty text'],
    ['an empty name', { ...ADD_FILE_INPUT, name: '  ' }, 'name must be non-empty text'],
    ['a name that is not text', { ...ADD_FILE_INPUT, name: 42 }, 'name must be non-empty text'],
    ['no dataBase64', { ...ADD_FILE_INPUT, dataBase64: undefined }, 'dataBase64 must be text'],
    ['dataBase64 that is not text', { ...ADD_FILE_INPUT, dataBase64: [1, 2, 3] }, 'dataBase64 must be text'],
    ['a lastModified that is text', { ...ADD_FILE_INPUT, lastModified: '1709640000000' }, 'lastModified must be a number'],
    ['a lastModified that is null', { ...ADD_FILE_INPUT, lastModified: null }, 'lastModified must be a number'],
    ['a lastModified that is an object', { ...ADD_FILE_INPUT, lastModified: {} }, 'lastModified must be a number'],
    ['an unknown slot', { ...ADD_FILE_INPUT, slot: 'resume-4' }, 'slot must be one of career-story, resume-1, resume-2, resume-3'],
    ['a slot that is not text', { ...ADD_FILE_INPUT, slot: 2 }, 'slot must be one of'],
    ['a slot that is null', { ...ADD_FILE_INPUT, slot: null }, 'slot must be one of'],
    ['an empty slot', { ...ADD_FILE_INPUT, slot: '' }, 'slot must be one of'],
  ];

  for (const [label, input, reason] of BAD_REQUESTS) {
    it(`answers ${label} with one error, and adds nothing`, async () => {
      const frames = await runOnce(input, handlers({}));
      expect(frames).toEqual([{ type: 'error', success: false, error: expect.stringContaining(reason) }]);
    });
  }

  it('answers a file over 10 MB with one error, and adds nothing', async () => {
    const dataBase64 = Buffer.alloc(MAX_FILE_BYTES + 1).toString('base64');
    const frames = await runFrame(frameFromChrome({ ...ADD_FILE_INPUT, dataBase64 }), handlers({}));
    expect(frames).toEqual([
      { type: 'error', success: false, error: expect.stringContaining('over 10 MB'), needsSetup: true },
    ]);
  });

  it('flags a setup problem the handler reports', async () => {
    const frames = await runOnce(
      ADD_FILE_INPUT,
      handlers({
        addFile: async () => {
          throw new ProfileError('Profile folder not set');
        },
      }),
    );
    expect(frames).toEqual([{ type: 'error', success: false, error: 'Profile folder not set', needsSetup: true }]);
  });
});

describe('runNativeHost: remove-file', () => {
  it('hands the name to the handler and frames the files that are left', async () => {
    const received: string[] = [];
    const frames = await runOnce(
      { command: 'remove-file', name: 'old.pdf' },
      handlers({
        removeFile: async (name) => {
          received.push(name);
          return [MY_FILE];
        },
      }),
    );
    expect(received).toEqual(['old.pdf']);
    expect(frames).toEqual([{ success: true, files: [MY_FILE] }]);
  });

  it('answers a request without a name with one error', async () => {
    const frames = await runOnce({ command: 'remove-file' }, handlers({}));
    expect(frames).toEqual([{ type: 'error', success: false, error: expect.stringContaining('name') }]);
  });
});

describe('runNativeHost: choose-folder', () => {
  it('frames the chosen folder back', async () => {
    const frames = await runOnce({ command: 'choose-folder' }, handlers({ chooseFolder: async () => '/Users/alex/Resumes' }));
    expect(frames).toEqual([{ success: true, path: '/Users/alex/Resumes' }]);
  });

  it('frames a cancelled dialog as a null path, which is still a success', async () => {
    const frames = await runOnce({ command: 'choose-folder' }, handlers({ chooseFolder: async () => null }));
    expect(frames).toEqual([{ success: true, path: null }]);
  });
});

describe('runNativeHost: set-output', () => {
  it('hands the folder to the handler and frames the saved folder back', async () => {
    const received: string[] = [];
    const frames = await runOnce(
      { command: 'set-output', outputDir: '/Users/alex/Resumes/' },
      handlers({
        setOutput: async (outputDir) => {
          received.push(outputDir);
          return '/Users/alex/Resumes';
        },
      }),
    );
    expect(received).toEqual(['/Users/alex/Resumes/']);
    expect(frames).toEqual([{ success: true, outputDir: '/Users/alex/Resumes' }]);
  });

  it('answers a request without a folder with one error', async () => {
    const frames = await runOnce({ command: 'set-output' }, handlers({}));
    expect(frames).toEqual([{ type: 'error', success: false, error: expect.stringContaining('outputDir') }]);
  });
});

describe('runNativeHost: open-folder', () => {
  it('opens either folder and frames a bare success', async () => {
    const opened: string[] = [];
    const host = handlers({
      openFolder: async (which) => {
        opened.push(which);
      },
    });
    expect(await runOnce({ command: 'open-folder', which: 'files' }, host)).toEqual([{ success: true }]);
    expect(await runOnce({ command: 'open-folder', which: 'resumes' }, host)).toEqual([{ success: true }]);
    expect(opened).toEqual(['files', 'resumes']);
  });

  it('answers any other folder with one error, and opens nothing', async () => {
    for (const which of [undefined, 'output', '/etc', 7]) {
      const frames = await runOnce({ command: 'open-folder', which }, handlers({}));
      expect(frames).toEqual([{ type: 'error', success: false, error: expect.stringContaining('which must be') }]);
    }
  });
});

// ---------------------------------------------------------------------------
// The real wiring: hostHandlers and writeDeps around a stand-in for `claude`
// ---------------------------------------------------------------------------

const LOGGED_IN = '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}';
const CANCELLED = 'Resume writing was cancelled.';

const wiringRoot = mkdtempSync(join(tmpdir(), 'seer-native-'));
afterAll(() => rmSync(wiringRoot, { recursive: true, force: true }));

type Call = 'auth' | 'scorer' | 'writer';
type Wiring = { ctx: HostContext; claudeLog: string; scorerArgs: string; hungCall: Call | null };

// A stand-in for `claude` that logs each call as auth, scorer (its schema names fit_score) or writer.
// `hang` names the call that never ends; the scorer otherwise replies with VALID_FIT at `fitScore`,
// and the writer replies with nothing usable.
function wiring(hang: Call | null, fitScore = VALID_FIT.fit_score): Wiring {
  const root = mkdtempSync(join(wiringRoot, 'case-'));
  const claudeLog = join(root, 'claude.log');
  const scorerArgs = join(root, 'scorer-args');
  const scoreReply = join(root, 'score-reply.json');
  const claudePath = join(root, 'claude');
  const structured = { ...VALID_FIT, recommended_base: 'mle', fit_score: fitScore };
  writeFileSync(scoreReply, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: structured }));
  writeFileSync(
    claudePath,
    [
      '#!/bin/sh',
      'case "$*" in',
      '  auth*) call=auth ;;',
      `  *fit_score*) call=scorer; printf '%s\\n' "$@" > "${scorerArgs}" ;;`,
      '  *) call=writer ;;',
      'esac',
      `echo "$call" >> "${claudeLog}"`,
      `if [ "$call" = "${hang ?? 'none'}" ]; then exec sleep 30; fi`,
      'if [ "$call" = auth ]; then echo \'' + LOGGED_IN + '\'; fi',
      `if [ "$call" = scorer ]; then cat "${scoreReply}"; fi`,
    ].join('\n'),
    'utf-8',
  );
  chmodSync(claudePath, 0o755);

  const profileDir = join(root, 'profile');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, 'career-story.md'), 'I build retrieval systems.');
  writeFileSync(join(profileDir, 'resume.md'), 'MLE resume');
  const templatePath = join(root, 'template.tex');
  writeFileSync(templatePath, '% template');

  const ctx: HostContext = {
    config: { claudePath, profileDir },
    outputBase: join(root, 'out'),
    templatePath,
    baseDir: root,
    home: root,
    env: { THESEER_TECTONIC: join(root, 'tectonic') },
  };
  return { ctx, claudeLog, scorerArgs, hungCall: hang };
}

function claudeCalls(claudeLog: string): string[] {
  return existsSync(claudeLog) ? readFileSync(claudeLog, 'utf-8').trim().split('\n') : [];
}

// Closes stdin once claude is mid-call, as Chrome does when the port goes away.
async function framesAfterChromeLeaves(hang: Call): Promise<unknown[]> {
  const { ctx, claudeLog, hungCall } = wiring(hang);
  const stdin = new PassThrough();
  const { stdout, frames } = captureStdout();
  const run = runNativeHost({ stdin, stdout }, hostHandlers(() => ctx));
  stdin.write(encodeNativeMessage(WRITE_INPUT));
  await waitUntil(() => claudeCalls(claudeLog).includes(hang), `the ${hungCall} call to start`);
  stdin.end();
  await run;
  return frames();
}

describe('hostHandlers wiring: the abort signal', () => {
  it('stops a login check that is still running when Chrome closes the port', async () => {
    expect(await framesAfterChromeLeaves('auth')).toStrictEqual([
      { type: 'progress', stage: 'checking-login' },
      { type: 'error', error: CANCELLED },
    ]);
  });

  it('stops Claude while it scores when Chrome closes the port', async () => {
    expect(await framesAfterChromeLeaves('scorer')).toStrictEqual([
      { type: 'progress', stage: 'checking-login' },
      { type: 'progress', stage: 'scoring' },
      { type: 'error', error: CANCELLED },
    ]);
  });

  it('stops Claude while it writes when Chrome closes the port', async () => {
    const frames = await framesAfterChromeLeaves('writer');
    expect(frames.slice(0, 2)).toStrictEqual([
      { type: 'progress', stage: 'checking-login' },
      { type: 'progress', stage: 'scoring' },
    ]);
    expect(frames[2]).toMatchObject({ type: 'score', analysis: { fit_score: VALID_FIT.fit_score } });
    expect(frames.slice(3)).toStrictEqual([
      { type: 'progress', stage: 'writing' },
      { type: 'error', error: CANCELLED },
    ]);
  });

  // A real template and a working tectonic: without the cancel checks this build would succeed
  // and create its folder.
  function buildContext(tectonicPath: string): HostContext {
    const { ctx } = wiring('writer');
    return { ...ctx, templatePath: REAL_TEMPLATE, env: { THESEER_TECTONIC: tectonicPath } };
  }

  it('does not build, and creates no folder, once the job is cancelled', async () => {
    const tectonic = onePageTectonic(mkdtempSync(join(wiringRoot, 'bin-')));
    const ctx = buildContext(tectonic.path);
    const controller = new AbortController();
    controller.abort();
    const deps = writeDeps(ctx, parseWriteRequest(WRITE_INPUT), controller.signal);

    const error = await rejection(deps.build(VALID, () => undefined));

    expect(error).toBeInstanceOf(ClaudeRunError);
    expect(error).toMatchObject({ kind: 'cancelled', message: CANCELLED });
    expect(tectonic.started()).toBe(false);
    expect(existsSync(ctx.outputBase) ? readdirSync(ctx.outputBase) : []).toEqual([]);
  });

  it('creates no folder when Chrome closes the port during the compile', async () => {
    const tectonic = onePageTectonic(mkdtempSync(join(wiringRoot, 'bin-')), true);
    const ctx = buildContext(tectonic.path);
    const controller = new AbortController();
    const deps = writeDeps(ctx, parseWriteRequest(WRITE_INPUT), controller.signal);

    const build = rejection(deps.build(VALID, () => undefined));
    await waitUntil(tectonic.started, 'tectonic to start');
    controller.abort();
    tectonic.release();
    const error = await build;

    expect(error).toMatchObject({ kind: 'cancelled', message: CANCELLED });
    expect(existsSync(ctx.outputBase) ? readdirSync(ctx.outputBase) : []).toEqual([]);
  });
});

// Keeps the port open until the host is done, as a long-lived connectNative port does.
async function runWithPortOpen(input: unknown, host: NativeHandlers): Promise<unknown[]> {
  const stdin = new PassThrough();
  const { stdout, frames } = captureStdout();
  stdin.write(encodeNativeMessage(input));
  await runNativeHost({ stdin, stdout }, host);
  stdin.end();
  return frames();
}

describe('hostHandlers wiring: scoring', () => {
  it('skips a low score without calling the writer or creating a folder', async () => {
    const { ctx, claudeLog } = wiring(null, 12);

    const frames = await runWithPortOpen(WRITE_INPUT, hostHandlers(() => ctx));

    expect(frames.at(-1)).toStrictEqual({ type: 'skipped', score: 12, threshold: 40 });
    expect(frames).toHaveLength(4);
    expect(claudeCalls(claudeLog)).toEqual(['auth', 'scorer']);
    expect(existsSync(ctx.outputBase) ? readdirSync(ctx.outputBase) : []).toEqual([]);
  });

  it('scores with the requested model and effort, with Sonnet as the only fallback', async () => {
    const { ctx, scorerArgs } = wiring(null, 12);

    await runWithPortOpen({ ...WRITE_INPUT, scoreModel: 'haiku', scoreEffort: 'medium' }, hostHandlers(() => ctx));

    const args = readFileSync(scorerArgs, 'utf-8').split('\n');
    const after = (flag: string): string | undefined => args[args.indexOf(flag) + 1];
    expect(after('--model')).toBe('haiku');
    expect(after('--effort')).toBe('medium');
    expect(after('--fallback-model')).toBe('sonnet');
  });

  it('sends the score analysis without the job facts, and the job facts apart', async () => {
    const { ctx } = wiring(null, 12);

    const frames = await runWithPortOpen(WRITE_INPUT, hostHandlers(() => ctx));

    const { job, ...analysis } = { ...VALID_FIT, recommended_base: 'mle', fit_score: 12 };
    expect(frames[2]).toStrictEqual({ type: 'score', analysis, job });
  });
});

describe('hostHandlers wiring: settings are checked before Claude runs', () => {
  it('fails on a missing template without calling claude', async () => {
    const { ctx, claudeLog } = wiring('writer');

    const frames = await runOnce(WRITE_INPUT, hostHandlers(() => ({ ...ctx, templatePath: join(ctx.home, 'gone.tex') })));

    expect(frames).toEqual([{ type: 'error', error: expect.stringContaining('Template not found'), needsSetup: true }]);
    expect(claudeCalls(claudeLog)).toEqual([]);
  });

  it('fails on a missing output folder setting without calling claude', async () => {
    const { ctx, claudeLog } = wiring('writer');

    const frames = await runOnce(WRITE_INPUT, hostHandlers(() => ({ ...ctx, outputBase: '' })));

    expect(frames).toEqual([
      { type: 'error', error: expect.stringContaining('Save folder not set'), needsSetup: true },
    ]);
    expect(claudeCalls(claudeLog)).toEqual([]);
  });

  // findClaude also looks in the machine's own /opt/homebrew/bin and /usr/local/bin.
  const claudeOnThisMachine = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'].some(existsSync);

  it.skipIf(claudeOnThisMachine)('flags Claude Code that is not installed, before anything runs', async () => {
    const { ctx } = wiring('writer');
    const noClaude: HostContext = { ...ctx, config: { profileDir: ctx.config.profileDir } };

    const frames = await runOnce(WRITE_INPUT, hostHandlers(() => noClaude));

    expect(frames).toEqual([{ type: 'error', error: CLAUDE_NOT_INSTALLED, needsSetup: true }]);
  });

  it.skipIf(claudeOnThisMachine)('scores nothing when Claude Code is not installed', async () => {
    const { ctx } = wiring(null);
    const noClaude: HostContext = { ...ctx, config: { profileDir: ctx.config.profileDir } };
    const req = parseScoreRequest({ job: WRITE_INPUT.job });

    const error = await rejection(scoreOnce(noClaude, req));

    expect(error).toBeInstanceOf(ClaudeRunError);
    expect(error).toMatchObject({ kind: 'not-installed', message: CLAUDE_NOT_INSTALLED });
  });
});

describe('hostHandlers wiring: the setup commands', () => {
  // A home of its own, so config.json is written under it and never under the real HOME.
  function setupWiring(overrides: Partial<SetupDeps> = {}): { ctx: HostContext; setup: SetupDeps } {
    const home = mkdtempSync(join(wiringRoot, 'setup-'));
    const ctx: HostContext = {
      config: { profileDir: join(home, 'My files') },
      outputBase: '',
      templatePath: join(home, 'template.tex'),
      baseDir: join(home, '.theseer'),
      home,
      env: { THESEER_TECTONIC: join(home, 'tectonic') },
    };
    const setup: SetupDeps = {
      context: () => ctx,
      readClaudeAuth: async () => ({ loggedIn: true, plan: 'pro', problem: null }),
      chooseFolder: unexpected('chooseFolder'),
      openPath: unexpected('openPath'),
      ...overrides,
    };
    return { ctx, setup };
  }

  it("stores an added file in My files under the file's own date and lists it in the status", async () => {
    const { ctx, setup } = setupWiring();
    const lastModified = new Date(2024, 2, 5, 12, 0).getTime();
    const host = hostHandlers(() => ctx, setup);

    const added = await runOnce({ ...ADD_FILE_INPUT, name: 'cv.md', lastModified }, host);
    const status = await runOnce({ command: 'status' }, host);

    const file = { name: 'cv.md', kind: 'text', words: 1, status: 'read', modified: '2024-03-05', slot: null };
    expect(added).toEqual([{ success: true, file }]);
    expect(status).toEqual([
      {
        success: true,
        status: expect.objectContaining({ profileDir: ctx.config.profileDir, files: [file] }),
      },
    ]);
    expect(readFileSync(join(ctx.config.profileDir ?? '', 'cv.md'), 'utf-8')).toBe('%PDF-1.4');
  });

  it('puts an added file in its slot, replaces it on the next upload to that slot, and lists the slot in the status', async () => {
    const { ctx, setup } = setupWiring();
    const host = hostHandlers(() => ctx, setup);
    await runOnce({ ...ADD_FILE_INPUT, name: 'old.md', slot: 'resume-2' }, host);

    const added = await runOnce({ ...ADD_FILE_INPUT, name: 'new.md', slot: 'resume-2' }, host);
    const status = await runOnce({ command: 'status' }, host);

    expect(added).toEqual([{ success: true, file: expect.objectContaining({ name: 'new.md', slot: 'resume-2' }) }]);
    expect(status).toEqual([
      {
        success: true,
        status: expect.objectContaining({ files: [expect.objectContaining({ name: 'new.md', slot: 'resume-2' })] }),
      },
    ]);
  });

  it('removes a file and frames the files that are left', async () => {
    const { ctx, setup } = setupWiring();
    const host = hostHandlers(() => ctx, setup);
    await runOnce({ ...ADD_FILE_INPUT, name: 'a.md' }, host);
    await runOnce({ ...ADD_FILE_INPUT, name: 'b.md' }, host);

    const frames = await runOnce({ command: 'remove-file', name: 'a.md' }, host);

    expect(frames).toEqual([{ success: true, files: [expect.objectContaining({ name: 'b.md' })] }]);
  });

  it('saves a chosen output folder in the config under the context home', async () => {
    const { ctx, setup } = setupWiring();
    const folder = mkdtempSync(join(ctx.home, 'Resumes-'));

    const frames = await runOnce({ command: 'set-output', outputDir: folder }, hostHandlers(() => ctx, setup));

    expect(frames).toEqual([{ success: true, outputDir: folder }]);
    expect(loadConfig(join(ctx.home, '.theseer', 'config.json')).outputDir).toBe(folder);
  });

  it('answers a folder that is not there with one error and saves nothing', async () => {
    const { ctx, setup } = setupWiring();

    const frames = await runOnce(
      { command: 'set-output', outputDir: join(ctx.home, 'Gone') },
      hostHandlers(() => ctx, setup),
    );

    expect(frames).toEqual([
      { type: 'error', success: false, error: expect.stringContaining("doesn't exist"), needsSetup: true },
    ]);
    expect(existsSync(join(ctx.home, '.theseer', 'config.json'))).toBe(false);
  });

  it('opens My files through the injected opener', async () => {
    const opened: string[] = [];
    const { ctx, setup } = setupWiring({
      openPath: async (path) => {
        opened.push(path);
      },
    });

    const frames = await runOnce({ command: 'open-folder', which: 'files' }, hostHandlers(() => ctx, setup));

    expect(frames).toEqual([{ success: true }]);
    expect(opened).toEqual([ctx.config.profileDir ?? '']);
  });

  it('frames what the folder dialog returns', async () => {
    const { ctx, setup } = setupWiring({ chooseFolder: async () => '/Users/alex/Resumes' });

    const frames = await runOnce({ command: 'choose-folder' }, hostHandlers(() => ctx, setup));

    expect(frames).toEqual([{ success: true, path: '/Users/alex/Resumes' }]);
  });
});
