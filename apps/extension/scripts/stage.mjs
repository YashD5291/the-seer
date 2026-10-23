// Copies the built extension into a folder that Chrome can load unpacked:
//
//   node scripts/stage.mjs <dir>
//
// Run it after `node build.mjs`. It copies only what the extension needs at run time (no sources,
// tests or node_modules) and exits non-zero, naming the first missing file, so a release is never
// packed from a half-built extension.
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Files the manifest and the three extension pages load, relative to the extension folder.
const REQUIRED_FILES = [
  'manifest.json',
  'popup.html',
  'setup.html',
  'editor.html',
  'content.css',
  'dist/background.js',
  'dist/content.js',
  'dist/popup.js',
  'dist/setup.js',
  'dist/editor.js',
  'dist/tailwind.css',
];

function fail(message) {
  console.error(`stage.mjs: ${message}`);
  process.exit(1);
}

function firstMissing() {
  const missing = REQUIRED_FILES.find((file) => !existsSync(join(EXTENSION_DIR, file)));
  if (missing) return missing;
  return iconFiles().length === 0 ? 'icons/*.png' : null;
}

function iconFiles() {
  const iconsDir = join(EXTENSION_DIR, 'icons');
  if (!existsSync(iconsDir)) return [];
  return readdirSync(iconsDir).filter((name) => name.endsWith('.png'));
}

function copyInto(targetDir) {
  mkdirSync(join(targetDir, 'icons'), { recursive: true });
  for (const file of REQUIRED_FILES.filter((name) => !name.startsWith('dist/'))) {
    cpSync(join(EXTENSION_DIR, file), join(targetDir, file));
  }
  for (const icon of iconFiles()) {
    cpSync(join(EXTENSION_DIR, 'icons', icon), join(targetDir, 'icons', icon));
  }
  cpSync(join(EXTENSION_DIR, 'dist'), join(targetDir, 'dist'), { recursive: true });
}

function main() {
  const targetArg = process.argv[2];
  if (!targetArg) fail('usage: node scripts/stage.mjs <dir>');
  const targetDir = resolve(targetArg);

  const missing = firstMissing();
  if (missing) fail(`missing ${missing} — build the extension first (cd apps/extension && node build.mjs)`);
  if (existsSync(targetDir) && !statSync(targetDir).isDirectory()) fail(`${targetDir} is not a folder`);

  copyInto(targetDir);
  console.log(`Staged the extension in ${targetDir}`);
}

main();
