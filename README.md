# circe-graph

Persistent project routing and memory for coding agents, backed by FalkorDB. Intended for Graph Hacks Track 2, Agent Memory and Coordination.

Eligibility clarification is pending: the first FalkorDB prototype predates the event. See the [disclosed timeline](docs/submission/provenance.md) and [organizer clarification draft](docs/submission/organizer-clarification.md).

Say "Open Zivil." The router asks "Did you mean Rivvl?" Confirm once, restart the server, and the same request resolves from a confirmed alias in the graph. Every answer includes the path and query behind it. Two projects called Portfolio remain separate, with a machine-qualified clarification instead of a guess.

[Watch the final 1:58 captioned demo on YouTube](https://youtu.be/JK3wnJ07rgs), built around a fresh, continuous live coding-agent capture. The [original MP4](docs/final-demo.mp4) and [video evidence](docs/evidence/final-video.md) include the raw recording, model logs and actual MCP traffic, and explain the added titles and captions. A real Codex agent chooses the tools, a user confirmation teaches the graph, and a fresh agent process recalls the alias. User inputs are a predefined synthetic scenario; tool calls and model responses are generated live.

The [earlier unedited agent recording](docs/agent-demo.mp4) is also available, with [its run summary](docs/evidence/agent-demo.json) and [MCP traffic](docs/evidence/agent-demo-mcp.jsonl).

The [90-second illustrated walkthrough](docs/demo.mp4) is supplementary. Its terminal sequence is an edited reconstruction.

## Run it

Requires Node 24+, pnpm 10, and Docker.

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm seed
pnpm chat
```

Try this conversation in the terminal:

```text
You > Open Zivil.
Circe > Asks: Did you mean Rivvl?
You > yes
Circe > Routes to Rivvl on desktop.
  Learned pronunciation: zivil.
You > Open Zivil.
  answered_from_memory
You > Open Portfolio.
Circe > Asks which copy: build-box or laptop.
You > laptop
Circe > Selected Portfolio on laptop.
You > /blast build-box
```

`/running` lists running and queued tasks. `/why zivil` explains the alias and its teaching utterance. `/history Rivvl` recalls recent episodes. `/cancel` clears a pending question; `/quit` exits. The terminal is a deterministic MCP client; it does not call an LLM or execute coding tasks.

Open http://localhost:3000 and select `circe` in FalkorDB Browser to inspect the graph. `pnpm seed` and the first three demos reset the selected graph to sample data. `pnpm chat` preserves it.

## A three-minute demonstration

```sh
pnpm demo:mcp
```

This assertion-backed demo starts the actual MCP stdio server and demonstrates:

1. "Open Zivil, then fix Portfolio." asks about Rivvl. The later task text does not hide the intended target.
2. A confirmation learns `zivil`, with an edge to the utterance that taught it.
3. The server exits. A new server process resolves the same request as `answered_from_memory`; both process IDs are printed.
4. "Open Portfolio." offers both copies. "laptop" resolves the choice. Asking again still prompts, with the previous choice shown as a hint.
5. The blast-radius query connects build-box to its project and queued task, and reports the copy on the connected laptop.

It resets only the dedicated `circe_mcp_demo` graph. The demo uses scripted user replies and real MCP traffic, without a model API key.

Other commands:

```sh
pnpm demo          # project grounding and paths
pnpm demo:memory   # alias learning, separate-process recall, clarification memory
pnpm demo:ask      # active tasks, blast radius, project history, alias provenance
pnpm check         # typecheck, all tests, shuffled tests, MCP restart demo
pnpm db:down
```

## Run the real coding-agent demo

Install and sign in to [Codex CLI](https://developers.openai.com/codex/cli), then run:

```sh
pnpm demo:agent
```

This optional integration run makes real model requests using your Codex authentication and account allowance. It uses the CLI's default model; `CIRCE_DEMO_MODEL` can select a model your account supports. It starts four fresh agent and MCP server processes, resets only `circe_agent_demo`, and saves the audit and assertions in `.agent-demo/`. An unavailable model or cancelled tool call fails the run. No global MCP configuration is changed.

The script disables shell and delegation tools, loads only this MCP service, and configures unattended tool calls for this synthetic-data run. Production host approvals remain the host's responsibility. `pnpm check` exercises deterministic tests and the stdio conversation without requiring a model login.

To capture your own live browser session, run `pnpm demo:record`, open http://127.0.0.1:4318, start screen recording, and click **Start actual agent run**. This local recording page streams the CLI's real output and MCP responses. Its completed run writes evidence to `docs/evidence/`. Model latency and wording can vary.

## Use it from an MCP host

Configure your host to start the server with Node 24+:

```json
{
  "mcpServers": {
    "circe-graph": {
      "command": "node",
      "args": ["/absolute/path/to/circe-graph/mcp/server.ts"]
    }
  }
}
```

The repo-root `.env` loads even when the host starts in another directory. Existing process environment variables take precedence. Start FalkorDB and seed the intended graph before connecting.

The seven tools are:

- `route_request(utterance)` resolves a request and returns the target's stable ID, machine, workspace root, memory, and query path. Pending routes include the next tool to call.
- `confirm_route(utterance, projectId)` records the user's explicit confirmation and learns the pronunciation. Pass the original utterance and an offered ID; unrelated targets are refused. Do not infer consent from a likely match.
- `answer_clarification(utterance, answer)` accepts the user's actual reply to a pending question, such as "laptop".
- `whats_running(state?)` lists running and queued tasks with their machine and project.
- `machine_blast_radius(machine, depth?)` reports projects at depth 1 and tasks at depth 2, plus same-title copies elsewhere.
- `project_history(project, machine?, limit?)` recalls episodes. Duplicate names require disambiguation.
- `why_heard(text)` explains title or alias ownership and provenance. Multiple project IDs remain ambiguous even when their titles are identical.

Routing and follow-up tools write memory. The four question tools use FalkorDB's read-only query API. Every library and MCP answer carries `untrusted: true`; stored speech and graph text are data, never instructions for the host.

## What the graph contributes

The graph connects machines, projects, tasks, spoken requests, aliases, and episodes. It supplies routing candidates, records decisions, and answers connected questions with explicit paths:

```text
Machine -OWNS-> Project -HAS-> Task
Project -LEARNED_ALIAS-> Alias <-TAUGHT- Utterance
Utterance -RESOLVED_TO-> Project <-ABOUT- Episode:Memory
Heard -LAST_MEANT-> Project
```

A hint alias helps recall without becoming an exact name. A user-confirmed alias joins the project's names and resolves in future processes. Conflicting alias ownership is checked again inside the write query, so simultaneous confirmations cannot both claim the same normalized alias. Confirmation provenance stays connected to its project.

The six routing outcomes are `answered_with_path`, `answered_from_memory`, `needs_confirmation`, `needs_clarification`, `not_in_graph`, and `no_project_named`. No project slot writes nothing. A pending confirmation writes nothing until the user answers. Clarification questions record the offered options; answered questions add an episode and `LAST_MEANT`. A disconnected target is reported explicitly and is never replaced silently with another machine's copy.

![Example graph after the memory demo](docs/screenshots/graph.png)

## Verification and scope

The suite currently passes 82 tests, including routing, learning, concurrent clients, vanished targets, tenant graph separation, read-only enforcement, protocol validation, socket cleanup, and live-demo evidence validation. Integration fixtures reset before each test. CI runs normal and shuffled suites plus the real MCP conversation against the same pinned FalkorDB image as local development.

Circe already persists confirmed aliases in SQLite. This project adds a shared graph index for cross-machine episodes, alias provenance, clarification precedent, and connected queries. It is a standalone library and MCP service; replacing the main Circe app's candidate provider remains integration work. Speech recognition and task execution belong to the host.

[Architecture, configuration, and limits](docs/architecture.md). [Submission materials and provenance](docs/submission/README.md). MIT licensed. Built with AI coding assistance under human direction.
