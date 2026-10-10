# circe-graph

A FalkorDB-backed memory + routing layer for Circe, built for the Graph Hacks hackathon. (`circe-src` reference at `~/.t3/scratch/2026-10-09-we-need-to-build-this-212e15ad/circe-src`.)

Circe turns a spoken request ("start a task in Rivvl to fix the login bug") into a route to one project on one machine. The reference implementation resolves the project against an **in-memory candidates array**. circe-graph replaces that array with **Cypher queries against FalkorDB** — and makes the graph the source of truth for both routing and memory. The deterministic grounding core (`groundVoiceTurn`) is copied byte-identical; the graph only supplies candidates and persists episodes.

```
heard utterance ──▶ heardWindows ──▶ FalkorDB (exact pass: title / learned alias)
                                         │ no exact match
                                         ▼
                                    FalkorDB (full bounded catalog)
                                         │
                                         ▼
                     groundVoiceTurn (copied core, byte-identical)
                                         │
                       resolved / clarified ──▶ write-back (:Utterance, :Episode:Memory)
                                         │
                                         ▼
                    { result, cypherPath }  ← the MATCH path that justified the route
```

## Graph schema

```
(:User)-[:SAID]->(:Utterance)-[:RESOLVED_TO]->(:Project)
(:Machine)-[:OWNS]->(:Project)-[:HAS]->(:Task)
(:Task)-[:LEARNED_ALIAS]->(:Alias)
(:Episode:Memory {text, ts})
```

Seeded catalog (`pnpm seed`):

```
(:Machine {name: "desktop",   connected: true}) ──OWNS──▶ (:Project {title: "Rivvl"})
      │                                                        │
      │                                                        └──HAS──▶ (:Task {title: "fix the login bug"})
      │                                                                        │
      │                                                                        └──LEARNED_ALIAS──▶ (:Alias {text: "rival"})

(:Machine {name: "laptop",    connected: true}) ──OWNS──▶ (:Project {title: "Portfolio"})
      │                                                        │
      │                                                        └──HAS──▶ (:Task {title: "polish the homepage"})

(:Machine {name: "build-box", connected: false}) ──OWNS──▶ (:Project {title: "Portfolio"})

(:Episode:Memory {text: "checked whether the login flow works in Rivvl", ts: "..."})
```

Write-back after a resolved or clarified turn:

```
(:User {id: "user-local"})-[:SAID]->(:Utterance {text, ts, status, heard, match})
                                          │
                                          └──[:RESOLVED_TO {match: "near"}]──▶ (:Project)

(:Episode:Memory {id, text, ts, status})
```

The catalog seeds two connected machines (desktop, laptop) and three projects. "Portfolio on build-box" needs a machine to own it, and that machine is deliberately the **disconnected** one the router must report instead of rerouting to laptop — so the seed adds build-box as a third machine node. Two connected machines, one disconnected, three projects.

## How a turn flows

1. **`heardWindows(utterance)`** — every normalized 1–4 word window of the utterance (`"start a task in rival"` yields `rival`, `task in rival`, …).
2. **Exact pass (Cypher)** — `src/catalog.ts` keeps only projects whose title or learned alias equals a window:
   `WHERE toLower(p.title) IN $windows OR any(alias IN aliasNames WHERE alias IN $windows)`.
3. **Fuzzy fallback (Cypher + core)** — when nothing matches exactly, the full bounded catalog comes back from the graph and `groundVoiceTurn`'s keystroke/pronunciation scoring decides (near match ≥ 0.8 spelling, confirmation, or clarification).
4. **`groundVoiceTurn`** — the copied core decides the route with byte-identical semantics. The graph never picks a match; it only supplies candidates.
5. **Write-back** — resolved turns link the `:Utterance` to the `:Project` with the match kind; clarified turns store the question and options. Pending confirmations and non-mentions are live conversation state, not memory: they write nothing.
6. **`cypherPath`** — the exact Cypher that ran, its rows, and the human-readable `(:Machine)-[:OWNS]->(:Project)` chain, so `/why` can explain any route after the fact.

## Quickstart

Needs Node 24 (runs `.ts` directly), pnpm, and Docker.

```sh
pnpm install
docker compose up -d        # FalkorDB on localhost:6379
pnpm seed                   # load the demo catalog
node demos/01-graph-grounding.ts
pnpm test                   # vitest: core + catalog + route (needs the container)
```

The demo prints all five routes with the Cypher path that justified each one:

```
2. near mishearing
You say:  "start a task in rival to fix the login bug"
Circe:    routes to Rivvl on desktop
          heard "rival" (near match)
          sends: "start a task in Rivvl to fix the login bug"
Cypher:   MATCH (m:Machine)-[:OWNS]->(p:Project) … WHERE toLower(p.title) IN $windows OR any(…)
          pass: exact · params: {"windows":["start","start a","… +32 more"]} · rows: 1
Path:     (:Machine {name: "desktop"})-[:OWNS]->(:Project {title: "Rivvl"})-[:HAS]->(:Task {title: "fix the login bug"})-[:LEARNED_ALIAS]->(:Alias {text: "rival"})   [matched learned alias "rival"]
```

Environment overrides: `CIRCE_GRAPH` (graph name, default `circe`), `FALKOR_HOST`, `FALKOR_PORT`. Tests use their own graphs (`circe_test_catalog`, `circe_test_route`) so they never touch demo data.

