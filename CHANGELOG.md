# Changelog

All notable changes to Threadglyph. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-10-24

The first public release.

### Added
- MIT license, contributor and security guides, issue templates, and a release workflow that drafts a GitHub release from a version tag (installable with BRAT).
- Delete a comment or a whole thread, with a confirmation and **Deleted comments** to restore it.
- Keyboard flow in the panel: Tab moves comment by comment, **E** edits, ⌘D / ⌘⇧D delete, ⌘⇧→ / ⌘⇧← step through threads, and the active card stays centered.
- Open, Resolved and All tabs show counts; threads whose passage is gone are listed first.
- `@agent` (legacy, on hold): proposes edits to a note as a diff, applied only on Accept.
- How Gitar and SonarQube reviewed Threadglyph (`docs/gitar-and-sonar.md`), an architecture overview and a roadmap.
- CodeQL and OpenSSF Scorecard checks, and build provenance for releases.

### Changed
- ⌘↩ posts in every comment box; Enter makes a new line. The Ask AI preview is a small keyboard tree, and Esc cancels the whole request.
- UI code follows Obsidian's official plugin lint rules.
- The development sandbox scripts work on any machine, and refuse to use any existing vault that isn't a sandbox.

### Fixed
- Escape no longer throws away an AI reply that could not be saved.
- Custom filter controls keep keyboard focus after a change.
- Enter and the arrow keys navigate from a clicked comment, as from its card.
- An AI rewrite containing a plain code block is no longer cut short, and its note text no longer reaches the saved reply.
- Deleting a thread drops its pending `@agent` proposal.

## [0.2.0] - 2026-09-30

Private pilot.

### Added
- Ask AI with **Local** (Ollama), **Gemini** (Gemini CLI) and **Claude** (Claude Code), each previewed before sending, with drafts kept when a save fails.
- `@Local`, `@Gemini` and `@Claude` mentions in comments; custom filters by author, age and date.
- Comments on images (PNG, JPEG, WebP), with a title pill and a **Comment** button on every embed.
- Numbered highlights, panel search, and thread navigation; Reading view badges.
- Import of Agent Comments' `{==…==}{>>…<<}` comments as threads, read-only.
- Back up all threads and restore from a backup (adds only what is missing).
- Long-note performance measurements and compatibility notes.

## [0.1.0] - 2026-09-28

### Added
- Comment threads anchored to selected text, stored beside the note: tracked thread files hold no note text; the quote lives in a local-only anchor file.
- A side panel to reply, edit (history kept), resolve and reopen; highlights and a margin glyph in the editor.
- Anchors that follow edits and renames, and say so instead of guessing when the passage is gone or ambiguous.

[Unreleased]: https://github.com/jmbost20/threadglyph/compare/0.3.0...HEAD
[0.3.0]: https://github.com/jmbost20/threadglyph/releases/tag/0.3.0
[0.2.0]: https://github.com/jmbost20/threadglyph/commits/main
[0.1.0]: https://github.com/jmbost20/threadglyph/pull/1
