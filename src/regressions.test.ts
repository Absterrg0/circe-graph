import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { askGraph } from "./ask.ts";
import { closeGraph, getGraph, runCypher, runRead } from "./falkor.ts";
import {
  answerClarification,
  confirmRoute,
  learnConfirmedAlias,
  routeWithGraph,
} from "./route.ts";
import { SEED_IDS, seedGraph } from "./seedGraph.ts";
import { handleMcpMessage } from "../mcp/server.ts";

beforeEach(async () => {
  process.env.CIRCE_GRAPH = "circe_test_regressions";
  await seedGraph(await getGraph());
});
afterAll(closeGraph);

const callTool = async (name: string, args: unknown) => {
  const response = await handleMcpMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  );
  const result = JSON.parse(response!).result;
  expect(result.isError).toBe(false);
  return JSON.parse(result.content[0].text);
};

describe("review regressions", () => {
  it("keeps names in the task from hiding the project slot", async () => {
    for (const utterance of [
      "Open Zivil, then fix Portfolio.",
      "In Zivil, compare the login screen with Portfolio.",
    ]) {
      expect(await routeWithGraph(utterance)).toMatchObject({
        outcome: "needs_confirmation",
        result: { heard: "Zivil", project: { id: SEED_IDS.rivvl } },
      });
    }
  });

  it("explains the alias actually heard even when the canonical title appears later", async () => {
    await confirmRoute("Open Zivil.", SEED_IDS.rivvl);
    for (const utterance of [
      "Open Zivil, then fix the Rivvl branch.",
      "Open Zivil. Rivvl needs a fix.",
      "Open Zivil and compare it to Rivvl.",
    ]) {
      const route = await routeWithGraph(utterance);
      expect(route.outcome).toBe("answered_from_memory");
      expect(route.cypherPath.paths.join(" ")).toContain('text: "zivil"');
    }
  });

  it("treats a pull request as task vocabulary rather than an unknown project", async () => {
    expect((await routeWithGraph("review the pull request")).outcome).toBe(
      "no_project_named",
    );
    expect(
      (await routeWithGraph("In Javis, review the pull request")).unmatchedName,
    ).toBe("Javis");
  });

  it("marks library responses untrusted, including clarification failures", async () => {
    expect(await routeWithGraph("Open Rivvl.")).toHaveProperty(
      "untrusted",
      true,
    );
    expect(
      await answerClarification("Open Portfolio.", "moonbase"),
    ).toHaveProperty("untrusted", true);
  });

  it("allows exactly one owner when two clients teach the same alias concurrently", async () => {
    await runCypher(
      "CREATE (:Utterance {id: 'race-a'}), (:Utterance {id: 'race-b'})",
    );
    const results = await Promise.all([
      learnConfirmedAlias({
        heard: "newword",
        projectId: SEED_IDS.rivvl,
        utteranceId: "race-a",
      }),
      learnConfirmedAlias({
        heard: "newword",
        projectId: SEED_IDS.portfolioLaptop,
        utteranceId: "race-b",
      }),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(["learned", "refused"]);
    expect(
      await runRead(
        "MATCH (p:Project)-[:LEARNED_ALIAS]->(:Alias {text: 'newword'}) RETURN p.id AS id",
      ),
    ).toHaveLength(1);
  });

  it("enforces alias ownership across independent processes", async () => {
    await runCypher(
      "CREATE (:Utterance {id: 'cross-a'}), (:Utterance {id: 'cross-b'})",
    );
    const exec = promisify(execFile);
    const teach = async (projectId: string, utteranceId: string) => {
      const { stdout } = await exec(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import { learnConfirmedAlias } from './src/route.ts';
        import { closeGraph } from './src/falkor.ts';
        try { console.log(JSON.stringify(await learnConfirmedAlias({ heard: 'crossword', projectId: process.argv[1], utteranceId: process.argv[2] }))); }
        finally { await closeGraph(); }
      `,
          projectId,
          utteranceId,
        ],
        { timeout: 5000, env: { ...process.env } },
      );
      return JSON.parse(stdout).kind;
    };
    expect(
      (
        await Promise.all([
          teach(SEED_IDS.rivvl, "cross-a"),
          teach(SEED_IDS.portfolioLaptop, "cross-b"),
        ])
      ).sort(),
    ).toEqual(["learned", "refused"]);
    expect(
      await runRead(
        "MATCH (p:Project)-[:LEARNED_ALIAS]->(:Alias {text: 'crossword'}) RETURN p.id AS id",
      ),
    ).toHaveLength(1);
  });

  it("creates no orphan utterance when the selected project disappears before write-back", async () => {
    const graph = await getGraph();
    const original = graph.query.bind(graph);
    let deleted = false;
    const spy = vi
      .spyOn(graph, "query")
      .mockImplementation(async (query, options) => {
        if (
          !deleted &&
          String(query).includes("CREATE (ut:Utterance") &&
          String(query).includes("RESOLVED_TO")
        ) {
          deleted = true;
          await original("MATCH (p:Project {id: $id}) DETACH DELETE p", {
            params: { id: SEED_IDS.rivvl },
          });
        }
        return original(query, options);
      });
    try {
      await expect(routeWithGraph("Open Rivvl.")).rejects.toThrow(
        /write-back failed/,
      );
      expect(
        await runRead("MATCH (u:Utterance) RETURN u.id AS id"),
      ).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not mistake identical titles for identical alias owners", async () => {
    await runCypher(
      "MATCH (p:Project {title: 'Portfolio'}) CREATE (a:Alias {text: 'porty', kind: 'confirmed'}) CREATE (p)-[:LEARNED_ALIAS]->(a)",
    );
    expect((await askGraph("why_heard", { text: "porty" })).outcome).toBe(
      "ambiguous_name",
    );
    expect((await askGraph("why_heard", { text: "Portfolio" })).outcome).toBe(
      "ambiguous_name",
    );
  });

  it("lists only active tasks and describes a shallow traversal honestly", async () => {
    await runCypher(
      "MATCH (p:Project {id: $id}) CREATE (t:Task {title: 'finished', state: 'done'}) CREATE (p)-[:HAS]->(t)",
      { id: SEED_IDS.rivvl },
    );
    const active = await askGraph("whats_running");
    expect(active.rows).toHaveLength(3);
    expect(active.summary).not.toContain("finished");
    const shallow = await askGraph("machine_blast_radius", {
      machine: "build-box",
      depth: 1,
    });
    expect(shallow.summary).not.toContain("no tasks are attached");
    expect(shallow.summary).toContain("depth 2");
  });

  it("completes confirmation and clarification using MCP tools alone", async () => {
    const pending = await callTool("route_request", {
      utterance: "Open Zivil.",
    });
    expect(pending.outcome).toBe("needs_confirmation");
    expect(pending.project.id).toBe(SEED_IDS.rivvl);
    const confirmed = await callTool("confirm_route", {
      utterance: "Open Zivil.",
      projectId: pending.project.id,
    });
    expect(confirmed.learned.text).toBe("zivil");
    expect(
      (await callTool("route_request", { utterance: "Open Zivil." })).outcome,
    ).toBe("answered_from_memory");
    const ambiguous = await callTool("route_request", {
      utterance: "Open Portfolio.",
    });
    expect(ambiguous.candidates).toHaveLength(2);
    const answer = await callTool("answer_clarification", {
      utterance: "Open Portfolio.",
      answer: "laptop",
    });
    expect(answer.resolved).toBe(true);
    expect(answer.project.id).toBe(SEED_IDS.portfolioLaptop);
    expect(
      (await callTool("route_request", { utterance: "Open Portfolio." }))
        .lastMeant.projectId,
    ).toBe(SEED_IDS.portfolioLaptop);
  });

  it("refuses confirmation of a project that the original request never offered", async () => {
    const route = await callTool("confirm_route", {
      utterance: "Open Zivil.",
      projectId: SEED_IDS.portfolioLaptop,
    });
    expect(route.confirmedTargetNotOffered).toBe(true);
    expect(route.status).toBe("needs-clarification");
    expect(route.learned).toBeUndefined();
  });

  it("does not silently select a surviving twin when a confirmed copy vanishes", async () => {
    await routeWithGraph("Open Portfolio.");
    await runCypher("MATCH (p:Project {id: $id}) DETACH DELETE p", {
      id: SEED_IDS.portfolioBuildBox,
    });
    const route = await confirmRoute(
      "Open Portfolio.",
      SEED_IDS.portfolioBuildBox,
    );
    expect(route.result.status).toBe("needs-clarification");
    expect(
      await runRead(
        "MATCH (:Utterance)-[:RESOLVED_TO]->(p:Project) RETURN p.id AS id",
      ),
    ).toHaveLength(0);
  });

  it("rejects malformed RPC envelopes and tool argument containers", async () => {
    for (const message of [
      { jsonrpc: "1.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: {}, method: "ping" },
      { jsonrpc: "2.0", id: 1, method: "ping", params: [] },
      {},
    ]) {
      const response = await handleMcpMessage(JSON.stringify(message));
      expect(JSON.parse(response!).error.code).toBe(-32600);
    }
    const response = await handleMcpMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "whats_running", arguments: [] },
      }),
    );
    expect(JSON.parse(response!).error.code).toBe(-32602);
  });
});
