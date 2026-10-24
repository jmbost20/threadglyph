# 0004. Notes are never written (`@agent` removed)

- **Status:** Accepted
- **Date:** 2026-10-24

## Context

Threadglyph started with the rule that the plugin never writes to note files. On 2026-09-30 the private pilot relaxed it for an experimental `@agent`, which proposed edits as a diff and applied them only when the user pressed **Accept**: one undoable edit, refused if the text had changed since the preview.

In use, `@agent` was put on hold (2026-10-01): small local models struggled with real restructuring, and comment help moved to `@Local` and `@Gemini` replies. It also had a weaker consent model than Ask AI: its confirmations showed scope and destination, not the full request text. Keeping it meant keeping a second, weaker path in a privacy-focused plugin.

## Decision

`@agent` is removed before the first public release (0.3.0): the proposal flow, the agent chat, inline `@agent` lines, the read-other-notes dialog, and their prompts and styles. The rule returns to its original form: **the plugin never writes to note files.** It writes only its own folders, the Gemini working folder, and a temporary copy of an image sent to an assistant.

The code stays in the repository's history.

## Consequences

- "Your notes are never changed" is unconditional, and every AI request goes through the one previewed path ([0003](0003-ai-requests-are-previewed-and-fenced.md)).
- Work that built on `@agent`, such as the knowledge-workflow prototype, needs a new design that does not write notes, or a new ADR.
- Bringing editing back would need an ADR that answers the consent gap above.
