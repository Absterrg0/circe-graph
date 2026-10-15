/**
 * Seed FalkorDB with the circe-graph demo catalog.
 *
 * Run: pnpm seed   (or: node seed.ts)
 * Uses CIRCE_GRAPH / FALKOR_HOST / FALKOR_PORT when set; defaults to
 * graph "circe" on localhost:6379.
 */
import { closeGraph, countNodes, getGraph, graphName } from "./src/falkor.ts";
import { seedGraph } from "./src/seedGraph.ts";

try {
  await seedGraph(await getGraph());
} catch (error) {
  console.error("FalkorDB is not reachable. Run: docker compose up -d");
  console.error(String(error));
  await closeGraph();
  process.exit(1);
}

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
