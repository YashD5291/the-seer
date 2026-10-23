# The Seer: developer and advanced guide

The plain-language guide for users is the [README](../README.md). This page holds everything technical: how The Seer works, how to build it, the helper's command line, and the full troubleshooting list.

## How it works

1. The Chrome extension adds The Seer's **S** button to job pages. When you click it, the extension reads the page and sends the job text to the helper over Chrome's native messaging.
2. The helper (`theseer-pdf`) runs your own Claude Code the way you would from Terminal (`claude -p`):
   - Haiku scores the fit from 0 to 100 (matches, gaps, keywords). Scoring gives up after 2 minutes.
   - Opus (the default) or Sonnet writes the resume, only if the score reaches your fit bar. Writing gives up after 6 minutes.
3. The helper builds the PDF with Tectonic from the resume template (`GEN/GEN-V3.tex`). If the result is longer than your page limit, it trims the least important bullets and says so in the panel.
4. The PDF, its LaTeX source and the writer's notes land in your save folder, and Chrome sends a notification.

### Your own Claude Code

The Seer does not include, modify or share Claude Code. Each person installs their own, unmodified Claude Code and signs in with their own account, under their plan's terms. The Seer never uses API keys: it removes any `ANTHROPIC_*` and `CLAUDE_CODE_USE_*` settings before running Claude Code, and refuses to run if Claude Code is signed in with an API key, Amazon Bedrock or Google Vertex.

### Permissions and network use

- The extension asks to run on **all sites** so its button can appear on whichever job board you use. It reads a page only when you click the button on it. Besides that, the only request it makes is to load a job board's embedded job frame (Greenhouse and Lever, for example).
- The PDF builder downloads standard LaTeX support files the first time it runs. None of your content is sent.
- The job text and the text of your files go to Anthropic only through your Claude Code. Anthropic's handling of it falls under your Claude plan's terms.

## The installer

`install.sh` is attached to every release. It requires macOS 13 (Ventura) or later, on Apple Silicon or Intel, and must run as your own user, not with `sudo`. It:

- downloads the release for your kind of Mac and checks it against the published checksums;
- installs The Seer into `~/.theseer` (the helper, PDF builder, resume template and the extension in `~/.theseer/extension`);
- finds Claude Code and records where it is;
- creates `~/TheSeer/My files` and `~/TheSeer/Resumes`;
- registers the helper with Google Chrome (not Edge, Brave, Arc or Chromium);
- prepares the PDF builder, which fetches its fonts and LaTeX files. The first run takes a couple of minutes. If that step fails (for example, offline) or is skipped, your first resume takes a few minutes longer instead;
- copies the extension folder's path to your clipboard and opens `chrome://extensions`.

`.theseer` is hidden in Finder, so the Load unpacked dialog needs ⌘⇧G to reach `~/.theseer/extension`.

The installer never rewrites `~/.theseer/config.json`.

Uninstall removes `~/.theseer` (the helper, PDF builder, extension and settings file) and the helper's registration with Chrome. It keeps `~/TheSeer`, so files and resumes stay. The PDF builder's download cache can be deleted to free space: `rm -rf ~/Library/Caches/Tectonic`.

## The setup page

Reopen it any time from the toolbar icon, then **Setup & settings**.

**1. Check.** Four rows, each green or red. Each red row says what is wrong and gives a command you can copy. **Next** unlocks when all four are green.

| Row | Means |
|---|---|
| Helper connected | Chrome can talk to The Seer's helper program. |
| Claude Code installed | The Seer found `claude` on your Mac. |
| Signed in with your Claude subscription | Claude Code is signed in with a Claude plan, not an API key. |
| PDF builder ready | The tool that turns your resume into a PDF, and its resume template, are installed. |

**2. Your files.** The step has a **Career story** row, rows for **Base resume 1, 2 and 3**, and **Other files (optional)**. Once a row has a file, its button reads **Replace** and **Remove** takes the file out. No row is required; one readable file is enough to continue. PDF, Word, text and Markdown files work, up to 10 MB each. Files are copied into `~/TheSeer/My files`; originals are not touched and nothing leaves the Mac at this step. Each file shows one of:

- **read**: Claude gets its text.
- **no readable text**: usually a scanned or password-protected PDF. Export it as Word or text instead.
- **not supported**: use PDF, Word, text or Markdown.
- **too big**: over 10 MB.

