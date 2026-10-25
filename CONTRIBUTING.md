# Contributing

Thanks for helping. Bug reports, small fixes and focused features are all welcome. For anything large, open an issue first so we can agree on the shape before you write code. Questions go to [Discussions](https://github.com/jmbost20/threadglyph/discussions). Issues labelled [good first issue](https://github.com/jmbost20/threadglyph/labels/good%20first%20issue) are a good place to start.

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Set up

You need Node 22 (22.12 or later), 24, or 26 or later, the versions Vitest supports (`.nvmrc` pins 22; `nvm use` picks it up).

```sh
npm ci
npm run check    # typecheck, lint (including Obsidian's review rules), tests with coverage, production build
npm run dev      # rebuild on change
npm run sandbox  # disposable test vault at ~/Developer/threadglyph-sandbox-vault with the build linked
```

Open the sandbox folder in Obsidian as a vault and enable community plugins. Reload the plugin after a rebuild (⌘R in the sandbox window).

The `npm run uat*` scripts are for the maintainer: they drive the maintainer's `obsidian-uat` harness, which is not published. To check a change by hand inside Obsidian, follow the [manual test script](docs/dev/pilot.md#owner-test-script) in the sandbox.

No local setup? Open the repository in **GitHub Codespaces** (or a VS Code dev container): Node and the dependencies are ready, and `npm run check` runs there. Trying the plugin inside Obsidian still needs a desktop vault.

## Ground rules

- **Notes stay untouched.** Threadglyph never writes to a note file. A change that would make it do so needs an issue and the maintainer's agreement first.
- **Quotes stay out of tracked thread files.** Captured passages and their context belong in `.threadglyph/` (local only); code must never copy them into `threadglyph/threads/`. Messages are the user's and the AI's own text. See [Where data lives](README.md#where-data-lives).
- **Nothing leaves the computer without a preview.** Any new AI path must show what is sent, in full, and where, before sending.
- **Synthetic test data only.** Never commit real notes, screenshots of real notes, transcripts, model output from personal text, or secrets.
- **Tests come with fixes.** A bug fix includes a test that fails without it. Don't lower coverage or loosen the lint or quality gates to get a green check.

## Pull requests

- Keep each PR to one coherent change, and fill in the PR template.
- Name the branch `<type>/<short-topic>`, with the same types as commit messages: for example `feat/image-threads` or `fix/panel-focus`.
- `npm run check` must pass. CI runs the same check; SonarQube Cloud and Gitar review every PR, and their findings are expected to be answered (fixed, or explained).
- Add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
- Changes to a README promise, the stored data format or what is sent to an AI need an [architecture decision record](docs/adr/README.md) first.
- AI-assisted contributions are welcome. You are responsible for every line, so read and test what you submit. [AGENTS.md](AGENTS.md) has the rules coding agents follow here.

## Sign-off (DCO)

Every commit needs a `Signed-off-by:` line, which certifies the [Developer Certificate of Origin](https://developercertificate.org): that you wrote the change, or otherwise have the right to submit it under the project's license. Add it with `git commit -s`. A CI check looks for it on every pull request.

Forgot? `git rebase --signoff main`, then push the branch again.

## Credit

Contributors are listed in the README, for code and for everything else (docs, testing, bug reports, ideas, reviews). After your first contribution is merged, a maintainer adds you; you can also ask in your pull request.

Maintainers add someone with `npx all-contributors-cli add <github-login> <contribution types>`, or by commenting `@all-contributors please add @<login> for code, doc` on a pull request once the all-contributors app is installed.

## Releases (maintainers)

Before tagging, run the [acceptance script](docs/dev/pilot.md#owner-test-script), including the live CLI isolation check (`node scripts/check-cli-isolation.mjs gemini <Gemini folder> claude`).

`npm version <x.y.z>` updates `package.json`, `manifest.json` and `versions.json` and creates a bare tag such as `0.4.0`. The first release, 0.3.0, is already the version in those files, so it is tagged directly: `git tag 0.3.0`. Pushing the tag drafts a GitHub release with `main.js`, `manifest.json` and `styles.css`; review it and publish.
