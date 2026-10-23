// A problem the user can fix on the setup page or in My files; the message says how.
export class SetupError extends Error {}

export class ProfileError extends SetupError {}

// Node words a file system error as "EACCES: permission denied, open '/path'".
const ERRNO_DESCRIPTION = /^[A-Z0-9_]+: (.+?), \w+ '/;

// "EACCES (permission denied)"; the path is left out because the caller already names it.
export function failureReason(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (!('code' in error) || typeof error.code !== 'string') return error.message;
  const description = ERRNO_DESCRIPTION.exec(error.message)?.[1];
  return description === undefined ? error.code : `${error.code} (${description})`;
}

export function hasErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

// "Can't save /path: EACCES (permission denied)"
export function fileProblem(action: string, path: string, error: unknown): ProfileError {
  return new ProfileError(`Can't ${action} ${path}: ${failureReason(error)}`, { cause: error });
}
