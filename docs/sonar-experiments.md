# Sonar and review-tool experiments

Each entry records: **problem → tool feedback → decision → changed behavior → verification → remaining limitation.** Unavailable or untested tools are marked as such, not as passing.

## Tool status

| Tool | Status | Evidence |
|---|---|---|
| SonarQube Cloud (CI analysis, coverage import) | Configured in repo, **not yet connected** | Org `jmbost20` exists; project `jmbost20_threadglyph` not found (public API, 2026-09-28); no `SONAR_TOKEN` secret. The Free plan covers private projects up to 50k LoC (Sonar pricing page, checked 2026-09-28); whether it includes PR decoration is to be verified at setup. **Until then the "SonarQube Cloud" CI job shows green while skipping the scan; its step summary says NOT ANALYSED.** |
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
