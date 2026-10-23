# The Seer

Open a job posting. Click one button. Get a resume tailored to that job.

The Seer is a free Chrome extension for Mac. It reads the job, checks how well you fit, and writes a PDF resume for it, using only what your own files say.

- **Scores your fit** from 0 to 100, with your matches, your gaps and the job's keywords.
- **Writes a tailored resume** as a PDF (two pages by default), but only when the job is a good fit.
- **Explains its choices** in a notes file that comes with every resume.
- **Stays private.** No accounts, no servers, no tracking.

## What you need

- A Mac with **macOS 13 (Ventura) or newer**.
- **Google Chrome**, version 120 or newer. Other browsers don't work.
- A paid **Claude plan** (Pro, Max, Team or Enterprise), with **Claude Code** installed and signed in. [How to install Claude Code](https://code.claude.com/docs/en/setup).

## Install (5 minutes)

**Step 1. Run the installer.** Open Terminal (press ⌘ Space, type "Terminal", press Return). Paste this and press Return:

```bash
curl -fsSL https://github.com/YashD5291/the-seer/releases/latest/download/install.sh | bash
```

It takes a couple of minutes the first time.

**Step 2. Add The Seer to Chrome.** The installer opens `chrome://extensions` for you and copies the folder's path.

1. Turn on **Developer mode** (top right).
2. Click **Load unpacked**.
3. Press **⌘⇧G**, paste with **⌘V**, press **Return**, then click **Select**.

The Seer's setup page opens by itself.

## Set up

The setup page has three steps. To open it again, click The Seer's icon in the Chrome toolbar, then **Setup & settings**.

1. **Check.** Four lights show that everything is ready. If one is red, it tells you how to fix it.
2. **Your files.** Add your **career story** (your work history in your own words), up to **three resumes** you already use, and any other files that are true about your work, like your LinkedIn profile saved as a PDF. One readable file is enough. PDF, Word, text and Markdown files all work.
3. **Preferences.** Pick:
   - your **fit bar**: the lowest score that gets a resume (40 by default),
   - **1 or 2 pages** (2 by default),
   - the writer, **Opus** (best quality) or **Sonnet** (faster, uses less of your plan),
   - the **folder** where resumes are saved,
   - and, if you like, **extra instructions**, such as "Use British spelling."

The Seer never adds anything your files don't support.

## Use it

1. Open a job posting.
2. Click The Seer's **S** button in the bottom-right corner of the page.
3. You see your fit score, how your files match, your gaps and the job's keywords.
4. If the score reaches your bar, The Seer writes a tailored PDF. It takes about two to three minutes, and Chrome tells you when it's ready. If the score is too low, it says so and writes nothing.

Each job gets its own folder in your save folder. Inside you'll find:

- the **PDF** resume, plus a copy named with your name, ready to upload;
- **`notes.md`**, which explains what the job asks for, where your files match, and what was changed and why.

Click **View PDF** in the panel to open the resume and tweak it.

## Your privacy

- Your files stay on your Mac.
- When you click the button, the text of the job posting and of your files goes to Anthropic, but only through your own Claude Code, signed in as you. It goes nowhere else.
- No servers, no tracking, no API keys.
- Chrome says The Seer can run on all websites. That's so the button can show up on any job site. It reads a page only when you click the button.

## Cost

The Seer is free. It uses your Claude plan's usage: one quick check for each job, plus one writing run only when the job fits. To use less, raise your fit bar or choose Sonnet.

## Troubleshooting

The setup page tells you what's wrong and how to fix it. The most common problems:

- **A red light on the setup page.** Run the install command from above again, then click **Check again**. If macOS says it can't open the helper, paste `xattr -dr com.apple.quarantine ~/.theseer` into Terminal.
- **Claude Code isn't signed in.** In Terminal, type `claude`, then `/login`, and choose your Claude account. Logins that use an API key don't work.
- **"Usage limit reached."** That's Claude's own message. Wait for your limit to reset, raise your fit bar, or choose Sonnet.
- **A file says "no readable text."** It's probably a scanned or password-protected PDF. Save it as a Word or text file instead.
- **No S button on a page.** Reload the tab and check that The Seer is on in its toolbar popup. Chrome blocks extensions on `chrome://` pages and the Chrome Web Store.

More fixes are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#troubleshooting-full-list).

## Update

Run the install command again, then open `chrome://extensions` and click the reload arrow on The Seer. Your files, resumes and settings stay.

## Uninstall

```bash
curl -fsSL https://github.com/YashD5291/the-seer/releases/latest/download/install.sh | bash -s -- --uninstall
```

Your `TheSeer` folder (files and resumes) is kept. Then remove The Seer's card in `chrome://extensions`.

---

The Seer is an independent project. It is not made or endorsed by Anthropic.

License: [MIT](LICENSE)

For developers: see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
