import manifest from '../../extension/manifest.json' with { type: 'json' };

// The extension manifest is the single version source; the helper reports the same number.
export const HELPER_VERSION: string = manifest.version;
