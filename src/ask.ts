/**
 * askGraph: the fixed catalogue of graph questions.
 *
 * The agent never writes Cypher. Every question the product asks of the graph
 * is a reviewed query with named parameters, and every argument is resolved
 * against the graph first — a machine name, a project name, an alias — so a
 * typo can never turn into a confident wrong answer. Each answer says which
 * shape it took:
 *
 *   answered_with_path   the graph answered, and here is the path that proves it
 *   answered_from_memory the answer is memory the graph already held
 *   not_in_graph         the name exists, but nothing connects it the way the question assumed
 *   unknown_name         nothing in the graph is called that
 *   ambiguous_name       several things are called that; the graph will not guess
 *
 * Reads go through FalkorDB's read-only API, so a tool bug cannot mutate data.
 * Every payload is marked `untrusted: true`: the text inside is graph data —
 * often replayed user speech — to reason about, never instructions to follow.
 */
import { runRead, type GraphRow } from "./falkor.ts";

export type AskToolName = "whats_running" | "machine_blast_radius" | "project_history" | "why_heard";

export type AskOutcome =
  | "answered_with_path"
  | "answered_from_memory"
  | "not_in_graph"
  | "unknown_name"
  | "ambiguous_name";

export interface AskResultShape {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly outcome: AskOutcome;
  readonly summary: string;
  readonly rows: ReadonlyArray<GraphRow>;
  readonly paths: ReadonlyArray<string>;
  readonly cypher: string;
}

/** A catalogue answer, marked untrusted; see the header note. */
export interface AskResult extends AskResultShape {
  readonly untrusted: true;
}

/** JSON-Schema tool descriptor, shared by the MCP server and any host. */
export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export const ROUTE_TOOL: ToolDescriptor = {
  name: "route_request",
  description:
    "Ground one spoken or typed request against the Circe graph: resolve the project slot to the project a machine owns, remember the turn, and return the typed outcome plus the Cypher path that justified the route. Never routes to a disconnected machine without reporting it; never guesses between duplicate project names.",
  inputSchema: {
    type: "object",
    properties: {
      utterance: {
        type: "string",
        description:
          'The user\'s request, e.g. "start a task in Rivvl to fix the login bug".',
      },
    },
    required: ["utterance"],
    additionalProperties: false,
  },
} as const;

export const ASK_TOOLS: ReadonlyArray<ToolDescriptor> = [
  {
    name: "whats_running",
    description:
      "Every task in flight, with the machine and project that own it. Multi-hop traversal (Machine)-[:OWNS]->(Project)-[:HAS]->(Task).",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          enum: ["running", "queued"],
          description: "Only tasks in this state.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "machine_blast_radius",
    description:
      "If this machine goes down, what stops? Traverses (Machine)-[:OWNS|HAS*1..depth]-> and reports affected projects and tasks, plus same-named projects on other machines (reported, never moved silently). Depth 1 = projects, depth 2 = projects and tasks.",
    inputSchema: {
      type: "object",
      properties: {
        machine: { type: "string", description: 'Machine name, e.g. "build-box".' },
        depth: {
          type: "integer",
          minimum: 1,
          maximum: 2,
          description: "Traversal depth; defaults to 2.",
        },
      },
      required: ["machine"],
      additionalProperties: false,
    },
  },
  {
    name: "project_history",
    description:
      "What the graph already knows about a project: episodes recorded about it, newest first. Answered from memory when episodes exist; says 'not in the graph yet' when the project exists with no episodes. Name the machine when the title exists on several.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: 'Project title, e.g. "Rivvl".' },
        machine: { type: "string", description: 'Machine name to disambiguate duplicate titles.' },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Max episodes; defaults to 5." },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "why_heard",
    description:
      'Why a heard word means a project: the learned alias that connects them, its strength (hint or confirmed), and — for confirmed aliases — the utterance that taught it. Falls back to the plain project title, or reports the name as unknown.',
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: 'The heard text, e.g. "rival".' },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
] as const;

const STATE_VALUES = ["running", "queued"] as const;

