import { extractPageContent } from '../scrapers/index.js';
import { errorMessage } from '../shared/error-message.js';
import { scorePasses } from '../shared/fit.js';
import { escapeHtml } from '../shared/html.js';
import { isSameJobPage } from '../shared/job-page.js';
import { errorStatus, errorToastText, readyStatus, skippedStatus, workingStatus } from '../shared/resume-status.js';
import type { WriterStatus } from '../shared/resume-status.js';
import type { MessageType, TabMessage } from '../shared/types.js';

// Avoid injecting on non-web pages and multiple times
const _href = window.location.href;
if (/^https?:\/\//.test(_href) && !(window as any).__seerInjected) {
  (window as any).__seerInjected = true;
  init();
}

// ─── Shared overlay shadow (FAB, badge, toast) ───────────────────────

const OVERLAY_CSS = `
  :host { all: initial; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  .fab {
    position: fixed; bottom: 24px; right: 24px; z-index: 999999;
    cursor: grab; display: flex; align-items: center; gap: 8px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    user-select: none; -webkit-user-select: none; touch-action: none;
  }
  .fab:active { cursor: grabbing; }
  .fab:hover .fab-tooltip { opacity: 1; transform: translateX(0); }
  .fab-icon {
    width: 44px; height: 44px; border-radius: 12px;
    background: #1a1a2e; color: #e0e0e8;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px; font-weight: 700;
    box-shadow: 0 2px 8px rgba(0,0,0,0.25), 0 0 0 1px rgba(255,255,255,0.06);
    transition: transform 0.15s, box-shadow 0.15s;
  }
  .fab-icon:hover {
    transform: scale(1.05);
    box-shadow: 0 4px 16px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.08);
  }
  .fab-icon.loading { animation: pulse 1s infinite; }
  .fab-tooltip {
    background: #27272a; color: #e4e4e7;
    padding: 6px 10px; border-radius: 6px; font-size: 12px;
    white-space: nowrap; opacity: 0; transform: translateX(8px);
    transition: opacity 0.15s, transform 0.15s;
    pointer-events: none; order: -1;
  }

  .badge {
    position: fixed; bottom: 72px; right: 28px; z-index: 999999;
    width: 36px; height: 36px; border-radius: 8px;
    display: none; align-items: center; justify-content: center;
    font-size: 13px; font-weight: 700;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2); animation: pop 0.3s ease-out;
  }
  .badge.show { display: flex; }
  .badge-pass { background: #16a34a; color: white; }
  .badge-fail { background: #dc2626; color: white; }

  .toast {
    position: fixed; bottom: 80px; right: 80px; z-index: 999999;
    padding: 10px 16px; border-radius: 8px; font-size: 13px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    box-shadow: 0 4px 16px rgba(0,0,0,0.12); animation: slide-in 0.3s ease-out;
    max-width: 360px; border: 1px solid; display: none;
  }
  .toast.show { display: block; }
  .toast-success { background: #f0fdf4; color: #166534; border-color: #bbf7d0; }
  .toast-warning { background: #fffbeb; color: #92400e; border-color: #fde68a; }
  .toast-error { background: #fef2f2; color: #991b1b; border-color: #fecaca; }
  .toast-action {
    display: block; margin-top: 8px; padding: 4px 10px; border-radius: 6px;
    border: 1px solid currentColor; background: transparent; color: inherit;
    font: inherit; font-weight: 600; cursor: pointer;
  }
  .toast-action:hover { background: rgba(0, 0, 0, 0.06); }

  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
  @keyframes pop { 0% { transform: scale(0); } 70% { transform: scale(1.15); } 100% { transform: scale(1); } }
  @keyframes slide-in { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
`;

let overlayShadow: ShadowRoot | null = null;
/** The finished resume for this page, opened by the View PDF button. */
let readyPdf: { jobId: string; pdfPath: string } | null = null;

/** The resume writer's latest state for this page; the panel's status bar shows it. */
let writerStatus: WriterStatus = workingStatus('writing');

/** Forget the previous job's resume: no "View PDF" target, and the status bar starts over. */
function clearWriterState() {
  readyPdf = null;
  writerStatus = workingStatus('writing');
}

