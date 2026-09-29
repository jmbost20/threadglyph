# Implementation progress

## Current state

- **Stage:** 1–2 (pipeline + editable text threads), first build.
- **Branch / PR:** `codex/bootstrap` → [PR #1](https://github.com/jmbost20/threadglyph/pull/1) (ready for owner review; merge is the owner's decision)
- **CI / reviews:** see PR #1 checks for the current head. Gitar findings (3) closed; SonarQube Cloud connected. First analysis failed the gate on coverage (79.4% < 80%) plus 7 minor issues, both addressed (see `docs/sonar-experiments.md`).
- **Repo:** https://github.com/jmbost20/threadglyph (private)
- **Local checks (2026-09-29):** typecheck, lint, 122 tests and build all pass; line coverage 99.8%. `src/main.ts` is covered by integration tests against a fake Obsidian runtime (`tests/plugin.test.ts`).
- **Next step:** owner review and merge decision; manual check in the sandbox vault; after merge, verify the Sonar main-branch baseline.

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

## Known limitations

- Desktop only. Mobile and sync behavior are untested (stage 6).
- Anchors are exact-text: if the quoted text itself is edited, the thread becomes "missing" and needs a reattach. Fuzzy matching is a possible later improvement.
- Reading view shows no highlights yet (stage 3).
- Changes to local anchor files from outside the app are not watched: Obsidian doesn't index dot-folders, so they are only picked up on reload.