function requiredString(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`argument "${key}" must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`argument "${key}" must be a non-empty string`);
  }
  return value.trim();
}

function optionalInteger(
  args: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`argument "${key}" must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

const quoted = (value: string): string => JSON.stringify(value);

/** (machine)-[:OWNS]->(project) [->(:Task ...)] chain, straight from the rows. */
function chainLine(parts: {
  readonly machine: string;
  readonly rels: ReadonlyArray<"OWNS" | "HAS" | "LEARNED_ALIAS">;
  readonly nodes: ReadonlyArray<{ readonly label: "Project" | "Task" | "Alias"; readonly props: string }>;
}): string {
  let line = `(:Machine {name: ${quoted(parts.machine)}})`;
  parts.nodes.forEach((node, index) => {
    line += `-[:${parts.rels[index]}]->(:${node.label} {${node.props}})`;
  });
  return line;
}

interface RunningRow extends GraphRow {
  readonly task: string;
  readonly state: string;
  readonly project: string;
  readonly machine: string;
}

const RUNNING_QUERY = `MATCH (m:Machine)-[:OWNS]->(p:Project)-[:HAS]->(t:Task)
RETURN t.title AS task, t.state AS state, p.title AS project, m.name AS machine
ORDER BY t.state, m.name, t.title`;

const RUNNING_QUERY_BY_STATE = `MATCH (m:Machine)-[:OWNS]->(p:Project)-[:HAS]->(t:Task)
WHERE t.state = $state
RETURN t.title AS task, t.state AS state, p.title AS project, m.name AS machine
ORDER BY m.name, t.title`;

async function whatsRunning(args: Readonly<Record<string, unknown>>): Promise<AskResultShape> {
  const state = optionalString(args, "state");
  if (state !== undefined && !STATE_VALUES.includes(state as (typeof STATE_VALUES)[number])) {
    throw new Error(`argument "state" must be one of: ${STATE_VALUES.join(", ")}`);
  }
  const cypher = state === undefined ? RUNNING_QUERY : RUNNING_QUERY_BY_STATE;
  const rows = await runRead<RunningRow>(cypher, state === undefined ? {} : { state });
  const paths = rows.map((row) =>
    chainLine({
      machine: row.machine,
      rels: ["OWNS", "HAS"],
      nodes: [
        { label: "Project", props: `title: ${quoted(row.project)}` },
        { label: "Task", props: `title: ${quoted(row.task)}, state: ${quoted(row.state)}` },
      ],
    }),
  );
  const described = rows
    .slice(0, 6)
    .map((row) => `${quoted(row.task)} (${row.state}, ${row.project} on ${row.machine})`)
    .join("; ");
  const summary =
    rows.length === 0
      ? state === undefined
        ? "Nothing is running or queued in the graph."
        : `No task is "${state}" in the graph.`
      : `${rows.length} task${rows.length === 1 ? "" : "s"} ${state === undefined ? "in the graph" : `in state "${state}"`}: ${described}.`;
  return {
    tool: "whats_running",
    args: state === undefined ? {} : { state },
    outcome: "answered_with_path",
    summary,
    rows,
    paths,
    cypher,
  };
}

interface MachineRow extends GraphRow {
  readonly id: string;
  readonly name: string;
  readonly connected: boolean;
  readonly reason?: string | null;
}

interface BlastRow extends GraphRow {
  readonly isTask: boolean;
  readonly title: string;
  readonly state?: string | null;
  readonly via: ReadonlyArray<string>;
  readonly nodeLabels: ReadonlyArray<string>;
  readonly rels: ReadonlyArray<string>;
  readonly hops: number;
}

interface MirrorRow extends GraphRow {
  readonly project: string;
  readonly mirrorMachine?: string | null;
  readonly mirrorConnected?: boolean | null;
  readonly mirrorRoot?: string | null;
}

const MACHINE_RESOLVE_QUERY = `MATCH (m:Machine)
WHERE toLower(m.name) = toLower($name)
RETURN m.id AS id, m.name AS name, m.connected AS connected, m.disconnectedReason AS reason`;

const blastQuery = (depth: number): string => `MATCH path = (m:Machine {id: $machineId})-[:OWNS|HAS*1..${depth}]->(x)
RETURN 'Task' IN labels(x) AS isTask, coalesce(x.title, x.name) AS title, x.state AS state,
       [n IN nodes(path) | coalesce(n.name, n.title)] AS via,
       [n IN nodes(path) | CASE WHEN 'Task' IN labels(n) THEN 'Task' ELSE 'Project' END] AS nodeLabels,
       [r IN relationships(path) | type(r)] AS rels,
       length(path) AS hops
ORDER BY hops, title`;

const MIRRORS_QUERY = `MATCH (m:Machine {id: $machineId})-[:OWNS]->(p:Project)
OPTIONAL MATCH (other:Machine)-[:OWNS]->(mirror:Project {title: p.title})
WHERE other.id <> m.id
RETURN p.title AS project, other.name AS mirrorMachine, other.connected AS mirrorConnected,
       mirror.workspaceRoot AS mirrorRoot
ORDER BY project, mirrorMachine`;

async function machineBlastRadius(args: Readonly<Record<string, unknown>>): Promise<AskResultShape> {
  const machineName = requiredString(args, "machine");
  const depth = optionalInteger(args, "depth", 2, 1, 2);
  const resolved = await runRead<MachineRow>(MACHINE_RESOLVE_QUERY, { name: machineName });
  const machine = resolved[0];
  if (machine === undefined) {
    return {
      tool: "machine_blast_radius",
      args: { machine: machineName },
      outcome: "unknown_name",
      summary: `No machine named ${quoted(machineName)} in the graph.`,
      rows: [],
      paths: [],
      cypher: MACHINE_RESOLVE_QUERY,
    };
  }
  const cypher = blastQuery(depth);
  const [rows, mirrorRows] = await Promise.all([
    runRead<BlastRow>(cypher, { machineId: machine.id }),
    runRead<MirrorRow>(MIRRORS_QUERY, { machineId: machine.id }),
  ]);
  const projects = rows.filter((row) => !row.isTask);
  const tasks = rows.filter((row) => row.isTask);
  const mirrors = mirrorRows.filter((row) => typeof row.mirrorMachine === "string");
  const paths: string[] = rows.map((row) => {
    // Walk the actual nodes and relationship types the query returned: the
    // traversal is `[:OWNS|HAS*1..depth]`, so parity-based guessing would
    // render a Machine-[:HAS]->Task shape with the wrong labels.
    const nodes: Array<{ label: "Project" | "Task"; props: string }> = [];
    const rels: Array<"OWNS" | "HAS"> = [];
    for (let index = 1; index < row.via.length; index += 1) {
      const isTask = row.nodeLabels[index] === "Task";
      const name = row.via[index] ?? "?";
      const props =
        isTask && typeof row.state === "string" && index === row.via.length - 1
          ? `title: ${quoted(name)}, state: ${quoted(row.state)}`
          : `title: ${quoted(name)}`;
      nodes.push({ label: isTask ? "Task" : "Project", props });
      rels.push(row.rels[index - 1] === "HAS" ? "HAS" : "OWNS");
    }
    return chainLine({ machine: machine.name, rels, nodes });
  });
  for (const mirror of mirrors) {
    paths.push(
      `${chainLine({
        machine: mirror.mirrorMachine as string,
        rels: ["OWNS"],
        nodes: [{ label: "Project", props: `title: ${quoted(mirror.project)}` }],
      })}   [mirror of ${quoted(machine.name)}'s copy — connected: ${mirror.mirrorConnected === true}]`,
    );
  }
  const mirrorSentence =
    mirrors.length === 0
      ? "No same-named project exists on another machine."
      : mirrors
          .map(
            (mirror) =>
              `${mirror.project} also lives on ${mirror.mirrorMachine} (connected: ${mirror.mirrorConnected === true}) — reported here; nothing is moved silently.`,
          )
          .join(" ");
  if (rows.length === 0) {
    return {
      tool: "machine_blast_radius",
      args: { machine: machine.name, depth },
      outcome: "not_in_graph",
      summary: `Machine ${quoted(machine.name)} exists but owns no projects in the graph — nothing to compute a blast radius over.${
        mirrorSentence === "No same-named project exists on another machine." ? "" : ` ${mirrorSentence}`
      }`,
      rows: [],
      paths,
      cypher,
    };
  }
  const taskSentence =
    tasks.length === 0
      ? "no tasks are attached"
      : tasks
          .map((row) => `${quoted(row.title)} (${row.state ?? "unknown state"})`)
          .join(", ");
  return {
    tool: "machine_blast_radius",
    args: { machine: machine.name, depth },
    outcome: "answered_with_path",
    summary: `If ${quoted(machine.name)} goes down: ${projects.length} project${projects.length === 1 ? "" : "s"} stop${projects.length === 1 ? "s" : ""} (${projects
      .map((row) => quoted(row.title))
      .join(", ")}) and ${taskSentence}. ${mirrorSentence}`,
    rows,
    paths,
    cypher,
  };
}

interface ProjectRow extends GraphRow {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly machine: string;
  readonly connected: boolean;
}

interface HistoryRow extends GraphRow {
  readonly text: string;
  readonly ts: string;
  readonly status?: string | null;
}

const PROJECT_RESOLVE_QUERY = `MATCH (m:Machine)-[:OWNS]->(p:Project)
WHERE toLower(p.title) = toLower($project)
RETURN p.id AS id, p.title AS title, p.workspaceRoot AS workspaceRoot,
       m.name AS machine, m.connected AS connected
ORDER BY machine`;

const PROJECT_HISTORY_QUERY = `MATCH (e:Episode:Memory)-[:ABOUT]->(p:Project {id: $projectId})
RETURN e.text AS text, e.ts AS ts, e.status AS status
ORDER BY e.ts DESC
LIMIT $limit`;

async function projectHistory(args: Readonly<Record<string, unknown>>): Promise<AskResultShape> {
  const project = requiredString(args, "project");
  const machine = optionalString(args, "machine");
  const limit = optionalInteger(args, "limit", 5, 1, 20);
  const resolved = await runRead<ProjectRow>(PROJECT_RESOLVE_QUERY, { project });
  const onMachine =
    machine === undefined
      ? resolved
      : resolved.filter((row) => row.machine.toLocaleLowerCase("en-US") === machine.toLocaleLowerCase("en-US"));
  if (onMachine.length === 0) {
    return {
      tool: "project_history",
      args: { project, ...(machine === undefined ? {} : { machine }), limit },
      outcome: "unknown_name",
      summary:
        machine === undefined
          ? `No project named ${quoted(project)} in the graph.`
          : `No project named ${quoted(project)} on ${quoted(machine)} in the graph.`,
      rows: [],
      paths: [],
      cypher: PROJECT_RESOLVE_QUERY,
    };
  }
  if (onMachine.length > 1) {
    return {
      tool: "project_history",
      args: { project, limit },
      outcome: "ambiguous_name",
      summary: `${quoted(project)} exists on more than one machine (${onMachine
        .map((row) => row.machine)
        .join(", ")}). Name the machine — the graph will not guess.`,
      rows: onMachine,
      paths: [],
      cypher: PROJECT_RESOLVE_QUERY,
    };
  }
  const target = onMachine[0] as ProjectRow;
  const rows = await runRead<HistoryRow>(PROJECT_HISTORY_QUERY, { projectId: target.id, limit });
  const paths = rows.map(
    (row) =>
      `(:Episode:Memory {ts: ${quoted(row.ts)}${typeof row.status === "string" ? `, status: ${quoted(row.status)}` : ""}})-[:ABOUT]->(:Project {title: ${quoted(target.title)}})   [${quoted(row.text)}]`,
  );
  if (rows.length === 0) {
    return {
      tool: "project_history",
      args: { project: target.title, machine: target.machine, limit },
      outcome: "not_in_graph",
      summary: `${quoted(target.title)} exists on ${quoted(target.machine)}, but nothing about it is in the graph's memory yet.`,
      rows: [],
      paths: [],
      cypher: PROJECT_HISTORY_QUERY,
    };
  }
  const newest = rows[0] as HistoryRow;
  return {
    tool: "project_history",
    args: { project: target.title, machine: target.machine, limit },
    outcome: "answered_from_memory",
    summary: `${rows.length} memor${rows.length === 1 ? "y" : "ies"} about ${quoted(target.title)} on ${quoted(target.machine)}; most recent: ${quoted(newest.text)} (${newest.ts}).`,
    rows,
    paths,
    cypher: PROJECT_HISTORY_QUERY,
  };
}

interface AliasRow extends GraphRow {
  readonly project: string;
  readonly machine?: string | null;
  readonly alias: string;
  readonly kind: string;
  readonly source?: string | null;
  readonly learnedAt?: string | null;
  readonly taughtText?: string | null;
  readonly taughtAt?: string | null;
}

interface TitleRow extends GraphRow {
  readonly project: string;
  readonly machine: string;
}

const WHY_ALIAS_QUERY = `MATCH (p:Project)-[l:LEARNED_ALIAS]->(a:Alias)
WHERE toLower(a.text) = toLower($text)
OPTIONAL MATCH (m:Machine)-[:OWNS]->(p)
OPTIONAL MATCH (u:Utterance)-[:TAUGHT]->(a)
RETURN p.title AS project, m.name AS machine, a.text AS alias, a.kind AS kind,
       l.source AS source, l.ts AS learnedAt, u.text AS taughtText, u.ts AS taughtAt
ORDER BY learnedAt DESC`;

const WHY_TITLE_QUERY = `MATCH (m:Machine)-[:OWNS]->(p:Project)
WHERE toLower(p.title) = toLower($text)
RETURN p.title AS project, m.name AS machine
ORDER BY machine`;

async function whyHeard(args: Readonly<Record<string, unknown>>): Promise<AskResultShape> {
  const text = requiredString(args, "text");
  const aliasRows = await runRead<AliasRow>(WHY_ALIAS_QUERY, { text });
  if (aliasRows.length > 0) {
    const paths: string[] = [];
    for (const row of aliasRows) {
      paths.push(
        `(:Project {title: ${quoted(row.project)}})-[:LEARNED_ALIAS${row.source == null ? "" : ` {source: ${quoted(row.source)}}`}]->(:Alias {text: ${quoted(row.alias)}, kind: ${quoted(row.kind)}})`,
      );
      if (typeof row.taughtText === "string") {
        paths.push(
          `(:Utterance {ts: ${quoted(row.taughtAt ?? "")}})-[:TAUGHT]->(:Alias {text: ${quoted(row.alias)}})   [${quoted(row.taughtText)}]`,
        );
      }
    }
    // One heard word can only mean one project; if several own the same text,
    // say so instead of narrating whichever came first.
    const owners = [...new Set(aliasRows.map((row) => row.project))];
    if (owners.length > 1) {
      return {
        tool: "why_heard",
        args: { text },
        outcome: "ambiguous_name",
        summary: `${quoted(text)} maps to ${owners.length} projects (${owners.join(", ")}) — the graph will not guess which one you meant.`,
        rows: aliasRows,
        paths,
        cypher: WHY_ALIAS_QUERY,
      };
    }
    const first = aliasRows[0] as AliasRow;
    const confirmed = first.kind === "confirmed";
    const where = first.machine == null ? "" : ` on ${first.machine}`;
    const taught =
      typeof first.taughtText === "string"
        ? ` Taught by ${quoted(first.taughtText)}${typeof first.taughtAt === "string" ? ` (${first.taughtAt})` : ""}.`
        : "";
    return {
      tool: "why_heard",
      args: { text },
      outcome: confirmed ? "answered_from_memory" : "answered_with_path",
      summary: confirmed
        ? `${quoted(first.alias)} means ${first.project}${where} — a confirmed alias, so the next session resolves it outright.${taught}`
        : `${quoted(first.alias)} means ${first.project}${where} — a learned hint, not yet confirmed. A confirmation makes it stick for good.`,
      rows: aliasRows,
      paths,
      cypher: WHY_ALIAS_QUERY,
    };
  }
  const titleRows = await runRead<TitleRow>(WHY_TITLE_QUERY, { text });
  if (titleRows.length > 0) {
    return {
      tool: "why_heard",
      args: { text },
      outcome: "answered_with_path",
      summary: `${quoted(text)} is a project's plain title (${titleRows
        .map((row) => row.machine)
        .join(", ")}) — no alias needed.`,
      rows: titleRows,
      paths: titleRows.map(
        (row) =>
          chainLine({
            machine: row.machine,
            rels: ["OWNS"],
            nodes: [{ label: "Project", props: `title: ${quoted(row.project)}` }],
          }),
      ),
      cypher: WHY_TITLE_QUERY,
    };
  }
  return {
    tool: "why_heard",
    args: { text },
    outcome: "unknown_name",
    summary: `Nothing in the graph is named ${quoted(text)} — no project, no alias.`,
    rows: [],
    paths: [],
    cypher: WHY_ALIAS_QUERY,
  };
}

/** Run one catalogue tool. Unknown tool names throw; the catalogue is fixed. */
export async function askGraph(
  tool: string,
  args: Readonly<Record<string, unknown>> = {},
): Promise<AskResult> {
  switch (tool) {
    case "whats_running":
      return { ...(await whatsRunning(args)), untrusted: true };
    case "machine_blast_radius":
      return { ...(await machineBlastRadius(args)), untrusted: true };
    case "project_history":
      return { ...(await projectHistory(args)), untrusted: true };
    case "why_heard":
      return { ...(await whyHeard(args)), untrusted: true };
    default:
      throw new Error(
        `unknown tool "${tool}" — the catalogue is fixed: ${ASK_TOOLS.map((entry) => entry.name).join(", ")}`,
      );
  }
}
