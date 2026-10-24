# Development logs

Threadglyph was built with AI coding agents (OpenAI Codex and Anthropic Claude Code) working under the rules in [`AGENTS.md`](../../AGENTS.md). Every pull request was reviewed by [Gitar](https://gitar.ai) and analysed by [SonarQube Cloud](https://sonarcloud.io) in CI. The files here are the working logs from that process, kept as they were written. "The owner" in them means the maintainer.

| File | What it holds |
|---|---|
| [`implementation-progress.md`](implementation-progress.md) | Stage-by-stage decisions, acceptance criteria, PR links and known limits. |
| [`sonar-experiments.md`](sonar-experiments.md) | Each Gitar and Sonar finding: the problem, the tool's feedback, the decision, the fix, and the test that proves it. |
| [`pilot.md`](pilot.md) | The pilot package, install and rollback steps, and the manual test script. |

For the curated summary, start with [How Gitar and SonarQube reviewed Threadglyph](../gitar-and-sonar.md). Other docs live one level up: [`architecture.md`](../architecture.md), [`compatibility.md`](../compatibility.md), [`roadmap.md`](../roadmap.md) and [`source-and-dependencies.md`](../source-and-dependencies.md).
