/**
 * Demo 1: grounding a spoken request against a graph, not an array.
 *
 * Same five cases as circe-src demos/01-ground-a-spoken-request.ts, but the
 * candidates come from FalkorDB Cypher, every route prints the MATCH path that
 * justified it, and each answer states its shape (answered with a path,
 * needs confirmation, not in the graph, no project named). Speech recognition
 * mishears project names, and a voice assistant that guesses will act on the
 * wrong repository. Circe resolves the project slot against the bounded
 * catalog of projects machines actually own, asks instead of guessing when the
 * name is unclear, and never moves work to another machine silently.
 *
 * Run: docker compose up -d && node demos/01-graph-grounding.ts
 * (The demo resets the graph to the seed first, so its output is deterministic.)
 */
import { closeGraph, countNodes, getGraph, graphName, runCypher } from "../src/falkor.ts";
import { routeWithGraph, type GraphRoute } from "../src/route.ts";
import { seedGraph } from "../src/seedGraph.ts";

const CASES = [
  { title: "exact name", utterance: "start a task in Rivvl to fix the login bug" },
  { title: "near mishearing", utterance: "start a task in rival to fix the login bug" },
  { title: "distant mishearing", utterance: "I need you to check out Zivil." },
  { title: "same name on two machines", utterance: "Open Portfolio." },
  { title: "no project named", utterance: "what is running right now" },
] as const;

const oneLine = (value: string): string => value.replace(/\s+/gu, " ").trim();
const shortTs = (ts: string): string => ts.slice(0, 16).replace("T", " ");

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
  console.log(`Outcome:  ${route.outcome}`);
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

  if (route.memory.length > 0) {
    const newest = route.memory[0];
    if (newest !== undefined) {
      console.log(
        `Memory:   the graph already knew ${route.memory.length} note${route.memory.length === 1 ? "" : "s"} — newest: "${newest.text}" (${shortTs(newest.ts)})`,
      );
    }
  }
  if (route.lastMeant !== undefined) {
    console.log(`Last time: you meant ${route.lastMeant.label} (${shortTs(route.lastMeant.ts)}) — still asking, never guessing`);
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
  const graph = await getGraph();
  await seedGraph(graph);
} catch (error) {
  console.error("FalkorDB is not reachable. Run: docker compose up -d");
  console.error(String(error));
  await closeGraph();
  process.exit(1);
}

const machines = await countNodes("Machine");
const projects = await countNodes("Project");
const seededEpisodes = await countNodes("Episode");
console.log(`circe-graph demo · graph "${graphName()}" · ${machines} machines · ${projects} projects · ${seededEpisodes} seeded episodes`);
console.log("Candidates, aliases, and write-back all live in FalkorDB; fuzzy scoring lives in groundVoiceTurn.");
console.log("(This demo reset the graph to the seed so the output is deterministic.)");

for (const [index, demoCase] of CASES.entries()) {
  console.log(`\n${index + 1}. ${demoCase.title}`);
  console.log(`You say:  "${demoCase.utterance}"`);
  printRoute(await routeWithGraph(demoCase.utterance));
}

const utterances = await countNodes("Utterance");
const episodes = await countNodes("Episode");
const aliases = await countNodes("Alias");
const taught = Number(
  (await runCypher<{ total: number }>("MATCH ()-[:TAUGHT]->(:Alias) RETURN count(*) AS total"))[0]
    ?.total ?? 0,
);
console.log(
  `\nGraph memory now holds ${utterances} utterances and ${episodes} episodes (resolved and clarified turns write back; pending confirmations and non-mentions do not).`,
);
console.log(
  `Aliases: ${aliases} (${taught} with teaching provenance) — confirm a pronunciation in demo 2 and the graph learns it for good.`,
);

await closeGraph();
