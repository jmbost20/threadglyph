# Governance

Threadglyph is a small project with one maintainer. This page says how decisions are made, so contributors know what to expect.

## Roles

- **Maintainer:** Jonah Bostrom ([@jmbost20](https://github.com/jmbost20)). Sets direction, reviews and merges pull requests, cuts releases, and enforces the [Code of Conduct](CODE_OF_CONDUCT.md).
- **Contributors:** anyone who opens an issue, a discussion or a pull request. Contributions of every kind are credited in the README's contributor list.
- **Co-maintainers:** a contributor with a record of good pull requests and reviews may be invited to help maintain the project. Co-maintainers get write access, are added to [CODEOWNERS](.github/CODEOWNERS), and can review and merge pull requests.

## How decisions are made

- **Everyday changes** are decided in issues and pull requests. The maintainer has the final say and explains the reason.
- **Larger decisions** are written up as an [architecture decision record](docs/adr/README.md) and discussed in its pull request before they are accepted. That covers anything that changes a promise in the README, the stored data format, or what is sent to an AI assistant.
- **The three promises** are the hardest to change: notes are never written, captured quotes stay out of tracked files, and nothing is sent to an AI without a preview. Changing one needs an ADR.

## AI-assisted work

Much of Threadglyph was written by AI coding agents under the maintainer's direction (see [How it was built](README.md#how-it-was-built)). Every contribution follows the same rules, AI-assisted or not: a person submits it, signs it off under the [DCO](CONTRIBUTING.md#sign-off-dco), and answers for it in review. [AGENTS.md](AGENTS.md) has the extra rules coding agents follow here.

## Changing this document

By pull request, decided by the maintainer.
