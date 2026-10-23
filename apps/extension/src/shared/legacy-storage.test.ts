import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LEGACY_STORAGE_KEYS, legacyKeysIn } from './legacy-storage.ts';

describe('LEGACY_STORAGE_KEYS', () => {
  it('lists every key the pre-Claude-Code versions stored', () => {
    assert.deepEqual(
      [...LEGACY_STORAGE_KEYS].sort(),
      [
        'baseResumeSummaries',
        'claudeEffort',
        'claudeExtendedThinking',
        'dashboardUrl',
        'grokModel',
        'profile',
        'promptIds',
        'prompts',
        'seerContext',
        'systemPrompts',
      ],
    );
  });
});

describe('legacyKeysIn', () => {
  it('returns only the legacy keys that are stored', () => {
    const stored = { profile: {}, grokModel: 'x', claudeModel: 'opus', tabJobs: {} };
    assert.deepEqual(legacyKeysIn(stored), ['profile', 'grokModel']);
  });

  it('finds the effort and dashboard URL that earlier versions stored', () => {
    const stored = { claudeEffort: 'high', dashboardUrl: 'https://example.test', claudeModel: 'opus' };
    assert.deepEqual(legacyKeysIn(stored), ['claudeEffort', 'dashboardUrl']);
  });

  it('returns nothing when no legacy key is stored', () => {
    assert.deepEqual(legacyKeysIn({ claudeModel: 'opus', maxPages: 2, minScore: 55 }), []);
  });
});
