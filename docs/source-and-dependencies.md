# Source and dependencies

## Ownership

All code in `src/`, `tests/`, `scripts/` and `styles.css` was written for this project. No code was copied from other Obsidian plugins. An earlier comment plugin was consulted only to understand observed behavior and avoid conflicts; none of its source, styles or storage format is reused.

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
| vitest, @vitest/coverage-v8 | MIT | Tests and LCOV coverage |
| happy-dom | MIT | DOM for panel and editor tests |
| eslint, @eslint/js, typescript-eslint | MIT | Linting |
| obsidian (types) | MIT | API type definitions |
| @codemirror/state 6.5.0, @codemirror/view 6.38.6 | MIT | Pinned to the versions `obsidian` 1.13 declares as peers; runtime copy comes from Obsidian |
| @types/node | MIT | Types for build scripts |

## Optional AI runtime

All three assistants are external programs the owner installs. None is an npm dependency, none is bundled, and none is part of Sonar's analysis.

| Assistant | Runtime | Where requests go | How it is called |
|---|---|---|---|
| Local (preferred) | [Ollama](https://ollama.com) app (MIT) with an open-weight model, e.g. `qwen3:8b` | This computer (`:cloud` models are labelled as leaving it) | HTTP to `localhost:11434` `/api/chat` with Node's `http`; `/api/show` to check vision support |
| Gemini | Gemini CLI (Apache-2.0, Google), owner's API key | Google | Child process, no shell, request on stdin; `--approval-mode plan -e none`; runs in `~/.threadglyph/gemini`, whose settings exclude every built-in tool |
| Claude | Claude Code CLI (proprietary, Anthropic), existing sign-in | Anthropic | Child process, no shell, request on stdin; tools, MCP servers and settings files off; OS temp folder as working directory |

Only the request shown in the preview is sent. Keys are never read or stored by the plugin: Gemini CLI reads its own `.env` file, and Claude Code its own sign-in.

Sonar analysis covers this repository's source. It is not an audit of Obsidian or of these dependencies.