/**
 * Back to the idle button: icon "S" and no score badge. While an analysis is still running the
 * icon keeps its loading state, so the user sees the button is busy; handleClick resets it when
 * the analysis ends. Does nothing when the overlay is not on the page.
 */
function resetOverlay(analyzing: boolean) {
  const shadow = document.getElementById('seer-overlay')?.shadowRoot;
  const icon = shadow?.querySelector('[data-icon]');
  if (icon && !analyzing) {
    icon.textContent = 'S';
    icon.classList.remove('loading');
  }
  shadow?.querySelector('[data-badge]')?.classList.remove('show');
}

function getOverlay(): ShadowRoot {
  let host = document.getElementById('seer-overlay');
  if (host?.shadowRoot) {
    overlayShadow = host.shadowRoot;
    return overlayShadow;
  }

  host = document.createElement('div');
  host.id = 'seer-overlay';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>${OVERLAY_CSS}</style>
    <div class="badge" data-badge></div>
    <div class="toast" data-toast></div>
  `;
  document.body.appendChild(host);
  overlayShadow = shadow;
  return shadow;
}

// ─── Main init ───────────────────────────────────────────────────────

function init() {
  console.log('[Seer] Content script initialized on:', window.location.href);

  // ─── Toggle listener: show/hide FAB when popup toggle changes ───
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SEER_TOGGLE') {
      const shadow = getOverlay();
      if (msg.enabled) {
        if (!shadow.querySelector('.fab')) {
          injectFabInto(shadow);
        }
      } else {
        shadow.querySelector('.fab')?.remove();
        document.getElementById('seer-panel-host')?.remove();
        const badge = shadow.querySelector('[data-badge]') as HTMLElement;
        if (badge) { badge.classList.remove('show'); }
        const toast = shadow.querySelector('[data-toast]') as HTMLElement;
        if (toast) { toast.classList.remove('show'); }
      }
    }
    // Resume writer updates from the background (msg is untyped at the chrome message boundary)
    if (
      msg.type === 'SEER_WRITER_PROGRESS' ||
      msg.type === 'SEER_PDF_READY' ||
      msg.type === 'SEER_PDF_ERROR' ||
      msg.type === 'SEER_WRITER_SKIPPED'
    ) {
      onWriterMessage(msg as TabMessage);
    }
  });

  // Check initial enabled state
  chrome.storage.local.get('seerEnabled', (data) => {
    if (data.seerEnabled === false) {
      console.log('[Seer] Extension disabled — skipping FAB injection');
      return;
    }
    const shadow = getOverlay();
    injectFabInto(shadow);

    // Re-inject if SPA frameworks remove our overlay host
    const observer = new MutationObserver(() => {
      if (!document.getElementById('seer-overlay')) {
        chrome.storage.local.get('seerEnabled', (d) => {
          if (d.seerEnabled === false) return;
          console.log('[Seer] Overlay was removed — re-injecting');
          overlayShadow = null;
          const s = getOverlay();
          injectFabInto(s);
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });

  let isAnalyzing = false;
  let pageAnalyzed = false;
  let lastPanelData: PanelData | null = null;
  // handleClick (left as is, owner rule) still passes these to togglePanel, which ignores
  // them: the panel reads the writer's state from `writerStatus`.
  const claudeStatus = 'pending';
  const claudeChatUrl = '';
  const claudeResponseText = '';

  // ─── SPA navigation: the next job page starts clean ───────────────
  // Job boards swap the job without reloading, so this script stays alive. Only the state
  // that handleClick / togglePanel read is reset here; those functions are untouched.
  // A const here, not at module level: init() runs before the module-level consts are set.
  const NAVIGATION_CHECK_MS = 1000;
  let lastUrl = window.location.href;
  setInterval(() => {
    const href = window.location.href;
    if (href === lastUrl || isSameJobPage(lastUrl, href)) return;
    console.log(`[Seer] Page changed (${lastUrl} -> ${href}) — clearing the previous job's results`);
    lastUrl = href;
    pageAnalyzed = false;
    lastPanelData = null;
    clearWriterState();
    document.getElementById('seer-panel-host')?.remove();
    resetOverlay(isAnalyzing);
  }, NAVIGATION_CHECK_MS);

  // ─── Draggable logic ──────────────────────────────────────────────
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let fabStartX = 0;
  let fabStartY = 0;

  function injectFabInto(shadow: ShadowRoot) {
    const fab = document.createElement('div');
    fab.className = 'fab';
    fab.innerHTML = `
      <div class="fab-icon" data-icon>S</div>
      <div class="fab-tooltip">Prophize with Seer</div>
    `;
    shadow.appendChild(fab);
    attachDragHandler(fab);
  }

  function attachDragHandler(target: HTMLDivElement) {
    target.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.button !== 0) return;
      isDragging = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      const rect = target.getBoundingClientRect();
      fabStartX = rect.left;
      fabStartY = rect.top;

      const onMouseMove = (e: MouseEvent) => {
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
          isDragging = true;
          target.style.left = `${fabStartX + dx}px`;
          target.style.top = `${fabStartY + dy}px`;
          target.style.right = 'auto';
          target.style.bottom = 'auto';
        }
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        if (!isDragging) {
          handleClick();
        }
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  // ─── Click handler: extract + send to background ─────────────────
  async function handleClick() {
    // If already analyzed, toggle the panel instead
    if (pageAnalyzed) {
      console.log('[Seer] Page already analyzed — toggling results panel');
      togglePanel(lastPanelData, claudeStatus, claudeChatUrl, claudeResponseText);
      return;
    }

    if (isAnalyzing) return;
    isAnalyzing = true;

    const shadow = getOverlay();
    const icon = shadow.querySelector('[data-icon]') as HTMLElement;
    icon.textContent = '...';
    icon.classList.add('loading');
    console.log('[Seer] ─── Analysis started ───');

    try {
      // Step 1: Extract
      console.log('[Seer] Step 1/3: Extracting page content...');
      const extraction = extractPageContent();

      if (!extraction.success && !(extraction.iframeUrls && extraction.iframeUrls.length > 0)) {
        console.log('[Seer] Extraction failed — not enough content on this page');
        showToast('Could not extract job data from this page.', 'error');
        return;
      }

      if (!extraction.success && extraction.iframeUrls?.length) {
        console.log(`[Seer] DOM empty but found ${extraction.iframeUrls.length} iframe(s) — sending to background to fetch`);
      }

      console.log(`[Seer] Step 1 done: method=${extraction.extractionMethod}, hasJobData=${!!extraction.jobData}, rawText=${extraction.rawText.length} chars`);

      // Step 2: Send to background
      console.log('[Seer] Step 2/3: Sending to background for analysis...');
      const response = await chrome.runtime.sendMessage({
        type: 'PAGE_EXTRACTED',
        extraction,
      });
      console.log('[Seer] Step 2 done: received response type:', response?.type);

      // Step 3: Show results
      console.log('[Seer] Step 3/3: Rendering results...');

      if (response?.type === 'DEEP_ANALYSIS_RESULT') {
        const { result, job, model, claudePrompt } = response;
        const pass = scorePasses(result.fit_score, response.threshold);
        console.log(`[Seer] Analysis: ${result.fit_score}/100, base: ${result.recommended_base}, model: ${model}`);
        showScoreBadge(result.fit_score, pass);
        showToast(
          `Fit: ${result.fit_score}/100 - ${result.apply_recommendation.replace('_', ' ')} | ${job.title} @ ${job.company}`,
          pass ? 'success' : 'warning'
        );
        lastPanelData = {
          job,
          score: result.fit_score,
          pass,
          model: model || 'grok-chat',
          recommendation: result.apply_recommendation,
          base: result.recommended_base,
          baseReasoning: result.base_reasoning || '',
          keyMatches: result.key_matches || [],
          gaps: result.gaps || [],
          atsKeywords: result.ats_keywords || [],
          claudePrompt,
        };
        showResultsPanel(lastPanelData);
        pageAnalyzed = true;
      } else if (response?.type === 'ERROR') {
        console.log('[Seer] Error from background:', response.message);
        showToast(response.message, 'error', response.needsSetup ? OPEN_SETUP_ACTION : undefined);
      }

      console.log('[Seer] ─── Analysis complete ───');
    } catch (err: any) {
      console.error('[Seer] Error:', err);
      showToast(err.message || 'Analysis failed', 'error');
    } finally {
      isAnalyzing = false;
      const s = getOverlay();
      const ic = s.querySelector('[data-icon]') as HTMLElement;
      ic.classList.remove('loading');
      ic.textContent = pageAnalyzed ? '✓' : 'S';
    }
  }
}

