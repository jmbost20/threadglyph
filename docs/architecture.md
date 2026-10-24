# Architecture

How Threadglyph is put together, and the rules each part keeps. For the user-facing view of the same rules, see the README's [Where data lives](../README.md#where-data-lives) and [Disclosures](../README.md#disclosures).

```mermaid
flowchart LR
  subgraph Obsidian
    Editor["Editor and Reading view<br/>highlights, margin glyph, image titles"]
    Panel["Thread panel<br/>(ui/ThreadPanel)"]
  end
  Plugin["Plugin wiring<br/>(main.ts)"]
  Controller["Controller<br/>(controller.ts)"]
  Anchor["Anchors<br/>(anchor/)"]
  Store["Thread store<br/>(storage/)"]
  AI["AI boundary<br/>(ai/)"]
  Tracked[("threadglyph/threads/*.json<br/>messages; no captured quotes")]
  Local[(".threadglyph/anchors/*.json<br/>quotes, local only")]
  Ollama["Ollama on localhost"]
  CLIs["gemini / claude CLIs"]

  Editor --> Plugin
  Panel --> Plugin
  Plugin --> Controller --> Store
  Plugin --> Anchor
  Store --> Tracked
  Store --> Local
  Plugin -- "previewed request" --> AI
  AI --> Ollama
  AI --> CLIs
```

## Parts

| Folder | Role |
|---|---|
| `src/model/` | Thread and message types and pure operations on them (reply, edit with history, resolve, delete). No Obsidian imports. |
| `src/anchor/` | Captures a selection as a quote plus 64 characters of context on each side, and finds it again in the current note text. Also parses image embeds. |
| `src/storage/` | Reads and writes threads and anchors, validates every record, and runs a per-thread queue so two quick actions can't overwrite each other. Backup and restore. |
| `src/controller.ts` | The commands the panel and editor call (comment, reply, edit, resolve, delete), and pending selections and drafts. |
| `src/ui/` | The thread panel, editor and Reading-view decorations, and modals. |
| `src/ai/` | One provider-neutral boundary (`types.ts`) with three adapters: Ollama over HTTP, and the Gemini and Claude command-line tools as child processes. Also builds the request and the preview. |
| `src/import/` | Read-only import of Agent Comments' `{==…==}{>>…<<}` markup. |
| `src/main.ts` | Obsidian wiring: commands, views, settings, file events, and the glue between the parts above. |

## How an anchor is found again

1. Find every place the quote occurs in the note.
2. **No match:** the thread is shown as *missing*, with **Reattach to selection**.
3. **One match:** found.
4. **Several matches:** rank them by how much of the saved context still surrounds each one. A tie is reported as *ambiguous*, never guessed. Line numbers are not used to break ties, because they shift with ordinary edits.

Rebuilding a note's anchors runs after edits (debounced 300 ms), not on each keystroke. Measured costs are in [compatibility.md](compatibility.md).

## Rules the code keeps

- **Notes are read, never written.** No code path writes to a note file; the plugin writes only its own folders (`threadglyph/`, `.threadglyph/`), the Gemini working folder, and a temporary copy of an image sent to an assistant.
- **Captured quotes stay out of tracked files.** Quotes, context and image paths live only in `.threadglyph/`. Messages, including AI replies, are stored as written and can repeat note text a user or model chose to include.
- **Ask AI is previewed.** Ask AI and @mention requests are built first, shown with their destination and exact text, and only then sent. Destinations come from where a request actually goes (a non-local Ollama address counts as leaving the computer).
- **External tools are fenced in, to the extent each CLI allows.** Both run without a shell and get the request on stdin. Claude Code runs with `--tools ""`, `--strict-mcp-config` and `--setting-sources ""`. Gemini CLI runs with `--approval-mode plan` (read-only) and `-e none`, plus a tool-exclusion settings file in Threadglyph's own folder; user-level Gemini settings still apply. Threadglyph never reads API keys.
- **Data is validated on the way in.** Every thread, anchor and backup record is checked against its schema; invalid records are skipped and reported, never half-loaded.

## Tests

`npm run check` runs about 340 tests with line coverage around 99.8%. UI tests run in happy-dom against a small Obsidian stand-in (`tests/obsidianStub.ts`). Plugin tests drive the real plugin class against an in-memory vault and workspace, with a real CodeMirror editor. Behavior inside the Obsidian app is checked by hand in a disposable sandbox vault (`npm run sandbox`).
