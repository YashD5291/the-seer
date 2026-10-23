import { afterAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_FIX,
  ConfigError,
  configPathFor,
  findClaude,
  findTectonic,
  findTemplate,
  loadConfig,
  requireOutputBase,
  requireProfileDir,
  requireTemplate,
  resolveTectonicPath,
  saveConfig,
  TECTONIC_NOT_FOUND,
  updateConfig,
  withDefaultFolders,
} from './config';
import { ProfileError, SetupError } from './setup-error';

const tempDir = mkdtempSync(join(tmpdir(), 'seer-config-'));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

function errorFrom(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected the call to throw');
}

describe('loadConfig / saveConfig', () => {
  it('round-trips every field, creating the folder', () => {
    const path = join(tempDir, 'nested', 'config.json');
    const config = { outputDir: '/out', profileDir: '/profile', claudePath: '/bin/claude' };
    saveConfig(path, config);
    expect(loadConfig(path)).toEqual(config);
  });

  it('returns an empty config when the file does not exist', () => {
    expect(loadConfig(join(tempDir, 'missing.json'))).toEqual({});
  });

  it('drops keys it does not know', () => {
    const path = join(tempDir, 'extra.json');
    writeFileSync(path, JSON.stringify({ outputDir: '/out', theme: 'dark' }));
    expect(loadConfig(path)).toEqual({ outputDir: '/out' });
  });

  it('rejects a file that is not JSON, naming the file', () => {
    const path = join(tempDir, 'broken.json');
    writeFileSync(path, '{ "outputDir": ');
    expect(errorFrom(() => loadConfig(path)).message).toContain(path);
  });

  it('rejects JSON that is not an object', () => {
    const path = join(tempDir, 'array.json');
    writeFileSync(path, '["/out"]');
    expect(errorFrom(() => loadConfig(path)).message).toContain(path);
  });

  it('rejects a known field that is not a string', () => {
    const path = join(tempDir, 'number.json');
    writeFileSync(path, JSON.stringify({ profileDir: 42 }));
    expect(errorFrom(() => loadConfig(path)).message).toContain('profileDir');
  });

  it('throws a ConfigError, a setup problem, for every broken file', () => {
    const files = { 'bad-json.json': '{', 'not-object.json': '7', 'bad-field.json': '{"outputDir": false}' };
    for (const [name, content] of Object.entries(files)) {
      const path = join(tempDir, name);
      writeFileSync(path, content);
      const error = errorFrom(() => loadConfig(path));
      expect(error).toBeInstanceOf(ConfigError);
      expect(error).toBeInstanceOf(SetupError);
    }
  });

  it('says how to fix a broken file: the installer leaves config.json alone', () => {
    expect(CONFIG_FIX).toBe('Fix or delete ~/.theseer/config.json, then re-run the install command');
  });
});

describe('findClaude', () => {
  const home = '/Users/a';
  const everywhere = new Set([
    '/opt/claude',
    '/Users/a/.local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/Users/a/.npm-global/bin/claude',
    '/Users/a/.claude/local/claude',
  ]);

  function existing(...paths: string[]): (path: string) => boolean {
    const present = new Set(paths);
    return (path) => present.has(path);
  }

  it('prefers the configured path when it exists', () => {
    expect(findClaude({ claudePath: '/opt/claude' }, home, existing(...everywhere))).toBe('/opt/claude');
  });

  it('skips a configured path that no longer exists', () => {
    const exists = existing('/Users/a/.local/bin/claude');
    expect(findClaude({ claudePath: '/opt/claude' }, home, exists)).toBe('/Users/a/.local/bin/claude');
  });

  it('looks in the usual install places, in order', () => {
    const places = [
      '/Users/a/.local/bin/claude',
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      '/Users/a/.npm-global/bin/claude',
      '/Users/a/.claude/local/claude',
    ];
    for (const [index, place] of places.entries()) {
      expect(findClaude({}, home, existing(...places.slice(index)))).toBe(place);
    }
  });

  it('returns null when claude is nowhere', () => {
    expect(findClaude({ claudePath: '/opt/claude' }, home, existing())).toBeNull();
  });

  it('checks the real file system by default', () => {
    const fakeHome = mkdtempSync(join(tempDir, 'home-'));
    mkdirSync(join(fakeHome, '.local', 'bin'), { recursive: true });
    writeFileSync(join(fakeHome, '.local', 'bin', 'claude'), '#!/bin/sh\n');
    expect(findClaude({}, fakeHome)).toBe(join(fakeHome, '.local', 'bin', 'claude'));
  });
});

describe('withDefaultFolders', () => {
  it('fills the two folders under ~/TheSeer', () => {
    expect(withDefaultFolders({}, '/Users/a')).toEqual({
      profileDir: '/Users/a/TheSeer/My files',
      outputDir: '/Users/a/TheSeer/Resumes',
    });
  });

  it('keeps folders that are already set, and the other settings', () => {
    const config = { profileDir: '/docs', outputDir: '/out', claudePath: '/bin/claude' };
    expect(withDefaultFolders(config, '/Users/a')).toEqual(config);
  });

  it('fills only the folder that is missing', () => {
    expect(withDefaultFolders({ outputDir: '/out' }, '/Users/a')).toEqual({
      profileDir: '/Users/a/TheSeer/My files',
      outputDir: '/out',
    });
  });
});