If the files hold more text than Claude can be given (over 300,000 characters, or 600,000 bytes for text mostly outside English letters), the step names the largest files and **Next** stays off until some are removed or shortened. If a row in step 1 turns red meanwhile, the step says so; **Back** returns to it. The × on other files removes The Seer's copy only. Folders can't be dropped; drop the files inside them. Files placed in `~/TheSeer/My files` in Finder are picked up too (top-level files only) and listed under Other files.

**3. Preferences.** Changes save as you make them.

| Setting | Default | Notes |
|---|---|---|
| Fit bar | 40 | A resume is written only when a job scores at least this, out of 100. |
| Resume length | 2 pages | 1 or 2 pages. |
| Writer | Opus | Opus is best; Sonnet is faster and lighter on your usage. |
| Save folder | `~/TheSeer/Resumes` | **Choose…** opens the macOS folder picker. |
| Extra instructions for the writer | empty | Optional, up to 2,000 characters. See [Custom writing](#custom-writing). |

## What a run produces

Each resume gets its own folder in the save folder, named `<Company> - <Role>`. A repeat becomes `... (2)`; nothing is overwritten. Inside:

- The PDF and its `.tex` source, both named after the folder.
- `First_Last_Resume.pdf`, a copy named from the name on the resume, ready to upload.
- `notes.md`, the writer's notes on the job. Before writing, it reads the posting: the role type, the company's culture and tone, the must-haves and nice-to-haves, a gap table (each requirement, where your files show it or "NO MATCH", and what it did about it) and tone scores from 1 to 10. After writing, it adds a changelog: what it changed and why, what it cut, what it took from your other files, and the requirements it left unaddressed.

The header puts the contact details your files give (email, phone, LinkedIn, GitHub) on one line. Only when all four are present does it split into two lines: email and phone, then LinkedIn and GitHub.

If the score is below your bar, the panel says so (for example "Fit 32/100 is below 40 — no resume written.") and the writer is never called.

**Editing.** **View PDF** in the panel (or the notification) opens the editor: the PDF next to its LaTeX. The pencil button lets you edit the source; **Recompile** rebuilds the PDF and writes the `.tex` and both PDFs back to the resume's folder. The editor keeps your last 20 resumes only until you quit Chrome or reload the extension. After that, **View PDF** opens the saved PDF file instead, which needs **Allow access to file URLs** turned on for The Seer in `chrome://extensions`; if that is off, open the PDF from your save folder.

**Popup.** The toolbar popup says **Ready** or **Needs setup**. If you click The Seer's button while it is not ready, the error includes an **Open setup** button.

## Custom writing

The Seer's built-in writing instructions always run. They set the structure and style of the resume and the truth rules: nothing your files don't support, numbers stay with the work that produced them, and no addressing the target company. You cannot replace them, but you can add to them.

The **Extra instructions for the writer** box on the Preferences step is added after the built-in instructions. The writer follows it even where it differs from its usual style, for example:

> Keep my publications section. Use British spelling. Lead with backend work.

The one exception is the truth rules: the writer does as much of a request as your files support and leaves the rest. Your instructions apply to every resume written from the extension afterwards (the command-line `--write` does not use them).

## Command line and settings file

The helper is also a command-line tool (run it with `--help` for every option):

```bash
~/.theseer/bin/theseer-pdf --set-profile <folder>   # use a different "My files" folder (it must hold a readable file)
~/.theseer/bin/theseer-pdf --set-output <folder>    # change the save folder (same as the setup page)
~/.theseer/bin/theseer-pdf --write job.txt          # score a job from a text file; write the resume if it fits
~/.theseer/bin/theseer-pdf --score job.txt          # score only; prints the result as JSON
~/.theseer/bin/theseer-pdf --version
```

`--write` and `--score` take `--url`, `--title` and `--model`; `--write` also takes `--max-pages` and `--min-score`. The settings file is `~/.theseer/config.json` (`outputDir`, `profileDir`, `claudePath`).

## Building from source

```
apps/extension/   Chrome extension (Manifest V3, TypeScript, esbuild)
apps/resume-gen/  The helper: a Bun program compiled to theseer-pdf. Talks to Chrome over
                  native messaging, runs Claude Code, builds the PDF with Tectonic.
                  GEN/GEN-V3.tex is the resume template.
scripts/          build-release.sh
install.sh        the installer attached to every release
```

You need Node 22 with pnpm, Bun 1.3.10 or newer, and Tectonic (`brew install tectonic`; the helper's tests run the real PDF builder).

```bash
pnpm install

# Checks
(cd apps/extension && pnpm test && npx tsc --noEmit && node build.mjs)
(cd apps/resume-gen && bun test && bun run typecheck)
```

**Run from source.** Build the extension with `node build.mjs` in `apps/extension` (`--watch` rebuilds on change) and load that folder unpacked. The manifest's `key` fixes the extension ID, so the helper accepts it. Then, in `apps/resume-gen`, run `bun run setup:dev`. It compiles the helper to `~/.theseer/bin/theseer-pdf`, copies the template and registers the helper with Chrome. The compile targets Apple Silicon; on an Intel Mac change `bun-darwin-arm64` to `bun-darwin-x64` in `package.json`. After changing the helper, run `bun run compile` and reload the extension. `SEER_REPO=owner/repo node build.mjs` bakes your repo into the install command the setup page shows (without it, a local build shows `OWNER/REPO`).

**Build a release.** `scripts/build-release.sh <arm64|x64> <out-dir>` writes `the-seer-macos-<arch>.tar.gz` (helper, Tectonic, template and extension). Try it with `bash install.sh --from <out-dir>/the-seer-macos-arm64.tar.gz`.

**Release.** The version lives in `apps/extension/manifest.json`; the helper reports the same one. Push a tag that matches it with a `v` in front (`git tag v1.0.0 && git push origin v1.0.0`). The workflow in `.github/workflows/release.yml` runs the checks, builds both tarballs, smoke-tests them, and publishes them with `SHA256SUMS` and `install.sh`. It fails if the tag and the manifest version differ. Its actions are pinned to commit SHAs (update the SHA and its version comment together), and only the final publish job, which runs no build tools, can write to the repository.

**Logs.** Console logs are tagged `[Seer]`, `[Seer BG]`, `[Seer Setup]` (extension) and `[theseer-pdf]` (helper, on stderr).

## Troubleshooting (full list)

**Setup page, red rows**

- **Helper connected.** Paste the install command from the README into Terminal, then click **Check again**. If it says the helper and The Seer are different versions, re-run the install command and click the reload arrow on The Seer in `chrome://extensions`. If it names `~/.theseer/config.json`, the settings file is broken: fix or delete it, then re-run the install command (the installer never rewrites that file).
- **Claude Code installed.** Run Claude's own installer, then click **Check again**:
  ```bash
  curl -fsSL https://claude.ai/install.sh | bash
  ```
  If Claude Code lives somewhere unusual, open a Terminal where `claude` works and re-run The Seer's install command so it can note where it is.
- **Signed in with your Claude subscription.** Open Terminal, run `claude`, type `/login` and choose your Claude account. An API-key or cloud-provider login stays red on purpose.
- **PDF builder ready.** Re-run the install command. It also restores the resume template if that is what the row says is missing.

**Other problems**

- **"Usage limit reached" (or similar).** That is Claude's own message, shown in the panel or in a pop-up message. Wait for your limit to reset, raise the fit bar, or switch the writer to Sonnet.
- **A file says "no readable text".** Image-only (scanned) and password-protected PDFs have no text to read. Export the document as Word or text and drop that in.
- **"No readable files in My files".** Add a resume or other file on step 2 of the setup page.
- **"Your files hold ... characters of text, over the 300,000 limit"** (or "... bytes, over the 600,000-byte limit", for text mostly outside English letters). Remove or shorten some files in My files. The message names the largest ones, and the setup page shows it too.
- **"My files folder not set" or "Save folder not set".** Re-run the install command; it fills in both default folders. You can also choose the save folder on the setup page.
- **Chrome can't find the helper** ("The Seer's helper isn't installed"). Re-run the install command. The helper is registered for Google Chrome only, not Edge, Brave, Arc or Chromium.
- **"The helper stopped unexpectedly".** Re-run the install command from the setup page. Chrome's own reason follows the dash; "Failed to start native messaging host" usually means macOS blocked the helper (see the next item).
- **macOS says it cannot open the helper.** Run `xattr -dr com.apple.quarantine ~/.theseer` in Terminal.
- **macOS asks for Keychain access.** Claude Code is reading its own sign-in. Choose Allow.
- **No button on a page.** Reload the tab, and check that The Seer is switched on in its popup. Chrome does not allow extensions on `chrome://` pages or the Chrome Web Store.
- **Timed out.** Scoring gives up after 2 minutes and writing after 6. Try again, or switch the writer to Sonnet.
- **"Couldn't fit N pages"** (for example "Couldn't fit 2 pages"). Trim the resume in the editor. If Resume length is 1 page, you can also set it to 2 pages.
