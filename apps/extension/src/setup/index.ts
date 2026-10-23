/** The setup page: 1 Check · 2 Your files · 3 Preferences. DOM wiring over checks.ts and files.ts. */

import { errorMessage } from '../shared/error-message.js';
import { createHelperClient, HelperError } from '../shared/helper-client.js';
import type { HelperStatus, MyFile } from '../shared/helper-types.js';
import { CLAUDE_MODELS, MAX_WRITER_NOTES } from '../shared/settings-normalize.js';
import { getSettings, saveSettings } from '../shared/storage.js';
import type { SeerSettings } from '../shared/types.js';
import { allGreen, checkRows } from './checks.js';
import type { CheckRow } from './checks.js';
import {
  ACCEPTED_TYPES,
  canLeaveFilesStep,
  fileStatusText,
  folderFailure,
  isTooBig,
  profileProblemText,
  toBase64,
  tooBigFile,
} from './files.js';

type Step = 1 | 2 | 3;

const STEPS: readonly Step[] = [1, 2, 3];
const COPIED_RESET_MS = 2000;
const NOTES_SAVE_DELAY_MS = 500;

const helper = createHelperClient((host, message) => chrome.runtime.sendNativeMessage(host, message));
const extensionVersion = chrome.runtime.getManifest().version;

const state = {
  step: 1 as Step,
  rows: [] as CheckRow[],
  /** The files in the helper's "My files" folder. */
  files: [] as MyFile[],
  /** Dropped files too big to send; shown until removed or the page closes. */
  tooBig: [] as MyFile[],
  /** Why no resume can be written from My files, as the helper's last status said. */
  profileProblem: null as string | null,
  /** Bumped on every add or remove, so a status that was already on its way cannot undo it. */
  filesVersion: 0,
};

// ─── DOM ──────────────────────────────────────────────────────────────

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[Seer Setup] setup.html has no #${id}`);
  return el as T;
}

function field<T extends HTMLElement>(root: ParentNode, name: string): T {
  const el = root.querySelector(`[data-field="${name}"]`);
  if (!el) throw new Error(`[Seer Setup] template has no [data-field="${name}"]`);
  return el as T;
}

function fromTemplate(id: string): HTMLLIElement {
  const template = byId<HTMLTemplateElement>(id);
  const li = template.content.firstElementChild?.cloneNode(true);
  if (!(li instanceof HTMLLIElement)) throw new Error(`[Seer Setup] template #${id} has no <li>`);
  return li;
}

/** Shows `text` in `el`, or hides `el` when there is none. */
function setText(el: HTMLElement, text: string | undefined): void {
  el.textContent = text ?? '';
  el.hidden = !text;
}

const loading = byId<HTMLDivElement>('loading');
const sections = new Map<Step, HTMLElement>(STEPS.map((n) => [n, byId(`step-${n}`)]));
const pills = new Map<Step, HTMLButtonElement>(STEPS.map((n) => [n, byId(`step-pill-${n}`)]));

const checkList = byId<HTMLUListElement>('check-list');
const checkAgainButton = byId<HTMLButtonElement>('check-again');
const checkNext = byId<HTMLButtonElement>('check-next');

const dropZone = byId<HTMLDivElement>('drop-zone');
const fileInput = byId<HTMLInputElement>('file-input');
const filesProgress = byId<HTMLParagraphElement>('files-progress');
const filesError = byId<HTMLParagraphElement>('files-error');
const filesEmpty = byId<HTMLParagraphElement>('files-empty');
const fileList = byId<HTMLUListElement>('file-list');
const filesProblem = byId<HTMLParagraphElement>('files-problem');
const filesBlocked = byId<HTMLParagraphElement>('files-blocked');
const filesNext = byId<HTMLButtonElement>('files-next');

const fitBar = byId<HTMLInputElement>('fit-bar');
const fitBarValue = byId<HTMLOutputElement>('fit-bar-value');
const writerSelect = byId<HTMLSelectElement>('writer');
const writerNotes = byId<HTMLTextAreaElement>('writer-notes');
const writerNotesCount = byId<HTMLElement>('writer-notes-count');
const outputDir = byId<HTMLElement>('output-dir');
const chooseOutput = byId<HTMLButtonElement>('choose-output');
const prefsError = byId<HTMLParagraphElement>('prefs-error');
const doneMessage = byId<HTMLDivElement>('done-message');

