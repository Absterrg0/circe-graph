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

import {
  ASK_TOOLS,
  askGraph,
  ROUTE_TOOL,
  FOLLOW_UP_TOOLS,
} from "../src/ask.ts";
import { closeGraph } from "../src/falkor.ts";
import {
  answerClarification,
  confirmRoute,
  routeWithGraph,
  type GraphRoute,
  type ClarificationAnswer,
} from "../src/route.ts";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  MCP_PROTOCOL_VERSION,
  "2025-06-18",
]);
export const MCP_SERVER_INFO = {
  name: "circe-graph",
  version: "0.3.0",
} as const;

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
  readonly jsonrpc?: unknown;
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

const reply = (
  id: number | string | null | undefined,
  result: unknown,
): string => JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result });

const replyError = (
  id: number | string | null | undefined,
  code: number,
  message: string,
): string =>
  JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** JSON-safe presentation of a route for MCP tool results. */
export function presentRoute(route: GraphRoute) {
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
          id: turn.project.id,
          workspaceRoot: turn.project.workspaceRoot,
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
    ...(turn.status === "needs-clarification"
      ? {
          candidates: turn.candidates.map(({ project, label }) => ({
            id: project.id,
            label,
            title: project.title,
            machine: project.machine.name,
            connected: project.machine.connected,
          })),
        }
      : {}),
    ...(turn.status === "needs-confirmation"
      ? {
          nextStep: {
            tool: "confirm_route",
            arguments: {
              utterance: turn.sourceUtterance,
              projectId: turn.project.id,
            },
            requiresUserConfirmation: true,
          },
        }
      : turn.status === "needs-clarification"
        ? {
            nextStep: {
              tool: "answer_clarification",
              utterance: turn.sourceUtterance,
              requiresUserAnswer: true,
            },
          }
        : {}),
    cypher: route.cypherPath.query,
    params: route.cypherPath.params,
    pass: route.cypherPath.pass,
    paths: route.cypherPath.paths,
    memory: route.memory,
    ...(route.lastMeant === undefined ? {} : { lastMeant: route.lastMeant }),
    ...(route.learned === undefined ? {} : { learned: route.learned }),
    ...(route.learningRefused === undefined
      ? {}
      : { learningRefused: route.learningRefused }),
    ...(route.unmatchedName === undefined
      ? {}
      : { unmatchedName: route.unmatchedName }),
    ...(route.confirmedTargetNotOffered === undefined
      ? {}
      : { confirmedTargetNotOffered: route.confirmedTargetNotOffered }),
    ...(route.disconnectedMachine === undefined
      ? {}
      : { disconnectedMachine: route.disconnectedMachine }),
  };
}

export function presentClarification(answer: ClarificationAnswer) {
  return {
    ...answer,
    outcome: answer.resolved ? "answered_with_path" : "needs_clarification",
    cypher: answer.cypherPath.query,
    params: answer.cypherPath.params,
    paths: answer.cypherPath.paths,
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
    return replyError(
      null,
      -32600,
      "invalid request: batch requests are not supported",
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    return replyError(null, -32600, "invalid request: expected a JSON object");
  }
  const message = parsed as JsonRpcRequest;
  const { id, method, params } = message;
  const validId =
    id === undefined ||
    id === null ||
    typeof id === "string" ||
    (typeof id === "number" && Number.isFinite(id));
  if (message.jsonrpc !== "2.0" || !validId || typeof method !== "string") {
    return replyError(
      validId ? id : null,
      -32600,
      "invalid JSON-RPC 2.0 request",
    );
  }
  if (
    params !== undefined &&
    (params === null || typeof params !== "object" || Array.isArray(params))
  ) {
    return replyError(id, -32600, "invalid request: params must be an object");
  }
  // JSON-RPC 2.0: a notification is a request *without* an id member — an
  // explicit "id": null is still a request and gets a response.
  const isNotification = !Object.prototype.hasOwnProperty.call(parsed, "id");
  switch (method) {
    case "initialize": {
      if (isNotification) return null;
      const requested =
        typeof params?.protocolVersion === "string"
          ? params.protocolVersion
          : undefined;
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
      return isNotification
        ? null
        : reply(id, { tools: [ROUTE_TOOL, ...FOLLOW_UP_TOOLS, ...ASK_TOOLS] });
    case "tools/call": {
      if (isNotification) return null;
      const name = typeof params?.name === "string" ? params.name : undefined;
      const rawArgs = params?.arguments;
      if (
        rawArgs !== undefined &&
        (rawArgs === null ||
          typeof rawArgs !== "object" ||
          Array.isArray(rawArgs))
      ) {
        return replyError(id, -32602, "arguments must be an object");
      }
      const args = (rawArgs ?? {}) as Readonly<Record<string, unknown>>;
      try {
        const descriptor = [ROUTE_TOOL, ...FOLLOW_UP_TOOLS, ...ASK_TOOLS].find(
          (tool) => tool.name === name,
        );
        if (descriptor !== undefined) {
          const properties = descriptor.inputSchema.properties as Record<
            string,
            unknown
          >;
          for (const key of Object.keys(args)) {
            if (!Object.hasOwn(properties, key))
              throw new Error(`unknown argument "${key}"`);
          }
        }
        let text: string;
        if (name === "route_request") {
          const utterance = args.utterance;
          if (typeof utterance !== "string" || utterance.trim().length === 0) {
            throw new Error('argument "utterance" must be a non-empty string');
          }
          text = JSON.stringify(
            presentRoute(await routeWithGraph(utterance)),
            null,
            2,
          );
        } else if (
          name === "confirm_route" ||
          name === "answer_clarification"
        ) {
          const utterance = args.utterance;
          const key = name === "confirm_route" ? "projectId" : "answer";
          const answer = args[key];
          if (
            typeof utterance !== "string" ||
            utterance.trim().length === 0 ||
            typeof answer !== "string" ||
            answer.trim().length === 0
          ) {
            throw new Error(
              `arguments "utterance" and "${key}" must be non-empty strings`,
            );
          }
          if (name === "confirm_route") {
            text = JSON.stringify(
              presentRoute(await confirmRoute(utterance, answer)),
              null,
              2,
            );
          } else {
            text = JSON.stringify(
              presentClarification(
                await answerClarification(utterance, answer),
              ),
              null,
              2,
            );
          }
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
      return isNotification
        ? null
        : replyError(id, -32601, `method not found: ${method}`);
  }
}

async function main(): Promise<void> {
  const lines = createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  try {
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      const response = await handleMcpMessage(line);
      if (response !== null) process.stdout.write(`${response}\n`);
    }
  } finally {
    await closeGraph();
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
