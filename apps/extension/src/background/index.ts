import { getSettings, saveJobForTab, getJobForTab, removeJobForTab, getEnabled } from '../shared/storage.js';
import { EDITOR_JOBS_KEY, editorPagePath, editorPayloadKey } from '../shared/editor-store.js';
import { errorMessage } from '../shared/error-message.js';
import { scorePasses } from '../shared/fit.js';
import { NATIVE_HOST } from '../shared/helper-client.js';
import { LEGACY_STORAGE_KEYS, legacyKeysIn } from '../shared/legacy-storage.js';
import type { WriteResult } from '../shared/host-protocol.js';
import { htmlToText, pickJobText } from '../shared/job-text.js';
import { WriterError, writeResumeViaHost } from '../shared/native-writer.js';
import { errorToastText } from '../shared/resume-status.js';
import type { ScrapedJob, MessageType, EditorPayload, FitAnalysis, JobData, TabMessage } from '../shared/types.js';
import {
  expiredResumeNotice,
  failedNotificationId,
  failureNotice,
  fileUrlFor,
  parseNotificationId,
  readyDelivery,
  readyNotificationId,
  resumeOpenAction,
  retainRecentJobs,
} from './delivery.js';
import { createJobRunner, HOST_JOB_TIMEOUT_MS } from './job-runner.js';
import type { JobRef } from './job-runner.js';
import { isBadgeStale, shouldDeliverAnalysis } from './stale-page.js';

const jobRunner = createJobRunner({
  newJobId: () => crypto.randomUUID(),
  pickJobText,
  write: (req, events) => {
    console.log(`[Seer BG] Job text: ${req.job.text.length} chars — sending to the native host`);
    return writeResumeViaHost(req, {
      connect: () => chrome.runtime.connectNative(NATIVE_HOST),
      lastError: () => chrome.runtime.lastError?.message,
      onProgress: events.onProgress,
      onScore: events.onScore,
      timeoutMs: HOST_JOB_TIMEOUT_MS,
    });
  },
  toTab: (tabId, msg) => {
    if (msg.type === 'SEER_WRITER_PROGRESS') {
      console.log(`[Seer BG] Job ${msg.jobId} (tab ${tabId}): ${msg.stage}`);
    }
    sendToTab(tabId, msg);
  },
  onWriteStart: startBadgeFlash,
  onResult: deliverResume,
  onWriteError: reportWriteError,
});

// One-time cleanup on install and update: drop what earlier versions stored and nothing reads now.
chrome.runtime.onInstalled.addListener((details) => {
  removeLegacyStorage().catch((err: unknown) => {
    console.log(`[Seer BG] Could not remove legacy storage keys: ${errorMessage(err)}`);
  });
  // A fresh install starts on the setup page (an update or a Chrome update does not).
  if (details.reason === 'install') openSetupPage();
});

function openSetupPage(): void {
  chrome.runtime.openOptionsPage().catch((err: unknown) => {
    console.log(`[Seer BG] Could not open the setup page: ${errorMessage(err)}`);
  });
}

async function removeLegacyStorage(): Promise<void> {
  const stored: Record<string, unknown> = await chrome.storage.local.get([...LEGACY_STORAGE_KEYS]);
  const present = legacyKeysIn(stored);
  if (present.length === 0) return;
  await chrome.storage.local.remove(present);
  console.log(`[Seer BG] Removed legacy storage keys: ${present.join(', ')}`);
}

// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((message: MessageType, sender, sendResponse) => {
  // Toggle messages are handled by content script directly
  if (message.type === 'SEER_TOGGLE') return;

  // Open resume editor (or fallback to raw PDF)
  if (message.type === 'SEER_OPEN_PDF') {
    const { jobId, pdfPath } = message;
    openResume(jobId, pdfPath).catch((err: unknown) => {
      console.log(`[Seer BG] Could not open job ${jobId}'s resume: ${errorMessage(err)}`);
    });
    return;
  }

  // Open the setup page for a toast's "Open setup" button (content scripts cannot open it themselves)
  if (message.type === 'OPEN_SETUP') {
    openSetupPage();
    return;
  }

  // Recompile LaTeX via native host
  if (message.type === 'SEER_RECOMPILE') {
    const { texSource, texPath, folderPath, uploadPdfPath } = message;
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST,
      { command: 'recompile', texSource, texPath, folderPath, uploadPdfPath },
      (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse(response);
      }
    );
    return true; // keep channel open for async sendResponse
  }

  const tabId = sender.tab?.id;
  handleMessage(message, tabId).then(sendResponse).catch((err: unknown) => {
    const response: BackgroundResponse = { type: 'ERROR', message: errorResponseText(err), needsSetup: needsSetupOf(err) };
    sendResponse(response);
  });
  return true; // keep channel open for async response
});

