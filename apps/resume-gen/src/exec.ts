import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Runs a program without a shell; rejects with an ExecFailure when it fails, times out or cannot start.
export const execFileAsync = promisify(execFile);

// What execFile rejects with: `code` is the exit code (or 'ENOENT' when the program is missing),
// `killed` is set when the timeout stopped it, `stderr` is what it printed there.
export type ExecFailure = Error & { code?: string | number; killed?: boolean; stderr?: string };

export function isExecFailure(error: unknown): error is ExecFailure {
  return error instanceof Error;
}

// The text trimmed, with every run of whitespace (line breaks included) as one space.
export function oneLine(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}
