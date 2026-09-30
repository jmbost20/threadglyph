# Threadglyph

An Obsidian plugin for editable comment threads anchored to text in your notes.

- Select text → **Threadglyph: Comment on selection** (command palette or right-click) → write a comment.
- Threads open in a right-side panel. The passage is highlighted, with a number that matches its card, and a glyph appears in the margin.
- Reply, **edit** any message (Edit → Save/Cancel; the prior text is kept), and resolve or reopen threads. Search the panel with ⌘F.
- **Images:** every PNG, JPEG or WebP image gets a title pill with a **Comment** button. Image threads show a preview.
- **Optional AI** (off by default): **Ask AI** or an @mention sends a previewed request to **Local** (Ollama on this computer, preferred), **Gemini** (Gemini CLI) or **Claude** (Claude Code). The answer is automatically appended to the thread with AI attribution and remains editable. A failed save keeps a recoverable draft.
- **@agent (proposes edits, previewed):** ask the agent to change the note, for example to sort a checkbox's children or add a list. You can ask in a comment (`@Agent sort these`), in the **agent chat** sidebar, or inline by typing `@agent sort these` on a line and running **Run @agent on this line**. The change appears as a diff in the panel or chat, and dimmed in the note with the new lines under it. **Nothing changes until you press Accept**, which applies it as one edit (⌘Z undoes it). Accept is refused if the text changed since the preview. If the agent wants other notes, it asks first (Allow / Deny). Searches skip daily notes; a cloud assistant asks before anything is sent.
- **Agent Comments import:** turns `{==…==}{>>…<<}` comments in a note into threads, read-only.
- **Your notes change only when you press Accept** on an agent proposal. Threads live in separate JSON files.

Status: 0.2.0 pilot candidate (stages 1–7), desktop only. See [docs/implementation-progress.md](docs/implementation-progress.md), [docs/compatibility.md](docs/compatibility.md) and [docs/pilot.md](docs/pilot.md).

## Quick AI and filtering

Write a question with a complete `@Local` mention, then press **Enter** to post it and open the preview. Press **Enter** again to send. **Shift+Enter** inserts a newline; Cmd/Ctrl+Enter also submits. **Escape** leaves Ask AI and returns to the passage without deleting the posted question. A disk save already in progress cannot be cancelled.

The default includes **the selected passage, the thread, and the containing section**. The exact-text preview starts expanded; scope choices show character counts for instructions and request text (not image bytes or provider formatting). An unavailable anchor never causes an unrelated section to be guessed.

Below **Open / Resolved / All**, expand **Custom filters** for agent, comment age, and an inclusive local date range. All selected predicates must match the same comment. These filters are local to the panel and do not change stored threads.

## Where data lives

| Folder (inside the vault) | Contents | Commit to a vault's Git? |
|---|---|---|
| `threadglyph/threads/<id>.json` | Thread ids, authors, timestamps, messages, edit history, resolved state. **No note text.** | Yes |
| `.threadglyph/anchors/<id>.json` | The quoted passage and its surrounding context, used to find the passage again. | **No.** Add `.threadglyph/` to `.gitignore` |
| `.threadglyph/exports/*.json` | Backups from *Back up all threads* (threads and anchors). | **No** (same folder) |

Agent proposals and the agent chat contain note text, so they are kept in memory only and disappear when Obsidian closes. The thread keeps only the agent's short explanation.

If the anchor file is missing (for example, on a fresh clone), the thread still shows with all its messages and offers **Reattach to selection**.

Anchors survive edits around the passage. If the quoted text is deleted, or repeated so that its original copy can't be identified, the thread says so instead of guessing.

## Develop

```sh
npm install
npm run check      # typecheck, lint, tests with coverage, production build
npm run dev        # rebuild on change
npm run sandbox    # create a disposable vault at ~/Developer/threadglyph-sandbox-vault and link the build
npm run sandbox:pull  # copy the owner's plugins, settings, hotkeys, templates and today's daily note into it (real vault read only)
npm run package    # pilot package in dist/ (installing it is a manual owner step, see docs/pilot.md)
```

Open the sandbox folder in Obsidian as a vault and enable community plugins. Test notes live under `Test data/`: `Threadglyph samples/` (synthetic), `My test notes/`, and `Daily notes/`, which holds a copy of the owner's daily note from `sandbox:pull`. The sandbox sits outside this repository, so none of it is ever committed. Test fixtures in the repo stay synthetic. `sandbox:pull` only reads the real vault. In the sandbox copies it turns off Sync and Publish, and Inline Comments' auto-dispatch and Gemini cloud consent, so daily-note text never leaves the computer on its own. Never point development tooling at the real vault for writing.

## Coexistence

Threadglyph uses its own plugin id (`threadglyph`), view type, `tg-` CSS namespace and storage folders. It registers no default hotkey (the sandbox binds ⌘⇧↩ to *Run @agent on this line* and ⌘⇧A to *Open agent chat*), so it can run beside other comment plugins without touching their data.
