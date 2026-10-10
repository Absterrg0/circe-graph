/**
 * Seed FalkorDB with the circe-graph demo catalog.
 *
 * Run: pnpm seed   (or: node seed.ts)
 * Uses CIRCE_GRAPH / FALKOR_HOST / FALKOR_PORT when set; defaults to
 * graph "circe" on localhost:6379.
 */
import { closeGraph, countNodes, getGraph, graphName } from "./src/falkor.ts";
import { seedGraph } from "./src/seedGraph.ts";

const graph = await getGraph();
await seedGraph(graph);

const counts = await Promise.all(
  ["User", "Machine", "Project", "Task", "Alias", "Utterance", "Episode"].map(async (label) => [
    label,
    await countNodes(label),
  ] as const),
);

console.log(`Seeded graph "${graphName()}" on FalkorDB:`);
for (const [label, total] of counts) {
  console.log(`  :${label.padEnd(9)} ${total}`);
}

await closeGraph();
