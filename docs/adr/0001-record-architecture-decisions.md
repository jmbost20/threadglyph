# 0001. Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-10-24

## Context

Threadglyph's early decisions were recorded in the agents' working log ([docs/dev/implementation-progress.md](../dev/implementation-progress.md)), mixed in with progress notes. With the project open to other contributors, the decisions that shape it need to be easy to find, and changes to them need a clear process.

## Decision

Significant decisions are recorded as short ADRs in `docs/adr/`, numbered in order, using [template.md](template.md). [README.md](README.md) says when one is needed. ADRs 0002–0004 record the decisions already in force.

## Consequences

- Contributors can see why the core rules exist before proposing to change them.
- A change to a core rule needs an ADR, which slows it down on purpose.
- The working log stays as the history; ADRs are the current rules.
