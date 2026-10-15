/**
 * routeWithGraph: one spoken turn, grounded and remembered.
 *
 * 1. candidates come from Cypher (catalog.ts) — never from an in-memory array;
 * 2. the copied groundVoiceTurn decides the route with byte-identical
 *    semantics; the graph only supplies candidates plus the memory it holds;
 * 3. resolved, clarified, and answered turns are written back: the utterance,
 *    the project it resolved to, an episode ABOUT that project, and — when the
 *    user confirmed a pronunciation — a confirmed alias, so the next session
 *    resolves the same mishearing without asking (the graph learns);
 * 4. every route carries the Cypher that justified it, the MATCH path, and the
 *    memory the graph already held about the target before this turn ran;
 * 5. the outcome is typed: answered with a path, answered from memory, needs
 *    confirmation, needs clarification, not in the graph, or no project named.
 *
 * A disconnected machine is reported (on the project, and in the route when it
 * is the target) and never silently swapped for another machine's copy.
 */
import { randomUUID } from "node:crypto";

import type { CandidateEvidence, GraphCandidate, GraphProject } from "./catalog.ts";
import { lookupCandidates, normalizeName } from "./catalog.ts";
import { runCypher, runRead, type GraphRow } from "./falkor.ts";
import type { GroundedVoiceTurn } from "./groundVoiceTurn.ts";
import { groundVoiceTurn } from "./groundVoiceTurn.ts";
import type { CirceProjectChoiceMatch } from "./projectChoice.ts";
import { resolveCirceProjectChoice } from "./projectChoice.ts";

export interface DisconnectedMachine {
  readonly id: string;
  readonly name: string;
  readonly reason?: string;
}

/** See the six shapes below; the answer never pretends to be another shape. */
export type RouteOutcome =
  | "answered_with_path"
  | "answered_from_memory"
  | "needs_confirmation"
  | "needs_clarification"
  | "not_in_graph"
  | "no_project_named";

/** One episode the graph remembered about a project. */
export interface MemoryNote {
  readonly projectId: string;
  readonly text: string;
  readonly ts: string;
}

/** What an identical ambiguous phrase meant the last time it was answered. */
export interface LastMeant {
  readonly heard: string;
  readonly projectId: string;
  readonly label: string;
  readonly ts: string;
}

/** Set when this turn taught the graph a confirmed pronunciation. */
export interface LearnedAlias {
  readonly text: string;
  readonly projectId: string;
  readonly utteranceId: string;
}

/**
 * The Cypher this route executed, plus the human-readable MATCH path.
 * Aliases are project-anchored: the path shows which project a mishearing
 * means and — for confirmed aliases — which utterance taught it.
 */
export interface CypherPath {
  /** The candidate-selection query that ran (exact pass, or catalog fallback). */
  readonly query: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly rows: ReadonlyArray<GraphRow>;
  readonly pass: "exact" | "catalog-fallback";
  /**
   * (machine)-[:OWNS]->(project) chains that justified the route, one per
   * matched project, with the alias hop (and its provenance) when a learned
   * alias is what matched.
   */
  readonly paths: ReadonlyArray<string>;
}

export interface GraphRoute {
  readonly outcome: RouteOutcome;
  readonly result: GroundedVoiceTurn<GraphProject>;
  readonly cypherPath: CypherPath;
  /** Episodes the graph already held about the routed (or pending) project. */
  readonly memory: ReadonlyArray<MemoryNote>;
  /** For a repeated ambiguity: what this exact phrase meant last time. */
  readonly lastMeant?: LastMeant;
  /** Set when this turn taught the graph a confirmed pronunciation. */
  readonly learned?: LearnedAlias;
  /** Present when the routed (or pending) project sits on a disconnected machine. */
  readonly disconnectedMachine?: DisconnectedMachine;
}

export interface RouteOptions {
  readonly mode?: "explicit-only" | "explicit-or-inferred";
  readonly confirmedCandidateId?: string;
}

const LOCAL_USER_ID = "user-local";
const MEMORY_NOTES_PER_PROJECT = 3;

