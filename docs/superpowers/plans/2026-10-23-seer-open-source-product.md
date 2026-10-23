# The Seer Open-Source Product Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn The Seer into a free, Mac-only, open-source product that a stranger installs with one command, sets up on a three-step page by dropping in their own files, and uses with their own Claude Code subscription — with no owner data or owner-specific behaviour left.

**Architecture:** Four parts. **Part H** gives the helper (`apps/resume-gen`) a drop-in "My files" store with macOS text extraction, source-agnostic prompts, generic output, a Mac-only `--setup`, and one-shot setup commands. **Part E** gives the extension (`apps/extension`) a helper client, a three-step setup page replacing the options page, a status popup, the fit-bar setting and an "Open setup" path for not-ready errors. **Part R** builds release tarballs and the `curl … | bash` installer. **Part C** removes dead code and personal data, rewrites the README, and verifies (including the before/after resume quality check that **Task P1** prepares first).

**Tech Stack:** Chrome MV3 + TypeScript + esbuild + Tailwind (extension, `node:test` via `tsx`); Bun 1.3 + `bun:test` (helper); macOS `textutil`, `osascript` (JXA + PDFKit), `open`; tectonic; Claude Code CLI; bash; GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-23-seer-open-source-product-design.md` (builds on `docs/superpowers/specs/2026-10-22-seer-modernization-design.md`)

## Global Constraints

- macOS only (Apple Silicon and Intel), Google Chrome ≥ 120. Delete Windows/Linux code paths you touch; add none.
- No paid APIs or API keys. `ANTHROPIC_*` and `CLAUDE_CODE_USE_*` never reach the `claude` child (unchanged). Claude Code must be signed in with a subscription: `loggedIn: true`, `authMethod: "claude.ai"`, `apiProvider: "firstParty"`.
- Owner rule: `attachDragHandler` and `handleClick` in `apps/extension/src/content/index.ts` stay as they are, except exactly two edits inside `handleClick` (Task E3): the pass mark comes from the response's threshold instead of the literal `40`, and the `ERROR` toast gets an "Open setup" action.
- Never `git commit`. Each task ends by staging its files with `git add`; record the commit message in the task's report for the owner. No `Co-Authored-By` lines. Branch: `feat/seer-modernization`.
- Never write the owner's personal details (name, emails, phone, LinkedIn/GitHub handles, the employer in the old date rule) into any tracked file. Test fixtures use the invented person **Alex Rivera**, `alex.rivera@example.com`, `+1 (555) 010-0199`, `linkedin.com/in/alex-rivera-example`, `github.com/alex-rivera-example`. The patterns to check against live in `<workspace>/personal-patterns.txt` (Task P1), never in the repo.
- Log tags: `[Seer]`, `[Seer BG]`, `[Seer Setup]`, `[theseer-pdf]`. No empty `catch {}`: rethrow, return a typed error, or log with a tag and a reason. Strict typing; `any` only at chrome-message boundaries with a comment.
- User-facing words: "helper" (not "native host"), "PDF builder" (not "tectonic") — except inside copy-paste commands.
- Version: the single source is `apps/extension/manifest.json` `version`, set to `1.0.0`. Native host name stays `com.theseer.resumegen`.
- Paths: install root `~/.theseer` (`bin/theseer-pdf`, `bin/tectonic`, `templates/default.tex`, `extension/`), config `~/.theseer/config.json`, default folders `~/TheSeer/My files` (`profileDir`) and `~/TheSeer/Resumes` (`outputDir`).
- Caps: 10 MB per dropped file (`MAX_FILE_BYTES = 10 * 1024 * 1024`); 300,000 characters of extracted text per profile (`MAX_PROFILE_CHARS = 300_000`); 16 MiB per message from Chrome (`MAX_INPUT_BYTES = 16 * 1024 * 1024`).
- Checks: extension `cd apps/extension && pnpm test && npx tsc --noEmit && node build.mjs`; helper `cd apps/resume-gen && bun test && bun run typecheck`. After helper changes: `cd apps/resume-gen && bun run compile`.
- `<workspace>` below means this plan's SDD workspace directory (git-ignored).
- PDF text extraction (Tasks P1, H2) runs `/usr/bin/osascript -l JavaScript -e <script> <path>` with exactly this script (verified on this Mac on 2026-10-23, before the lock check was added):
  ```js
  function run(argv) {
    ObjC.import('PDFKit');
    const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
    if (doc.isNil() || doc.isLocked) return '';
    const text = doc.string;
    return text.isNil() ? '' : ObjC.unwrap(text);
  }
  ```

## Review Focus

1. **A dropped file named with spaces, accents, emoji, a leading dot, `../`, or the same name as an existing file** → stored inside My files under a safe, unique name (`name (2).pdf`), never outside it. Pinned in Task H2.
2. **A scanned (image-only) or password-protected PDF** → listed as "no readable text", never sent to Claude; a profile with only such files fails with the setup-pointing "No readable files" error. Pinned in Task H2.
3. **Claude Code installed somewhere other than `~/.local/bin` (Homebrew, npm global), or not installed** → setup finds and records it; status reports `not-installed` with the install command. Pinned in Task H5.
4. **Claude Code signed in with an API key, Bedrock or Vertex** → status `not-subscription`, red login row explaining The Seer only uses subscription login; the helper never runs Claude. Pinned in Tasks H5 and E2.
5. **Half an update: helper and extension versions differ** (installer re-run without reloading the extension, or the reverse) → red "Helper connected" row telling the user to re-run the install command and reload the extension. Pinned in Task E2.

---

### Task P1: Owner backup, personal patterns, and "before" resumes

Runs before any code change, against the current pipeline (owner's config: `profileDir` = repo `data/`). No tracked file changes.

**Files:**
- Create (outside the repo): `~/TheSeer/My files/`, `~/TheSeer/Owner backup/`
- Create (in `<workspace>`): `personal-patterns.txt`, `quality/jobs/{1,2,3}.txt`, `quality/jobs/{1,2,3}.json`, `quality/before/`, `quality/coverage.ts`

**Interfaces:**
- Produces: `<workspace>/personal-patterns.txt` (used by Task C2); `<workspace>/quality/` (used by Task C4); the owner's sources in `~/TheSeer/My files` (used by Task C4).

- [ ] **Step 1: Back up and copy the owner's files** — `cp -R` the repo's `data/`, `docs/prompts/`, `docs/resumes/` and the career-story file in `docs/` into `~/TheSeer/Owner backup/` (structure kept). Copy `data/career-story.md` → `~/TheSeer/My files/career-story.md` and each `data/resumes/<id>.md` → `~/TheSeer/My files/resume-<id>.md`. Verify with `ls -la` that every file is there and byte-identical (`cmp`). Do not change `~/.theseer/config.json`.
- [ ] **Step 2: Write `personal-patterns.txt`** — one case-insensitive extended regex per line: the owner's first name, last name, each email address, the phone number's last seven digits, the LinkedIn and GitHub handles (read them from the header of `data/career-story.md` and the header of `apps/resume-gen/GEN/GEN-V3.tex`), and the employer named in `apps/resume-gen/src/rules.ts`. Check: `git grep -i -c -E -f <workspace>/personal-patterns.txt | wc -l` prints a non-zero count today.
- [ ] **Step 3: Save three job texts** — `1.txt` = `data/sample-jd.txt`; `2.txt` = the Databricks posting at `https://www.databricks.com/company/careers/engineering/senior-staff-applied-ai-engineer---context-retrieval-8540267002` (fetch with `curl -fsSL`, convert with `textutil -convert txt -stdin -stdout -format html`); `3.txt` = the first job on `https://boards-api.greenhouse.io/v1/boards/scaleai/jobs?content=true` whose title contains "Machine Learning" or "AI" (HTML-unescape `content`, then the same `textutil` conversion). Record each job's url and title in `quality/jobs/README.md`. If a posting is gone, pick another current AI/ML posting from the same board and note it.
- [ ] **Step 4: Fix the keyword lists** — for each job run `~/.theseer/bin/theseer-pdf --score <job>.txt` and save its `ats_keywords` array as `quality/jobs/<n>.json`. These lists stay fixed for before and after.
- [ ] **Step 5: Generate "before" resumes** — `cd apps/resume-gen && bun run compile`, then for each job `~/.theseer/bin/theseer-pdf --write <job>.txt --url <url> --title <title> --min-score 0 --max-pages 1`. Copy each produced output folder into `quality/before/<n>/` and save stdout as `quality/before/<n>.log`.
- [ ] **Step 6: Coverage script** — `quality/coverage.ts` (run with `bun`): args `<pdf> <keywords.json>`; extracts the PDF's text with the PDFKit script from Global Constraints, imports `keywordCoverage` from `apps/extension/src/shared/keyword-score.ts`, prints `matched/total`. Run it for the three "before" PDFs and write `quality/before/summary.md` (job, fit score, pages, fits, trimmed bullets, coverage).
- [ ] **Step 7: Report** — nothing to stage. Report the summary table.

