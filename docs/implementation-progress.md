# Implementation progress

## Current state

- **Stage:** 3–5 in progress on stacked branches, at the owner's request (2026-09-29) to push core code ahead and not wait on Sonar or Gitar rounds for each stage. CI still runs on every push; Sonar results get reviewed in one pass afterwards.
- **Merged:** stages 1–2 via [PR #1](https://github.com/jmbost20/threadglyph/pull/1) (`a4182ff`). First Sonar main analysis ran on `a4182ff`. Its gate shows "not computed" because a first baseline has no new code to compare against.
- **Repo:** https://github.com/jmbost20/threadglyph (private)
- **Where to test:** the sandbox vault only (`~/Developer/threadglyph-sandbox-vault`). The owner chose to stay there before any install into the main vault.

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

## Known limitations

- Desktop only. Mobile and sync behavior are untested (stage 6).
- Anchors are exact-text: if the quoted text itself is edited, the thread becomes "missing" and needs a reattach. Fuzzy matching is a possible later improvement.
- Reading view cannot highlight a quote that crosses a formatting boundary; the editor and the panel still show it.
- Changes to local anchor files from outside the app are not watched: Obsidian doesn't index dot-folders, so they are only picked up on reload.
