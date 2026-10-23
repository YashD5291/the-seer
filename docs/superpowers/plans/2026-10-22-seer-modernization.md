# The Seer Modernization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make The Seer work again, write resumes through Claude Code (`claude -p`) on the owner's Max plan, roughly halve time-to-PDF by running Grok scoring and Claude writing concurrently, and produce better one-page resumes from a schema-enforced JSON contract with a keyword-coverage score.

**Architecture:** Three parts. **Part A** turns the native host (`apps/resume-gen`) into the resume writer: owner-editable profile folder → `claude -p` with a run-time JSON schema → validated `ResumeDoc` → deterministic LaTeX → tectonic → page fit, streamed back over a native-messaging port with progress. **Part B** fixes Grok and rebuilds the extension pipeline so Grok scoring and the native writer start together from the scraped job text, per job, with no claude.ai automation left. **Part C** is setup, docs, and the live run. Parts A and B touch disjoint directories and may run as parallel tracks.

**Tech Stack:** Chrome MV3 + TypeScript + esbuild; `node:test` via `tsx` + `jsdom` (extension); Bun + `bun:test` (native host); Claude Code 2.1.308 CLI; tectonic.

**Spec:** `docs/superpowers/specs/2026-10-22-seer-modernization-design.md`

## Global Constraints

- No paid LLM APIs. Grok scores in a grok.com tab; Claude writes via `claude -p` on the Max login. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` must never reach the `claude` child process.
- Do not modify `attachDragHandler` / `handleClick` in `apps/extension/src/content/index.ts` (owner rule).
- Never `git commit`. Each task ends by staging its files; record the commit message in the task for the owner. Branch: `feat/seer-modernization`.
- Console logs keep prefixed tags: `[Seer]`, `[Seer BG]`, `[Seer Grok]`, `[theseer-pdf]`.
- No empty `catch {}`: every catch either rethrows, returns a typed error, or logs with its tag and a reason.
- Strict typing; `any` only at chrome-message boundaries with a comment.
- Extension checks: `cd apps/extension && pnpm test && npx tsc --noEmit && node build.mjs`. Native host checks: `cd apps/resume-gen && bun test`.
- After native host changes: `cd apps/resume-gen && bun build --compile --target=bun-darwin-arm64 main.ts --outfile ~/.theseer/bin/theseer-pdf`.

## Review Focus

1. **Claude reply with prose around the JSON, two JSON blocks, or a cut-off block** → use the last valid `version: 1` block; a cut-off block yields "reply was cut off", not a stale PDF. Pinned in Task A1.
2. **Company/role names with `/ | : * ? " < > + ( )` or emoji** → folder name sanitized, no regex built from names, no crash. Pinned in Tasks A5 and B5.
3. **Bullets containing `_ & % $ # { } ~ ^ \`, en/em dashes, accented letters, curly quotes** → PDF compiles. Pinned in Tasks A2 and A3.
4. **Second job started before the first job's resume finishes** → each job produces its own PDF for its own tab. Pinned in Task B5.
5. **Claude Code not logged in, usage limit hit, or a run that hangs** → a clear error in the panel (not logged in → how to log in; failure → Claude's own message; hang → timeout), never a silent "done". Pinned in Tasks A8 and B4.

---

## Part A — Native host (`apps/resume-gen`)

All new modules live in `apps/resume-gen/src/`, tests next to them as `*.test.ts` (`import { describe, it, expect } from 'bun:test'`). `main.ts` keeps argv dispatch and `runSetup` only.

### Task A1: ResumeDoc contract + extraction

**Files:**
- Create: `apps/resume-gen/package.json` (`{"name":"@the-seer/resume-gen","private":true,"type":"module","scripts":{"test":"bun test","compile":"bun build --compile --target=bun-darwin-arm64 main.ts --outfile ~/.theseer/bin/theseer-pdf"}}` — no `build` script so turbo skips it)
- Create: `apps/resume-gen/src/resume-doc.ts`
- Test: `apps/resume-gen/src/resume-doc.test.ts`

**Interfaces:**
- Produces: `ResumeDoc`, `Bullet = { text: string; priority: 1 | 2 | 3 }` (types exactly as in the spec); `class ResumeFormatError extends Error { problems: string[] }`; `extractResumeDoc(responseText: string): ResumeDoc`; `validateResumeDoc(value: unknown): ResumeDoc`; `resumePlainText(doc: ResumeDoc): string` (summary, skills, bullets, project bullets joined by newlines — used for keyword scoring).

- [ ] **Step 1: Write failing tests** — `resume-doc.test.ts` with a `VALID` fixture object (1 job × 3 bullets, 1 education, `projects` omitted):
  - `extractResumeDoc("Here you go:\n```json\n" + JSON.stringify(VALID) + "\n```\nGood luck")` deep-equals `VALID`.
  - Two blocks (first `{"version":1,"draft":true}` invalid, second valid) → returns the second.
  - `"```json\n{\"version\":1,\"name\":\"A\""` (unclosed) → throws `ResumeFormatError` whose message contains `cut off`.
  - No fenced block → throws with message containing `No resume JSON`.
  - `validateResumeDoc({...VALID, experience: [{...job, bullets: [{text: 'x', priority: 4}]}]})` → `problems` contains `experience[0].bullets[0].priority must be 1, 2 or 3`.
  - Missing `target.company` → `problems` contains `target.company is required`.
  - `resumePlainText(VALID)` contains every bullet text and every skill item.
- [ ] **Step 2: Run** `cd apps/resume-gen && bun test src/resume-doc.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** in `src/resume-doc.ts`. Block scan regex: ``/```(?:json)?\s*\n([\s\S]*?)```/g``; iterate matches last→first, `JSON.parse`, accept the first with `version === 1` that validates. A ```` ```json ```` opener with no closing fence → "cut off". Validation collects every problem (path + rule) before throwing; required non-empty strings: `target.company`, `target.role`, `name`, `contact.email`, `summary`, each job's `title/company/start`, each bullet's `text`; `skills.length ≥ 1`, `experience.length ≥ 1`, each job `bullets.length ≥ 1`; `base ∈ {gen_ai, mle, mix}`; `keywords` is a string array.
- [ ] **Step 4: Run** `bun test src/resume-doc.test.ts` → PASS.
- [ ] **Step 5: Stage** `git add apps/resume-gen/package.json apps/resume-gen/src/resume-doc.ts apps/resume-gen/src/resume-doc.test.ts` — message: `feat(resume-gen): ResumeDoc JSON contract with strict validation`.

### Task A2: LaTeX rendering + legacy markdown adapter

**Files:**
- Create: `apps/resume-gen/src/latex.ts`, `apps/resume-gen/src/legacy-markdown.ts`, `apps/resume-gen/src/rules.ts`
- Test: `apps/resume-gen/src/latex.test.ts`, `apps/resume-gen/src/legacy-markdown.test.ts`

**Interfaces:**
- Consumes: `ResumeDoc` (A1).
- Produces: `escapeLatex(text: string): string`; `readPreamble(templatePath: string): string` (moved unchanged from `main.ts:683-689`); `renderResumeLatex(doc: ResumeDoc, preamble: string): string`; `parseLegacyMarkdown(text: string, fallbackTitle: string | null): ResumeDoc` (wraps the moved `extractChatTitle`, `extractResumeSection`, `parseResume` from `main.ts:550-660`; all bullets `priority: 2`; `dateRange` split on `/\s+[-–—]+\s+/` into `start`/`end`); `applyDateRules(doc: ResumeDoc): ResumeDoc` (the existing employer-specific end-date rule from `main.ts:662-668`, applied to `end`, pure).

- [ ] **Step 1: Write failing tests**
  - `escapeLatex('R&D 100% $5 #1 a_b {x} ~ ^ \\ — –')` === `'R\\&D 100\\% \\$5 \\#1 a\\_b \\{x\\} \\textasciitilde{} \\textasciicircum{} \\textbackslash{} -- --'` (single pass — `\` must not be double-escaped).
  - `renderResumeLatex(VALID, '%PRE')` starts with `%PRE`, contains `\section{Experience}`, `\textbf{<title>}`, `<start> -- <end>`, one `\item` per bullet, ends with `\end{document}`; has no `\section{Projects}` when `projects` is absent; has it (with project name bold) when present.
  - A job whose bullets array is empty is impossible post-validation, but `renderResumeLatex` never emits an empty `highlights` environment for a project with zero bullets (skip the list).
  - Header omits LinkedIn (existing owner rule) and omits the GitHub separator when `github` is absent.
  - `parseLegacyMarkdown(LEGACY)` where `LEGACY` is a synthetic reply in the old format (`## TAILORED RESUME`, `# Name`, `**Email:**`/`**Phone:**`/`**GitHub:**` lines, summary, `## Skills` rows `**Cat:** a, b`, two `**Title** | Company -- Location` jobs with date lines `Jan 2023 - Present` and `- ` bullets, `## Education`, trailing `## CHANGELOG`) → name, 2 jobs, bullet counts, `start: 'Jan 2023'`, `end: 'Present'`, and no CHANGELOG text anywhere in the doc. (No saved real reply exists in `data/`.)
  - `applyDateRules` rewrites `end` for the one employer the rule names and leaves other companies alone.
