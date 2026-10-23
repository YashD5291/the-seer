import {
  CLAUDE_NOT_INSTALLED,
  type ClaudeOptions,
  ClaudeRunError,
  checkClaudeLogin,
  EFFORTS,
  type Effort,
  runClaudeJson,
  runClaudeWriter,
} from './claude-runner';
import {
  findClaude,
  type HostContext,
  requireOutputBase,
  requireProfileDir,
  requireTemplate,
  resolveTectonicPath,
} from './config';
import {
  type BuildOptions,
  buildResume,
  type GenerateResult,
  generateResume,
  type HostMessage,
  type NativeError,
  type RecompileRequest,
  type RecompileResult,
  recompileTex,
  toNativeError,
  type WriteDeps,
  type WriteRequest,
  writeResume,
} from './generate';
import { isRecord, type JsonObject } from './json-validation';
import { assertFileWithinLimit, isSlot, type Slot, SLOTS } from './my-files/store';
import { loadProfile } from './profile';
import { buildScoreRequest, type FitResult, fitResultFromReply, MAX_SCORE } from './scorer/request';
import {
  type AddFileRequest,
  type FolderChoice,
  type SetupDeps,
  type SetupHandlers,
  setupHandlers,
  systemSetupDeps,
} from './setup-commands';
import { MAX_WRITER_NOTES, type WriterJob } from './writer/request';

// Chrome native messaging: each message is a 4-byte little-endian length, then UTF-8 JSON.

export interface NativeIo {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
}

export interface GenerateRequest {
  responseText: string;
  fallbackTitle: string | null;
  maxPages: number;
}

// The CLI's --score: one job scored, nothing written.
export interface ScoreRequest {
  job: WriterJob;
  model: string;
  effort: Effort;
}

export interface NativeHandlers extends SetupHandlers {
  write: (req: WriteRequest, signal: AbortSignal, send: (message: HostMessage) => void) => Promise<void>;
  recompile: (req: RecompileRequest) => Promise<RecompileResult>;
  generate: (req: GenerateRequest) => Promise<GenerateResult>;
}

type Send = (message: unknown) => void;

const TAG = '[theseer-pdf]';
const HEADER_BYTES = 4;
// Chrome drops a host-to-extension message over 1 MB.
const MAX_MESSAGE_BYTES = 1024 * 1024;
// Chrome lets a message to the host run to 4 GB; the largest this host reads is a 10 MB file as base64 plus a little JSON.
export const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const READ_TIMEOUT_MS = 5_000;
const FALLBACK_MODEL = 'sonnet';
const WRITE_TIMEOUT_MS = 6 * 60_000;
const SCORE_TIMEOUT_MS = 2 * 60_000;
const SCORE_TASK = 'Job scoring';
export const DEFAULT_MAX_PAGES = 2;
// Scoring is cheap: Haiku at low effort, and a resume only at a fit of 40 or more.
export const DEFAULT_SCORE_MODEL = 'haiku';
export const DEFAULT_SCORE_EFFORT: Effort = 'low';
export const DEFAULT_MIN_SCORE = 40;
// Aliases (opus) and full ids (claude-opus-5-5, …[1m]). The first character is never "-", so a
// model name cannot pass for a claude flag.
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

