# 0003. AI requests are previewed, and the CLIs are fenced in

- **Status:** Accepted
- **Date:** 2026-09-29 (recorded 2026-10-24; Gemini MCP allow-list added 2026-10-24)

## Context

AI replies are useful in a comment thread, but notes are personal, and an assistant's command-line tool can do far more than answer a question: read files, run commands, call MCP servers. Users need to know exactly what leaves their computer, and where it goes, before it does.

## Decision

- AI is off by default. Nothing is sent in the background: a request starts only from **Ask AI** or an `@Local` / `@Gemini` / `@Claude` mention, and is sent only after the user presses **Send** in a preview.
- The preview lists what goes (the passage or image, the thread, and the context scope the user chose) and shows the exact request text. Its destination is judged from where the request actually goes: Ollama on another machine is shown as leaving the computer.
- **Send** (and Retry) rebuild the request and compare it with what the preview last showed: the exact text, the destination, and the image file's version. If anything differs, nothing is sent and the refreshed preview is shown again (amended 2026-10-25, after the open-source audit).
- Local (Ollama) is the preferred assistant by default.
- The CLIs run as child processes without a shell, with the request on standard input, so note text never appears in the process list:
  - Claude Code: `--tools ""`, `--strict-mcp-config`, `--setting-sources ""`.
  - Gemini CLI: `--approval-mode plan` (read-only), `-e none`, `--allowed-mcp-server-names threadglyph-no-mcp-servers` (Gemini treats an empty allow-list as "all", so the list names a server that cannot exist), and a tool-exclusion settings file in Threadglyph's own folder, created once and never overwritten.
- Threadglyph never reads or stores API keys.

## Consequences

- Every new AI path must go through the same preview.
- Gemini's other user-level settings still apply, because the CLI has no switch to ignore them all.
- Whether each flag does what it says depends on the CLI version; the adapters name the version they were checked against, and a release's acceptance test checks them live. For Gemini, `scripts/check-gemini-mcp.mjs` does this with a canary MCP server (passed on 0.60.0, 2026-10-24).