// ─── Floating results panel (own Shadow DOM) ─────────────────────────

interface PanelData {
  job: any;
  score: number;
  pass: boolean;
  model: string;
  recommendation: string;
  base: string;
  baseReasoning: string;
  keyMatches: string[];
  gaps: string[];
  atsKeywords: string[];
  /** Still set by handleClick (left as is, owner rule); the background no longer sends one. */
  claudePrompt?: string;
}

const PANEL_CSS = `
  :host { all: initial; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  .panel {
    position: fixed; top: 16px; right: -480px;
    width: 390px; max-height: calc(100vh - 32px);
    background: #fff; border-radius: 12px;
    box-shadow: 0 8px 30px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.06);
    border: 1px solid #e4e4e7;
    overflow: hidden; display: flex; flex-direction: column;
    transition: right 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px; line-height: 1.5; color: #18181b;
    z-index: 999998;
  }
  .panel.visible { right: 76px; }

  .header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; background: #1a1a2e; color: #f0f0f4; flex-shrink: 0;
  }
  .header-title { font-size: 13px; font-weight: 600; letter-spacing: 0.2px; }
  .header-close {
    background: none; border: none; color: #8b8b9e;
    font-size: 20px; cursor: pointer; padding: 0 4px; line-height: 1;
    transition: color 0.15s; font-family: inherit;
  }
  .header-close:hover { color: #f0f0f4; }

  .body { padding: 16px; overflow-y: auto; flex: 1; }

  .score {
    display: flex; align-items: baseline; justify-content: center;
    gap: 2px; padding: 16px 0 12px;
  }
  .score-num { font-size: 44px; font-weight: 800; line-height: 1; }
  .score-label { font-size: 16px; font-weight: 600; color: #a1a1aa; }
  .score-pass .score-num { color: #16a34a; }
  .score-fail .score-num { color: #dc2626; }

  .job {
    text-align: center; padding-bottom: 12px;
    border-bottom: 1px solid #e4e4e7; margin-bottom: 12px;
  }
  .job-title { font-size: 15px; font-weight: 700; color: #18181b; margin-bottom: 4px; }
  .job-company { font-size: 13px; color: #71717a; font-weight: 500; }
  .job-meta { font-size: 12px; color: #a1a1aa; margin-top: 4px; }

  .meta {
    display: flex; flex-wrap: wrap; gap: 6px;
    margin-bottom: 14px; justify-content: center;
  }
  .tag {
    font-size: 11px; padding: 3px 8px; border-radius: 4px;
    background: #f4f4f5; color: #3f3f46; font-weight: 500;
    display: inline-block;
  }
  .rec-strong_yes { background: #dcfce7; color: #166534; }
  .rec-yes { background: #dbeafe; color: #1e40af; }
  .rec-maybe { background: #fef3c7; color: #92400e; }
  .rec-no { background: #fee2e2; color: #991b1b; }
  .tag-model { background: #f4f4f5; color: #52525b; font-family: monospace; font-size: 10px; }

  .section { margin-bottom: 16px; }
  .section-title {
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.5px; color: #71717a; margin-bottom: 6px;
  }
  .section-body { font-size: 13px; color: #3f3f46; line-height: 1.5; }
  .section-body strong { font-weight: 700; }

  .tags { display: flex; flex-wrap: wrap; gap: 6px; }
  .tag-match {
    font-size: 12px; padding: 3px 8px; border-radius: 4px;
    background: #dcfce7; color: #166534; font-weight: 500;
    line-height: 1.3; display: inline-block;
  }
  .tag-gap {
    font-size: 12px; padding: 3px 8px; border-radius: 4px;
    background: #fee2e2; color: #991b1b; font-weight: 500;
    line-height: 1.3; display: inline-block;
  }
  .tag-kw {
    font-size: 12px; padding: 3px 8px; border-radius: 4px;
    background: #e0f2fe; color: #0c4a6e; font-weight: 500;
    line-height: 1.3; display: inline-block;
  }

  .desc-header { display: flex; align-items: center; justify-content: space-between; }
  .desc {
    font-size: 12px; color: #52525b; line-height: 1.6;
    white-space: pre-wrap; max-height: 400px; overflow-y: auto;
    background: #fafafa; padding: 10px; border-radius: 6px;
    border: 1px solid #e4e4e7;
  }
  .copy-btn {
    font-size: 11px; padding: 2px 10px; border-radius: 4px;
    border: 1px solid #d4d4d8; background: #fff; color: #3f3f46;
    cursor: pointer; font-weight: 600; transition: background 0.15s, border-color 0.15s;
    font-family: inherit;
  }
  .copy-btn:hover { background: #f4f4f5; border-color: #a1a1aa; }

  .resume-status {
    padding: 12px 16px; border-top: 1px solid #e4e4e7;
    display: flex; align-items: center; gap: 10px;
    font-size: 13px; font-weight: 600; color: #52525b;
    background: #fafafa; flex-shrink: 0;
  }
  .resume-status.ready { background: #dcfce7; color: #166534; }
  .resume-status.error { background: #fef3c7; color: #92400e; }
  .resume-text { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .resume-note { font-size: 12px; font-weight: 500; color: #92400e; }
  .resume-missing {
    display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
    font-size: 11px; font-weight: 500;
  }
  .resume-missing-label { margin-right: 2px; }
  .resume-spinner {
    width: 16px; height: 16px; border: 2px solid #d4d4d8;
    border-top-color: #3f3f46; border-radius: 50%;
    animation: spin 0.8s linear infinite; flex-shrink: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .resume-pdf-btn {
    margin-left: auto; font-size: 11px; padding: 4px 12px; border-radius: 4px;
    border: 1px solid #7c3aed; background: #fff; color: #6d28d9;
    cursor: pointer; font-weight: 600; transition: background 0.15s;
    font-family: inherit; flex-shrink: 0;
  }
  .resume-pdf-btn:hover { background: #f5f3ff; }
`;

