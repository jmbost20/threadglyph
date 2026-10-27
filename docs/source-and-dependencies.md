# Source and dependencies

## Ownership

All code in `src/`, `tests/`, `scripts/` and `styles.css` was written for this project; to the maintainer's knowledge no code was copied from other Obsidian plugins. Threadglyph's importer reads inline `{==…==}{>>…<<}` comment markup, but Threadglyph's own storage format and styles are separate.

## Runtime boundary

| Component | Role | Bundled? |
|---|---|---|
| Obsidian (desktop app) | Host application, plugin API, vault file access | No; provided at runtime |
| `@codemirror/state`, `@codemirror/view` | Editor highlights and the margin glyph gutter | No; marked external, Obsidian's own copy is used |
| Node built-ins (`child_process`, `http`, `fs`, `os`, `path`) | AI adapters only: start the Gemini/Claude CLIs, call the local Ollama server, stage an image in a temp folder | No; provided by Obsidian desktop (Electron). This is why the plugin is desktop-only |

The shipped `main.js` contains only this project's code.

## Development dependencies

Exact versions are pinned in `package-lock.json`.

| Package | License | Purpose |
|---|---|---|
| typescript | Apache-2.0 | Type checking |
| esbuild | MIT | Bundling |
| vitest, @vitest/coverage-v8 (5.x) | MIT | Tests and LCOV coverage |
| happy-dom | MIT | DOM for panel and editor tests |
| eslint, @eslint/js, typescript-eslint | MIT | Linting |
| eslint-plugin-obsidianmd | MIT | Obsidian's own plugin review rules |
| obsidian (types) | MIT | API type definitions |
| @codemirror/state 6.7.6, @codemirror/view 6.43.13 | MIT | Pinned to the versions `obsidian` 1.14 declares as peers; runtime copy comes from Obsidian. Update all three together (see `.github/dependabot.yml`) |
| @types/node | MIT | Types for build scripts |

## npm audit triage

Development dependencies only; none of them is bundled into `main.js`. Last checked 2026-10-27: `npm audit` finds no advisories.

| Advisory | Severity | Where it comes from | Disposition |
|---|---|---|---|
| [GHSA-4p3w-j4w9-5jqw](https://github.com/advisories/GHSA-4p3w-j4w9-5jqw): path traversal via a crafted non-string locale name | Moderate | `moment`, a dependency of the `obsidian` type package. `obsidian` 1.14 brought the fixed 2.31.0, but the copy of `obsidian` 1.12.3 inside `eslint-plugin-obsidianmd` still asked for 2.29.4 | Fixed 2026-10-27: an `overrides` entry in `package.json` gives both copies `moment` 2.31.0. It was never exploitable here (only types are used at build time, nothing calls `moment`, and at runtime Obsidian supplies its own copy). Remove the override once the lint plugin moves past `obsidian` 1.12.3. |

Earlier advisories in Vitest 2, its `tinypool`/`vite` chain, happy-dom 15 and esbuild 0.24 (4 critical, 2 high, 3 moderate) were cleared by upgrading to Vitest 5, happy-dom 21 and esbuild 0.28.

## Optional AI runtime

All three assistants are external programs the owner installs. None is an npm dependency, none is bundled, and none is part of Sonar's analysis.

| Assistant | Runtime | Where requests go | How it is called |
|---|---|---|---|
| Local (preferred) | [Ollama](https://ollama.com) app (MIT) with an open-weight model, e.g. `qwen3:8b` | This computer with the default `localhost` address. A server on another machine, and `:cloud` models, are labelled as leaving it | HTTP to `localhost:11434` `/api/chat` with Node's `http`; `/api/show` to check vision support |
| Gemini | Gemini CLI (Apache-2.0, Google), owner's API key | Google | Child process, no shell, request on stdin; `--approval-mode plan` (read-only), `-e none` (no extensions) and an MCP allow-list naming no real server (no MCP servers); runs in a private home made for each request with hooks, skills, context files, telemetry and built-in tools off and endpoint overrides cleared (`src/ai/cli-lockdown.json`) |
| Claude | Claude Code CLI (proprietary, Anthropic), existing sign-in | Anthropic | Child process, no shell, request on stdin; `--tools ""`, `--strict-mcp-config`, `--setting-sources ""`; `CLAUDE.md`, auto memory, telemetry and other endpoints off (`src/ai/cli-lockdown.json`); OS temp folder as working directory |

Only the request shown in the preview is sent; `node scripts/check-cli-isolation.mjs` checks that the CLIs add nothing of the user's own setup. Keys are never read or stored by the plugin: Gemini CLI reads its own `.env` file (linked into each request's private home), and Claude Code its own sign-in.

Sonar analysis covers this repository's source. It is not an audit of Obsidian or of these dependencies.