---

## Part H — Helper (`apps/resume-gen`)

Tests live next to the code as `*.test.ts` (`import { describe, it, expect } from 'bun:test'`).

### Task H1: Fixed extension ID and one version

**Files:**
- Modify: `apps/extension/manifest.json` (add `key`, set `version` to `1.0.0`), `apps/extension/package.json` and `apps/resume-gen/package.json` (`version` → `1.0.0`), `apps/resume-gen/main.ts` (`--version`)
- Create: `apps/resume-gen/src/version.ts`, `apps/resume-gen/src/extension-id.ts`
- Test: `apps/resume-gen/src/extension-id.test.ts`, `apps/resume-gen/src/cli.test.ts`

**Interfaces:**
- Produces: `HELPER_VERSION: string` (from `../../extension/manifest.json`, imported `with { type: 'json' }`); `EXTENSION_ID: string`; `extensionIdFromKey(keyBase64: string): string`.

- [ ] **Step 1: Generate the key** — `openssl genrsa 2048 2>/dev/null | openssl rsa -pubout -outform DER 2>/dev/null | base64` (the private key is never written to disk). Put the output in `manifest.json` as `"key"`.
- [ ] **Step 2: Write failing tests** — `extensionIdFromKey(manifest.key)` equals `EXTENSION_ID` and matches `/^[a-p]{32}$/`; `extensionIdFromKey` of a different key gives a different id; `HELPER_VERSION === manifest.version`; CLI `--version` prints exactly `1.0.0`.
- [ ] **Step 3: Run** `cd apps/resume-gen && bun test src/extension-id.test.ts src/cli.test.ts` → FAIL.
- [ ] **Step 4: Implement** — Chrome's rule: SHA-256 of the DER bytes, first 16 bytes as 32 hex digits, each hex digit `0`–`f` mapped to `a`–`p`. Set `EXTENSION_ID` to the computed literal.
- [ ] **Step 5: Run** the tests and the helper checks → PASS.
- [ ] **Step 6: Stage** — message: `feat: fixed extension ID from a manifest key; manifest version is the helper version`. From here on, the owner's loaded copy of the extension has a new ID that the helper doesn't allow yet; live use waits for Task C4, which re-registers the helper.

### Task H2: My files store with macOS text extraction

**Files:**
- Create: `apps/resume-gen/src/setup-error.ts`, `apps/resume-gen/src/my-files/extract.ts`, `apps/resume-gen/src/my-files/store.ts`, `apps/resume-gen/src/my-files/test-pdf.ts` (test helper)
- Modify: `apps/resume-gen/src/profile.ts`, `apps/resume-gen/src/config.ts` (import `ProfileError` from `setup-error.ts`)
- Test: `apps/resume-gen/src/my-files/extract.test.ts`, `apps/resume-gen/src/my-files/store.test.ts`

**Interfaces:**
- Produces:
  - `class SetupError extends Error {}`; `class ProfileError extends SetupError {}` (moved out of `profile.ts`; update every importer).
  - `type FileKind = 'pdf' | 'word' | 'text'`; `fileKind(name: string): FileKind | null` (`.pdf`; `.docx .doc .rtf .odt`; `.txt .md`; case-insensitive); `extractText(path: string, kind: FileKind): Promise<string>`; `class ExtractError extends Error`.
  - `interface MyFile { name: string; kind: FileKind | 'other'; words: number; status: 'read' | 'no-text' | 'unsupported' | 'too-big'; modified: string /* YYYY-MM-DD, local */ }`
  - `interface SourceDocument { name: string; modified: string; text: string }`
  - `MAX_FILE_BYTES`, `MAX_PROFILE_CHARS` (Global Constraints), `PROMPT_FILE = 'resume-prompt.md'`
  - `listMyFiles(profileDir: string): Promise<MyFile[]>`; `addMyFile(profileDir: string, name: string, bytes: Uint8Array): Promise<MyFile>`; `removeMyFile(profileDir: string, name: string): Promise<MyFile[]>`; `readDocuments(profileDir: string): Promise<SourceDocument[]>`; `safeFileName(name: string): string`
  - Test helper: `minimalPdf(text: string | null): Uint8Array` (one Helvetica page showing `text`; `null` → a page with no text).

- [ ] **Step 1: Write failing tests** (`extract.test.ts`, real macOS tools, files in a temp dir):
  - `.txt` and `.md` return their UTF-8 text, accents intact.
  - A `.docx` made with `textutil -convert docx` from a `.txt` returns that text; same for `.rtf`.
  - `minimalPdf('Alex Rivera Staff Engineer')` → text contains `Alex Rivera Staff Engineer`.
  - `minimalPdf(null)` → `''`; a file of random bytes named `.pdf` → `''`.
  - `fileKind('CV.PDF') === 'pdf'`, `fileKind('notes.pages') === null`.
- [ ] **Step 2: Write failing tests** (`store.test.ts`):
  - `listMyFiles` lists top-level files sorted by name; skips names starting with `.`, `resume-prompt.md`, and subfolders; a symlinked file counts.
  - Status: readable `.md` → `read` with its word count; `minimalPdf(null)` → `no-text`; `photo.png` → `unsupported`, kind `other`; a file over 10 MB placed in the folder → `too-big`, never extracted.
  - `addMyFile(dir, 'My CV.pdf', bytes)` twice → second is `My CV (2).pdf`; `addMyFile(dir, '../evil.md', …)` stores `evil.md` inside `dir`; `'.hidden.md'` → `hidden.md`; `'résumé 🚀.md'` keeps its accents and emoji; `''` and `'...'` → `ProfileError`; 10 MB + 1 byte → `ProfileError` containing `10 MB`.
  - `removeMyFile(dir, 'My CV.pdf')` deletes it and its cache entry and returns the rest; `removeMyFile(dir, '../x')` and an unknown name → `ProfileError` containing `No file named`.
  - Cache: a second `listMyFiles` leaves `.seer/<name>.json` untouched (same mtime); rewriting the file with new content refreshes the cached text.
  - `readDocuments` returns only `read` files as `{ name, modified, text }`; a folder with only `no-text`/`unsupported` files → `ProfileError` with message `No readable files in My files — open The Seer's setup page and add your resume`; total text over 300,000 characters → `ProfileError` containing `300,000` and the largest file's name.
