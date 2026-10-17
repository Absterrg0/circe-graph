/**
 * Ask-tool tests run against a live FalkorDB (docker compose up -d) on a
 * separate graph so they never touch the demo data.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { askGraph, ASK_TOOLS, ROUTE_TOOL, FOLLOW_UP_TOOLS } from "./ask.ts";
import { closeGraph, getGraph, runCypher } from "./falkor.ts";
import { SEED_IDS, seedGraph } from "./seedGraph.ts";

beforeEach(async () => {
  process.env.CIRCE_GRAPH = "circe_test_ask";
  await seedGraph(await getGraph());
});

afterAll(async () => {
  await closeGraph();
});

describe("askGraph", () => {
  it("whats_running traverses machine → project → task and returns every path", async () => {
    const all = await askGraph("whats_running");
    expect(all.outcome).toBe("answered_with_path");
    expect(all.untrusted).toBe(true);
    expect(all.rows).toHaveLength(3);
    expect(all.paths).toHaveLength(3);
    expect(all.paths.join("\n")).toContain(
      '(:Machine {name: "laptop"})-[:OWNS]->(:Project {title: "Portfolio"})-[:HAS]->(:Task {title: "polish the homepage", state: "running"})',
    );

    const running = await askGraph("whats_running", { state: "running" });
    expect(running.rows).toHaveLength(1);
    expect(running.summary).toContain("polish the homepage");
  });

  it("machine_blast_radius changes scope with depth and reports mirrors without moving them", async () => {
    const depthOne = await askGraph("machine_blast_radius", {
      machine: "build-box",
      depth: 1,
    });
    expect(depthOne.outcome).toBe("answered_with_path");
    expect(depthOne.rows).toHaveLength(1);
    expect(depthOne.summary).toContain("Portfolio also lives on laptop");

    const depthTwo = await askGraph("machine_blast_radius", {
      machine: "build-box",
      depth: 2,
    });
    expect(depthTwo.rows).toHaveLength(2);
    expect(
      depthTwo.paths.some((path) =>
        path.includes("refresh the portfolio theme"),
      ),
    ).toBe(true);
    expect(depthTwo.paths.some((path) => path.includes("[mirror of"))).toBe(
      true,
    );

    const desktop = await askGraph("machine_blast_radius", {
      machine: "desktop",
    });
    expect(desktop.summary).toContain("Rivvl");
    expect(desktop.summary).toContain(
      "No same-named project exists on another machine.",
    );

    const unknown = await askGraph("machine_blast_radius", {
      machine: "yosemite",
    });
    expect(unknown.outcome).toBe("unknown_name");
  });

  it("project_history answers from memory, refuses duplicate guesses, and admits an empty memory", async () => {
    const memory = await askGraph("project_history", {
      project: "Portfolio",
      machine: "laptop",
    });
    expect(memory.outcome).toBe("answered_from_memory");
    expect(memory.rows).toHaveLength(1);
    expect(memory.paths[0]).toContain("reviewed the portfolio homepage copy");

    const ambiguous = await askGraph("project_history", {
      project: "Portfolio",
    });
    expect(ambiguous.outcome).toBe("ambiguous_name");
    expect(ambiguous.summary).toContain("will not guess");

    const empty = await askGraph("project_history", {
      project: "Portfolio",
      machine: "build-box",
    });
    expect(empty.outcome).toBe("not_in_graph");
  });

  it("why_heard explains a hint, a plain title, and an unknown name", async () => {
    const hint = await askGraph("why_heard", { text: "rival" });
    expect(hint.outcome).toBe("answered_with_path");
    expect(hint.paths[0]).toContain('(:Alias {text: "rival", kind: "hint"})');
    expect(hint.summary).toContain("not yet confirmed");

    const title = await askGraph("why_heard", { text: "rivvl" });
    expect(title.outcome).toBe("answered_with_path");
    expect(title.summary).toContain("plain title");

    const unknown = await askGraph("why_heard", { text: "blender" });
    expect(unknown.outcome).toBe("unknown_name");
    expect(unknown.paths).toEqual([]);
  });

  it("refuses to narrate one meaning when several projects own the same alias text", async () => {
    await runCypher(
      `MATCH (p:Project {id: $id})
       CREATE (a:Alias {text: 'rival', kind: 'hint', projectId: $id})
       CREATE (p)-[:LEARNED_ALIAS {source: 'test'}]->(a)`,
      { id: SEED_IDS.portfolioLaptop },
    );
    try {
      const heard = await askGraph("why_heard", { text: "rival" });
      expect(heard.outcome).toBe("ambiguous_name");
      expect(heard.summary).toContain("will not guess");
      expect(heard.paths).toHaveLength(2);
    } finally {
      // Clean up: ownership goes back to one project for any later test.
      await runCypher(
        `MATCH (:Project {id: $id})-[l:LEARNED_ALIAS]->(a:Alias {text: 'rival'})
         DELETE l, a`,
        { id: SEED_IDS.portfolioLaptop },
      );
    }
  });

  it("validates arguments and refuses unknown tools", async () => {
    await expect(
      askGraph("whats_running", { state: "paused" }),
    ).rejects.toThrow(/state/);
    await expect(askGraph("machine_blast_radius", {})).rejects.toThrow(
      /machine/,
    );
    await expect(
      askGraph("machine_blast_radius", { machine: "desktop", depth: 9 }),
    ).rejects.toThrow(/depth/);
    await expect(askGraph("drop_everything")).rejects.toThrow(
      /catalogue is fixed/,
    );
  });
});

describe("tool catalogue", () => {
  it("declares the actual read and additive-write behavior to MCP hosts", () => {
    for (const tool of ASK_TOOLS)
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
      });
    for (const tool of [ROUTE_TOOL, ...FOLLOW_UP_TOOLS])
      expect(tool.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
      });
  });

  it("is fixed, described, and schema-shaped for MCP", () => {
    expect(ROUTE_TOOL.name).toBe("route_request");
    expect(ASK_TOOLS.map(({ name }) => name)).toEqual([
      "whats_running",
      "machine_blast_radius",
      "project_history",
      "why_heard",
    ]);
    for (const tool of [ROUTE_TOOL, ...ASK_TOOLS]) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });
});
