import { describe, expect, it } from 'bun:test';
import manifest from '../../extension/manifest.json' with { type: 'json' };
import { EXTENSION_ID, extensionIdFromKey } from './extension-id';
import { HELPER_VERSION } from './version';

// A second, unrelated public key (DER, base64) to prove the id depends on the key.
const OTHER_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwT2j7IbxDtDAoJv6EMP1uTHQ30D/A8kaIlnWIpno7lmZo6Z4JjNiUMma6alsc5hWpMvxVX9ObA4TLUaMJyT8vQYNqRQMx/+rUp40oFL/xB/CZVgvaO1NBXgUsSFt4440kbWhbwwj+Fec0Epw5ROv77X4eZr4bsKhJBIvR9KbCru9IWCSpvfvtrDmQG9YekIAJHVzKLmoHL14L4yy6Q+LLkTrVPdQyNdSXV2829YGyyQW6JTa0kNa9+sEFmY+m3QgYhq1ddTrMnjRdvaS8TBfFvNICc1f7xxSvIn1HBaL5aUmluNcyk1/6HlnIu7uIb2+jJ56fH3Y96LnLY3f+9h++QIDAQAB';

describe('extension id', () => {
  it('EXTENSION_ID is the id Chrome derives from the manifest key', () => {
    expect(extensionIdFromKey(manifest.key)).toBe(EXTENSION_ID);
  });

  // A changed manifest key changes the id Chrome gives the extension; this makes that change visible.
  it('is the published extension id', () => {
    expect(EXTENSION_ID).toBe('ejgkmkoeecllnelmkcdhkbifakmkbkkf');
  });

  it('is 32 characters from a to p', () => {
    expect(EXTENSION_ID).toMatch(/^[a-p]{32}$/);
  });

  it('gives a different id for a different key', () => {
    expect(extensionIdFromKey(OTHER_KEY)).not.toBe(EXTENSION_ID);
    expect(extensionIdFromKey(OTHER_KEY)).toMatch(/^[a-p]{32}$/);
  });
});

describe('helper version', () => {
  it('is the extension manifest version', () => {
    expect(HELPER_VERSION).toBe(manifest.version);
  });
});
