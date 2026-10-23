import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { getSettings, saveSettings } from './storage.ts';

type Stored = Record<string, unknown>;

/** chrome.storage.local over a plain object; records the keys each `get` asked for. */
function fakeChrome(stored: Stored): { asked: unknown[]; stored: Stored } {
  const asked: unknown[] = [];
  const local = {
    get: async (keys: string[]): Promise<Stored> => {
      asked.push(keys);
      return Object.fromEntries(keys.filter((key) => key in stored).map((key) => [key, stored[key]]));
    },
    set: async (items: Stored): Promise<void> => {
      Object.assign(stored, items);
    },
  };
  Object.assign(globalThis, { chrome: { storage: { local } } });
  return { asked, stored };
}

describe('settings storage', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'chrome');
  });

  it('reads the extra instructions along with the other settings', async () => {
    const fake = fakeChrome({ claudeModel: 'sonnet', maxPages: 2, minScore: 55, writerNotes: 'Use British spelling.' });

    assert.deepEqual(await getSettings(), {
      claudeModel: 'sonnet',
      maxPages: 2,
      minScore: 55,
      writerNotes: 'Use British spelling.',
    });
    assert.ok((fake.asked[0] as string[]).includes('writerNotes'));
  });

  it('has empty extra instructions when none are saved', async () => {
    fakeChrome({});

    assert.equal((await getSettings()).writerNotes, '');
  });

  it('trims and caps saved extra instructions when it reads them', async () => {
    fakeChrome({ writerNotes: `  ${'a'.repeat(2500)}  ` });

    assert.equal((await getSettings()).writerNotes, 'a'.repeat(2000));
  });

  it('saves only the extra instructions, leaving the other settings as they were', async () => {
    const fake = fakeChrome({ minScore: 55 });

    await saveSettings({ writerNotes: 'Lead with backend work.' });

    assert.deepEqual(fake.stored, { minScore: 55, writerNotes: 'Lead with backend work.' });
  });
});
