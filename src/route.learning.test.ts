/** Learning tests reset their graph before each case, including shuffled runs. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getCandidates } from "./catalog.ts";
import {
  closeGraph,
  getGraph,
  runCypher,
  type CypherParams,
} from "./falkor.ts";
import { confirmRoute, learnConfirmedAlias, routeWithGraph } from "./route.ts";
import { SEED_IDS, seedGraph } from "./seedGraph.ts";

beforeEach(async () => {
  process.env.CIRCE_GRAPH = "circe_test_route_learning";
  await seedGraph(await getGraph());
});

afterAll(async () => {
  await closeGraph();
});

const count = async (
  cypher: string,
  params: CypherParams = {},
): Promise<number> =>
  Number((await runCypher<{ total: number }>(cypher, params))[0]?.total ?? 0);

/** A minimal utterance, for learnConfirmedAlias's provenance edge. */
const freshUtterance = async (text: string): Promise<string> => {
  const id = `utterance-test-${Math.random().toString(36).slice(2, 10)}`;
  await runCypher(
    "CREATE (:Utterance {id: $id, text: $text, ts: $ts, status: 'resolved'})",
    {
      id,
      text,
      ts: new Date().toISOString(),
    },
  );
  return id;
};

describe("learning", () => {
  it("refuses names that would blur two projects together, and no-ops on a title", async () => {
    // Another project's title.
    const byTitle = await learnConfirmedAlias({
      heard: "Portfolio",
      projectId: SEED_IDS.rivvl,
      utteranceId: await freshUtterance("Portfolio"),
    });
    expect(byTitle.kind).toBe("refused");
    if (byTitle.kind === "refused")
      expect(byTitle.refusal.reason).toContain("Portfolio");

    // Another project's learned alias (the seeded hint "rival" on Rivvl).
    const byAlias = await learnConfirmedAlias({
      heard: "Rival!",
      projectId: SEED_IDS.portfolioLaptop,
      utteranceId: await freshUtterance("Rival!"),
    });
    expect(byAlias.kind).toBe("refused");
    if (byAlias.kind === "refused")
      expect(byAlias.refusal.reason).toContain("another project");

    // A project's own canonical title already routes exactly: nothing to teach.
    const canonical = await learnConfirmedAlias({
      heard: "Rivvl",
      projectId: SEED_IDS.rivvl,
      utteranceId: await freshUtterance("Rivvl"),
    });
    expect(canonical.kind).toBe("no-op");
  });

  it("learns a confirmed pronunciation and answers it from memory next session", async () => {
    const utterance = "I need you to check out Zivil.";
    const confirmed = await confirmRoute(utterance, SEED_IDS.rivvl);
    expect(confirmed.outcome).toBe("answered_with_path");
    expect(confirmed.result).toMatchObject({
      status: "resolved",
      match: "confirmed-pronunciation",
      project: { id: SEED_IDS.rivvl },
    });
    expect(confirmed.learned).toMatchObject({
      text: "zivil",
      projectId: SEED_IDS.rivvl,
    });

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
    expect(candidates.find(({ id }) => id === SEED_IDS.rivvl)?.names).toEqual([
      "Rivvl",
      "zivil",
    ]);

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

  it("upgrades a hint with the confirmation's provenance", async () => {
    const confirmed = await confirmRoute("Open rival.", SEED_IDS.rivvl);
    expect(confirmed.learned?.text).toBe("rival");
    const next = await routeWithGraph("Open rival.");
    expect(next.outcome).toBe("answered_from_memory");
    expect(next.cypherPath.paths.join(" ")).toContain('source: "confirmation"');
  });

  it("keys a learned alias to its own project only", async () => {
    const learned = await learnConfirmedAlias({
      heard: "Spindrift",
      projectId: SEED_IDS.rivvl,
      utteranceId: await freshUtterance("Spindrift"),
    });
    expect(learned).toMatchObject({
      kind: "learned",
      alias: { text: "spindrift" },
    });
    expect(
      await count(
        "MATCH (:Project {id: $id})-[:LEARNED_ALIAS]->(a:Alias {text: 'spindrift'}) RETURN count(a) AS total",
        { id: SEED_IDS.rivvl },
      ),
    ).toBe(1);
    // The node carries its owner, and another project cannot re-teach it.
    expect(
      await count(
        "MATCH (a:Alias {text: 'spindrift', projectId: $id}) RETURN count(a) AS total",
        {
          id: SEED_IDS.rivvl,
        },
      ),
    ).toBe(1);
    const stolen = await learnConfirmedAlias({
      heard: "Spindrift",
      projectId: SEED_IDS.portfolioLaptop,
      utteranceId: await freshUtterance("Spindrift"),
    });
    expect(stolen.kind).toBe("refused");
  });
});