// ─── Errors ───────────────────────────────────────────────────────────

/** Logs the failure and shows it inline in `el`. */
function showError(el: HTMLElement, context: string, err: unknown): void {
  const message = errorMessage(err);
  console.error(`[Seer Setup] ${context}: ${message}`);
  setText(el, message);
}

// ─── Steps ────────────────────────────────────────────────────────────

function canEnter(step: Step): boolean {
  if (step === 1) return true;
  if (!allGreen(state.rows)) return false;
  return step === 2 || canLeaveFilesStep(state.files, state.profileProblem);
}

/** Step 1 while anything is red, step 2 until a file is read, then step 3. */
function startStep(): Step {
  if (canEnter(3)) return 3;
  return canEnter(2) ? 2 : 1;
}

function renderPills(): void {
  for (const [n, pill] of pills) {
    const current = n === state.step;
    pill.dataset.state = current ? 'current' : canEnter(n) ? 'open' : 'locked';
    pill.disabled = !current && !canEnter(n);
    if (current) pill.setAttribute('aria-current', 'step');
    else pill.removeAttribute('aria-current');
  }
}

function goTo(step: Step): void {
  if (!canEnter(step)) return;
  state.step = step;
  for (const [n, section] of sections) section.hidden = n !== step;
  renderPills();
  byId(`step-${step}-title`).focus();
}

// ─── Step 1: Check ────────────────────────────────────────────────────

function copyCommand(button: HTMLButtonElement, command: string): void {
  navigator.clipboard.writeText(command).then(
    () => {
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy'; }, COPIED_RESET_MS);
    },
    (err: unknown) => {
      console.error(`[Seer Setup] Could not copy the command: ${errorMessage(err)}`);
      button.textContent = 'Select and copy it';
    },
  );
}

function checkRowElement(row: CheckRow): HTMLLIElement {
  const li = fromTemplate('check-row');
  li.dataset.ok = String(row.ok);
  field(li, 'icon').textContent = row.ok ? '✓' : '!';
  field(li, 'label').textContent = row.label;
  field(li, 'state').textContent = row.ok ? ' — done' : ' — needs attention';
  setText(field(li, 'problem'), row.problem);
  setText(field(li, 'hint'), row.hint);
  const fixBox = field(li, 'fix-box');
  fixBox.hidden = !row.fix;
  if (row.fix) {
    const command = row.fix;
    field(li, 'fix').textContent = command;
    const copy = field<HTMLButtonElement>(li, 'copy');
    copy.addEventListener('click', () => copyCommand(copy, command));
  }
  return li;
}

function renderChecks(): void {
  checkList.replaceChildren(...state.rows.map(checkRowElement));
  checkNext.disabled = !allGreen(state.rows);
  renderPills();
}

function showOutputDir(dir: string | null): void {
  outputDir.textContent = dir ?? 'Not set yet';
  outputDir.title = dir ?? '';
}

async function readStatus(): Promise<{ status: HelperStatus | null; helperError: HelperError | null }> {
  try {
    return { status: await helper.status(), helperError: null };
  } catch (err) {
    console.error(`[Seer Setup] Status check failed: ${errorMessage(err)}`);
    const helperError = err instanceof HelperError ? err : new HelperError(errorMessage(err));
    return { status: null, helperError };
  }
}

async function runChecks(): Promise<void> {
  const filesVersion = state.filesVersion;
  const { status, helperError } = await readStatus();
  state.rows = checkRows({ status, helperError, extensionVersion });
  if (status) {
    if (filesVersion === state.filesVersion) {
      state.files = status.files;
      state.profileProblem = status.profileProblem;
    }
    showOutputDir(status.outputDir);
  }
  renderChecks();
  renderFiles();
}

let checking: Promise<void> | null = null;

/** Runs the checks unless they are already running; both callers wait for the same run. */
function checkAgain(): Promise<void> {
  if (checking) return checking;
  checkAgainButton.disabled = true;
  checkAgainButton.textContent = 'Checking…';
  checking = runChecks().finally(() => {
    checking = null;
    checkAgainButton.disabled = false;
    checkAgainButton.textContent = 'Check again';
  });
  return checking;
}

/**
 * Asks the helper again after files were added or removed, so the profile problem matches them. Until it
 * answers, nothing is assumed wrong. A check already on its way is discarded (filesVersion), so wait it out first.
 */
async function recheckFiles(): Promise<void> {
  state.profileProblem = null;
  renderFiles();
  if (checking) await checking;
  await checkAgain();
}

