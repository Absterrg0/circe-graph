/**
 * Route tests run against a live FalkorDB (docker compose up -d) on a
 * separate graph so they never touch the demo data. Tests that teach the graph
 * (the learning test) run last; everything before them asserts the seeded
 * state.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getCandidates } from "./catalog.ts";
import { closeGraph, getGraph, runCypher, type CypherParams } from "./falkor.ts";
import { answerClarification, confirmRoute, routeWithGraph } from "./route.ts";
import { SEED_IDS, seedGraph } from "./seedGraph.ts";

const count = async (cypher: string, params: CypherParams = {}): Promise<number> =>
  Number((await runCypher<{ total: number }>(cypher, params))[0]?.total ?? 0);

beforeAll(async () => {
  process.env.CIRCE_GRAPH = "circe_test_route";
  await seedGraph(await getGraph());
});

afterAll(async () => {
  await closeGraph();
});

describe("routeWithGraph", () => {
  it("grounds an exact name, writes the turn back, and reads memory before it reasons", async () => {
    const route = await routeWithGraph("start a task in Rivvl to fix the login bug");
    expect(route.outcome).toBe("answered_with_path");
    expect(route.result).toMatchObject({
      status: "resolved",
      match: "exact",
      heard: "Rivvl",
      utterance: "start a task in Rivvl to fix the login bug",
      project: { id: SEED_IDS.rivvl, machine: { name: "desktop" } },
    });
    expect(route.result.status === "resolved" ? route.result.span : undefined).toEqual({
      start: 16,
      end: 21,
    });
    expect(route.cypherPath.pass).toBe("exact");
    expect(route.cypherPath.paths).toEqual([
      '(:Machine {name: "desktop"})-[:OWNS]->(:Project {title: "Rivvl"})   [matched title "rivvl"]',
    ]);
    expect(route.disconnectedMachine).toBeUndefined();

    // Memory the graph held before this turn ran: both seeded Rivvl episodes.
    expect(route.memory.map(({ text }) => text)).toEqual([
      "started fixing the login redirect in Rivvl",
      "checked whether the login flow works in Rivvl",
    ]);

    expect(
      await count(
        "MATCH (:User {id: $userId})-[:SAID]->(u:Utterance)-[:RESOLVED_TO]->(p:Project {id: $id}) RETURN count(u) AS total",
        { userId: SEED_IDS.user, id: SEED_IDS.rivvl },
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await count(
        "MATCH (e:Episode:Memory {status: 'resolved'})-[:ABOUT]->(p:Project {id: $id}) RETURN count(e) AS total",
        { id: SEED_IDS.rivvl },
      ),
    ).toBeGreaterThanOrEqual(3);
  });

  it("resolves a near mishearing via its hint alias; one edit further only asks", async () => {
    const route = await routeWithGraph("start a task in rival to fix the login bug");
    expect(route.outcome).toBe("answered_with_path");
    expect(route.result).toMatchObject({
      status: "resolved",
      match: "near",
      heard: "rival",
      project: { id: SEED_IDS.rivvl },
    });
    expect(route.cypherPath.pass).toBe("exact");
    expect(route.cypherPath.paths[0]).toBe(
      '(:Machine {name: "desktop"})-[:OWNS]->(:Project {title: "Rivvl"})-[:LEARNED_ALIAS {source: "seed"}]->(:Alias {text: "rival", kind: "hint"})   [matched learned alias "rival" (hint, unconfirmed)]',
    );

    // One edit further ("Zivil" scores 0.6 spelling) is not silently routed:
    // phonetics can only ask, never act, below the threshold.
    const farther = await routeWithGraph("I need you to check out Zivil.");
    expect(farther.outcome).toBe("needs_confirmation");
    expect(farther.result).toMatchObject({
      status: "needs-confirmation",
      heard: "Zivil",
      prompt: "Did you mean Rivvl?",
      project: { id: SEED_IDS.rivvl },
    });
    // Still a live question: the graph has not been taught this pronunciation.
    expect(farther.learned).toBeUndefined();
    expect(farther.lastMeant).toBeUndefined();
  });

  it("clarifies a duplicate title with one option per machine and records the question", async () => {
    const route = await routeWithGraph("Open Portfolio.");
    expect(route.outcome).toBe("needs_clarification");
    expect(route.result).toMatchObject({
      status: "needs-clarification",
      heard: "Portfolio",
    });
    if (route.result.status !== "needs-clarification") return;
    expect(route.result.candidates.map(({ label }) => label)).toEqual([
      "Portfolio on build-box",
      "Portfolio on laptop",
    ]);
    expect(route.cypherPath.paths).toHaveLength(2);
    expect(route.cypherPath.paths.join("\n")).toContain("machine disconnected");
    // First time this phrase is answered has not happened yet.
    expect(route.lastMeant).toBeUndefined();
    expect(
      await count(
        "MATCH (u:Utterance {status: 'needs-clarification'}) RETURN count(u) AS total",
      ),
    ).toBeGreaterThanOrEqual(1);
  });

  it("reports a disconnected machine on the target instead of rerouting to its twin", async () => {
    const route = await routeWithGraph("Open Portfolio.", {
      confirmedCandidateId: SEED_IDS.portfolioBuildBox,
    });
    expect(route.outcome).toBe("answered_with_path");
    expect(route.result).toMatchObject({
      status: "resolved",
      match: "confirmed-pronunciation",
      project: {
        id: SEED_IDS.portfolioBuildBox,
        machine: { id: SEED_IDS.machineBuildBox, name: "build-box", connected: false },
      },
    });
    expect(route.disconnectedMachine).toMatchObject({
      id: SEED_IDS.machineBuildBox,
      name: "build-box",
    });
    expect(route.disconnectedMachine?.reason).toContain("offline");
    if (route.result.status === "resolved") {
      expect(route.result.project.id).not.toBe(SEED_IDS.portfolioLaptop);
    }
    expect(route.cypherPath.paths).toEqual([
      '(:Machine {name: "build-box"})-[:OWNS]->(:Project {title: "Portfolio"})   [matched title "portfolio"; machine disconnected]',
    ]);
    // Confirming a project's own title teaches nothing new.
    expect(route.learned).toBeUndefined();
  });

  it("classifies a heard name that is not in the graph as not_in_graph", async () => {
    const route = await routeWithGraph("In Javis, list projects.");
    expect(route.outcome).toBe("not_in_graph");
    expect(route.result.status).toBe("needs-clarification");
    if (route.result.status === "needs-clarification") {
      expect(route.result.heard).toBe("Javis");
      expect(route.result.prompt).toContain("couldn't match");
    }
  });

  it("answers a clarification, remembers what the phrase meant, and still asks next time", async () => {
    const answered = await answerClarification("Open Portfolio.", "laptop");
    expect(answered.resolved).toBe(true);
    expect(answered.matchKind).toBe("name");
    expect(answered.project).toMatchObject({
      id: SEED_IDS.portfolioLaptop,
      machine: { name: "laptop" },
    });
    expect(answered.memory.map(({ text }) => text)).toContain("reviewed the portfolio homepage copy");

    // The answer is durable memory: utterance → project, episode → project,
    // and the phrase itself remembers what it meant.
    expect(
      await count(
        "MATCH (u:Utterance {status: 'clarified'})-[:RESOLVED_TO]->(:Project {id: $id}) RETURN count(u) AS total",
        { id: SEED_IDS.portfolioLaptop },
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await count(
        "MATCH (e:Episode:Memory {answer: 'laptop'})-[:ABOUT]->(:Project {id: $id}) RETURN count(e) AS total",
        { id: SEED_IDS.portfolioLaptop },
      ),
    ).toBe(1);
    expect(
      await count(
        "MATCH (h:Heard {text: 'portfolio'})-[:LAST_MEANT]->(:Project {id: $id}) RETURN count(h) AS total",
        { id: SEED_IDS.portfolioLaptop },
      ),
    ).toBeGreaterThanOrEqual(1);

    // Next identical ask: still asks (ambiguity is a fact, not a cache miss),
    // but now carries the user's own precedent.
    const again = await routeWithGraph("Open Portfolio.");
    expect(again.outcome).toBe("needs_clarification");
    expect(again.lastMeant).toMatchObject({
      projectId: SEED_IDS.portfolioLaptop,
      label: "Portfolio on laptop",
    });

    // An answer that matches nothing re-asks; a non-clarification is refused.
    const nonsense = await answerClarification("Open Portfolio.", "moonbase");
    expect(nonsense.resolved).toBe(false);
    expect(nonsense.reason).toBe("no-match");
    const notPending = await answerClarification("start a task in Rivvl to fix the login bug", "yes");
    expect(notPending.resolved).toBe(false);
    expect(notPending.reason).toBe("not-a-clarification");
  });

  it("writes nothing for a turn that named no project", async () => {
    const utterancesBefore = await count("MATCH (u:Utterance) RETURN count(u) AS total");
    const episodesBefore = await count("MATCH (e:Episode) RETURN count(e) AS total");
    const route = await routeWithGraph("what is running right now");
    expect(route.outcome).toBe("no_project_named");
    expect(route.result).toMatchObject({ status: "not-mentioned" });
    expect(route.cypherPath.paths).toEqual([]);
    expect(route.memory).toEqual([]);
    expect(await count("MATCH (u:Utterance) RETURN count(u) AS total")).toBe(utterancesBefore);
    expect(await count("MATCH (e:Episode) RETURN count(e) AS total")).toBe(episodesBefore);
  });

  // Teaches the graph permanently, so it runs last.
  it("learns a confirmed pronunciation and answers it from memory next session", async () => {
    const utterance = "I need you to check out Zivil.";
    const confirmed = await confirmRoute(utterance, SEED_IDS.rivvl);
    expect(confirmed.outcome).toBe("answered_with_path");
    expect(confirmed.result).toMatchObject({
      status: "resolved",
      match: "confirmed-pronunciation",
      project: { id: SEED_IDS.rivvl },
    });
    expect(confirmed.learned).toMatchObject({ text: "zivil", projectId: SEED_IDS.rivvl });

    // The graph kept the confirmation with provenance: project → alias, and
    // the utterance that taught it → alias.
    expect(
      await count(
        "MATCH (p:Project {id: $id})-[:LEARNED_ALIAS {source: 'confirmation'}]->(a:Alias {text: 'zivil', kind: 'confirmed'}) RETURN count(p) AS total",
        { id: SEED_IDS.rivvl },
      ),
    ).toBe(1);
    expect(
      await count(
        "MATCH (u:Utterance {text: $text})-[:TAUGHT]->(a:Alias {text: 'zivil'}) RETURN count(u) AS total",
        { text: utterance },
      ),
    ).toBeGreaterThanOrEqual(1);

    // A confirmed alias is part of how the project is named now.
    const candidates = await getCandidates(utterance);
    expect(candidates.find(({ id }) => id === SEED_IDS.rivvl)?.names).toEqual(["Rivvl", "zivil"]);

    // Session two: the same words, answered from memory.
    const next = await routeWithGraph(utterance);
    expect(next.outcome).toBe("answered_from_memory");
    expect(next.result).toMatchObject({
      status: "resolved",
      match: "confirmed-pronunciation",
      project: { id: SEED_IDS.rivvl },
    });
    expect(next.learned).toBeUndefined();
    expect(next.cypherPath.paths[0]).toContain(
      '-[:LEARNED_ALIAS {source: "confirmation"}]->(:Alias {text: "zivil", kind: "confirmed"})',
    );
    expect(next.cypherPath.paths[0]).toContain("answered from memory");
  });
});
