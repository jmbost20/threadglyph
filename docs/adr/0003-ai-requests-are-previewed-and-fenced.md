# 0003. AI requests are previewed, and the CLIs are fenced in

- **Status:** Accepted
- **Date:** 2026-09-29 (recorded 2026-10-24; Gemini MCP allow-list added 2026-10-24)

## Context

AI replies are useful in a comment thread, but notes are personal, and an assistant's command-line tool can do far more than answer a question: read files, run commands, call MCP servers. Users need to know exactly what leaves their computer, and where it goes, before it does.

## Decision

- AI is off by default. Nothing is sent in the background: a request starts only from **Ask AI** or an `@Local` / `@Gemini` / `@Claude` mention, and is sent only after the user presses **Send** in a preview.
- The preview lists what goes (the passage or image, the thread, and the context scope the user chose) and shows the exact request text. Its destination is judged from where the request actually goes: Ollama on another machine is shown as leaving the computer.
- Local (Ollama) is the preferred assistant by default.
- The CLIs run as child processes without a shell, with the request on standard input, so note text never appears in the process list:
  - Claude Code: `--tools ""`, `--strict-mcp-config`, `--setting-sources ""` (no settings files, so no hooks or plugins), and environment switches that turn off `CLAUDE.md`, auto memory, telemetry and non-Anthropic endpoints.
  - Gemini CLI: `--approval-mode plan` (read-only), `-e none`, `--allowed-mcp-server-names threadglyph-no-mcp-servers` (Gemini treats an empty allow-list as "all", so the list names a server that cannot exist). Each request runs in a new private home (`GEMINI_CLI_HOME`) holding only Threadglyph's settings (hooks, skills, context files, telemetry and every built-in tool off; the folder trusted, so plan mode holds) and a link to the key file, deleted afterwards. Endpoint overrides and telemetry switches in the environment are cleared.
  - Both lists live in `src/ai/cli-lockdown.json`, shared with the live check (amended 2026-10-25 after the open-source audit, which found the user's own CLI setup could add unpreviewed context or destinations).
- Threadglyph never reads or stores API keys.

## Consequences

- Every new AI path must go through the same preview.
- Settings an administrator enforces machine-wide (Gemini's root-owned system settings, Claude Code's managed settings) and proxies in the environment still apply; the README says so.
- Whether each switch does what it says depends on the CLI version; the adapters name the version they were checked against, and a release's acceptance test checks them live with `scripts/check-cli-isolation.mjs`. It plants hooks, MCP servers, context files with a codeword, telemetry and a bogus endpoint, and passes only when a control run uses them and Threadglyph's run uses none yet still reaches the provider (passed with Gemini CLI 0.60.0 and Claude Code 2.1.310, 2026-10-25).