// Clean up stored job data when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  removeJobForTab(tabId).catch((err: unknown) => {
    console.log(`[Seer BG] Could not remove the job for closed tab ${tabId}: ${errorMessage(err)}`);
  });
  clearBadgeFlash(tabId);
  badgeScores.delete(tabId);
  closedTabs.add(tabId);
});

// A tab that moves to another job page must not keep the old job's score in the toolbar.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  clearStaleBadge(tabId, changeInfo.url).catch((err: unknown) => {
    console.log(`[Seer BG] Could not check the badge of tab ${tabId}: ${errorMessage(err)}`);
  });
});

/** Clears the tab's badge if `newUrl` is not the page of the job stored for the tab; the stored job stays. */
async function clearStaleBadge(tabId: number, newUrl: string): Promise<void> {
  const stored = await getJobForTab(tabId);
  const storedUrl = stored?.extraction?.url ?? stored?.job.url;
  if (isBadgeStale(storedUrl, newUrl)) clearScoreBadge(tabId);
}

/** True when the tab is still on `pageUrl`. A tab that cannot be read (it was closed) counts as moved on. */
async function isTabStillOn(tabId: number, pageUrl: string): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return shouldDeliverAnalysis(pageUrl, tab.url);
  } catch (err: unknown) {
    console.log(`[Seer BG] Could not read tab ${tabId}: ${errorMessage(err)}`);
    return false;
  }
}

/** What the background answers a content script's or the popup's message with. */
type BackgroundResponse = Extract<MessageType, { type: 'ERROR' | 'STALE_RESULT' | 'DEEP_ANALYSIS_RESULT' | 'CURRENT_JOB_RESULT' }>;

async function handleMessage(message: MessageType, senderTabId?: number): Promise<BackgroundResponse> {
  console.log(`[Seer BG] Received message: ${message.type} (tab: ${senderTabId ?? 'unknown'})`);
  const settings = await getSettings();

  switch (message.type) {
    // ─── New: Content script sends extraction result ──────────────
    case 'PAGE_EXTRACTED': {
      const enabled = await getEnabled();
      if (!enabled) {
        return { type: 'ERROR', message: 'Seer is disabled.' };
      }

      const { extraction } = message;
      console.log(`[Seer BG] Extraction method: ${extraction.extractionMethod}, hasJobData: ${!!extraction.jobData}, rawText: ${extraction.rawText.length} chars`);

      if (senderTabId == null) {
        return { type: 'ERROR', message: 'PAGE_EXTRACTED must come from a tab.' };
      }

      // ── Gather the best job content (the native host scores it and writes from it) ──
      console.log(`[Seer BG] Gathering job content`);
      const iframeTexts = await fetchIframeTexts(extraction.iframeUrls ?? []);

      // ── The host scores the job (Claude Code); the resume follows only if the fit passes ──
      const t_score_start = performance.now();
      const combined = await jobRunner.run(senderTabId, extraction, { iframeTexts }, settings);
      const t_score_end = performance.now();
      console.log(`[Seer BG] Scored by ${combined.model} in ${((t_score_end - t_score_start) / 1000).toFixed(1)}s`);
      console.log(`[Seer BG] Extracted: "${combined.job.title}" @ ${combined.job.company}`);
      console.log(`[Seer BG] Fit: ${combined.analysis.fit_score}/100, base: ${combined.analysis.recommended_base}, rec: ${combined.analysis.apply_recommendation}`);

      // The tab may have moved to another job while the host was scoring (job boards swap the job
      // without reloading). The resume write is left alone: the resume still reaches the user
      // through its notification and the editor. But this analysis must not be drawn over the
      // new page, stored for the popup or put in the toolbar badge.
      if (!(await isTabStillOn(senderTabId, extraction.url))) {
        console.log(`[Seer BG] Page moved on — dropping stale analysis for ${extraction.url}`);
        return { type: 'STALE_RESULT' };
      }

      // Only `extraction.url` is read back (badge staleness), so the page text is not stored.
      const scrapedJob: ScrapedJob = {
        job: combined.job,
        extraction: { ...extraction, rawText: '', jsonLd: null },
        deepAnalysis: combined.analysis,
        scrapedAt: new Date().toISOString(),
      };
      await saveJobForTab(senderTabId, scrapedJob);
      console.log(`[Seer BG] Saved to storage (tab ${senderTabId})`);
      showScoreBadge(senderTabId, { score: combined.analysis.fit_score, threshold: combined.threshold });

      return {
        type: 'DEEP_ANALYSIS_RESULT',
        result: combined.analysis,
        job: combined.job,
        model: combined.model,
        threshold: combined.threshold,
      };
    }

    // ─── Get job for a specific tab ────────────────────────────────
    case 'GET_JOB_FOR_TAB': {
      const data = await getJobForTab(message.tabId);
      console.log(`[Seer BG] GET_JOB_FOR_TAB (tab ${message.tabId}): ${data ? `"${data.job.title}"` : 'null'}`);
      return { type: 'CURRENT_JOB_RESULT', data };
    }

    default:
      console.log(`[Seer BG] Unknown message type: ${message.type}`);
      return { type: 'ERROR', message: 'Unknown message type' };
  }
}

