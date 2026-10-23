/** Keys that earlier versions kept in `chrome.storage.local` and nothing reads any more. */
export const LEGACY_STORAGE_KEYS: readonly string[] = [
  'profile',
  'prompts',
  'grokModel',
  'baseResumeSummaries',
  'claudeExtendedThinking',
  'claudeEffort',
  'dashboardUrl',
  'seerContext',
  'systemPrompts',
  'promptIds',
];

/** The legacy keys present in a storage snapshot. */
export function legacyKeysIn(stored: Record<string, unknown>): string[] {
  return LEGACY_STORAGE_KEYS.filter((key) => key in stored);
}
