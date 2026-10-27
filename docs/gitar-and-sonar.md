# How Gitar and SonarQube reviewed Threadglyph

Threadglyph was written by AI coding agents (OpenAI Codex and Anthropic Claude Code), working on a pull request at a time. Every feature pull request was reviewed by [Gitar](https://gitar.ai) and analysed by [SonarQube Cloud](https://sonarcloud.io) before it was merged (the exceptions are listed under [What the tools did not do](#what-the-tools-did-not-do)). This page is the short version of what those tools found and what changed because of it, with links to the original review comments. The full working log is in [docs/dev/sonar-experiments.md](dev/sonar-experiments.md).

## In numbers

| | |
|---|---|
| Pull requests with Gitar findings | 29 (28 merged, 1 closed without merging) |
| Gitar findings on merged code | **63** distinct findings, all resolved: 62 fixed, 1 made moot by a later redesign |
| …of which bugs or security issues | 21 (19 bugs, 2 security) |
| …edge cases | 23 |
| …test, documentation or code quality | 18 (including tests that could not fail, and docs that no longer matched the code) |
| …performance | 1 |
| Findings on the knowledge-workflows PR (#12, closed without merging) | 10, all fixed on that branch |
| Sonar quality-gate failures | 2: low coverage on new code (PR #1) and Reliability rating D, caused by two real bugs (PR #7) |
| How the coverage gate was met | With tests: no files excluded and no gate conditions lowered. Line coverage went from 72.8% to 99.8%, and is about 99.8% today |

**How the findings were counted:** every top-level Gitar review comment on a merged pull request, by its own category label. Two findings were posted on both #7 and #8 (#8 was stacked on #7); each is counted once. The counts cover every pull request merged up to release 0.3.1 (#52), last checked on October 27. Coverage figures come from the development log and `npm run check`.

## How the loop works

1. An agent opens a pull request.
2. CI runs typecheck, lint (including Obsidian's own plugin rules), the tests with coverage, and the production build.
3. SonarQube Cloud applies its quality gate to the new code. Gitar reviews the diff and leaves findings inline.
4. The agent reproduces each finding with a test that fails, then fixes it. If it disagrees, it writes down why instead.
5. Gitar re-reviews the new commits and closes what is fixed. The maintainer merges.

The rules the agents follow are in [AGENTS.md](../AGENTS.md). Two of them matter most here: never weaken a test, coverage or the quality gate to get a green check; and stop after two failed attempts at the same failure and report instead.

## Six findings worth reading

### 1. Two quick actions could silently lose a reply (PR #1)

[Gitar's comment](https://github.com/jmbost20/threadglyph/pull/1#discussion_r4122849310): saving a thread read the file, then wrote it, with nothing stopping a second save in between. Replying and resolving in quick succession could drop the reply, and a double-click could create two threads. Six tests reproduced it. The suggested fix (queue the saves) would have reported a false conflict, so the agent adapted it: the whole read-modify-write runs in a per-thread queue. Gitar's re-review closed the finding, then found two more problems in the fix itself ([one](https://github.com/jmbost20/threadglyph/pull/1#discussion_r4124548487), [two](https://github.com/jmbost20/threadglyph/pull/1#discussion_r4124548706)).

### 2. A privacy promise checked from three directions (PRs #10 and #14)

Threadglyph promises that the thread files you can commit to Git never contain your note's text. Gitar found three different ways an AI reply could break that:

- [An unreadable edit block](https://github.com/jmbost20/threadglyph/pull/10#discussion_r4145848206), which quotes the note, could be saved into the thread (flagged as security).
- [A rewrite was cut off at the first code block inside it](https://github.com/jmbost20/threadglyph/pull/10#discussion_r4146492016), leaving the rest of the note in the saved reply.
- After that fix, [an *unlabelled* code block still cut it off](https://github.com/jmbost20/threadglyph/pull/14#discussion_r4366902160). The first fix had only handled labelled ones.

Each one now has a test that checks the thread files never hold the quoted text.

### 3. "Restore never overwrites" did overwrite (PR #7)

[Gitar's comment](https://github.com/jmbost20/threadglyph/pull/7#discussion_r4137041506): restoring from a backup was documented to only add missing threads, but it replaced existing anchor files. In the same review it found that a Gemini folder the user only lent to Threadglyph [was being written to](https://github.com/jmbost20/threadglyph/pull/7#discussion_r4137041646).

### 4. Accept could edit the wrong copy of a passage (PR #10)

[Gitar's comment](https://github.com/jmbost20/threadglyph/pull/10#discussion_r4145848018): if the text an AI proposal was about had been edited, and the same text existed elsewhere in the note, Accept would rewrite the other copy. The fix made proposals remember the text around them, so Accept refused unless the passage and its surroundings were unchanged and unique. (`@agent`, the feature behind this finding and the ones in section 2, was later removed: Threadglyph no longer writes to notes at all.)

### 5. Sonar: two real bugs behind a "D", and a finding declined with a reason (PR #7)

The quality gate failed on Reliability rating D. Behind it were two real bugs: `Array.sort()` without a compare function, in the backup list and in the import's date ordering. Of Sonar's 21 maintainability findings, 19 were accepted, including four regular expressions Sonar flagged for super-linear backtracking or excess complexity, which were rewritten. The other two, "`await` inside a loop" warnings, were declined: those writes are sequential on purpose, because parallel folder creation races in Obsidian's file adapter. The reason is recorded in the log rather than silenced.

On PR #1 the gate failed on coverage (79.4% of new code, 80% required). The gap was the Obsidian wiring, at 0%. Instead of excluding it, 19 integration tests were written that drive the real plugin against an in-memory Obsidian.

### 6. Reviewing the tests, not just the code (PRs #1 and #9)

Several findings were about tests that could not fail:

- [a test that passed even with the guard it tested deleted](https://github.com/jmbost20/threadglyph/pull/1#discussion_r4128873979);
- [a "re-enables the button" test that never checked the button](https://github.com/jmbost20/threadglyph/pull/1#discussion_r4124548706);
- [a "lost passage" check that passed even if the code skipped the passage](https://github.com/jmbost20/threadglyph/pull/9#discussion_r4145383712).

Each fix was confirmed by breaking the code on purpose and watching the test fail.

## What the tools did not do

- **Findings still open when a pull request merged stayed open.** Gitar reviews new commits on an open PR, but nothing stopped a merge with findings outstanding, and nothing reminded anyone afterwards. Six findings on PRs #7–#9 were in that state. An audit on October 24 found them: five were fixed then, each with a test or a config change, and one had already been made moot by a redesign ([details](#closing-the-open-findings)). It happened again: a check on October 27 found two findings on #29 still open (an old sandbox kept a renamed sample note, and the changelog never mentioned the import command's rename), and both were fixed then. The same day, one pull request (#47) was merged on a review that still had a suggestion; it was fixed in #48.
- **Not every merge went through the checks.** An early Dependabot update (#2) was merged with failing CI and without a Gitar review. It broke the build on main until #9 restored the dependency pins.
- **A green Sonar job is not a passing gate.** CI's Sonar job uploads the analysis; it does not wait for the quality gate. The gate result arrives as a separate check from SonarQube Cloud, and while the project was private that check failed to process. Read the gate check, not the upload job.
- **Neither tool tests the plugin inside Obsidian.** The maintainer checks behavior by hand in a disposable test vault. Automated in-app tests are on the [roadmap](roadmap.md).
- **Sonar's issue details** were not readable from CI while the project was private, so some rounds record only the gate result.

## A second opinion

Before going public, the whole project was reviewed once more by a different agent (OpenAI Codex), reading the code and docs together rather than one diff at a time. It found problems the per-PR reviews had not, mostly where the documentation promised more than the code enforced:

- The README called thread files free of note text, but comments and AI replies are stored as written and can quote the note. The docs now say exactly what is kept out (captured quotes) and what isn't.
- An Ollama server on another machine was labelled "Stays on this computer". The label now comes from the configured address.
- Gemini CLI's isolation was described as tools, MCP servers and settings all off. It ran in read-only plan mode with extensions off, but MCP servers from the user's own settings still started. The docs were corrected, and Gemini now also gets an MCP allow-list that names no real server.
- Text typed while a comment was saving could be lost, two overlapping restores could overwrite each other, and the sandbox scripts' vault guard could be bypassed through a parent folder or a symlink. Each is fixed, with a test or a scripted check.
- Development dependencies carried 12 npm advisories (4 critical). Upgrading Vitest, happy-dom and esbuild left 3 moderate ones, triaged in [source-and-dependencies.md](source-and-dependencies.md).

## Closing the open findings

| Finding | PR | Status |
|---|---|---|
| [Escape discarded an AI reply whose save had failed](https://github.com/jmbost20/threadglyph/pull/7#discussion_r4143480136) | #7 / #8 | Fixed: Escape keeps an unsaved reply, and still cancels a request or closes an error |
| [Enter posted before the @-mention menu could pick](https://github.com/jmbost20/threadglyph/pull/7#discussion_r4143480329) | #7 / #8 | Moot: Enter now makes a new line, ⌘↩ posts, and the menu handles keys first |
| Custom filters lost keyboard focus on every change | #8 | Fixed |
| [Clicking a comment stopped Enter and the arrow keys from navigating](https://github.com/jmbost20/threadglyph/pull/9#discussion_r4143960839) | #9 | Fixed |
| [The lost-passage test could not fail](https://github.com/jmbost20/threadglyph/pull/9#discussion_r4145383712) | #9 | Fixed, and confirmed by breaking the code |
| [Dependabot could open Vitest majors that cannot install alone](https://github.com/jmbost20/threadglyph/pull/9#discussion_r4145621279) | #9 | Fixed: the Vitest packages are grouped |