function showResultsPanel(data: PanelData) {
  document.getElementById('seer-panel-host')?.remove();

  const host = document.createElement('div');
  host.id = 'seer-panel-host';
  const shadow = host.attachShadow({ mode: 'open' });

  const recLabel: Record<string, string> = {
    'strong_yes': 'Strong Yes', 'yes': 'Yes',
    'maybe': 'Maybe', 'no': 'No',
  };

  let body = `
    <div class="score ${data.pass ? 'score-pass' : 'score-fail'}">
      <span class="score-num">${data.score}</span>
      <span class="score-label">/100</span>
    </div>
    <div class="job">
      <div class="job-title">${escapeHtml(data.job.title || 'Unknown Title')}</div>
      <div class="job-company">${escapeHtml(data.job.company || 'Unknown Company')}</div>
      ${data.job.location ? `<div class="job-meta">${escapeHtml(data.job.location)}</div>` : ''}
      ${data.job.salary_range ? `<div class="job-meta">${escapeHtml(data.job.salary_range)}</div>` : ''}
    </div>
    <div class="meta">
      <span class="tag rec-${escapeHtml(data.recommendation)}">${escapeHtml(recLabel[data.recommendation] || data.recommendation)}</span>
      <span class="tag tag-model">${escapeHtml(data.model)}</span>
    </div>
    <div class="section">
      <div class="section-title">Closest file</div>
      <div class="section-body"><strong>${escapeHtml(data.base)}</strong> — ${escapeHtml(data.baseReasoning)}</div>
    </div>
  `;

  if (data.keyMatches.length > 0) {
    body += `
      <div class="section">
        <div class="section-title">Key Matches (${data.keyMatches.length})</div>
        <div class="tags">${data.keyMatches.map(s => `<span class="tag-match">${escapeHtml(s)}</span>`).join('')}</div>
      </div>`;
  }
  if (data.gaps.length > 0) {
    body += `
      <div class="section">
        <div class="section-title">Gaps (${data.gaps.length})</div>
        <div class="tags">${data.gaps.map(s => `<span class="tag-gap">${escapeHtml(s)}</span>`).join('')}</div>
      </div>`;
  }
  if (data.atsKeywords.length > 0) {
    body += `
      <div class="section">
        <div class="section-title">ATS Keywords</div>
        <div class="tags">${data.atsKeywords.map(s => `<span class="tag-kw">${escapeHtml(s)}</span>`).join('')}</div>
      </div>`;
  }
  if (data.job.description) {
    body += `
      <div class="section">
        <div class="section-title desc-header">
          <span>Full Description</span>
          <button class="copy-btn" data-copy>Copy JD</button>
        </div>
        <div class="desc">${escapeHtml(data.job.description)}</div>
      </div>`;
  }

  shadow.innerHTML = `
    <style>${PANEL_CSS}</style>
    <div class="panel">
      <div class="header">
        <span class="header-title">The Seer is Prophesying...</span>
        <button class="header-close">&times;</button>
      </div>
      <div class="body">${body}</div>
      <div class="resume-status" data-resume-status></div>
    </div>
  `;

  document.body.appendChild(host);
  renderWriterStatus();

  const panel = shadow.querySelector('.panel') as HTMLElement;
  requestAnimationFrame(() => panel.classList.add('visible'));

  shadow.querySelector('.header-close')!.addEventListener('click', () => {
    panel.classList.remove('visible');
    setTimeout(() => host.remove(), 300);
  });

  const copyBtn = shadow.querySelector('[data-copy]');
  if (copyBtn && data.job.description) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(data.job.description).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy JD'; }, 2000);
      });
    });
  }
}

