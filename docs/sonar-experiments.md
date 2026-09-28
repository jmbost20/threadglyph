# Sonar and review-tool experiments

Each entry records: **problem → tool feedback → decision → changed behavior → verification → remaining limitation.** Unavailable or untested tools are marked as such, not as passing.

## Tool status

| Tool | Status | Evidence |
|---|---|---|
| SonarQube Cloud (CI analysis, coverage import) | Configured in repo, **not yet connected** | `sonar-project.properties` and the `sonar` CI job exist. Needs the owner to create/import the project and add the `SONAR_TOKEN` secret. |
| Gitar (PR review) | **Not yet installed** | Needs the owner to install the GitHub App on this repo only. |
| SonarQube for IDE | Not exercised | No IDE session used so far. |
| SonarQube CLI / Vortex | Not exercised | Waiting for a Cloud baseline. |
| SonarQube MCP Server | Not exercised | Waiting for a Cloud baseline. |
| AI CodeFix / Remediation Agent | Not exercised | Needs a real finding first. |
| Advanced Security | Not exercised | Entitlement unknown. |

## Experiments

_None yet._