## The five routes

| You say | Route | Graph's role |
| --- | --- | --- |
| "start a task in Rivvl to fix the login bug" | Rivvl on desktop (exact match) | title window matched in Cypher |
| "start a task in rival to fix the login bug" | Rivvl on desktop (near match, 0.8 spelling) | learned alias `rival` narrowed the exact pass to Rivvl; the core scored the pronunciation |
| "I need you to check out Zivil." | asks "Did you mean Rivvl?" | no exact match → full catalog fallback; the core's Soundex tail matched, spelling said 0.6 < 0.8, so it asks |
| "Open Portfolio." | asks which Portfolio: laptop or build-box | Cypher returned both machine-owned copies; the core clarified with machine-qualified labels; build-box is flagged disconnected |
| "what is running right now" | no project named, nothing routed | fallback catalog still read; the core found no project slot, so nothing was written |

## What is new vs circe-core

| File | Origin |
| --- | --- |
| `src/groundVoiceTurn.ts` | byte-identical copy (sha256 matches `circe-src/packages/circe-core/src/groundVoiceTurn.ts`) |
| `src/projectChoice.ts` | byte-identical copy |
| `src/buildProjectVocabulary.ts` | copy; only the `@circe/contracts` import is replaced with local interface declarations (field names and semantics match the contracts) |
| `src/groundVoiceTurn.test.ts`, `src/projectChoice.test.ts` | copies; only the test-runner import changed to `vitest` |
| `src/buildProjectVocabulary.test.ts` | adapted: same two test intents, fixtures no longer use `effect`/`ProjectId` |
| `src/catalog.ts` | **new** — `getCandidates(heard)` via Cypher: exact pass, then catalog fallback |
| `src/route.ts` | **new** — `routeWithGraph(utterance)`: candidates → core → write-back → `{ result, cypherPath }` |
| `src/falkor.ts` | **new** — connection, graph naming, `runCypher` |
| `src/seedGraph.ts`, `seed.ts` | **new** — demo catalog |
| `src/catalog.test.ts`, `src/route.test.ts` | **new** — live-FalkorDB tests |
| `demos/01-graph-grounding.ts` | the reference demo with candidates from Cypher + path output |

## Design decisions

- **Learned aliases gate recall, not pronunciation labels.** A seeded alias (`rival → Rivvl`) narrows the exact Cypher pass, but candidate `names` stay canonical (`["Rivvl"]`), so `groundVoiceTurn` still reports the honest match kind (`near` at 0.8 spelling). The graph can never disagree with the core about what a name sounds like because fuzzy scoring exists in exactly one place.
- **The graph is the source of truth for routing, not a sidecar.** Every candidate decision — which projects exist, who owns them, which aliases were learned — is a Cypher query. There is no in-memory catalog to drift.
- **A disconnected machine is reported, never swapped.** Both Portfolios stay distinct candidates; the build-box copy carries `connected: false` from the graph, its clarification option is labeled `Portfolio on build-box`, and a route that targets it returns `disconnectedMachine` in the envelope (with the reason) instead of rerouting to laptop.
- **Minimal write-back.** Resolved and clarified turns produce `:Utterance` + `:Episode:Memory`. Confirmations that are still pending and non-mentions write nothing.
- **Statements run one at a time.** FalkorDB rejects multi-statement queries, so the seed is a statement list.

## Tests

`pnpm test` runs 38 tests:

- **Copied core** (from circe-core): all 22 `groundVoiceTurn` cases and 5 `projectChoice` cases, unchanged — the guarantee that graph-backed candidates didn't alter grounding semantics; plus 2 vocabulary cases.
- **`catalog`**: exact title match, learned-alias match, duplicate Portfolio across machines (both kept, build-box marked disconnected), catalog fallback, window normalization.
- **`route`**: exact route + write-back with `RESOLVED_TO` edge, near match at the 0.8 threshold via the alias path (`Zivil` at 0.6 asks instead), ambiguous Portfolio clarification with one option per machine, disconnected target reported and not swapped for its twin, non-mention writes nothing.

## Hackathon track mapping

- **Track 02 — primary: agent memory + routing.** The graph *is* the memory layer: projects, machines, tasks, learned aliases, utterance history, and episodes all live in FalkorDB, and the routing decision itself is a Cypher query. Memory is updated by the router (write-back) and immediately readable by the next turn (learned alias recall).
- **Track 01 — secondary: graph-native retrieval with traceable decisions.** Every route returns the exact Cypher and the `:Machine-[:OWNS]->:Project[-:HAS->:Task-:LEARNED_ALIAS->:Alias]` chain that produced it. Nothing is a black box: "/why this route" is a graph answer, not a guess.

## Limits (honest)

- One turn at a time: clarification answers to the graph are not wired yet (`resolveCirceProjectChoice` is copied but unused by the demo).
- New learned aliases are seeded, not created at runtime; without an alias, a mishearing still resolves through the core's fuzzy pass with a margin, sometimes a confirmation.
- The fuzzy fallback reads the whole catalog per turn. That is correct and bounded for this scale; a larger catalog would push more of the blocking (initial letter, Soundex tail) into Cypher.
- Single graph per process (`CIRCE_GRAPH`); no multi-tenancy.