export function encodeNativeMessage(value: unknown): Uint8Array {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('Cannot send an empty message to Chrome');
  const body = Buffer.from(json, 'utf8');
  if (body.length > MAX_MESSAGE_BYTES) {
    throw new Error(`Message too large for Chrome: ${body.length} bytes (the limit is 1 MB)`);
  }
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

// The chunks are kept as they arrive and joined once, when the whole message is in.
export function readNativeMessage(stream: NodeJS.ReadableStream, timeoutMs: number = READ_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    // The body length the header announces; null until all 4 header bytes have arrived.
    let announced: number | null = null;

    const stopListening = (): void => {
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    };
    const fail = (message: string): void => {
      stopListening();
      reject(new Error(message));
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      chunks.push(bytes);
      received += bytes.length;
      if (announced === null && received >= HEADER_BYTES) {
        announced = Buffer.concat(chunks, HEADER_BYTES).readUInt32LE(0);
        // The header alone decides: an oversized message is refused before any more of it is read.
        if (announced > MAX_INPUT_BYTES) {
          fail(tooLargeMessage(announced));
          return;
        }
      }
      if (announced === null || received < HEADER_BYTES + announced) return;
      stopListening();
      const body = Buffer.concat(chunks, received).subarray(HEADER_BYTES, HEADER_BYTES + announced);
      try {
        resolve(parseBody(body));
      } catch (error) {
        reject(error);
      }
    };
    const onEnd = (): void =>
      fail(received === 0 ? 'No input received from Chrome' : 'Input from Chrome ended before the message was complete');
    const onError = (error: Error): void => fail(`Could not read the message from Chrome: ${error.message}`);
    const timer = setTimeout(() => fail(`No message from Chrome within ${timeoutMs / 1000} s`), timeoutMs);

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

function tooLargeMessage(announced: number): string {
  return `The message from Chrome is too large (${announced.toLocaleString('en-US')} bytes; the limit is ${MAX_INPUT_BYTES / (1024 * 1024)} MiB)`;
}

function parseBody(body: Buffer): unknown {
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(`The message from Chrome is not valid JSON (${error.message})`);
  }
}

// Writes are ordered, so waiting for the last one means every message has left the process.
function framedSender(stdout: NodeJS.WritableStream): { send: Send; flushed: () => Promise<void> } {
  let last: Promise<void> = Promise.resolve();
  const send = (message: unknown): void => {
    const frame = encodeNativeMessage(message);
    last = new Promise((resolve) => {
      stdout.write(frame, () => resolve());
    });
  };
  return { send, flushed: () => last };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

// Reads one request and answers it. `write` streams progress and ends with one result or error;
// `recompile`, `generate` and the setup commands answer once. Returns when the last message is flushed.
export async function runNativeHost(io: NativeIo, handlers: NativeHandlers): Promise<void> {
  // Chrome closes stdin when the port closes (tab gone, extension reloaded): stop Claude then.
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  io.stdin.once('end', abort);
  io.stdin.once('close', abort);
  io.stdout.on('error', (error: Error) => console.error(`${TAG} could not write to Chrome: ${error.message}`));

  const { send, flushed } = framedSender(io.stdout);
  await dispatch(io.stdin, handlers, controller.signal, send);
  await flushed();
}

async function dispatch(
  stdin: NodeJS.ReadableStream,
  handlers: NativeHandlers,
  signal: AbortSignal,
  send: Send,
): Promise<void> {
  let input: JsonObject;
  try {
    input = asObject(await readNativeMessage(stdin), 'The message from Chrome');
  } catch (error) {
    send(failure('request', error));
    return;
  }
  switch (input.command) {
    case 'write':
      return answerWrite(input, handlers, signal, send);
    case 'recompile':
      return answerRecompile(input, handlers, send);
    case 'generate':
    case undefined:
      return answerGenerate(input, handlers, send);
    case 'status':
      return answerSetup('status', send, async () => ({ status: await handlers.status() }));
    case 'add-file':
      return answerSetup('add-file', send, async () => ({ file: await handlers.addFile(parseAddFileRequest(input)) }));
    case 'remove-file':
      return answerSetup('remove-file', send, async () => ({
        files: await handlers.removeFile(requireText(input.name, 'name')),
      }));
    case 'choose-folder':
      return answerSetup('choose-folder', send, async () => ({ path: await handlers.chooseFolder() }));
    case 'set-output':
      return answerSetup('set-output', send, async () => ({
        outputDir: await handlers.setOutput(requireText(input.outputDir, 'outputDir')),
      }));
    case 'open-folder':
      return answerSetup('open-folder', send, async () => {
        await handlers.openFolder(parseFolderChoice(input.which));
        return {};
      });
    default:
      send(failure('request', new Error(`Unknown command: ${String(input.command)}`)));
  }
}

async function answerWrite(input: JsonObject, handlers: NativeHandlers, signal: AbortSignal, send: Send): Promise<void> {
  const sendLogged = (message: HostMessage): void => {
    if (message.type === 'error') console.error(`${TAG} write failed: ${message.error}`);
    send(message);
  };
  try {
    await handlers.write(parseWriteRequest(input), signal, sendLogged);
  } catch (error) {
    sendLogged(toNativeError(error));
  }
}

// The editor reads LaTeX errors from `compilerOutput`.
async function answerRecompile(input: JsonObject, handlers: NativeHandlers, send: Send): Promise<void> {
  try {
    send(await handlers.recompile(parseRecompileRequest(input)));
  } catch (error) {
    const { error: message, details } = toNativeError(error);
    console.error(`${TAG} recompile failed: ${message}`);
    send({ success: false, error: message, ...(details !== undefined && { compilerOutput: details }) });
  }
}

async function answerGenerate(input: JsonObject, handlers: NativeHandlers, send: Send): Promise<void> {
  try {
    send(await handlers.generate(parseGenerateRequest(input)));
  } catch (error) {
    send(failure('generate', error));
  }
}

// The setup page's commands reply { success: true, ...fields }, or the failure shape below.
async function answerSetup(command: string, send: Send, run: () => Promise<JsonObject>): Promise<void> {
  try {
    send({ success: true, ...(await run()) });
  } catch (error) {
    send(failure(command, error));
  }
}

// Carries both `type` (the write port reads it) and `success` (one-shot callers read it).
function failure(command: string, error: unknown): NativeError & { success: false } {
  const native = toNativeError(error);
  console.error(`${TAG} ${command} failed: ${native.error}`);
  return { ...native, success: false };
}

// ---------------------------------------------------------------------------
// Request validation: the message is untrusted JSON
// ---------------------------------------------------------------------------

export function parseWriteRequest(input: JsonObject): WriteRequest {
  const writerNotes = parseWriterNotes(input.writerNotes);
  return {
    command: 'write',
    job: parseJob(input.job),
    model: parseModel(input.model, 'model'),
    effort: parseEffort(input.effort, 'effort'),
    maxPages: parseMaxPages(input.maxPages),
    scoreModel: input.scoreModel === undefined ? DEFAULT_SCORE_MODEL : parseModel(input.scoreModel, 'scoreModel'),
    scoreEffort: input.scoreEffort === undefined ? DEFAULT_SCORE_EFFORT : parseEffort(input.scoreEffort, 'scoreEffort'),
    minScore: input.minScore === undefined ? DEFAULT_MIN_SCORE : parseMinScore(input.minScore),
    ...(writerNotes !== undefined && { writerNotes }),
  };
}

export function parseScoreRequest(input: JsonObject): ScoreRequest {
  return {
    job: parseJob(input.job),
    model: input.model === undefined ? DEFAULT_SCORE_MODEL : parseModel(input.model, 'model'),
    effort: input.effort === undefined ? DEFAULT_SCORE_EFFORT : parseEffort(input.effort, 'effort'),
  };
}

function parseJob(value: unknown): WriterJob {
  const job = asObject(value, 'job');
  return {
    text: requireText(job.text, 'job.text'),
    url: optionalString(job.url, 'job.url') ?? '',
    title: optionalString(job.title, 'job.title') ?? '',
  };
}

function parseRecompileRequest(input: JsonObject): RecompileRequest {
  const uploadPdfPath = optionalString(input.uploadPdfPath, 'uploadPdfPath');
  return {
    texSource: requireText(input.texSource, 'texSource'),
    texPath: requireText(input.texPath, 'texPath'),
    folderPath: requireText(input.folderPath, 'folderPath'),
    ...(uploadPdfPath !== undefined && { uploadPdfPath }),
  };
}

function parseGenerateRequest(input: JsonObject): GenerateRequest {
  return {
    responseText: requireText(input.responseText, 'responseText'),
    fallbackTitle: optionalString(input.chatTitle, 'chatTitle') ?? null,
    maxPages: input.maxPages === undefined ? DEFAULT_MAX_PAGES : parseMaxPages(input.maxPages),
  };
}

function parseAddFileRequest(input: JsonObject): AddFileRequest {
  const name = requireText(input.name, 'name');
  const bytes = decodeFileData(input.dataBase64, name);
  const lastModifiedMs = parseLastModified(input.lastModified);
  const slot = parseSlot(input.slot);
  return { name, bytes, ...(lastModifiedMs !== undefined && { lastModifiedMs }), ...(slot !== undefined && { slot }) };
}

// The store's size limit, checked as soon as the file is decoded (addMyFile checks it again).
function decodeFileData(value: unknown, name: string): Uint8Array {
  if (typeof value !== 'string') throw new Error('dataBase64 must be text (the file, base64-encoded)');
  const bytes = Buffer.from(value, 'base64');
  assertFileWithinLimit(name, bytes.byteLength);
  return bytes;
}

// The browser's File.lastModified: milliseconds since 1970.
function parseLastModified(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new Error('lastModified must be a number of milliseconds since 1970');
}

function parseSlot(value: unknown): Slot | undefined {
  if (value === undefined) return undefined;
  if (isSlot(value)) return value;
  throw new Error(`slot must be one of ${SLOTS.join(', ')}`);
}

function parseFolderChoice(value: unknown): FolderChoice {
  if (value === 'files' || value === 'resumes') return value;
  throw new Error("which must be 'files' or 'resumes'");
}

function parseModel(value: unknown, label: string): string {
  if (typeof value === 'string' && MODEL_NAME.test(value)) return value;
  throw new Error(`${label} must be a model name such as opus, sonnet or claude-opus-5-5`);
}

function parseEffort(value: unknown, label: string): Effort {
  const effort = EFFORTS.find((candidate) => candidate === value);
  if (effort === undefined) throw new Error(`${label} must be one of ${EFFORTS.join(', ')}`);
  return effort;
}

function parseWriterNotes(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.length <= MAX_WRITER_NOTES) return value;
  throw new Error(`writerNotes must be text of at most ${MAX_WRITER_NOTES.toLocaleString('en-US')} characters`);
}

function parseMinScore(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_SCORE) return value;
  throw new Error(`minScore must be a whole number from 0 to ${MAX_SCORE}`);
}

