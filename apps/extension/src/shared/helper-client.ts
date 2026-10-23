import { errorMessage } from './error-message.js';
import { isRecord } from './guards.js';
import type { UnknownRecord } from './guards.js';
import type { HelperStatus, MyFile, Slot } from './helper-types.js';
import { isHelperStatus, isMyFile, isMyFileList } from './helper-types.js';

/** The native messaging host name the installer registers with Chrome. */
export const NATIVE_HOST = 'com.theseer.resumegen';

export const HELPER_MISSING = "The Seer's helper isn't installed — run the install command from the setup page";

/** What Chrome says when the helper is not registered, or this extension may not talk to it. */
const NOT_INSTALLED_REASONS: readonly string[] = [
  'native messaging host not found',
  'access to the specified native messaging host is forbidden',
];

/** `chrome.runtime.sendNativeMessage` with the host name first; a fake in tests. */
export type SendNative = (host: string, message: object) => Promise<unknown>;

export interface HelperClient {
  status(): Promise<HelperStatus>;
  /**
   * `lastModified` (ms since 1970, a File's own date) lets the helper keep the date the user last changed the file.
   * `slot` puts it in that place on the setup page; the helper replaces whatever file held it.
   */
  addFile(name: string, dataBase64: string, lastModified?: number, slot?: Slot): Promise<MyFile>;
  removeFile(name: string): Promise<MyFile[]>;
  /** The folder the user picked, or `null` when they cancelled. */
  chooseFolder(): Promise<string | null>;
  /** Saves the resume folder; resolves with the folder the helper stored. */
  setOutput(dir: string): Promise<string>;
  openFolder(which: 'files' | 'resumes'): Promise<void>;
}

interface HelperErrorOptions {
  notInstalled?: boolean;
  needsSetup?: boolean;
  details?: string;
}

/** A helper command that did not succeed. */
export class HelperError extends Error {
  /** The helper is not registered with Chrome (or Chrome refuses this extension access to it). */
  readonly notInstalled: boolean;
  /** The fix is on the setup page: the helper is missing, or it said so in its failure reply. */
  readonly needsSetup: boolean;
  readonly details?: string;

  constructor(message: string, options: HelperErrorOptions = {}) {
    super(message);
    this.name = 'HelperError';
    this.notInstalled = options.notInstalled ?? false;
    this.needsSetup = options.needsSetup ?? this.notInstalled;
    this.details = options.details;
  }
}

/**
 * HELPER_MISSING when Chrome's `reason` says the helper is not registered, or this extension may
 * not use it; null for any other reason. Shared by the one-shot commands and the write port.
 */
export function notInstalledMessage(reason: string): string | null {
  const lower = reason.toLowerCase();
  return NOT_INSTALLED_REASONS.some((known) => lower.includes(known)) ? HELPER_MISSING : null;
}

function transportError(err: unknown): HelperError {
  const reason = errorMessage(err);
  const missing = notInstalledMessage(reason);
  if (missing !== null) return new HelperError(missing, { notInstalled: true });
  return new HelperError(`The helper did not answer: ${reason}`);
}

function unexpectedReply(command: string): HelperError {
  return new HelperError(
    `Unexpected reply from the helper to "${command}" — it may be out of date; run the install command from the setup page again.`,
  );
}

/** The reply to `command` when it succeeded; throws the helper's failure, or a HelperError for a reply that is neither. */
async function request(send: SendNative, command: string, fields: UnknownRecord = {}): Promise<UnknownRecord> {
  let reply: unknown;
  try {
    reply = await send(NATIVE_HOST, { command, ...fields });
  } catch (err) {
    throw transportError(err);
  }
  if (!isRecord(reply)) throw unexpectedReply(command);
  if (reply.success === true) return reply;
  if (reply.success === false && typeof reply.error === 'string') {
    throw new HelperError(reply.error, {
      needsSetup: reply.needsSetup === true,
      details: typeof reply.details === 'string' ? reply.details : undefined,
    });
  }
  throw unexpectedReply(command);
}

export function createHelperClient(send: SendNative): HelperClient {
  return {
    async status() {
      const { status } = await request(send, 'status');
      if (!isHelperStatus(status)) throw unexpectedReply('status');
      return status;
    },

    async addFile(name, dataBase64, lastModified, slot) {
      const { file } = await request(send, 'add-file', {
        name,
        dataBase64,
        ...(lastModified !== undefined && { lastModified }),
        ...(slot !== undefined && { slot }),
      });
      if (!isMyFile(file)) throw unexpectedReply('add-file');
      return file;
    },

    async removeFile(name) {
      const { files } = await request(send, 'remove-file', { name });
      if (!isMyFileList(files)) throw unexpectedReply('remove-file');
      return files;
    },

    async chooseFolder() {
      const { path } = await request(send, 'choose-folder');
      if (path !== null && typeof path !== 'string') throw unexpectedReply('choose-folder');
      return path;
    },

    async setOutput(dir) {
      const { outputDir } = await request(send, 'set-output', { outputDir: dir });
      if (typeof outputDir !== 'string') throw unexpectedReply('set-output');
      return outputDir;
    },

    async openFolder(which) {
      await request(send, 'open-folder', { which });
    },
  };
}
