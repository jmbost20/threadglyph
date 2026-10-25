# Threadglyph

[![CI](https://github.com/jmbost20/threadglyph/actions/workflows/ci.yml/badge.svg)](https://github.com/jmbost20/threadglyph/actions/workflows/ci.yml)
[![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=jmbost20_threadglyph&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=jmbost20_threadglyph)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=jmbost20_threadglyph&metric=coverage)](https://sonarcloud.io/summary/new_code?id=jmbost20_threadglyph)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/jmbost20/threadglyph/badge)](https://scorecard.dev/viewer/?uri=github.com/jmbost20/threadglyph)
[![Release](https://img.shields.io/github/v/release/jmbost20/threadglyph)](https://github.com/jmbost20/threadglyph/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Comment threads for Obsidian, anchored to the text and images in your notes, with optional AI replies that can run entirely on your own computer.

https://github.com/user-attachments/assets/c47be86b-fada-4872-82b5-1cfd47f5eab1

*The demo (50 s): highlight a passage, ask a local model with `@Local`, and the answer lands in the thread. If the player doesn't show, [watch it here](https://www.jonahbostrom.com/demos/threadglyph-demo.mp4).*

> **Status: alpha (0.3.0), desktop only.** It is used daily by its author, on macOS, but expect rough edges. Bug reports are welcome.
>
> **Windows and Linux:** the core plugin and the Ollama assistant are covered by automated tests on all three systems. The Gemini and Claude assistants have only been used on macOS; on Windows, command-line tools installed through npm (`.cmd` launchers) are not supported yet ([#23](https://github.com/jmbost20/threadglyph/issues/23)).

## What it does

- **Comment on any passage.** Select text and run **Threadglyph: Comment on selection** (command palette or right-click). The passage is highlighted, numbered to match its card, and marked in the margin.
- **Threads in a side panel.** Reply, edit any message (the earlier text is kept), resolve or reopen, delete with undo, and search with ⌘F. Open, Resolved and All tabs, plus filters by author, age and date.
- **Comment on images.** Every PNG, JPEG or WebP embed gets a title pill with a **Comment** button.
- **Your notes are never changed.** Threads are stored in separate JSON files beside your notes; Threadglyph does not write to note files.
- **Anchors that survive edits.** Edits around a passage don't break its thread. If the passage is deleted, or repeated so the original copy can't be told apart, the thread says so instead of guessing, and offers **Reattach to selection**.
- **Optional AI replies (off by default).** Mention `@Local`, `@Gemini` or `@Claude` in a comment, or press **Ask AI**. Before anything is sent you see a preview of exactly what goes, and where ("Stays on this computer", "Sent to Google", "Sent to Anthropic", or the host of an Ollama server on another machine). The answer is added to the thread, labelled as AI, and stays editable.
- **Import inline comments.** Turns `{==…==}{>>…<<}` comments written inside a note into threads, without changing the note.

## How it was built

Threadglyph was written by AI coding agents (OpenAI Codex and Anthropic Claude Code), one pull request at a time, with the maintainer setting direction, reviewing and merging. Every feature pull request was reviewed by [Gitar](https://gitar.ai) and analysed by [SonarQube Cloud](https://sonarcloud.io) before it merged. The agents' rule: reproduce a finding with a test that fails before fixing it, and answer in writing any finding they disagree with. The record includes the misses too: an early dependency update (#2) merged with failing CI and broke main until #9, and a later whole-project review found problems the per-PR reviews had not (now fixed).

- **35 distinct Gitar findings on merged code, all resolved:** 15 bugs, 1 security issue, 11 edge cases, 7 test or code-quality problems, 1 performance issue. (Two comments repeated on stacked PRs are counted once.)
- **Examples:** two quick clicks [could silently lose a reply](https://github.com/jmbost20/threadglyph/pull/1#discussion_r4122849310); an AI rewrite containing a code block [could leak quoted note text into a thread file](https://github.com/jmbost20/threadglyph/pull/14#discussion_r4366902160); and several tests [could not actually fail](https://github.com/jmbost20/threadglyph/pull/1#discussion_r4128873979).
- **Sonar's coverage gate was met with tests, never by excluding code:** line coverage went from 72.8% to 99.8% on the first PR, and is about 99.8% today.

The full story, with links to the reviews, is in [How Gitar and SonarQube reviewed Threadglyph](docs/gitar-and-sonar.md).

## Install

Threadglyph is not yet in Obsidian's community plugin directory.

**With BRAT (recommended):** install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin, choose **Add beta plugin**, and enter `jmbost20/threadglyph`.

**Manually:** download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/jmbost20/threadglyph/releases/latest) into `<your vault>/.obsidian/plugins/threadglyph/`. Then reload Obsidian and enable **Threadglyph** under Settings → Community plugins.

If your vault is in Git, add `.threadglyph/` to its `.gitignore` first (see [Where data lives](#where-data-lives)).

## Quick start

1. Select a sentence and run **Threadglyph: Comment on selection**. Bind it to a hotkey under Settings → Hotkeys; the plugin ships with none, so it never clashes with your setup.
2. Write a comment and press **⌘↩** to post. **Enter** makes a new line.
3. Run **Threadglyph: Open thread panel** to see every thread in the note.

### Keyboard

| Where | Key | Does |
|---|---|---|
| Any comment box | ⌘↩ | Post |
| Panel | Tab | Move comment by comment, then to the reply box |
| Focused comment | E | Edit it |
| Panel | ⌘D | Delete the focused comment (or the latest one, from the reply box) |
| Panel | ⌘⇧D | Delete the whole thread (restorable from *Deleted comments*) |
| Panel | ⌘⇧→ / ⌘⇧← | Next / previous thread |
| Ask AI preview | Enter or ⌘↩ | Send. Esc cancels the request and removes the comment that asked (restorable) |

## AI assistants (optional)

Turn on **Settings → Threadglyph → Enable Ask AI**. Each assistant is a program you install yourself; Threadglyph never reads or stores API keys.

| Assistant | You need | Where your text goes |
|---|---|---|
| **Local** (preferred) | [Ollama](https://ollama.com) running, with a model pulled (default `qwen3:8b`; a vision model such as `qwen2.5vl:7b` for images) | Nowhere, with the default `localhost:11434`. An Ollama server on another machine, and Ollama `:cloud` models, are labelled as leaving the computer. |
| **Gemini** | [Gemini CLI](https://github.com/google-gemini/gemini-cli) and an API key in `~/.threadglyph/gemini/.gemini/.env` as `GEMINI_API_KEY=…` | Google |
| **Claude** | [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and signed in | Anthropic |

By default a request holds the selected passage, the thread and the section around it. Open **Exact text** in the preview to see every character that will be sent, or narrow the scope. For daily notes and other personal text, prefer **Local**.

## Disclosures

As Obsidian's [developer policies](https://docs.obsidian.md/Developer+policies) require:

- **Network use:** none unless you turn on Ask AI. Then requests go only to the assistant you pick: Ollama at the address you set (`localhost` by default; any other address is shown as leaving the computer), or Google or Anthropic through their own command-line tools.
- **Runs external programs:** the Gemini and Claude assistants start the `gemini` and `claude` command-line tools you installed, without a shell, with the request on standard input. This is why the plugin is desktop only.
  - Your own setup for these tools is not used, so a request carries only what the preview shows and goes only where it says. Claude Code runs without its built-in tools, MCP servers, settings files (and so your hooks and plugins), `CLAUDE.md` files, auto memory or telemetry. Gemini CLI runs read-only, in a home folder made for the request, so your `~/.gemini` settings, hooks, `GEMINI.md`, extensions and MCP servers are not used; its tools, skills, context files and telemetry are off.
  - Custom endpoints are ignored: a Bedrock, Vertex or `ANTHROPIC_BASE_URL` setup for Claude Code, or a `GOOGLE_GEMINI_BASE_URL` gateway for Gemini, is not used, so requests go to Anthropic or Google as labelled. A proxy set in your environment still applies, and so do settings an administrator enforces for the whole machine.
  - `node scripts/check-cli-isolation.mjs` proves all of this against your installed versions (checked with Gemini CLI 0.60.0 and Claude Code 2.1.310).
- **Files outside your vault:** your Gemini key stays in `~/.threadglyph/gemini/.gemini/.env` (or a folder you choose); Threadglyph only creates that `.gemini` folder in its own folder and never writes to a folder you choose. Each Gemini request runs in a new private folder in your system's temp folder, holding Threadglyph's settings and a link to the key file (a copy on Windows), deleted with Gemini's logs of the request when it ends. An image you ask about is copied to the temp folder for the request and deleted afterwards.
- **No telemetry, no ads, no account.** Threadglyph itself sends nothing anywhere.

## Where data lives

| Folder (inside the vault) | Contents | Commit to a vault's Git? |
|---|---|---|
| `threadglyph/threads/<id>.json` | Thread ids, authors, timestamps, messages, edit history, resolved state. The quoted passage is kept out of these files, but comments and AI replies are free text and can quote or summarise your note. | If you're comfortable publishing your comments |
| `.threadglyph/anchors/<id>.json` | The quoted passage and its surrounding context, used to find the passage again. | **No.** Add `.threadglyph/` to `.gitignore` |
| `.threadglyph/exports/*.json` | Backups from *Back up all threads* (threads and anchors). | **No** (same folder) |

If an anchor file is missing (for example, on a fresh clone), the thread still shows with all its messages and offers **Reattach to selection**. **Back up all threads** and **Restore threads from a backup** are in the command palette; a restore only adds threads that are missing and never overwrites.

Anchors sit in a dot-folder. Git (with the suggested `.gitignore`) and some sync tools skip it, so another device may show threads that need a reattach; check how your sync tool treats hidden folders. The plugin does not run on mobile. See [docs/compatibility.md](docs/compatibility.md) for measured performance on large notes and other limits.

## Development

```sh
npm ci
npm run check      # typecheck, lint, tests with coverage, production build
npm run dev        # rebuild on change
npm run sandbox    # make a disposable test vault at ~/Developer/threadglyph-sandbox-vault and link the build
```

Open the sandbox folder in Obsidian as a vault and enable community plugins; sample notes are in `Test data/Threadglyph samples/`. The sandbox scripts refuse any existing vault, and any vault Obsidian knows about, unless it is a sandbox they made.

Optional: `THREADGLYPH_SOURCE_VAULT=<your vault> npm run sandbox:pull` copies your plugins, hotkeys, templates and today's daily note into the sandbox. It only reads your vault, and turns off Sync and Publish in the copies. `THREADGLYPH_GEMINI_FOLDER=<folder>` lets a new sandbox borrow an existing Gemini folder.

No local setup? The repository has a dev container, so **Code → Codespaces** gives you a ready environment for the checks (trying the plugin in Obsidian still needs a desktop vault).

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, [docs/architecture.md](docs/architecture.md) for how the parts fit together, and the [decision records](docs/adr/README.md) for why. What's planned is in the [roadmap](docs/roadmap.md). The agents' working logs are in [docs/dev/](docs/dev/README.md).

## Community

Questions and ideas go to [Discussions](https://github.com/jmbost20/threadglyph/discussions); see [SUPPORT.md](SUPPORT.md) for where everything else goes. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). How decisions are made is in [GOVERNANCE.md](GOVERNANCE.md).

### Contributors

Every kind of contribution counts: code, docs, testing, bug reports, ideas and reviews ([emoji key](https://allcontributors.org/emoji-key/)).

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tbody>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://jonahbostrom.com"><img src="https://avatars.githubusercontent.com/u/84430322?v=4?s=80" width="80px;" alt="Jonah Bostrom"/><br /><sub><b>Jonah Bostrom</b></sub></a><br /><a href="https://github.com/jmbost20/threadglyph/commits?author=jmbost20" title="Code">💻</a> <a href="https://github.com/jmbost20/threadglyph/commits?author=jmbost20" title="Documentation">📖</a> <a href="#design-jmbost20" title="Design">🎨</a> <a href="#maintenance-jmbost20" title="Maintenance">🚧</a> <a href="https://github.com/jmbost20/threadglyph/commits?author=jmbost20" title="Tests">⚠️</a> <a href="#ideas-jmbost20" title="Ideas, Planning, & Feedback">🤔</a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->

## Coexistence

Threadglyph uses its own plugin id, view type, `tg-` CSS namespace and storage folders, and registers no default hotkeys, so it runs beside other comment plugins without touching their data.

## License

[MIT](LICENSE) © 2026 Jonah Bostrom
