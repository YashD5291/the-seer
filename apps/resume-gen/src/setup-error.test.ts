import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { failureReason, fileProblem, hasErrnoCode, ProfileError, SetupError } from './setup-error';

describe('error classes', () => {
  it('makes a ProfileError a SetupError and an Error', () => {
    const error = new ProfileError('no profile');

    expect(error).toBeInstanceOf(SetupError);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('no profile');
  });

  it('keeps a SetupError distinct from a ProfileError', () => {
    expect(new SetupError('setup')).not.toBeInstanceOf(ProfileError);
  });
});

describe('failureReason', () => {
  it('words a file system error as its code and description', () => {
    expect(failureReason(fileSystemError('/no/such/file'))).toBe('ENOENT (no such file or directory)');
  });

  it('falls back to the message for an error without a code', () => {
    expect(failureReason(new Error('boom'))).toBe('boom');
  });

  it('falls back to the code when the message has no description', () => {
    expect(failureReason(Object.assign(new Error('odd'), { code: 'EODD' }))).toBe('EODD');
  });

  it('stringifies a value that is not an Error', () => {
    expect(failureReason('plain text')).toBe('plain text');
  });
});

function fileSystemError(path: string): unknown {
  try {
    readFileSync(path);
  } catch (error) {
    return error;
  }
  throw new Error(`expected ${path} to be unreadable`);
}

describe('hasErrnoCode', () => {
  it('matches the code of a file system error', () => {
    const error = fileSystemError('/no/such/file');
    expect(hasErrnoCode(error, 'ENOENT')).toBe(true);
    expect(hasErrnoCode(error, 'EEXIST')).toBe(false);
  });

  it('is false for an error without a code and for a value that is not an Error', () => {
    expect(hasErrnoCode(new Error('ENOENT'), 'ENOENT')).toBe(false);
    expect(hasErrnoCode({ code: 'ENOENT' }, 'ENOENT')).toBe(false);
  });
});

describe('fileProblem', () => {
  it('is a ProfileError naming the action, the path and the reason, caused by the error', () => {
    const error = fileSystemError('/no/such/file');

    const problem = fileProblem('read', '/no/such/file', error);

    expect(problem).toBeInstanceOf(ProfileError);
    expect(problem.message).toBe("Can't read /no/such/file: ENOENT (no such file or directory)");
    expect(problem.cause).toBe(error);
  });
});
