# GitHub setup

Repository settings that live on GitHub rather than in files, as `gh` commands a maintainer can run. Each step says whether it works while the repository is private.

## Labels (works while private)

```sh
gh label create "good first issue" --color 7057ff --description "Small, well-described, a good start" --force
gh label create "help wanted"      --color 008672 --description "Open for anyone to pick up" --force
gh label create "bug"              --color d73a4a --description "Something doesn't work" --force
gh label create "enhancement"      --color a2eeef --description "New feature or improvement" --force
gh label create "documentation"    --color 0075ca --description "Docs only" --force
gh label create "question"         --color d876e3 --description "Better as a Discussion" --force
gh label create "needs repro"      --color fbca04 --description "Needs steps that show it, with made-up text" --force
gh label create "needs decision"   --color b60205 --description "Waiting on the maintainer, or an ADR" --force
gh label create "area: ai"         --color c5def5 --description "Ask AI, assistants, previews" --force
gh label create "area: anchors"    --color c5def5 --description "Finding passages again" --force
gh label create "area: panel"      --color c5def5 --description "Thread panel and keyboard" --force
gh label create "area: storage"    --color c5def5 --description "Thread and anchor files, backup" --force
gh label create "platform: windows" --color ededed --description "Windows-specific" --force
gh label create "dependencies"     --color 0366d6 --description "Dependency updates" --force
```

## Seed issues (works while private)

Five starter issues. The first three are labelled `good first issue`.

```sh
gh issue create --label "good first issue" --label "area: panel" \
  --title "Use an Obsidian dialog instead of confirm() when discarding unsaved text" \
  --body "Two places in src/ui/ThreadPanel.ts call the browser's window.confirm() before throwing away unsaved text (lint warns about both). Replace them with a small Obsidian Modal, like ConfirmDeleteModal in src/ui/modals.ts: Discard and Keep editing buttons, focus on Keep editing, Escape keeps the text. Update the tests that spy on window.confirm (tests/threadPanel.test.ts)."

gh issue create --label "good first issue" --label "area: panel" \
  --title "Remove two unused CSS classes" \
  --body "styles.css styles .tg-delete-comment and .tg-icon-button, but no code uses them any more. Remove the rules, and check the panel still looks the same in the sandbox (npm run sandbox)."

gh issue create --label "good first issue" --label "area: ai" \
  --title "Check the Ollama address in settings" \
  --body "Settings → Threadglyph → Ollama address accepts any text. When it doesn't parse as an http(s) URL, show a short note under the field and keep the last good value. src/ai/ollama.ts already parses the address to name its host; reuse that. Add a test."

gh issue create --label "help wanted" --label "enhancement" \
  --title "Copy a thread as Markdown" \
  --body "A small first step towards exporting threads: a 'Copy as Markdown' action on a thread card that puts the passage (as a quote) and the messages, with authors and dates, on the clipboard. AI messages keep their 'AI' label. Nothing is written to the vault."

gh issue create --label "help wanted" --label "platform: windows" \
  --title "Check Threadglyph on Windows" \
  --body "CI runs the tests on Windows, but nobody has tried the plugin in Obsidian on Windows yet. Install a release with BRAT in a test vault, run the checklist in docs/dev/pilot.md (the AI steps can be skipped), and report what differs."
```

## Discussions (works while private)

```sh
gh api -X PATCH repos/jmbost20/threadglyph -f has_discussions=true
```

Then, in **Discussions**, keep the default categories (Announcements, General, Ideas, Q&A, Show and tell). The issue chooser already sends questions there.

## all-contributors app (works while private)

Install [all-contributors](https://github.com/apps/allcontributors/installation/new) on this repository only. It reads `.all-contributorsrc` and updates the README's contributor list by pull request.

## Sponsors

`.github/FUNDING.yml` points at GitHub Sponsors for `jmbost20`. Set up a Sponsors profile before the repository goes public, or change the file to another link.

## After the repository is public

These are paid features on private repositories.

1. **Secret scanning and push protection:**
   ```sh
   gh api -X PATCH repos/jmbost20/threadglyph \
     -F "security_and_analysis[secret_scanning][status]=enabled" \
     -F "security_and_analysis[secret_scanning_push_protection][status]=enabled"
   ```
2. **Private vulnerability reporting** (SECURITY.md offers it beside email; until it is on, reports come by email):
   ```sh
   gh api -X PUT repos/jmbost20/threadglyph/private-vulnerability-reporting
   ```
3. **Make the SonarQube Cloud project public** (on sonarcloud.io), then let CI wait for its quality gate:
   ```sh
   gh variable set SONAR_WAIT_FOR_GATE --body true
   ```
4. **Branch protection on `main`:** pull requests only, one approving review, the CODEOWNERS review, and these checks required: *Typecheck, lint, test, build*, *Tests on windows-latest*, *Tests on macos-latest*, *SonarQube Cloud*, *Commits are signed off*, *CodeQL*.
   ```sh
   gh api -X PUT repos/jmbost20/threadglyph/branches/main/protection --input - <<'JSON'
   {
     "required_status_checks": { "strict": true, "contexts": [
       "Typecheck, lint, test, build", "Tests on windows-latest", "Tests on macos-latest",
       "SonarQube Cloud", "Commits are signed off", "Analyze (javascript-typescript)" ] },
     "enforce_admins": false,
     "required_pull_request_reviews": { "required_approving_review_count": 1, "require_code_owner_reviews": true },
     "restrictions": null,
     "allow_force_pushes": false,
     "allow_deletions": false
   }
   JSON
   ```
   With one maintainer, `enforce_admins: false` lets the maintainer merge their own pull requests; turn it on once there is a second reviewer.
5. **Docs site:** Settings → Pages → Deploy from a branch → `main`, `/docs`. It publishes at `https://jmbost20.github.io/threadglyph/`.
6. **Community Standards:** Insights → Community Standards should then show every item checked.
7. **Check the README badges** (CI, Quality Gate, Coverage, Scorecard, Release) all render.
