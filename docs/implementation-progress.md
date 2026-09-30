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

Branch: `codex/ai-review-ux`, isolated from the ongoing `codex/local-gemini-pilot` work. This separate UI batch is based on PR #7; review targets that branch until #7 lands.

- Default preview includes passage, thread and containing section; missing anchors fall back to passage/thread instead of guessing. All three scopes show textual prompt character counts, including standing instructions. Exact text starts expanded.
- Complete assistant mention + Enter opens preview; the next Enter sends. Preview focus survives renders; Shift+Enter remains available. Escape exits to the passage and cancels an unfinished model call, preserving posted comments.
- Successful answers automatically append with AI attribution. A saving state prevents duplicate adoption. Disk failure preserves a recovery draft; retry-save does not call the provider again. Once a disk write starts it completes atomically.
- Custom filters sit below the unchanged Open / Resolved / All row. Agent, recency and local creation dates match the same comment. Buttons wrap and scope labels align at the top in narrow panels. Explicit thread navigation clears filters that hide its target.
- Baseline: 301 tests passed. Updated verification: `npm run check` passes (308 tests, 99.76% line coverage, typecheck, lint and production build). No real provider requests or live vault writes in this pass.
- Knowledge integration remains a separate draft design; no knowledge publication or Anki functionality is claimed here.

Owner sandbox validation still needed: (1) question + `@Local`, Enter, review the expanded section preview, Enter and observe one saved AI reply; (2) Escape from preview/running returns to the note without deleting the question; (3) narrow the panel and inspect button wrapping/scope separators; (4) filter AI replies by agent/date and reset. Existing edit, resolve/reopen, image-anchor and backup flows remain covered by the automated suite.
