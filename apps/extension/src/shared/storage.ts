import type { SeerSettings, ScrapedJob } from './types.js';
import {
  normalizeClaudeModel,
  normalizeMaxPages,
  normalizeMinScore,
  normalizeWriterNotes,
} from './settings-normalize.js';

// chrome.storage hands back untyped records at this boundary; each getter narrows the fields it reads.
type StorageRecord = Record<string, any>;

export async function getSettings(): Promise<SeerSettings> {
  const data: StorageRecord = await chrome.storage.local.get(['claudeModel', 'maxPages', 'minScore', 'writerNotes']);
  return {
    claudeModel: normalizeClaudeModel(data.claudeModel),
    maxPages: normalizeMaxPages(data.maxPages),
    minScore: normalizeMinScore(data.minScore),
    writerNotes: normalizeWriterNotes(data.writerNotes),
  };
}

/** Saves only the settings given; the others keep their stored value. */
export async function saveSettings(partial: Partial<SeerSettings>): Promise<void> {
  await chrome.storage.local.set(partial);
}

// ─── Per-tab job storage ──────────────────────────────────────────────

export async function saveJobForTab(tabId: number, job: ScrapedJob): Promise<void> {
  const data: StorageRecord = await chrome.storage.local.get('tabJobs');
  const tabJobs: Record<string, ScrapedJob> = data.tabJobs || {};
  tabJobs[String(tabId)] = job;
  await chrome.storage.local.set({ tabJobs });
}

export async function getJobForTab(tabId: number): Promise<ScrapedJob | null> {
  const data: StorageRecord = await chrome.storage.local.get('tabJobs');
  const tabJobs: Record<string, ScrapedJob> = data.tabJobs || {};
  return tabJobs[String(tabId)] || null;
}

export async function removeJobForTab(tabId: number): Promise<void> {
  const data: StorageRecord = await chrome.storage.local.get('tabJobs');
  const tabJobs: Record<string, ScrapedJob> = data.tabJobs || {};
  delete tabJobs[String(tabId)];
  await chrome.storage.local.set({ tabJobs });
}

export async function getEnabled(): Promise<boolean> {
  const data: StorageRecord = await chrome.storage.local.get('seerEnabled');
  return data.seerEnabled !== false; // default on
}

export async function setEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ seerEnabled: enabled });
}
