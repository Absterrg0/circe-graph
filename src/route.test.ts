/**
 * Route tests run against a live FalkorDB (docker compose up -d) on a
 * separate graph so they never touch the demo data. They cover the five demo
 * routes plus write-back and the disconnected-machine contract.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeGraph, getGraph, runCypher, type CypherParams } from "./falkor.ts";
import { routeWithGraph } from "./route.ts";
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
  it("grounds an exact name, keeps the canonical utterance, and writes the turn back", async () => {
    const route = await routeWithGraph("start a task in Rivvl to fix the login bug");
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

    expect(
      await count(
        "MATCH (:User {id: $userId})-[:SAID]->(u:Utterance)-[:RESOLVED_TO]->(p:Project {id: $id}) RETURN count(u) AS total",
        { userId: SEED_IDS.user, id: SEED_IDS.rivvl },
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(await count("MATCH (e:Episode:Memory {status: 'resolved'}) RETURN count(e) AS total")).toBeGreaterThanOrEqual(1);
  });

  it("resolves a near mishearing at the 0.8 spelling threshold via its learned alias path", async () => {
    const route = await routeWithGraph("start a task in rival to fix the login bug");
    expect(route.result).toMatchObject({
      status: "resolved",
      match: "near",
      heard: "rival",
      project: { id: SEED_IDS.rivvl },
    });
    expect(route.cypherPath.pass).toBe("exact");
    expect(route.cypherPath.paths[0]).toContain("-[:LEARNED_ALIAS]->(:Alias {text: \"rival\"})");

    // One edit further ("Zivil" scores 0.6 spelling) is not silently routed:
    // phonetics can only ask, never act, below the threshold.
    const farther = await routeWithGraph("I need you to check out Zivil.");
    expect(farther.result).toMatchObject({
      status: "needs-confirmation",
      heard: "Zivil",
      prompt: "Did you mean Rivvl?",
      project: { id: SEED_IDS.rivvl },
    });
  });

  it("clarifies a duplicate title with one option per machine and records the question", async () => {
    const route = await routeWithGraph("Open Portfolio.");
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
  });

  it("writes nothing for a turn that named no project", async () => {
    const utterancesBefore = await count("MATCH (u:Utterance) RETURN count(u) AS total");
    const episodesBefore = await count("MATCH (e:Episode) RETURN count(e) AS total");
    const route = await routeWithGraph("what is running right now");
    expect(route.result).toMatchObject({ status: "not-mentioned" });
    expect(route.cypherPath.paths).toEqual([]);
    expect(await count("MATCH (u:Utterance) RETURN count(u) AS total")).toBe(utterancesBefore);
    expect(await count("MATCH (e:Episode) RETURN count(e) AS total")).toBe(episodesBefore);
  });
});