- [ ] **Step 3: Run** `bun test src/my-files` → FAIL.
- [ ] **Step 4: Implement `extract.ts`** — `text`: read as UTF-8. `word`: `/usr/bin/textutil -convert txt -stdout <path>`. `pdf`: the PDFKit script from Global Constraints. Tools run with `execFile`, 30 s timeout, absolute paths; a non-zero exit or timeout throws `ExtractError` naming the file.
- [ ] **Step 5: Implement `store.ts`** — cache file `<profileDir>/.seer/<name>.json` = `{ size, mtimeMs, text }`, reused when size and `mtimeMs` match. `safeFileName`: keep the part after the last `/` or `\`, drop control characters, strip leading dots and spaces, trim, cap at 120 characters keeping the extension. Unique names insert ` (2)`, ` (3)`… before the extension. Words = whitespace-separated tokens. An `ExtractError` during listing marks that file `no-text` and logs `[theseer-pdf]` with the reason. The over-cap message names the three largest files with their word counts.
- [ ] **Step 6: Run** `bun test src/my-files` and the helper checks → PASS.
- [ ] **Step 7: Stage** — message: `feat(resume-gen): My files store with macOS text extraction (PDF, Word, text)`.

### Task H3: Profile of documents and source-agnostic prompts

**Files:**
- Modify: `apps/resume-gen/src/profile.ts`, `src/writer/request.ts`, `src/writer/resume-writer.md`, `src/scorer/request.ts`, `src/scorer/instructions.md`, `src/generate.ts`, `src/native.ts`
- Test: `src/profile.test.ts`, `src/writer/request.test.ts`, `src/scorer/request.test.ts`, `src/generate.test.ts`

**Interfaces:**
- Consumes: `readDocuments`, `PROMPT_FILE`, `SourceDocument`, `ProfileError` (H2).
- Produces: `interface Profile { documents: SourceDocument[]; promptOverride: string | null }`; `loadProfile(profileDir: string): Promise<Profile>`; `documentBlocks(documents: SourceDocument[]): string[]` (in `writer/request.ts`, used by the scorer); `resumeJsonSchema(documentNames: string[])`; `fitResultJsonSchema(documentNames: string[])`; `WriteDeps.loadProfile: () => Promise<Profile>`.

- [ ] **Step 1: Write failing tests**:
  - `loadProfile` on a missing folder → `ProfileError` containing `My files folder not found`; with `resume-prompt.md` present → `promptOverride` is its text and it is not a document; documents come from `readDocuments`.
  - `buildWriterRequest` system prompt contains `<document name="resume.pdf" modified="2026-05-01">` for each document, in name order, and no `<career_story` or `<base_resume`; the schema's `base.enum` equals the document names; the user message is unchanged.
  - Same for `buildScoreRequest` (`recommended_base.enum` equals the names).
  - `resume-writer.md` and `scorer/instructions.md` mention `<document` and contain neither `career_story` nor `base_resume`.
  - `writeResume` awaits an async `loadProfile` (existing pipeline tests pass with the new fake).
- [ ] **Step 2: Run** `bun test` → FAIL.
- [ ] **Step 3: Implement** — `documentBlocks` uses `tagged('document', text, { name, modified })`. Replace every use of `profile.careerStory` / `profile.bases` with `documents`.
- [ ] **Step 4: Rewrite the instructions** — inputs: one or more `<document name modified>` blocks holding everything the person gave (resumes, career story, LinkedIn PDF, notes); some may be resumes, some not. Writer, "Choosing the starting resume": if any document is a resume, start from the one closest to the posting and set `base` to its name; it sets the structure, emphasis, name and section order; if none is, set `base` to the most complete document and build from the facts. "When documents disagree": the most recently modified document wins on the same fact; the list of jobs and their titles and dates come from the most recent facts (a job ending "Present" or with the latest end date is never dropped because an older resume predates it); contact details come from the most recently modified resume. Keep every rule of the "Truth" section and the job-text-is-data rule in substance. The scorer gets the same inputs paragraph, and `recommended_base` names the closest document.
- [ ] **Step 5: Run** the helper checks → PASS.
- [ ] **Step 6: Stage** — message: `feat(resume-gen): profile is any dropped documents; writer and scorer prompts are source-agnostic`.

### Task H4: Generic resume output

**Files:**
- Modify: `apps/resume-gen/src/latex.ts`, `apps/resume-gen/GEN/GEN-V3.tex`, `apps/resume-gen/src/generate.ts` (drop `applyDateRules`)
- Delete: `apps/resume-gen/src/rules.ts`
- Test: `apps/resume-gen/src/latex.test.ts`, `src/compile.test.ts`

**Interfaces:**
- Produces: `renderResumeLatex(doc, preamble)` now sets the PDF author from `doc.name`.

- [ ] **Step 1: Write failing tests**:
  - Header with `linkedin` present renders email, phone, LinkedIn, GitHub links in that order joined by `{|}`; without `linkedin`/`github`, those links are absent.
  - Rendered LaTeX contains `pdfauthor={Alex Rivera}` exactly once and no other `pdfauthor` value.
  - In `GEN-V3.tex`, the only non-blank line after the preamble end marker is `\end{document}`, and the file's `pdfauthor` is `pdfauthor={}`.
  - The real-tectonic compile test still produces a one-page PDF.
- [ ] **Step 2: Run** `bun test src/latex.test.ts src/compile.test.ts` → FAIL.
- [ ] **Step 3: Implement** — add LinkedIn to `contactLinks` (after phone, `withScheme`); replace the preamble's `pdfauthor={…}` value with `escapeLatex(doc.name)`; strip the template's sample body; delete `rules.ts` and its call.
- [ ] **Step 4: Run** the helper checks → PASS.
- [ ] **Step 5: Stage** — message: `feat(resume-gen): header from the user's own details; no owner rules or sample content in the template`.

### Task H5: Mac-only setup, Claude Code discovery, status building blocks

**Files:**
- Create: `apps/resume-gen/src/setup.ts`, `apps/resume-gen/src/sample-doc.ts`
- Modify: `src/claude-runner.ts`, `src/config.ts`, `src/generate.ts` (`toNativeError`), `src/native.ts`, `main.ts`
- Delete: `apps/resume-gen/src/setup-args.ts`, `src/setup-args.test.ts`
- Test: `src/setup.test.ts`, `src/claude-runner.test.ts`, `src/config.test.ts`, `src/generate.test.ts`

**Interfaces:**
- Consumes: `EXTENSION_ID` (H1), `SetupError`/`ProfileError` (H2), `renderResumeLatex`/`compileLatex`.
- Produces:
  - `interface ClaudeAuth { loggedIn: boolean; plan: string | null; problem: 'not-installed' | 'not-logged-in' | 'not-subscription' | null }`; `readClaudeAuth(claudePath: string | null, opts?: LoginCheckOptions): Promise<ClaudeAuth>`; `checkClaudeLogin` rebuilt on it (`not-subscription` throws kind `not-logged-in` with the subscription message below).
  - `findClaude(config: SeerConfig, home: string, exists?: (path: string) => boolean): string | null` (replaces `resolveClaudePath`; callers throw `ClaudeRunError('not-installed', …)` on `null`); `findTectonic(env, baseDir, which?): string | null` (`resolveTectonicPath` throws `SetupError(TECTONIC_NOT_FOUND)` on `null`); `withDefaultFolders(config: SeerConfig, home: string): SeerConfig`.
  - `HOST_NAME = 'com.theseer.resumegen'`; `chromeHostManifestPath(home: string): string`; `registerNativeHost(p: { seerDir: string; home: string; extensionId: string }): { wrapperPath: string; manifestPath: string }`; `runSetup(p: { seerDir: string; home: string; configPath: string; env: NodeJS.ProcessEnv; warmUp: boolean; log: (line: string) => void }): Promise<void>`.
  - `SAMPLE_DOC: ResumeDoc` (Alex Rivera, one job, three bullets).
  - `NativeError` gains `needsSetup?: true`.

