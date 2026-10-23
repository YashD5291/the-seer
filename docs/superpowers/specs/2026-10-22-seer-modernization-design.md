# The Seer — Modernization Design (Oct 2026)

## Intent

The Seer turns a job posting into a tailored resume PDF. It was built in early 2026 and has not been used since ~March 2026. The owner wants to send **more** resumes of **better** quality, **faster**, to land a role soon, and wants "the best engineered software for this".

Before this work it was broken (the claude.ai and grok.com web UIs it automated had changed), slow (~1.5–3.5 min, steps run back to back), and its output is weak (every resume is 2 pages, content is dropped silently by a brittle markdown parser, nothing checks the final resume).

## Goals

1. **Works end to end again** and reports real errors (with the cause) when it doesn't.
2. **Faster**: one native-host job per click — a quick Claude Code score, then the write right away when it passes; no browser automation in between. *(Originally "Claude writes while Grok scores"; superseded by the owner decisions of 2026-10-23 below.)*
3. **Better resumes**: a writer prompt built for Opus 5.5, schema-enforced structured output that cannot be silently truncated, an automatic page-fit pass, and a keyword-coverage score for the finished resume.
4. **More resumes**: re-clicking on single-page job boards (LinkedIn-style) analyzes the new job; several jobs run at once without interfering.

## Non-goals

- No paid LLM APIs and no API keys. Claude scores and writes through **Claude Code (`claude -p`) on the owner's Max subscription**. *(Owner decisions, 2026-10-22; Grok removed 2026-10-23.)*
- No dashboard/tracking revival (tracker stays disabled behind `DASHBOARD_ENABLED = false`).
- No new resume visual template — the GEN-V3 LaTeX look stays.
- No resume content work: the owner will supply new base resumes.

## Anti-goals (failure even if it "works")

- A resume that states anything not backed by the base resumes / career story.
- Silent success: a PDF that dropped bullets, or a reported success with no resume.
- Any path that could bill an API key (`ANTHROPIC_API_KEY` must never reach the `claude` child process).
- Breaking the FAB click/drag handler in `content/index.ts` (owner rule: do not touch it).

## Constraints

- Chrome MV3 extension (`apps/extension`), esbuild, TypeScript strict; tests via `node:test` + `tsx`.
- Native host (`apps/resume-gen`) compiled with Bun to `~/.theseer/bin/theseer-pdf`; tests via `bun test`.
- PDF compiler: tectonic (`/opt/homebrew/bin/tectonic`). Page count comes from the tectonic log line `Output written on <file>.xdv (N pages` (verified; the PDF is object-stream compressed).
- Claude Code 2.1.308 at `~/.local/bin/claude`, logged in: `claude auth status` → `{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}`.
- Owner git rule: never commit; stage files and hand over commit messages. Work is on branch `feat/seer-modernization`.

## Architecture after the change

```
FAB click → content script extracts page (unchanged)
  → background: pickJobText()  ← best plain text (JSON-LD desc / page / iframe / crawl)
      → chrome.runtime.connectNative('com.theseer.resumegen'), one port per job
            host: load profile (career story + base resumes + writer prompt)
                  → claude -p (Haiku, low effort, schema-enforced JSON) → score ──→ panel: fit, gaps, ATS keywords
                  → fit < 40: skipped → panel "Fit N/100 is below 40 — no resume written."
                  → fit ≥ 40: claude -p (Opus 5.5, schema-enforced JSON) → validate ResumeDoc
                              → render LaTeX → tectonic → fit to page(s) → files
            host → progress (checking-login / scoring / writing / compiling / fitting) → result
      → background: keyword coverage (the score's ATS keywords vs resume text)
      → panel + notification "Resume ready · 1 page · 15/18 keywords" → editor
```

Claude Code (Haiku) scores first; Opus writes only when the fit score is ≥ 40 (`FIT_THRESHOLD` in `src/shared/fit.ts`, sent to the host as `minScore`), so no Opus tokens are spent on jobs that don't suit. The extension's job runner resolves the panel's analysis as soon as the host's `score` message arrives; the resume follows on the same port. The writer still picks the base resume itself (it sees all of them); the score's analysis is used for the panel and the keyword coverage. The `connectNative` port keeps the MV3 service worker alive for the whole write (Chrome ≥ 105), and one host process per job makes jobs independent.

### Profile (owner-editable files, read by the host on every write)

