# Changelog

All notable changes to Threadglyph. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Show threads on missing notes** (command palette) lists threads whose note was deleted or renamed outside Obsidian, which no panel could show. Move one to the open note and reattach it there, or delete it (and restore it from the same list).
### Changed
- Styles avoid three CSS features the Obsidian directory review flags for older devices (`text-decoration-color`, `column-gap` and `:has()`). A detached quote is struck through in faint text; the chosen assistant in Ask AI is highlighted as before.

### Fixed
- A thread on a short quote, such as one word, no longer moves silently to another copy of those words when its own passage is deleted. It asks for a reattach instead.
- Reading view highlights the right copy of a repeated quote when another copy sits somewhere hidden, such as a link's address or a comment.
- **Go to next thread** and **Go to previous thread** visit every thread, including threads that start at the same place.
- Importing inline comments: a comment with a missing or unreadable date no longer moves every later comment to the import date. It takes the time of the comment before it.
- Ask AI's "section" context no longer mistakes a `#` comment line in a note's properties block for a heading.
- **Import inline comments** skips `{==…==}{>>…<<}` examples written inside code, so documentation of the markup is not imported as comments.

## [0.3.0] - 2026-10-25

The first public release.

### Added
- MIT license, contributor and security guides, issue templates, and a release workflow that drafts a GitHub release from a version tag (installable with BRAT).
- Delete a comment or a whole thread, with a confirmation and **Deleted comments** to restore it.
- Keyboard flow in the panel: Tab moves comment by comment, **E** edits, ⌘D / ⌘⇧D delete, ⌘⇧→ / ⌘⇧← step through threads, and the active card stays centered.
- Open, Resolved and All tabs show counts; threads whose passage is gone are listed first.
- How Gitar and SonarQube reviewed Threadglyph (`docs/gitar-and-sonar.md`), an architecture overview and a roadmap.
- CodeQL and OpenSSF Scorecard checks, and build provenance for releases.
- A Code of Conduct (Contributor Covenant 2.1), support and governance pages, architecture decision records, CODEOWNERS, a dev container for Codespaces, a contributor list, and a documentation site.
- CI also runs the tests on Windows and macOS, and checks that every commit in a pull request is signed off (DCO).

### Changed
- ⌘↩ posts in every comment box; Enter makes a new line. The Ask AI preview is a small keyboard tree, and Esc cancels the whole request.
- UI code follows Obsidian's official plugin lint rules.
- The development sandbox scripts work on any machine, and refuse to use any existing vault that isn't a sandbox.

### Removed
- The experimental `@agent` from the private pilot, which proposed edits to a note and applied them on Accept. Threadglyph no longer writes to note files at all. Its code remains in the repository's history.

### Fixed
- Gemini CLI and Claude Code no longer bring in your own setup: no hooks, plugins, MCP servers, `GEMINI.md` / `CLAUDE.md` files, auto memory, telemetry or custom endpoints, so a request holds only what the preview shows and goes where it says. Each Gemini request runs in a private home deleted afterwards, which also fixes Gemini skipping the key and plan mode in a folder it did not trust. `scripts/check-cli-isolation.mjs` proves it live.
- **Send** goes only if the request still matches the preview on screen. If the note, the image or the destination changed after the preview was drawn, nothing is sent and the preview comes back with a note to check it again; this uses no retry.
- Switching the plugin off removes its highlights, numbers and image titles from Reading view, Canvas cards and hover previews straight away.
- Escape no longer throws away an AI reply that could not be saved.
- Custom filter controls keep keyboard focus after a change.
- Enter and the arrow keys navigate from a clicked comment, as from its card.
- Posting a new comment that mentions an assistant leaves the keyboard in the Ask AI preview, so Enter sends; it could jump to the reply box instead.
- On Windows, the PATH given to the Gemini and Claude tools keeps its entries whole (they are separated by `;`, not `:`).
- Local (Ollama) requests with a long note get a context window large enough to keep the instructions; Ollama otherwise silently drops the start of the prompt.
- Gemini CLI no longer starts MCP servers from your own Gemini settings for a Threadglyph request.
- An Ollama server on another machine is no longer labelled "Stays on this computer"; the preview names its host.
- Text typed into a comment box while it is saving is kept.
- Two restores of the same thread at once can no longer overwrite each other.
- An anchor file whose name does not match its thread is reported, and a fixed anchor clears its warning.

## [0.2.0] - 2026-09-30

Private pilot.

### Added
- Ask AI with **Local** (Ollama), **Gemini** (Gemini CLI) and **Claude** (Claude Code), each previewed before sending, with drafts kept when a save fails.
- `@Local`, `@Gemini` and `@Claude` mentions in comments; custom filters by author, age and date.
- Comments on images (PNG, JPEG, WebP), with a title pill and a **Comment** button on every embed.
- Numbered highlights, panel search, and thread navigation; Reading view badges.
- Read-only import of inline `{==…==}{>>…<<}` comments as threads.
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