// ─── Step 2: Your files ───────────────────────────────────────────────

function byName(a: MyFile, b: MyFile): number {
  return a.name.localeCompare(b.name);
}

async function removeFile(file: MyFile, button: HTMLButtonElement): Promise<void> {
  if (file.status === 'too-big') {
    state.tooBig = state.tooBig.filter((f) => f.name !== file.name);
    renderFiles();
    return;
  }
  button.disabled = true;
  try {
    state.files = await helper.removeFile(file.name);
    state.filesVersion += 1;
    setText(filesError, undefined);
  } catch (err) {
    showError(filesError, `Could not remove ${file.name}`, err);
    renderFiles();
    return;
  }
  await recheckFiles();
}

function fileRowElement(file: MyFile): HTMLLIElement {
  const li = fromTemplate('file-row');
  li.dataset.read = String(file.status === 'read');
  field(li, 'name').textContent = file.name;
  field(li, 'name').title = file.name;
  field(li, 'status').textContent = fileStatusText(file);
  const remove = field<HTMLButtonElement>(li, 'remove');
  remove.setAttribute('aria-label', `Remove ${file.name}`);
  remove.title = `Remove ${file.name}`;
  remove.addEventListener('click', () => { void removeFile(file, remove); });
  return li;
}

function renderFiles(): void {
  const shown = [...state.files, ...state.tooBig];
  fileList.replaceChildren(...shown.map(fileRowElement));
  fileList.hidden = shown.length === 0;
  filesEmpty.hidden = shown.length > 0;
  setText(filesProblem, profileProblemText(state.files, state.profileProblem));
  filesBlocked.hidden = allGreen(state.rows);
  filesNext.disabled = !canEnter(3);
  renderPills();
}

/** Sends one file to the helper, or lists it as too big without sending it. */
async function addOne(file: File): Promise<void> {
  if (isTooBig(file.size)) {
    state.tooBig = [...state.tooBig.filter((f) => f.name !== file.name), tooBigFile(file)];
    return;
  }
  setText(filesProgress, `Adding ${file.name}…`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const added = await helper.addFile(file.name, toBase64(bytes), file.lastModified);
  state.files = [...state.files, added].sort(byName);
  state.filesVersion += 1;
}

/** Adds each file in turn; `failures` holds lines already known to fail (dropped folders). */
async function addFiles(files: File[], failures: string[] = []): Promise<void> {
  const versionBefore = state.filesVersion;
  for (const file of files) {
    try {
      await addOne(file);
    } catch (err) {
      console.error(`[Seer Setup] Could not add ${file.name}: ${errorMessage(err)}`);
      failures.push(`${file.name}: ${errorMessage(err)}`);
    }
    renderFiles();
  }
  setText(filesProgress, undefined);
  setText(filesError, failures.length > 0 ? failures.join('\n') : undefined);
  if (state.filesVersion !== versionBefore) await recheckFiles();
}

/** The files dropped on the drop zone, and the names of any folders, which cannot be sent. Read during the drop event. */
function droppedItems(data: DataTransfer | null): { files: File[]; folders: string[] } {
  const files: File[] = [];
  const folders: string[] = [];
  for (const item of Array.from(data?.items ?? [])) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry();
    const file = item.getAsFile();
    if (entry?.isDirectory) folders.push(entry.name);
    else if (file) files.push(file);
  }
  return { files, folders };
}

function wireFilesStep(): void {
  fileInput.accept = ACCEPTED_TYPES;
  byId('choose-files').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = '';
    void addFiles(files);
  });

  // A file dropped outside the drop zone would otherwise replace this page.
  for (const type of ['dragover', 'drop'] as const) {
    window.addEventListener(type, (event) => event.preventDefault());
  }
  dropZone.addEventListener('dragover', () => { dropZone.dataset.over = 'true'; });
  dropZone.addEventListener('dragleave', () => { dropZone.dataset.over = 'false'; });
  dropZone.addEventListener('drop', (event) => {
    dropZone.dataset.over = 'false';
    const { files, folders } = droppedItems(event.dataTransfer);
    for (const name of folders) console.error(`[Seer Setup] Could not add ${name}: it is a folder`);
    void addFiles(files, folders.map(folderFailure));
  });

  byId('open-files').addEventListener('click', () => {
    helper.openFolder('files').catch((err: unknown) => showError(filesError, 'Could not open My files', err));
  });
}

