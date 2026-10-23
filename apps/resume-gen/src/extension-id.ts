import { createHash } from 'node:crypto';
import manifest from '../../extension/manifest.json' with { type: 'json' };

const HEX_DIGITS = '0123456789abcdef';
const ID_LETTERS = 'abcdefghijklmnop';

// Chrome's rule: SHA-256 of the DER public key, first 16 bytes as 32 hex digits, each digit 0-f written as a-p.
export function extensionIdFromKey(keyBase64: string): string {
  const der = Buffer.from(keyBase64, 'base64');
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex].map((digit) => ID_LETTERS[HEX_DIGITS.indexOf(digit)]).join('');
}

// The id Chrome gives the extension, from the manifest `key` in `apps/extension/manifest.json`.
export const EXTENSION_ID = extensionIdFromKey(manifest.key);
