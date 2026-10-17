/**
 * Candidate lookup for spoken turns, served by FalkorDB.
 *
 * This replaces the in-memory `candidates` array the rest of Circe builds
 * today. The graph is the source of truth: the projects machines own and their
 * learned aliases are read with Cypher — never from a sidecar cache.
 *
 * Two passes:
 *  1. exact: Cypher keeps only projects whose title or learned alias appears
 *     verbatim (normalized) among the utterance's word windows.
 *  2. catalog-fallback: when nothing matches exactly, the full bounded catalog
 *     comes back and groundVoiceTurn's phonetic/edit-distance engine decides.
 *     Fuzzy scoring lives in exactly one place — the copied core — so the
 *     graph can never disagree with the core about what a name sounds like.
 *
 * Aliases come in two strengths (see seedGraph.ts): "hint" aliases gate recall
 * only, so the core still reports an honest near match; "confirmed" aliases —
 * taught by a real confirmation — also join the candidate's `names`, so the
 * next session resolves them outright with a confirmed-pronunciation match.
 */
import {
  locateProjectSlot,
  type VoiceProjectCandidate,
} from "./groundVoiceTurn.ts";
import { runRead, type GraphRow } from "./falkor.ts";

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
  | { readonly pass: "exact"; readonly kind: "title"; readonly matched: string }
  | {
      readonly pass: "exact";
      readonly kind: "alias";
      readonly matched: string;
      /** hint = heard once, gates recall; confirmed = the user said yes. */
      readonly aliasKind: "hint" | "confirmed";
    }
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
  readonly aliasWindows?: ReadonlyArray<string | null> | null;
  readonly confirmedNames?: ReadonlyArray<string | null> | null;
}

/** Longest name a single window can span; learned aliases are short. */
const MAX_WINDOW_WORDS = 4;

/** Folding used for every name comparison, in the graph and in memory. */
export const normalizeName = (value: string): string =>
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
  const words = [...heard.matchAll(/[\p{Letter}\p{Number}]+/gu)].map((match) =>
    normalizeName(match[0]),
  );
  const windows = new Set<string>();
  for (let start = 0; start < words.length; start += 1) {
    for (
      let length = 1;
      length <= MAX_WINDOW_WORDS && start + length <= words.length;
      length += 1
    ) {
      windows.add(words.slice(start, start + length).join(" "));
    }
  }
  return [...windows];
}

/**
 * Machine → Project → Alias rows. `aliasWindows` is every alias folded
 * lowercase (recall gate); `confirmedNames` is only confirmed aliases, in
 * their original spelling (they join the candidate's `names`).
 */
const CATALOG_FROM = `MATCH (m:Machine)-[:OWNS]->(p:Project)
OPTIONAL MATCH (p)-[:LEARNED_ALIAS]->(a:Alias)
WITH m, p, collect(DISTINCT toLower(a.text)) AS aliasWindows,
     collect(DISTINCT CASE WHEN a.kind = 'confirmed' THEN a.text END) AS confirmedNames`;

const CATALOG_SELECT = `RETURN m.id AS machineId, m.name AS machineName, m.connected AS machineConnected,
       m.disconnectedReason AS machineReason, p.id AS projectId, p.title AS projectTitle,
       p.workspaceRoot AS workspaceRoot, aliasWindows, confirmedNames
ORDER BY machineName, projectTitle`;

const EXACT_CANDIDATES_QUERY = `${CATALOG_FROM}
WHERE toLower(p.title) IN $windows OR any(alias IN aliasWindows WHERE alias IN $windows)
${CATALOG_SELECT}`;

const FULL_CATALOG_QUERY = `${CATALOG_FROM}
${CATALOG_SELECT}`;

const asStrings = (
  values: ReadonlyArray<string | null> | null | undefined,
): string[] =>
  (values ?? []).filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

function toCandidate(
  row: CatalogRow,
  windows: ReadonlyArray<string>,
): GraphCandidate {
  const title = row.projectTitle;
  const aliasWindows = asStrings(row.aliasWindows).map(normalizeName);
  // A confirmed alias is part of how this project is named; a hint is not.
  const confirmedNames = asStrings(row.confirmedNames).filter(
    (name) => normalizeName(name) !== normalizeName(title),
  );
  const titleWindow = windows.find((window) => window === normalizeName(title));
  const aliasWindow =
    titleWindow === undefined
      ? windows.find((window) => aliasWindows.includes(window))
      : undefined;
  const evidence: CandidateEvidence =
    titleWindow !== undefined
      ? { pass: "exact", kind: "title", matched: titleWindow }
      : aliasWindow !== undefined
        ? {
            pass: "exact",
            kind: "alias",
            matched: aliasWindow,
            aliasKind: confirmedNames.some(
              (name) => normalizeName(name) === aliasWindow,
            )
              ? "confirmed"
              : "hint",
          }
        : { pass: "catalog-fallback" };
  return {
    id: row.projectId,
    title,
    // Duplicate titles (Portfolio on two machines) make the label the
    // clarification text, so it always says which machine owns the copy.
    label: `${title} on ${row.machineName}`,
    names: [title, ...confirmedNames],
    project: {
      id: row.projectId,
      title,
      workspaceRoot: row.workspaceRoot,
      machine: {
        id: row.machineId,
        name: row.machineName,
        connected: row.machineConnected !== false,
        ...(typeof row.machineReason === "string" &&
        row.machineReason.length > 0
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
export async function lookupCandidates(
  heard: string,
  mode: "explicit-only" | "explicit-or-inferred" = "explicit-or-inferred",
): Promise<CandidateLookup> {
  const source = heard.trim();
  const slot = locateProjectSlot(source, mode);
  // Names in task prose cannot narrow the catalog for the project slot.
  const windows = heardWindows(
    slot === undefined ? "" : source.slice(slot.start, slot.end),
  );
  const exactRows = await runRead<CatalogRow>(EXACT_CANDIDATES_QUERY, {
    windows,
  });
  if (exactRows.length > 0) {
    return {
      candidates: exactRows.map((row) => toCandidate(row, windows)),
      query: EXACT_CANDIDATES_QUERY,
      params: { windows },
      rows: exactRows,
      pass: "exact",
    };
  }
  const catalogRows = await runRead<CatalogRow>(FULL_CATALOG_QUERY);
  return {
    candidates: catalogRows.map((row) => toCandidate(row, [])),
    query: FULL_CATALOG_QUERY,
    params: {},
    rows: catalogRows,
    pass: "catalog-fallback",
  };
}

/** Explain the exact span selected by the core, rather than other names in the slot. */
export function candidatesForMatchedSpan(
  lookup: CandidateLookup,
  heard: string,
): GraphCandidate[] {
  return lookup.rows.map((row) => toCandidate(row, heardWindows(heard)));
}

/**
 * The candidates for one spoken turn, shaped for groundVoiceTurn's input.
 * Async because the catalog lives in FalkorDB; the returned items are plain
 * VoiceProjectCandidates.
 */
export async function getCandidates(heard: string): Promise<GraphCandidate[]> {
  return [...(await lookupCandidates(heard)).candidates];
}
