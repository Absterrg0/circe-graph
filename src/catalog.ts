/**
 * Candidate lookup for spoken turns, served by FalkorDB.
 *
 * This replaces the in-memory `candidates` array the rest of Circe builds
 * today. The graph is the source of truth: the projects machines own, the
 * tasks under them, and learned aliases are read with Cypher — never from a
 * sidecar cache.
 *
 * Two passes:
 *  1. exact: Cypher keeps only projects whose title or learned alias appears
 *     verbatim (normalized) among the utterance's word windows.
 *  2. catalog-fallback: when nothing matches exactly, the full bounded catalog
 *     comes back and groundVoiceTurn's phonetic/edit-distance engine decides.
 *     Fuzzy scoring lives in exactly one place — the copied core — so the
 *     graph can never disagree with the core about what a name sounds like.
 */
import type { VoiceProjectCandidate } from "./groundVoiceTurn.ts";
import { runCypher, type GraphRow } from "./falkor.ts";

export interface GraphMachine {
  readonly id: string;
  readonly name: string;
  readonly connected: boolean;
  readonly reason?: string;
}

export interface GraphProject {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly machine: GraphMachine;
}

/** How the graph put this candidate in front of groundVoiceTurn. */
export type CandidateEvidence =
  | { readonly pass: "exact"; readonly kind: "title" | "alias"; readonly matched: string }
  | { readonly pass: "catalog-fallback" };

/**
 * A VoiceProjectCandidate (so it drops straight into groundVoiceTurn input)
 * plus the graph evidence for /why.
 */
export interface GraphCandidate extends VoiceProjectCandidate<GraphProject> {
  readonly evidence: CandidateEvidence;
}

export interface CandidateLookup {
  readonly candidates: ReadonlyArray<GraphCandidate>;
  readonly query: string;
  readonly params: Record<string, unknown>;
  readonly rows: ReadonlyArray<CatalogRow>;
  readonly pass: "exact" | "catalog-fallback";
}

interface CatalogRow extends GraphRow {
  readonly machineId: string;
  readonly machineName: string;
  readonly machineConnected: boolean;
  readonly machineReason?: string | null;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly workspaceRoot: string;
  readonly aliasNames?: ReadonlyArray<string | null> | null;
}

/** Longest name a single window can span; learned aliases are short. */
const MAX_WINDOW_WORDS = 4;

const normalize = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");

/**
 * Every consecutive 1..4 word window of the utterance, normalized. "start a
 * task in rival" yields windows such as "rival" and "task in rival"; exact
 * matching then asks the graph whether any title or alias equals a window.
 */
export function heardWindows(heard: string): string[] {
  const words = [...heard.matchAll(/[\p{Letter}\p{Number}]+/gu)].map((match) => normalize(match[0]));
  const windows = new Set<string>();
  for (let start = 0; start < words.length; start += 1) {
    for (let length = 1; length <= MAX_WINDOW_WORDS && start + length <= words.length; length += 1) {
      windows.add(words.slice(start, start + length).join(" "));
    }
  }
  return [...windows];
}

/** Machine → Project → Task → Alias rows; `aliasNames` is folded lowercase. */
const CATALOG_FROM = `MATCH (m:Machine)-[:OWNS]->(p:Project)
OPTIONAL MATCH (p)-[:HAS]->(:Task)-[:LEARNED_ALIAS]->(a:Alias)
WITH m, p, collect(DISTINCT toLower(a.text)) AS aliasNames`;

const CATALOG_SELECT = `RETURN m.id AS machineId, m.name AS machineName, m.connected AS machineConnected,
       m.disconnectedReason AS machineReason, p.id AS projectId, p.title AS projectTitle,
       p.workspaceRoot AS workspaceRoot, aliasNames
ORDER BY machineName, projectTitle`;

const EXACT_CANDIDATES_QUERY = `${CATALOG_FROM}
WHERE toLower(p.title) IN $windows OR any(alias IN aliasNames WHERE alias IN $windows)
${CATALOG_SELECT}`;

const FULL_CATALOG_QUERY = `${CATALOG_FROM}
${CATALOG_SELECT}`;

function toCandidate(row: CatalogRow, windows: ReadonlyArray<string>): GraphCandidate {
  const title = row.projectTitle;
  const aliases = (row.aliasNames ?? []).filter(
    (alias): alias is string => typeof alias === "string" && alias.length > 0,
  );
  const titleWindow = windows.find((window) => window === normalize(title));
  const aliasWindow =
    titleWindow === undefined ? windows.find((window) => aliases.includes(window)) : undefined;
  const evidence: CandidateEvidence =
    titleWindow !== undefined
      ? { pass: "exact", kind: "title", matched: titleWindow }
      : aliasWindow !== undefined
        ? { pass: "exact", kind: "alias", matched: aliasWindow }
        : { pass: "catalog-fallback" };
  return {
    id: row.projectId,
    title,
    // Duplicate titles (Portfolio on two machines) make the label the
    // clarification text, so it always says which machine owns the copy.
    label: `${title} on ${row.machineName}`,
    names: [title],
    project: {
      id: row.projectId,
      title,
      workspaceRoot: row.workspaceRoot,
      machine: {
        id: row.machineId,
        name: row.machineName,
        connected: row.machineConnected !== false,
        ...(typeof row.machineReason === "string" && row.machineReason.length > 0
          ? { reason: row.machineReason }
          : {}),
      },
    },
    evidence,
  };
}

/**
 * Candidates plus the exact Cypher that produced them, for /why explainability.
 */
export async function lookupCandidates(heard: string): Promise<CandidateLookup> {
  const windows = heardWindows(heard);
  const exactRows = await runCypher<CatalogRow>(EXACT_CANDIDATES_QUERY, { windows });
  if (exactRows.length > 0) {
    return {
      candidates: exactRows.map((row) => toCandidate(row, windows)),
      query: EXACT_CANDIDATES_QUERY,
      params: { windows },
      rows: exactRows,
      pass: "exact",
    };
  }
  const catalogRows = await runCypher<CatalogRow>(FULL_CATALOG_QUERY);
  return {
    candidates: catalogRows.map((row) => toCandidate(row, [])),
    query: FULL_CATALOG_QUERY,
    params: {},
    rows: catalogRows,
    pass: "catalog-fallback",
  };
}

/**
 * The candidates for one spoken turn, shaped for groundVoiceTurn's input.
 * Async because the catalog lives in FalkorDB; the returned items are plain
 * VoiceProjectCandidates.
 */
export async function getCandidates(heard: string): Promise<GraphCandidate[]> {
  return [...(await lookupCandidates(heard)).candidates];
}