/** Extra arguments from handleClick are ignored; a re-created panel shows `writerStatus`. */
function togglePanel(panelData?: PanelData | null, ..._ignored: string[]) {
  const host = document.getElementById('seer-panel-host');
  if (host?.shadowRoot) {
    // Panel exists — close it
    const panel = host.shadowRoot.querySelector('.panel');
    panel?.classList.remove('visible');
    setTimeout(() => host.remove(), 300);
  } else if (panelData) {
    // Panel was removed — re-create it
    showResultsPanel(panelData);
  }
}

function onWriterMessage(msg: TabMessage) {
  // A job started on another URL (the tab has moved on) must not touch this page's panel.
  if (!isSameJobPage(msg.jobUrl, window.location.href)) {
    const job = 'jobId' in msg ? ` for job ${msg.jobId}` : '';
    console.log(`[Seer] Ignoring ${msg.type}${job} from another page (${msg.jobUrl})`);
    return;
  }
  switch (msg.type) {
    case 'SEER_WRITER_PROGRESS':
      console.log(`[Seer] Resume writer: ${msg.stage}`);
      setWriterStatus(workingStatus(msg.stage));
      return;
    case 'SEER_PDF_READY':
      readyPdf = { jobId: msg.jobId, pdfPath: msg.pdfPath };
      console.log(`[Seer] PDF ready: ${msg.pdfPath} (${msg.pages} page(s))`);
      setWriterStatus(readyStatus(msg));
      return;
    case 'SEER_PDF_ERROR':
      console.log(`[Seer] Resume writing failed: ${msg.error}${msg.details ? ` — ${msg.details}` : ''}`);
      setWriterStatus(errorStatus(msg.error));
      showToast(errorToastText(msg.error, msg.details), 'error', msg.needsSetup ? OPEN_SETUP_ACTION : undefined);
      return;
    case 'SEER_WRITER_SKIPPED':
      console.log(`[Seer] Fit ${msg.score} is below ${msg.threshold} — no resume written`);
      setWriterStatus(skippedStatus(msg.score, msg.threshold));
      return;
  }
}

