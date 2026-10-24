# Architecture decision records

An ADR is a short note that records one significant decision: the situation, what was decided, and what follows from it. They are kept so a contributor can learn why Threadglyph works the way it does without digging through pull requests.

## When to write one

Write an ADR, and discuss it in its pull request before it is accepted, for any change to:

- a promise in the README: notes are never written, captured quotes stay out of tracked files, nothing is sent to an AI without a preview;
- the stored data format (`threadglyph/threads/`, `.threadglyph/`);
- what is sent to an AI assistant, or how an assistant's command-line tool is run;
- the project's tooling or process, when the change is hard to undo.

Everyday changes don't need one.

## How

1. Copy [template.md](template.md) to `NNNN-short-title.md`, using the next number.
2. Fill it in with status **Proposed**, and open a pull request.
3. When the maintainer accepts it, the status becomes **Accepted** and the PR is merged. A later ADR that replaces it marks the old one **Superseded by NNNN**; accepted ADRs are not rewritten.

## Index

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-quotes-stay-out-of-tracked-files.md) | Captured quotes stay out of tracked files | Accepted |
| [0003](0003-ai-requests-are-previewed-and-fenced.md) | AI requests are previewed, and the CLIs are fenced in | Accepted |
| [0004](0004-notes-are-never-written.md) | Notes are never written (`@agent` removed) | Accepted |
