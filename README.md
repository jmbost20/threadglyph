# Threadglyph

An Obsidian plugin for editable comment threads anchored to text in your notes.

- Select text → **Threadglyph: Comment on selection** (command palette or right-click) → write a comment.
- Threads open in a right-side panel. The passage is highlighted, with a number that matches its card, and a glyph appears in the margin.
- Reply, **edit** any message (Edit → Save/Cancel; the prior text is kept), and resolve or reopen threads. Search the panel with ⌘F.
- **Images:** every PNG, JPEG or WebP image gets a title pill with a **Comment** button. Image threads show a preview.
- **Optional AI** (off by default): **Ask AI** or an @mention sends a previewed request to **Local** (Ollama on this computer, preferred), **Gemini** (Gemini CLI) or **Claude** (Claude Code). The answer is automatically appended to the thread with AI attribution and remains editable. A failed save keeps a recoverable draft.
- **@agent (legacy, on hold; use @Gemini or @Local for comment help) — proposes edits, previewed:** ask the agent to change the note, for example to sort a checkbox's children or add a list. You can ask in a comment (`@Agent sort these`), in the **agent chat** sidebar, or inline: type `@a` in a note and choose **@agent** (or run **Ask @agent here**), and a window asks what it should do and what it may change. The change appears as a diff (or side by side) in the window, panel or chat, and under the dimmed text in the note. A line typed as `@agent sort these` still runs as written with **Ask @agent here**. **Nothing changes until you press Accept**, which applies it as one edit (⌘Z undoes it). Accept is refused if the text changed since the preview. If the agent wants other notes, it asks first (Allow / Deny). Searches skip daily notes; a cloud assistant asks before anything is sent.
- **Agent Comments import:** turns `{==…==}{>>…<<}` comments in a note into threads, read-only.
- **Your notes change only when you press Accept** on an agent proposal. Threads live in separate JSON files.

Status: 0.2.0 pilot candidate (stages 1–7), desktop only. See [docs/implementation-progress.md](docs/implementation-progress.md), [docs/compatibility.md](docs/compatibility.md) and [docs/pilot.md](docs/pilot.md).

## Quick AI and filtering

Every comment box works the same way: **⌘↩ posts**, and **Enter makes a new line**, even with an @mention. Posting `@Local …` (or `@Agent …`) opens the Ask AI preview. There, **Enter or ⌘↩ sends** with the defaults. The preview is a small tree: **What to send**, **Model** and **Exact text** start collapsed. **↑/↓** move between rows, **→** opens one, and moving onto an option chooses it. **Esc** or **Cancel** before the answer arrives cancels the whole request and removes the comment that asked. That comment can be restored from *Deleted comments*. The panel handles ⌘↩ and ⌘⇧⌫ itself, so Obsidian's editor shortcuts (⌘↩ toggles a checkbox) can't take them while the panel has focus.

In the panel, after posting a new thread the keyboard lands in its **reply box**. **Tab** moves comment by comment (then the reply box, then the thread's links). The Edit, Delete and Reply buttons stay out of the Tab order, with keys instead:
- on a focused comment, **E** edits it;
- **⌘D** deletes the focused comment, or the latest one when you're in the reply box;
- **⌘⇧D** deletes the whole thread, from anywhere in its card. **Delete thread** at the bottom of each card does the same, and *Deleted comments* restores the thread in one step;
- **⌘⇧→ / ⌘⇧←** (or **↑/↓** on a card) move between threads.

The Open, Resolved and All tabs show counts (99+ beyond 99). Threads whose passage was deleted or rewritten are listed **first**, with **Reattach to selection**.

The default includes **the selected passage, the thread, and the containing section**. Open **Exact text** to see everything that will be sent; scope choices show character counts for instructions and request text (not image bytes or provider formatting). An unavailable anchor never causes an unrelated section to be guessed.

Below **Open / Resolved / All**, expand **Custom filters** for agent, comment age, and an inclusive local date range. All selected predicates must match the same comment. These filters are local to the panel and do not change stored threads.

## Knowledge and cards (preview, off by default)

Turn on **Settings → Knowledge workflows** to make two more mentions work in any comment:

- **`@knowledge`** turns the commented passage, its section and the thread (including an assistant's answer) into a **Knowledge Object**: a note in `Knowledge/Objects/` with an Essence, Key ideas, the Evidence it came from, and a Learning history. If the object already exists, the new evidence is appended to it; the Essence and your edits are never overwritten.
- **`@card`** does the same, then writes flashcards **from that object**, not from the raw passage. Cards come from what you read and discussed, starting with a definition card. They land in `Knowledge/Cards/` (the *card inbox*), and in Anki only when **Send cards to Anki** is on.

Work runs in the background, one request at a time, with the **Knowledge assistant** (Local by default, so nothing leaves the computer). A comment that also asks `@Local …` waits for that answer and includes it. Each thread shows a status row (queued, running, done, failed, needs review) with **Open**, **Retry**, **Cancel** and **Update request** (after you edit the comment).

When the assistant thinks the request may be an object you already have, the job stops at **Needs review**. **Review** opens a form: add it to the existing object, or create a new one with an editable title and essence (Enter or ⌘↩ applies). **Knowledge: show queue** lists every request; **Knowledge: review the next request** opens the next review.

`Knowledge/Knowledge.base` is an Obsidian Bases view of the objects (kind, learning state, sources) and the card inbox. Knowledge workflows write **only inside the knowledge folder**; source notes are never changed. Jobs, which hold the quoted passage, are kept in `.threadglyph/knowledge/jobs/`.

## Where data lives

| Folder (inside the vault) | Contents | Commit to a vault's Git? |
|---|---|---|
| `threadglyph/threads/<id>.json` | Thread ids, authors, timestamps, messages, edit history, resolved state. **No note text.** | Yes |
| `.threadglyph/anchors/<id>.json` | The quoted passage and its surrounding context, used to find the passage again. | **No.** Add `.threadglyph/` to `.gitignore` |
| `.threadglyph/exports/*.json` | Backups from *Back up all threads* (threads and anchors). | **No** (same folder) |
| `.threadglyph/knowledge/jobs/*.json` | Knowledge and card requests, with the passage they captured. | **No** (same folder) |
| `Knowledge/Objects`, `Knowledge/Cards` | Knowledge Objects and cards (only when knowledge workflows are on). | Your choice: they are notes |

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

Threadglyph uses its own plugin id (`threadglyph`), view type, `tg-` CSS namespace and storage folders. It registers no default hotkey (the sandbox binds ⌘⇧↩ to *Ask @agent here* and ⌘⇧A to *Open agent chat*), so it can run beside other comment plugins without touching their data.