// ─── Step 3: Preferences ──────────────────────────────────────────────

function save(partial: Partial<SeerSettings>): void {
  saveSettings(partial).then(
    () => setText(prefsError, undefined),
    (err: unknown) => showError(prefsError, 'Could not save your preferences', err),
  );
}

function maxPagesRadios(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[name="max-pages"]'));
}

/** What storage holds for the extra instructions, so a blur without an edit saves nothing. */
let savedNotes = '';
let notesTimer: ReturnType<typeof setTimeout> | undefined;

function showNotesCount(): void {
  writerNotesCount.textContent = `${writerNotes.value.length} / ${MAX_WRITER_NOTES}`;
}

function saveNotes(): void {
  clearTimeout(notesTimer);
  if (writerNotes.value === savedNotes) return;
  savedNotes = writerNotes.value;
  save({ writerNotes: savedNotes });
}

function onNotesInput(): void {
  showNotesCount();
  clearTimeout(notesTimer);
  notesTimer = setTimeout(saveNotes, NOTES_SAVE_DELAY_MS);
}

async function loadSettings(): Promise<void> {
  try {
    const settings = await getSettings();
    fitBar.value = String(settings.minScore);
    fitBarValue.textContent = fitBar.value;
    writerSelect.value = settings.claudeModel;
    writerNotes.value = settings.writerNotes;
    savedNotes = settings.writerNotes;
    showNotesCount();
    for (const radio of maxPagesRadios()) radio.checked = radio.value === String(settings.maxPages);
  } catch (err) {
    showError(prefsError, 'Could not load your preferences', err);
  }
}

async function chooseSaveFolder(): Promise<void> {
  chooseOutput.disabled = true;
  try {
    const picked = await helper.chooseFolder();
    if (picked !== null) {
      showOutputDir(await helper.setOutput(picked));
      setText(prefsError, undefined);
    }
  } catch (err) {
    showError(prefsError, 'Could not change the save folder', err);
  }
  chooseOutput.disabled = false;
}

function wirePreferencesStep(): void {
  for (const model of CLAUDE_MODELS) writerSelect.add(new Option(model.label, model.id));

  fitBar.addEventListener('input', () => { fitBarValue.textContent = fitBar.value; });
  fitBar.addEventListener('change', () => save({ minScore: Number(fitBar.value) }));
  for (const radio of maxPagesRadios()) {
    radio.addEventListener('change', () => save({ maxPages: radio.value === '2' ? 2 : 1 }));
  }
  writerSelect.addEventListener('change', () => save({ claudeModel: writerSelect.value }));
  showNotesCount();
  writerNotes.addEventListener('input', onNotesInput);
  writerNotes.addEventListener('blur', saveNotes);
  // Closing the tab within the save delay would otherwise lose the last edit.
  window.addEventListener('pagehide', saveNotes);

  chooseOutput.addEventListener('click', () => { void chooseSaveFolder(); });
  byId('open-output').addEventListener('click', () => {
    helper.openFolder('resumes').catch((err: unknown) => showError(prefsError, 'Could not open the save folder', err));
  });
  byId('done').addEventListener('click', () => {
    doneMessage.hidden = false;
    doneMessage.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

// ─── Start ────────────────────────────────────────────────────────────

function wireNavigation(): void {
  for (const [n, pill] of pills) pill.addEventListener('click', () => goTo(n));
  checkNext.addEventListener('click', () => goTo(2));
  filesNext.addEventListener('click', () => goTo(3));
  for (const back of document.querySelectorAll<HTMLButtonElement>('[data-back]')) {
    back.addEventListener('click', () => goTo(state.step === 3 ? 2 : 1));
  }
  checkAgainButton.addEventListener('click', () => { void checkAgain(); });
  // Back from Terminal or Finder: the user may have fixed something or changed the folder.
  window.addEventListener('focus', () => {
    if (state.step !== 3) void checkAgain();
  });
}

async function init(): Promise<void> {
  wireNavigation();
  wireFilesStep();
  wirePreferencesStep();
  await Promise.all([loadSettings(), checkAgain()]);
  loading.hidden = true;
  goTo(startStep());
}

init().catch((err: unknown) => {
  console.error(`[Seer Setup] The setup page could not start: ${errorMessage(err)}`);
  setText(byId('loading-text'), `The setup page could not start: ${errorMessage(err)}`);
});
