/**
 * routeWithGraph: one spoken turn, grounded against FalkorDB.
 *
 * 1. candidates come from Cypher (catalog.ts) — never from an in-memory array;
 * 2. the copied groundVoiceTurn decides the route with byte-identical
 *    semantics; the graph only supplies candidates;
 * 3. resolved and clarified turns are written back: an (:Utterance) linked to
 *    the resolved (:Project) and an (:Episode:Memory) for the durable record;
 * 4. the turn carries the exact Cypher that justified it, so /why can explain
 *    any route after the fact.
 *
 * A disconnected machine is reported (on the project, and in the route when it
 * is the target) and never silently swapped for another machine's copy of the
 * same project.
 */
import { randomUUID } from "node:crypto";

import type { GraphCandidate, GraphProject } from "./catalog.ts";
import { lookupCandidates } from "./catalog.ts";
import { runCypher, type GraphRow } from "./falkor.ts";
import type { GroundedVoiceTurn } from "./groundVoiceTurn.ts";
import { groundVoiceTurn } from "./groundVoiceTurn.ts";

export interface DisconnectedMachine {
  readonly id: string;
  readonly name: string;
  readonly reason?: string;
}

/** The Cypher this route executed, plus the human-readable MATCH path. */
export interface CypherPath {
  /** The candidate-selection query that ran (exact pass, or catalog fallback). */
  readonly query: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly rows: ReadonlyArray<GraphRow>;
  readonly pass: "exact" | "catalog-fallback";
  /**
   * (machine)-[:OWNS]->(project) [-(:Task)-[:LEARNED_ALIAS]->(:Alias)] chains
   * that justified the route, one per matched project.
   */
  readonly paths: ReadonlyArray<string>;
}

export interface GraphRoute {
  readonly result: GroundedVoiceTurn<GraphProject>;
  readonly cypherPath: CypherPath;
  /** Present when the routed (or pending) project sits on a disconnected machine. */
  readonly disconnectedMachine?: DisconnectedMachine;
}

export interface RouteOptions {
  readonly mode?: "explicit-only" | "explicit-or-inferred";
  readonly confirmedCandidateId?: string;
}

const LOCAL_USER_ID = "user-local";

const PATH_QUERY = `MATCH (m:Machine)-[:OWNS]->(p:Project)
WHERE p.id IN $projectIds
OPTIONAL MATCH (p)-[:HAS]->(t:Task)-[:LEARNED_ALIAS]->(a:Alias)
RETURN p.id AS projectId, m.name AS machineName, m.connected AS machineConnected,
       p.title AS projectTitle, t.title AS taskTitle, a.text AS aliasText`;

const RESOLVED_WRITE_BACK = `MERGE (u:User {id: $userId})
CREATE (ut:Utterance {id: $utteranceId, text: $text, ts: $ts, status: 'resolved', heard: $heard, match: $match})
CREATE (u)-[:SAID]->(ut)
WITH ut
MATCH (p:Project {id: $projectId})
CREATE (ut)-[:RESOLVED_TO {match: $match}]->(p)
CREATE (e:Episode:Memory {id: $episodeId, text: $text, ts: $ts, status: 'resolved'})`;

const CLARIFIED_WRITE_BACK = `MERGE (u:User {id: $userId})
CREATE (ut:Utterance {id: $utteranceId, text: $text, ts: $ts, status: 'needs-clarification', heard: $heard, options: $options})
CREATE (u)-[:SAID]->(ut)
CREATE (e:Episode:Memory {id: $episodeId, text: $text, ts: $ts, status: 'needs-clarification'})`;

interface PathRow extends GraphRow {
  readonly projectId: string;
  readonly machineName: string;
  readonly machineConnected: boolean;
  readonly projectTitle: string;
  readonly taskTitle?: string | null;
  readonly aliasText?: string | null;
}

/** Project ids a result points at: the route's target, or the offered options. */
function matchedProjectIds(result: GroundedVoiceTurn<GraphProject>): string[] {
  switch (result.status) {
    case "resolved":
      return [result.project.id];
    case "needs-confirmation":
      return [result.project.id];
    case "needs-clarification":
      return [...new Set(result.candidates.map(({ project }) => project.id))];
    case "not-mentioned":
      return [];
  }
}

