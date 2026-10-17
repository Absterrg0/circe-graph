# Live coding-agent evidence

Recorded October 17, 2026 using Codex CLI 0.162.0, its default model, and the ordinary `mcp/server.ts` behind a transparent audit proxy. No explicit model ID was selected for the successful recording; `requestedModel: null` preserves that fact. The recording uses a predefined synthetic user scenario. Model responses and MCP requests were generated during the run.

- [Working screen recording](../agent-demo.mp4): 63.76 seconds, 1920×1080, H.264 MP4.
- [Run summary and process IDs](agent-demo.json).
- [Unmodified MCP tool requests and responses](agent-demo-mcp.jsonl).
- Raw Codex JSONL events for [the first request](ask.codex.jsonl), [explicit confirmation](confirm.codex.jsonl), [fresh-agent recall](recall.codex.jsonl), and [the connected-data question](connected.codex.jsonl).

The MP4 is a format conversion of one continuous headless-browser screen recording. There are no cuts, timing changes, substituted tool responses, or hand-authored agent answers. The page streams actual CLI events and the proxy's actual graph responses. The earlier illustrated walkthrough is a separate artifact.

The assertions check that the first request needs confirmation and has not learned an alias, the explicit confirmation learns `zivil`, a fresh agent/server resolves the original request from graph memory without reconfirming, and the offline-machine query reports the affected task and connected laptop copy. Each stage has a different MCP server process ID.

## Re-run

```sh
pnpm db:up
# Install Codex CLI and authenticate separately.
pnpm demo:agent
```

This performs real model requests against the authenticated account. Failed authentication, unavailable models, cancelled tools, and missing required graph responses fail the demonstration. The normal test suite does not make model requests.

For a new screen recording, run `pnpm demo:record`, open http://127.0.0.1:4318, start your browser screen recorder, then click the start button. Evidence from that run overwrites the files in this directory. Use `.agent-demo/` for scratch runs so the published evidence remains intact.

The recorded CLI uses only this MCP service and disables shell and delegation tools. It reports selected project routes; it does not open an editor or execute coding tasks. The records contain synthetic graph data and model output, not a claim that the seeded machines are live computers.
