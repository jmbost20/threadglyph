# Pilot package (stage 7)

How to try Threadglyph 0.2.0 in a real vault, how to back out, and what to check. **Installing is the owner's step.** No script here touches a vault other than the disposable sandbox.

## Build the package

```sh
npm ci && npm run check   # must pass
npm run package           # → dist/threadglyph-0.2.0/
```

The folder contains `main.js`, `manifest.json` and `styles.css`, plus `SHA256SUMS` and `BUILD.txt`, which records the commit it was built from and says so if there were uncommitted changes. `dist/` is git-ignored.

## Install (manual, owner only)

1. **Git-tracked vault:** first add `.threadglyph/` to the vault's `.gitignore`. That folder holds anchors and backups, which quote note text, including daily notes. `threadglyph/threads/` holds no note text and may be committed.
2. Copy `dist/threadglyph-0.2.0/` to `<vault>/.obsidian/plugins/threadglyph/`.
3. In Obsidian, go to Settings → Community plugins, reload, and enable **Threadglyph**.
4. Optional: Settings → Hotkeys. The plugin ships with no hotkeys, so it never collides with Agent Comments. The sandbox uses ⌘/ (comment), ⌥⌘/ (reply at cursor), ⌥⌘] / ⌥⌘[ (next / previous thread).
5. Optional AI: Settings → Threadglyph → **Enable Ask AI**.
   - **Local (Ollama):** preferred by default. Needs the Ollama app running and the model pulled (`qwen3:8b`). Image questions need a vision model such as `qwen2.5vl:7b`.
   - **Gemini (Gemini CLI):** needs `gemini` installed and an API key in `~/.threadglyph/gemini/.gemini/.env` as `GEMINI_API_KEY=…`. Alternatively, point **Gemini folder** at an existing Gemini folder; the sandbox borrows the folder named by `THREADGLYPH_GEMINI_FOLDER` that way. Threadglyph's own folder gets settings that switch off every Gemini tool. A borrowed folder keeps its own settings.
   - **Claude (Claude Code):** uses the existing Claude Code sign-in.
   - For daily notes and other personal text, prefer **Local**. The preview always says where a request goes ("Stays on this computer" / "Sent to Google" / "Sent to Anthropic") before anything is sent.

## Back up, export and roll back

- **Back up:** command **Threadglyph: Back up all threads**. It writes one JSON file with every thread and anchor to `.threadglyph/exports/` (local-only, because it contains quotes).
- **Restore:** command **Threadglyph: Restore threads from a backup**, then pick a file. Every record is validated, only missing threads are added, and nothing is overwritten or deleted. Invalid records are counted and skipped.
- **Roll back:**
  1. Back up.
  2. Disable Threadglyph.
  3. Delete `<vault>/.obsidian/plugins/threadglyph/`.

  Threadglyph never writes to notes, so there is nothing to undo in them. The `threadglyph/` and `.threadglyph/` folders can stay, which makes a reinstall pick up where it left off, or be deleted.
- **Agent Comments import:** read-only. The note keeps its `{==…==}{>>…<<}` markup, so removing Threadglyph leaves Agent Comments exactly as it was.

## Owner test script

Run it in the sandbox first (`npm run build && npm run sandbox`, then ⌘R in the sandbox window). The sample notes named below are in `Test data/Threadglyph samples/`. `npm run sandbox:pull` adds your real plugins, hotkeys and today's daily note (in `Test data/Daily notes/`), so you can test alongside your usual setup.

1. **Highlights and numbers** (`Welcome.md`): select text, press ⌘/, comment, then ⌘↩. You should see a highlight and a raised number, and the card shows the same number. A comment higher in the note renumbers in reading order. Resolving keeps the numbers.
2. **Navigation:** ⌥⌘] and ⌥⌘[ step through threads in the note. In the panel (outside a text box), ⌘⇧→ and ⌘⇧← step through comments and highlight each passage; the keyboard stays in the panel. ⌥⌘/ inside a highlight jumps to its reply box. Clicking highlighted text shows the card without moving your cursor; clicking a badge focuses the reply box.
3. **Panel search and keys:** click in the panel and press **⌘F**. The search box focuses; Esc clears it. Open / Resolved / All filter the list. ↑/↓ move between cards and ↩ jumps to the passage, from a focused card or a clicked comment. Under **Custom filters**, change *Comment age* with the arrow keys: focus stays on the dropdown after each change.
4. **Images** (`Image titles.md`, `Images.md`): each image has a title pill (alias, alt text or file name) with **Comment**. Clicking it starts an image thread with a preview. HEIC and missing files get a clear message instead. The title pill also appears in Reading view.
5. **Ask AI, Local first:** Ask AI on a card. The preview preselects **Local · qwen3:8b · Stays on this computer**; Enter sends. The answer is added to the thread, labelled as AI, and stays editable. Esc in the preview cancels the whole request and removes the comment that asked (restorable from *Deleted comments*). Local on an image thread explains that the model cannot see images; switch to **Gemini** and it describes the image. In settings, set *Ollama address* to `http://192.168.1.20:11434`: the preview now says **Sent to 192.168.1.20** (no server needed to see the label). Set it back.
6. **@mentions:** type `@` in a reply. You should see Local, Gemini and Claude with their models. Enter makes a new line; ⌘↩ posts, and `@Gemini` then opens the preview with Gemini chosen. When a request fails, the error offers the other assistants directly. If saving an AI reply fails, the reply stays as an editable draft, and Esc does not discard it.
7. **Import** (`Agent Comments sample.md`): run *Import Agent Comments from this note*. The preview lists 3 threads (2 messages; 1 message · resolved; 1 message). Import them, then check that the note text is byte-for-byte unchanged. Running the import again says *Nothing new to import*. Then ask Local or Gemini on an imported thread.
8. **Backup and restore:** back up, delete one file in `threadglyph/threads/`, reload, and restore. The thread comes back and the others are reported as already existing.
9. **Safety:** after all of the above, no note has changed. Check with the sandbox's file history or a diff.
10. **Release candidate install:** `npm run package`, then copy `dist/threadglyph-<version>/` into a *fresh* empty vault's `.obsidian/plugins/threadglyph/`. Enable it, make a thread, quit and reopen Obsidian (the thread and highlight come back), then disable and delete the plugin folder: the note is unchanged and Obsidian shows no errors.

## Acceptance record

One row per release candidate, filled in by the maintainer after running the script above in Obsidian. A release is tagged only after its row says *pass*.

| Date | Version / commit | Obsidian / OS | Steps run | Result | Notes |
|---|---|---|---|---|---|
| | 0.3.0 / | | 1–10 | | |

## Evidence for the walkthrough

- **History:** PR #1 (bootstrap + stages 1–2), PR #3 (stage 3), PR #4 (stage 4) and PR #5 (stage 5) were merged by the owner. This round (stage 5 follow-up, stages 6–7) is one end-to-end PR, as the owner asked on 2026-09-29.
- **Quality gate:** `npm run check` (typecheck, lint, tests with coverage, build). CI runs it on every push, alongside the SonarQube Cloud analysis and Gitar review.
- **Tool findings that changed code:** see `docs/dev/sonar-experiments.md`. That includes 7 Sonar maintainability issues and a coverage gate failure fixed by tests, not exclusions, plus 10 Gitar findings, all reproduced with failing tests first.
- **Live AI checks, 2026-09-29, synthetic content only:**
  - Local `qwen3:8b` answered a follow-up on the imported sample thread (23.6 s) and refused the image with the fix spelled out.
  - Gemini `gemini-3.1-flash-lite` answered the same follow-up (21.7 s) and described the synthetic PNG ("Clear, solid blue sky.") from its real bytes (7.3 s).
  - `gemini-3.5-flash` was returning HTTP 503 (overloaded) that day, which is why overload has its own error message.
- **Limits:** see `docs/compatibility.md` (mobile unsupported, multi-device edits not merged) and the progress doc's known limitations.
