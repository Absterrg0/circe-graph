/**
 * Demo 1: grounding a spoken request against a graph, not an array.
 *
 * Same five cases as circe-src demos/01-ground-a-spoken-request.ts, but the
 * candidates come from FalkorDB Cypher and every route prints the MATCH path
 * that justified it. Speech recognition mishears project names, and a voice
 * assistant that guesses will act on the wrong repository. Circe resolves the
 * project slot against the bounded catalog of projects machines actually own,
 * asks instead of guessing when the name is unclear, and never moves work to
 * another machine silently.
 *
 * Run: docker compose up -d && pnpm seed && node demos/01-graph-grounding.ts
 */
import { closeGraph, countNodes, graphName, runCypher } from "../src/falkor.ts";
import { routeWithGraph, type GraphRoute } from "../src/route.ts";

const CASES = [
  { title: "exact name", utterance: "start a task in Rivvl to fix the login bug" },
  { title: "near mishearing", utterance: "start a task in rival to fix the login bug" },
  { title: "distant mishearing", utterance: "I need you to check out Zivil." },
  { title: "same name on two machines", utterance: "Open Portfolio." },
  { title: "no project named", utterance: "what is running right now" },
] as const;

const oneLine = (value: string): string => value.replace(/\s+/gu, " ").trim();

/** Params stay readable: long window lists print their head plus a count. */
function compactParams(params: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(params, (_key, value) => {
    if (Array.isArray(value) && value.length > 6) {
      return [`${String(value[0])}`, `${String(value[1])}`, `… +${value.length - 2} more`];
    }
    return value;
  });
}

function printRoute(route: GraphRoute): void {
  const turn = route.result;
  switch (turn.status) {
    case "resolved":
      console.log(`Circe:    routes to ${turn.project.title} on ${turn.project.machine.name}`);
      console.log(`          heard "${turn.heard}" (${turn.match} match)`);
      console.log(`          sends: "${turn.utterance}"`);
      if (route.disconnectedMachine !== undefined) {
        console.log(
          `          note: ${route.disconnectedMachine.name} is disconnected — reported, not rerouted`,
        );
      }
      break;
    case "needs-confirmation":
      console.log(`Circe:    asks "${turn.prompt}"`);
      console.log(`          heard "${turn.heard}", will not act until you confirm`);
      break;
    case "needs-clarification": {
      console.log(`Circe:    asks "${turn.prompt}"`);
      for (const candidate of turn.candidates) {
        console.log(`          option: ${candidate.label}`);
      }
      const offline = turn.candidates.filter(({ project }) => !project.machine.connected);
      if (offline.length > 0) {
        console.log(
          `          note: ${offline
            .map(({ project }) => `${project.title} on ${project.machine.name}`)
            .join(", ")} sits on a disconnected machine — reported, never rerouted`,
        );
      }
      break;
    }
    case "not-mentioned":
      console.log("Circe:    no project named, so nothing is routed by project");
      break;
  }

  const { cypherPath } = route;
  console.log(`Cypher:   ${oneLine(cypherPath.query)}`);
  console.log(
    `          pass: ${cypherPath.pass} · params: ${compactParams(cypherPath.params)} · rows: ${cypherPath.rows.length}`,
  );
  if (cypherPath.paths.length === 0) {
    console.log("Path:     — (no project named; nothing routed, nothing written)");
  } else {
    cypherPath.paths.forEach((path, index) => {
      console.log(`${index === 0 ? "Path:     " : "          "}${path}`);
    });
  }
}

// Fail with instructions instead of a stack trace when the graph is missing.
try {
  const totalProjects = Number(
    (await runCypher<{ total: number }>("MATCH (p:Project) RETURN count(p) AS total"))[0]?.total ?? 0,
  );
  if (totalProjects === 0) {
    console.error('Graph is empty. Run "pnpm seed" first (after "docker compose up -d").');
    await closeGraph();
    process.exit(1);
  }
} catch (error) {
  console.error("FalkorDB is not reachable. Run: docker compose up -d && pnpm seed");
  console.error(String(error));
  await closeGraph();
  process.exit(1);
}

const machines = await countNodes("Machine");
const projects = await countNodes("Project");
console.log(`circe-graph demo · graph "${graphName()}" · ${machines} machines · ${projects} projects`);
console.log("Candidates, aliases, and write-back all live in FalkorDB; fuzzy scoring lives in groundVoiceTurn.");

for (const [index, demoCase] of CASES.entries()) {
  console.log(`\n${index + 1}. ${demoCase.title}`);
  console.log(`You say:  "${demoCase.utterance}"`);
  printRoute(await routeWithGraph(demoCase.utterance));
}

const utterances = await countNodes("Utterance");
const episodes = await countNodes("Episode");
console.log(
  `\nGraph memory now holds ${utterances} utterances and ${episodes} episodes (resolved and clarified turns write back; pending confirmations and non-mentions do not).`,
);

await closeGraph();
