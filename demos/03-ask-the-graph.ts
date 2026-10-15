/**
 * Demo 3: ask the graph — a fixed catalogue, no model-written Cypher.
 *
 * Five reviewed tools with named parameters and arguments validated against
 * the graph. Every answer states its shape (answered with a path, answered
 * from memory, not in the graph, unknown name, ambiguous name) and carries the
 * query it ran. The same catalogue is exposed over MCP, so any agent host can
 * ask these questions — see the round trip at the end.
 *
 * Run: node demos/03-ask-the-graph.ts   (resets the graph to seed first)
 */
import { handleMcpMessage } from "../mcp/server.ts";
import { ASK_TOOLS, askGraph, type AskResult } from "../src/ask.ts";
import { closeGraph, getGraph, graphName } from "../src/falkor.ts";
import { seedGraph } from "../src/seedGraph.ts";

const oneLine = (value: string): string => value.replace(/\s+/gu, " ").trim();

function printAsk(result: AskResult): void {
  console.log(`Tool:     ${result.tool}(${JSON.stringify(result.args)})`);
  console.log(`Outcome:  ${result.outcome}`);
  console.log(`Answer:   ${result.summary}`);
  result.paths.forEach((path, index) => {
    console.log(`${index === 0 ? "Path:     " : "          "}${path}`);
  });
  console.log(`Cypher:   ${oneLine(result.cypher)}`);
}

console.log(`circe-graph "ask" demo · graph "${graphName()}"`);
try {
  await seedGraph(await getGraph());
} catch (error) {
  console.error("FalkorDB is not reachable. Run: docker compose up -d");
  console.error(String(error));
  await closeGraph();
  process.exit(1);
}
console.log(
  `(reset to seed) Fixed catalogue: ${ASK_TOOLS.map((tool) => tool.name).join(", ")} — the model picks and fills parameters; it never writes Cypher.\n`,
);

console.log("1. What is running?");
printAsk(await askGraph("whats_running"));

console.log("\n2. Only what is running right now?");
printAsk(await askGraph("whats_running", { state: "running" }));

console.log("\n3. build-box goes down — what stops? (depth 1: projects)");
printAsk(await askGraph("machine_blast_radius", { machine: "build-box", depth: 1 }));

console.log("\n4. Same machine, depth 2 — the traversal adds the tasks:");
printAsk(await askGraph("machine_blast_radius", { machine: "build-box", depth: 2 }));
console.log(
  "Note:     one parameter changed, and the answer's scope changed with it. The graph is doing the reasoning, not a prompt.",
);

console.log("\n5. desktop goes down; no mirror anywhere.");
printAsk(await askGraph("machine_blast_radius", { machine: "desktop" }));

console.log("\n6. A machine that is not in the graph — resolved before anything runs:");
printAsk(await askGraph("machine_blast_radius", { machine: "yosemite" }));

console.log("\n7. What do we already know about Portfolio on laptop?");
printAsk(await askGraph("project_history", { project: "Portfolio", machine: "laptop" }));

console.log("\n8. Portfolio without a machine — two copies exist, so the graph will not guess:");
printAsk(await askGraph("project_history", { project: "Portfolio" }));

console.log('\n9. Why does "rival" mean Rivvl?');
printAsk(await askGraph("why_heard", { text: "rival" }));

console.log('\n10. Why does "zivil" mean anything? (Not yet — confirm it once in demo 2.)');
printAsk(await askGraph("why_heard", { text: "zivil" }));

console.log('\n11. "rivvl" is just the project\'s name:');
printAsk(await askGraph("why_heard", { text: "rivvl" }));

console.log("\n12. The same catalogue, over MCP (in-process round trip):");
const request = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "machine_blast_radius", arguments: { machine: "desktop", depth: 2 } },
});
console.log(`→ ${request}`);
const response = await handleMcpMessage(request);
if (response !== null) {
  const parsed = JSON.parse(response) as { result?: { content?: Array<{ text?: string }> } };
  const text = parsed.result?.content?.[0]?.text;
  if (typeof text === "string") {
    const payload = JSON.parse(text) as { outcome: string; summary: string };
    console.log(
      `← { outcome: ${JSON.stringify(payload.outcome)}, summary: ${JSON.stringify(payload.summary)} }  (paths, memory, and Cypher included)`,
    );
  }
}
console.log("Any MCP host gets this by running: node mcp/server.ts");

await closeGraph();
