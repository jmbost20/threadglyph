# Sonar and review-tool experiments

Each entry records: **problem → tool feedback → decision → changed behavior → verification → remaining limitation.** Unavailable or untested tools are marked as such, not as passing.

## Tool status

| Tool | Status | Evidence |
|---|---|---|
| SonarQube Cloud (CI analysis, coverage import) | **Connected and exercised** | Org `jmbost20`, project `jmbost20_threadglyph`, CI-based analysis with LCOV import. First real analysis: PR #1 at `8f2b4ab` (scanner log: `ANALYSIS SUCCESSFUL`, lcov imported). Quality gate **failed**: 79.4% coverage on new code (required ≥ 80%) plus 7 maintainability issues. See experiment 2. The Sonar project is private, so issue details were read from the PR check annotations. |
| Gitar (PR review) | **Installed and exercised** | Reviewed PR #1 at `2dbc4fb` (1 high-risk finding) and re-reviewed `e91d5b9` (closed it, raised 2 more). See experiment 1. |
| SonarQube for IDE | Not exercised | No IDE session used so far. |
| SonarQube CLI / Vortex | Not exercised | Waiting for a Cloud baseline. |
| SonarQube MCP Server | Not exercised | Waiting for a Cloud baseline. |
| AI CodeFix / Remediation Agent | Not exercised | Needs a real finding first. |
| Advanced Security | Not exercised | Entitlement unknown. |

## Experiments

### 1. Gitar: concurrent saves lose updates; double submit duplicates threads (PR #1)

- **Problem:** `ThreadStore.save` awaited a read and then a write with no exclusion, and the controller took its snapshot from the cache before any await. So two in-app actions on one thread (Reply + Resolve, or an edit during a note rename) both passed the revision check, and the second write silently dropped the first. `commitThread` cleared `pending` only after `await store.create`, so a double submit created two threads.
- **Tool feedback:** Gitar review comment on `2dbc4fb`, flagged high risk. Suggested fix: a per-thread promise chain around `save`, and clearing `pending` before the first await.
- **Reproduced first:** six new regression tests failed on the unfixed code. The reply was dropped, the edit was lost to the rename, two threads were created, and two same-revision saves both succeeded.
- **Engineering decision:** accepted the finding; **partly adapted** the fix. Queuing only `save` (as suggested) would turn a quick Reply + Resolve into a false "changed elsewhere" conflict, because both were built from the same snapshot. Instead, `ThreadStore.update(id, change)` runs the whole read-modify-write in the per-thread queue against the latest version, and `save` goes through the same queue so an external-revision mismatch is still refused. Renames use `update` too. `commitThread` claims `pending` before awaiting and restores it on failure.
- **Found while fixing:** with writes queued instead of racing, a double-clicked Reply would post the reply twice. The panel composer now ignores a second submit while one is in flight, with a test that fails without the guard.
- **Verification:** 100 tests pass (10 new); typecheck, lint and build pass; CI green on `e91d5b9`. Gitar's re-review on `e91d5b9` **closed this finding**.
- **Round 2 (Gitar re-review on `e91d5b9`, two new findings, both accepted):**
  1. *Bug:* `commitThread` restored the selection only on a returned failure. A thrown `Error` (disk failure) skipped the restore, so the selection was lost. My earlier regression test used a `RangeError`, which `guard` converts to a result, so it missed this path. Reproduced with a failing test that injects a plain `Error` at the file layer. Fixed with a `try/catch` restore, plus a test that a newer selection made during the failed save is not overwritten. The plugin now also turns such errors into a notice ("Your text is kept") instead of an unhandled rejection.
  2. *Test quality:* the "re-enables the button" test passed even without the re-enable line, because the re-render builds a fresh button. The test now keeps the DOM in place, asserts the same button is disabled and then re-enabled, and retries successfully. A second test covers a thrown submit. Mutation check: deleting `submitButton.disabled = false` now fails both tests.
- **Verification (round 2):** 103 tests pass; typecheck, lint and build pass.
- **Remaining limitation:** serialization is per process. Two Obsidian instances (or sync) writing the same file are still handled only by the on-disk revision check, which detects a conflict and refuses to overwrite; it does not merge.

