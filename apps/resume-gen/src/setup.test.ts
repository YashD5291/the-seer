import { afterAll, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_NOT_INSTALLED } from './claude-runner';
import { loadConfig, saveConfig } from './config';
import { EXTENSION_ID } from './extension-id';
import { readPreamble, renderResumeLatex } from './latex';
import { validateResumeDoc } from './resume-doc';
import { SAMPLE_DOC } from './sample-doc';
import { chromeHostManifestPath, HOST_NAME, registerNativeHost, runSetup } from './setup';
import { onePageTectonic, REAL_TEMPLATE } from './test-fixtures';

const tempDir = mkdtempSync(join(tmpdir(), 'seer-setup-'));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

type Sandbox = { root: string; home: string; seerDir: string; configPath: string; binDir: string };

// Every path a setup run touches lives under one temp folder; nothing reaches the real HOME.
function sandbox(): Sandbox {
  const root = mkdtempSync(join(tempDir, 'case-'));
  const binDir = join(root, 'path-bin');
  mkdirSync(binDir);
  return {
    root,
    home: join(root, 'home'),
    seerDir: join(root, 'home', '.theseer'),
    configPath: join(root, 'home', '.theseer', 'config.json'),
    binDir,
  };
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function fakeClaude(dir: string): string {
  const path = join(dir, 'claude');
  writeExecutable(path, 'exit 0');
  return path;
}

async function setUp(box: Sandbox, overrides: { env?: NodeJS.ProcessEnv; warmUp?: boolean } = {}): Promise<string[]> {
  const lines: string[] = [];
  await runSetup({
    seerDir: box.seerDir,
    home: box.home,
    configPath: box.configPath,
    env: overrides.env ?? { PATH: box.binDir },
    warmUp: overrides.warmUp ?? false,
    log: (line) => lines.push(line),
  });
  return lines;
}

function withTemplate(box: Sandbox): void {
  mkdirSync(join(box.seerDir, 'templates'), { recursive: true });
  copyFileSync(REAL_TEMPLATE, join(box.seerDir, 'templates', 'default.tex'));
}

const FINISHED = 'Setup finished.';

// findClaude also looks in the machine's own /opt/homebrew/bin and /usr/local/bin.
function claudeOnThisMachine(): boolean {
  return ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'].some(existsSync);
}
const FINISHED_WITH_GAPS = "Setup finished — open The Seer's setup page to finish.";

describe('chromeHostManifestPath', () => {
  it("is Chrome's NativeMessagingHosts folder under the given home", () => {
    expect(HOST_NAME).toBe('com.theseer.resumegen');
    expect(chromeHostManifestPath('/Users/a')).toBe(
      '/Users/a/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.theseer.resumegen.json',
    );
  });
});

describe('registerNativeHost', () => {
  function register(box: Sandbox): { wrapperPath: string; manifestPath: string } {
    return registerNativeHost({ seerDir: box.seerDir, home: box.home, extensionId: EXTENSION_ID });
  }

  it("writes Chrome's manifest for the fixed extension id, pointing at the wrapper", () => {
    const box = sandbox();

    const { wrapperPath, manifestPath } = register(box);

    expect(manifestPath).toBe(chromeHostManifestPath(box.home));
    expect(JSON.parse(readFileSync(manifestPath, 'utf-8'))).toEqual({
      name: 'com.theseer.resumegen',
      description: 'The Seer - Resume PDF Generator',
      path: wrapperPath,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    });
  });

  it('writes an executable wrapper that starts the helper in native-host mode, even from a folder with spaces', () => {
    const box = sandbox();
    const spaced = { ...box, seerDir: join(box.root, 'my seer dir') };
    const { wrapperPath } = register(spaced);
    writeExecutable(join(spaced.seerDir, 'bin', 'theseer-pdf'), 'echo "called with: $@"');

    expect(statSync(wrapperPath).mode & 0o111).not.toBe(0);
    const run = Bun.spawnSync([wrapperPath]);
    expect(run.stdout.toString()).toBe('called with: --native-host\n');
    expect(readFileSync(wrapperPath, 'utf-8')).toContain(`"${spaced.seerDir}/bin/theseer-pdf" --native-host`);
  });

  it('can run again over its own files', () => {
    const box = sandbox();
    register(box);

    const second = register(box);

    expect(existsSync(second.manifestPath)).toBe(true);
    expect(existsSync(second.wrapperPath)).toBe(true);
  });
});

describe('runSetup', () => {
  it('registers the helper, records the claude on PATH and creates the default folders', async () => {
    const box = sandbox();
    const claude = fakeClaude(box.binDir);

    await setUp(box);

    expect(existsSync(chromeHostManifestPath(box.home))).toBe(true);
    const config = loadConfig(box.configPath);
    expect(config).toEqual({
      claudePath: claude,
      profileDir: join(box.home, 'TheSeer', 'My files'),
      outputDir: join(box.home, 'TheSeer', 'Resumes'),
    });
    expect(statSync(join(box.home, 'TheSeer', 'My files')).isDirectory()).toBe(true);
    expect(statSync(join(box.home, 'TheSeer', 'Resumes')).isDirectory()).toBe(true);
  });

  it('keeps folders the user already chose, and creates them if they are gone', async () => {
    const box = sandbox();
    fakeClaude(box.binDir);
    const outputDir = join(box.root, 'elsewhere', 'My resumes');
    saveConfig(box.configPath, { outputDir });

    await setUp(box);

    expect(loadConfig(box.configPath).outputDir).toBe(outputDir);
    expect(statSync(outputDir).isDirectory()).toBe(true);
    expect(loadConfig(box.configPath).profileDir).toBe(join(box.home, 'TheSeer', 'My files'));
  });

  it('keeps a hand-set outputDir on a second run', async () => {
    const box = sandbox();
    fakeClaude(box.binDir);
    await setUp(box);
    const outputDir = join(box.root, 'hand-set');
    saveConfig(box.configPath, { ...loadConfig(box.configPath), outputDir });

    await setUp(box);

    expect(loadConfig(box.configPath).outputDir).toBe(outputDir);
  });

  it('prefers the claude on PATH over an older recorded one', async () => {
    const box = sandbox();
    const claude = fakeClaude(box.binDir);
    saveConfig(box.configPath, { claudePath: join(box.root, 'old', 'claude') });

    await setUp(box);

    expect(loadConfig(box.configPath).claudePath).toBe(claude);
  });

  it('falls back to a usual install place when claude is not on PATH', async () => {
    const box = sandbox();
    mkdirSync(join(box.home, '.local', 'bin'), { recursive: true });
    const claude = fakeClaude(join(box.home, '.local', 'bin'));

    await setUp(box);

    expect(loadConfig(box.configPath).claudePath).toBe(claude);
  });

  it.skipIf(claudeOnThisMachine())('finishes and says so when Claude Code is not installed', async () => {
    const box = sandbox();

    const lines = await setUp(box);

    expect(loadConfig(box.configPath).claudePath).toBeUndefined();
    expect(lines.join('\n')).toContain(CLAUDE_NOT_INSTALLED);
    expect(existsSync(chromeHostManifestPath(box.home))).toBe(true);
  });

  it('reports what it set', async () => {
    const box = sandbox();
    const claude = fakeClaude(box.binDir);

    const text = (await setUp(box)).join('\n');

    expect(text).toContain(chromeHostManifestPath(box.home));
    expect(text).toContain(claude);
    expect(text).toContain(join(box.home, 'TheSeer', 'My files'));
    expect(text).toContain(join(box.home, 'TheSeer', 'Resumes'));
  });

  it('does not touch the PDF builder when warm-up is off', async () => {
    const box = sandbox();
    fakeClaude(box.binDir);
    const tectonic = onePageTectonic(box.binDir);

    await setUp(box, { env: { PATH: box.binDir, THESEER_TECTONIC: tectonic.path } });

    expect(tectonic.started()).toBe(false);
  });
});

describe('runSetup: the last line', () => {
  it('says setup finished when Claude Code, the template and the PDF builder are all there', async () => {
    const box = sandbox();
    fakeClaude(box.binDir);
    withTemplate(box);
    const tectonic = onePageTectonic(box.binDir);

    const lines = await setUp(box, { env: { PATH: box.binDir, THESEER_TECTONIC: tectonic.path } });

    expect(lines.at(-1)).toBe(FINISHED);
  });

  it.skipIf(claudeOnThisMachine())('points at the setup page when Claude Code is missing', async () => {
    const box = sandbox();
    withTemplate(box);
    const tectonic = onePageTectonic(box.binDir);

    const lines = await setUp(box, { env: { PATH: box.binDir, THESEER_TECTONIC: tectonic.path } });

    expect(lines.at(-1)).toBe(FINISHED_WITH_GAPS);
  });

  it('points at the setup page, and names the file, when the template is missing', async () => {
    const box = sandbox();
    fakeClaude(box.binDir);
    const tectonic = onePageTectonic(box.binDir);

    const lines = await setUp(box, { env: { PATH: box.binDir, THESEER_TECTONIC: tectonic.path } });

    expect(lines.join('\n')).toContain(join(box.seerDir, 'templates', 'default.tex'));
    expect(lines.at(-1)).toBe(FINISHED_WITH_GAPS);
  });

  // findTectonic also looks in the machine's own /opt/homebrew/bin and /usr/local/bin.
  const tectonicOnThisMachine = ['/opt/homebrew/bin/tectonic', '/usr/local/bin/tectonic'].some(existsSync);

  it.skipIf(tectonicOnThisMachine)('points at the setup page when the PDF builder is missing', async () => {
    const box = sandbox();
    fakeClaude(box.binDir);
    withTemplate(box);

    const lines = await setUp(box, { env: { PATH: box.binDir } });

    expect(lines.join('\n')).toContain('PDF builder (tectonic) not found');
    expect(lines.at(-1)).toBe(FINISHED_WITH_GAPS);
  });
});

// The PDF builder here is a stand-in script, so nothing is downloaded.
describe('runSetup: warming up the PDF builder', () => {
  it('compiles the sample resume once and warns that the first run is slow', async () => {
    const box = sandbox();
    fakeClaude(box.binDir);
    withTemplate(box);
    const tectonic = onePageTectonic(box.binDir);

    const lines = await setUp(box, { warmUp: true, env: { PATH: box.binDir, THESEER_TECTONIC: tectonic.path } });

    expect(tectonic.started()).toBe(true);
    expect(lines.find((line) => line.includes('may take a minute'))).toBeDefined();
    expect(lines).toContain('PDF builder ready');
    expect(lines.at(-1)).toBe(FINISHED);
  });

  it('says what is missing when there is no template, without failing', async () => {
    const box = sandbox();
    fakeClaude(box.binDir);
    const tectonic = onePageTectonic(box.binDir);

    const lines = await setUp(box, { warmUp: true, env: { PATH: box.binDir, THESEER_TECTONIC: tectonic.path } });

    expect(tectonic.started()).toBe(false);
    expect(lines.join('\n')).toContain(join(box.seerDir, 'templates', 'default.tex'));
  });

  it('reports a failed compile and still finishes', async () => {
    const box = sandbox();
    fakeClaude(box.binDir);
    withTemplate(box);
    const broken = join(box.binDir, 'broken-tectonic');
    writeExecutable(broken, 'echo "! Undefined control sequence." > resume.log; exit 1');

    const lines = await setUp(box, { warmUp: true, env: { PATH: box.binDir, THESEER_TECTONIC: broken } });

    expect(lines.join('\n')).toContain('PDF builder warm-up failed');
    expect(lines.join('\n')).toContain('your first resume, which may take a few minutes');
    expect(existsSync(chromeHostManifestPath(box.home))).toBe(true);
  });
});

describe('SAMPLE_DOC', () => {
  it('is a valid resume for Alex Rivera with one job and three bullets', () => {
    expect(validateResumeDoc(SAMPLE_DOC)).toEqual(SAMPLE_DOC);
    expect(SAMPLE_DOC.name).toBe('Alex Rivera');
    expect(SAMPLE_DOC.experience).toHaveLength(1);
    expect(SAMPLE_DOC.experience[0].bullets).toHaveLength(3);
  });

  it('renders with the real template', () => {
    const latex = renderResumeLatex(SAMPLE_DOC, readPreamble(REAL_TEMPLATE));
    expect(latex).toContain('Alex Rivera');
    expect(latex).toContain('\\end{document}');
  });
});
