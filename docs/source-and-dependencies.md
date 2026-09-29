# Source and dependencies

## Ownership

All code in `src/`, `tests/`, `scripts/` and `styles.css` was written for this project. No code was copied from other Obsidian plugins. An earlier comment plugin was consulted only to understand observed behavior and avoid conflicts; none of its source, styles or storage format is reused.

## Runtime boundary

| Component | Role | Bundled? |
|---|---|---|
| Obsidian (desktop app) | Host application, plugin API, vault file access | No; provided at runtime |
| `@codemirror/state`, `@codemirror/view` | Editor highlights and the margin glyph gutter | No; marked external, Obsidian's own copy is used |
| Electron / Node built-ins | Not used by plugin code | — |

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

## Optional AI runtime (stage 5)

"Ask Claude" runs the owner's locally installed **Claude Code CLI** (proprietary, Anthropic) as a child process, using its existing sign-in. No npm package or API key is added. The plugin passes fixed arguments with no shell: every built-in tool is disabled, MCP servers and settings files are skipped, the working directory is the OS temp folder and sessions are not persisted. Only the previewed request goes over stdin. The CLI is outside this repository's source and outside Sonar's analysis.

Sonar analysis covers this repository's source. It is not an audit of Obsidian or of these dependencies.
