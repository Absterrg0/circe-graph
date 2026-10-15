/**
 * One FalkorDB connection per process, shared by the catalog, the router, the
 * seed script, the demo, and tests. Nothing in this repo keeps a second copy
 * of the catalog: callers always query the graph.
 */
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
  if (process.env.CIRCE_GRAPH !== undefined && process.env.CIRCE_GRAPH.length > 0) {
    return process.env.CIRCE_GRAPH;
  }
  // Tenant isolation comes free: FalkorDB holds many graphs in one instance,
  // so a tenant is a graph rather than a WHERE clause anyone can forget.
  const tenant = process.env.CIRCE_TENANT;
  return tenant === undefined || tenant.length === 0 ? DEFAULT_GRAPH : `${DEFAULT_GRAPH}:${tenant}`;
}

let client: FalkorDB | undefined;
let graph: Graph | undefined;

async function connectClient(): Promise<FalkorDB> {
  if (client === undefined) {
    // FALKOR_URL (e.g. a FalkorDB Cloud rediss:// URL) wins when present;
    // otherwise host/port, with FALKOR_TLS=1 to wrap the socket in TLS.
    const url = process.env.FALKOR_URL;
    client =
      url !== undefined && url.length > 0
        ? await FalkorDB.connect({ url })
        : await FalkorDB.connect({
            socket: {
              host: process.env.FALKOR_HOST ?? "localhost",
              port: Number(process.env.FALKOR_PORT ?? 6379),
              ...(process.env.FALKOR_TLS === "1" ? { tls: true } : {}),
            },
          });
  }
  return client;
}

export async function getGraph(): Promise<Graph> {
  if (graph === undefined) {
    const connected = await connectClient();
    graph = connected.selectGraph(graphName());
  }
  return graph;
}

/** Close the socket so scripts exit cleanly; tests call this in afterAll. */
export async function closeGraph(): Promise<void> {
  graph = undefined;
  const connected = client;
  client = undefined;
  if (connected !== undefined) await connected.close();
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
  const rows = await runRead<{ total: number }>(`MATCH (n:${label}) RETURN count(n) AS total`);
  return Number(rows[0]?.total ?? 0);
}
