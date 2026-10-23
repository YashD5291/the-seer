import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isRecord, type JsonObject } from './json-validation';
import { ProfileError, SetupError } from './setup-error';

// The host's settings file, ~/.theseer/config.json.
export interface SeerConfig {
  outputDir?: string;
  profileDir?: string;
  claudePath?: string;
}

type ConfigWithFolders = SeerConfig & { profileDir: string; outputDir: string };

// Everything the host resolves at start-up; the parts that can be missing are checked where used.
export interface HostContext {
  config: SeerConfig;
  outputBase: string; // '' when no output folder is configured
  templatePath: string;
  baseDir: string; // the install root, where a bundled bin/tectonic may live
  home: string;
  env: NodeJS.ProcessEnv;
}

type Which = (command: string, searchPath: string) => string | null;

const CONFIG_KEYS = ['outputDir', 'profileDir', 'claudePath'] as const;
// Chrome starts the host with a minimal PATH, so Homebrew's folders are searched first.
const TECTONIC_SEARCH_PREFIX = '/opt/homebrew/bin:/usr/local/bin:';
// Where Claude Code's installer, Homebrew and npm put it; a relative place is under HOME.
const CLAUDE_PLACES = [
  join('.local', 'bin', 'claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  join('.npm-global', 'bin', 'claude'),
  join('.claude', 'local', 'claude'),
];
const DEFAULT_FOLDERS_ROOT = 'TheSeer';
const DEFAULT_PROFILE_FOLDER = 'My files';
const DEFAULT_OUTPUT_FOLDER = 'Resumes';

// The installer never rewrites config.json, so re-running it alone cannot fix a broken one.
export const CONFIG_FIX = 'Fix or delete ~/.theseer/config.json, then re-run the install command';
export const TECTONIC_NOT_FOUND = 'PDF builder (tectonic) not found — re-run the install command';
export const PROFILE_NOT_SET = "My files folder not set — re-run the install command from The Seer's setup page";
const OUTPUT_NOT_SET = "Save folder not set — choose one on The Seer's setup page, or re-run the install command";

// config.json cannot be used; the user fixes it by hand (see CONFIG_FIX).
export class ConfigError extends SetupError {}

export function loadConfig(path: string): SeerConfig {
  if (!existsSync(path)) return {};
  const parsed = parseConfigJson(path);
  const config: SeerConfig = {};
  for (const key of CONFIG_KEYS) {
    const value = parsed[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new ConfigError(`${key} in ${path} must be a string`);
    config[key] = value;
  }
  return config;
}

function parseConfigJson(path: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ConfigError(`Config file is not valid JSON: ${path} (${error.message})`);
  }
  if (!isRecord(value)) throw new ConfigError(`Config file must hold a JSON object: ${path}`);
  return value;
}

export function saveConfig(path: string, config: SeerConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

// config.json lives in the install root, ~/.theseer; `home` says whose.
export function configPathFor(home: string): string {
  return join(home, '.theseer', 'config.json');
}

// Saves `patch` over what config.json holds; the fields it leaves out keep their value.
export function updateConfig(path: string, patch: SeerConfig): void {
  saveConfig(path, { ...loadConfig(path), ...patch });
}

// The configured claude if it still exists, else the first usual install place that has one.
export function findClaude(
  config: SeerConfig,
  home: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const places = CLAUDE_PLACES.map((place) => resolve(home, place));
  const candidates = config.claudePath ? [config.claudePath, ...places] : places;
  return candidates.find(exists) ?? null;
}

// Folders the user has not chosen go under ~/TheSeer.
export function withDefaultFolders(config: SeerConfig, home: string): ConfigWithFolders {
  return {
    ...config,
    profileDir: config.profileDir || join(home, DEFAULT_FOLDERS_ROOT, DEFAULT_PROFILE_FOLDER),
    outputDir: config.outputDir || join(home, DEFAULT_FOLDERS_ROOT, DEFAULT_OUTPUT_FOLDER),
  };
}

export function requireProfileDir(config: SeerConfig): string {
  if (!config.profileDir) throw new ProfileError(PROFILE_NOT_SET);
  return config.profileDir;
}

export function requireOutputBase(outputBase: string): string {
  if (outputBase === '') throw new SetupError(OUTPUT_NOT_SET);
  return outputBase;
}

// The resume template, or null when it is missing.
export function findTemplate(templatePath: string): string | null {
  return existsSync(templatePath) ? templatePath : null;
}

export function requireTemplate(templatePath: string): string {
  const found = findTemplate(templatePath);
  if (found === null) throw new SetupError(`Template not found: ${templatePath} — re-run the install command`);
  return found;
}

// Order: THESEER_TECTONIC, a tectonic bundled in <base>/bin, then Homebrew and the inherited PATH.
// Always absolute, because the host's PATH under Chrome is minimal.
export function findTectonic(env: NodeJS.ProcessEnv, baseDir: string, which: Which = bunWhich): string | null {
  if (env.THESEER_TECTONIC) return resolve(env.THESEER_TECTONIC);
  const bundled = join(baseDir, 'bin', 'tectonic');
  if (existsSync(bundled)) return bundled;
  const found = which('tectonic', TECTONIC_SEARCH_PREFIX + (env.PATH ?? ''));
  return found ? resolve(found) : null;
}

export function resolveTectonicPath(env: NodeJS.ProcessEnv, baseDir: string, which: Which = bunWhich): string {
  const found = findTectonic(env, baseDir, which);
  if (found === null) throw new SetupError(TECTONIC_NOT_FOUND);
  return found;
}

function bunWhich(command: string, searchPath: string): string | null {
  return Bun.which(command, { PATH: searchPath });
}
