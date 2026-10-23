import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CLAUDE_NOT_INSTALLED } from './claude-runner';
import { CompileError, compileLatex } from './compile';
import {
  findClaude,
  findTectonic,
  findTemplate,
  loadConfig,
  saveConfig,
  TECTONIC_NOT_FOUND,
  withDefaultFolders,
} from './config';
import { EXTENSION_ID } from './extension-id';
import { readPreamble, renderResumeLatex } from './latex';
import { SAMPLE_DOC } from './sample-doc';
import { withTempDir } from './temp-dir';

export const HOST_NAME = 'com.theseer.resumegen';

const HOST_DESCRIPTION = 'The Seer - Resume PDF Generator';
const WRAPPER_NAME = 'theseer-native-host.sh';
const WARM_UP_PREFIX = 'theseer-warmup-';
const SETUP_FINISHED = 'Setup finished.';
const SETUP_FINISHED_WITH_GAPS = "Setup finished — open The Seer's setup page to finish.";

type PdfParts = { templatePath: string; tectonicPath: string };

export interface SetupParams {
  seerDir: string; // the install root, ~/.theseer
  home: string;
  configPath: string;
  env: NodeJS.ProcessEnv;
  warmUp: boolean; // compile the sample resume once, which downloads the PDF builder's TeX files
  log: (line: string) => void;
}

export function chromeHostManifestPath(home: string): string {
  return join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', `${HOST_NAME}.json`);
}

// Chrome starts the wrapper, and the wrapper starts the helper: a manifest cannot pass arguments.
export function registerNativeHost(p: {
  seerDir: string;
  home: string;
  extensionId: string;
}): { wrapperPath: string; manifestPath: string } {
  const binDir = join(p.seerDir, 'bin');
  const wrapperPath = join(binDir, WRAPPER_NAME);
  mkdirSync(binDir, { recursive: true });
  writeFileSync(wrapperPath, `#!/bin/bash\nexec "${join(binDir, 'theseer-pdf')}" --native-host\n`);
  chmodSync(wrapperPath, 0o755);

  const manifestPath = chromeHostManifestPath(p.home);
  const manifest = {
    name: HOST_NAME,
    description: HOST_DESCRIPTION,
    path: wrapperPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${p.extensionId}/`],
  };
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { wrapperPath, manifestPath };
}

// Registers the helper with Chrome, records where Claude Code is, creates the default folders and
// warms up the PDF builder. Claude Code, the template or the PDF builder being absent is reported, not
// thrown: the last line sends the user to the setup page, which says how to add them.
export async function runSetup(p: SetupParams): Promise<void> {
  const { manifestPath } = registerNativeHost({ seerDir: p.seerDir, home: p.home, extensionId: EXTENSION_ID });
  p.log(`Helper registered with Chrome: ${manifestPath}`);

  const config = loadConfig(p.configPath);
  const claudePath = claudeOnPath(p.env) ?? findClaude(config, p.home);
  const settings = withDefaultFolders(claudePath === null ? config : { ...config, claudePath }, p.home);
  mkdirSync(settings.profileDir, { recursive: true });
  mkdirSync(settings.outputDir, { recursive: true });
  saveConfig(p.configPath, settings);

  p.log(claudePath === null ? CLAUDE_NOT_INSTALLED : `Claude Code: ${claudePath}`);
  p.log(`My files folder: ${settings.profileDir}`);
  p.log(`Resumes folder: ${settings.outputDir}`);
  const pdfParts = findPdfParts(p);
  if (pdfParts !== null && p.warmUp) await warmUpPdfBuilder(p, pdfParts);
  p.log(claudePath !== null && pdfParts !== null ? SETUP_FINISHED : SETUP_FINISHED_WITH_GAPS);
}

// The shell the user ran setup from finds the claude they use; Bun.which can return a relative path.
function claudeOnPath(env: NodeJS.ProcessEnv): string | null {
  const found = Bun.which('claude', { PATH: env.PATH ?? '' });
  return found === null ? null : resolve(found);
}

// The template and the PDF builder; null, after saying which one is missing, when either is.
function findPdfParts(p: SetupParams): PdfParts | null {
  const expected = join(p.seerDir, 'templates', 'default.tex');
  const templatePath = findTemplate(expected);
  if (templatePath === null) {
    p.log(`Resume template not found at ${expected} — re-run the install command`);
    return null;
  }
  const tectonicPath = findTectonic(p.env, p.seerDir);
  if (tectonicPath === null) {
    p.log(TECTONIC_NOT_FOUND);
    return null;
  }
  return { templatePath, tectonicPath };
}

async function warmUpPdfBuilder(p: SetupParams, { templatePath, tectonicPath }: PdfParts): Promise<void> {
  p.log('Warming up the PDF builder — the first run downloads TeX files and may take a minute or two…');
  const latex = renderResumeLatex(SAMPLE_DOC, readPreamble(templatePath));
  try {
    await withTempDir(WARM_UP_PREFIX, (workDir) => compileLatex(latex, { tectonicPath, workDir }));
    p.log('PDF builder ready');
  } catch (error) {
    if (!(error instanceof CompileError)) throw error;
    p.log(
      `PDF builder warm-up failed: ${error.message} — it will try again with your first resume,` +
        ' which may take a few minutes',
    );
    if (error.excerpt !== error.message) p.log(error.excerpt);
  }
}
