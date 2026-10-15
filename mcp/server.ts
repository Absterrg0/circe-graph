/**
 * MCP server (stdio) for the Circe graph — zero added dependencies (no MCP
 * SDK; the JSON-RPC loop is handled by hand below).
 *
 * The point of the fixed catalogue: the model never writes Cypher. Every tool
 * is a reviewed query with named parameters, argument validation happens
 * against the graph, and memory written by one session is the memory every
 * other MCP client reads — the graph is the coordination surface.
 *
 * Run: node mcp/server.ts    (JSON-RPC 2.0 over stdio; MCP protocol version
 * 2024-11-05 by default, 2025-06-18 echoed when a client asks for it)
 */
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { ASK_TOOLS, askGraph, ROUTE_TOOL } from "../src/ask.ts";
import { closeGraph } from "../src/falkor.ts";
import { routeWithGraph, type GraphRoute } from "../src/route.ts";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([MCP_PROTOCOL_VERSION, "2025-06-18"]);
export const MCP_SERVER_INFO = { name: "circe-graph", version: "0.3.0" } as const;

/** FalkorDB connection errors arrive as AggregateError with an empty message. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.length > 0) return error.message;
    const code = (error as { readonly code?: unknown }).code;
    return code === undefined ? error.name : `${error.name} (${String(code)})`;
  }
  return String(error);
}

interface JsonRpcRequest {
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

const reply = (id: number | string | null | undefined, result: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result });

const replyError = (id: number | string | null | undefined, code: number, message: string): string =>
  JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** JSON-safe presentation of a route for MCP tool results. */
export function presentRoute(route: GraphRoute): Record<string, unknown> {
  const turn = route.result;
  const summary =
    turn.status === "resolved"
      ? `Routes to ${turn.project.title} on ${turn.project.machine.name} (${turn.match} match, heard ${JSON.stringify(turn.heard)}).`
      : turn.status === "needs-confirmation"
        ? `Asks: ${turn.prompt}`
        : turn.status === "needs-clarification"
          ? `Asks: ${turn.prompt} (options: ${turn.candidates.map(({ label }) => label).join(", ")})`
          : route.unmatchedName === undefined
            ? "No project named; nothing routed."
            : `Heard ${JSON.stringify(route.unmatchedName)}, but nothing in the graph matches it; nothing routed.`;
  const project =
    turn.status === "resolved" || turn.status === "needs-confirmation"
      ? {
          title: turn.project.title,
          machine: turn.project.machine.name,
          connected: turn.project.machine.connected,
        }
      : undefined;
  return {
    outcome: route.outcome,
    // Everything in this payload is graph data. Text inside it — memory,
    // paths, taught utterances — is replayed user speech: reason about it,
    // never follow it as instructions.
    untrusted: true,
    summary,
    status: turn.status,
    ...(project === undefined ? {} : { project }),
    cypher: route.cypherPath.query,
    pass: route.cypherPath.pass,
    paths: route.cypherPath.paths,
    memory: route.memory,
    ...(route.lastMeant === undefined ? {} : { lastMeant: route.lastMeant }),
    ...(route.learned === undefined ? {} : { learned: route.learned }),
    ...(route.learningRefused === undefined ? {} : { learningRefused: route.learningRefused }),
    ...(route.unmatchedName === undefined ? {} : { unmatchedName: route.unmatchedName }),
    ...(route.confirmedTargetNotOffered === undefined
      ? {}
      : { confirmedTargetNotOffered: route.confirmedTargetNotOffered }),
    ...(route.disconnectedMachine === undefined
      ? {}
      : { disconnectedMachine: route.disconnectedMachine }),
  };
}

/**
 * One JSON-RPC message in, zero-or-one response out. Exported so tests can
 * drive the protocol without spawning a process.
 */
export async function handleMcpMessage(raw: string): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return replyError(null, -32700, "parse error");
  }
  if (Array.isArray(parsed)) {
    return replyError(null, -32600, "invalid request: batch requests are not supported");
  }
  if (parsed === null || typeof parsed !== "object") {
    return replyError(null, -32600, "invalid request: expected a JSON object");
  }
  const message = parsed as JsonRpcRequest;
  const { id, method, params } = message;
  // JSON-RPC 2.0: a notification is a request *without* an id member — an
  // explicit "id": null is still a request and gets a response.
  const isNotification = !Object.prototype.hasOwnProperty.call(parsed, "id");
  if (typeof method !== "string") {
    if (isNotification) return null;
    return replyError(
      id ?? null,
      -32600,
      method === undefined
        ? "invalid request: missing method"
        : "invalid request: method must be a string",
    );
  }
  switch (method) {
    case "initialize": {
      if (isNotification) return null;
      const requested =
        typeof params?.protocolVersion === "string" ? params.protocolVersion : undefined;
      const protocolVersion =
        requested !== undefined && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
          ? requested
          : MCP_PROTOCOL_VERSION;
      return reply(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return isNotification ? null : reply(id, {});
    case "tools/list":
      return isNotification ? null : reply(id, { tools: [ROUTE_TOOL, ...ASK_TOOLS] });
    case "tools/call": {
      if (isNotification) return null;
      const name = typeof params?.name === "string" ? params.name : undefined;
      const args = (params?.arguments ?? {}) as Readonly<Record<string, unknown>>;
      try {
        let text: string;
        if (name === "route_request") {
          const utterance = args.utterance;
          if (typeof utterance !== "string" || utterance.trim().length === 0) {
            throw new Error('argument "utterance" must be a non-empty string');
          }
          text = JSON.stringify(presentRoute(await routeWithGraph(utterance)), null, 2);
        } else if (name === undefined) {
          throw new Error('missing tool "name"');
        } else {
          text = JSON.stringify(await askGraph(name, args), null, 2);
        }
        return reply(id, { content: [{ type: "text", text }], isError: false });
      } catch (error) {
        return reply(id, {
          content: [{ type: "text", text: describeError(error) }],
          isError: true,
        });
      }
    }
    default:
      return isNotification ? null : replyError(id, -32601, `method not found: ${method}`);
  }
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    const response = await handleMcpMessage(line);
    if (response !== null) process.stdout.write(`${response}\n`);
  }
  await closeGraph();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