// ─── Badge: the fit score, flashing "PDF" while a resume is being written ───

const PASS_COLOR = '#10b981';
const FAIL_COLOR = '#ef4444';
const PDF_COLOR = '#f59e0b';
const BADGE_FLASH_MS = 500;

/** A tab's badge alternates "PDF" with the score while that tab's resumes are being written. */
interface BadgeFlash {
  timer: ReturnType<typeof setInterval>;
  /** Jobs of this tab whose host has started writing and not yet finished. */
  jobIds: Set<string>;
}

const badgeFlashes = new Map<number, BadgeFlash>();

/** A fit score and the fit bar it was judged against (the setting when the job was scored). */
interface BadgeScore {
  score: number;
  threshold: number;
}

/** The score each tab's badge shows (absent: no score for the tab's current page). */
const badgeScores = new Map<number, BadgeScore>();

/** Tabs closed in this browser session (tab ids are never reused); a job still running for one gets no badge flash. */
const closedTabs = new Set<number>();

/** The panel's toast for a failed analysis; a host error before the score keeps the first line of its details. */
function errorResponseText(err: unknown): string {
  if (err instanceof WriterError) return errorToastText(err.message, err.details);
  return errorMessage(err) || 'Unknown error';
}

/** True when the failure's fix is on the setup page, so the toast offers "Open setup". */
function needsSetupOf(err: unknown): boolean {
  return err instanceof WriterError && err.needsSetup;
}

function setBadge(tabId: number, text: string, color: string): void {
  Promise.all([
    chrome.action.setBadgeText({ text, tabId }),
    chrome.action.setBadgeBackgroundColor({ color, tabId }),
  ]).catch((err: unknown) => {
    console.log(`[Seer BG] Could not set the badge on tab ${tabId}: ${errorMessage(err)}`);
  });
}

/** Shows the tab's score, or no badge when it has none. */
function setScoreBadge(tabId: number): void {
  const shown = badgeScores.get(tabId);
  if (shown == null) {
    setBadge(tabId, '', PDF_COLOR);
    return;
  }
  setBadge(tabId, `${shown.score}`, scorePasses(shown.score, shown.threshold) ? PASS_COLOR : FAIL_COLOR);
}

/** Removes the tab's score; a running "PDF" flash then alternates with a blank badge. */
function clearScoreBadge(tabId: number): void {
  badgeScores.delete(tabId);
  setScoreBadge(tabId);
}

function showScoreBadge(tabId: number, shown: BadgeScore): void {
  badgeScores.set(tabId, shown);
  setScoreBadge(tabId);
}

