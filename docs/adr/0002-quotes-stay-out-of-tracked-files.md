# 0002. Captured quotes stay out of tracked files

- **Status:** Accepted
- **Date:** 2026-09-28 (recorded 2026-10-24)

## Context

Many Obsidian vaults are kept in Git and pushed to a remote, and daily notes are often personal. Comment threads are worth committing, so they sync and have history, but a thread needs to remember the passage it is about, and that passage is note text.

A content hash of the quote was considered for spotting changes, and dropped: the hash of a short quote can give the quote away.

## Decision

Storage is split in two:

- `threadglyph/threads/<id>.json` holds thread ids, authors, timestamps, messages, edit history and resolved state, and **no captured note text**. It is safe to commit.
- `.threadglyph/anchors/<id>.json` holds the quoted passage, 64 characters of context on each side and, for images, the image path (a file name can be personal too). Users are told to ignore `.threadglyph/` in Git.

Messages are stored as written, so a comment or AI reply that repeats note text is the author's choice.

## Consequences

- Committing the thread folder never commits captured quotes.
- A fresh clone, or another device through Sync, has threads but no anchors. Each such thread shows as missing and offers **Reattach to selection**.
- Every code path that saves a thread must keep quotes out; tests check the thread files never hold the quoted text.