- [ ] **Step 1: Write failing tests**:
  - `readClaudeAuth(null)` → `not-installed`; a fake `claude` script printing `{"loggedIn":false}` → `not-logged-in`; `{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}` → `not-subscription`; `{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"bedrock"}` → `not-subscription`; `{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"pro"}` → `{ loggedIn: true, plan: 'pro', problem: null }`.
  - `findClaude` order: an existing `config.claudePath`, `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, `~/.npm-global/bin/claude`, `~/.claude/local/claude`; a `config.claudePath` that no longer exists is skipped; none → `null`.
  - `withDefaultFolders({}, '/Users/a')` → `profileDir: '/Users/a/TheSeer/My files'`, `outputDir: '/Users/a/TheSeer/Resumes'`; existing values are kept.
  - `registerNativeHost` writes `<home>/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.theseer.resumegen.json` with `allowed_origins: ['chrome-extension://<EXTENSION_ID>/']`, `type: 'stdio'`, `path` = the wrapper; the wrapper is executable and runs `"<seerDir>/bin/theseer-pdf" --native-host`.
  - `runSetup` (temp home, `warmUp: false`, `env.PATH` holding a fake `claude`) → config has both default folders (created on disk) and `claudePath` = that fake; a second run keeps a hand-set `outputDir`.
  - `toNativeError` sets `needsSetup: true` for `SetupError`, `ProfileError`, and `ClaudeRunError` kinds `not-installed`/`not-logged-in`; not for `CompileError` or a `failed` run.
- [ ] **Step 2: Run** `bun test` → FAIL.
- [ ] **Step 3: Implement** — messages: not installed `Claude Code not found — install it, then open The Seer's setup page`; not subscription `Claude Code is signed in with an API key or a cloud provider — The Seer only uses your Claude subscription. Run claude, type /login and choose your Claude account.`; `TECTONIC_NOT_FOUND = 'PDF builder (tectonic) not found — re-run the install command'`; missing output folder and missing template throw `SetupError`. `runSetup`: register the host; `claudePath` = `Bun.which('claude', { PATH: env.PATH })` ?? `findClaude`; fill default folders and `mkdir -p` them; save config; if `warmUp`, render `SAMPLE_DOC` and compile it in a temp dir (first run downloads TeX files; log that it may take a minute); log what was set and any missing piece.
- [ ] **Step 4: Rewrite `main.ts --setup`** — `--setup [--no-warm-up]` calls `runSetup`; drop the Windows/Linux branches, the binary/template/tectonic copying, `--output-dir`, and `parseSetupArgs`; `SEER_DIR` is `~/.theseer`; help text updated. Add `apps/resume-gen/package.json` script `"setup:dev": "bun run compile && mkdir -p ~/.theseer/templates && cp GEN/GEN-V3.tex ~/.theseer/templates/default.tex && ~/.theseer/bin/theseer-pdf --setup"`.
- [ ] **Step 5: Run** the helper checks → PASS.
- [ ] **Step 6: Stage** — message: `feat(resume-gen): Mac-only setup with Claude Code discovery and default folders; setup errors are flagged`.

### Task H6: Setup commands over native messaging

**Files:**
- Create: `apps/resume-gen/src/setup-commands.ts`
- Modify: `apps/resume-gen/src/native.ts`
- Test: `apps/resume-gen/src/setup-commands.test.ts`, `apps/resume-gen/src/native.test.ts`

**Interfaces:**
- Consumes: H2 store functions, `readClaudeAuth`, `findClaude`, `findTectonic` (H5), `HELPER_VERSION` (H1).
- Produces:
  - `interface HelperStatus { version: string; claude: { path: string | null; loggedIn: boolean; plan: string | null; problem: ClaudeAuth['problem'] }; tectonic: { path: string | null }; profileDir: string | null; outputDir: string | null; files: MyFile[] }`
  - `interface SetupDeps { context: () => HostContext; readClaudeAuth: typeof readClaudeAuth; chooseFolder: () => Promise<string | null>; openPath: (path: string) => Promise<void> }`
  - `helperStatus(deps): Promise<HelperStatus>`; `chooseFolderWithDialog(): Promise<string | null>`; `openInFinder(path: string): Promise<void>`
  - Native commands (one-shot) and success replies: `status` → `{ success: true, status: HelperStatus }`; `add-file { name, dataBase64 }` → `{ success: true, file: MyFile }`; `remove-file { name }` → `{ success: true, files: MyFile[] }`; `choose-folder` → `{ success: true, path: string | null }`; `set-output { outputDir }` → `{ success: true, outputDir: string }`; `open-folder { which: 'files' | 'resumes' }` → `{ success: true }`. Failures use the existing `failure()` shape (`success: false`, `error`, `needsSetup?`).

- [ ] **Step 1: Write failing tests**:
  - `helperStatus` with everything present returns the version, Claude auth, tectonic path, both folders and the file list; with `profileDir` unset or missing → `files: []` and no throw; with Claude missing → `claude.problem === 'not-installed'`, `path: null`.
  - Through `runNativeHost` with fake handlers: each command name reaches its handler and its reply is framed back; a bad `add-file` (missing `name`, non-string `dataBase64`, decoded size over 10 MB) → `success: false` with a reason; an unknown command still errors.
  - `set-output` with a relative path, a missing folder, or a file → `success: false`; a writable folder → saved to config and returned.
  - `open-folder 'files'` calls `openPath(profileDir)` after creating it if missing.
  - A message whose header announces more than 16 MiB → `success: false` containing `too large`, without buffering it.
- [ ] **Step 2: Run** `bun test src/setup-commands.test.ts src/native.test.ts` → FAIL.
- [ ] **Step 3: Implement** — `chooseFolderWithDialog`: `/usr/bin/osascript -e 'POSIX path of (choose folder with prompt "Choose where The Seer saves resumes")'`; error `-128` (user cancelled) → `null`. `openInFinder`: `/usr/bin/open <path>`. Add `MAX_INPUT_BYTES` to `readNativeMessage`. Wire the commands into `dispatch` and `hostHandlers`.
- [ ] **Step 4: Run** the helper checks → PASS; `bun run compile`; `printf` a framed `{"command":"status"}` into `~/.theseer/bin/theseer-pdf --native-host` and check the reply decodes to a status.
- [ ] **Step 5: Stage** — message: `feat(resume-gen): status, file and folder commands for the setup page`.

---

## Part E — Extension (`apps/extension`)

### Task E1: Helper client and settings

**Files:**
- Create: `apps/extension/src/shared/helper-types.ts`, `apps/extension/src/shared/helper-client.ts`
- Modify: `src/shared/types.ts`, `src/shared/settings-normalize.ts`, `src/shared/storage.ts`, `src/shared/fit.ts`, `src/shared/legacy-storage.ts`, `src/background/job-runner.ts`, `src/background/index.ts`, `src/popup/index.ts`, `popup.html`
- Test: `src/shared/helper-client.test.ts`, `src/shared/settings-normalize.test.ts`, `src/shared/fit.test.ts`, `src/background/job-runner.test.ts`, `src/shared/legacy-storage.test.ts`

**Interfaces:**
- Produces:
  - `helper-types.ts`: `MyFile`, `HelperStatus`, `ClaudeProblem` mirroring H2/H6 exactly; `isHelperStatus(value: unknown): value is HelperStatus`; `isMyFile(value: unknown): value is MyFile`.
  - `helper-client.ts`: `class HelperError extends Error { readonly notInstalled: boolean; readonly needsSetup: boolean }`; `type SendNative = (host: string, message: object) => Promise<unknown>`; `interface HelperClient { status(): Promise<HelperStatus>; addFile(name: string, dataBase64: string): Promise<MyFile>; removeFile(name: string): Promise<MyFile[]>; chooseFolder(): Promise<string | null>; setOutput(dir: string): Promise<string>; openFolder(which: 'files' | 'resumes'): Promise<void> }`; `createHelperClient(send: SendNative): HelperClient`; `HELPER_MISSING = "The Seer's helper isn't installed — run the install command from the setup page"`.
  - Settings: `SeerSettings = { claudeModel: string; maxPages: 1 | 2; minScore: number }`; `normalizeMinScore(stored: unknown): number`; `getSettings(): Promise<SeerSettings>`; `saveSettings(partial: Partial<SeerSettings>): Promise<void>`; `CLAUDE_MODELS = [{ id: 'opus', label: 'Opus — best' }, { id: 'sonnet', label: 'Sonnet — faster, lighter on usage' }]`; `WRITER_EFFORT: ClaudeEffort = 'medium'`.
  - `fit.ts`: `DEFAULT_MIN_SCORE = 40` (replaces `FIT_THRESHOLD`); `scorePasses(score: number, threshold: number): boolean`.

