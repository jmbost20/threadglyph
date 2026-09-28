# Threadglyph

An Obsidian plugin for editable comment threads anchored to text in your notes.

- Select text → **Threadglyph: Comment on selection** (command palette or right-click) → write a comment.
- Threads open in a right-side panel. A small glyph appears in the margin and the passage is highlighted.
- Reply, **edit** any message (Edit → Save/Cancel; the prior text is kept), and resolve or reopen threads.
- **Your notes are never modified.** Threads live in separate JSON files.

Status: early development (stage 2 of 7), desktop only. Image comments and optional AI assistance come later. See [docs/implementation-progress.md](docs/implementation-progress.md).

## Where data lives

| Folder (inside the vault) | Contents | Commit to a vault's Git? |
|---|---|---|
| `threadglyph/threads/<id>.json` | Thread ids, authors, timestamps, messages, edit history, resolved state. **No note text.** | Yes |
| `.threadglyph/anchors/<id>.json` | The quoted passage and its surrounding context, used to find the passage again. | **No.** Add `.threadglyph/` to `.gitignore` |

If the anchor file is missing (for example, on a fresh clone), the thread still shows with all its messages and offers **Reattach to selection**.

Anchors survive edits around the passage. If the quoted text is deleted, or repeated so that its original copy can't be identified, the thread says so instead of guessing.

## Develop

```sh
npm install
npm run check      # typecheck, lint, tests with coverage, production build
npm run dev        # rebuild on change
npm run sandbox    # create a disposable vault at ~/Developer/threadglyph-sandbox-vault and link the build
```

Open the sandbox folder in Obsidian as a vault and enable community plugins. The sandbox contains synthetic notes only; never point development tooling at a real vault.

## Coexistence

Threadglyph uses its own plugin id (`threadglyph`), view type, `tg-` CSS namespace and storage folders. It registers no default hotkey, so it can run beside other comment plugins without touching their data.
