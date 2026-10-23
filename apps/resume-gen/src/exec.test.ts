import { describe, expect, it } from 'bun:test';
import { execFileAsync, isExecFailure, oneLine } from './exec';

describe('oneLine', () => {
  it('trims the text and collapses every run of whitespace to one space', () => {
    expect(oneLine('  first line\n\n  second\tline  ')).toBe('first line second line');
  });
});

describe('execFileAsync and isExecFailure', () => {
  it("resolves with the program's output", async () => {
    const { stdout } = await execFileAsync('/bin/echo', ['hello'], { encoding: 'utf8' });
    expect(stdout).toBe('hello\n');
  });

  it('rejects with an Error carrying the exit code and stderr', async () => {
    const error = await execFileAsync('/bin/sh', ['-c', 'echo oops >&2; exit 3'], { encoding: 'utf8' }).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(isExecFailure(error)).toBe(true);
    if (!isExecFailure(error)) return;
    expect(error.code).toBe(3);
    expect(error.stderr).toBe('oops\n');
  });

  it('is false for a value that is not an Error', () => {
    expect(isExecFailure('boom')).toBe(false);
  });
});