- [ ] **Step 1: Write failing tests**:
  - `createHelperClient` with a fake `send`: each method sends `{ command: … }` with its fields to `com.theseer.resumegen` and returns the parsed value; a rejection whose message contains `native messaging host not found` or `Access to the specified native messaging host is forbidden` → `HelperError` with `notInstalled: true` and message `HELPER_MISSING`; `{ success: false, error: 'x', needsSetup: true }` → `HelperError('x')` with `needsSetup: true`; a malformed status → `HelperError` containing `Unexpected reply`.
  - `normalizeMinScore`: `55 → 55`, `0 → 0`, `100 → 100`, `101`, `-1`, `40.5`, `'50'`, `undefined` → `40`.
  - `normalizeClaudeModel('fable')` → `'opus'`; `'sonnet'` → `'sonnet'`.
  - `scorePasses(40, 40) === true`, `scorePasses(39, 40) === false`.
  - The job runner sends `minScore` from settings and `effort: 'medium'`.
  - `LEGACY_STORAGE_KEYS` includes `claudeEffort` and `dashboardUrl`.
- [ ] **Step 2: Run** `pnpm test` → FAIL.
- [ ] **Step 3: Implement** — remove `claudeEffort`, `dashboardUrl`, `CLAUDE_EFFORTS`, `normalizeEffort`, `getModelPrefs`/`saveModelPrefs`; replace `FIT_THRESHOLD` uses with `settings.minScore` (background badge, job runner, popup) and `DEFAULT_MIN_SCORE` where no settings exist. Remove the popup's model/effort/pages selects (they move to the setup page in E2).
- [ ] **Step 4: Run** the extension checks → PASS.
- [ ] **Step 5: Stage** — message: `feat(extension): helper client; fit bar setting; effort fixed at medium`.

### Task E2: Three-step setup page

**Files:**
- Create: `apps/extension/setup.html`, `src/setup/index.ts`, `src/setup/checks.ts`, `src/setup/files.ts`, `src/globals.d.ts` (`declare const __SEER_REPO__: string;`)
- Modify: `manifest.json` (`options_ui.page` → `setup.html`), `build.mjs` (entry `src/setup/index.ts → dist/setup.js`, drop options; esbuild `define: { __SEER_REPO__: JSON.stringify(process.env.SEER_REPO ?? 'OWNER/REPO') }`), `src/background/index.ts` (`onInstalled` with `reason === 'install'` → `chrome.runtime.openOptionsPage()`)
- Delete: `options.html`, `src/options/`
- Test: `src/setup/checks.test.ts`, `src/setup/files.test.ts`

**Interfaces:**
- Consumes: `HelperClient`, `HelperError`, `HelperStatus`, `MyFile` (E1); `getSettings`/`saveSettings`, `CLAUDE_MODELS` (E1).
- Produces:
  - `checks.ts`: `type CheckId = 'helper' | 'claude' | 'login' | 'pdf'`; `interface CheckRow { id: CheckId; label: string; ok: boolean; problem?: string; fix?: string /* copy-paste command */; hint?: string }`; `INSTALL_COMMAND = \`curl -fsSL https://github.com/${__SEER_REPO__}/releases/latest/download/install.sh | bash\``; `CLAUDE_INSTALL_COMMAND` (Claude Code's official macOS install command, checked against Anthropic's current docs when implementing); `checkRows(input: { status: HelperStatus | null; helperError: HelperError | null; extensionVersion: string }): CheckRow[]`; `allGreen(rows: CheckRow[]): boolean`.
  - `files.ts`: `ACCEPTED_TYPES = '.pdf,.docx,.doc,.rtf,.odt,.txt,.md'`; `fileStatusText(file: MyFile): string`; `canLeaveFilesStep(files: MyFile[]): boolean`; `toBase64(bytes: Uint8Array): string`.

- [ ] **Step 1: Write failing tests** (`checks.test.ts`, `files.test.ts`):
  - Rows always come back in the order helper, claude, login, pdf with labels `Helper connected`, `Claude Code installed`, `Signed in with your Claude subscription`, `PDF builder ready`.
  - All present → four green rows, `allGreen` true.
  - Helper missing (`helperError.notInstalled`) → helper row red with `fix === INSTALL_COMMAND`; the other three red with problem `Waiting for the helper`.
  - Versions `0.9.0` (helper) vs `1.0.0` (extension) → helper row red, problem names both versions, hint says to re-run the install command and reload The Seer in `chrome://extensions`, `fix === INSTALL_COMMAND`.
  - `not-installed` → claude row red with `fix === CLAUDE_INSTALL_COMMAND`, login row red; `not-logged-in` → login row hint `Open Terminal, run claude, then type /login`; `not-subscription` → login row problem says The Seer only uses your Claude subscription, not an API key; `tectonic.path === null` → pdf row red with `fix === INSTALL_COMMAND`.
  - `fileStatusText`: `read` with 412 words → `Read · 412 words`; `no-text` → `No readable text — export it as Word or text`; `unsupported` → `Not supported — use PDF, Word, text or Markdown`; `too-big` → `Too big — the limit is 10 MB`.
  - `canLeaveFilesStep` true only when some file is `read`.
  - `toBase64` of bytes `0..255`, and of 100,000 bytes, equals `Buffer.from(bytes).toString('base64')`.
