/**
 * Catalog tests run against a live FalkorDB (docker compose up -d) on a
 * separate graph so they never touch the demo data.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getCandidates, heardWindows, lookupCandidates } from "./catalog.ts";
import { closeGraph, getGraph, runCypher } from "./falkor.ts";
import { SEED_IDS, seedGraph } from "./seedGraph.ts";

beforeAll(async () => {
  process.env.CIRCE_GRAPH = "circe_test_catalog";
  await seedGraph(await getGraph());
});

afterAll(async () => {
  await closeGraph();
});

describe("heardWindows", () => {
  it("normalizes every 1..4 word window of the utterance", () => {
    const windows = heardWindows("open the Portfolio site, please");
    expect(windows).toContain("portfolio");
    expect(windows).toContain("open the portfolio");
    expect(windows).toContain("the portfolio site");
    expect(windows).not.toContain("open the portfolio site please");
  });
});

describe("getCandidates", () => {
  it("returns the project as a VoiceProjectCandidate with its machine", async () => {
    const candidates = await getCandidates("start a task in Rivvl to fix the login bug");
    expect(candidates).toEqual([
      {
        id: SEED_IDS.rivvl,
        title: "Rivvl",
        label: "Rivvl on desktop",
        names: ["Rivvl"],
        project: {
          id: SEED_IDS.rivvl,
          title: "Rivvl",
          workspaceRoot: "/home/you/code/rivvl",
          machine: { id: SEED_IDS.machineDesktop, name: "desktop", connected: true },
        },
        evidence: { pass: "exact", kind: "title", matched: "rivvl" },
      },
    ]);
  });

  it("treats a hint alias as an exact graph match that still reports its strength", async () => {
    const lookup = await lookupCandidates("start a task in rival to fix the login bug");
    expect(lookup.pass).toBe("exact");
    expect(lookup.candidates).toHaveLength(1);
    expect(lookup.candidates[0]?.id).toBe(SEED_IDS.rivvl);
    expect(lookup.candidates[0]?.evidence).toEqual({
      pass: "exact",
      kind: "alias",
      matched: "rival",
      aliasKind: "hint",
    });
    // A hint gates recall only; it never joins `names`, so the core still
    // reports an honest near match instead of pretending it is exact.
    expect(lookup.candidates[0]?.names).toEqual(["Rivvl"]);
  });

  it("keeps both machines' copies of a duplicate title instead of merging them", async () => {
    const candidates = await getCandidates("Open Portfolio.");
    expect(candidates.map(({ id }) => id).sort()).toEqual(
      [SEED_IDS.portfolioLaptop, SEED_IDS.portfolioBuildBox].sort(),
    );
    expect(candidates.map(({ label }) => label).sort()).toEqual([
      "Portfolio on build-box",
      "Portfolio on laptop",
    ]);
    const buildBox = candidates.find(({ id }) => id === SEED_IDS.portfolioBuildBox);
    expect(buildBox?.project.machine).toMatchObject({
      id: SEED_IDS.machineBuildBox,
      name: "build-box",
      connected: false,
    });
  });

  it("falls back to the bounded catalog when nothing matches exactly", async () => {
    const lookup = await lookupCandidates("I need you to check out Zivil.");
    expect(lookup.pass).toBe("catalog-fallback");
    expect(lookup.candidates).toHaveLength(3);
    expect(lookup.candidates.every(({ evidence }) => evidence.pass === "catalog-fallback")).toBe(
      true,
    );
  });

  it("promotes a confirmed alias into the candidate's names", async () => {
    await runCypher(
      `MATCH (p:Project {id: '${SEED_IDS.rivvl}'})
       CREATE (a:Alias {id: 'alias-test-zivil', text: 'zivil', kind: 'confirmed',
                        ts: '2026-10-15T00:00:00.000Z'})
       CREATE (p)-[:LEARNED_ALIAS {source: 'confirmation', ts: '2026-10-15T00:00:00.000Z'}]->(a)`,
    );
    try {
      const lookup = await lookupCandidates("I need you to check out Zivil.");
      expect(lookup.pass).toBe("exact");
      const rivvl = lookup.candidates.find(({ id }) => id === SEED_IDS.rivvl);
      expect(rivvl?.names).toEqual(["Rivvl", "zivil"]);
      expect(rivvl?.evidence).toEqual({
        pass: "exact",
        kind: "alias",
        matched: "zivil",
        aliasKind: "confirmed",
      });
    } finally {
      await runCypher("MATCH (a:Alias {id: 'alias-test-zivil'}) DETACH DELETE a");
    }
  });
});
