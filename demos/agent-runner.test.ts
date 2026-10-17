import { describe, expect, it } from "vitest";
import {
  codexArguments,
  demoStages,
  verifyAgentEvidence,
  type AuditEvent,
} from "./agent-runner.ts";

function fixture(): AuditEvent[] {
  const result = (
    stage: string,
    tool: string,
    payload: object,
  ): AuditEvent => ({
    at: "2026-10-17T00:00:00Z",
    stage,
    serverPid: 1,
    direction: "response",
    tool,
    result: {
      isError: false,
      content: [{ type: "text", text: JSON.stringify(payload) }],
    },
  });
  return [
    ...demoStages.map((stage, index) => ({
      at: "2026-10-17T00:00:00Z",
      stage: stage.id,
      serverPid: index + 1,
      direction: "start",
    })),
    result("ask", "route_request", { outcome: "needs_confirmation" }),
    result("confirm", "confirm_route", { learned: { text: "zivil" } }),
    result("recall", "route_request", { outcome: "answered_from_memory" }),
    result("connected", "machine_blast_radius", {
      summary: "refresh the portfolio theme; Portfolio also lives on laptop",
    }),
  ];
}

describe("live agent demo verification", () => {
  it("accepts the required evidence and rejects a missing real tool response", () => {
    expect(() => verifyAgentEvidence(fixture())).not.toThrow();
    expect(() =>
      verifyAgentEvidence(fixture().filter((e) => e.tool !== "confirm_route")),
    ).toThrow(/did not call/);
  });
  it("rejects learning before confirmation and repeated server processes", () => {
    const early = fixture();
    early.push({ ...early[0]!, tool: "confirm_route" });
    expect(() => verifyAgentEvidence(early)).toThrow();
    const reused = fixture().map((e) => ({ ...e, serverPid: 1 }));
    expect(() => verifyAgentEvidence(reused)).toThrow(/fresh MCP server/);
  });
  it("rejects a recall which still asks for confirmation", () => {
    const events = fixture();
    const recall = events.find(
      (e) => e.stage === "recall" && e.direction === "response",
    )!;
    recall.result!.content![0]!.text = JSON.stringify({
      outcome: "needs_confirmation",
    });
    expect(() => verifyAgentEvidence(events)).toThrow();
  });
  it("uses an isolated graph, ephemeral agent, and disabled shell tools", () => {
    const args = codexArguments(
      demoStages[0],
      "/tmp/audit.jsonl",
      "test-model",
    );
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("features.shell_tool=false");
    expect(args).toContain(
      'mcp_servers.circe.env.CIRCE_GRAPH="circe_agent_demo"',
    );
    expect(args).toContain("test-model");
  });
});
