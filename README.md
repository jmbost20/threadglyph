# Threadglyph

An Obsidian plugin for editable comment threads anchored to text in your notes.

- Select text → **Threadglyph: Comment on selection** (command palette or right-click) → write a comment.
- Threads open in a right-side panel. The passage is highlighted, with a number that matches its card, and a glyph appears in the margin.
- Reply, **edit** any message (Edit → Save/Cancel; the prior text is kept), and resolve or reopen threads. Search the panel with ⌘F.
- **Images:** every PNG, JPEG or WebP image gets a title pill with a **Comment** button. Image threads show a preview.
- **Optional AI** (off by default): **Ask AI** or an @mention sends a previewed request to **Local** (Ollama on this computer, preferred), **Gemini** (Gemini CLI) or **Claude** (Claude Code). The answer comes back as an editable draft.
- **Agent Comments import:** turns `{==…==}{>>…<<}` comments in a note into threads, read-only.
- **Your notes are never modified.** Threads live in separate JSON files.

Status: 0.2.0 pilot candidate (stages 1–7), desktop only. See [docs/implementation-progress.md](docs/implementation-progress.md), [docs/compatibility.md](docs/compatibility.md) and [docs/pilot.md](docs/pilot.md).

## Where data lives

| Folder (inside the vault) | Contents | Commit to a vault's Git? |
|---|---|---|
| `threadglyph/threads/<id>.json` | Thread ids, authors, timestamps, messages, edit history, resolved state. **No note text.** | Yes |
| `.threadglyph/anchors/<id>.json` | The quoted passage and its surrounding context, used to find the passage again. | **No.** Add `.threadglyph/` to `.gitignore` |
| `.threadglyph/exports/*.json` | Backups from *Back up all threads* (threads and anchors). | **No** (same folder) |

If the anchor file is missing (for example, on a fresh clone), the thread still shows with all its messages and offers **Reattach to selection**.

Anchors survive edits around the passage. If the quoted text is deleted, or repeated so that its original copy can't be identified, the thread says so instead of guessing.

## Develop

```sh
npm install
npm run check      # typecheck, lint, tests with coverage, production build
npm run dev        # rebuild on change
npm run sandbox    # create a disposable vault at ~/Developer/threadglyph-sandbox-vault and link the build
npm run package    # pilot package in dist/ (installing it is a manual owner step, see docs/pilot.md)
```

Open the sandbox folder in Obsidian as a vault and enable community plugins. The sandbox contains synthetic notes only; never point development tooling at a real vault.

## Coexistence

Threadglyph uses its own plugin id (`threadglyph`), view type, `tg-` CSS namespace and storage folders. It registers no default hotkey, so it can run beside other comment plugins without touching their data.