/** Renders `(:Machine {name: "desktop"})-[:OWNS]->(:Project {title: "Rivvl"})` chains. */
async function explainPaths(
  candidates: ReadonlyArray<GraphCandidate>,
  projectIds: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> {
  if (projectIds.length === 0) return [];
  const rows = await runCypher<PathRow>(PATH_QUERY, { projectIds: [...projectIds] });
  const evidenceByProject = new Map(candidates.map((candidate) => [candidate.id, candidate.evidence]));
  type ProjectFacts = {
    machineName: string;
    machineConnected: boolean;
    projectTitle: string;
    aliases: Array<{ task: string; alias: string }>;
  };
  const facts = new Map<string, ProjectFacts>();
  for (const row of rows) {
    const entry = facts.get(row.projectId) ?? {
      machineName: row.machineName,
      machineConnected: row.machineConnected !== false,
      projectTitle: row.projectTitle,
      aliases: [],
    };
    if (typeof row.taskTitle === "string" && typeof row.aliasText === "string") {
      entry.aliases.push({ task: row.taskTitle, alias: row.aliasText });
    }
    facts.set(row.projectId, entry);
  }
  const lines: string[] = [];
  for (const projectId of projectIds) {
    const entry = facts.get(projectId);
    if (entry === undefined) continue;
    const evidence = evidenceByProject.get(projectId);
    let line = `(:Machine {name: ${JSON.stringify(entry.machineName)}})-[:OWNS]->(:Project {title: ${JSON.stringify(entry.projectTitle)}})`;
    const markers: string[] = [];
    if (evidence?.pass === "exact") {
      markers.push(
        evidence.kind === "alias"
          ? `matched learned alias ${JSON.stringify(evidence.matched)}`
          : `matched title ${JSON.stringify(evidence.matched)}`,
      );
      // Only draw the task→alias chain when a learned alias is what matched.
      if (evidence.kind === "alias") {
        for (const { task, alias } of entry.aliases.filter((item) => item.alias === evidence.matched)) {
          line += `-[:HAS]->(:Task {title: ${JSON.stringify(task)}})-[:LEARNED_ALIAS]->(:Alias {text: ${JSON.stringify(alias)}})`;
        }
      }
    }
    if (!entry.machineConnected) markers.push("machine disconnected");
    if (markers.length > 0) line += `   [${markers.join("; ")}]`;
    lines.push(line);
  }
  return lines;
}

/**
 * Durable memory for one turn. Resolved turns link the utterance to the
 * project it resolved to; clarified turns keep the question and the offered
 * options. Pending confirmations and non-mentions write nothing — they are
 * live conversation state, not settled facts.
 */
async function recordTurn(
  utterance: string,
  result: GroundedVoiceTurn<GraphProject>,
): Promise<void> {
  const ts = new Date().toISOString();
  const ids = {
    userId: LOCAL_USER_ID,
    utteranceId: `utterance-${randomUUID()}`,
    episodeId: `episode-${randomUUID()}`,
    text: utterance,
    ts,
  };
  if (result.status === "resolved") {
    await runCypher(RESOLVED_WRITE_BACK, {
      ...ids,
      heard: result.heard,
      match: result.match,
      projectId: result.project.id,
    });
    return;
  }
  if (result.status === "needs-clarification") {
    await runCypher(CLARIFIED_WRITE_BACK, {
      ...ids,
      heard: result.heard,
      options: result.candidates.map(({ label }) => label),
    });
  }
}

function disconnectedTarget(
  result: GroundedVoiceTurn<GraphProject>,
): DisconnectedMachine | undefined {
  if (result.status !== "resolved" && result.status !== "needs-confirmation") return undefined;
  const { machine } = result.project;
  if (machine.connected) return undefined;
  return {
    id: machine.id,
    name: machine.name,
    ...(machine.reason === undefined ? {} : { reason: machine.reason }),
  };
}

/**
 * Ground one spoken utterance against the graph and persist the outcome.
 * `options` passes through to groundVoiceTurn (spoken clarification answers or
 * typed requests use the same code path).
 */
export async function routeWithGraph(
  utterance: string,
  options: RouteOptions = {},
): Promise<GraphRoute> {
  const lookup = await lookupCandidates(utterance);
  const result = groundVoiceTurn({
    utterance,
    candidates: lookup.candidates,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.confirmedCandidateId === undefined
      ? {}
      : { confirmedCandidateId: options.confirmedCandidateId }),
  });
  const paths = await explainPaths(lookup.candidates, matchedProjectIds(result));
  await recordTurn(utterance, result);
  const disconnectedMachine = disconnectedTarget(result);
  return {
    result,
    cypherPath: {
      query: lookup.query,
      params: lookup.params,
      rows: lookup.rows,
      pass: lookup.pass,
      paths,
    },
    ...(disconnectedMachine === undefined ? {} : { disconnectedMachine }),
  };
}
