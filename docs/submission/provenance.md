# Project provenance and eligibility

Status on October 17, 2026: organizer eligibility confirmation is pending. This document records the repository's existing history. It does not establish eligibility.

The [published Graph Hacks rules](https://www.wemakedevs.org/hackathons/falkordb/rules) say main coding and design must begin after October 15, 2026 at 12:01 AM IST. General libraries, templates, and infrastructure may be reused. The event FAQ says the submission and its main FalkorDB implementation must be new work completed during the event.

## Before the event

Commit [`bf37481`](https://github.com/Absterrg0/circe-graph/commit/bf37481f6d0e01622b2dede298faecbcef157aa6), authored and committed October 11, 2026 at 01:17:41 IST, contains an implementation, not only planning notes:

- FalkorDB connection and seeded graph.
- Graph-backed project candidate lookup and routing.
- Utterance and episode writes and path explanations.
- A CLI demo and live-database tests.
- Grounding and project-choice code reused from the existing Circe project.

We are disclosing this work as pre-event implementation. Its presence creates an eligibility question under the published rules.

## During the event

The repository records these October 15 commits:

- `21d276d`: learning across sessions, typed outcomes, project memory, fixed question tools, and an MCP endpoint.
- `fcd9362`: pinned database image, local deployment setup, CI, license, and environment template.
- `e297b05`: corrections to learning, write verification, outcome labels, and trust metadata.
- `1b1173c` and `d6468d0`: graph screenshots and the illustrated walkthrough.

October 16–17 work adds the MCP confirmation and clarification flow, regression fixes, concurrent-client tests, independent test fixtures, a terminal MCP client, process-restart evidence, and submission documentation. The final commits preserve the earlier history.

These additions do not retroactively make the October 11 implementation new event work. Only the organizers can decide whether the event changes are eligible for judging.

## AI assistance and participant responsibility

AI coding assistants implemented and reviewed code under the participant's direction, ran live-database tests, and prepared documentation and demo materials. The participant is responsible for checking the result and explaining the graph model, queries, architecture, and decisions. This disclosure does not claim any unverified level of participant review or understanding.

## Reproduce the timeline

```sh
git log --reverse --format='%h %aI %cI %s'
git show --stat bf37481
git diff --stat bf37481..HEAD
```
