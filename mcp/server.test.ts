/**
 * MCP protocol tests: drive the handler directly (no process spawn) against a
 * live FalkorDB on a separate graph.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeGraph, getGraph } from "../src/falkor.ts";
import { seedGraph } from "../src/seedGraph.ts";
import { handleMcpMessage } from "./server.ts";

beforeEach(async () => {
  process.env.CIRCE_GRAPH = "circe_test_mcp";
  await seedGraph(await getGraph());
});

afterAll(async () => {
  await closeGraph();
});

const call = async (
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const response = await handleMcpMessage(JSON.stringify(message));
  expect(response).not.toBeNull();
  return JSON.parse(response as string) as Record<string, unknown>;
};

describe("handleMcpMessage", () => {
  it("speaks initialize, ping, and tools/list", async () => {
    const init = await call({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    expect(init.result).toMatchObject({
      protocolVersion: "2024-11-05",
      serverInfo: { name: "circe-graph" },
    });
    // A client asking for a protocol version this server knows is echoed it;
    // an unknown one falls back to the default.
    const newer = await call({
      jsonrpc: "2.0",
      id: 11,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(newer.result).toMatchObject({ protocolVersion: "2025-06-18" });
    const unknown = await call({
      jsonrpc: "2.0",
      id: 12,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect(unknown.result).toMatchObject({ protocolVersion: "2024-11-05" });
    const ping = await call({ jsonrpc: "2.0", id: 2, method: "ping" });
    expect(ping.result).toEqual({});
    const list = await call({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const tools = (list.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map(({ name }) => name)).toEqual([
      "route_request",
      "confirm_route",
      "answer_clarification",
      "whats_running",
      "machine_blast_radius",
      "project_history",
      "why_heard",
    ]);
  });

  it("routes a request through tools/call and returns the path", async () => {
    const response = await call({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "route_request",
        arguments: { utterance: "start a task in Rivvl to fix the login bug" },
      },
    });
    const result = response.result as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      outcome: string;
      untrusted: boolean;
      paths: string[];
      memory: unknown[];
    };
    expect(payload.outcome).toBe("answered_with_path");
    expect(payload.untrusted).toBe(true);
    expect(payload.paths[0]).toContain("Rivvl");
    expect(payload.memory.length).toBeGreaterThanOrEqual(2);
  });

  it("serves ask tools through the same surface", async () => {
    const response = await call({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "whats_running", arguments: { state: "running" } },
    });
    const result = response.result as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      outcome: string;
      summary: string;
    };
    expect(payload.outcome).toBe("answered_with_path");
    expect(payload.summary).toContain("polish the homepage");
  });

  it("handles bad tool calls, unknown methods, parse errors, and notifications", async () => {
    const badTool = await call({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "drop_everything" },
    });
    expect((badTool.result as { isError: boolean }).isError).toBe(true);

    const unknownMethod = await call({
      jsonrpc: "2.0",
      id: 7,
      method: "resources/list",
    });
    expect((unknownMethod.error as { code: number }).code).toBe(-32601);

    const parseError = await call({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
    });
    expect((parseError.result as { isError: boolean }).isError).toBe(true);

    const unparsable = await handleMcpMessage("{oops");
    expect(unparsable).not.toBeNull();
    expect(
      (JSON.parse(unparsable as string).error as { code: number }).code,
    ).toBe(-32700);

    // No batch support: an array is rejected, not silently dropped.
    const batch = await handleMcpMessage(
      JSON.stringify([{ jsonrpc: "2.0", id: 9, method: "ping" }]),
    );
    expect((JSON.parse(batch as string).error as { code: number }).code).toBe(
      -32600,
    );

    // An explicit "id": null is a request, not a notification.
    const nullId = await handleMcpMessage(
      JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }),
    );
    expect(JSON.parse(nullId as string).result).toEqual({});

    expect(
      await handleMcpMessage(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      ),
    ).toBeNull();
  });
});
