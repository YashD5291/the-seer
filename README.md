# The Seer

Open a job posting, click one button, get a resume tailored to it.

The Seer is a free, open-source Chrome extension. You give it the files you already have (resumes, a LinkedIn profile PDF, career notes). On a job posting it scores how well you fit, and if the fit is good enough it writes a resume for that job (one page by default) as a PDF, using only what your files say. It runs on your own Claude subscription through Claude Code, on your Mac. Nothing is sold, there are no accounts or servers, and it never uses API keys.

1. **Click** The Seer's **S** button (bottom-right corner) on any job posting.
2. **Score.** Claude (Haiku) rates your fit from 0 to 100 and shows matches, gaps and keywords.
3. **Resume.** If the score is at or above your bar (40 by default), Claude (Opus or Sonnet) writes a tailored resume. The PDF lands in your save folder.

## Requirements

- A Mac running **macOS 13 (Ventura) or later**, Apple Silicon or Intel. The installer refuses older versions.
- **Google Chrome** 120 or newer. Other browsers are not supported.
- A **Claude Pro, Max, Team or Enterprise** subscription, with [Claude Code](https://code.claude.com/docs/en/setup) installed and signed in.

You do not need Homebrew, Node or Bun.

## Install

Paste this into Terminal:

```bash
curl -fsSL https://github.com/YashD5291/the-seer/releases/latest/download/install.sh | bash
```

It downloads the release for your kind of Mac, checks it against the published checksums, installs The Seer into `~/.theseer`, finds Claude Code, creates your two folders (`~/TheSeer/My files` and `~/TheSeer/Resumes`) and prepares the PDF builder. The first run takes a couple of minutes while the PDF builder fetches its fonts and LaTeX files; if that step fails (for example, offline) or you skip it, your first resume takes a few minutes longer instead. Run it as yourself, not with `sudo`.

Then add the extension to Chrome. The installer copies the folder's path to your clipboard and opens `chrome://extensions` for you.

1. Turn on **Developer mode** (top right).
2. Click **Load unpacked**.
3. In the file dialog press **⌘⇧G**, paste (⌘V) and press Return, then click **Select**. The folder is `~/.theseer/extension`; the dialog needs the shortcut because `.theseer` is hidden in Finder.

The Seer's setup page opens by itself.

## Set up

The setup page has three steps. You can reopen it any time: click The Seer's toolbar icon, then **Setup & settings**.

**1. Check.** Four rows, each green or red:

| Row | Means |
|---|---|
| Helper connected | Chrome can talk to The Seer's helper program. |
| Claude Code installed | The Seer found `claude` on your Mac. |
| Signed in with your Claude subscription | Claude Code is signed in with a Claude plan, not an API key. |
| PDF builder ready | The tool that turns your resume into a PDF, and its resume template, are installed. |

Every red row says what is wrong and how to fix it, with a command you can copy. Click **Check again** after fixing. **Next** unlocks when all four are green.

**2. Your files.** Drop in everything true about your work: resumes, a career story, your LinkedIn profile saved as PDF, project notes. PDF, Word, text and Markdown files all work, up to 10 MB each. The Seer copies them into `~/TheSeer/My files`; your originals are not touched and nothing leaves your Mac at this step. Each file shows one of:

- **read**: Claude gets its text.
- **no readable text**: usually a scanned or password-protected PDF. Export it as Word or text instead.
- **not supported**: use PDF, Word, text or Markdown.
- **too big**: over 10 MB.

You need at least one readable file. If your files hold more text than Claude can be given (over 300,000 characters), the step says so under the list, names the largest files, and **Next** stays off until you remove or shorten some. If a row in step 1 turns red while you are here, the step says so; click **Back** to fix it. The × removes The Seer's copy only. Folders can't be dropped; drop the files inside them. Files you put into `~/TheSeer/My files` in Finder are picked up too (top-level files only).

**3. Preferences.** Changes save as you make them.

| Setting | Default | Notes |
|---|---|---|
| Fit bar | 40 | A resume is written only when a job scores at least this, out of 100. |
| Resume length | 1 page | 1 or 2 pages. |
| Writer | Opus | Opus is best; Sonnet is faster and lighter on your usage. |
| Save folder | `~/TheSeer/Resumes` | **Choose…** opens the macOS folder picker. |
| Extra instructions for the writer | empty | Optional, up to 2,000 characters. See [Custom writing](#custom-writing). |

## Use

1. Open a job posting and click The Seer's **S** button in the bottom-right corner (drag it if it is in the way).
2. The panel shows your fit score, which of your files is closest to the job, key matches, gaps with ways to address them, and the job's keywords.
3. If the score is below your bar, you see "Fit 32/100 is below 40 — no resume written." and the writer is never called.
4. At or above the bar, the panel shows progress (writing, building the PDF, fitting to your page limit), then "Resume ready", and Chrome sends a notification. A resume usually takes a minute or two.

Each resume gets its own folder in your save folder, named `<Company> - <Role>`. A repeat becomes `... (2)`; nothing is overwritten. Inside:

- The PDF and its `.tex` source, both named after the folder.
- `First_Last_Resume.pdf`, a copy named from the name on the resume, ready to upload.

The header puts your email and phone on one line and your LinkedIn and GitHub on the next, each only when your files give it.

If the resume is longer than your page limit, The Seer trims the least important bullets and says so in the panel.

**Editing.** Click **View PDF** in the panel (or the notification) to open the editor: the PDF next to its LaTeX. The pencil button lets you edit the source; **Recompile** rebuilds the PDF and writes the `.tex` and both PDFs back to the resume's folder. The editor keeps your last 20 resumes only until you quit Chrome or reload the extension (including the reload the [Update](#update) step asks for). After that, **View PDF** opens the saved PDF file instead, which needs **Allow access to file URLs** turned on for The Seer in `chrome://extensions`; if that is off, open the PDF from your save folder.

**Popup.** The toolbar popup says **Ready** or **Needs setup**. If you click The Seer's button while it is not ready, the error includes an **Open setup** button.

## Privacy

- Your files stay on your Mac, in `~/TheSeer/My files`. The Seer has no servers, no accounts and no telemetry.
- When you click the button, the **text of the job posting** and the **text of your files** go to Anthropic, through the Claude Code you installed, signed in as you. That is the only place your content goes. Anthropic's handling of it falls under your Claude plan's terms.
- The extension asks to run on **all sites** so its button can appear on whichever job board you use. It reads a page only when you click the button on it. Besides that, the only request it makes is to load a job board's embedded job frame (Greenhouse and Lever, for example).
- The PDF builder downloads standard LaTeX support files the first time it runs. None of your content is sent.

## Usage cost

The Seer is free; the only cost is your Claude plan's usage. Each job uses **one Haiku call** to score the fit, plus **one Opus or Sonnet call** only when the fit reaches your bar. These count against your plan's usage limits like any other Claude use. To spend less, raise the fit bar or pick Sonnet as the writer.

## Your own Claude Code

The Seer does not include, modify or share Claude Code. Each person installs their own, unmodified Claude Code and signs in with their own account, under their plan's terms. The Seer runs it the way you would from Terminal (`claude -p`). It never uses API keys: it removes any `ANTHROPIC_*` and `CLAUDE_CODE_USE_*` settings before running Claude Code, and refuses to run if Claude Code is signed in with an API key, Amazon Bedrock or Google Vertex.

The Seer is an independent project. It is not made or endorsed by Anthropic.

## Troubleshooting

**Setup page, red rows**

- **Helper connected.** Paste the install command from [Install](#install) into Terminal, then click **Check again**. If it says the helper and The Seer are different versions, re-run the install command and click the reload arrow on The Seer in `chrome://extensions`. If it names `~/.theseer/config.json`, the settings file is broken: fix or delete it, then re-run the install command (the installer never rewrites that file).
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
- **"Couldn't fit 1 page".** Set Resume length to 2 pages, or trim in the editor.

## Update

Run the install command again, then open `chrome://extensions` and click the reload arrow on The Seer. Your files, resumes and settings stay as they are.

## Uninstall

```bash
curl -fsSL https://github.com/YashD5291/the-seer/releases/latest/download/install.sh | bash -s -- --uninstall
```

This removes `~/.theseer` (the helper, PDF builder, extension and settings file) and the helper's registration with Chrome. It keeps `~/TheSeer`, so your files and resumes stay; delete that folder yourself if you want them gone. Then remove The Seer's card in `chrome://extensions`.

The PDF builder's download cache in `~/Library/Caches/Tectonic` can be deleted to free space (`rm -rf ~/Library/Caches/Tectonic`).

## Custom writing

The Seer's built-in writing instructions always run. They set the structure and style of the resume and the truth rules: nothing your files don't support, numbers stay with the work that produced them, and no addressing the target company. You cannot replace them, but you can add to them.

The **Extra instructions for the writer** box on the Preferences step is added after the built-in instructions. The writer follows it even where it differs from its usual style, for example:

> Keep my publications section. Use British spelling. Lead with backend work.

The one exception is the truth rules: the writer does as much of a request as your files support and leaves the rest. Your instructions apply to every resume written from the extension afterwards (the command-line `--write` does not use them).

## Advanced

The helper is also a command-line tool (run it with `--help` for every option):

```bash
~/.theseer/bin/theseer-pdf --set-profile <folder>   # use a different "My files" folder (it must hold a readable file)
~/.theseer/bin/theseer-pdf --set-output <folder>    # change the save folder (same as the setup page)
~/.theseer/bin/theseer-pdf --write job.txt          # score a job from a text file; write the resume if it fits
~/.theseer/bin/theseer-pdf --score job.txt          # score only; prints the result as JSON
~/.theseer/bin/theseer-pdf --version
```

`--write` and `--score` take `--url`, `--title` and `--model`; `--write` also takes `--max-pages` and `--min-score`. The settings file is `~/.theseer/config.json` (`outputDir`, `profileDir`, `claudePath`).

## For developers

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

**Run from source.** Build the extension with `node build.mjs` in `apps/extension` (`--watch` rebuilds on change) and load that folder unpacked. The manifest's `key` fixes the extension ID, so the helper accepts it. Then, in `apps/resume-gen`, run `bun run setup:dev`. It compiles the helper to `~/.theseer/bin/theseer-pdf`, copies the template and registers the helper with Chrome. The compile targets Apple Silicon; on an Intel Mac change `bun-darwin-arm64` to `bun-darwin-x64` in `package.json`. After changing the helper, run `bun run compile` and reload the extension. `SEER_REPO=owner/repo node build.mjs` bakes your repo into the install command the setup page shows.

**Build a release.** `scripts/build-release.sh <arm64|x64> <out-dir>` writes `the-seer-macos-<arch>.tar.gz` (helper, Tectonic, template and extension). Try it with `bash install.sh --from <out-dir>/the-seer-macos-arm64.tar.gz`.

**Release.** The version lives in `apps/extension/manifest.json`; the helper reports the same one. Push a tag that matches it with a `v` in front (`git tag v1.0.0 && git push origin v1.0.0`). The workflow in `.github/workflows/release.yml` runs the checks, builds both tarballs, smoke-tests them, and publishes them with `SHA256SUMS` and `install.sh`. It fails if the tag and the manifest version differ. Its actions are pinned to commit SHAs (update the SHA and its version comment together), and only the final publish job, which runs no build tools, can write to the repository.

Console logs are tagged `[Seer]`, `[Seer BG]`, `[Seer Setup]` (extension) and `[theseer-pdf]` (helper, on stderr).

## License

[MIT](LICENSE)