export function parseMaxPages(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value;
  throw new Error('maxPages must be a whole number, 1 or more');
}

function asObject(value: unknown, label: string): JsonObject {
  if (isRecord(value)) return value;
  throw new Error(`${label} must be a JSON object`);
}

function requireText(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value;
  throw new Error(`${label} must be non-empty text`);
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  throw new Error(`${label} must be text`);
}

// ---------------------------------------------------------------------------
// The real pipeline behind each command
// ---------------------------------------------------------------------------

// The context is loaded per request, so a broken config becomes an error message, not a crash.
// `setup` is the macOS folder dialog and Finder; tests pass stand-ins.
export function hostHandlers(context: () => HostContext, setup: SetupDeps = systemSetupDeps(context)): NativeHandlers {
  return {
    ...setupHandlers(setup),
    write: async (req, signal, send) => writeResume(req, writeDeps(context(), req, signal), send),
    recompile: async (req) => {
      const ctx = context();
      const outputBase = requireOutputBase(ctx.outputBase);
      return recompileTex(req, { outputBase, tectonicPath: resolveTectonicPath(ctx.env, ctx.baseDir) });
    },
    generate: async (req) =>
      generateResume(req.responseText, { ...buildOptions(context(), req.maxPages), fallbackTitle: req.fallbackTitle }),
  };
}

