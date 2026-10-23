import * as esbuild from 'esbuild';
import { execSync } from 'node:child_process';

const isWatch = process.argv.includes('--watch');

// ── Tailwind CSS ──────────────────────────────────────────────────────
const twFlags = isWatch ? '' : '--minify';
execSync(
  `npx @tailwindcss/cli -i src/styles/input.css -o dist/tailwind.css ${twFlags}`,
  { stdio: 'inherit' },
);

// ── esbuild ───────────────────────────────────────────────────────────
const commonOptions = {
  bundle: true,
  sourcemap: true,
  target: 'es2022',
  format: 'esm',
  logLevel: 'info',
  // The GitHub owner/repo the setup page's install command downloads from (read in src/shared/repo.ts).
  define: { __SEER_REPO__: JSON.stringify(process.env.SEER_REPO ?? 'OWNER/REPO') },
};

const entries = [
  {
    entryPoints: ['src/background/index.ts'],
    outfile: 'dist/background.js',
  },
  {
    entryPoints: ['src/content/index.ts'],
    outfile: 'dist/content.js',
    // Content scripts can't use ESM in Chrome, must be IIFE
    format: 'iife',
  },
  {
    entryPoints: ['src/popup/index.ts'],
    outfile: 'dist/popup.js',
  },
  {
    entryPoints: ['src/setup/index.ts'],
    outfile: 'dist/setup.js',
  },
  {
    entryPoints: ['src/editor/index.ts'],
    outfile: 'dist/editor.js',
  },
];

async function build() {
  for (const entry of entries) {
    const options = {
      ...commonOptions,
      ...entry,
      format: entry.format || commonOptions.format,
    };

    if (isWatch) {
      const ctx = await esbuild.context(options);
      await ctx.watch();
    } else {
      await esbuild.build(options);
    }
  }

  if (!isWatch) {
    console.log('Build complete.');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
