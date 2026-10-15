/**
 * Demo 2: the graph remembers — across sessions.
 *
 * Session A: a distant mishearing ("Zivil") only earns a confirmation prompt;
 * cannot act. The user says yes, and that answer is written to the graph as a
 * confirmed alias with provenance — the utterance that taught it.
 *
 * Session B: the same words resolve outright, answered_from_memory, because
 * the router read the graph's memory before it reasoned. The run-the-same-
 * question-twice contrast is the whole point: only a graph is still there
 * between the two.
 *
 * Then the same for ambiguity: an answered clarification ("laptop") is stored
 * as memory, and the next identical ask still asks — ambiguity is a fact, not
 * a cache miss — but it shows the user their own precedent. And every resolved
 * route returns the episodes the graph already held about the project.
 *
 * Run: node demos/02-memory-across-sessions.ts   (resets the graph to seed first)
 */
import { closeGraph, countNodes, getGraph, graphName, runCypher } from "../src/falkor.ts";
import { answerClarification, confirmRoute, routeWithGraph } from "../src/route.ts";
import { SEED_IDS, seedGraph } from "../src/seedGraph.ts";

const oneLine = (value: string): string => value.replace(/\s+/gu, " ").trim();
const shortTs = (ts: string): string => ts.slice(0, 16).replace("T", " ");

console.log(`circe-graph memory demo · graph "${graphName()}"`);
try {
  await seedGraph(await getGraph());
} catch (error) {
  console.error("FalkorDB is not reachable. Run: docker compose up -d");
  console.error(String(error));
  await closeGraph();
  process.exit(1);
}
console.log("(This demo reset the graph to the seed so the two sessions are reproducible.)\n");

const UTTERANCE = "I need you to check out Zivil.";

console.log("── Session A · the mishearing only earns a question ──");
const sessionOne = await routeWithGraph(UTTERANCE);
console.log(`You say:  "${UTTERANCE}"`);
console.log(`Outcome:  ${sessionOne.outcome}`);
if (sessionOne.result.status === "needs-confirmation") {
  console.log(`Circe:    asks "${sessionOne.result.prompt}"`);
  console.log(`          heard "${sessionOne.result.heard}" — phonetics may ask, never act`);
}

console.log("\nYou say:  \"yes\"");
const confirmed = await confirmRoute(UTTERANCE, SEED_IDS.rivvl);
console.log(`Outcome:  ${confirmed.outcome}`);
if (confirmed.learned !== undefined) {
  console.log(
    `Learned:  (:Alias {text: "${confirmed.learned.text}", kind: "confirmed"}) — answered from memory next time`,
  );
}
confirmed.cypherPath.paths.forEach((path, index) => {
  console.log(`${index === 0 ? "Path:     " : "          "}${path}`);
});

// What the graph actually kept between the sessions.
const learnedRows = await runCypher<{ project: string; taughtText: string; taughtAt: string }>(
  `MATCH (p:Project)-[:LEARNED_ALIAS]->(a:Alias {text: 'zivil'})
   MATCH (u:Utterance)-[:TAUGHT]->(a)
   RETURN p.title AS project, u.text AS taughtText, u.ts AS taughtAt`,
);
const learnedRow = learnedRows[0];
if (learnedRow !== undefined) {
  console.log(
    `\nBetween sessions, the graph holds: (:Project "${learnedRow.project}")-[:LEARNED_ALIAS]->(:Alias "zivil") and (:Utterance "${learnedRow.taughtText}")-[:TAUGHT]->the alias (${shortTs(learnedRow.taughtAt)}).`,
  );
}

console.log("\n── Session B · same words, new session ──");
const sessionTwo = await routeWithGraph(UTTERANCE);
console.log(`You say:  "${UTTERANCE}"`);
console.log(`Outcome:  ${sessionTwo.outcome}`);
if (sessionTwo.result.status === "resolved") {
  console.log(
    `Circe:    routes to ${sessionTwo.result.project.title} on ${sessionTwo.result.project.machine.name} (${sessionTwo.result.match} match) — it did not ask this time`,
  );
}
sessionTwo.cypherPath.paths.forEach((path, index) => {
  console.log(`${index === 0 ? "Path:     " : "          "}${path}`);
});

console.log("\n── Ambiguity that remembers its answer ──");
console.log('You say:  "Open Portfolio."');
const askOne = await routeWithGraph("Open Portfolio.");
if (askOne.result.status === "needs-clarification") {
  console.log(`Circe:    asks "${askOne.result.prompt}"`);
  for (const candidate of askOne.result.candidates) console.log(`          option: ${candidate.label}`);
}
console.log('You say:  "laptop"  (the copied projectChoice matcher resolves it)');
const answered = await answerClarification("Open Portfolio.", "laptop");
if (answered.resolved && answered.project !== undefined) {
  console.log(
    `Circe:    resolves to ${answered.project.title} on ${answered.project.machine.name} (matched by ${answered.matchKind}: "${answered.matchedText ?? ""}")`,
  );
}

console.log('\n-- time passes --\nYou say:  "Open Portfolio."');
const askAgain = await routeWithGraph("Open Portfolio.");
console.log(`Outcome:  ${askAgain.outcome} (still asking — the name really is ambiguous)`);
if (askAgain.lastMeant !== undefined) {
  console.log(
    `Last time: you meant ${askAgain.lastMeant.label} (${shortTs(askAgain.lastMeant.ts)}) — the graph showed its own precedent`,
  );
}

console.log("\n── Memory read before reasoning ──");
console.log('You say:  "start a task in Rivvl to fix the login bug"');
const recalled = await routeWithGraph("start a task in Rivvl to fix the login bug");
console.log(`Outcome:  ${recalled.outcome}`);
recalled.memory.forEach((note, index) => {
  console.log(`${index === 0 ? "Memory:   " : "          "}"${oneLine(note.text)}" (${shortTs(note.ts)})`);
});

const utterances = await countNodes("Utterance");
const episodes = await countNodes("Episode");
const aliases = await countNodes("Alias");
const lastMeant = Number(
  (
    await runCypher<{ total: number }>(
      "MATCH (:Heard)-[l:LAST_MEANT]->(:Project) RETURN count(l) AS total",
    )
  )[0]?.total ?? 0,
);
console.log(
  `\nGraph memory now: ${utterances} utterances · ${episodes} episodes · ${aliases} aliases · last-meant remembered: ${lastMeant > 0}.`,
);
console.log("Nothing above lived in process memory; every session read and wrote the same graph.");

await closeGraph();
