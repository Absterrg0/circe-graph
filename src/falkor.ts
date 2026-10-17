/**
 * One FalkorDB connection per process, shared by the catalog, the router, the
 * seed script, the demo, and tests. Nothing in this repo keeps a second copy
 * of the catalog: callers always query the graph.
 */
import "./env.ts";
import { FalkorDB, type Graph } from "falkordb";

export type GraphRow = Record<string, unknown>;

/** Parameter values the falkordb client accepts (mirrors its QueryParam). */
export type CypherValue =
  | null
  | string
  | number
  | boolean
  | CypherValue[]
  | { readonly [key: string]: CypherValue };
export type CypherParams = { [key: string]: CypherValue };

const DEFAULT_GRAPH = "circe";

/** Graph name is environment-driven so tests can run without touching dev data. */
export function graphName(): string {
  if (
    process.env.CIRCE_GRAPH !== undefined &&
    process.env.CIRCE_GRAPH.length > 0
  ) {
    return process.env.CIRCE_GRAPH;
  }
  // Tenant isolation comes free: FalkorDB holds many graphs in one instance,
  // so a tenant is a graph rather than a WHERE clause anyone can forget.
  const tenant = process.env.CIRCE_TENANT;
  return tenant === undefined || tenant.length === 0
    ? DEFAULT_GRAPH
    : `${DEFAULT_GRAPH}:${tenant}`;
}

interface GraphConnection {
  client: Promise<FalkorDB>;
  readonly graphs: Map<string, Graph>;
}

let connection: GraphConnection | undefined;

function connectClient(): GraphConnection {
  if (connection === undefined) {
    const url = process.env.FALKOR_URL;
    const pending = FalkorDB.connect(
      url !== undefined && url.length > 0
        ? { url }
        : {
            socket: {
              host: process.env.FALKOR_HOST ?? "localhost",
              port: Number(process.env.FALKOR_PORT ?? 6379),
              ...(process.env.FALKOR_TLS === "1" ? { tls: true } : {}),
            },
          },
    );
    const next: GraphConnection = { client: pending, graphs: new Map() };
    next.client = pending.catch((error: unknown) => {
      if (connection === next) connection = undefined;
      throw error;
    });
    connection = next;
  }
  return connection;
}

export async function getGraph(): Promise<Graph> {
  const name = graphName();
  const state = connectClient();
  const connected = await state.client;
  let selected = state.graphs.get(name);
  if (selected === undefined) {
    selected = connected.selectGraph(name);
    state.graphs.set(name, selected);
  }
  return selected;
}

/** Await even an in-flight connection; old graph handles stay with that client. */
export async function closeGraph(): Promise<void> {
  const state = connection;
  connection = undefined;
  if (state !== undefined) await (await state.client).close();
}

/**
 * Run one Cypher statement and return its rows. FalkorDB rejects queries with
 * more than one statement, so callers run statements one at a time.
 */
/**
 * A never-created graph rejects every query ("Invalid graph operation on
 * empty key"); one plain read materializes it, then it behaves like any
 * empty graph. Without this, first contact with a fresh tenant would throw
 * a cryptic transport error instead of answering "not in the graph".
 */
const isEmptyGraphError = (error: unknown): boolean =>
  error instanceof Error && /empty key/i.test(error.message);

async function materializeEmptyGraph(selected: Graph): Promise<void> {
  await selected.query("RETURN 1 AS probe");
}

export async function runCypher<T extends object = GraphRow>(
  cypher: string,
  params: CypherParams = {},
): Promise<ReadonlyArray<T>> {
  const selected = await getGraph();
  try {
    const reply = await selected.query<T>(cypher, { params });
    return reply.data ?? [];
  } catch (error) {
    if (!isEmptyGraphError(error)) throw error;
    await materializeEmptyGraph(selected);
    const reply = await selected.query<T>(cypher, { params });
    return reply.data ?? [];
  }
}

/**
 * Read path: every query that does not deliberately write goes through
 * FalkorDB's read-only API, so a bug in a tool cannot mutate the graph.
 */
export async function runRead<T extends object = GraphRow>(
  cypher: string,
  params: CypherParams = {},
): Promise<ReadonlyArray<T>> {
  const selected = await getGraph();
  try {
    const reply = await selected.roQuery<T>(cypher, { params });
    return reply.data ?? [];
  } catch (error) {
    if (!isEmptyGraphError(error)) throw error;
    await materializeEmptyGraph(selected);
    const reply = await selected.roQuery<T>(cypher, { params });
    return reply.data ?? [];
  }
}

const LABEL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Count helper for scripts and tests. The label is interpolated, so it is validated. */
export async function countNodes(label: string): Promise<number> {
  if (!LABEL_PATTERN.test(label)) {
    throw new Error(`countNodes: invalid label ${JSON.stringify(label)}`);
  }
  const rows = await runRead<{ total: number }>(
    `MATCH (n:${label}) RETURN count(n) AS total`,
  );
  return Number(rows[0]?.total ?? 0);
}
