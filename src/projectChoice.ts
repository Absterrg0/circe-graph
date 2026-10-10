/**
 * Shared spoken-choice resolution for a pending project clarification. Web
 * voice, mobile, and the server must agree on which answers count as a target
 * selection: a divergent matcher lets one client reuse a paused instruction
 * that another would have replaced with a fresh request. The matcher reports
 * the exact answer text it consumed so callers can check for leftover command
 * content before trusting the paused instruction.
 */

export interface CirceProjectChoiceCandidate {
  readonly title: string;
  readonly label?: string;
  /** Alternate catalog names (basename, repository, learned aliases). */
  readonly names?: ReadonlyArray<string>;
}

export type CirceProjectChoiceMatch = {
  /** Index into the offered candidates. */
  readonly index: number;
  /** The answer text the match consumed. */
  readonly matchedText: string;
  /** How the answer matched; ordinals address the offered order only. */
  readonly kind: "affirmation" | "ordinal" | "name" | "fuzzy";
};

const foldCirceChoiceText = (value: string): string =>
  value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const ORDINAL_VALUES: ReadonlyMap<string, number> = new Map([
  ["one", 0],
  ["first", 0],
  ["two", 1],
  ["second", 1],
  ["three", 2],
  ["third", 2],
  ["four", 3],
  ["fourth", 3],
  ["five", 4],
  ["fifth", 4],
]);

const AFFIRMATION = /^(?:yes|yeah|yep|correct|that one|use that)$/u;

/** Small, allocation-bounded Levenshtein distance; null when over the cap. */
function boundedCirceEditDistance(a: string, b: string, cap: number): number | null {
  if (Math.abs(a.length - b.length) > cap) return null;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = Array.from({ length: b.length + 1 }, () => 0);
    current[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      rowMin = Math.min(rowMin, current[j]!);
    }
    if (rowMin > cap) return null;
    previous = current;
  }
  const distance = previous[b.length]!;
  return distance > cap ? null : distance;
}

/** One edit per five characters, and never a guess for one-to-three-letter names. */
function circeChoiceDistanceCap(a: string, b: string): number {
  const shorter = Math.min(a.length, b.length);
  if (shorter < 4) return 0;
  return Math.max(1, Math.floor(shorter / 5));
}

function candidateNames(
  candidate: CirceProjectChoiceCandidate,
): ReadonlyArray<{ readonly folded: string; readonly compact: string }> {
  return [
    candidate.title,
    ...(candidate.label === undefined ? [] : [candidate.label]),
    ...(candidate.names ?? []),
  ]
    .filter((value): value is string => value !== undefined)
    .map((value) => foldCirceChoiceText(value))
    .filter((value) => value.length > 0)
    .map((value) => ({ folded: value, compact: value.replace(/\s+/gu, "") }));
}

/**
 * Unique-best fuzzy match of one spoken answer (or one word of it) against the
 * offered candidates. Ties and distant guesses return null so the host re-asks
 * instead of guessing.
 */
function fuzzyCirceProjectChoice(
  answer: string,
  candidates: ReadonlyArray<CirceProjectChoiceCandidate>,
): CirceProjectChoiceMatch | null {
  const probes = [answer, ...answer.split(/\s+/u)]
    .map((probe) => ({ text: probe, folded: foldCirceChoiceText(probe).replace(/\s+/gu, "") }))
    .filter((probe) => probe.folded.length >= 4);
  if (probes.length === 0) return null;
  const scored: Array<{
    readonly index: number;
    readonly distance: number;
    readonly matchedText: string;
  }> = [];
  candidates.forEach((candidate, index) => {
    let best: number | null = null;
    let bestProbe = "";
    for (const { compact } of candidateNames(candidate)) {
      for (const probe of probes) {
        const distance = boundedCirceEditDistance(
          compact,
          probe.folded,
          circeChoiceDistanceCap(compact, probe.folded),
        );
        if (distance !== null && (best === null || distance < best)) {
          best = distance;
          bestProbe = probe.text;
        }
      }
    }
    if (best !== null) scored.push({ index, distance: best, matchedText: bestProbe });
  });
  if (scored.length === 0) return null;
  scored.sort((left, right) => left.distance - right.distance);
  const bestScore = scored[0]!;
  if (scored[1] !== undefined && scored[1].distance === bestScore.distance) return null;
  return { index: bestScore.index, matchedText: bestScore.matchedText, kind: "fuzzy" };
}

/**
 * Resolve one answer against the offered candidates. Ordinals and affirmations
 * consume the whole answer; a name consumes the exact name or the uniquely
 * best matching word. Null means no target was selected; callers then decide
 * between a fresh interpretation and one honest re-prompt.
 */
export function resolveCirceProjectChoice(input: {
  readonly answer: string;
  readonly candidates: ReadonlyArray<CirceProjectChoiceCandidate>;
  readonly acceptsAffirmation?: boolean;
}): CirceProjectChoiceMatch | null {
  const raw = input.answer.trim();
  const answer = foldCirceChoiceText(raw);
  if (answer.length === 0) return null;
  if (
    input.acceptsAffirmation === true &&
    AFFIRMATION.test(answer) &&
    input.candidates.length === 1
  ) {
    return { index: 0, matchedText: raw, kind: "affirmation" };
  }
  const ordinal =
    /^(?:the\s+)?(?:(?:number|option|choice|project)\s+)?(\d+)(?:st|nd|rd|th)?(?:\s+one)?$/u.exec(
      answer,
    );
  const wordOrdinal =
    /^(?:the\s+)?(?:(?:number|option|choice|project)\s+)?(one|two|three|four|five|first|second|third|fourth|fifth)(?:\s+one)?$/u.exec(
      answer,
    );
  const position =
    ordinal?.[1] !== undefined
      ? Number(ordinal[1])
      : wordOrdinal?.[1] === undefined
        ? undefined
        : (ORDINAL_VALUES.get(wordOrdinal[1]) ?? 0) + 1;
  if (position !== undefined && position >= 1 && position <= input.candidates.length) {
    return { index: position - 1, matchedText: raw, kind: "ordinal" };
  }
  const exact = input.candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidateNames(candidate).some((name) => name.folded === answer));
  if (exact.length === 1) return { index: exact[0]!.index, matchedText: raw, kind: "name" };
  if (exact.length > 1) return null;
  return fuzzyCirceProjectChoice(raw, input.candidates);
}