describe('requireOutputBase', () => {
  it('returns the folder', () => {
    expect(requireOutputBase('/out')).toBe('/out');
  });

  it('throws a SetupError when no output folder is configured', () => {
    const error = errorFrom(() => requireOutputBase(''));
    expect(error).toBeInstanceOf(SetupError);
    expect(error.message).toBe("Save folder not set — choose one on The Seer's setup page, or re-run the install command");
  });
});

describe('requireProfileDir', () => {
  it('returns the configured folder', () => {
    expect(requireProfileDir({ profileDir: '/profile' })).toBe('/profile');
  });

  it('throws a ProfileError pointing at the install command when none is set', () => {
    const error = errorFrom(() => requireProfileDir({}));
    expect(error).toBeInstanceOf(ProfileError);
    expect(error.message).toBe("My files folder not set — re-run the install command from The Seer's setup page");
  });
});

describe('findTectonic', () => {
  const nowhere = (): string | null => null;

  function bundledBase(): string {
    const base = mkdtempSync(join(tempDir, 'base-'));
    mkdirSync(join(base, 'bin'));
    writeFileSync(join(base, 'bin', 'tectonic'), '#!/bin/sh\n');
    chmodSync(join(base, 'bin', 'tectonic'), 0o755);
    return base;
  }

  it('prefers THESEER_TECTONIC, made absolute', () => {
    const path = findTectonic({ THESEER_TECTONIC: 'tools/tectonic' }, bundledBase(), nowhere);
    expect(path).toBe(join(process.cwd(), 'tools/tectonic'));
  });

  it('uses the tectonic bundled in <base>/bin next', () => {
    const base = bundledBase();
    expect(findTectonic({}, base, () => '/usr/bin/tectonic')).toBe(join(base, 'bin', 'tectonic'));
  });

  it('searches Homebrew before the inherited PATH', () => {
    const searched: string[] = [];
    const which = (command: string, searchPath: string): string | null => {
      searched.push(`${command}@${searchPath}`);
      return '/opt/homebrew/bin/tectonic';
    };
    const path = findTectonic({ PATH: '/usr/bin' }, join(tempDir, 'no-base'), which);
    expect(path).toBe('/opt/homebrew/bin/tectonic');
    expect(searched).toEqual(['tectonic@/opt/homebrew/bin:/usr/local/bin:/usr/bin']);
  });

  it('returns null when tectonic is nowhere', () => {
    expect(findTectonic({}, join(tempDir, 'no-base'), nowhere)).toBeNull();
  });
});

describe('resolveTectonicPath', () => {
  it('returns the tectonic it finds', () => {
    expect(resolveTectonicPath({}, join(tempDir, 'no-base'), () => '/opt/homebrew/bin/tectonic')).toBe(
      '/opt/homebrew/bin/tectonic',
    );
  });

  it('throws a SetupError with the install hint when tectonic is nowhere', () => {
    const error = errorFrom(() => resolveTectonicPath({}, join(tempDir, 'no-base'), () => null));
    expect(error).toBeInstanceOf(SetupError);
    expect(error.message).toBe(TECTONIC_NOT_FOUND);
    expect(TECTONIC_NOT_FOUND).toBe('PDF builder (tectonic) not found — re-run the install command');
  });
});

describe('configPathFor', () => {
  it('is config.json in the install root under the home folder', () => {
    expect(configPathFor('/Users/alex')).toBe('/Users/alex/.theseer/config.json');
  });
});

describe('updateConfig', () => {
  it('changes the given fields and keeps the others', () => {
    const path = join(tempDir, 'update', 'config.json');
    saveConfig(path, { outputDir: '/out', claudePath: '/bin/claude' });

    updateConfig(path, { outputDir: '/new-out', profileDir: '/profile' });

    expect(loadConfig(path)).toEqual({ outputDir: '/new-out', profileDir: '/profile', claudePath: '/bin/claude' });
  });

  it('creates the file when there is none', () => {
    const path = join(tempDir, 'update-new', 'config.json');

    updateConfig(path, { profileDir: '/profile' });

    expect(loadConfig(path)).toEqual({ profileDir: '/profile' });
  });
});

describe('findTemplate / requireTemplate', () => {
  it('answers with the template when it is there', () => {
    const path = join(tempDir, 'template.tex');
    writeFileSync(path, '\\documentclass{article}');

    expect(findTemplate(path)).toBe(path);
    expect(requireTemplate(path)).toBe(path);
  });

  it('finds no template that is missing', () => {
    expect(findTemplate(join(tempDir, 'missing.tex'))).toBeNull();
  });

  it('rejects a missing template with a SetupError pointing at the install command', () => {
    const path = join(tempDir, 'missing.tex');

    const error = errorFrom(() => requireTemplate(path));

    expect(error).toBeInstanceOf(SetupError);
    expect(error.message).toBe(`Template not found: ${path} — re-run the install command`);
  });
});