const PATH_QUERY = `MATCH (m:Machine)-[:OWNS]->(p:Project)
WHERE p.id IN $projectIds
OPTIONAL MATCH (p)-[l:LEARNED_ALIAS]->(a:Alias)
OPTIONAL MATCH (u:Utterance)-[:TAUGHT]->(a)
RETURN p.id AS projectId, m.name AS machineName, m.connected AS machineConnected,
       p.title AS projectTitle, a.text AS aliasText, a.kind AS aliasKind, l.source AS aliasSource,
       u.text AS taughtText, u.ts AS taughtAt`;

const MEMORY_RECALL_QUERY = `MATCH (e:Episode:Memory)-[:ABOUT]->(p:Project)
WHERE p.id IN $projectIds
RETURN p.id AS projectId, e.text AS text, e.ts AS ts
ORDER BY e.ts DESC`;

const LAST_MEANT_QUERY = `MATCH (h:Heard {text: $heard})-[l:LAST_MEANT]->(p:Project)
OPTIONAL MATCH (m:Machine)-[:OWNS]->(p)
RETURN p.id AS projectId, p.title AS projectTitle, m.name AS machineName, l.ts AS ts
ORDER BY l.ts DESC
LIMIT 1`;

const RESOLVED_WRITE_BACK = `MERGE (u:User {id: $userId})
CREATE (ut:Utterance {id: $utteranceId, text: $text, ts: $ts, status: 'resolved', heard: $heard, match: $match})
CREATE (u)-[:SAID]->(ut)
WITH ut
MATCH (p:Project {id: $projectId})
CREATE (ut)-[:RESOLVED_TO {match: $match}]->(p)
CREATE (e:Episode:Memory {id: $episodeId, text: $text, ts: $ts, status: 'resolved'})
CREATE (e)-[:ABOUT]->(p)`;

const CLARIFIED_WRITE_BACK = `MERGE (u:User {id: $userId})
CREATE (ut:Utterance {id: $utteranceId, text: $text, ts: $ts, status: 'needs-clarification', heard: $heard, options: $options})
CREATE (u)-[:SAID]->(ut)
CREATE (e:Episode:Memory {id: $episodeId, text: $text, ts: $ts, status: 'needs-clarification'})`;

// A clarification answer is a resolution: it resolves the utterance, records
// the episode, and remembers what this phrase meant (LAST_MEANT) so the next
// identical ask can show the user their own precedent.
const ANSWER_WRITE_BACK = `MERGE (u:User {id: $userId})
CREATE (ut:Utterance {id: $utteranceId, text: $text, ts: $ts, status: 'clarified', heard: $heard, answer: $answer, answerKind: $answerKind})
CREATE (u)-[:SAID]->(ut)
WITH ut
MATCH (p:Project {id: $projectId})
CREATE (ut)-[:RESOLVED_TO {match: $answerKind}]->(p)
CREATE (e:Episode:Memory {id: $episodeId, text: $text, ts: $ts, status: 'resolved', answer: $answer})
CREATE (e)-[:ABOUT]->(p)
MERGE (h:Heard {text: $heardText})
CREATE (h)-[:LAST_MEANT {ts: $ts}]->(p)`;

const LEARN_ALIAS_WRITE = `MATCH (p:Project {id: $projectId})
MATCH (ut:Utterance {id: $utteranceId})
MERGE (a:Alias {text: $text})
ON CREATE SET a.id = $aliasId, a.kind = 'confirmed', a.ts = $ts
ON MATCH SET a.kind = 'confirmed'
MERGE (p)-[l:LEARNED_ALIAS]->(a)
ON CREATE SET l.source = 'confirmation', l.ts = $ts
MERGE (ut)-[:TAUGHT]->(a)`;

interface PathRow extends GraphRow {
  readonly projectId: string;
  readonly machineName: string;
  readonly machineConnected: boolean;
  readonly projectTitle: string;
  readonly aliasText?: string | null;
  readonly aliasKind?: string | null;
  readonly aliasSource?: string | null;
  readonly taughtText?: string | null;
  readonly taughtAt?: string | null;
}

interface RecallRow extends GraphRow {
  readonly projectId: string;
  readonly text: string;
  readonly ts: string;
}

