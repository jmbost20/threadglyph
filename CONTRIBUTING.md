# Contributing

Thanks for helping. Bug reports, small fixes and focused features are all welcome. For anything large, open an issue first so we can agree on the shape before you write code.

## Set up

```sh
npm ci
npm run check    # typecheck, lint (including Obsidian's review rules), tests with coverage, production build
npm run dev      # rebuild on change
npm run sandbox  # disposable test vault at ~/Developer/threadglyph-sandbox-vault with the build linked
```

Open the sandbox folder in Obsidian as a vault and enable community plugins. Reload the plugin after a rebuild (⌘R in the sandbox window).

## Ground rules

- **Notes stay untouched.** Threadglyph writes to a note only when the user presses Accept on a previewed `@agent` proposal (and removes the `@a` they just typed when they pick `@agent` from the menu). Keep it that way.
- **Quotes stay out of tracked thread files.** Captured passages and their context belong in `.threadglyph/` (local only); code must never copy them into `threadglyph/threads/`. Messages are the user's and the AI's own text. See [Where data lives](README.md#where-data-lives).
- **Nothing leaves the computer without a preview.** Any new AI path must show what is sent, in full, and where, before sending. (The legacy `@agent` predates this rule and shows scope and destination only.)
- **Synthetic test data only.** Never commit real notes, screenshots of real notes, transcripts, model output from personal text, or secrets.
- **Tests come with fixes.** A bug fix includes a test that fails without it. Don't lower coverage or loosen the lint or quality gates to get a green check.

## Pull requests

- Keep each PR to one coherent change, and fill in the PR template.
- `npm run check` must pass. CI runs the same check; SonarQube Cloud and Gitar review every PR, and their findings are expected to be answered (fixed, or explained).
- Add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
- AI-assisted contributions are welcome. You are responsible for every line, so read and test what you submit. [AGENTS.md](AGENTS.md) has the rules coding agents follow here.

## Releases (maintainers)

`npm version <x.y.z>` updates `package.json`, `manifest.json` and `versions.json` and creates a bare tag (`0.3.0`). Pushing the tag drafts a GitHub release with `main.js`, `manifest.json` and `styles.css`; review it and publish.