function setWriterStatus(status: WriterStatus) {
  writerStatus = status;
  renderWriterStatus();
}

/** Draw `writerStatus` into the panel's status bar, if the panel is open. */
function renderWriterStatus() {
  const panelHost = document.getElementById('seer-panel-host');
  const statusEl = panelHost?.shadowRoot?.querySelector('[data-resume-status]');
  if (!statusEl) return;

  statusEl.className = `resume-status ${writerStatus.state}`;
  statusEl.replaceChildren();
  if (writerStatus.state === 'working') {
    const spinner = document.createElement('div');
    spinner.className = 'resume-spinner';
    statusEl.appendChild(spinner);
  }
  statusEl.appendChild(buildStatusText(writerStatus));

  if (writerStatus.state === 'ready') addViewPdfButton(statusEl);
}

function textElement(tag: 'div' | 'span', className: string, text: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}

/** The status line, its note and the missing keywords. Text goes in as textContent, so nothing is parsed as HTML. */
function buildStatusText(status: WriterStatus): HTMLElement {
  const box = document.createElement('div');
  box.className = 'resume-text';
  box.appendChild(textElement('div', 'resume-line', status.text));
  if (status.note) box.appendChild(textElement('div', 'resume-note', status.note));
  if (status.missing.length > 0) {
    const missing = document.createElement('div');
    missing.className = 'resume-missing';
    missing.appendChild(textElement('span', 'resume-missing-label', 'Missing:'));
    for (const keyword of status.missing) missing.appendChild(textElement('span', 'tag-gap', keyword));
    if (status.moreMissing > 0) missing.appendChild(textElement('span', 'resume-more', `+${status.moreMissing} more`));
    box.appendChild(missing);
  }
  return box;
}

