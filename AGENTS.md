# Agent instructions: Threadglyph

## Standing authority (repository-scoped)

The owner has authorized coding agents working **in this repository**, without asking each time, to:

- create `codex/<short-feature>` branches, and choose how to group commits and pushes;
- commit intended source, tests and docs, and push finished features plus useful intermediate checkpoints;
- open and update PRs (ready for review, not draft, unless there is a strong reason — owner request 2026-09-29), reusing the existing PR on reruns;
- pick a PR mode per batch of work: **end-to-end** (one branch and one PR for a large batch; the owner's current choice) or **incremental** (several smaller PRs, one per coherent feature);
- adjust CI and repository settings for this repo only.

**Not authorized:** committing to or force-pushing `main`, merging (an owner decision), making the repo public, publishing releases, paid upgrades, installing into the owner's live vault, or modifying other plugins or projects.

## Rules

- Stage explicit files and inspect the diff before every commit. Never commit real vault content, screenshots of real notes, transcripts, provider output or secrets. Test fixtures are synthetic.
- The plugin changes a note only when the user explicitly asks in the moment: **Accept** on a previewed agent proposal (one undoable editor transaction, refused if the text changed since the preview), or choosing `@agent` from the editor's autocomplete (which only removes the `@a…` just typed and opens the ask window). Nothing else writes to note files (owner decision 2026-09-30). Knowledge workflows (off by default; sandbox only until the owner says otherwise) create and append to notes **only inside the configured knowledge folder**, never source notes (owner request 2026-10-01). Tracked thread records must never contain quoted note text, and agent proposals, which do, stay in memory only (see `README.md`, "Where data lives").
- Only one actor writes a branch at a time. Fetch and compare before building on bot or remediation commits, and never force-push over them.
- Stop an automated repair loop after two failed attempts at the same failure, and report the evidence. Never weaken tests, coverage or the quality gate to get a green check.
- Record decisions, PR links and blockers in `docs/implementation-progress.md`, and Sonar/Gitar evidence in `docs/sonar-experiments.md`.

## Commands

```sh
npm ci && npm run check   # typecheck, lint, coverage, build
npm run sandbox           # disposable test vault
```

## Feature is done when

The acceptance criteria for its stage are met, `npm run check` passes, CI is green on the PR head SHA, and the progress doc is updated.
