import { describe, expect, it } from 'bun:test';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTempDir } from './temp-dir';

describe('withTempDir', () => {
  it("runs with a new folder in the system's temp folder and answers with run's result", async () => {
    let seen = '';

    const result = await withTempDir('theseer-test-', async (dir) => {
      seen = dir;
      expect(statSync(dir).isDirectory()).toBe(true);
      return 42;
    });

    expect(result).toBe(42);
    expect(seen.startsWith(join(tmpdir(), 'theseer-test-'))).toBe(true);
  });

  it('removes the folder and everything in it afterwards', async () => {
    const dir = await withTempDir('theseer-test-', async (folder) => {
      writeFileSync(join(folder, 'work.txt'), 'scratch');
      return folder;
    });

    expect(existsSync(dir)).toBe(false);
  });

  it('removes the folder when run throws, and passes the error on', async () => {
    let seen = '';

    const error = await withTempDir('theseer-test-', async (dir) => {
      seen = dir;
      throw new Error('boom');
    }).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error && error.message).toBe('boom');
    expect(existsSync(seen)).toBe(false);
  });
});