// Everything that can be checked before Claude runs is checked here, so a missing tectonic or
// template fails in a second instead of after a multi-minute write.
export function buildOptions(ctx: HostContext, maxPages: number): BuildOptions {
  const templatePath = requireTemplate(ctx.templatePath);
  return {
    outputBase: requireOutputBase(ctx.outputBase),
    templatePath,
    tectonicPath: resolveTectonicPath(ctx.env, ctx.baseDir),
    maxPages,
  };
}

// Claude Code is looked up on every request, so installing it needs no restart of the helper.
function requireClaudePath(ctx: HostContext): string {
  const claudePath = findClaude(ctx.config, ctx.home);
  if (claudePath === null) throw new ClaudeRunError('not-installed', CLAUDE_NOT_INSTALLED);
  return claudePath;
}

export function writeDeps(ctx: HostContext, req: WriteRequest, signal?: AbortSignal): WriteDeps {
  const build = buildOptions(ctx, req.maxPages);
  const claudePath = requireClaudePath(ctx);
  const claude: ClaudeOptions = {
    claudePath,
    model: req.model,
    effort: req.effort,
    fallbackModel: FALLBACK_MODEL,
    timeoutMs: WRITE_TIMEOUT_MS,
    signal,
  };
  return {
    loadProfile: async () => loadProfile(requireProfileDir(ctx.config)),
    checkLogin: () => checkClaudeLogin(claudePath, { signal }),
    runScorer: (request) =>
      runClaudeJson(request, scorerOptions(claudePath, req.scoreModel, req.scoreEffort, signal), fitResultFromReply),
    runWriter: (request) => runClaudeWriter(request, claude),
    build: (doc, onStage) => buildResume(doc, { ...build, onStage, signal }),
  };
}

// Profile, login check, then one scoring run; needs no template or output folder.
export async function scoreOnce(ctx: HostContext, req: ScoreRequest): Promise<FitResult> {
  const profile = await loadProfile(requireProfileDir(ctx.config));
  const claudePath = requireClaudePath(ctx);
  await checkClaudeLogin(claudePath);
  const request = buildScoreRequest({ profile, job: req.job });
  const { value } = await runClaudeJson(request, scorerOptions(claudePath, req.model, req.effort), fitResultFromReply);
  return value;
}

// Sonnet is the only fallback, for when Haiku is overloaded.
function scorerOptions(claudePath: string, model: string, effort: Effort, signal?: AbortSignal): ClaudeOptions {
  return {
    claudePath,
    model,
    effort,
    fallbackModel: FALLBACK_MODEL,
    timeoutMs: SCORE_TIMEOUT_MS,
    signal,
    task: SCORE_TASK,
  };
}