- [ ] **Step 2: Run** `pnpm test` → FAIL.
- [ ] **Step 3: Implement `checks.ts` and `files.ts`.**
- [ ] **Step 4: Build the page** (`setup.html` + `src/setup/index.ts`, Tailwind like `popup.html`; add the new files to Tailwind's sources if they are listed explicitly). Step pills `1 Check · 2 Your files · 3 Preferences`. Step 1 renders `checkRows` with a copy button per `fix`, a "Check again" button, re-checks on window focus, "Next" enabled when `allGreen`. Step 2: drop zone + "Choose files…" (`ACCEPTED_TYPES`, multiple), hint `Add your resumes, career story, LinkedIn profile PDF, project notes — anything true about your work. Files stay on this Mac.`; files over 10 MB are marked too big without sending; others go through `addFile`; list with `fileStatusText`, remove ×, "Open folder"; "Next" when `canLeaveFilesStep`. Step 3: fit bar range 0–100 step 5 with live value, pages 1/2, writer from `CLAUDE_MODELS`, save folder with "Choose…" (`chooseFolder` → `setOutput`) and "Open"; changes save immediately; "Done" shows `You're set. Open any job posting and click The Seer's button.` Opening the page starts at step 1 if any row is red, else step 2 if no file is read, else step 3. Errors show inline, logged with `[Seer Setup]`.
- [ ] **Step 5: Run** the extension checks → PASS.
- [ ] **Step 6: Stage** — message: `feat(extension): three-step setup page replaces the options page; opens on first install`.

### Task E3: Popup status, fit bar end to end, "Open setup"

**Files:**
- Modify: `popup.html`, `src/popup/index.ts`, `src/shared/host-protocol.ts`, `src/shared/native-writer.ts`, `src/shared/types.ts`, `src/background/index.ts`, `src/content/index.ts`
- Test: `src/shared/host-protocol.test.ts`, `src/shared/native-writer.test.ts`, `src/background/job-runner.test.ts`

**Interfaces:**
- Consumes: `createHelperClient`, `checkRows`, `allGreen`, `scorePasses`, `getSettings` (E1, E2).
- Produces: `HostErrorMessage.needsSetup?: boolean`; `WriterError.needsSetup: boolean`; `DEEP_ANALYSIS_RESULT` carries `threshold: number`; `ERROR` responses carry `needsSetup?: boolean`; content → background message `{ type: 'OPEN_SETUP' }`.

- [ ] **Step 1: Write failing tests**:
  - `isHostMessage({ type: 'error', error: 'x', needsSetup: true })` is true; `needsSetup: 'yes'` is rejected.
  - `writeResumeViaHost`: a host error with `needsSetup: true` rejects with `WriterError.needsSetup === true`; a disconnect whose `lastError` says the native host was not found rejects with `needsSetup === true`; a compile error has `needsSetup === false`.
  - The job runner's `DEEP_ANALYSIS_RESULT` includes `threshold` equal to the settings' `minScore`.
- [ ] **Step 2: Run** `pnpm test` → FAIL.
- [ ] **Step 3: Implement** — background: `ERROR` responses add `needsSetup` from `WriterError`; `OPEN_SETUP` calls `chrome.runtime.openOptionsPage()`; the per-tab badge stores `{ score, threshold }` and colours with `scorePasses`. Content: `showToast(message, type, action?)` gains an optional `{ label: 'Open setup' }` button that sends `OPEN_SETUP`; the `SEER_PDF_ERROR` toast passes it when `msg.needsSetup`. Inside `handleClick`, only: `const pass = scorePasses(result.fit_score, response.threshold);` and the `ERROR` branch's toast passes the action when `response.needsSetup`. Popup: on open shows `Checking…`, then `Ready` (all rows green and a file read) or `Needs setup`, plus a "Setup & settings" button replacing the "Settings" link; the per-tab analysis view uses `scorePasses` with the saved fit bar.
- [ ] **Step 4: Run** the extension checks → PASS.
- [ ] **Step 5: Stage** — message: `feat(extension): popup readiness, fit bar end to end, Open setup on not-ready errors`.

### Task X1: Extra instructions for the writer

Owner decisions (2026-10-23): the built-in prompts always run — nothing replaces them. Users can add custom instructions in an optional "Extra instructions for the writer" box; the writer follows them, even where they differ from the built-in style and tailoring guidance, but never against the Truth rules. The `resume-prompt.md` full override is removed.

**Files:**
- Modify (helper): `apps/resume-gen/src/native.ts` (`parseWriteRequest`), `src/generate.ts` (`WriteRequest`), `src/writer/request.ts`, `src/writer/resume-writer.md`, `src/profile.ts` (drop `promptOverride`), `src/my-files/store.ts` (drop the `PROMPT_FILE` special case)
- Modify (extension): `src/shared/types.ts`, `src/shared/settings-normalize.ts`, `src/shared/storage.ts`, `src/shared/host-protocol.ts` (`WriteRequest`), `src/background/job-runner.ts`, `setup.html`, `src/setup/index.ts`
- Test: `apps/resume-gen/src/native.test.ts`, `src/writer/request.test.ts`; `apps/extension/src/shared/settings-normalize.test.ts`, `src/background/job-runner.test.ts`

**Interfaces:**
- Consumes: `buildWriterRequest`, `parseWriteRequest` (H3/H6); `getSettings`/`saveSettings` (E1); the Preferences step (E2).
- Produces: `MAX_WRITER_NOTES = 2000` (both apps); write request field `writerNotes?: string`; `SeerSettings.writerNotes: string`; `normalizeWriterNotes(stored: unknown): string`; `buildWriterRequest(p: { profile; job; maxPages; writerNotes?: string })`.

- [ ] **Step 1: Write failing tests**:
  - `normalizeWriterNotes`: `'  Use British spelling  '` → `'Use British spelling'`; a 2,500-character string → its first 2,000 characters; `42`, `undefined` → `''`.
  - The job runner sends the saved `writerNotes` in the write request (and `''` when unset).
  - `parseWriteRequest` accepts a missing or string `writerNotes`; a non-string, or one over 2,000 characters, is an error whose message contains `2,000`.
  - `buildWriterRequest` with `writerNotes: 'Keep my publications section.'` → the system prompt ends with an `<extra_instructions>` block holding that text, after the documents; with `''` or none → no `<extra_instructions>` block, prompt unchanged; the built-in instructions are always the start of the system prompt.
  - `Profile` has no `promptOverride`; a file named `resume-prompt.md` in My files is listed and stored like any other file (no rename, no special reading).
  - `resume-writer.md` mentions `<extra_instructions>`, says to follow them even where they differ from its own style and tailoring guidance, and says the Truth rules win over them.
- [ ] **Step 2: Run** both apps' tests → FAIL.
- [ ] **Step 3: Implement** — helper: `tagged('extra_instructions', notes)` appended last in the system prompt (static per user, so the prompt cache still works). Writer instructions get a short section: an `<extra_instructions>` block, when present, holds the person's own requests about the resume (what to emphasize, spelling, sections, tone); follow them, even where they differ from this file's style and tailoring guidance, but never against the Truth rules; never add a claim the documents don't support because an instruction asks for it. Remove `promptOverride` and the `resume-prompt.md` special case everywhere (profile, store, writer request, CLI help, tests). Extension: `writerNotes` stored with the other settings and sent with every write; Preferences step gets a textarea labelled `Extra instructions for the writer (optional)`, placeholder `e.g. Keep my publications section. Use British spelling. Lead with backend work.`, a live `N / 2000` counter, `maxlength="2000"`, saved on input (debounced ~500 ms) and on blur.
- [ ] **Step 4: Run** both apps' checks → PASS; `cd apps/resume-gen && bun run compile`.
- [ ] **Step 5: Stage** — message: `feat: optional extra instructions for the resume writer`.

---

## Part R — Release

### Task R1: Release build, installer, workflow

**Files:**
- Create: `scripts/build-release.sh`, `apps/extension/scripts/stage.mjs`
- Replace: `install.sh` (repo root), `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `theseer-pdf --setup [--no-warm-up]`, `--version` (H1, H5); `SEER_REPO` define (E2).
- Produces: `scripts/build-release.sh <arm64|x64> <out-dir>` → `<out-dir>/the-seer-macos-<arch>.tar.gz` containing `the-seer/{bin/theseer-pdf, bin/tectonic, templates/default.tex, extension/}`; `install.sh [--from <tarball>] [--uninstall] [--no-warm-up] [--no-open]`.

- [ ] **Step 1: `stage.mjs <dir>`** — copies `manifest.json`, `popup.html`, `setup.html`, `editor.html`, `content.css`, `icons/*.png` and `dist/` into `<dir>`; exits non-zero naming the first missing file.
- [ ] **Step 2: `build-release.sh`** — `set -euo pipefail`; builds the extension (`pnpm --dir apps/extension build`, passing `SEER_REPO` through); `bun build --compile --target=bun-darwin-<arch> apps/resume-gen/main.ts --outfile <stage>/the-seer/bin/theseer-pdf`; downloads tectonic `TECTONIC_VERSION` (pin the newest stable release that has both `aarch64-apple-darwin` and `x86_64-apple-darwin` assets) into a cache dir and copies the binary into `bin/`; copies `apps/resume-gen/GEN/GEN-V3.tex` to `templates/default.tex`; runs `stage.mjs`; tars.
- [ ] **Step 3: `install.sh`** — `set -euo pipefail`; `REPO='__SEER_REPO__'` (the workflow substitutes it; still a placeholder and no `--from` → exit with `This copy of install.sh has no release to download — use the command from the project's README`). Refuse non-Darwin; `uname -m` `arm64` → `arm64`, `x86_64` → `x64`. Without `--from`: `curl -fsSL` the tarball and `SHA256SUMS` from `https://github.com/$REPO/releases/latest/download/`, verify with `shasum -a 256 -c` on that tarball's line. Unpack into a temp dir; install into `~/.theseer` (`bin/`, `templates/`, replace `extension/` wholesale); never touch `config.json` or `~/TheSeer`. Clear `com.apple.quarantine` on what it installed. Run `~/.theseer/bin/theseer-pdf --setup`, adding `--no-warm-up` only when the installer was given it. Warn if `Google Chrome.app` is in neither `/Applications` nor `~/Applications`. Print the Chrome steps; unless `--no-open`, copy `~/.theseer/extension` to the clipboard (`pbcopy`) and `open -a "Google Chrome" chrome://extensions` (if that fails, say to open it by hand). `--uninstall`: remove the Chrome host manifest and `~/.theseer`, keep `~/TheSeer`, print how to remove the extension card. Every step prints one line; any failure exits non-zero with what failed.
- [ ] **Step 4: Workflow** — on tags `v*`, `runs-on: macos-14`: checkout; Bun (pinned 1.3.x ≥ 1.3.10), Node 22, pnpm; `pnpm install --frozen-lockfile`; fail unless `manifest.json` version equals the tag without `v`; `brew install tectonic`; helper and extension checks; `SEER_REPO=${{ github.repository }}` build both arches into `dist/`; smoke: unpack each and run `bin/theseer-pdf --version` (x64 under `arch -x86_64`); `sed "s#__SEER_REPO__#${{ github.repository }}#g" install.sh > dist/install.sh`; `shasum -a 256 the-seer-macos-*.tar.gz > SHA256SUMS` in `dist/`; publish `dist/*` with `softprops/action-gh-release@v2`.
- [ ] **Step 5: Verify locally** — `bash -n install.sh scripts/build-release.sh` (and `shellcheck` if installed); `scripts/build-release.sh arm64 <workspace>/dist`; then with `T=$(mktemp -d)`: `HOME=$T bash install.sh --from <workspace>/dist/the-seer-macos-arm64.tar.gz --no-warm-up --no-open` → `$T/.theseer/bin/theseer-pdf --version` prints `1.0.0`, the host manifest under `$T/Library/…/NativeMessagingHosts/` names `EXTENSION_ID`, `$T/.theseer/config.json` has both folders, `$T/.theseer/extension/manifest.json` exists; `HOME=$T bash install.sh --uninstall` → `$T/.theseer` and the manifest are gone, `$T/TheSeer` remains. Build `x64` too and run its `--version` under `arch -x86_64`.
- [ ] **Step 6: Stage** — message: `feat: macOS release tarballs, one-command installer and release workflow`.

---

## Part Y — Owner changes after the live run (2026-10-24)

Owner decisions: (1) "Your files" asks separately for a career story and three base resumes, then offers "Add more files"; (2) two pages is the default length; (3) the owner's chosen resume `.tex` (kept outside the repo, path given in the dispatch) is the one built-in format — no template upload option. Calls made by the controller: no slot is required (a person may have one resume); a file in a slot that gets a new upload is replaced; the header stays on one line with up to three links and splits into two lines (email · phone, then LinkedIn · GitHub) only when all four are present.

### Task Y1: Slots for career story and base resumes (helper)

**Files:** `apps/resume-gen/src/my-files/store.ts`, `src/setup-commands.ts`, `src/native.ts`, `src/writer/request.ts`, `src/writer/resume-writer.md`, `src/scorer/instructions.md`, `src/scorer/request.ts`, `src/profile.ts` (+ tests)

**Interfaces:**
- Produces: `type Slot = 'career-story' | 'resume-1' | 'resume-2' | 'resume-3'`; `SLOTS: readonly Slot[]`; `MyFile.slot: Slot | null`; `SourceDocument.kind: 'career story' | 'resume' | 'other'`; `addMyFile(profileDir, name, bytes, lastModifiedMs?, slot?)`; `add-file` request gains optional `slot`.

- [ ] **Step 1: Failing tests** — slot map in `<profileDir>/.seer/slots.json` (`{ "career-story": "<file name>", … }`); `addMyFile(…, 'resume-2')` records the slot and `listMyFiles` reports it; a second upload to the same slot deletes the earlier file and its cache entry; removing a slotted file clears its slot; a slot whose file was deleted in Finder is dropped on the next listing; a corrupt `slots.json` is treated as empty and logged; `add-file` with an unknown slot is refused; `readDocuments` gives `kind` 'career story' / 'resume' / 'other'; writer and scorer prompts carry `kind="…"` on each `<document>`.
- [ ] **Step 2: Implement**; writer and scorer instructions say: documents of kind "resume" are the person's base resumes (start from the closest one); kind "career story" is their fullest record of what they did; kind "other" adds detail; with no kind "resume", fall back to the existing no-resume rules. All Truth rules stay.
- [ ] **Step 3: Checks + `bun run compile`; stage** — message: `feat(resume-gen): career story and base resume slots`.

### Task Y2: Slot upload rows and two-page default (extension)

**Files:** `apps/extension/setup.html`, `src/setup/index.ts`, `src/setup/files.ts`, `src/shared/helper-types.ts`, `src/shared/helper-client.ts`, `src/shared/settings-normalize.ts` (+ tests); README.md

**Interfaces:**
- Consumes: Y1's `Slot`, `MyFile.slot`, `add-file` `slot`.
- Produces: `HelperClient.addFile(name, dataBase64, lastModified?, slot?)`; `DEFAULT_MAX_PAGES = 2`.

- [ ] **Step 1: Failing tests** — `isMyFile` accepts `slot` (one of the four or null) and rejects others; `addFile` sends `slot` only when given; `normalizeMaxPages(undefined) === 2`, `1 → 1`, `2 → 2`; a pure `slotRows(files)` returns the four rows in order (Career story, Base resume 1, Base resume 2, Base resume 3) each with its file or empty, and `otherFiles(files)` the unslotted ones.
- [ ] **Step 2: Build the step** — four labelled rows, each with an Upload button (single file, `ACCEPTED_TYPES`) and, once filled, the file name, its status text, Replace and Remove; hints: career story `Your work history in your own words — the fullest record of what you did.`, resumes `A resume you already use.`; then "Other files (optional)" with the drop zone, an "Add more files" button and the list. Next stays enabled when any file is read. Pages default 2 in Preferences.
- [ ] **Step 3: README** — setup step 2 and the default length. Checks; stage — message: `feat(extension): ask for career story and base resumes separately; two pages by default`.

### Task Y3: The owner's resume format as the built-in template

**Files:** `apps/resume-gen/GEN/GEN-V3.tex`, `src/latex.ts`, `src/native.ts`/`main.ts` defaults (`DEFAULT_MAX_PAGES` → 2), tests

- [ ] **Step 1:** Compile the owner's `.tex` unchanged with tectonic (in a scratch dir outside the repo) and record its look: fonts (`pdffonts` or the PDF's font names), page size, margins, section style, header layout, spacing.
- [ ] **Step 2: Failing tests** — the rendered LaTeX for a doc with the same structure matches the owner's file's body structure (header block, summary entry, skills rows with `\vspace{0.15cm}` between them, experience `twocolentry` + `highlights` + `\experienceSeparator` between roles, education entries) — written with the invented person; header has one line for up to three links and two lines (email · phone / LinkedIn · GitHub) for four, never a dangling separator.
- [ ] **Step 3: Implement** — the shipped template's preamble becomes the owner's preamble verbatim except `pdfauthor={}`, with no body content; keep the font setup that reproduces the owner's compiled look under tectonic (if the owner's file compiles to a different font than the current template, the owner's result wins); renderer output matches the owner's body structure and spacing. Default pages 2 in the helper and CLI.
- [ ] **Step 4:** Compile `SAMPLE_DOC` and a doc carrying the owner's file's structure (scratch only, never committed) and compare side by side with the owner's PDF: same fonts, same spacing, same section look. No owner data in tracked files. Checks + `bun run compile`; stage — message: `feat(resume-gen): owner's resume format is the built-in look; two pages by default`.

### Task Y4: Merge the owner's software-engineering prompt into the writer

Owner decision (2026-10-24): keep the tone and role-type analysis "and everything" from the owner's earlier prompt (kept outside the repo; path given in the dispatch). Its Markdown output format does not apply (the writer returns JSON); everything else is merged, generalised beyond software roles where it is software-specific, and the existing Truth rules keep precedence.

**Files:** `apps/resume-gen/src/writer/resume-writer.md`, `src/writer/request.ts` (schema), `src/resume-doc.ts`, `src/generate.ts` (notes file), README.md (+ tests)

**Interfaces:**
- Produces: `ResumeDoc.analysis?: { role_type: string; company_dna: string; must_haves: string[]; nice_to_haves: string[]; core_problems: string[]; seniority: string; gaps: { requirement: string; evidence: string; action: string }[]; tone: { technical_depth: number; culture_emphasis: number; formality: number; innovation_vs_stability: number; individual_vs_team: number } }` and `ResumeDoc.changelog?: string[]`; the writer schema lists `analysis` FIRST and `changelog` LAST and requires both (so the model analyses before it writes); the validator treats them as optional (old replies still parse); `notes.md` written next to the PDF.

- [ ] **Step 1: Failing tests** — schema property order starts with `analysis` and ends with `changelog`, both required, tone values integers 1–10; `validateResumeDoc` accepts a doc without them and rejects malformed ones (tone 0 or 11, non-array changelog); `writeResume` writes `notes.md` in the output folder (analysis sections + changelog) when present and none when absent; instructions tests pin the merged sections (role-type guide, company DNA, requirements, gap analysis, tone calibration, summary 60–80% rewrite, skills rebuild, bullet actions KEEP/REPHRASE/MERGE/ADD/REMOVE/SKIP, education unchanged, keep every position, at most five bullets per role, skills↔experience sync, no em/en dashes in resume text) and every existing Truth sentence.
- [ ] **Step 2: Implement** — merge every rule from the owner's prompt into the matching section of `resume-writer.md` (generalise "software engineering" guidance to "the role's field", keep the frontend/backend/full-stack guide as examples for software roles); reconcile bullet caps: never more than five bullets per role, one-page caps unchanged, two-page targets within five. No em or en dashes in summary, skills or bullets (date ranges are typeset separately).
- [ ] **Step 3: Live check** — compile, then write one resume for a job in the quality set; confirm `notes.md`, the analysis, one or two pages, and no unsupported claim. README: mention `notes.md`. Checks; stage — message: `feat(resume-gen): analysis-first writer with the owner's tailoring rules; notes.md per resume`.

---

## Part C — Cleanup, docs, verification

### Task C1: Remove dead code

**Files:**
- Delete: `packages/` (core, db, cli), `apps/crawl-server/`, `apps/extension/src/shared/tracker.ts`, `the-seer-final-blueprint.md`, `apps/resume-gen/resume-gen.mjs`, `apps/resume-gen/native-host/`, `apps/resume-gen/build.ts`, `install.ps1`, `apps/extension/package-lock.json`, any tracked `apps/dashboard` files
- Modify: `apps/extension/src/background/index.ts` (drop `tryCrawlServer`, `cleanCrawlMarkdown`, tracker calls), `src/background/job-runner.ts` (`CrawlContent` keeps only `iframeTexts`), `src/shared/job-text.ts` (`pickJobText` loses `crawlMarkdown`), root `package.json` (drop the `seer` script), `pnpm-workspace.yaml` (only `apps/*`), `pnpm-lock.yaml` (`pnpm install`)
- Test: `src/shared/job-text.test.ts`, `src/background/job-runner.test.ts`

- [ ] **Step 1: Update tests** — remove the crawl-markdown cases from `job-text.test.ts`; job-runner tests build `CrawlContent` without `crawlMarkdown`.
- [ ] **Step 2: Delete and edit** as listed; `rg -n "crawl|tracker|9742|DASHBOARD" apps` finds nothing left that refers to removed code.
- [ ] **Step 3: Run** both apps' checks and `pnpm install` from the root → PASS, lockfile updated.
- [ ] **Step 4: Stage** (including deletions) — message: `chore: remove code no product user can run (crawl server, dashboard tracker, old packages and installers)`.

### Task C2: Remove personal data

**Files:**
- Untrack: `data/` (`git rm -r --cached data`; files stay on disk, `data/` is already ignored)
- Delete from the repo: `docs/prompts/`, `docs/resumes/`, the career-story file in `docs/` (first copy them to `data/old-docs/` locally; Task P1 already backed them up)
- Modify: test fixtures and tests in both apps that hold the owner's details (`apps/resume-gen/src/test-fixtures.ts`, the `*.test.ts` files `git grep -f` lists), `docs/superpowers/specs/*.md`, `docs/superpowers/plans/*.md`, `.gitignore` (add `.superpowers/`)

- [ ] **Step 1: Replace** every owner detail in tests and fixtures with the invented person from Global Constraints, and the old date-rule employer in test data with an invented employer; adjust assertions to match.
- [ ] **Step 2: Scrub docs** — in the specs and plans, replace the owner's name, contact details, career-story file name and the employer rule with neutral wording ("the owner", "the owner's career story", "an employer-specific date rule").
- [ ] **Step 3: Verify** — `git grep -i -n -E -f <workspace>/personal-patterns.txt` prints nothing; `git ls-files | grep -i -E -f <workspace>/personal-patterns.txt` prints nothing; both apps' checks pass.
- [ ] **Step 4: Stage** (including removals) — message: `chore: remove the owner's personal data from the repository`.

### Task C3: README and license

**Files:**
- Create: `LICENSE`
- Replace: `README.md`

- [ ] **Step 1: `LICENSE`** — MIT, `Copyright (c) 2026 <git config user.name>`.
- [ ] **Step 2: README** — job seekers first, in this order: what it does (one paragraph + the three-step flow); requirements (Mac on Apple Silicon or Intel, Google Chrome, a Claude Pro/Max/Team/Enterprise subscription with Claude Code); install (the single `curl -fsSL https://github.com/OWNER/REPO/releases/latest/download/install.sh | bash` line — the only place the repo slug appears — then the three Chrome steps with the ⌘⇧G tip); setup (the three steps); use (click the button; fit score; resume when the fit is at or above your bar; where PDFs go; the editor); privacy (files stay on your Mac; job text and your files' text go to Anthropic through your own Claude Code; no telemetry; why the extension asks to run on all sites); usage cost (one Haiku call per job, plus one Opus or Sonnet call when it writes; counts against your plan's limits); your own Claude Code (each user runs their own, unmodified Claude Code under their own account and plan terms; The Seer never uses API keys); troubleshooting (each setup row's fix, "usage limit reached", "no readable text", Chrome can't find the helper); update (re-run the install command, then reload the extension); uninstall (`curl … | bash -s -- --uninstall`); custom writing (the built-in prompts always run; the Preferences step's "Extra instructions for the writer" box adds your own requests, which the writer follows except against the truth rules); advanced (`theseer-pdf --set-profile`, `--set-output`, `--write`, `--score`); developers (repo layout, `pnpm install`, checks, `bun run setup:dev`, `scripts/build-release.sh`, releasing by pushing a `v*` tag); license.
- [ ] **Step 3: Check** every command and path in the README against the code (`--help` output, `install.sh` flags, default folders).
- [ ] **Step 4: Stage** — message: `docs: README for job seekers; MIT license`.

### Task C4: Verification, quality comparison, handoff

- [ ] **Step 1: Checks** — both apps' checks; `scripts/build-release.sh arm64 <workspace>/dist`; repeat Task R1 Step 5's temp-HOME install and uninstall.
- [ ] **Step 2: Owner's helper** — `cd apps/resume-gen && bun run setup:dev` (registers the host for the new extension ID), then `~/.theseer/bin/theseer-pdf --set-profile "$HOME/TheSeer/My files"`.
- [ ] **Step 3: "After" resumes** — for the three jobs in `<workspace>/quality/jobs/`, run the same `--write … --min-score 0 --max-pages 1` commands; save outputs to `quality/after/<n>/`; compute coverage with `quality/coverage.ts` against the same keyword lists; write `quality/comparison.md` (before vs after: fit score, pages, fits, trimmed bullets, coverage, PDF paths). Pages and coverage must not drop for any job; if they do, rule on a writer-instruction fix (ledger it), apply it, and rerun the affected job.
- [ ] **Step 4: Simplify** — run the `simplify` skill on the branch's changes; re-run both apps' checks.
- [ ] **Step 5: Owner live run** (the owner clicks): remove the old unpacked "The Seer" card in `chrome://extensions`; `bash install.sh --from <workspace>/dist/the-seer-macos-arm64.tar.gz` (owner's real HOME; existing config is kept); Load unpacked → `~/.theseer/extension`; the setup page opens by itself; all four rows green; My files lists the owner's files as read; set preferences; "Choose…" opens the macOS folder picker (if it can't from a Chrome-launched helper, rule on adding a typed-path field and add it); click the button on one real posting → fit score → PDF.
- [ ] **Step 6: Handoff** — give the owner: the staged commit messages; `<workspace>/quality/comparison.md` with the PDF pairs; and the publishing commands from the spec (make the current repo private; create the new public repo; push the cleaned tree as a single first commit from an orphan branch; set `OWNER/REPO` in the README; push tag `v1.0.0`; then run the README's install command on a fresh macOS user account as the acceptance test).