interface LastMeantRow extends GraphRow {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly machineName?: string | null;
  readonly ts: string;
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

/**
 * Read before you reason: the episodes the graph already holds about these
 * projects, newest first, at most three per project.
 */
async function recallMemory(projectIds: ReadonlyArray<string>): Promise<ReadonlyArray<MemoryNote>> {
  const unique = [...new Set(projectIds)];
  if (unique.length === 0) return [];
  const rows = await runRead<RecallRow>(MEMORY_RECALL_QUERY, { projectIds: unique });
  const perProject = new Map<string, MemoryNote[]>();
  for (const row of rows) {
    const notes = perProject.get(row.projectId) ?? [];
    if (notes.length < MEMORY_NOTES_PER_PROJECT) {
      notes.push({ projectId: row.projectId, text: row.text, ts: row.ts });
      perProject.set(row.projectId, notes);
    }
  }
  return [...perProject.values()].flat();
}

/** What this exact phrase meant the last time a clarification answered it. */
async function lastMeantFor(heard: string): Promise<LastMeant | undefined> {
  const text = normalizeName(heard);
  if (text.length === 0) return undefined;
  const rows = await runRead<LastMeantRow>(LAST_MEANT_QUERY, { heard: text });
  const row = rows[0];
  if (row === undefined) return undefined;
  const label =
    row.machineName == null ? row.projectTitle : `${row.projectTitle} on ${row.machineName}`;
  return { heard: text, projectId: row.projectId, label, ts: row.ts };
}

type AliasFact = {
  readonly text: string;
  readonly kind: string;
  readonly source?: string;
  readonly taughtText?: string;
  readonly taughtAt?: string;
};

type ProjectFacts = {
  readonly machineName: string;
  readonly machineConnected: boolean;
  readonly projectTitle: string;
  readonly aliases: AliasFact[];
};

/** Renders `(:Machine {name: "desktop"})-[:OWNS]->(:Project {title: "Rivvl"})` chains. */
async function explainPaths(
  candidates: ReadonlyArray<GraphCandidate>,
  projectIds: ReadonlyArray<string>,
  context: { readonly confirmedThisCall: boolean },
): Promise<ReadonlyArray<string>> {
  if (projectIds.length === 0) return [];
  const rows = await runRead<PathRow>(PATH_QUERY, { projectIds: [...projectIds] });
  const evidenceByProject = new Map<string, CandidateEvidence>(
    candidates.map((candidate) => [candidate.id, candidate.evidence]),
  );
  const facts = new Map<string, ProjectFacts>();
  for (const row of rows) {
    const entry = facts.get(row.projectId) ?? {
      machineName: row.machineName,
      machineConnected: row.machineConnected !== false,
      projectTitle: row.projectTitle,
      aliases: [],
    };
    if (
      typeof row.aliasText === "string" &&
      !entry.aliases.some((alias) => alias.text === row.aliasText)
    ) {
      entry.aliases.push({
        text: row.aliasText,
        kind: typeof row.aliasKind === "string" ? row.aliasKind : "hint",
        ...(typeof row.aliasSource === "string" ? { source: row.aliasSource } : {}),
        ...(typeof row.taughtText === "string" ? { taughtText: row.taughtText } : {}),
        ...(typeof row.taughtAt === "string" ? { taughtAt: row.taughtAt } : {}),
      });
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
      if (evidence.kind === "alias") {
        const alias = entry.aliases.find((item) => item.text === evidence.matched);
        const aliasKind = alias?.kind === "confirmed" ? "confirmed" : "hint";
        line += `-[:LEARNED_ALIAS${alias?.source === undefined ? "" : ` {source: ${JSON.stringify(alias.source)}}`}]->(:Alias {text: ${JSON.stringify(evidence.matched)}, kind: ${JSON.stringify(aliasKind)}})`;
        markers.push(
          aliasKind === "confirmed"
            ? context.confirmedThisCall
              ? `matched alias ${JSON.stringify(evidence.matched)} (confirmed just now)`
              : `matched confirmed alias ${JSON.stringify(evidence.matched)} (answered from memory)`
            : `matched learned alias ${JSON.stringify(evidence.matched)} (hint, unconfirmed)`,
        );
      } else {
        markers.push(`matched title ${JSON.stringify(evidence.matched)}`);
      }
    }
    if (!entry.machineConnected) markers.push("machine disconnected");
    if (markers.length > 0) line += `   [${markers.join("; ")}]`;
    lines.push(line);
  }
  return lines;
}

interface TurnIds {
  readonly userId: string;
  readonly utteranceId: string;
  readonly episodeId: string;
  readonly ts: string;
}

/**
 * Durable memory for one turn. Resolved turns link the utterance to the
 * project it resolved to and record an episode ABOUT it; clarified turns keep
 * the question and the offered options. Pending confirmations and non-mentions
 * write nothing — they are live conversation state, not settled facts.
 */
async function recordTurn(
  utterance: string,
  result: GroundedVoiceTurn<GraphProject>,
  ids: TurnIds,
): Promise<void> {
  const base = { ...ids, text: utterance };
  if (result.status === "resolved") {
    await runCypher(RESOLVED_WRITE_BACK, {
      ...base,
      heard: result.heard,
      match: result.match,
      projectId: result.project.id,
    });
    return;
  }
  if (result.status === "needs-clarification") {
    await runCypher(CLARIFIED_WRITE_BACK, {
      ...base,
      heard: result.heard,
      options: result.candidates.map(({ label }) => label),
    });
  }
}

/**
 * Learning: a confirmation is evidence. The heard phrasing becomes a
 * confirmed alias of the project — semantic memory the next session reads
 * before it reasons, so the same request resolves outright.
 */
async function learnConfirmedAlias(input: {
  readonly heard: string;
  readonly projectId: string;
  readonly utteranceId: string;
}): Promise<LearnedAlias | undefined> {
  const text = normalizeName(input.heard);
  if (text.length < 3) return undefined;
  const titles = await runRead<{ folded: string }>(
    "MATCH (p:Project {id: $projectId}) RETURN toLower(p.title) AS folded",
    { projectId: input.projectId },
  );
  // The canonical title already routes exactly; confirming it teaches nothing.
  if (titles[0]?.folded === text) return undefined;
  const ts = new Date().toISOString();
  await runCypher(LEARN_ALIAS_WRITE, {
    projectId: input.projectId,
    utteranceId: input.utteranceId,
    text,
    aliasId: `alias-${randomUUID()}`,
    ts,
  });
  return { text, projectId: input.projectId, utteranceId: input.utteranceId };
}

/**
 * The six answer shapes. The graph's two clarification prompts are distinct in
 * the graph's terms: "More than one project matches" offers real options,
 * while "I couldn't match" means the spoken name is not in the graph at all.
 */
function classifyOutcome(
  result: GroundedVoiceTurn<GraphProject>,
  candidates: ReadonlyArray<GraphCandidate>,
  confirmedThisCall: boolean,
): RouteOutcome {
  switch (result.status) {
    case "resolved": {
      const evidence = candidates.find((candidate) => candidate.id === result.project.id)?.evidence;
      const fromMemory =
        !confirmedThisCall &&
        evidence?.pass === "exact" &&
        evidence.kind === "alias" &&
        evidence.aliasKind === "confirmed";
      return fromMemory ? "answered_from_memory" : "answered_with_path";
    }
    case "needs-confirmation":
      return "needs_confirmation";
    case "needs-clarification":
      return result.prompt.startsWith("I couldn't match") ? "not_in_graph" : "needs_clarification";
    case "not-mentioned":
      return "no_project_named";
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
  const confirmedThisCall = options.confirmedCandidateId !== undefined;
  const projectIds = matchedProjectIds(result);
  const [paths, memory] = await Promise.all([
    explainPaths(lookup.candidates, projectIds, { confirmedThisCall }),
    recallMemory(projectIds),
  ]);
  const ids: TurnIds = {
    userId: LOCAL_USER_ID,
    utteranceId: `utterance-${randomUUID()}`,
    episodeId: `episode-${randomUUID()}`,
    ts: new Date().toISOString(),
  };
  await recordTurn(utterance, result, ids);

  let learned: LearnedAlias | undefined;
  if (confirmedThisCall && result.status === "resolved" && result.match === "confirmed-pronunciation") {
    learned = await learnConfirmedAlias({
      heard: result.heard,
      projectId: result.project.id,
      utteranceId: ids.utteranceId,
    });
  }
  const lastMeant = result.status === "needs-clarification" ? await lastMeantFor(result.heard) : undefined;
  const disconnectedMachine = disconnectedTarget(result);
  return {
    outcome: classifyOutcome(result, lookup.candidates, confirmedThisCall),
    result,
    cypherPath: {
      query: lookup.query,
      params: lookup.params,
      rows: lookup.rows,
      pass: lookup.pass,
      paths,
    },
    memory,
    ...(lastMeant === undefined ? {} : { lastMeant }),
    ...(learned === undefined ? {} : { learned }),
    ...(disconnectedMachine === undefined ? {} : { disconnectedMachine }),
  };
}

export interface ClarificationAnswer {
  readonly resolved: boolean;
  readonly reason?: "not-a-clarification" | "no-match";
  /** What the router asked (a needs-clarification turn), re-grounded deterministically. */
  readonly pending: GroundedVoiceTurn<GraphProject>;
  readonly project?: GraphProject;
  readonly matchKind?: CirceProjectChoiceMatch["kind"];
  readonly matchedText?: string;
  readonly memory: ReadonlyArray<MemoryNote>;
  readonly cypherPath: CypherPath;
}

/**
 * Answer a pending clarification with the user's spoken choice. The copied
 * projectChoice matcher decides which option the answer selects; the machine
 * name ("the laptop one") is legitimate disambiguation vocabulary and enters
 * only this matcher — groundVoiceTurn never sees it. A resolved answer is
 * written back, and the phrase remembers what it meant (LAST_MEANT), so the
 * next identical ask shows the user their own precedent instead of forgetting.
 */
export async function answerClarification(
  utterance: string,
  answer: string,
): Promise<ClarificationAnswer> {
  const lookup = await lookupCandidates(utterance);
  const pending = groundVoiceTurn({ utterance, candidates: lookup.candidates });
  const lookupPath: CypherPath = {
    query: lookup.query,
    params: lookup.params,
    rows: lookup.rows,
    pass: lookup.pass,
    paths: [],
  };
  if (pending.status !== "needs-clarification") {
    return { resolved: false, reason: "not-a-clarification", pending, memory: [], cypherPath: lookupPath };
  }
  const offered = pending.candidates.map(({ project, label }) => {
    const full = lookup.candidates.find((candidate) => candidate.id === project.id);
    return {
      title: project.title,
      label,
      names: [...(full?.names ?? [project.title]), project.machine.name],
    };
  });
  const match = resolveCirceProjectChoice({
    answer,
    candidates: offered,
    acceptsAffirmation: offered.length === 1,
  });
  if (match === null) {
    return {
      resolved: false,
      reason: "no-match",
      pending,
      memory: await recallMemory(pending.candidates.map(({ project }) => project.id)),
      cypherPath: lookupPath,
    };
  }
  const offeredProject = pending.candidates[match.index]?.project;
  const chosen = lookup.candidates.find((candidate) => candidate.id === offeredProject?.id);
  if (chosen === undefined) {
    return { resolved: false, reason: "no-match", pending, memory: [], cypherPath: lookupPath };
  }
  const ids: TurnIds = {
    userId: LOCAL_USER_ID,
    utteranceId: `utterance-${randomUUID()}`,
    episodeId: `episode-${randomUUID()}`,
    ts: new Date().toISOString(),
  };
  await runCypher(ANSWER_WRITE_BACK, {
    ...ids,
    text: utterance,
    heard: pending.heard,
    heardText: normalizeName(pending.heard),
    answer,
    answerKind: match.kind,
    projectId: chosen.id,
  });
  const [memory, paths] = await Promise.all([
    recallMemory([chosen.id]),
    explainPaths(lookup.candidates, [chosen.id], { confirmedThisCall: false }),
  ]);
  return {
    resolved: true,
    pending,
    project: chosen.project,
    matchKind: match.kind,
    matchedText: match.matchedText,
    memory,
    cypherPath: { ...lookupPath, paths },
  };
}

/**
 * Convenience for hosts: the user said yes to "Did you mean X?". Re-grounds
 * the utterance with the confirmed candidate; routeWithGraph then persists
 * the turn *and teaches the graph the pronunciation for future sessions*.
 */
export async function confirmRoute(
  utterance: string,
  projectId: string,
): Promise<GraphRoute> {
  return routeWithGraph(utterance, { confirmedCandidateId: projectId });
}