`profileDir` (host config `~/.theseer/config.json` → `profileDir`; set with `theseer-pdf --set-profile <dir>`; the owner points it at the repo's `data/`):

- `career-story.md` — source of truth for facts (required).
- `resumes/*.md` — base resumes; each file's stem is its id (e.g. `gen-ai`, `mle`, `mix`). At least one required. The owner will replace these.
- `resume-prompt.md` — optional; replaces the built-in writer instructions.

### Resume contract, `version: 1`

```ts
interface ResumeDoc {
  version: 1;
  target: { company: string; role: string };
  base: string;                                        // id of the base resume used (file stem)
  name: string;
  contact: { email: string; phone: string; linkedin?: string; github?: string; location?: string };
  summary: string;
  skills: { category: string; items: string[] }[];
  experience: {
    title: string; company: string; location?: string;
    start: string; end: string;                       // "Jan 2023", "Present"
    bullets: { text: string; priority: 1 | 2 | 3 }[];  // 1 = must keep, 3 = cut first
  }[];
  projects?: { name: string; link?: string; bullets: { text: string; priority: 1 | 2 | 3 }[] }[];
  education: { school: string; degree: string; date: string }[];
  keywords: string[];                                  // JD terms Claude worked in truthfully
}
```

The writer gets a JSON Schema generated from this contract at run time, with `base` constrained to the profile's actual base ids. The host still validates semantically (`validateResumeDoc`) because schemas don't express "non-empty". Text replies (CLI / legacy) still go through the fenced-block extractor, and old `## TAILORED RESUME` markdown still renders through the legacy adapter.

### Claude Code runner (verified on 2.1.308)

```
claude -p --safe-mode --tools "" --no-session-persistence
       --model <opus|sonnet|haiku|fable|full id> --effort <low|medium|high|xhigh|max>
       --fallback-model sonnet --output-format json --json-schema '<schema>'
       --system-prompt '<writer: writer instructions + career story + base resumes | scorer: scorer/instructions.md + career story + base resumes>'
   stdin: the job (url, page title, job text, page budget)
```

- `--safe-mode` disables the owner's CLAUDE.md, hooks, plugins, skills, MCP servers; auth still works. `--tools ""` removes all tools. Runs in a fresh temp cwd.
- Child env is the parent's minus every `ANTHROPIC_*` and `CLAUDE_CODE_USE_*` variable; absolute `claudePath` (config `claudePath`, default `~/.local/bin/claude`) because Chrome launches the host with a minimal `PATH`.
- Login check once per job: `claude auth status` must report `loggedIn: true`, `authMethod: "claude.ai"` and `apiProvider: "firstParty"`, else fail with "Claude Code isn't logged in with your Claude subscription — run `claude` and `/login`."
- Output (`--output-format json`, verified): one object with `type: "result"`, `subtype: "success"`, `is_error: false`, `result` (text) and `structured_output` (the schema-validated object), plus `duration_ms`, `num_turns`. `is_error: true` or a non-success `subtype` → error carrying `result` text.
- Static content (instructions, career story, bases) goes in the system prompt so repeated runs reuse the prompt cache; the job goes on stdin.
- Defaults: writer — model `opus` (Opus 5.5), effort `medium`, fallback `sonnet`, timeout 6 min; scorer — model `haiku`, effort `low`, fallback `sonnet`, timeout 2 min.

### Native messaging protocol

- **`write`** over `chrome.runtime.connectNative`: request `{ command: 'write', job: { text, url, title }, model, effort, maxPages, scoreModel: 'haiku', scoreEffort: 'low', minScore: 40 }`. Host posts `{ type: 'progress', stage: 'checking-login' | 'scoring' | 'writing' | 'compiling' | 'fitting' }` messages and one non-terminal `{ type: 'score', analysis, job }` (`analysis`: fit_score, confidence, recommended_base, base_reasoning, key_matches, gaps, gap_mitigation, tailoring_priorities, ats_keywords, red_flags, estimated_competition, apply_recommendation; `job`: title, company, location?, salary_range?, job_type?, requirements, nice_to_haves), then exactly one `{ type: 'skipped', score, threshold }`, `{ type: 'result', ...GenerateResult }` or `{ type: 'error', error, details? }`, then exits. An error before the score is shown as a toast (the panel does not open); one after it is a write failure (toast + notification).
- **`recompile`** (one-shot `sendNativeMessage`, editor): `texPath` must resolve inside the output directory, end in `.tex`, and sit in `folderPath`; compile failures return the LaTeX error excerpt.
- **`generate`** (CLI / legacy, one-shot): `{ responseText, maxPages? }` → same result shape.
- `GenerateResult` = `{ success: true, folderName, folderPath, texPath, pdfPath, uploadPdfPath, pages, fits, trimmedBullets, latexSource, pdfBase64, pdfSizeBytes, resumeText, keywords }`.
- Output folder: `"<Company> - <Role>"`, sanitized (no `/\:*?"<>|` or control chars, ≤ 80 chars), suffixed ` (2)`, ` (3)`… instead of overwriting. Upload copy named `<First>_<Last>_Resume.pdf`.

### Page fit

Target `maxPages = 1` (extension setting, default 1). If the compiled PDF is longer, bullets are removed in a fixed order — priority 3 before 2, never priority 1; projects before experience; oldest job first; bottom bullet first; keep ≥2 bullets per job and ≥1 per project — using a binary search on how many to remove (≤ ~5 compiles). If it still doesn't fit, keep the shortest version and report `fits: false`.

### Keyword score

`keywordCoverage(resumeText, keywords)` → `{ matched, missing, pct }`, case-insensitive, punctuation-normalized, whole words/phrases. Shown as "1 page · 15/18 keywords" plus the missing list.

## Decided by the owner

- Free only. Claude Code scores and writes via `claude -p` on the Max plan.
- Owner supplies new base resumes; the tool reads whatever is in `profileDir/resumes/`.
- Don't wait for approval on better ideas within those constraints.
- Don't touch the FAB click handler.
- Claude writes only when the fit score is ≥ 40 (owner, 2026-10-23); supersedes concurrent writing.
- "Go all in for Claude" (owner, 2026-10-23): Grok is removed. The native host scores each job with Claude Code (Haiku, low effort) and Opus writes only if the score is ≥ 40. The extension no longer keeps a profile, a Grok prompt or a Grok model setting; the host reads the profile folder.

## Calls made by the builder (owner may override)

- One-page target by default (setting).
- `opus` at `medium` effort by default, `sonnet` fallback.
- The writer chooses the base resume; the score's `recommended_base` is display-only.
- Upload copy named `<First>_<Last>_Resume.pdf`.
- The existing employer-specific end-date rule is ported unchanged.
- LinkedIn stays out of the PDF header (existing behavior).
- Writer instructions are overridable by `profileDir/resume-prompt.md` (replaces the old options-page Claude prompt cards).
