# Compatibility report (stage 6)

What was measured or tested, on what, and what is still unverified. Nothing here is claimed from reading documentation alone unless it says so.

## Long notes

Measured on an Apple M1 Pro (Node 26, Vitest), synthetic notes of ordinary lines. The time is for one full rebuild of a note's thread list (resolving every anchor and numbering them). That rebuild runs after an edit, debounced 300 ms, never per keystroke. Steady state is the average of 5 runs after a warm-up.

| Note size | Threads | Rebuild | Image-embed scan |
|---|---|---|---|
| 41 KB | 20 | 0.2 ms | 0.1 ms |
| 168 KB | 50 | 2.7 ms | 0.1 ms |
| 1.7 MB | 20 | 9.5 ms | 0.7 ms |
| 1.7 MB | 200 | 87.5 ms | 0.5 ms |

- Cost grows with note size × thread count, because every anchor scans the note for **every** occurrence of its quote. That full scan is how a repeated quote is reported as ambiguous instead of being guessed. For ordinary notes the cost is negligible. At 1–2 MB with hundreds of threads a refresh is noticeable but under 0.1 s.
- `tests/compatibility.test.ts` keeps generous ceilings (3 s / 0.5 s) so a slow CI machine does not fail spuriously. They catch a regression by an order of magnitude, not small drifts.
- An insertion at the top of a 1 MB note leaves all 50 test anchors found, at the right shifted offsets.

## External changes

- **Note edited outside Obsidian** (another editor, sync, Git pull): the vault `modify` event triggers a refresh, and anchors re-resolve against the new text. Covered by plugin tests.
- **Thread file changed outside the app**: re-read on `modify` / `create` / `delete`. A malformed file is reported in the panel and never rewritten. Covered by plugin tests.
- **Anchor file (`.threadglyph/anchors`) changed outside the app**: Obsidian does not index dot-folders, so it is **not watched**; it is picked up on the next reload. This is a known limitation.
- **Stale save**: every write compares the on-disk revision. A mismatch writes nothing and keeps the draft. It **detects** a conflict; it does not merge one.

## Coexistence with Agent Comments

- Separate id, view, CSS prefix and folders. Neither plugin reads or writes the other's data, with one exception, and it is read-only: **Import Agent Comments from this note** reads the `{==…==}{>>…<<}` markup and creates Threadglyph threads. The note is never changed.
- A Threadglyph anchor inside the old markup resolves to the passage inside `{==…==}`, not to a plain copy of the same words elsewhere. If the old plugin later removes its markup, the passage is still found (tested).
- **Not yet tested:** both plugins enabled together in one live vault. The sandbox does not have Agent Comments installed, and nothing is installed into the live vault without the owner.

## Mobile

- `manifest.json` keeps `isDesktopOnly: true`. The AI layer loads Node modules (`child_process`, `http`, `fs`), which do not exist on Obsidian mobile, and the bundle loads them at startup. On mobile, the plugin would fail to load rather than degrade.
- Human-only comments could run on mobile if the AI modules were loaded lazily on desktop only. That is a contained change, but it is **untested on a device** and not claimed.

## Sync and multiple devices

- `threadglyph/threads/` holds plain JSON files with no note text. They travel with any sync (Obsidian Sync, iCloud, Git).
- `.threadglyph/` (anchors, backups) is a dot-folder. It is meant to stay local: it quotes note text, and the README tells Git users to ignore it. Obsidian Sync documents that it skips hidden folders (from the docs, not verified here). On a second device, threads therefore show with all their messages and offer **Reattach to selection**. This is by design, to keep note text out of synced records.
- Two devices changing the same thread at once: the revision check refuses to overwrite a newer file. How a given sync service resolves two diverging JSON files is **not tested**. Some services keep the last write, so one device's reply could be lost before Threadglyph ever sees it.

## Verdict

Desktop, single device: supported and tested. Long notes: fine at realistic sizes, measured above. Coexistence: data-safe by design, with a read-only import; the live side-by-side check is pending. Mobile: not supported. Multi-device sync: messages travel, anchors do not, and concurrent edits are not merged.
