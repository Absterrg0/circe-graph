/**
 * Route tests run against a live FalkorDB (docker compose up -d) on a
 * separate graph so they never touch the demo data. Nothing here teaches the
 * graph permanently — the learning flow lives in route.learning.test.ts —
 * so this file stays order-independent and safe under --sequence.shuffle.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

    // Memory the graph held before this turn ran: both seeded Rivvl episodes,
    // marked as the replayed user speech they are. Other tests may have
    // written newer episodes about Rivvl, so this checks presence and relative
    // order — the seed order must survive the newest-first global sort.
    const texts = route.memory.map(({ text }) => text);
    expect(texts).toContain("started fixing the login redirect in Rivvl");
    expect(texts).toContain("checked whether the login flow works in Rivvl");
    expect(texts.indexOf("started fixing the login redirect in Rivvl")).toBeLessThan(
      texts.indexOf("checked whether the login flow works in Rivvl"),
    );
    expect(route.memory[0]).toMatchObject({ provenance: "user-speech", untrusted: true });

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
    // Whether this phrase was answered before depends on test order (the
    // precedent itself, and the still-asks-next-time behaviour, are asserted
    // in "answers a clarification, remembers what the phrase meant" below).
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

  it("labels natural unmatched phrasings as not_in_graph, with the heard span", async () => {
    const simple = await routeWithGraph("open Javis");
    expect(simple.outcome).toBe("not_in_graph");
    expect(simple.result.status).toBe("not-mentioned");
    expect(simple.unmatchedName).toBe("Javis");

    const phrased = await routeWithGraph("start a task in Javis to fix the login bug");
    expect(phrased.outcome).toBe("not_in_graph");
    expect(phrased.result.status).toBe("needs-clarification");
    expect(phrased.unmatchedName).toBe("Javis");
  });

  it("flags a confirmed candidate that was never offered, and teaches nothing", async () => {
    const route = await confirmRoute("In Portfolio.", SEED_IDS.rivvl);
    expect(route.outcome).toBe("needs_clarification");
    expect(route.confirmedTargetNotOffered).toBe(true);
    expect(route.learned).toBeUndefined();
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

  it("reports a disconnected machine when a clarification resolves to it", async () => {
    const answered = await answerClarification("Open Portfolio.", "build-box");
    expect(answered.resolved).toBe(true);
    expect(answered.project).toMatchObject({
      id: SEED_IDS.portfolioBuildBox,
      machine: { name: "build-box", connected: false },
    });
    expect(answered.disconnectedMachine).toMatchObject({
      id: SEED_IDS.machineBuildBox,
      name: "build-box",
    });
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

  it("orders recalled memory globally newest-first across projects", async () => {
    await runCypher(
      `MATCH (p:Project {id: $id})
       CREATE (e:Episode:Memory {id: 'episode-test-newest', text: 'build-box scratch note', ts: '2026-10-12T08:00:00.000Z', status: 'resolved'})
       CREATE (e)-[:ABOUT]->(p)`,
      { id: SEED_IDS.portfolioBuildBox },
    );
    const route = await routeWithGraph("Open Portfolio.");
    expect(route.memory.map(({ text }) => text)).toContain("build-box scratch note");
    const times = route.memory.map(({ ts }) => ts);
    expect([...times].sort((left, right) => (left === right ? 0 : left < right ? 1 : -1))).toEqual(
      times,
    );
  });

});