/** Add "View PDF" button to the panel status bar */
function addViewPdfButton(statusEl: Element) {
  const btn = document.createElement('button');
  btn.className = 'resume-pdf-btn';
  btn.textContent = 'View PDF';
  btn.addEventListener('click', openPdf);
  statusEl.appendChild(btn);
}

function openPdf() {
  if (readyPdf) {
    const msg: MessageType = { type: 'SEER_OPEN_PDF', jobId: readyPdf.jobId, pdfPath: readyPdf.pdfPath };
    chrome.runtime.sendMessage(msg);
  }
}

// ─── Score badge + toast (via overlay shadow) ────────────────────────

function showScoreBadge(score: number, pass: boolean) {
  const shadow = getOverlay();
  const badge = shadow.querySelector('[data-badge]') as HTMLElement;
  badge.textContent = `${score}`;
  badge.className = `badge show ${pass ? 'badge-pass' : 'badge-fail'}`;
}

/** A button under a toast's message: `label` is its text, `onClick` runs when it is pressed. */
interface ToastAction {
  label: string;
  onClick: () => void;
}

/** Asks the background to open the setup page; content scripts cannot open it themselves. */
function openSetup() {
  const msg: MessageType = { type: 'OPEN_SETUP' };
  chrome.runtime.sendMessage(msg).catch((err: unknown) => {
    console.log(`[Seer] Could not ask for the setup page: ${errorMessage(err)}`);
  });
}

/** The toast button for a failure whose fix is on the setup page. */
const OPEN_SETUP_ACTION: ToastAction = { label: 'Open setup', onClick: openSetup };

function buildToastAction(action: ToastAction, toast: HTMLElement): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'toast-action';
  button.textContent = action.label;
  button.addEventListener('click', () => {
    action.onClick();
    toast.classList.remove('show');
  });
  return button;
}

function showToast(message: string, type: 'success' | 'warning' | 'error', action?: ToastAction) {
  const shadow = getOverlay();
  const toast = shadow.querySelector('[data-toast]') as HTMLElement;
  toast.textContent = message;
  if (action) toast.appendChild(buildToastAction(action, toast));
  toast.className = `toast show toast-${type}`;
  setTimeout(() => { toast.classList.remove('show'); }, 12000);
}
