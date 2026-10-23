import type { ScrapedJob, FitAnalysis, MessageType } from '../shared/types.js';
import { getEnabled, setEnabled, getSettings } from '../shared/storage.js';
import { scorePasses } from '../shared/fit.js';
import { errorMessage } from '../shared/error-message.js';
import { createHelperClient } from '../shared/helper-client.js';
import { escapeHtml } from '../shared/html.js';
import { isReady } from './readiness.js';

const contentEl = document.getElementById('content')!;
const setupButton = document.getElementById('setup-button')!;
const readinessDot = document.getElementById('readiness-dot')!;
const readinessText = document.getElementById('readiness-text')!;
const toggle = document.getElementById('seer-toggle') as HTMLInputElement;

setupButton.addEventListener('click', () => {
  chrome.runtime.openOptionsPage().catch((err: unknown) => {
    console.log(`[Seer] Could not open the setup page: ${errorMessage(err)}`);
  });
});

// ─── Readiness ───────────────────────────────────────────────────────

/** What the helper check found; until it answers, popup.html shows "Checking…". */
type Readiness = 'ready' | 'needs-setup';

const READINESS_TEXT: Record<Readiness, string> = {
  ready: 'Ready',
  'needs-setup': 'Needs setup',
};

const READINESS_DOT: Record<Readiness, string> = {
  ready: 'bg-emerald-500',
  'needs-setup': 'bg-amber-500',
};

function showReadiness(state: Readiness): void {
  readinessText.textContent = READINESS_TEXT[state];
  readinessDot.className = `w-2 h-2 rounded-full ${READINESS_DOT[state]}`;
}

const helper = createHelperClient((host, message) => chrome.runtime.sendNativeMessage(host, message));

/** Asks the helper for its status; a helper that cannot answer means setup is needed. */
async function checkReadiness(): Promise<Readiness> {
  try {
    const status = await helper.status();
    const extensionVersion = chrome.runtime.getManifest().version;
    return isReady({ status, helperError: null, extensionVersion }) ? 'ready' : 'needs-setup';
  } catch (err: unknown) {
    console.log(`[Seer] Helper status check failed: ${errorMessage(err)}`);
    return 'needs-setup';
  }
}

checkReadiness().then(showReadiness);

// ─── Toggle ──────────────────────────────────────────────────────────
getEnabled().then(on => { toggle.checked = on; });

toggle.addEventListener('change', async () => {
  const enabled = toggle.checked;
  await setEnabled(enabled);

  // Notify all tabs so content script can show/hide FAB immediately
  const tabs = await chrome.tabs.query({});
  const msg: MessageType = { type: 'SEER_TOGGLE', enabled };
  for (const tab of tabs) {
    if (tab.id) {
      chrome.tabs.sendMessage(tab.id, msg).catch((err: unknown) => {
        // Tabs without the content script (chrome:// pages, tabs opened before install) have no receiver.
        console.log(`[Seer] Tab ${tab.id} did not take the toggle (no content script): ${errorMessage(err)}`);
      });
    }
  }
});

async function init() {
  // Determine which tab is currently active
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTabId = activeTab?.id;

  if (!activeTabId) return;

  // Fetch job data for the active tab
  const response = await chrome.runtime.sendMessage({ type: 'GET_JOB_FOR_TAB', tabId: activeTabId });

  if (!response?.data) {
    // Show empty state (already in HTML)
    return;
  }

  const data: ScrapedJob = response.data;
  const { minScore } = await getSettings();
  renderJobData(data, minScore);
}