function startBadgeFlash(job: JobRef): void {
  if (closedTabs.has(job.tabId)) {
    console.log(`[Seer BG] Job ${job.jobId}: tab ${job.tabId} was closed while scoring — no badge flash`);
    return;
  }
  const running = badgeFlashes.get(job.tabId);
  if (running) {
    running.jobIds.add(job.jobId);
    return;
  }
  let showPdf = true;
  const flash: BadgeFlash = {
    jobIds: new Set([job.jobId]),
    timer: setInterval(() => {
      showPdf = !showPdf;
      if (showPdf) {
        setBadge(job.tabId, 'PDF', PDF_COLOR);
      } else {
        setScoreBadge(job.tabId);
      }
    }, BADGE_FLASH_MS),
  };
  badgeFlashes.set(job.tabId, flash);
  setBadge(job.tabId, 'PDF', PDF_COLOR);
}

/**
 * The job has ended. A job that never started writing (skipped, or failed first) changes nothing;
 * once no job of the tab is writing, the badge settles on the score.
 */
function stopBadgeFlash(job: JobRef): void {
  const flash = badgeFlashes.get(job.tabId);
  if (!flash || !flash.jobIds.delete(job.jobId)) return;
  if (flash.jobIds.size > 0) return;
  clearBadgeFlash(job.tabId);
  setScoreBadge(job.tabId);
}

/** Stops the tab's flash without touching its badge (used when the tab is closed). */
function clearBadgeFlash(tabId: number): void {
  const flash = badgeFlashes.get(tabId);
  if (!flash) return;
  clearInterval(flash.timer);
  badgeFlashes.delete(tabId);
}

// ─── Resume delivery (job runner callbacks) ─────────────────────────

function sendToTab(tabId: number, msg: TabMessage): void {
  chrome.tabs.sendMessage(tabId, msg).catch((err: unknown) => {
    console.log(`[Seer BG] Could not send ${msg.type} to tab ${tabId}: ${errorMessage(err)}`);
  });
}

function editorPayloadOf(result: WriteResult): EditorPayload {
  return {
    pdfPath: result.pdfPath,
    uploadPdfPath: result.uploadPdfPath,
    texPath: result.texPath,
    folderPath: result.folderPath,
    folderName: result.folderName,
    latexSource: result.latexSource,
    pdfBase64: result.pdfBase64,
    pdfSizeBytes: result.pdfSizeBytes,
  };
}

/** Stores run one after another, so two jobs finishing together can't lose each other's id. */
let editorStores: Promise<void> = Promise.resolve();

async function writeEditorPayload(jobId: string, payload: EditorPayload): Promise<void> {
  const data = await chrome.storage.session.get(EDITOR_JOBS_KEY);
  const ids = (data[EDITOR_JOBS_KEY] as string[] | undefined) ?? [];
  const { kept, dropped } = retainRecentJobs(ids, jobId);
  await chrome.storage.session.set({ [EDITOR_JOBS_KEY]: kept, [editorPayloadKey(jobId)]: payload });
  if (dropped.length > 0) {
    await chrome.storage.session.remove(dropped.map(editorPayloadKey));
  }
}

/** Keeps the job's resume for the editor, dropping the oldest beyond the last 20 jobs. Never rejects. */
function storeEditorPayload(jobId: string, payload: EditorPayload): Promise<void> {
  editorStores = editorStores
    .then(() => writeEditorPayload(jobId, payload))
    .catch((err: unknown) => {
      console.log(`[Seer BG] Could not update the editor's stored resumes (job ${jobId}): ${errorMessage(err)}`);
    });
  return editorStores;
}

/** The resume is written: keep it for the editor, then tell the tab and the user. */
async function deliverResume(job: JobRef, result: WriteResult, analysis: FitAnalysis, jobData: JobData): Promise<void> {
  const { message, notificationText } = readyDelivery(job, result, analysis);
  const keywords = message.coverage ? `${message.coverage.matched}/${message.coverage.total} keywords` : 'not scored';
  console.log(`[Seer BG] Job ${job.jobId} (tab ${job.tabId}): resume for "${jobData.title}" @ ${jobData.company} ready at ${result.pdfPath} — ${result.pages} page(s), fits: ${result.fits}, trimmed bullets: ${result.trimmedBullets}, ${keywords}`);
  stopBadgeFlash(job);
  await storeEditorPayload(job.jobId, editorPayloadOf(result));
  sendToTab(job.tabId, message);
  notify(readyNotificationId(job.jobId), result.folderName, notificationText);
}

