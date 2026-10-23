import { constants } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { type ClaudeAuth, ClaudeRunError, readClaudeAuth } from './claude-runner';
import {
  configPathFor,
  findClaude,
  findTectonic,
  findTemplate,
  type HostContext,
  PROFILE_NOT_SET,
  requireOutputBase,
  requireProfileDir,
  updateConfig,
} from './config';
import { execFileAsync, isExecFailure, oneLine } from './exec';
import { addMyFile, inspectMyFiles, type MyFile, removeMyFile, type Slot } from './my-files/store';
import { failureReason, hasErrnoCode, ProfileError, SetupError } from './setup-error';
import { HELPER_VERSION } from './version';

// The helper's one-shot commands for the setup page: what is set up, the files in My files, and the folders.

const TAG = '[theseer-pdf]';
const OSASCRIPT = '/usr/bin/osascript';
const OPEN = '/usr/bin/open';
// The helper runs in the background, so the dialog is brought to the front first; otherwise it can open behind Chrome.
const CHOOSE_FOLDER_ARGS = [
  '-e',
  'tell me to activate',
  '-e',
  'POSIX path of (choose folder with prompt "Choose where The Seer saves resumes")',
];
// osascript's error number when the user closes the folder dialog.
const USER_CANCELLED = '(-128)';
// The dialog waits for the user, but not forever: a forgotten one must not keep the helper alive.
const TOOL_TIMEOUT_MS = 10 * 60_000;
// The setup page is waiting on the status, so a claude that does not answer soon is reported as unreadable.
const AUTH_TIMEOUT_MS = 10_000;

export interface HelperStatus {
  version: string;
  // `problem`: what the login says, or that Claude Code is missing or did not answer ('unreadable', with
  // the reason on one line in `detail`); null when it can be used.
  claude: {
    path: string | null;
    loggedIn: boolean;
    plan: string | null;
    problem: ClaudeAuth['problem'] | 'not-installed' | 'unreadable';
    detail?: string;
  };
  tectonic: { path: string | null };
  // The resume template the PDF builder needs; null when it is missing.
  template: { path: string | null };
  profileDir: string | null;
  outputDir: string | null;
  files: MyFile[];
  // Why no resume could be written from My files (the error writing would give); null when nothing stops it.
  profileProblem: string | null;
}

export interface SetupDeps {
  context: () => HostContext;
  readClaudeAuth: typeof readClaudeAuth;
  chooseFolder: () => Promise<string | null>;
  openPath: (path: string) => Promise<void>;
}

export type FolderChoice = 'files' | 'resumes';

// lastModifiedMs is the file's own date (File.lastModified, milliseconds since 1970). `slot` is the place on the
// setup page the file is for; the file that held it is replaced.
export interface AddFileRequest {
  name: string;
  bytes: Uint8Array;
  lastModifiedMs?: number;
  slot?: Slot;
}

export interface SetupHandlers {
  status: () => Promise<HelperStatus>;
  addFile: (req: AddFileRequest) => Promise<MyFile>;
  removeFile: (name: string) => Promise<MyFile[]>;
  chooseFolder: () => Promise<string | null>;
  setOutput: (outputDir: string) => Promise<string>;
  openFolder: (which: FolderChoice) => Promise<void>;
}

// Runs a program and answers with what it printed; the programs below are macOS's own.
export type RunTool = (command: string, args: string[]) => Promise<string>;

export function setupHandlers(deps: SetupDeps): SetupHandlers {
  return {
    status: () => helperStatus(deps),
    addFile: (req) => addFile(deps, req),
    removeFile: (name) => removeFile(deps, name),
    chooseFolder: () => deps.chooseFolder(),
    setOutput: (outputDir) => setOutputDir(deps, outputDir),
    openFolder: (which) => openFolder(deps, which),
  };
}

