# Final submission video

[`docs/final-demo.mp4`](../final-demo.mp4) is 118.0 seconds long, 1920×1080, H.264 (yuv420p), 30 fps and 13.7 MB, with no audio track. Its SHA-256 is `94892ffb0137e849f2d9850b7fd7f72872b2b919dca28bc32a07fcea0fefb719`. It is a captioned edit built around one fresh live capture.

## Sources

| Time in video | Source | Real or edited |
| --- | --- | --- |
| 0–20 s | Title card and graph diagram | Made in editing (HyperFrames). The diagram shows nodes and edges from `src/seedGraph.ts`. |
| 20–81.8 s | [`final-run/raw-capture.webm`](final-run/raw-capture.webm), the full 61.8 s, starting at its first frame | **Real.** One continuous capture at 1× speed with no cuts or retiming. The page is shifted 212 px left to make room for a caption rail. Captions are drawn beside the footage, never on top of it. |
| 81.8–96 s | [`final-run/graph-query-after-run.txt`](final-run/graph-query-after-run.txt) | Real `redis-cli GRAPH.QUERY` output against `circe_agent_demo`, run after the capture. In the video the values are verbatim but set in a table. |
| 96–118 s | Disclosure and end card | Made in editing. |

## The capture

The capture was recorded on October 17, 2026, from 10:03:48 to 10:04:51 UTC. A local headless Chromium page was driven by Playwright ([`final-run/browser-recorder.js`](final-run/browser-recorder.js)) at a 1920×1080 viewport. The T3 preview recorder was tried first. Its first take was lost when the machine ran out of memory and the kernel's OOM killer stopped the browser mid-run. After that, the preview host reported that it was unavailable.

The page is the unchanged `demos/agent-preview.html`. The server is [`final-run/recorder-server.ts`](final-run/recorder-server.ts), which matches `demos/record-agent-demo.ts` with one difference: it writes evidence to `docs/evidence/final-run/`, so the earlier published evidence stays untouched. It calls the unchanged `runAgentDemo` from `demos/agent-runner.ts`.

The run used Codex CLI's default model (`requestedModel: null`) with a read-only sandbox. Shell and delegation tools were disabled, and every MCP call went through the transparent audit proxy to the ordinary `mcp/server.ts` on the isolated graph `circe_agent_demo`. The dev graph was not touched.

The run passed all four assertions:

- `needs_confirmation`, with no alias learned before confirmation
- `confirm_route` learned `zivil`
- a fresh agent and server returned `answered_from_memory`
- `machine_blast_radius` reported the queued theme task and the copy on laptop

There were four distinct agent PIDs (3491243, 3492525, 3494016, 3495246) and four distinct MCP server PIDs (3491443, 3492896, 3494279, 3495450). Run records:

- [Run summary](final-run/agent-demo.json)
- [MCP audit (5 model-chosen tool calls)](final-run/agent-demo-mcp.jsonl)
- Raw Codex JSONL for each stage: [ask](final-run/ask.codex.jsonl), [confirm](final-run/confirm.codex.jsonl), [recall](final-run/recall.codex.jsonl), [connected](final-run/connected.codex.jsonl)
- Timestamped logs from the [server](final-run/recorder-server.log) and the [browser](final-run/browser-recorder.log)

The raw capture's SHA-256 is `8bb96a5d3da25d4d35fa96567e4339f93ea3d052dfb244315d007a4633f55dae`.

Caption timing comes from the server timestamps. The video clock equals wall-clock time minus 10:03:49.11, which was confirmed by scene-change detection on the log region of the capture. The stages start at 2.5 s, 18.3 s, 33.3 s and 44.6 s of the capture, and PASS appears at 56.6 s.

## Disclosures shown in the video

- Machines, projects and tasks are synthetic seeded data. The user's turns are predefined.
- Route selection only selects a project. It does not open a workspace or execute coding tasks.
- Title cards, the diagram, the captions and the typeset query result were added in editing.

## Verification

- `npx hyperframes check` passed with 0 errors. The warnings are Studio-layout suggestions, plus a contrast note on the decorative background word.
- `ffprobe` confirmed the output: duration 118.000000 s, 1920×1080, h264, 30/1 fps, video stream only. Keyframes at 3, 15, 21, 30, 50, 60, 75, 80, 88, 103 and 116 s were inspected; the captions line up with the on-screen stage headings.
- The composition source is [`final-run/final-video-composition.html`](final-run/final-video-composition.html). It expects the raw capture at `assets/capture.webm`.

`docs/agent-demo.mp4` and the files directly in `docs/evidence/` come from an earlier separate run. They were not modified.