### 2. SonarQube Cloud: first analysis of PR #1 (`8f2b4ab`)

- **Tool feedback:** quality gate failed on one condition, **79.4% coverage on new code (≥ 80% required)**. There were 7 open issues, all minor maintainability "code smells" and none bugs, vulnerabilities or hotspots:
  1. `main.ts:241`: use an optional chain.
  2. `threadStore.ts:27`: mark the never-reassigned maps `readonly`.
  3. `threadStore.ts:155`: use an optional chain.
  4. `threadStore.ts:175`: extract a nested ternary.
  5. `threadStore.ts:177`: the array copy in `for…of` is unnecessary.
  6. `textAnchor.ts:13`: prefer `codePointAt` over `charCodeAt`.
  7. `ThreadPanel.ts:142`: avoid nested template literals.
- **Engineering decisions:** accepted all 7, since none changes behavior.
  - #4 and #5 were fixed together. The copy flagged by #5 was a deliberate snapshot, because the loop awaits while the cache can change. Rather than drop it, the rename logic now computes every move before the first await (still a snapshot, now explicit) and moves the path mapping into a named `renamedPath` helper.
  - #6 was fixed by comparing to `'\n'` directly instead of switching to `codePointAt`.
- **Coverage:** the gap was entirely `src/main.ts`, the Obsidian wiring, at 0%. **The quality gate was not changed and nothing was excluded.** Instead:
  - `AdapterFileStore` was moved into its own module.
  - 19 integration tests (`tests/plugin.test.ts`) drive the real plugin against a fake in-memory Obsidian vault and workspace. They check that commenting never changes the note and keeps quotes out of tracked files, that highlights reach a real CodeMirror editor, and that renames, external edits, deletes and creates are followed. They also check that a disk failure shows a notice and keeps the draft, that stale edits are reported, that navigation, reattach, the margin glyph and settings work, and that unusable selections are rejected.
- **Mutation checks:** disabling rename handling, or replacing the save-failure notice with a log line, each makes a test fail.
- **Result:** 122 tests pass. Local line coverage 99.8% (was 72.8%). SonarQube Cloud on `bf59bf3`: **quality gate passed**, 98.7% coverage on new code, 0 new issues, 0 security hotspots, 0.0% duplication. The gate conditions were unchanged.
- **Gitar on `bf59bf3`:** "Approved with suggestions" (3 of 4 findings closed). Its new suggestion was valid: the "ignores renames of its own thread files" test would pass even with the guard deleted, because no thread lives under that path. The test now spies on `renameNote`, covers renames into, out of and within the thread folder, and confirms a real note rename still goes through. Mutation check: deleting the whole guard, or only its `oldPath` half, now fails the test.
- **Limitation:** the fake runtime models only the Obsidian API surface Threadglyph uses. It is not proof of behavior inside the real app; the sandbox-vault check covers that.

### 3. Gitar and SonarQube Cloud on the stacked stage 3–5 PRs (#3, #4, #5)
- **Context:** the owner asked for stages 3–5 without a separate Sonar/Gitar round per stage. CI and both bots still ran on every push, and their findings were handled in one pass afterwards.
- **SonarQube Cloud:** the quality gate passed on all three PR heads, with the conditions unchanged.
- **Gitar:** 7 inline findings, all accepted, all real:
  1. **#3, Reading view.** The second of two threads on a repeated quote got no badge: wrapping the first shifted the DOM occurrence count. Fix: wrap last-to-first.
  2. **#3, Reading view.** Re-render signatures were keyed by path and saved even for source panes, so a Reading pane of the same note could stay stale. Fix: per-view `WeakMap`, recorded only for panes in Reading mode.
  3. **#4, Reading view.** A thread on a Markdown-style image embed could badge a different wiki embed of the same file, because those embeds shifted the count. Fix: embeds record their style; Markdown ones are skipped and not counted.
  4. **#5, AI.** After an edit, Retry showed the stale edit instead of the new answer. Fix: clear the draft key on send, cancel and close.
  5. **#5, AI.** A thrown `build()` (an unreadable note or image) left the card spinning. Fix: catch it and settle into an error.
  6. **#5, AI.** Switching AI off left sessions running and cards visible. Fix: `closeAll()` plus a refresh on every settings save, and no cards while the adapter is null.
  7. **#5, AI.** The adapter was rebuilt, probing the disk, on every refresh. Fix: cache it per settings key.
