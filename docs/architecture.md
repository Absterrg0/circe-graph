# Architecture and operating notes

## Routing

`src/catalog.ts` reads Machine → Project → Alias rows from FalkorDB. Candidate selection uses the same project-slot parser as `groundVoiceTurn`, so names in later task prose cannot narrow an earlier project slot. The exact pass checks title and alias windows inside that slot. With no match, the full catalog reaches the pronunciation scorer.

`src/groundVoiceTurn.ts` and `src/projectChoice.ts` originate in Circe's core. Grounding exports its slot parser and task-domain vocabulary so the graph wrapper can reuse them. The scoring rules remain unchanged, but this file is no longer byte-identical to upstream. `buildProjectVocabulary.ts` uses local declarations in place of upstream contract imports.

The router reads memory before recording a resolved turn. An alias marked `hint` gates recall but is absent from the candidate's names, preserving the near-match threshold. A `confirmed` alias joins the names. Machine availability stays attached to the selected project; choosing an offline copy returns `disconnectedMachine`.

`routeWithGraph` returns `result`, `outcome`, `cypherPath`, and recalled `memory`, with optional `learned`, `learningRefused`, `lastMeant`, and `unmatchedName` fields. `cypherPath` includes the candidate query, parameters, rows, and human-readable paths. Question-tool answers carry `cypher`, `params`, `rows`, `paths`, `summary`, and `outcome`.

## Writes and concurrency

Resolved routes match the target project before creating the utterance or episode. If a target vanishes before the write, the query produces no rows and the router throws without creating an orphan turn. Clarification answers use the same ordering.

Every resolved turn creates an utterance linked by `RESOLVED_TO` and an Episode:Memory linked by `ABOUT`. A clarification question creates only the utterance and offered options. An answer creates a resolved episode and updates Heard → LAST_MEANT → Project. Ambiguity is preserved; precedent is displayed, never silently applied.

Alias nodes are keyed by project ID and normalized text. Learning checks normalized titles and existing aliases for collisions, then checks alias ownership again inside the graph write. The latter check closes the gap between a probe and a competing client's confirmation. Tests exercise simultaneous calls in one process and independent processes. An existing title confirmation is a no-op. Missing projects or teaching utterances fail rather than reporting an alias that was never learned.

Turn recording and alias learning are separate statements. An interruption between them may record a resolved turn without learning the alias. Retrying can create another episode. There is no transaction spanning a whole conversation and no request-id deduplication.

## MCP and the terminal

`mcp/server.ts` implements newline-delimited JSON-RPC 2.0 over stdio. It negotiates `2024-11-05` and `2025-06-18`, rejects batches and malformed envelopes, validates argument containers, and returns tool failures as `isError`. Logs belong on stderr; stdout contains protocol responses only.

The server is stateless about pending conversations. Hosts retain the original utterance and send it to `confirm_route` or `answer_clarification`. Each follow-up re-grounds against current graph data. A changed catalog can invalidate the previous choice. The host must obtain the user's answer before calling a follow-up tool.

`mcp/client.ts` is the small stdio transport used by `pnpm chat` and `pnpm demo:mcp`. The terminal runs a human-directed conversation; the scripted demo checks the same tools through separate server processes. Neither requires an LLM provider. The optional `pnpm demo:agent` run starts a real Codex CLI host with only this MCP service configured. Four independent agent and server processes demonstrate an unconfirmed request, explicit confirmation, fresh-process recall, and an offline-machine question. `demos/audit-proxy.ts` transparently records requests and responses in front of the ordinary `mcp/server.ts`; it does not synthesize responses. Assertions inspect those recorded tool results, and the run fails if a required tool was never actually called. User replies are a predefined synthetic scenario. This run requires a signed-in CLI and uses model account allowance, so it is separate from CI.

`pnpm demo:record` serves a loopback-only page that streams a new live run for screen recording. The published working-demo video captures that page while the model and MCP service run. The illustrated video remains a separate artifact. The raw audit and summary accompany the working video. MCP tool annotations distinguish read-only question tools from additive memory writes; they are descriptive hints and do not replace host permissions.

All result text is untrusted, including recalled user speech. Read tools use `roQuery`, which rejects writes at the database boundary. First access to a new graph may initialize its empty key with `RETURN 1`; it creates no domain records.

## Configuration

Optional settings load from the repository's `.env`. Exported environment variables take precedence. Start a new process after changing connection settings.

- `CIRCE_GRAPH` selects a graph, default `circe`. It overrides the tenant setting.
- `CIRCE_TENANT` selects `circe:<tenant>` when no explicit graph is set.
- `FALKOR_URL` supplies a full connection URL and overrides host/port. Use `rediss://` for TLS.
- `FALKOR_HOST` and `FALKOR_PORT` default to `localhost` and `6379`.
- `FALKOR_TLS=1` enables TLS with host/port settings.

Graph separation is a storage boundary selected by the trusted process environment, not an authentication system. The service uses one local user identity. Do not expose an unauthenticated database or give an untrusted caller control of graph selection.

`src/falkor.ts` shares a pending connection promise so parallel first callers cannot open untracked sockets. `closeGraph` also awaits an in-flight connection. Each selected graph is named explicitly. Compose binds database and Browser ports to loopback and persists data in its named volume. `pnpm db:down` preserves that volume.

The first three demos and `pnpm seed` reset their selected graph to sample data. `pnpm demo:mcp` always resets its own `circe_mcp_demo` graph. Tests use `circe_test_*` graphs and seed each integration case independently. The tests need a writable FalkorDB database.

## Current limits

The fallback reads the full catalog; there is no large-catalog query budget. The exact query's lowercase comparison is less aggressive than the core's punctuation and Unicode normalization. A spelling with punctuation can take the fallback path. Utterances and episodes accumulate without retention or pruning. Alias learning follows explicit confirmation; machine clarification replies update precedent without becoming pronunciation aliases.

Blast radius reports stored graph relationships and same-title copies. It does not prove two workspaces have identical contents, move work, or execute tasks. Runtime machine status is seeded data until a host supplies updates. A main-app integration should provide live project and machine ingestion, user identities, retention controls, and request deduplication.