function renderJobData(data: ScrapedJob, minScore: number) {
  const { job, deepAnalysis } = data;

  const score = deepAnalysis?.fit_score ?? 0;
  const pass = deepAnalysis ? scorePasses(deepAnalysis.fit_score, minScore) : false;

  const ringColor = pass ? 'border-emerald-500' : 'border-red-500';
  const scoreColor = pass ? 'text-emerald-600' : 'text-red-500';
  const labelColor = pass ? 'text-emerald-600' : 'text-red-500';

  let html = `
    <div class="text-center pb-4 mb-4 border-b border-zinc-200">
      <div class="inline-flex items-center justify-center w-[72px] h-[72px] rounded-full border-[3px] ${ringColor} mb-2">
        <span class="text-2xl font-bold ${scoreColor}">${score}</span>
      </div>
      <div class="text-sm font-semibold ${labelColor} mb-1">${pass ? 'Good Fit' : 'Weak Fit'}</div>
      <div class="text-xs text-zinc-500">${escapeHtml(job.title)} @ ${escapeHtml(job.company)}</div>
      ${job.location ? `<div class="text-xs text-zinc-400">${escapeHtml(job.location)}</div>` : ''}
      ${job.salary_range ? `<div class="text-xs text-zinc-400">${escapeHtml(job.salary_range)}</div>` : ''}
    </div>
  `;

  if (deepAnalysis && deepAnalysis.key_matches.length > 0) {
    html += `
      <div class="mb-4">
        <h3 class="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">Key Matches (${deepAnalysis.key_matches.length})</h3>
        <div class="flex flex-wrap gap-1">
          ${deepAnalysis.key_matches.map(s => `<span class="text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">${escapeHtml(s)}</span>`).join('')}
        </div>
      </div>
    `;
  }

  if (deepAnalysis) {
    html += renderDeepAnalysis(deepAnalysis);
  }

  contentEl.innerHTML = html;
}

function renderDeepAnalysis(analysis: FitAnalysis): string {
  const recClass: Record<string, string> = {
    strong_yes: 'bg-emerald-50 text-emerald-700',
    yes: 'bg-blue-50 text-blue-700',
    maybe: 'bg-amber-50 text-amber-700',
    no: 'bg-red-50 text-red-700',
  };

  let html = `
    <div class="mb-4">
      <h3 class="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">Deep Analysis</h3>
      <div class="divide-y divide-zinc-100">
        <div class="flex justify-between py-1.5 text-sm">
          <span class="text-zinc-500">Confidence</span>
          <span class="font-semibold text-zinc-800">${analysis.confidence}%</span>
        </div>
        <div class="flex justify-between py-1.5 text-sm">
          <span class="text-zinc-500">Closest file</span>
          <span class="font-semibold text-zinc-800">${escapeHtml(analysis.recommended_base)}</span>
        </div>
        <div class="flex justify-between py-1.5 text-sm">
          <span class="text-zinc-500">Competition</span>
          <span class="font-semibold text-zinc-800">${escapeHtml(analysis.estimated_competition)}</span>
        </div>
        <div class="flex justify-between py-1.5 text-sm">
          <span class="text-zinc-500">Recommendation</span>
          <span class="font-semibold">
            <span class="text-xs px-2 py-0.5 rounded ${recClass[analysis.apply_recommendation] || 'bg-zinc-100 text-zinc-600'}">
              ${escapeHtml(analysis.apply_recommendation.replace('_', ' '))}
            </span>
          </span>
        </div>
      </div>
    </div>
  `;

  if (analysis.gaps.length > 0) {
    html += `
      <div class="mb-4">
        <h3 class="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">Gaps (${analysis.gaps.length})</h3>
        <div class="flex flex-wrap gap-1">
          ${analysis.gaps.map(g => `<span class="text-[11px] font-medium px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">${escapeHtml(g)}</span>`).join('')}
        </div>
      </div>
    `;
  }

  if (analysis.red_flags.length > 0) {
    html += `
      <div class="mb-4">
        <h3 class="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">Red Flags</h3>
        ${analysis.red_flags.map(f => `<div class="text-xs px-3 py-2 rounded-lg bg-red-50 text-red-700 border border-red-200 mb-1.5">${escapeHtml(f)}</div>`).join('')}
      </div>
    `;
  }

  return html;
}

init();
