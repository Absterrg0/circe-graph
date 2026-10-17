/** One independent process for the restart-persistence demo. No seed here. */
import { closeGraph } from "../src/falkor.ts";
import { routeWithGraph } from "../src/route.ts";

try {
  const utterance = process.argv[2];
  if (utterance === undefined) throw new Error("An utterance is required");
  console.log(
    JSON.stringify({
      pid: process.pid,
      route: await routeWithGraph(utterance),
    }),
  );
} finally {
  await closeGraph();
}
