/**
 * The GitHub `owner/repo` The Seer's releases come from. esbuild replaces `__SEER_REPO__` at build
 * time; tests run without that define, where `typeof` on the undeclared global is still safe.
 */
export const SEER_REPO: string = typeof __SEER_REPO__ === 'string' ? __SEER_REPO__ : 'OWNER/REPO';