- [ ] **Step 2: Run** `bun test src/latex.test.ts src/legacy-markdown.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `escapeLatex` uses one `replace(/[\\&%$#_{}~^–—]/g, ch => MAP[ch])`. `renderResumeLatex` reproduces the existing layout of `generateContent` (`main.ts:691-772`) with skills `items.join(', ')`, experience date `${start} -- ${end}`, and a Projects section (between Experience and Education) using `twocolentry`-free `onecolentry` + `highlights`.
- [ ] **Step 4: Run** the two test files → PASS.
- [ ] **Step 5: Stage** the five files — message: `feat(resume-gen): deterministic LaTeX renderer, single-pass escaping, legacy markdown adapter`.

### Task A3: tectonic compile with page count

**Files:**
- Create: `apps/resume-gen/src/compile.ts`
- Test: `apps/resume-gen/src/compile.test.ts`

**Interfaces:**
- Produces: `parsePageCount(log: string): number | null`; `class CompileError extends Error { excerpt: string }`; `compileLatex(tex: string, opts: { tectonicPath: string; workDir: string }): Promise<{ pdf: Uint8Array; pages: number }>`.

- [ ] **Step 1: Write failing tests**
  - `parsePageCount('Output written on resume.xdv (2 pages, 41532 bytes).')` === 2; `'(1 page, 9 bytes)'` form === 1; unrelated log → `null`.
  - Integration (wrap in `describe.skipIf(!Bun.which('tectonic'))`): render `VALID` with a bullet `'Cut p95 latency 40% for C++ & CUDA_kernels at $0 cost — {fast} ~ ^ é “quoted”'` using `readPreamble('GEN/GEN-V3.tex')`, `compileLatex` → `pages === 1`, `pdf` starts with `%PDF`.
  - Integration: tex with `\undefinedmacro` → rejects with `CompileError` whose `excerpt` contains `Undefined control sequence`.
- [ ] **Step 2: Run** `bun test src/compile.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Write `resume.tex` in `workDir`, run `execFile(tectonicPath, ['--keep-logs', '--outdir', workDir, 'resume.tex'], { cwd: workDir, timeout: 60_000, env: {...process.env, PATH: <tectonic dir>:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin} })`. Pages come from `resume.log`. `excerpt` = each log line starting with `!` plus the next two lines, else the last 30 lines of stderr. Missing binary → `CompileError('tectonic not found at <path>')`. The pdflatex fallback is dropped (pdflatex is not installed).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Stage** — message: `feat(resume-gen): tectonic compile with page count and readable LaTeX errors`.

### Task A4: Page fit

**Files:**
- Create: `apps/resume-gen/src/fit.ts`
- Test: `apps/resume-gen/src/fit.test.ts`

**Interfaces:**
- Consumes: `ResumeDoc` (A1).
- Produces: `type BulletRef = { section: 'experience' | 'projects'; entry: number; bullet: number }`; `removalOrder(doc: ResumeDoc): BulletRef[]`; `withoutBullets(doc: ResumeDoc, refs: BulletRef[]): ResumeDoc` (pure); `fitToPages(doc: ResumeDoc, maxPages: number, measure: (d: ResumeDoc) => Promise<number>): Promise<{ doc: ResumeDoc; pages: number; fits: boolean; removed: number }>`.

- [ ] **Step 1: Write failing tests**
  - Order: doc with job0 bullets `[p1, p2, p3, p3]`, job1 bullets `[p2, p3, p2]`, project0 `[p3, p2]` → priority-3 refs come first, projects before experience, older job (job1) before job0, bottom bullet first; no priority-1 ref; job1 keeps ≥2 bullets, project keeps ≥1.
  - `withoutBullets` does not mutate its input (deep-equal snapshot before/after).
  - Fake `measure` = `d => Promise.resolve(totalBullets(d) > 8 ? 2 : 1)`: a 12-bullet doc returns `fits: true`, `removed` equals the minimal count that reaches 8 bullets (or fewer if floors force it), and `measure` was called ≤ `Math.ceil(Math.log2(candidates)) + 2` times.
  - A doc that fits immediately → `measure` called once, `removed: 0`.
  - Fake `measure` always 2 → `fits: false`, `doc` is the most-trimmed version.
- [ ] **Step 2: Run** `bun test src/fit.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Floors: per entry, sort bullets by (priority asc, index asc); the first `floor` (2 for jobs, 1 for projects) and every priority-1 bullet are protected. Candidates sorted by priority desc → projects before experience → entry index desc → bullet index desc. Binary search the smallest `k` in `[1, n]` with `pages ≤ maxPages`, memoizing `measure` by `k`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Stage** — message: `feat(resume-gen): priority-aware page fit with bounded compiles`.

### Task A5: Output naming and path safety

**Files:**
- Create: `apps/resume-gen/src/output.ts`
- Test: `apps/resume-gen/src/output.test.ts`

**Interfaces:**
- Produces: `safeFolderName(company: string, role: string): string`; `nextFreeFolder(base: string, name: string, exists: (path: string) => boolean): string` (returns an absolute folder path); `uploadPdfName(fullName: string): string`; `isPathInside(child: string, parent: string): boolean`.

- [ ] **Step 1: Write failing tests**
  - `safeFolderName('Acme/Corp | AI', 'ML Engineer: Agents*')` === `'Acme Corp AI - ML Engineer Agents'`; `safeFolderName('', '')` === `'Untitled'`; 200-char input → length ≤ 80, no trailing space/dot/dash; emoji preserved; control chars removed.
  - `nextFreeFolder('/out', 'X', p => p === '/out/X' || p === '/out/X (2)')` === `'/out/X (3)'`.
  - `uploadPdfName('Alex Rivera')` === `'Alex_Rivera_Resume.pdf'`; `uploadPdfName('  José  de la Cruz ')` === `'José_de_la_Cruz_Resume.pdf'`.
  - `isPathInside('/out/A/a.tex', '/out')` true; `'/out/../etc/x.tex'` false; `'/outside/a.tex'` vs `/out` false.
- [ ] **Step 2: Run** `bun test src/output.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Forbidden chars `/\:*?"<>|` and `\p{Cc}` → space, collapse whitespace, trim `[\s.-]` from both ends, slice to 80 then re-trim. `isPathInside` uses `path.resolve` + `path.relative` (no `..` prefix, not absolute).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Stage** — message: `feat(resume-gen): safe unique output folders and candidate-named upload PDF`.


### Task A6: Profile loader

**Files:**
- Create: `apps/resume-gen/src/profile.ts`
- Test: `apps/resume-gen/src/profile.test.ts`

**Interfaces:**
- Produces: `interface Profile { careerStory: string; bases: { id: string; text: string }[]; promptOverride: string | null }`; `class ProfileError extends Error {}`; `loadProfile(profileDir: string): Profile`.

- [ ] **Step 1: Write failing tests** (temp dirs via `fs.mkdtempSync`):
  - Dir with `career-story.md`, `resumes/mle.md`, `resumes/gen-ai.md`, no `resume-prompt.md` → `bases` ids `['gen-ai', 'mle']` (sorted), texts match files, `promptOverride === null`.
  - With `resume-prompt.md` → `promptOverride` is its text.
  - Non-`.md` files in `resumes/` are ignored.
  - Missing dir → `ProfileError` message `Profile folder not found: <dir> — set it with: theseer-pdf --set-profile <dir>`.
  - Missing `career-story.md` → message contains `career-story.md is missing`.
  - No `resumes/*.md` → message contains `No base resumes`.
  - A whitespace-only `resumes/x.md` → message contains `resumes/x.md is empty`.
- [ ] **Step 2: Run** `cd apps/resume-gen && bun test src/profile.test.ts` → FAIL.
- [ ] **Step 3: Implement** with synchronous `node:fs` reads (profiles are small); ids are file stems.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Stage** — message: `feat(resume-gen): owner-editable profile folder (career story, base resumes, prompt override)`.

### Task A7: Writer instructions + JSON schema

**Files:**
- Create: `apps/resume-gen/src/writer/resume-writer.md` (built-in instructions), `apps/resume-gen/src/writer/request.ts`, `apps/resume-gen/src/writer/request.test.ts`
- Modify: `apps/resume-gen/src/resume-doc.ts` (`base: string`, required non-empty — no fixed enum), `apps/resume-gen/src/resume-doc.test.ts`, `apps/resume-gen/src/test-fixtures.ts` (`base: 'gen-ai'`)

**Interfaces:**
- Consumes: `Profile` (A6), `ResumeDoc` (A1).
- Produces: `resumeJsonSchema(baseIds: string[]): Record<string, unknown>` (JSON Schema draft 2020-12 object mirroring the contract: required keys, `version` const 1, `priority` enum `[1,2,3]`, `base` enum `baseIds`, optional keys not required, `additionalProperties: false` on every object); `interface WriterRequest { systemPrompt: string; userMessage: string; schema: Record<string, unknown> }`; `buildWriterRequest(p: { profile: Profile; job: { text: string; url: string; title: string }; maxPages: number }): WriterRequest`. Load the built-in instructions with `import INSTRUCTIONS from './resume-writer.md' with { type: 'text' }` (bundled into the compiled binary).
- System prompt = (`profile.promptOverride` ?? built-in instructions) + `<career_story>…</career_story>` + one `<base_resume id="<id>">…</base_resume>` per base. User message = `<job url="…" title="…">…</job>` + `Page budget: <maxPages> page(s).`
- The built-in instructions, in calm plain language (no all-caps rules): truth (every claim traceable to the base resumes or career story; rephrase/reorder/merge allowed; never invent employers, titles, dates, tools, or numbers; on conflicting numbers use the chosen base's); choose the closest base by id and keep its employers, dates, and contact block; one-page budget (summary ≤ 45 words, 4–5 skill rows, newest role 4–5 bullets, next 3–4, older 2–3, bullets ≤ 30 words, priority 1/2/3 per bullet; scale up for 2 pages); mirror the job's exact terms only where true and list them in `keywords`; plain ASCII punctuation, no em dashes; omit optional keys instead of using null; return only the JSON object.

- [ ] **Step 1: Write failing tests**: `resumeJsonSchema(['gen-ai','mle'])` has `required` containing every required contract key at each level, `properties.base.enum` deep-equals `['gen-ai','mle']`, bullet `priority.enum` is `[1,2,3]`; `buildWriterRequest` puts the career story and each base (with its id attribute) in `systemPrompt`, the job text/url/title and `Page budget: 1 page(s).` in `userMessage`, and uses `promptOverride` instead of the built-in instructions when set; `validateResumeDoc({...VALID, base: ''})` reports `base is required`; if the instructions contain a ```json example, `extractResumeDoc` on it succeeds.
- [ ] **Step 2: Run** `bun test src/writer src/resume-doc.test.ts` → FAIL.
- [ ] **Step 3: Implement** and write the instructions.
- [ ] **Step 4: Run** `bun test` → all PASS.
- [ ] **Step 5: Stage** — message: `feat(resume-gen): Opus 5.5 writer instructions and run-time JSON schema`.

### Task A8: Claude Code runner

**Files:**
- Create: `apps/resume-gen/src/claude-runner.ts`, `apps/resume-gen/src/claude-runner.test.ts`

**Interfaces:**
- Consumes: `WriterRequest` (A7), `validateResumeDoc`/`extractResumeDoc` (A1).
- Produces:
  - `type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'`
  - `interface ClaudeOptions { claudePath: string; model: string; effort: Effort; fallbackModel: string | null; timeoutMs: number }`
  - `class ClaudeRunError extends Error { readonly kind: 'not-installed' | 'not-logged-in' | 'timeout' | 'failed' | 'bad-output' }`
  - `claudeArgs(req: WriterRequest, opts: ClaudeOptions): string[]` → exactly `['-p', '--safe-mode', '--tools', '', '--no-session-persistence', '--model', model, '--effort', effort, ...(fallbackModel && fallbackModel !== model ? ['--fallback-model', fallbackModel] : []), '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--system-prompt', systemPrompt]`
  - `childEnv(parent: NodeJS.ProcessEnv, claudePath: string): NodeJS.ProcessEnv` → copy without `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`; `PATH` prefixed with `dirname(claudePath)` and `/opt/homebrew/bin`.
  - `checkClaudeLogin(claudePath: string): Promise<void>` — runs `claude auth status`; requires `loggedIn === true` and `authMethod === 'claude.ai'`, else `ClaudeRunError('not-logged-in', "Claude Code isn't logged in with your Claude subscription — run `claude` and `/login`.")`.
  - `runClaudeWriter(req: WriterRequest, opts: ClaudeOptions): Promise<{ doc: ResumeDoc; durationMs: number }>` — spawns `claudePath` with `claudeArgs`, `stdin = req.userMessage`, `cwd` = a fresh temp dir (removed afterwards), `env = childEnv(process.env, claudePath)`.
- Output handling: parse stdout as JSON; `is_error === true` or `subtype !== 'success'` → `failed` with message `Claude Code failed: <result text>`; `structured_output` present → `validateResumeDoc`; else `extractResumeDoc(result)`; unparseable stdout → `bad-output` with the first 300 chars of stdout and stderr; spawn `ENOENT` → `not-installed` (`Claude Code not found at <path>`); timeout → SIGTERM, SIGKILL after 5 s, `timeout` (`Resume writing timed out after <n> min`).

- [ ] **Step 1: Write failing tests** using a fake `claude` — a Bun script the test writes to a temp dir (`#!/usr/bin/env bun`, chmod 755) that appends `{argv, hasApiKey: 'ANTHROPIC_API_KEY' in process.env, stdin}` to a log file and prints a canned reply chosen by env `FAKE_MODE` (`structured` | `text` | `error` | `garbage` | `sleep` | `auth-ok` | `auth-api`):
  - `claudeArgs` equals the exact list above (with and without fallback; fallback omitted when equal to model).
  - With `process.env.ANTHROPIC_API_KEY = 'sk-test'` in the parent, the fake logs `hasApiKey: false`; stdin equals `req.userMessage`.
  - `structured` → returns the doc; `text` (fenced JSON in `result`, no `structured_output`) → returns the doc; `error` → `ClaudeRunError` kind `failed` whose message includes the fake's result text; `garbage` → `bad-output`; `sleep` with `timeoutMs: 300` → `timeout`, and the fake process is gone; path `/nonexistent/claude` → `not-installed`.
  - `checkClaudeLogin` → resolves on `auth-ok` (`{"loggedIn":true,"authMethod":"claude.ai"}`), rejects `not-logged-in` on `auth-api` (`{"loggedIn":true,"authMethod":"api_key"}`).
- [ ] **Step 2: Run** `bun test src/claude-runner.test.ts` → FAIL.
- [ ] **Step 3: Implement** with `node:child_process` `spawn` (no shell).
- [ ] **Step 4: Run** → PASS, output pristine.
- [ ] **Step 5: Stage** — message: `feat(resume-gen): Claude Code (claude -p) writer on the Max login, API keys stripped`.

### Task A9: Pipeline, native protocol, slim main.ts

**Files:**
- Create: `apps/resume-gen/src/generate.ts`, `apps/resume-gen/src/native.ts`, `apps/resume-gen/src/config.ts`
- Modify: `apps/resume-gen/main.ts` (delete moved parsing/rendering/compile code and the self-subprocess `runResumeGenSubprocess`; keep `getBaseDir`, `runSetup`, `printUsage`; config moves to `config.ts`)
- Test: `apps/resume-gen/src/generate.test.ts`, `apps/resume-gen/src/native.test.ts`, `apps/resume-gen/src/config.test.ts`

**Interfaces:**
- Consumes: A1–A8.
- Produces:
  - `config.ts`: `interface SeerConfig { outputDir?: string; profileDir?: string; claudePath?: string }`; `loadConfig(path: string): SeerConfig`; `saveConfig(path: string, c: SeerConfig): void`; `resolveClaudePath(c: SeerConfig, home: string): string` (`c.claudePath ?? <home>/.local/bin/claude`).
  - `generate.ts`:
    - `interface BuildOptions { outputBase: string; templatePath: string; tectonicPath: string; maxPages: number; onStage?: (stage: 'compiling' | 'fitting') => void }`
    - `buildResume(doc: ResumeDoc, opts: BuildOptions): Promise<GenerateResult>` (`GenerateResult` exactly as the spec) — applies `applyDateRules`, renders, compiles in a `mkdtemp` work dir, fits, writes `<folder>/<folderName>.tex`, `<folder>/<folderName>.pdf`, `<folder>/<uploadPdfName(doc.name)>`; `measure` caches by doc JSON so no doc compiles twice.
    - `generateResume(responseText: string, opts: BuildOptions & { fallbackTitle: string | null }): Promise<GenerateResult>` — `extractResumeDoc`; on `ResumeFormatError` kind `missing` with `TAILORED RESUME` in the text → `parseLegacyMarkdown(text, fallbackTitle)`.
    - `type HostMessage = { type: 'progress'; stage: 'checking-login' | 'writing' | 'compiling' | 'fitting' } | ({ type: 'result' } & GenerateResult) | { type: 'error'; error: string; details?: string }`
    - `interface WriteRequest { command: 'write'; job: { text: string; url: string; title: string }; model: string; effort: Effort; maxPages: number }`
    - `writeResume(req: WriteRequest, deps: { loadProfile: () => Profile; checkLogin: () => Promise<void>; runWriter: (r: WriterRequest) => Promise<{ doc: ResumeDoc }>; build: (doc: ResumeDoc, onStage: (s: 'compiling' | 'fitting') => void) => Promise<GenerateResult> }, send: (m: HostMessage) => void): Promise<void>` — sends `checking-login` → `writing` → `compiling` → `fitting` progress, then one `result`, or one `error` built by `toNativeError`.
    - `recompileTex(req: { texSource: string; texPath: string; folderPath: string; uploadPdfPath?: string }, opts: { outputBase: string; tectonicPath: string }): Promise<{ success: true; pdfBase64: string; pdfSizeBytes: number; pages: number }>` — rejects `Refusing to write outside the output folder` unless `isPathInside(texPath, outputBase)`, `.tex` suffix, and `dirname(texPath) === resolve(folderPath)`.
    - `toNativeError(err: unknown): { type: 'error'; error: string; details?: string }` (`ResumeFormatError` → problems joined; `CompileError` → excerpt; `ClaudeRunError`/`ProfileError` → message only).
  - `native.ts`: `encodeNativeMessage(value: unknown): Uint8Array`; `readNativeMessage(stream: NodeJS.ReadableStream, timeoutMs?: number): Promise<unknown>`; `runNativeHost(io)` dispatch — `write` → `writeResume` with real deps (each `send` writes one framed message; exit after the terminal message); `recompile` → one response; `generate` or no command → one `generateResume` response (`fallbackTitle: input.chatTitle ?? null`).
  - CLI (`main.ts`): `theseer-pdf <reply-file> [--json] [--name <t>] [--max-pages <n>]`; `theseer-pdf --write <job.txt> [--url <u>] [--title <t>] [--model <m>] [--effort <e>] [--max-pages <n>]` (prints progress lines and the result paths); `theseer-pdf --set-profile <dir>`; existing `--setup`, `--set-output`, `--help`.

- [ ] **Step 1: Write failing tests**
  - `native.test.ts`: `readNativeMessage(Readable.from([encodeNativeMessage({a: 1})]))` → `{a: 1}`; a message split across 3 chunks still resolves; zero-length message → `{}`.
  - `generate.test.ts`: `writeResume` with fake deps → exact message sequence `progress:checking-login, progress:writing, progress:compiling, progress:fitting, result`; `runWriter` rejecting `new ClaudeRunError('failed', 'Claude Code failed: usage limit')` → sequence ends with `{ type: 'error', error: 'Claude Code failed: usage limit' }` and no `result`; `loadProfile` throwing `ProfileError` → single `error` after `checking-login` is not sent (profile loads first).
  - `generate.test.ts` (skipIf no tectonic), temp `outputBase`: `buildResume(VALID, opts)` → folder `"Acme AI - ML Engineer"` with `.tex`, `.pdf`, `Alex_Rivera_Resume.pdf`; `pages === 1`; `fits === true`; `resumeText` includes a bullet; a second run creates `"Acme AI - ML Engineer (2)"`. `generateResume` on a fenced JSON reply → same; on a legacy markdown reply → renders.
  - `recompileTex` with `texPath: join(outputBase, '..', 'evil.tex')` → rejects `Refusing to write outside the output folder`, no file created.
  - `config.test.ts`: round-trip `saveConfig`/`loadConfig`; `resolveClaudePath({}, '/h')` === `'/h/.local/bin/claude'`.
- [ ] **Step 2: Run** `bun test` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test` → all PASS.
- [ ] **Step 5: Recompile binary** (`bun run compile` in `apps/resume-gen`), `~/.theseer/bin/theseer-pdf --help` runs; `~/.theseer/bin/theseer-pdf --set-profile <repo>/data`; live smoke: `~/.theseer/bin/theseer-pdf --write <repo>/data/sample-jd.txt --model haiku --effort low` prints progress and a PDF path; open nothing, just confirm the files exist and `pages` is reported.
- [ ] **Step 6: Stage** — message: `feat(resume-gen): write command (Claude Code → PDF) with progress, path-checked recompile, slim entry point`.

---

## Part B — Extension (`apps/extension`)

### Task B1: Grok automation from tested code

**Files:**
- Modify: `apps/extension/package.json` (`"test": "tsx --test 'src/**/*.test.ts'"`)
- Modify: `apps/extension/src/shared/grok-dom.ts`, `apps/extension/src/shared/grok-dom.test.ts`
- Create: `apps/extension/src/automation/grok-page.ts` (esbuild IIFE entry → `dist/grok-page.js`)
- Modify: `apps/extension/build.mjs` (add the entry), `apps/extension/src/shared/grok-client.ts` (delete inline `grokSubmitAutomation`/`grokCaptureAutomation`; inject the file, then call it; always open its own background tab)

**Interfaces:**
- Produces (grok-dom): `GROK_SELECTORS.composer = ['.query-bar div.tiptap.ProseMirror[contenteditable="true"]', '.query-bar div.ProseMirror[contenteditable="true"]', '.query-bar [contenteditable="true"]', '.query-bar textarea']` (no bare `textarea`); `GROK_SELECTORS.modelPicker = ['#model-select-trigger', 'button[aria-label^="Model:"]', 'button[aria-label="Model select"]']`; `GROK_SELECTORS.response = ['.response-content-markdown']`; `latestResponseText(doc: ParentNode, promptHead: string): string` ('' when the latest response starts with `promptHead`).
- Produces (page bundle): `globalThis.__seerGrok = { submit(prompt: string, requestId: string, model: string): void; capture(requestId: string, promptHead: string): void }`, posting `SEER_GROK_SUBMITTED` / `SEER_GROK_RESULT` as today.
- grok-client: `chrome.tabs.create({ url: 'https://grok.com/', active: false })` every run — never reuses or navigates the owner's grok tab.

- [ ] **Step 1: Write failing tests** (fixtures from the live DOM in the spec; update existing fixtures that assumed a bare top-level `textarea` to the live `.query-bar` structure):
  - `.query-bar` ProseMirror **and** `<textarea class="persephone-panel-textarea">` → `findComposer` returns the ProseMirror.
  - Only `<textarea class="persephone-panel-textarea">` → `findComposer` is `null`.
  - `<button id="model-select-trigger" aria-label="Model: Fast">` → `findModelPicker` finds it.
  - User bubble holds the prompt, response holds `JOB_TITLE: X` → `latestResponseText(doc, prompt.slice(0, 120))` === `'JOB_TITLE: X'`; only the user bubble → `''`.
- [ ] **Step 2: Run** `cd apps/extension && pnpm test` → new tests FAIL.
- [ ] **Step 3: Implement.** `grok-page.ts` imports from `../shared/grok-dom.js`; submit waits ≤ 20 s for a composer and, if it is a `TEXTAREA`, ≤ 3 s more for a contenteditable (hydration) before filling. `fillComposer` tries `ownerDocument.execCommand('insertText', false, text)` for contenteditables before the paste fallback. grok-client injects `files: ['dist/grok-page.js']` then `func: (p, r, m) => (globalThis as any).__seerGrok.submit(p, r, m)`; on `/c/` navigation it re-injects the file and calls `capture`.
- [ ] **Step 4: Run** `pnpm test && npx tsc --noEmit && node build.mjs` → PASS, `dist/grok-page.js` exists.
- [ ] **Step 5: Stage** — message: `fix(grok): hydration-safe composer, echo-safe capture, ship the tested DOM code`.

### Task B2: Job text goes straight to both sides; Grok stops retyping the JD

**Files:**
- Create: `apps/extension/src/shared/job-text.ts`, `apps/extension/src/shared/job-text.test.ts`
- Modify: `apps/extension/src/shared/prompt-defaults.ts` (Grok template: delete the `DESCRIPTION:` and `===END_DESCRIPTION===` lines), `apps/extension/src/shared/grok-dom.ts` (`parseGrokTextResponse`: description optional), `apps/extension/src/shared/grok-client.ts` (`extractAndAnalyzeViaGrok({ jobText, jsonLd, profile, baseResumeSummaries, url, pageTitle })` sets `job.description = jobText`)

**Interfaces:**
- Produces: `htmlToText(html: string): string`; `pickJobText(input: { extraction: ExtractionResult; crawlMarkdown: string | null; iframeTexts: string[] }): string` (longest candidate, capped at 20 000 chars). Candidates: `extraction.jobData?.description` (via `htmlToText`), `extraction.rawText` only when `jobData` is null, `crawlMarkdown`, each iframe text.

- [ ] **Step 1: Write failing tests**
  - `htmlToText('<p>A &amp; B</p><ul><li>x</li><li>y</li></ul>')` === `'A & B\nx\ny'`.
  - JSON-LD case (jobData present, rawText is full-page HTML) → returns the jobData description text, not the page HTML.
  - Longer iframe text wins; result length ≤ 20 000.
  - `parseGrokTextResponse` on a reply without `DESCRIPTION:` → `job.description === ''`, title/score parsed.
- [ ] **Step 2: Run** `pnpm test` → FAIL.
- [ ] **Step 3: Implement**; the template variable stays `{{rawText}}` (keeps saved overrides working) but receives `jobText`.
- [ ] **Step 4: Run** checks → PASS.
- [ ] **Step 5: Stage** — message: `perf(grok): score only, send clean scraped job text instead of a retyped copy`.

### Task B3: Settings for the Claude Code writer

**Files:**
- Create: `apps/extension/src/shared/settings-normalize.ts`, `apps/extension/src/shared/settings-normalize.test.ts`
- Modify: `apps/extension/src/shared/types.ts`, `apps/extension/src/shared/storage.ts`, `apps/extension/src/shared/prompt-defaults.ts` (remove `claude_gen_ai|claude_mle|claude_mix` entries), `packages/cli/src/index.ts` (`export` no longer writes `prompts`)
- Delete: `apps/extension/src/shared/prompt-builder.ts` (the writer prompt now lives in the native host)

**Interfaces:**
- Produces:
  - `type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'`
  - `CLAUDE_MODELS = [{ id: 'opus', label: 'Opus 5.5' }, { id: 'sonnet', label: 'Sonnet 5.5' }, { id: 'haiku', label: 'Haiku 5.5' }, { id: 'fable', label: 'Fable 5.1' }] as const`
  - `CLAUDE_EFFORTS = [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }, { id: 'xhigh', label: 'Extra' }, { id: 'max', label: 'Max' }] as const`
  - `SeerSettings`: remove `prompts`, `claudeExtendedThinking`, `seerContext`; `claudeModel` holds a model id; add `claudeEffort: ClaudeEffort`, `maxPages: 1 | 2`.
  - `normalizeClaudeModel(stored: unknown): string` (unknown or old values like `'Sonnet 4.5'` → `'opus'`); `normalizeEffort(stored: unknown): ClaudeEffort` (→ `'medium'`); `normalizeMaxPages(stored: unknown): 1 | 2` (→ `1`). `getSettings`/`getModelPrefs` use them.
- [ ] **Step 1: Write failing tests** for the three normalizers (`'Sonnet 4.5'` → `'opus'`, `'sonnet'` → `'sonnet'`, `undefined` → `'opus'`; `'xhigh'` → `'xhigh'`, `'Extended'` → `'medium'`; `2` → `2`, `'3'` → `1`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test && node build.mjs` → PASS (tsc errors are allowed only in files B5/B7 own — Ruling 4).
- [ ] **Step 5: Stage** — message: `feat(settings): Claude Code model + effort + page settings; drop browser-era Claude prompt plumbing`.

### Task B4: Native writer client

**Files:**
- Create: `apps/extension/src/shared/native-writer.ts`, `apps/extension/src/shared/native-writer.test.ts`
- Modify: `apps/extension/src/shared/types.ts` (host protocol types mirroring the spec: `WriteStage`, `HostMessage`, `WriteResult`)

**Interfaces:**
- Produces: `interface NativePortLike { postMessage(msg: unknown): void; onMessage: { addListener(cb: (msg: unknown) => void): void }; onDisconnect: { addListener(cb: () => void): void }; disconnect(): void }`; `class WriterError extends Error { details?: string }`; `writeResumeViaHost(req: { job: { text: string; url: string; title: string }; model: string; effort: ClaudeEffort; maxPages: 1 | 2 }, io: { connect: () => NativePortLike; lastError: () => string | undefined; onProgress: (stage: WriteStage) => void; timeoutMs: number }): Promise<WriteResult>`.
- Behavior: posts `{ command: 'write', ...req }`; `progress` → `onProgress`; `result` → resolve + `disconnect()`; `error` → reject `WriterError(error)` with `details`; disconnect before a terminal message → reject with `lastError()` or `The PDF helper stopped unexpectedly — run "theseer-pdf --setup" again.`; timeout → `disconnect()` + reject `Resume writing timed out after <n> min.`; a message that is not a known `HostMessage` → reject `WriterError('Unexpected message from the PDF helper')`.
- [ ] **Step 1: Write failing tests** with a fake port (records posts, lets the test emit messages/disconnect): request shape; progress forwarding order; result resolves and disconnects; error rejects with details; early disconnect uses `lastError()`; timeout (`timeoutMs: 20`) rejects and disconnects; unknown message rejects.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** checks → PASS.
- [ ] **Step 5: Stage** — message: `feat(extension): native writer client over a long-lived port with progress and timeouts`.

### Task B5: Concurrent job runner

**Files:**
- Create: `apps/extension/src/background/job-runner.ts`, `apps/extension/src/background/job-runner.test.ts`
- Modify: `apps/extension/src/background/index.ts` (wire `PAGE_EXTRACTED` to the runner via `chrome.runtime.connectNative('com.theseer.resumegen')`; delete `claudePollState`, `CLAUDE_POLL_ALARM`, alarm listener, `SEER_CLAUDE_*` handling, `onClaudeResponseComplete`, `triggerPdfGeneration`, the company-name `RegExp`), `apps/extension/manifest.json` (remove the `claude.ai` MAIN-world content script and the `alarms` permission), `apps/extension/build.mjs` (remove the claude-hook entry), `apps/extension/src/content/index.ts` (remove the claude.ai relay block; handle `SEER_WRITER_PROGRESS`; do not touch the click handler)
- Delete: `apps/extension/src/claude-hook/`, `apps/extension/src/shared/claude-client.ts`

**Interfaces:**
- Consumes: `pickJobText` (B2), `extractAndAnalyzeViaGrok` (B2), settings (B3), `writeResumeViaHost` (B4).
- Produces: `createJobRunner(deps: { getSettings: () => Promise<SeerSettings>; pickJobText: typeof pickJobText; analyze: (input: GrokInput) => Promise<CombinedResult>; write: (req: WriterReq, onProgress: (s: WriteStage) => void) => Promise<WriteResult>; toTab: (tabId: number, msg: TabMessage) => void; onResult: (tabId: number, result: WriteResult, analysis: FitAnalysis | null) => Promise<void>; onWriteError: (tabId: number, err: WriterError) => void }): { run(tabId: number, extraction: ExtractionResult, crawl: { crawlMarkdown: string | null; iframeTexts: string[] }): Promise<CombinedResult> }` — starts `write` and `analyze` at the same time; returns the Grok result for `DEEP_ANALYSIS_RESULT`; when writing ends it waits for Grok to settle and calls `onResult(tabId, result, analysis-or-null)`; write failures call `onWriteError` for that tab only; a Grok failure never cancels the write. `WRITER_TIMEOUT_MS = 8 * 60_000`.
- Tab messages: `SEER_WRITER_PROGRESS { stage }`, `SEER_PDF_READY { pdfPath, folderName, pages, fits, trimmedBullets }`, `SEER_PDF_ERROR { error, details? }`.
- [ ] **Step 1: Write failing tests** with fakes: `write` is invoked before `analyze` resolves (concurrency); two runs interleaved (`run(1)`, `run(2)`, then the writer for 2 finishes first) → `onResult` gets each result with its own tab id; writer rejection → `onWriteError(1, …)` only; `analyze` rejection → `run` rejects but `onResult` still fires with `analysis === null`; progress stages reach `toTab` in order for the right tab.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the runner and the wiring (`onResult` stores the editor payload incl. `uploadPdfPath`, stops the badge flash, posts the notification and `SEER_PDF_READY`).
- [ ] **Step 4: Run** `pnpm test && node build.mjs` → PASS; `npx tsc --noEmit` clean except popup/options (Ruling 4).
- [ ] **Step 5: Stage** (including deletions) — message: `perf(pipeline): Grok scoring and Claude Code writing run concurrently per job; remove claude.ai automation`.

### Task B6: Resume score, PDF status in the panel, editor save fix

**Files:**
- Create: `apps/extension/src/shared/keyword-score.ts`, `apps/extension/src/shared/keyword-score.test.ts`, `apps/extension/src/editor/payload.ts`, `apps/extension/src/editor/payload.test.ts`
- Modify: `apps/extension/src/background/index.ts` (`onResult` adds `coverage` to `SEER_PDF_READY` and the notification text `Resume ready · <pages> page(s) · <matched>/<total> keywords`), `apps/extension/src/content/index.ts` (panel shows progress stages "Writing resume…", "Building PDF…", "Fitting to <n> page(s)…", then the ready line + missing keywords; `SEER_PDF_ERROR` shows a toast with `error` and the first line of `details`), `apps/extension/src/editor/index.ts` (`recompile()` returns the response; `save()` uses `nextEditorPayload`; recompile message carries `uploadPdfPath`), `apps/extension/src/shared/types.ts` (`EditorPayload.uploadPdfPath`)

**Interfaces:**
- Produces: `keywordCoverage(resumeText: string, keywords: string[]): { matched: string[]; missing: string[]; pct: number }`; `nextEditorPayload(prev: EditorPayload, latexSource: string, res: RecompileResponse): EditorPayload`.
- [ ] **Step 1: Write failing tests**: `keywordCoverage('Built CI/CD for PyTorch models in C++', ['ci/cd', 'pytorch', 'C++', 'Go', 'pytorch'])` → matched `['ci/cd','pytorch','C++']`, missing `['Go']`, pct `75` (duplicates collapse; `Go` does not match inside other words); empty keywords → pct `0`. `nextEditorPayload` keeps `pdfBase64` from `res` when present, keeps `prev.pdfBase64` otherwise, never returns an empty `pdfBase64`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; normalization lowercases and maps every run of chars outside `[a-z0-9+#./]` to one space, then matches `' ' + kw + ' '` inside `' ' + text + ' '`.
- [ ] **Step 4: Run** checks → PASS.
- [ ] **Step 5: Stage** — message: `feat(score): keyword coverage for the finished resume; live progress and real PDF errors; fix editor reopen after save`.

### Task B7: Popup/options, SPA re-analysis, escaping, cleanup

**Files:**
- Create: `apps/extension/src/shared/html.ts` (`escapeHtml(s: string): string`, string-based), `apps/extension/src/shared/url-change.ts` (`didNavigate(prev: string, next: string): boolean`, ignores hash-only changes), tests for both
- Modify: `apps/extension/popup.html` + `src/popup/index.ts` (model select from `CLAUDE_MODELS`, effort select from `CLAUDE_EFFORTS`, pages select `1 | 2`; remove the thinking and context toggles; escape dynamic HTML), `apps/extension/options.html` + `src/options/index.ts` (remove Claude prompt cards; profile import stays for Grok), `apps/extension/src/content/index.ts` (in `init`, a 1 s interval using `didNavigate` resets `pageAnalyzed`, `lastPanelData`, writer status, PDF path, icon to `S`, and removes the panel — outside the click handler; remove the Claude response modal, `renderMarkdown`, `parseClaudeResponse`, and the prompt-to-clipboard copy; wrap dynamic values in panel/toast HTML with `escapeHtml`)
- Delete: `apps/extension/src/grok/index.ts`, `apps/extension/dist/grok.js`; `saveCurrentJob`, `getCurrentJob`, `isConfigured` (storage.ts); `GET_CURRENT_JOB` and `GENERATE_PROMPT` (types + handlers); `badgeFlashOn`; Gemini wording in `scrapers/index.ts` comments; tracked build output `apps/dashboard/.next` (`git rm -r --cached apps/dashboard/.next`, then delete the folder)
- [ ] **Step 1: Write failing tests**: `escapeHtml('<img src=x onerror="a">&\'')` === `'&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;'`; `didNavigate('https://x/jobs/1', 'https://x/jobs/2') === true`; `didNavigate('https://x/a#1', 'https://x/a#2') === false`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** everything listed; `grep -rn "claudeExtendedThinking\|seerContext\|GET_CURRENT_JOB\|GENERATE_PROMPT\|claude-hook\|Gemini" apps/extension/src` returns nothing.
- [ ] **Step 4: Run** `pnpm test && npx tsc --noEmit && node build.mjs` → all clean.
- [ ] **Step 5: Stage** — message: `chore(extension): model/effort/page controls, SPA re-analysis, HTML escaping, remove dead code`.

---

## Part C — Setup, docs, end-to-end

### Task C1: Setup, README, live run

**Files:**
- Modify: `README.md` (flow diagram: concurrent Grok + Claude Code; profile folder; `claude -p` flags and the Max-login requirement; progress stages; page fit; keyword score; settings model/effort/pages; troubleshooting: not logged in, tectonic missing, usage limits; test commands for both apps; "re-run `pnpm seer export` and re-import for Grok scoring")
- [ ] **Step 1:** Rebuild everything: `cd apps/extension && node build.mjs`; `cd apps/resume-gen && bun run compile`; confirm `theseer-pdf --set-profile` points at `data/`.
- [ ] **Step 2:** Owner reloads the extension and re-imports the profile export.
- [ ] **Step 3:** Live run on two postings (one JSON-LD board, one Greenhouse/Lever iframe). Expected: Grok score in the panel while the writer reports progress, PDF notification `Resume ready · 1 page · N/M keywords`, editor opens, save + reopen works. Record timings from `[Seer BG]` logs vs. the old 1.5–3.5 min.
- [ ] **Step 4: Stage** README — message: `docs: README for Claude Code writing, profile folder, concurrent pipeline, and new settings`.
- [ ] **Step 5:** Hand the owner the staged commit list and run `/simplify` per their PR rule.
