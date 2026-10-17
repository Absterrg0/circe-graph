/** Real MCP processes, real graph writes, assertions on every step. */
import assert from "node:assert/strict";
import {
  createMcpClient,
  type PresentedRoute,
  type PresentedClarification,
} from "../mcp/client.ts";
import { closeGraph, getGraph, graphName } from "../src/falkor.ts";
import type { AskResult } from "../src/ask.ts";
import { seedGraph } from "../src/seedGraph.ts";

// This demo resets only its dedicated graph, never the user's ordinary graph.
process.env.CIRCE_GRAPH = "circe_mcp_demo";
try {
  await seedGraph(await getGraph());
} finally {
  await closeGraph();
}
console.log(`MCP conversation · graph ${graphName()}`);
let client = createMcpClient();
try {
  await client.initialize();
  const pending = await client.call<PresentedRoute>("route_request", {
    utterance: "Open Zivil, then fix Portfolio.",
  });
  assert.equal(pending.outcome, "needs_confirmation");
  console.log(
    `You: Open Zivil, then fix Portfolio.\nCirce: ${pending.summary}`,
  );
  console.log("You: yes");
  assert.ok(
    "nextStep" in pending &&
      pending.nextStep &&
      "arguments" in pending.nextStep,
  );
  const confirmed = await client.call<PresentedRoute>(
    "confirm_route",
    pending.nextStep.arguments,
  );
  assert.equal(confirmed.learned?.text, "zivil");
  assert.ok(confirmed.learned);
  console.log(
    `Circe: ${confirmed.summary}\nLearned: ${confirmed.learned.text}`,
  );
  const firstPid = client.pid;
  await client.close();
  client = createMcpClient();
  await client.initialize();
  console.log(`\nServer restarted · PID ${firstPid} → ${client.pid}`);
  const remembered = await client.call<PresentedRoute>("route_request", {
    utterance: "Open Zivil, then fix Portfolio.",
  });
  assert.equal(remembered.outcome, "answered_from_memory");
  console.log(
    `Same request: ${remembered.outcome}\n${remembered.paths.join("\n")}`,
  );
  const ambiguous = await client.call<PresentedRoute>("route_request", {
    utterance: "Open Portfolio.",
  });
  assert.equal(ambiguous.outcome, "needs_clarification");
  console.log(
    `\nYou: Open Portfolio.\nCirce: ${ambiguous.summary}\nYou: laptop`,
  );
  const answer = await client.call<PresentedClarification>(
    "answer_clarification",
    { utterance: "Open Portfolio.", answer: "laptop" },
  );
  assert.ok(answer.project);
  assert.equal(answer.project.machine.name, "laptop");
  const again = await client.call<PresentedRoute>("route_request", {
    utterance: "Open Portfolio.",
  });
  assert.equal(again.outcome, "needs_clarification");
  assert.equal(again.lastMeant?.projectId, answer.project.id);
  assert.ok(again.lastMeant);
  console.log(
    `Circe: Portfolio on laptop.\nNext time: still asks; last meant ${again.lastMeant.label}.`,
  );
  const blast = await client.call<AskResult>("machine_blast_radius", {
    machine: "build-box",
    depth: 2,
  });
  assert.match(blast.summary, /refresh the portfolio theme/);
  assert.match(blast.summary, /also lives on laptop/);
  console.log(`\n${blast.summary}`);
  const why = await client.call<AskResult>("why_heard", { text: "zivil" });
  assert.equal(why.outcome, "answered_from_memory");
  console.log(
    `\n${why.summary}\n\nMCP conversation passed. Every response came over stdio.`,
  );
} finally {
  await client.close();
}