function reportWriteError(job: JobRef, err: WriterError, jobData: JobData): void {
  if (err.details) {
    console.log(`[Seer BG] Job ${job.jobId} writer error details: ${err.details}`);
  }
  stopBadgeFlash(job);
  sendToTab(job.tabId, {
    type: 'SEER_PDF_ERROR',
    jobId: job.jobId,
    jobUrl: job.jobUrl,
    error: err.message,
    details: err.details,
    needsSetup: err.needsSetup,
  });
  const notice = failureNotice(jobData, err.message);
  notify(failedNotificationId(job.jobId), notice.title, notice.message);
}

function notify(id: string, title: string, message: string): void {
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message,
    priority: 2,
  }, (createdId) => {
    if (chrome.runtime.lastError) {
      console.error(`[Seer BG] Notification failed: ${chrome.runtime.lastError.message}`);
    } else {
      console.log(`[Seer BG] Notification shown: ${createdId}`);
    }
  });
}

/**
 * Opens the job's resume in the editor while it is stored. Once it is gone (pruned beyond the
 * last 20 jobs, or the session ended) it opens the PDF file if `pdfPath` is known, else (or when
 * Chrome refuses the file, e.g. without file access) tells the user where to find it. Returns
 * false only when it told the user. The stored resume stays: the editor page needs it, and old
 * jobs are pruned as new ones arrive.
 */
async function openResume(jobId: string, pdfPath?: string): Promise<boolean> {
  const key = editorPayloadKey(jobId);
  const stored = (await chrome.storage.session.get(key))[key] != null;
  const action = resumeOpenAction(stored, pdfPath);
  if (action === 'editor') {
    await chrome.tabs.create({ url: chrome.runtime.getURL(editorPagePath(jobId)) });
    return true;
  }
  console.log(`[Seer BG] Job ${jobId}'s resume is no longer in session storage (pruned or the session ended)`);
  if (action === 'file' && pdfPath && (await openPdfFile(pdfPath))) return true;
  const notice = expiredResumeNotice(pdfPath);
  notify(readyNotificationId(jobId), notice.title, notice.message);
  return false;
}

/** Opens the PDF in a new tab; false when Chrome refuses (e.g. the extension lacks file access). */
async function openPdfFile(pdfPath: string): Promise<boolean> {
  try {
    await chrome.tabs.create({ url: fileUrlFor(pdfPath) });
    return true;
  } catch (err: unknown) {
    console.log(`[Seer BG] Could not open ${pdfPath}: ${errorMessage(err)}`);
    return false;
  }
}

chrome.notifications.onClicked.addListener(async (notifId) => {
  const target = parseNotificationId(notifId);
  let keepNotification = false;
  // A failure notification has no resume to open: clicking it only dismisses it.
  if (target?.kind === 'ready') {
    try {
      keepNotification = !(await openResume(target.jobId));
    } catch (err: unknown) {
      console.log(`[Seer BG] Could not open job ${target.jobId}'s resume: ${errorMessage(err)}`);
      keepNotification = true;
    }
  }
  // A resume that could not be opened keeps its notification, so the user can try again or read why.
  if (!keepNotification) chrome.notifications.clear(notifId);
});

// ─── Iframe pages (cross-origin job boards the content script cannot read) ───

/** The page's text, or null when it does not load (a non-2xx answer). Runs in the service worker: no DOM. */
async function fetchIframeText(url: string): Promise<string | null> {
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const html = await resp.text();
  const text = htmlToText(html);
  console.log(`[Seer BG] Iframe fetched: ${html.length} → text: ${text.length} chars`);
  return text;
}

/** Fetches every iframe page at once; the texts keep `urls`' order, and a page that fails is logged and left out. */
async function fetchIframeTexts(urls: readonly string[]): Promise<string[]> {
  if (urls.length === 0) return [];
  console.log(`[Seer BG] Fetching ${urls.length} iframe(s) directly...`);
  const results = await Promise.allSettled(urls.map(fetchIframeText));
  const texts: string[] = [];
  for (const result of results) {
    if (result.status === 'rejected') {
      console.log(`[Seer BG] Iframe fetch failed: ${errorMessage(result.reason)}`);
    } else if (result.value !== null) {
      texts.push(result.value);
    }
  }
  return texts;
}