- **Verification:** each finding got a regression test, and each test was run against the unfixed source and failed there (mutation check by stashing `src/`). After the fixes: 233 tests, 99.8% line coverage, CI plus both bots green on all three heads, and no new Gitar comments.
- **Process note:** the first push of #4 failed CI on lint (`Buffer` undefined in the sandbox script), because PNG generation was added after that stage's local check had run. The fix went onto #4 and was merged forward. Lesson: run `npm run check` after the last edit, not before it.

### 4. SonarQube Cloud on the end-to-end PR #7 (`42c882f`)

- **Tool feedback:** quality gate **failed** on *Reliability Rating D on new code*. It was caused by 2 real bugs: `Array.sort()` without a compare function, in the restore dialog's file list (`modals.ts`) and in the import's date ordering (`agentComments.ts`). There were 21 further maintainability findings: `node:` import prefixes, 4 regular expressions with super-linear backtracking or too much complexity, `replaceAll` / `.at()` / optional-chain / `String.raw` / `codePointAt` preferences, cognitive complexity 16 > 15 in `renderAi`, and two `await` inside a loop.
- **Decisions:**
  - Accepted both bugs. The file list now sorts with `localeCompare`, newest first. The import no longer uses `sort().pop()` to keep message times in order; it compares the two ISO strings directly.
  - Accepted all 4 regex findings:
    - Legacy entries are parsed by hand, not with backtracking regexes.
    - The embed pattern was split into separate wiki and Markdown patterns, merged by position, with nested matches skipped (new test).
    - Stack-frame stripping filters lines instead of using a regex.
    - Trailing-slash trimming is a loop.
  - Accepted the style findings, including `node:` imports; esbuild now keeps `node:*` external too, and the bundle's `require` list was checked.
  - Extracted the preview's request section from `renderAi`.
  - **Rejected** the two `await`-in-loop warnings (import and restore). The writes are sequential on purpose: they share folder creation, and parallel `mkdir` calls race in Obsidian's adapter.
- **Verification:** 297 tests, 99.75% line coverage; typecheck, lint and build pass. The gate result for the fix commit is recorded on the PR.

### 5. Gitar on PR #7 (`2fea26f`): 4 findings, all accepted

"Approved with suggestions". Each finding was reproduced with a failing test first (`tests/gitarPr7.test.ts`: 4 of 4 failed before the fix), then fixed:
1. **Import, edge case.** The legacy pattern's lazy passage could run past a plain `{==a==}` with no comment and swallow it into the next commented highlight. The parser now scans by hand, and a passage ends at its own `==}`. This also drops the last backtracking regex in that file.
2. **Restore, bug.** Restore skipped existing thread files but could overwrite an anchor file that had outlived its thread file, for example after a later reattach. Existing anchors are now kept, which matches the "never overwrite" promise.
3. **Gemini folder, bug.** A folder pointed at in settings (the sandbox borrows `~/.ilc/gemini`) could still receive `.gemini/settings.json` if it had none. Only Threadglyph's own folder is prepared now; a borrowed folder is never written to.
4. **Sessions, edge case.** An `@Gemini` reply after a failed Local request did nothing. Mentioning a different assistant now switches a failed request, not only a preview, to a fresh preview for that assistant.

- **Verification:** 301 tests, typecheck, lint and build pass.


## September 30 — AI interaction and custom filter batch

Local baseline on `7b9a5f4`: 301 tests passed. The first restricted run could not bind the loopback HTTP fixture or write the dependency cache; the correctly permissioned run passed. Updated local `npm run check`: 308 passing tests, 99.76% line coverage, typecheck, lint and production build. No scan or Gitar approval is inferred from local checks. CI, Sonar and review results for this branch must be read from its own PR head, separately from PR #7.
