# The Seer — Open-Source Product Design (Oct 2026)

## Intent

The Seer turns a job posting into a tailored, one-page resume PDF in one click. The modernization (spec `2026-10-22-seer-modernization-design.md`) made it work well for its owner. The owner now wants **anyone** to be able to use it for their job hunt: a free, open-source project on GitHub, nothing sold, no servers. Each person uses **their own Claude Code with their own Claude subscription**, and **drops in whatever they already have** (resumes, career story, LinkedIn PDF, notes) instead of writing special files.

Today only the owner can run it: setup means building from source, typing CLI commands with an extension ID, hand-writing `career-story.md` and `resumes/*.md`, and the output carries owner-only rules (an employer-specific date fix, LinkedIn hidden, the owner's name in the PDF metadata). The public repo also contains the owner's career story and resumes.

## Who it's for

A job seeker on a Mac who uses Chrome and already pays for Claude (Pro, Max, Team or Enterprise) with Claude Code. Comfortable pasting one command into Terminal; not expected to know what a native messaging host, LaTeX or a JSON file is.

## Goals

1. **Ten minutes from the GitHub page to the first resume**: one pasted install command, three Chrome clicks, a three-step setup page, done.
2. **Drop-in profile**: the person drops files (PDF, Word, text, Markdown) and The Seer uses them as-is. No required file names, no folders to organize, no Markdown to write.
3. **Every "not ready" state says exactly what to do**, with a copy-paste fix where one exists.
4. **Generic output**: nothing owner-specific in the code, the template, the prompts, the PDF or the repo.
5. **No quality regression for the owner**: the owner's own files, dropped in through the new flow, produce resumes as good as today's.

## Non-goals

- Windows, Linux, and Chromium browsers other than Google Chrome.
- Chrome Web Store listing, Apple notarization, auto-update.
- Job tracking, dashboards, accounts, telemetry, any server.
- More than one resume look (the GEN-V3 LaTeX design stays the only one).
- Paid APIs or API keys of any kind (unchanged from the modernization).
- Reading images, scanned (image-only) PDFs, `.pages` files or archives.

## Anti-goals (failure even if it "works")

- Any of the owner's personal data left in the repo or in a stranger's output (name, contact details, PDF author field, employer-specific rules).
- Losing the owner's only copy of their profile files during the cleanup.
- A user's file silently ignored: a dropped file that contributes nothing must say so.
- A path that bills an API key, or that runs anyone's Claude Code with someone else's login.
- Copying files out of the user's Mac anywhere except what their own Claude Code sends to Anthropic.
- Breaking the FAB click/drag behaviour in `apps/extension/src/content/index.ts` (owner rule). The owner allows two edits inside `handleClick`: the pass mark comes from the fit-bar setting instead of the literal `40`, and the not-ready error toast gets an "Open setup" button. Nothing else in `attachDragHandler`/`handleClick` changes.

## Constraints

- Builds on the modernized code: Chrome MV3 extension (`apps/extension`, esbuild, TypeScript strict, `node:test` + `tsx`) and the Bun native host (`apps/resume-gen`, `bun test`), the score-gated pipeline (Haiku scores; Opus writes only when fit ≥ threshold), `ResumeDoc` v1, page fit, keyword coverage and the native protocol all stay.
- macOS on Apple Silicon and Intel; Chrome ≥ 120 (existing `minimum_chrome_version`). Lowest macOS version: 13 (Ventura) — the Bun-compiled helper needs 13.0 (verified with otool); the installer refuses older macOS before downloading.
- Claude Code is installed by the user. The host requires a subscription login (`claude auth status` → `loggedIn`, `authMethod: "claude.ai"`, `apiProvider: "firstParty"`) and strips every `ANTHROPIC_*` / `CLAUDE_CODE_USE_*` variable from the child (unchanged).
- Binaries are unsigned/ad-hoc signed. They are downloaded with `curl` (which does not set the quarantine attribute), so Gatekeeper does not block them.
- Chrome launches the host with a minimal `PATH`; every tool path the host uses is absolute.
- Native messaging: host → extension messages are capped at 1 MB by Chrome; extension → host messages may be much larger, but the host's own reader currently rejects messages over 1 MB.
- Owner workflow rules: TDD, strict typing, no silent catches, README updated in the same pass, never commit (stage and hand over messages), no Co-Authored-By lines.

## The user's journey

1. **Install.** README's first line of instructions: paste
   `curl -fsSL https://github.com/<owner>/<repo>/releases/latest/download/install.sh | bash`
   into Terminal. The script:
   1. Refuses anything but macOS; picks the `arm64` or `x64` build.
   2. Downloads `the-seer-macos-<arch>.tar.gz` from the same release, checks it against the release's `SHA256SUMS`, and unpacks it into `~/.theseer/` (`bin/theseer-pdf`, `bin/tectonic`, `templates/default.tex`, `extension/`). Existing config and user files are never touched.
   3. Finds Claude Code (on `PATH`, then the usual install locations) and records its absolute path as `claudePath` in `~/.theseer/config.json`. If it isn't found, it prints the official install command and keeps going; the setup page shows the same fix.
   4. Registers the native host for Google Chrome with the fixed extension ID (no ID copying).
   5. Creates `~/TheSeer/My files` and `~/TheSeer/Resumes` and records them as `profileDir` and `outputDir`, unless the config already has values.
   6. Warms up tectonic with a tiny compile so its TeX files download now rather than during the first resume.
   7. Prints the three Chrome steps (open `chrome://extensions`, turn on Developer mode, Load unpacked → `~/.theseer/extension`). It copies that path to the clipboard and says to press ⌘⇧G in the folder dialog and paste, since `.theseer` is hidden in Finder.
   Re-running the command updates in place. `… | bash -s -- --uninstall` removes `~/.theseer` and the native host registration and leaves `~/TheSeer` alone.
2. **Setup page.** Opens by itself the first time the extension loads. Three steps (owner's pick, option A; mockup in `.superpowers/brainstorm/2773-1792751955/content/onboarding.html`):
   1. **Check**: one row each for *Helper connected*, *Claude Code installed*, *Signed in with your Claude subscription*, *PDF builder ready*. Green or red; each red row says what's wrong and gives a "Fix it for me" copy-paste command (or, for sign-in, "run `claude` in Terminal and type `/login`"). A signed-in-with-API-key/Bedrock/Vertex account is red with an explanation that The Seer only uses subscription login. Re-checks on a button and when the tab regains focus. "Next" is enabled when all rows are green.
   2. **Your files**: a big drop zone plus "Choose files…". Hint: add your resumes, career story, LinkedIn profile PDF, project notes, anything true about your work; files stay on this Mac. Each file shows its name, a word count and a status: read ✓, "no readable text" ⚠ (with "export it as Word or text"), or "too big" ✗. Remove (×) and "Open folder" (Finder). "Next" is enabled when at least one file was read.
   3. **Preferences**: fit bar (slider, default 40), pages (1 or 2, default 1), writer (Opus, best; Sonnet, faster and lighter on usage), save folder ("Choose…" opens the macOS folder picker; "Open" shows it in Finder). "Done" shows a closing screen: open any job posting and click The Seer's button.
3. **Use.** Unchanged from the modernization: click the FAB on a posting, see the fit score, get a PDF when the fit is at or above the bar.
4. **Come back later.** The popup shows Ready / Needs setup and a "Setup & settings" button that reopens the setup page. A FAB click while not ready shows a toast with an "Open setup" button instead of a raw error.

## Decided by the owner

- Free, open-source GitHub project; nothing sold; no servers. Users bring their own Claude Code subscription.
- Users drop in everything they have; no hand-written profile files.
- Mac only (Apple Silicon and Intel).
- First-run setup is a step-by-step page (option A): Check → Your files → Preferences, reopenable from the popup.
- Install is one `curl … | bash` from a GitHub release with prebuilt binaries (no Bun or build step for users), a Claude Code check, native host registration, and a fixed extension ID; then Load unpacked.
- Strip the owner's personal data and owner-specific rules (employer-specific date rule, hidden LinkedIn header, owner-named fixtures).
- The resume header comes from the user's own files; one PDF look.
- Non-goals: Windows/Linux, Chrome Web Store, job tracking, servers.
- README explains that each user runs their own, unmodified Claude Code under their own account.
- **Publish as a fresh public repo** (2026-10-23): the current repo becomes private and the product goes out as a new repo whose history starts clean. Its address is not chosen yet, so the repo slug lives in one place each for `install.sh`, the README and the workflow, set at handoff.
- **Two edits inside `handleClick` are allowed** (2026-10-23): the fit-bar pass mark and the "Open setup" toast button. The click/drag behaviour itself stays untouched.
- **MIT license** (2026-10-23).
- **Owner changes after the live run (2026-10-24):** "Your files" asks separately for a career story and three base resumes (each its own upload button, none required; a new upload to a filled slot replaces it), then "Add more files" for anything else; documents reach Claude labelled as career story, resume or other. Two pages is the default length. The owner's chosen resume format (their own `.tex`, kept outside the repo) is the one built-in look; there is no template upload.
- **Built-in prompts always run; users can add custom instructions** (2026-10-23): an optional "Extra instructions for the writer" box on the Preferences step. Its text is added after the built-in writer instructions, and the writer follows it even where it differs from the built-in style and tailoring guidance, but never against the Truth rules. The `resume-prompt.md` full override is removed.

## Architecture changes

### Release and install

- A GitHub Actions workflow on tags `v*` (replacing today's `release.yml` matrix) builds, on macOS runners, the helper for `bun-darwin-arm64` and `bun-darwin-x64`, downloads the matching tectonic release binary for each, builds the extension once, and publishes `the-seer-macos-arm64.tar.gz`, `the-seer-macos-x64.tar.gz`, `SHA256SUMS` and `install.sh` as release assets. It fails if the tag, `manifest.json` version and helper version differ, and smoke-runs `theseer-pdf --version` for both architectures (x64 under Rosetta).
- tectonic ships inside the release; the host already looks for `<install root>/bin/tectonic` first. Homebrew is not required.
- `install.sh` is the single installer (the current root `install.sh`, `install.ps1` and `apps/resume-gen/native-host/install.sh` are replaced). It is idempotent and offers `--uninstall`.

### Fixed extension ID

`manifest.json` gets a `key` (a public key generated once; the private key is not needed for unpacked loading and is never committed). The ID derived from it is the default for `theseer-pdf --setup` and goes in the native host's `allowed_origins`. The options page's "copy your extension ID" flow goes away.

### Helper (native host) additions

New one-shot commands over `sendNativeMessage`, used by the setup page and the popup:

| Command | Request | Reply |
|---|---|---|
| `status` | — | helper version; Claude Code `{ path, loggedIn, plan, problem }`; tectonic `{ path }`; `profileDir`; `outputDir`; the file list |
| `add-file` | `{ name, dataBase64 }` | the stored file's entry `{ name, kind, words, status }` |
| `remove-file` | `{ name }` | the updated file list |
| `choose-folder` | — | the chosen absolute path, or cancelled (macOS folder picker via `osascript`) |
| `set-output` | `{ outputDir }` | saved, after checking the folder exists and is writable |
| `open-folder` | `{ which: 'files' \| 'resumes' }` | opened in Finder |

- Dropped files are **copied** into `profileDir`; the user's originals stay where they were. Remove deletes only that copy. Name clashes get ` (2)`, ` (3)`… suffixes. Size cap per file: 10 MB. The host's input limit rises enough for that (base64 overhead included); replies stay under 1 MB.
- The extension checks that the helper version equals its own; a mismatch is a red *Helper connected* row ("re-run the install command").

### Profile: "My files"

- Every top-level file in `profileDir` is a **source document**; hidden files are not sources. `career-story.md` and `resumes/` are no longer required or special.
- Text is extracted once per file with macOS built-ins and cached in `profileDir/.seer/` (refreshed when the file's size or modified time changes, so edits made in Finder are picked up):
  - `.txt`, `.md`: read as UTF-8.
  - `.docx`, `.doc`, `.rtf`, `.odt`: `textutil -convert txt -stdout`.
  - `.pdf`: PDFKit through `osascript -l JavaScript` (`PDFDocument.string`). Verified on this Mac on 2026-10-23: extracts a generated resume in 0.08 s.
  - Anything else, or empty extracted text: listed with a status, never sent to Claude.
- Total extracted text is capped (builder picks the number; it must leave room inside Haiku's context for the scorer's prompt). Over the cap, the setup page and the host error both name the largest files.
- Writes and scores fail with a setup-pointing error when no source document is readable.

### Prompts

- The writer and scorer system prompts take `<document name="…">` blocks instead of `<career_story>` and `<base_resume id="…">`.
- The writer instructions are rewritten source-agnostic: if the documents include resumes, start from the one closest to the posting and keep its name, contact block, employers, titles, dates and education exactly; draw extra true detail from every other document; if no document is a resume, build from the documents' facts. All existing truth rules stay word for word in spirit (nothing unsupported, numbers stay attached, no addressing the target company).
- When the user has written extra instructions, they go last in the writer's system prompt as an `<extra_instructions>` block; the instructions say to follow them unless they conflict with the Truth rules.
- `ResumeDoc.base` keeps its name; its schema enum becomes the source documents' names. The scorer's `recommended_base` likewise names a document.
- When documents disagree, the newest information wins: each `<document>` block carries the file's modified date, and the instructions say contact details and the list of jobs come from the most recent facts (a job ending "Present" or the latest end date beats an older document's list; contact details from the most recently modified resume). The starting resume still sets the structure and emphasis. *(Builder's call.)*

### Resume output

- Header: name, then email · phone · LinkedIn · GitHub, each when present (the owner's hide-LinkedIn rule goes). No location line (unchanged).
- The PDF author field comes from `doc.name` (today the template hard-codes the owner's name).
- The shipped template is the GEN-V3 preamble only, without the owner's sample body.
- `src/rules.ts` (employer-specific date rule) is deleted.
- Upload copy stays `<First>_<Last>_Resume.pdf`, derived from the name on the resume.

### Settings

| Setting | Lives in | Default |
|---|---|---|
| Fit bar (`minScore`) | extension storage (today the `FIT_THRESHOLD` constant) | 40 |
| Pages | extension storage | 2 |
| Writer model | extension storage | Opus |
| Save folder | helper config `outputDir` | `~/TheSeer/Resumes` |
| Extra instructions for the writer (`writerNotes`, ≤ 2,000 characters) | extension storage, sent with each write | empty |
| My files folder | helper config `profileDir` | `~/TheSeer/My files` (changed only via `--set-profile`) |

The popup's model/effort/pages controls move to the setup page. Effort leaves the UI (fixed at `medium`).

### Repo cleanup

- Remove personal data: `data/`, the owner's career-story file in `docs/`, `docs/prompts/`, `docs/resumes/`, the template's sample body, owner details in tests and fixtures (replaced with an invented person), and owner names, contacts and employer rules in the modernization spec and plan. **Before deleting anything, the owner's files are copied to `~/TheSeer/My files`** (or wherever the owner says), and the owner's config is pointed there.
- Remove code no product user can run or that is already dead: `packages/` (core, db, cli), `apps/crawl-server` and the Crawl4AI fetch in the background script, `apps/dashboard` leftovers and `tracker.ts`, `the-seer-final-blueprint.md`, `apps/resume-gen/resume-gen.mjs`, the old Node host in `apps/resume-gen/native-host/`, `install.ps1`, and the Windows/Linux targets in `build.ts`.
- Add an MIT `LICENSE`. The copyright line uses the repo's git author name unless the owner gives another at handoff.

### Publishing (owner's steps after handoff)

The builder leaves a cleaned tree with no personal data in any tracked file (checked with a `git grep` for the owner's name, emails, phone, profile URLs and employer rule) and hands over the commands. The owner then makes the current repo private, creates the new public repo, pushes the cleaned tree to it as a single first commit, and pushes the first `v*` tag to produce the release. Because the new repo starts clean, the order of the modernization commits and this work doesn't matter for privacy.
- README rewritten for job seekers first: what it does, requirements (Mac, Chrome, Claude subscription with Claude Code), install, setup, use, privacy (files stay on the Mac; job text and file text go to Anthropic through the user's own Claude Code; no telemetry; why the extension asks for all sites), usage cost (one Haiku call per job, plus one Opus or Sonnet call when it writes), troubleshooting, update, uninstall, and a developer section. It notes that each user runs their own, unmodified Claude Code under their own account and plan terms.

## Left to the builder (calls I made; the owner may override)

- **tectonic is bundled in the release** instead of installed with Homebrew (the playback said Homebrew). The host already supports it and it removes a dependency.
- Default folders under `~/TheSeer/` (not `~/Documents`), because a Chrome-launched helper touching Documents, Desktop or Downloads triggers macOS privacy prompts.
- Extension installed at `~/.theseer/extension`, with the clipboard + ⌘⇧G instruction for the hidden folder.
- Top-level files only in My files; subfolders are ignored.
- Effort leaves the UI (fixed `medium`).
- Crawl4AI path removed (needs a Python server no user will run).
- LinkedIn shown in the header when present.
- `--uninstall` in the installer.
- Exact copy, layout and styling of the setup page and popup; how the setup page picks its starting step on reopen; text-cap number; how "Fix it for me" commands are worded (the Claude Code install command must be checked against Anthropic's current docs at build time).
- Acceptance test: on a fresh macOS user account, follow only the README, from the install command to a resume PDF, with an invented person's files. Because the builder can't push tags, `install.sh` also accepts `--from <tarball>` for this test; the real-release run is the owner's step after handoff (owner pushes the first `v*` tag).
- Quality check: before the prompts are rewritten, save "before" resumes from the current pipeline for three postings (including the Scale AI and Databricks postings already used); after the change, generate "after" resumes from the same files dropped in through the setup page and hand both sets to the owner side by side at handoff. Page count and keyword coverage must not drop. The work does not stop mid-build for this review; the old code stays recoverable in git.
