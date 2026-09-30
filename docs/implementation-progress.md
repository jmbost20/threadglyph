# Implementation progress

## Current state

- **Stage:** 6–7 plus follow-ups to stages 3–5, on one end-to-end branch (`codex/local-gemini-pilot`) with one PR, at the owner's request (2026-09-29). See "Round 2026-09-29" below.
- **Merged:** stages 1–2 via [PR #1](https://github.com/jmbost20/threadglyph/pull/1) (`a4182ff`); stages 3–5 via PRs [#3](https://github.com/jmbost20/threadglyph/pull/3), [#4](https://github.com/jmbost20/threadglyph/pull/4) and [#5](https://github.com/jmbost20/threadglyph/pull/5) (`2823ab3`).
- **Repo:** https://github.com/jmbost20/threadglyph (private)
- **Where to test:** the sandbox vault only (`~/Developer/threadglyph-sandbox-vault`). Installing into the live vault is the owner's step; see `docs/pilot.md`.
- **PR modes (owner, 2026-09-29):** *end-to-end* (one branch, one ready-for-review PR for a large batch; the current mode) or *incremental* (several smaller ready-for-review PRs). Drafts only for a strong reason.

## Decisions (stage 0)

| Decision | Choice | Why |
|---|---|---|
| Coexistence with the existing comment plugin | Separate id `threadglyph`, view `threadglyph-panel`, `tg-` CSS prefix, no default hotkey, JSON storage outside notes | Neither plugin reads or writes the other's data. The only interaction is that the other plugin edits notes inline, which Threadglyph handles as an ordinary external edit (re-anchor). |
| Where to test | Disposable sandbox vault (`npm run sandbox`) until stage 2 passes; then the owner decides on installing into the live vault | Early builds never write into real notes' vault. |
| Storage | Split: tracked `threadglyph/threads/<id>.json` (no note text) and local-only `.threadglyph/anchors/<id>.json` (quote + context) | The owner's vault is Git-tracked with a remote. Comments may be committed, but note content (especially daily notes) must not be pushed through thread records. |
| Anchor strategy | Quote + 64 characters of prefix/suffix + line hint. An exact single match wins; repeated quotes are ranked by surrounding context; ties become **ambiguous**; a deleted quote becomes **missing** | Never silently attaches to the wrong occurrence. The line hint is deliberately not used to break ties. |
| Write ordering | All writes to one thread go through a per-thread queue in `ThreadStore`; in-app changes use `update()`, which applies the change to the latest version | Fixes lost updates and duplicate threads from rapid actions (Gitar finding, PR #1). |
| Stale saves | Every write checks the on-disk `revision`; on a mismatch nothing is written, the cache adopts the disk version and the draft is kept. Edits also compare the message body from when editing began | No silent last-writer-wins. |
| Edit history | Prior bodies are kept in `revisions[]`; ids, author and `createdAt` never change; `editedAt` is shown as "edited" | Recoverable content. |
| AI text | `origin: ai` / `ai-edited`, so edited model text is never shown as raw model output | Set up for stage 5; no AI adapter yet. |
| Dropped from plan | A content hash in the tracked record | A hash of a short quote can leak it; not needed for drift detection. |
| UI framework | None: native Obsidian DOM helpers + CodeMirror 6 | Small panel, fewer dependencies. |
| UI tests | happy-dom + a small Obsidian API stand-in (`tests/obsidianStub.ts`) | Tests real panel behavior (drafts, focus, Save/Cancel, plain-text rendering) without the app. Gutter-click tests are limited to line 1 because happy-dom has no layout. |
| Rendering safety | All comment text rendered with `textContent`, never HTML/Markdown | Hostile text stays inert. |

## Panel sketch

```
┌ ◔ Note name ─────────────────┐
│ 2 open · 1 resolved          │
├──────────────────────────────┤
│ ▎"quoted passage…"  (→ note) │
│ Jonah · 9:05 · edited   ✎    │
│ Comment text                 │
│ [ Reply…            ]        │
│                    Resolve   │
├──────────────────────────────┤
│ Show resolved (1)            │
└──────────────────────────────┘
```

## Stage log

### Stage 1: repository and pipeline
- [x] Scaffold: TypeScript, esbuild, Vitest + v8 LCOV, ESLint, manifest
- [x] CI workflow (check job + separate Sonar job), PR template, Dependabot
- [x] Sandbox vault script
- [x] `npm install` + lockfile, local `npm run check`
- [x] Private GitHub repo, bootstrap PR, CI results on the head SHA
- [x] CI actions pinned by commit SHA to current releases (v4 actions were flagged as deprecated)
- [x] SonarQube Cloud project + `SONAR_TOKEN` (set up by the owner 2026-09-29)
- [x] Gitar app on this repo
- [x] Branch protection on `main`: **not available.** The GitHub API returns 403 ("Upgrade to GitHub Pro or make this repository public"). The repo stays private, merges stay manual by the owner, and branch discipline is local practice, **not server-enforced**.

### Stage 2: editable text threads
- [x] Thread model: create / reply / edit with retained revisions / resolve / move
- [x] Text anchors: capture, resolve, ambiguity, missing
- [x] Storage: split sidecars, schema validation, path-escape guard, stale-save check, rename following, per-file reload
- [x] Controller: drafts, edit sessions, stale-edit detection, reattach
- [x] Panel + margin glyph + highlights
- [ ] Manual check in the sandbox vault, including coexistence with the other comment plugin
- [ ] Owner UI review

### Stage 3: fresh review UI (`codex/review-ui`)
Owner feedback from the first sandbox session: no visible highlight, and a request for a number on each commented passage like the old plugin's.
- [x] Highlight fix. The CSS used `--color-accent-rgb`, which Obsidian does not define, so the colour was invalid and nothing drew. Tints are now `color-mix()` from `--color-accent`.
- [x] Numbered badges after each passage, in reading order, with matching numbers on the panel cards. Resolving a thread keeps every number.
- [x] The pending selection stays highlighted (dashed) while its first comment is written.
- [x] Clicking highlighted text shows its card without taking focus from the note. Clicking a badge or glyph also puts the caret in the reply box.
- [x] Panel: search (quote, messages, authors), an Open / Resolved / All filter, focusable cards (↑/↓ to move, Enter to jump to the passage), clearer empty states.
- [x] Commands: Go to next / previous thread (wraps around) and Reply to thread at cursor. No default hotkeys. The sandbox script binds ⌘/, ⌥⌘/, ⌥⌘] and ⌥⌘[ in the sandbox only.
- [x] Reading view highlights and badges. A quote that spans formatting (half bold, for example) is left unhighlighted rather than guessed.
- [ ] Owner UI review in the sandbox

### Stage 4: image annotations (`codex/image-threads`, stacked on stage 3)
- [x] **Anchor.** An image thread anchors to the embed markup (`![[pic.png|300]]`, `![alt](<a b.png>)`) with the usual quote and context. The image's vault path is kept **only in the local anchor file**; the tracked record just says `anchorKind: "image"`, because a file name can be personal too.
- [x] **Resolution.** If the markup changes (a rename rewrote the link, a size was added), the thread finds the same file through Obsidian's link resolution. Two embeds of that file → ambiguous; none → missing. Neither case guesses.
- [x] **Renames.** Image file and folder renames update the anchor's image path.
- [x] **Starting one.** "Comment on selection" (⌘/ in the sandbox) comments on the image when the cursor is on an image embed. In Live Preview, click just after the image. A text selection that merely contains an image stays a text comment. The context menu says "comment on image" in that case.
- [x] **Formats.** PNG, JPEG and WebP only. HEIC, HEIF, PDF, SVG, GIF, BMP, TIFF and AVIF get a clear "not supported yet" message before any typing. Remote URLs are refused ("does not fetch remote images"), and a missing file is named.
- [x] **Panel.** Image previews on cards and on the new-thread card. A missing file is named; a damaged file says it could not be displayed.
- [x] **Reading view.** Badges plus an outline on wiki image embeds (`.internal-embed[src]`). Markdown-style image embeds carry no link in the rendered DOM, so they are not badged there; the editor and the panel still show them.
- [x] **Vision groundwork.** `prepareImage` checks the extension, reads the real type from the file's first bytes (a PNG named `.jpg` is sent as PNG, garbage is refused), caps size at 5 MB (the strictest common provider limit) and base64-encodes the exact bytes. Tested with synthetic byte fixtures.
- [x] **Sandbox content.** `Images.md` plus two generated gradient PNGs, a fake `.heic` and a missing-file embed.
- [ ] Owner UI review in the sandbox

### Stage 5: optional AI (`codex/ask-ai`, stacked on stage 4)
- [x] **Adapter (one).** The local Claude Code CLI through the owner's existing sign-in, so there is no API key and no new billing. It declares text and images. Isolation: `--tools ""`, `--strict-mcp-config`, `--setting-sources ""`, `--no-session-persistence`, `--disable-slash-commands`, cwd in the OS temp folder, spawned without a shell, output capped.
- [x] **Off by default.** Human comments never need a model. Settings: enable, CLI path (blank = auto-detect in the usual install folders, since the Dock app doesn't inherit the shell PATH), model and timeout.
- [x] **Explicit start.** An "Ask Claude" link on each open thread, and an **@ dropdown** in every comment box. Posting a comment that @mentions Claude opens the preview; nothing is sent automatically. There is no background mention sweep.
- [x] **Preview.** Lists exactly what goes out: the passage or the image, the number of messages, and optional context. Scope defaults to passage + thread; section and whole-note are deliberate choices, capped at 40,000 characters. "Show exact text" shows the request verbatim.
- [x] **Draft, not a message.** The answer is an editable draft; only "Add to thread" writes it. Author kind `ai`, origin `ai`, or `ai-edited` if the user changed it.
- [x] **Cancel, timeout, retry.** A cancel kills the process. Retries are bounded (3 attempts). A cancelled or superseded request's late answer is dropped, so a retry cannot duplicate a reply.
- [x] **Errors.** Not installed, not signed in, usage/rate limit, network, timeout and empty reply each get their own message.
- [x] **Images.** The request carries the file's real bytes (type checked from content, 5 MB cap). A damaged or missing image is refused before any call.
- [x] **Untrusted data.** Note text and earlier messages are fenced as data, and closing tags inside them are neutralised. The model has no tools and cannot touch the note.
- [x] **Real-provider check (2026-09-29).** One manual request with a synthetic gradient PNG through the same flags returned "Blue gradient, dark to light." The CLI's init line showed `tools: []` and `mcp_servers: []`. CI never calls a real provider; every automated test uses a fake adapter or a Node subprocess.
- [ ] Owner UI review in the sandbox (now Settings → Threadglyph → Enable Ask AI)

### Round 2026-09-29: owner feedback, stages 6–7 (`codex/local-gemini-pilot`, one PR)
Owner feedback from the first UAT pass: Local and Gemini should come before Claude; ⌘F in the panel should open search; images need a title to comment on, like the old plugin's image captions. Plus: do stages 6 and 7, and fix earlier stages.
- [x] **Assistants: Local, then Gemini, then Claude.** Adapters are behind one provider-neutral interface, and each declares its egress.
  - **Local:** Ollama HTTP (`/api/chat`, `think: false`). Before sending an image, it checks `/api/show` for vision and refuses with the fix for a text-only model. `:cloud` models are labelled as leaving the machine.
  - **Gemini:** Gemini CLI, read-only `plan` mode, extensions off, every built-in tool excluded in its own folder, request on stdin (never on the command line), image staged in a private temp folder and deleted afterwards. Overload (503), quota, auth (exit 41), ineligible account, old Node and network each get their own message.
  - **Claude:** unchanged.
  - Command-line tools get a PATH that includes the usual install folders, because Obsidian launched from the Dock does not have one.
- [x] **Choosing.** "Ask AI" opens a preview with an assistant picker (model plus "Stays on this computer" / "Sent to Google" / "Sent to Anthropic"). The preferred assistant is a setting, Local by default. `@Local`, `@Gemini` and `@Claude` each preselect their assistant. Errors offer the other assistants as one-click alternatives. Each assistant can be switched off on its own. The old single `aiModel` setting migrates to `claudeModel`.
- [x] **⌘F in the panel** focuses thread search via a panel-scoped hotkey, so it does not steal ⌘F from notes. There is also a *Search threads* command.
- [x] **Image titles.** A title pill (alias or alt text, else the file name) with a **Comment** button sits after every supported image, in Live Preview and Reading view. It is drawn by the plugin only, never written into the note. The old plugin wrote a caption line into the note instead.
- [x] **Stage 6: compatibility.** Measured long-note costs, external-change handling, coexistence, and mobile and sync assessments are in `docs/compatibility.md`.
- [x] **Stage 6: Agent Comments import.** *Import Agent Comments from this note* parses `{==…==}{>>…<<}` and shows a preview. On confirm it creates threads anchored inside the markup and never edits the note.
  - Opinion tags, reactions and resolve markers are not carried over as messages; a trailing `resolve` sets the thread resolved.
  - Suggestions keep their wording.
  - Re-running recognises what was already imported.
- [x] **Stage 7: pilot.** `npm run package` builds `dist/threadglyph-0.2.0/` with checksums and the source commit. There are *Back up all threads* and *Restore threads from a backup* commands; backups are validated, go to the local-only folder, and a restore only adds what is missing. `docs/pilot.md` covers install and rollback, the owner test script and the walkthrough evidence.
- [x] **Sandbox.**
  - New notes: `Image titles.md` and `Agent Comments sample.md` (synthetic).
  - Ask AI starts on in the sandbox. When `~/.ilc/gemini/.env` exists, the sandbox borrows that Gemini folder read-only.
  - The owner's request to copy real commented notes from the live vault was **not** carried out: the privacy guard blocked scanning the live vault, and owner guidance says daily-note content must not leave it. Synthetic examples in the same markup stand in until the owner supplies copies.
- [x] **Live checks, synthetic content only.**
  - Local `qwen3:8b` answered a follow-up on the imported sample thread in 23.6 s, and refused the image with the fix spelled out.
  - Gemini `gemini-3.1-flash-lite` answered the same follow-up in 21.7 s, and described the synthetic PNG from its real bytes in 7.3 s.
  - `gemini-3.5-flash` returned 503 "high demand" throughout.
  - The borrowed Gemini folder was unchanged afterwards, and no temporary images were left behind.
- [ ] Owner UAT in the sandbox (script in `docs/pilot.md`)

## Known limitations

- Desktop only. Mobile is unsupported, and sync carries messages but not anchors; see `docs/compatibility.md`.
- Anchors are exact-text: if the quoted text itself is edited, the thread becomes "missing" and needs a reattach. Fuzzy matching is a possible later improvement.
- Reading view cannot highlight a quote that crosses a formatting boundary; the editor and the panel still show it.
- Changes to local anchor files from outside the app are not watched: Obsidian doesn't index dot-folders, so they are only picked up on reload.


## September 30 — AI interaction and filter feedback

PR: https://github.com/jmbost20/threadglyph/pull/8

Branch: `codex/ai-review-ux`, isolated from the ongoing `codex/local-gemini-pilot` work. This separate UI batch is based on PR #7; review targets that branch until #7 lands.

- Default preview includes passage, thread and containing section; missing anchors fall back to passage/thread instead of guessing. All three scopes show textual prompt character counts, including standing instructions. Exact text starts expanded.
- Complete assistant mention + Enter opens preview; the next Enter sends. Preview focus survives renders; Shift+Enter remains available. Escape exits to the passage and cancels an unfinished model call, preserving posted comments.
- Successful answers automatically append with AI attribution. A saving state prevents duplicate adoption. Disk failure preserves a recovery draft; retry-save does not call the provider again. Once a disk write starts it completes atomically.
- Custom filters sit below the unchanged Open / Resolved / All row. Agent, recency and local creation dates match the same comment. Buttons wrap and scope labels align at the top in narrow panels. Explicit thread navigation clears filters that hide its target.
- Baseline: 301 tests passed. Updated verification: `npm run check` passes (308 tests, 99.76% line coverage, typecheck, lint and production build). No real provider requests or live vault writes in this pass.
- Knowledge integration remains a separate draft design; no knowledge publication or Anki functionality is claimed here.

Owner sandbox validation still needed: (1) question + `@Local`, Enter, review the expanded section preview, Enter and observe one saved AI reply; (2) Escape from preview/running returns to the note without deleting the question; (3) narrow the panel and inspect button wrapping/scope separators; (4) filter AI replies by agent/date and reset. Existing edit, resolve/reopen, image-anchor and backup flows remain covered by the automated suite.

## September 30 — Comment deletion and panel centering

The owner's sandbox was still loading the PR #7 build, so the PR #8 changes (Enter after an @mention, Escape, expanded exact text with counts) had not been seen. The sandbox now links to this branch's build.

- **Delete:** a Delete button on each comment, and ⌘⇧Delete (or Ctrl+Shift+Delete) on a clicked comment. Deletion is soft (`deletedAt`); the text stays in the record, is left out of AI requests, and can be restored from **Deleted comments → Undo delete** in the panel header. A thread whose comments are all deleted is hidden.
- **Centering:** a new comment box, a newly focused card and an opened Ask AI box are centered in the panel. Re-renders keep the scroll position, and focus no longer scrolls on its own.
- **Fix:** after posting a comment with an @mention, the panel stays on the Ask AI box and its Send button instead of re-scrolling to the card's top.
- **Delete confirmation:** both the Delete button and ⌘⇧Delete ask “Delete this comment?” first; Enter confirms, Escape cancels.
- **Panel navigation:** ⌘⇧→ / ⌘⇧← step through the visible cards (wrapping), highlight the passage without moving focus to the note, and keep focus on the card. Inside a text box they still select text. The note keeps ⌥⌘] / ⌥⌘[ (owner's choice), so ⌘⇧←/→ still selects to line start/end there.
- Started by Codex (uncommitted when it hit its usage limit), finished here.

## September 30 — CI repair after the Dependabot merge

Main had been red since PR #2 (Dependabot, ten dev-dependency updates) merged: `npm ci` failed because `@codemirror/state` 6.7.6 and `@codemirror/view` 6.43.13 conflict with the exact peer versions `obsidian@1.13.1` requires (6.5.0 / 6.38.6), and TypeScript 7 is outside `typescript-eslint`'s supported range. Local checks passed only because `node_modules` predated the merge.

- `package.json` and `package-lock.json` restored to the last green set (commit `42c882f`); `npm ci && npm run check` passes from a clean install.
- `.github/dependabot.yml`: `@codemirror/*` is ignored (it follows the `obsidian` package, which supplies CodeMirror at runtime), and the grouped PR now carries only minor and patch updates, so each major update (TypeScript 7, Vitest 5, ESLint 10, happy-dom 20) arrives as its own PR and must pass CI on its own.

## September 30 — @agent: proposed edits, previewed before anything changes

Owner request: let the local agent act on notes (sort a checkbox's children, generate a list, pull in other notes), started with `@`, previewing the change without making it. Branch `codex/embedded-agent`, stacked on PR #9.

**Owner decisions (2026-09-30)**
- **Write rule changed.** It was "the plugin never writes notes". It is now "changes a note only on an explicit Accept of a previewed diff". Accept is one editor transaction (a single ⌘Z), refused if the target text changed since the preview. `AGENTS.md` and `README.md` are updated.
- **Surfaces:** all three, with the same `@` trigger: `@Agent` in a comment (panel), a sidebar agent chat, and inline `@agent …` in the note.
- **Other notes:** the agent may ask to read them; a dialog asks first (Allow / Deny, Deny by default). Searches skip daily notes and the current note; named daily notes are flagged in the dialog.

**Design**
- `src/agent/`:
  - `proposal.ts`: reply parsing. The model answers in prose plus one ```` ```threadglyph ```` JSON block with `edits: [{old, new}]` or `read: {search, notes}`. Every `old` must match exactly once; nothing is guessed.
  - `diff.ts`: line LCS diff.
  - `target.ts`: what may change. It is picked by scope: the list item with its children, the passage's lines, the section, or the note.
  - `apply.ts`: builds and checks proposals; `applyProposal` makes the single transaction.
  - `vaultRead.ts`: the permission-gated read loop, with at most 2 rounds.
  - `inline.ts`: finds and removes an `@agent …` request line.
  - `service.ts`: an in-memory proposal store shared by all surfaces.
- **Prompt:** agent requests use `AGENT_SYSTEM_PROMPT` and an `<edit-target>` block. Other notes travel as fenced `<vault-note>` data. Plain `@Local` / `@Gemini` replies keep the old prompt.
- **Privacy:**
  - Proposals and chat turns hold note text, so they are never persisted. Thread records keep only the agent's prose; a test asserts that no proposal text or JSON reaches `threadglyph/threads/`.
  - Chat and inline requests to a cloud assistant ask first.
  - The panel request goes through the existing Ask AI preview, whose scope choice decides what the agent may edit.
- **In the note:** the target text is dimmed, and a block widget below it shows the added and removed lines with Accept / Reject.
- **Sandbox:** new synthetic notes `Agent playground.md` and `Recipes.md`. Sandbox-only shortcuts: ⌘⇧↩ runs `@agent` on the line (⌘↩ already toggles checkboxes), and ⌘⇧A opens the chat.

**Evidence:** 374 tests pass (`tests/agent.test.ts`, `tests/agentPlugin.test.ts`), including:
- no write without Accept, and Reject writes nothing;
- stale refusal at Accept and on refresh;
- Deny reads nothing, and searches exclude daily notes;
- the inline request is removed only on Accept.

**Known limits**
- Proposals are lost on reload.
- The chat's target is taken at send time (selection, or the section at the cursor); it is named in the chat log.
- Search is plain word counting over at most 2,000 notes.
- Small local models may produce edits whose `old` does not match. These are refused with the reason shown.

## September 30 — A more realistic sandbox

Owner request: bring the production plugins and shortcuts into the sandbox, organize test data, and add a copy of today's daily note.

- `npm run sandbox:pull` (`scripts/sandbox-pull-production.mjs`) **reads** the real vault and writes only inside the sandbox. `scripts/sandbox-lib.mjs` checks every write path and refuses the real vault. The script copies:
  - the 18 plugins with their settings, and the same 12 enabled, plus Threadglyph;
  - core plugins, appearance, CSS snippets and property types;
  - the templates folder;
  - hotkeys, merged;
  - today's daily note, as `Test data/Daily notes/<date>.md`. An existing copy is kept unless `--refresh-daily` is passed.
- **Changes in the sandbox copies only:**
  - Obsidian Sync and Publish are off.
  - Inline Comments' `autoDispatchOnMention` is off, and its Gemini agent loses `cloudConsent`, so daily-note text is never sent on its own.
  - Threadglyph's sandbox keys win conflicts: ⌘/ over `inline-comments:add-inline-comment`, and ⌘⇧/ over `app:toggle-right-sidebar`.
- **Layout:** samples now live in `Test data/Threadglyph samples/`, and the owner's own test notes in `Test data/My test notes/`. New notes and attachments go to `Test data/Inbox` and `Test data/Attachments`. Moves update the thread and anchor paths (56 threads kept).
- The sandbox is outside the repository, so the daily-note copy is never committed. Repository fixtures stay synthetic.

## September 30 — Agent on a real daily note (sandbox copy)

The owner's first real `@Agent` request, "consolidate the cards under this item into three head bullets", timed out: `qwen3:8b did not answer within 180 seconds`. The target was the list item and its children, 6,609 characters over 127 lines. Local reproduction printed sizes and timings only, never the note text. Two causes:
1. **Wrong fence label.** The model labelled its block ```` ```json ````, so the parser ignored it and reported no change. A `json` block carrying `edits` or `read` now counts.
2. **The edit format was too slow for a rewrite.** Copying every line as `old` and then writing `new`, JSON-escaped, came to about 14,000 output characters in 240–310 s. The agent can now answer with a ```` ```threadglyph-replace ```` block holding the complete new target as plain Markdown. Agent requests also get extra time: 45 s per 1,000 target characters on top of the configured timeout, which gives 495 s here.

**After the fix,** the same request finished in 136 s and then 103 s. The parent stayed first, there were exactly 3 head bullets, and the proposal applied. It shrank 127 lines to 61–91, so the owner should review the diff before accepting. The running box now warns that local rewrites take minutes. 381 tests pass.

## September 30 — Owner feedback from the sandbox: keys, preview tree, agent results

**Owner requests (2026-09-30)**
- ⌘↩ posts from every comment box, whatever it contains. Enter makes a new line; Enter-to-post with an @mention is gone. Later steps (the Ask AI preview) take Enter or ⌘↩.
- The Ask AI preview should be navigable by keyboard as a tree: what to send, then the model. Enter continues with the defaults.
- Esc in Ask AI cancels the whole thing, including the comment that asked.
- Agent diffs should be readable, as original vs. proposed.
- Inline `@agent` was not offered. ⌘⇧⌫ did not delete a comment when an agent reply was on it.

**Causes found**
- **⌘↩ did nothing:** with the panel focused, the note stays Obsidian's active editor, so its ⌘↩ (toggle checkbox) took the key. The panel and chat now register ⌘↩, and ⌘⇧⌫/⌦, in their own shortcut scope, which Obsidian consults first while they have focus.
- **Empty agent reply** ("Here is the updated content:" with nothing after it): qwen put the rewritten Markdown in a `threadglyph` block instead of JSON. The block was stripped as unreadable and the proposal was lost. Markdown in that block now counts as a whole-block rewrite, and an unreadable answer is shown in the card instead of being dropped.
- **No `@agent` in the note:** the Inline Comments plugin's "@" member menu answered first, and Obsidian shows only the first suggester that responds. Ours now moves to the front and answers only from `@a…`, so a bare `@` still reaches Inline Comments.

**Changes**
- The preview tree has rows "What to send", "Model" (with several assistants) and "Exact text", collapsed by default. ↑/↓ move, → opens, ← closes or returns to the row, and moving onto an option chooses it. The first row is focused on open.
- Esc or Cancel before an answer soft-deletes the asking comment, which is restorable under *Deleted comments*. After Send, the question is never removed.
- Diffs wrap and show "N removed · M added". **Compare** opens an Original | Proposed side-by-side view, where each removed run faces its replacement. In the note, the widget shows the proposed version, with new lines highlighted, under the dimmed original.
- The agent chat uses the same keys: ⌘↩ sends, Enter makes a new line.
- **Superseded tests:** "Enter posts with an @mention", "exact text starts expanded" and "Escape keeps the question" were rewritten to the new behavior, as the owner asked; they were not weakened. 392 tests pass.
