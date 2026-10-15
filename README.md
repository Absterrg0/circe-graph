# circe-graph

**A voice-driven multi-machine coding agent whose routing, memory, and reasoning all live in one FalkorDB graph** — built for the Graph Hacks hackathon (Track 2: Agent Memory and Coordination; Track 1: Agents That Act on Connected Data).

Circe turns a spoken request ("start a task in Rivvl to fix the login bug") into a route to one project on one machine. The reference implementation resolves the project against an **in-memory candidates array** and forgets everything on restart. circe-graph replaces that array with **Cypher queries against FalkorDB** and makes the graph the source of truth for four things at once:

1. **Routing** — candidates come from Cypher, never from a sidecar cache.
2. **Memory** — episodes, learned aliases, and clarification answers are graph structure, read *before* the agent reasons and written *after* it acts.
3. **Learning** — confirm a mishearing once and it becomes a confirmed alias; the next session resolves the same words outright. The graph gets better at its job.
4. **Reasoning** — a fixed catalogue of validated graph questions (blast radius, what's running, project history, why a word means a project) exposed over MCP.

The deterministic grounding core (`groundVoiceTurn`, `projectChoice`) is copied byte-identical: the graph feeds the core and remembers what happened; it never second-guesses pronunciation.

## Why this wins (judging criteria, mapped)

| What judges look for | How this repo demonstrates it |
| --- | --- |
| **The graph does work the agent could not do without it** | Run `pnpm demo:memory`: session A only earns "Did you mean Rivvl?"; after one confirmation the answer is a `(:Project)-[:LEARNED_ALIAS]->(:Alias)` with `(:Utterance)-[:TAUGHT]->(:Alias)` provenance. Session B — same words, fresh process — is `answered_from_memory`. Delete the graph and the agent is back to guessing. |
| **The same question twice, with depth** | `pnpm demo:ask` case 3–4: `machine_blast_radius(depth: 1)` says which project stops; `depth: 2` adds which task stops. One parameter, the graph changes the answer's scope — not a prompt. |
| **"Not in the graph" is a distinct answer** | Six typed outcomes, never conflated: `answered_with_path`, `answered_from_memory`, `needs_confirmation`, `needs_clarification`, `not_in_graph` (name heard, nothing matches it), `no_project_named`. The demo prints the outcome for every turn. |
| **Every answer carries its path** | Every route and every tool answer returns the human-readable MATCH chain (`(:Machine)-[:OWNS]->(:Project)-[:LEARNED_ALIAS]->(:Alias) [matched …]`) plus the exact Cypher and its parameters. `/why` is a graph fact, not a retelling. |
| **Fixed tool catalogue, no model-written Cypher** | Five reviewed tools (`route_request`, `whats_running`, `machine_blast_radius`, `project_history`, `why_heard`) with named parameters, JSON schemas, and argument validation against the graph — served over a zero-dependency MCP stdio server (`node mcp/server.ts`). |
| **Name resolution before reasoning** | The router resolves names against the graph (exact windows → core scoring → confirmation/clarification); the ask tools resolve machines, projects, and aliases against the graph first, and return `unknown_name` / `ambiguous_name` instead of a confident wrong answer. A typo can't become a wrong action. |
| **Memory is more nodes, connected** | Episodes are `(:Episode:Memory)-[:ABOUT]->(:Project)`; clarification answers are `(:Heard {text})-[:LAST_MEANT]->(:Project)`; confirmations are aliases with teaching provenance. Memory is read first (`memory` on every route), then extended. |

## Architecture

```
heard utterance ──▶ heardWindows ──▶ FalkorDB (exact pass: title / learned alias)
                                         │ no exact match
                                         ▼
                                    FalkorDB (full bounded catalog)
                                         │
                                         ▼
                     groundVoiceTurn (copied core, byte-identical)
                                         │
              ┌──────────────────────────┼──────────────────────────────┐
              ▼                          ▼                              ▼
   resolved / clarified         needs-confirmation              needs-clarification
   → write :Utterance,          → write nothing (live state)    → write question;
     :Episode -[:ABOUT]->                                         offer machine-qualified
     :Project                                                     options + last-meant hint
              │                          │                              │
              │              confirmed?  │                              │ answered via
              │◀── route.learned ────────┘                              │ projectChoice?
              │   (:Alias "zivil", kind: "confirmed")                    ▼
              │   (:Utterance)-[:TAUGHT]->(:Alias)               :Utterance, :Episode,
              ▼                                                   (:Heard)-[:LAST_MEANT]->
   { outcome, result, cypherPath, memory, … }                     (:Project)
```

## Graph schema

```
(:User)-[:SAID]->(:Utterance)-[:RESOLVED_TO {match}]->(:Project)
(:Utterance)-[:TAUGHT]->(:Alias)                       -- provenance: what taught this word
(:Machine)-[:OWNS]->(:Project)-[:HAS]->(:Task)
(:Project)-[:LEARNED_ALIAS {source, ts}]->(:Alias {text, kind})
(:Episode:Memory {text, ts, status})-[:ABOUT]->(:Project)
(:Heard {text})-[:LAST_MEANT {ts}]->(:Project)
```

**Alias kinds are memory strength**: a `hint` (heard once, never confirmed) gates candidate recall but never joins a project's `names`, so the core still reports an honest near match; a `confirmed` alias (the user said "yes, that's what I meant") joins `names` and makes every future session resolve it outright.

Seeded catalog (`pnpm seed`):

```
(:Machine {name: "desktop",   connected: true}) ──OWNS──▶ (:Project "Rivvl") ──HAS──▶ (:Task "fix the login bug", queued)
                                                                ▲                          (:Episode "checked whether the login flow works…")
                                                                │                          (:Episode "started fixing the login redirect…")
                                                    (:Alias "rival", kind: "hint")  ◀──LEARNED_ALIAS──┘

(:Machine {name: "laptop",    connected: true}) ──OWNS──▶ (:Project "Portfolio") ──HAS──▶ (:Task "polish the homepage", running)
                                                                                             (:Episode "reviewed the portfolio homepage copy")

(:Machine {name: "build-box", connected: false}) ──OWNS──▶ (:Project "Portfolio") ──HAS──▶ (:Task "refresh the portfolio theme", queued)
```

Three machines, three projects (Portfolio exists twice — that is what forces clarification), three tasks, one hint alias, three episodes. build-box is deliberately the **disconnected** machine the router must report instead of rerouting to laptop's copy of Portfolio.

## The six answer shapes

| Outcome | Meaning | Written back? |
| --- | --- | --- |
| `answered_with_path` | Resolved — exact, near ≥ 0.8, or confirmed-pronunciation this turn | yes: utterance + episode ABOUT project |
| `answered_from_memory` | Resolved because a **confirmed alias** from a previous session matched | yes: utterance + episode |
| `needs_confirmation` | Phonetics found a plausible target but spelling is below threshold | no — live conversation state |
| `needs_clarification` | A real ambiguity (duplicate title); machine-qualified options offered, last-meant hint shown | question + options |
| `not_in_graph` | A name was heard but nothing in the graph matches it ("In Javis, …") | as a clarification question |
| `no_project_named` | No project slot at all ("what is running right now") | nothing |

Clarification **answers** are resolutions: `answerClarification(utterance, answer)` uses the copied `projectChoice` matcher (machine names like "laptop" are legitimate disambiguation vocabulary there) and writes `:Utterance -[:RESOLVED_TO]-> :Project`, an episode `-[:ABOUT]->` the project, and `(:Heard {text})-[:LAST_MEANT]->(:Project)`. The next identical ask still asks — ambiguity is a fact, not a cache miss — but shows the user their own precedent.

## Quickstart

Needs Node 24 (runs `.ts` directly), pnpm, and Docker.

```sh
pnpm install
docker compose up -d        # FalkorDB on localhost:6379 + Browser on localhost:3000
pnpm seed                   # load the demo catalog

pnpm demo                   # 1 · grounding: five routes, each with its Cypher path
pnpm demo:memory            # 2 · the graph learns across sessions (the money demo)
pnpm demo:ask               # 3 · the tool catalogue: blast radius, memory, why-heard, MCP
pnpm test                   # 52 tests against live FalkorDB (own graphs, never demo data)
```

All three demos reset the graph to the seed first, so their output is deterministic and reproducible. Open **http://localhost:3000** (FalkorDB Browser, ships in the same container) and select the graph `circe` to watch the demos' writes appear live.

### The five routes (`pnpm demo`)

| You say | Route | Graph's role |
| --- | --- | --- |
| "start a task in Rivvl to fix the login bug" | Rivvl on desktop (exact) | title window matched in Cypher; two seeded episodes returned as memory |
| "start a task in rival to fix the login bug" | Rivvl on desktop (near, 0.8 spelling) | hint alias `rival` narrowed the exact pass; the core scored the pronunciation honestly |
| "I need you to check out Zivil." | asks "Did you mean Rivvl?" | no alias for `zivil` yet → full catalog; Soundex tail matched, spelling 0.6 < 0.8 → asks |
| "Open Portfolio." | asks which Portfolio | both machine-owned copies returned, build-box flagged disconnected |
| "what is running right now" | nothing routed | the core found no project slot; nothing written |

### The memory demo (`pnpm demo:memory`)

1. Session A: "check out Zivil" → `needs_confirmation`. User says yes.
2. The graph learns: `(:Project "Rivvl")-[:LEARNED_ALIAS]->(:Alias {text: "zivil", kind: "confirmed"})` and `(:Utterance "I need you to check out Zivil.")-[:TAUGHT]->(:Alias)`. The `learned` field in the route envelope reports it.
3. Session B (fresh call, same words) → `answered_from_memory`, no question asked, path shows the alias and marker `(answered from memory)`.
4. "Open Portfolio." → asks; answer "laptop" → resolved via `projectChoice`, remembered as `LAST_MEANT`. The next identical ask still asks, and adds "Last time: you meant Portfolio on laptop".
5. A later route to Rivvl returns the episodes the graph already held — memory read before reasoning.

## The fixed tool catalogue

`src/ask.ts` — hand-written Cypher, named parameters, arguments resolved against the graph before anything runs. Reads go through FalkorDB's read-only API (`roQuery`), so a tool bug cannot mutate the graph.

| Tool | Question | Graph shape it uses | Outcomes |
| --- | --- | --- | --- |
| `whats_running` (`state?`) | What's in flight? | `(Machine)-[:OWNS]->(Project)-[:HAS]->(Task)` | `answered_with_path` |
| `machine_blast_radius` (`machine`, `depth?` 1–2) | If this machine goes down, what stops? | `(Machine)-[:OWNS\|HAS*1..depth]->(x)`, plus same-title mirrors on other machines | `answered_with_path`, `unknown_name`, `not_in_graph` (owns nothing) |
| `project_history` (`project`, `machine?`, `limit?`) | What do we already know about this project? | `(:Episode:Memory)-[:ABOUT]->(:Project)` | `answered_from_memory`, `not_in_graph` (no episodes yet), `ambiguous_name`, `unknown_name` |
| `why_heard` (`text`) | Why does this word mean a project? | `(:Project)-[:LEARNED_ALIAS]->(:Alias)`, `(:Utterance)-[:TAUGHT]->(:Alias)` | `answered_with_path` (hint), `answered_from_memory` (confirmed), `unknown_name` |

Every answer carries `outcome`, `summary` (assembled from rows, not a model), `rows`, `paths`, and the exact `cypher`. A machine that goes down is reported with mirrors — **never silently moved**.

### Over MCP

`node mcp/server.ts` speaks JSON-RPC 2.0 / MCP 2024-11-05 over stdio with zero dependencies. Any MCP host (Claude Desktop, Cursor, an agent runtime) gets all five tools:

```json
→ {"jsonrpc":"2.0","id":1,"method":"tools/call",
   "params":{"name":"machine_blast_radius","arguments":{"machine":"build-box","depth":2}}}
← {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text",
   "text":"{ \"outcome\": \"answered_with_path\", \"summary\": \"If \\\"build-box\\\" goes down: …\" }"}],
   "isError":false}}
```

Memory written by one client is the memory every other client reads: the graph is the coordination surface.

## What is new vs circe-core

| File | Origin |
| --- | --- |
| `src/groundVoiceTurn.ts`, `src/projectChoice.ts` | byte-identical copies (sha256 match `circe-src/packages/circe-core/src/`) |
| `src/buildProjectVocabulary.ts` | copy; only the `@circe/contracts` import replaced with local interface declarations |
| `src/groundVoiceTurn.test.ts`, `src/projectChoice.test.ts` | copies; only the test-runner import changed to `vitest` |
| `src/buildProjectVocabulary.test.ts` | adapted; fixtures no longer use `effect`/`ProjectId` |
| `src/catalog.ts` | **new** — `getCandidates(heard)` via Cypher: exact pass, then catalog fallback; alias kinds steer evidence |
| `src/route.ts` | **new** — `routeWithGraph`, `confirmRoute`, `answerClarification`: candidates → core → memory read → write-back → learning → typed outcome |
| `src/ask.ts` | **new** — the fixed tool catalogue with argument validation and typed outcomes |
| `mcp/server.ts` | **new** — zero-dependency MCP stdio server |
| `src/falkor.ts` | **new** — connection, tenant-aware graph naming, `runCypher` / `runRead` |
| `src/seedGraph.ts`, `seed.ts` | **new** — the demo catalog |
| `src/catalog.test.ts`, `src/route.test.ts`, `src/ask.test.ts`, `mcp/server.test.ts` | **new** — live-FalkorDB tests |
| `demos/01-…`, `demos/02-…`, `demos/03-…` | **new** — grounding, memory-across-sessions, tool-catalogue demos |

## Design decisions

- **The core decides pronunciation; the graph decides everything else.** Fuzzy scoring lives in exactly one place (the copied core), so the graph can never disagree with it about what a name sounds like. The graph's job is recall, memory, persistence, and reasoning.
- **Hints vs confirmed aliases.** A hint narrows recall but never becomes a `name` (so "rival" honestly reports `near`); a confirmed alias joins `names` (so "zivil" resolves as `confirmed-pronunciation`). The difference is the user's own confirmation — the graph stores *evidence strength*, not just facts.
- **Learning happens at the confirmation seam.** `confirmRoute` persists the turn and teaches the graph one alias with provenance (`TAUGHT`). A confirmation of a canonical title teaches nothing (guarded).
- **Ambiguity is never cached away.** `LAST_MEANT` is shown, not applied: the router still asks.
- **A disconnected machine is reported, never swapped.** Both Portfolios stay distinct; the build-box copy carries `connected: false`; a route targeting it returns `disconnectedMachine` (with reason) instead of rerouting to laptop.
- **Only settled facts are written.** Resolved and clarified turns produce utterances/episodes; answered clarifications add `LAST_MEANT`; pending confirmations and non-mentions write nothing.
- **Reads are read-only.** Catalog lookups, recall, and every tool query go through `roQuery`.
- **Statements run one at a time.** FalkorDB rejects multi-statement queries, so the seed is a statement list.

## Tests

`pnpm test` runs **52 tests** against a live FalkorDB on separate graphs (`circe_test_catalog`, `circe_test_route`, `circe_test_ask`, `circe_test_mcp`):

- **Copied core**: all `groundVoiceTurn`, `projectChoice`, and vocabulary cases, unchanged — the guarantee that graph-backed candidates didn't alter grounding semantics.
- **`catalog`**: exact title match; hint alias gates recall without joining `names`; confirmed alias joins `names`; duplicate Portfolio across machines (both kept, build-box marked disconnected); catalog fallback.
- **`route`**: exact route + write-back + memory read; near ≥ 0.8 via hint alias (Zivil at 0.6 asks); duplicate-title clarification; disconnected target reported, not swapped; `not_in_graph` classification ("In Javis, …"); clarification answered via `projectChoice`, `LAST_MEANT` persisted, repeat ask still asks but carries precedent; non-mention writes nothing; **learning**: confirm `zivil` → alias + `TAUGHT` provenance → next session `answered_from_memory`.
- **`ask`**: traversal paths; depth 1 vs 2 scope change; mirrors reported; `unknown_name` / `ambiguous_name` / `not_in_graph`; argument validation; fixed catalogue shape.
- **`mcp`**: initialize / tools/list / tools/call round trips, unknown methods (`-32601`), parse errors (`-32700`), notifications get no response.

## Environment & deployment

| Variable | Effect |
| --- | --- |
| `CIRCE_GRAPH` | Graph name (default `circe`). Tests override it to their own graphs. |
| `CIRCE_TENANT` | Tenant isolation: selects graph `circe:<tenant>` — one tenant per graph, so a `WHERE` clause nobody can forget is never the isolation boundary. |
| `FALKOR_HOST`, `FALKOR_PORT` | FalkorDB connection (default `localhost:6379`). |

Point `FALKOR_HOST/PORT` at a FalkorDB Cloud instance (with TLS env as needed) and the same code runs against a hosted graph; the Browser ships with the local container at `localhost:3000`.

## Limits (honest)

- Clarification answers are wired (`answerClarification`), but a host must pass the pending utterance back — there is no long-lived session store beyond the graph.
- Alias learning happens at confirmations of mishearings; it does not (yet) learn from clarification answers ("laptop" is remembered as `LAST_MEANT`, not as an alias of a machine).
- The fuzzy fallback reads the whole bounded catalog per turn; a larger catalog would push more blocking (initial letter, Soundex tail) into Cypher.
- `machine_blast_radius` depth is capped at 2 because the seeded graph is Machine→Project→Task; the traversal generalizes but the demo graph is deliberately small.