// The real thing: the dialog and Finder are macOS's own.
export function systemSetupDeps(context: () => HostContext): SetupDeps {
  return { context, readClaudeAuth, chooseFolder: chooseFolderWithDialog, openPath: openInFinder };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// Claude Code and the PDF builder are looked up on every call, so installing either needs no restart.
// A part that cannot be read is reported as such; it never fails the whole status, because the setup page
// needs the rest to tell the user what to fix.
export async function helperStatus(deps: SetupDeps): Promise<HelperStatus> {
  const ctx = deps.context();
  const [claude, myFiles] = await Promise.all([
    claudeStatus(deps, findClaude(ctx.config, ctx.home)),
    myFilesStatus(ctx),
  ]);
  return {
    version: HELPER_VERSION,
    claude,
    tectonic: { path: findTectonic(ctx.env, ctx.baseDir) },
    template: { path: findTemplate(ctx.templatePath) },
    profileDir: ctx.config.profileDir || null,
    outputDir: ctx.outputBase || null,
    ...myFiles,
  };
}

// A cancelled check is rethrown: only a stopped request cancels it, and nobody is waiting for the reply.
async function claudeStatus(deps: SetupDeps, claudePath: string | null): Promise<HelperStatus['claude']> {
  if (claudePath === null) return { path: null, loggedIn: false, plan: null, problem: 'not-installed' };
  try {
    const auth = await deps.readClaudeAuth(claudePath, { timeoutMs: AUTH_TIMEOUT_MS });
    return { path: claudePath, loggedIn: auth.loggedIn, plan: auth.plan, problem: auth.problem };
  } catch (error) {
    if (!(error instanceof ClaudeRunError) || error.kind === 'cancelled') throw error;
    const detail = oneLine(error.message);
    console.error(`${TAG} Couldn't read Claude Code's status: ${detail}`);
    return { path: claudePath, loggedIn: false, plan: null, problem: 'unreadable', detail };
  }
}

// A folder that is not set or cannot be read lists no files; its problem says why.
async function myFilesStatus(ctx: HostContext): Promise<Pick<HelperStatus, 'files' | 'profileProblem'>> {
  if (!ctx.config.profileDir) return { files: [], profileProblem: PROFILE_NOT_SET };
  try {
    const { files, problem } = await inspectMyFiles(ctx.config.profileDir);
    return { files, profileProblem: problem };
  } catch (error) {
    if (!(error instanceof ProfileError)) throw error;
    console.error(`${TAG} Couldn't list My files: ${error.message}`);
    return { files: [], profileProblem: error.message };
  }
}

export async function addFile(deps: SetupDeps, req: AddFileRequest): Promise<MyFile> {
  const profileDir = requireProfileDir(deps.context().config);
  return addMyFile(profileDir, req.name, req.bytes, req.lastModifiedMs, req.slot);
}

export async function removeFile(deps: SetupDeps, name: string): Promise<MyFile[]> {
  return removeMyFile(requireProfileDir(deps.context().config), name);
}

// Saves the resumes folder in the helper's config. The folder must already exist and be writable,
// so a typo is caught here instead of when the first resume is written.
export async function setOutputDir(deps: SetupDeps, outputDir: string): Promise<string> {
  const folder = await writableFolder(outputDir);
  updateConfig(configPathFor(deps.context().home), { outputDir: folder });
  return folder;
}

export async function openFolder(deps: SetupDeps, which: FolderChoice): Promise<void> {
  const ctx = deps.context();
  const folder = which === 'files' ? requireProfileDir(ctx.config) : requireOutputBase(ctx.outputBase);
  await createFolder(folder);
  await deps.openPath(folder);
}

// ---------------------------------------------------------------------------
// macOS: the folder dialog and Finder
// ---------------------------------------------------------------------------

// The folder the user picked, or null when they closed the dialog.
export async function chooseFolderWithDialog(run: RunTool = runTool): Promise<string | null> {
  let chosen: string;
  try {
    chosen = (await run(OSASCRIPT, CHOOSE_FOLDER_ARGS)).trim();
  } catch (error) {
    if (toolMessage(error).includes(USER_CANCELLED)) return null;
    throw new Error(`Couldn't show the folder dialog: ${toolProblem(error)}`, { cause: error });
  }
  if (chosen === '') throw new Error("The folder dialog didn't say which folder was chosen");
  return resolve(chosen); // osascript ends a folder's path with a slash
}

export async function openInFinder(path: string, run: RunTool = runTool): Promise<void> {
  const absolute = resolve(path);
  try {
    await run(OPEN, [absolute]);
  } catch (error) {
    throw new Error(`Couldn't open ${absolute}: ${toolProblem(error)}`, { cause: error });
  }
}

async function runTool(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { timeout: TOOL_TIMEOUT_MS, encoding: 'utf8' });
  return stdout;
}

// What the program said on stderr (execFile puts it on the error), else the error's own words.
function toolMessage(error: unknown): string {
  if (isExecFailure(error) && typeof error.stderr === 'string' && error.stderr.trim() !== '') {
    return oneLine(error.stderr);
  }
  return failureReason(error);
}

function toolProblem(error: unknown): string {
  const timedOut = isExecFailure(error) && error.killed === true;
  return timedOut ? `it did not finish within ${TOOL_TIMEOUT_MS / 60_000} minutes` : toolMessage(error);
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

async function writableFolder(outputDir: string): Promise<string> {
  if (!isAbsolute(outputDir)) {
    throw new SetupError(`Choose the folder by its full path, starting with /, not ${JSON.stringify(outputDir)}`);
  }
  const folder = resolve(outputDir);
  await requireFolder(folder);
  try {
    await access(folder, constants.W_OK);
  } catch (error) {
    throw new SetupError(`Can't save resumes in ${folder}: ${failureReason(error)}`, { cause: error });
  }
  return folder;
}

async function requireFolder(folder: string): Promise<void> {
  let isFolder: boolean;
  try {
    isFolder = (await stat(folder)).isDirectory();
  } catch (error) {
    if (hasErrnoCode(error, 'ENOENT')) throw new SetupError(`The folder ${folder} doesn't exist`, { cause: error });
    throw new SetupError(`Can't read ${folder}: ${failureReason(error)}`, { cause: error });
  }
  if (!isFolder) throw new SetupError(`${folder} is a file, not a folder`);
}

async function createFolder(folder: string): Promise<void> {
  try {
    await mkdir(folder, { recursive: true });
  } catch (error) {
    throw new SetupError(`Can't create ${folder}: ${failureReason(error)}`, { cause: error });
  }
}
