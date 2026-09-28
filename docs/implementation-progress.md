# Implementation progress

## Current state

- **Stage:** 1–2 (pipeline + editable text threads), first build.
- **Branch / PR:** `codex/bootstrap`; PR link added once it's created.
- **Repo:** https://github.com/jmbost20/threadglyph (private)
- **Local checks (2026-09-28):** typecheck, lint, 90 tests, build all pass. Line coverage is 72.5%: 100% for the domain, storage, controller and panel; 0% for `src/main.ts`, the Obsidian wiring. That file is verified by the manual sandbox check, not unit tests, and is deliberately not excluded from coverage.
- **Next step:** CI on the PR, then set up SonarQube Cloud and Gitar (needs the owner's login), then the manual sandbox check.

## Decisions (stage 0)

| Decision | Choice | Why |
|---|---|---|
| Coexistence with the existing comment plugin | Separate id `threadglyph`, view `threadglyph-panel`, `tg-` CSS prefix, no default hotkey, JSON storage outside notes | Neither plugin reads or writes the other's data. The only interaction is that the other plugin edits notes inline, which Threadglyph handles as an ordinary external edit (re-anchor). |
| Where to test | Disposable sandbox vault (`npm run sandbox`) until stage 2 passes; then the owner decides on installing into the live vault | Early builds never write into real notes' vault. |
| Storage | Split: tracked `threadglyph/threads/<id>.json` (no note text) and local-only `.threadglyph/anchors/<id>.json` (quote + context) | The owner's vault is Git-tracked with a remote. Comments may be committed, but note content (especially daily notes) must not be pushed through thread records. |
| Anchor strategy | Quote + 64 characters of prefix/suffix + line hint. An exact single match wins; repeated quotes are ranked by surrounding context; ties become **ambiguous**; a deleted quote becomes **missing** | Never silently attaches to the wrong occurrence. The line hint is deliberately not used to break ties. |
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
- [ ] Private GitHub repo, bootstrap PR, CI results on the head SHA
- [ ] SonarQube Cloud project + `SONAR_TOKEN` (owner login needed)
- [ ] Gitar app on this repo (owner consent needed)
- [ ] Branch protection on `main`: verify what the plan enforces for a private repo

### Stage 2: editable text threads
- [x] Thread model: create / reply / edit with retained revisions / resolve / move
- [x] Text anchors: capture, resolve, ambiguity, missing
- [x] Storage: split sidecars, schema validation, path-escape guard, stale-save check, rename following, per-file reload
- [x] Controller: drafts, edit sessions, stale-edit detection, reattach
- [x] Panel + margin glyph + highlights
- [ ] Manual check in the sandbox vault, including coexistence with the other comment plugin
- [ ] Owner UI review

## Known limitations

- Desktop only. Mobile and sync behavior are untested (stage 6).
- Anchors are exact-text: if the quoted text itself is edited, the thread becomes "missing" and needs a reattach. Fuzzy matching is a possible later improvement.
- Reading view shows no highlights yet (stage 3).
- Changes to local anchor files from outside the app are not watched: Obsidian doesn't index dot-folders, so they are only picked up on reload.
