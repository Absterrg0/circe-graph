export interface VoiceProjectCandidate<Project> {
  readonly id: string;
  readonly title: string;
  readonly label?: string;
  readonly names: ReadonlyArray<string>;
  readonly project: Project;
}

export type VoiceProjectMatchKind = "exact" | "near" | "confirmed-pronunciation";

/** Character offsets into sourceUtterance justifying one resolved mention. */
export interface VoiceProjectSpan {
  readonly start: number;
  readonly end: number;
}

export type GroundedVoiceTurn<Project> =
  | {
      readonly status: "not-mentioned";
      readonly sourceUtterance: string;
      readonly utterance: string;
    }
  | {
      readonly status: "resolved";
      readonly sourceUtterance: string;
      readonly utterance: string;
      readonly heard: string;
      readonly match: VoiceProjectMatchKind;
      readonly project: Project;
      /** Present when a concrete mention span produced this route. */
      readonly span?: VoiceProjectSpan;
    }
  | {
      readonly status: "needs-confirmation";
      readonly sourceUtterance: string;
      readonly heard: string;
      readonly prompt: string;
      readonly project: Project;
    }
  | {
      readonly status: "needs-clarification";
      readonly sourceUtterance: string;
      readonly heard: string;
      readonly prompt: string;
      readonly candidates: ReadonlyArray<{
        readonly project: Project;
        readonly label: string;
        readonly learnedAlias?: string;
      }>;
    };

type ProjectMention = {
  readonly heard: string;
  readonly start: number;
  readonly end: number;
};

/**
 * Tokens that mark version-control references rather than project mentions.
 * A candidate span touching one of these is skipped, so "checkout zivil" or
 * "the Rivvl branch" never fuzzy-match a project the user did not name.
 */
const TASK_DOMAIN_TOKENS: ReadonlySet<string> = new Set([
  "branch",
  "tag",
  "commit",
  "pull",
  "request",
  "pr",
  "prs",
  "file",
  "files",
  "issue",
  "issues",
  "checkout",
  "switch",
  "merge",
  "rebase",
  "clone",
  "fetch",
]);

type WordToken = { readonly word: string; readonly start: number; readonly end: number };

function wordTokens(utterance: string): WordToken[] {
  const tokens: WordToken[] = [];
  const pattern = /[\p{Letter}\p{Number}]+/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(utterance)) !== null) {
    tokens.push({ word: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

type ProjectSlot = {
  readonly start: number;
  readonly end: number;
  readonly explicit: boolean;
};

/**
 * Verbs whose object names a project to work with. Task verbs (fix, move,
 * delete, deploy) are deliberately absent: "fix auth" must not route to a
 * project named Auth.
 */
function spanFromCapture(
  utterance: string,
  match: RegExpExecArray,
  captured: string,
): ProjectSlot | undefined {
  const heard = captured.trim();
  if (heard.length === 0) return undefined;
  const relativeStart = match[0].indexOf(captured);
  const start = match.index + relativeStart;
  return { start, end: start + heard.length, explicit: false };
}

function verbObjectSlot(utterance: string): ProjectSlot | undefined {
  const match =
    /\b(?:check out|look at|inspect|review|open|work on|compare)\s+(?:the\s+)?(.+?)(?=\s*(?:,|\b(?:and|then|also)\s+(?:add|build|change|create|delete|deploy|edit|fix|implement|install|merge|move|push|remove|rename|replace|rewrite|update|write)\b|[.!?]*$))/iu.exec(
      utterance.trim(),
    );
  const captured = match?.[1];
  if (match === null || captured === undefined) return undefined;
  return spanFromCapture(utterance, match, captured);
}

function trailingPrepSlot(utterance: string): ProjectSlot | undefined {
  const match =
    /\b(?:in|inside|within|on|for|of|to|into)\s+(?:the\s+)?([^,;.!?]+?)(?=\s*[.!?]*$)/iu.exec(
      utterance.trim(),
    );
  const captured = match?.[1];
  if (match === null || captured === undefined) return undefined;
  return spanFromCapture(utterance, match, captured);
}

/**
 * Locate the single project-bearing span. Explicit syntax ("in X", "X
 * project") always wins; otherwise one inferred slot from a project-taking
 * verb or a trailing prepositional phrase. Anything else — "fix auth",
 * "what is the weather today" — has no slot and never routes.
 */
function locateSlot(
  utterance: string,
  mode: "explicit-only" | "explicit-or-inferred",
): ProjectSlot | undefined {
  const explicit = explicitSuffixMention(utterance) ?? explicitPrefixMention(utterance);
  if (explicit !== undefined) return { start: explicit.start, end: explicit.end, explicit: true };
  if (mode === "explicit-only") return undefined;
  return verbObjectSlot(utterance) ?? trailingPrepSlot(utterance);
}

const normalize = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");

function soundex(value: string): string {
  const letters = normalize(value).replace(/[^a-z]/gu, "");
  if (letters.length === 0) return "";
  const groups: Readonly<Record<string, string>> = {
    b: "1",
    f: "1",
    p: "1",
    v: "1",
    c: "2",
    g: "2",
    j: "2",
    k: "2",
    q: "2",
    s: "2",
    x: "2",
    z: "2",
    d: "3",
    t: "3",
    l: "4",
    m: "5",
    n: "5",
    r: "6",
  };
  const firstLetter = letters.charAt(0);
  let previous = groups[firstLetter] ?? "";
  let code = firstLetter.toUpperCase();
  for (const letter of letters.slice(1)) {
    const digit = groups[letter] ?? "";
    if (digit !== "" && digit !== previous) code += digit;
    previous = digit;
  }
  return `${code}000`.slice(0, 4);
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const next = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const insertion = next[rightIndex] ?? leftIndex + rightIndex + 1;
      const deletion = previous[rightIndex + 1] ?? leftIndex + rightIndex + 2;
      const substitution = previous[rightIndex] ?? leftIndex + rightIndex;
      next.push(
        Math.min(
          insertion + 1,
          deletion + 1,
          substitution + (left[leftIndex] === right[rightIndex] ? 0 : 1),
        ),
      );
    }
    previous = next;
  }
  return previous[right.length] ?? 0;
}

function similarity(left: string, right: string): number {
  const longest = Math.max(left.length, right.length);
  return longest === 0 ? 1 : 1 - editDistance(left, right) / longest;
}

function explicitSuffixMention(
  utterance: string,
): Pick<ProjectMention, "heard" | "start" | "end"> | undefined {
  const suffixes = [...utterance.matchAll(/\s+(?:project|workspace|repo|repository)\b/giu)];
  const suffix = suffixes.at(-1);
  if (suffix === undefined) return undefined;
  const beforeSuffix = utterance.slice(0, suffix.index);
  const boundaries = [
    ...beforeSuffix.matchAll(/\b(?:to|in|inside|within|on|into)\s+(?:the\s+)?/giu),
  ];
  const boundary = boundaries.at(-1);
  if (boundary === undefined) return undefined;
  const start = boundary.index + boundary[0].length;
  const heard = beforeSuffix.slice(start).trim();
  return heard.length === 0 ? undefined : { heard, start, end: start + heard.length };
}

function explicitPrefixMention(
  utterance: string,
): Pick<ProjectMention, "heard" | "start" | "end"> | undefined {
  const match =
    /\b(?:in|inside|within|on)\s+(?:the\s+)?([^,;.!?]+?)(?:\s+(?:project|workspace|repo|repository))?(?=\s*[,;]|\s+(?:please\s+)?(?:check|compare|look|inspect|review|open|work|add|build|change|create|delete|deploy|edit|fix|implement|install|merge|move|push|remove|rename|replace|rewrite|update|write)\b)/iu.exec(
      utterance,
    );
  const captured = match?.[1];
  const heard = captured?.trim();
  if (match === null || captured === undefined || heard === undefined || heard.length === 0) {
    return undefined;
  }
  const relativeStart = match[0].indexOf(captured);
  const start = match.index + relativeStart;
  return { heard, start, end: start + heard.length };
}

function canonicalizeMention(utterance: string, mention: ProjectMention, title: string): string {
  return `${utterance.slice(0, mention.start)}${title}${utterance.slice(mention.end)}`;
}

function labels<Project>(
  candidates: ReadonlyArray<VoiceProjectCandidate<Project>>,
  learnedAlias?: string,
) {
  const duplicateTitles = new Set(
    candidates
      .map(({ title }) => title)
      .filter((title, index, titles) => titles.indexOf(title) !== index),
  );
  const bounded = candidates.slice(0, 5);
  const baseLabels = bounded.map((candidate) =>
    duplicateTitles.has(candidate.title) && candidate.label !== undefined
      ? candidate.label
      : candidate.title,
  );
  const occurrences = new Map<string, number>();
  return bounded.map((candidate) => {
    const baseLabel =
      duplicateTitles.has(candidate.title) && candidate.label !== undefined
        ? candidate.label
        : candidate.title;
    const occurrence = (occurrences.get(baseLabel) ?? 0) + 1;
    occurrences.set(baseLabel, occurrence);
    return {
      project: candidate.project,
      label:
        baseLabels.filter((label) => label === baseLabel).length > 1
          ? `${baseLabel} (${occurrence})`
          : baseLabel,
      ...(learnedAlias === undefined ? {} : { learnedAlias }),
    };
  });
}

/**
 * Grounds a spoken project slot against a bounded catalog. A resolved result
 * owns both the route and the canonical utterance; raw ASR text is retained
 * only as source evidence.
 */
export function groundVoiceTurn<Project>(input: {
  readonly utterance: string;
  readonly candidates: ReadonlyArray<VoiceProjectCandidate<Project>>;
  readonly mode?: "explicit-only" | "explicit-or-inferred";
  readonly confirmedCandidateId?: string;
}): GroundedVoiceTurn<Project> {
  const sourceUtterance = input.utterance.trim();
  // Bounds keep this safe to run synchronously on UI threads: utterances
  // truncate, names per candidate cap, and windows stay inside one slot.
  const MAX_GROUND_TOKENS = 64;
  const MAX_NAMES_PER_CANDIDATE = 8;
  const MAX_SLOT_WINDOW = 8;
  const allWords = wordTokens(sourceUtterance);
  const words = allWords.slice(0, MAX_GROUND_TOKENS);
  const normalizedWords = words.map((token) => normalize(token.word));

  type RankedHit = {
    readonly candidate: VoiceProjectCandidate<Project>;
    readonly score: number;
    readonly spelling: number;
    readonly start: number;
    readonly end: number;
    readonly heard: string;
  };
  type CompiledName = {
    readonly normalized: string;
    readonly compact: string;
    readonly sound: string;
    readonly tail: string;
    readonly initial: string;
  };
  const compileName = (name: string): CompiledName | undefined => {
    const normalized = normalize(name);
    if (normalized.length === 0) return undefined;
    const sound = soundex(normalized);
    return {
      normalized,
      // ASR splits invented names into separate words ("alert if i" for
      // Alertify). Spelling distance runs on the space-free form so word
      // breaks never look like edits.
      compact: normalized.replace(/\s+/gu, ""),
      sound,
      tail: sound.slice(1),
      initial: normalized.charAt(0),
    };
  };
  const compiledCandidates = input.candidates.map((candidate) => ({
    candidate,
    names: candidate.names.slice(0, MAX_NAMES_PER_CANDIDATE).flatMap((name) => {
      const compiled = compileName(name);
      return compiled === undefined ? [] : [compiled];
    }),
  }));
  // Mishearings can run longer than the name ("alert effect" for
  // "Alertify"), so windows extend past the longest catalog name, capped.
  let longestNameWords = 1;
  for (const { names } of compiledCandidates) {
    for (const name of names) {
      const length = name.normalized.split(" ").length;
      if (length > longestNameWords) longestNameWords = length;
    }
  }
  const maxWindow = Math.min(MAX_SLOT_WINDOW, Math.max(4, longestNameWords + 1));
  // Exact and phonetic indexes over compiled names: exact hits never reach
  // edit distance, and fuzzy scoring only visits a blocked shortlist.
  const exactIndex = new Map<string, Array<number>>();
  const initialIndex = new Map<string, Array<number>>();
  const tailIndex = new Map<string, Array<number>>();
  compiledCandidates.forEach(({ names }, candidateIndex) => {
    for (const name of names) {
      const exact = exactIndex.get(name.normalized);
      if (exact === undefined) exactIndex.set(name.normalized, [candidateIndex]);
      else if (!exact.includes(candidateIndex)) exact.push(candidateIndex);
      if (name.initial.length > 0) {
        const bucket = initialIndex.get(name.initial);
        if (bucket === undefined) initialIndex.set(name.initial, [candidateIndex]);
        else if (!bucket.includes(candidateIndex)) bucket.push(candidateIndex);
      }
      if (name.tail.length > 0) {
        const bucket = tailIndex.get(name.tail);
        if (bucket === undefined) tailIndex.set(name.tail, [candidateIndex]);
        else if (!bucket.includes(candidateIndex)) bucket.push(candidateIndex);
      }
    }
  });
  type SlotWindow = {
    readonly start: number;
    readonly end: number;
    readonly firstChar: number;
    readonly lastChar: number;
    readonly heard: string;
    readonly span: string;
    readonly compact: string;
    readonly sound: string;
    readonly tail: string;
    readonly initial: string;
  };
  const windowsInSlot = (slot: ProjectSlot): Array<SlotWindow> => {
    let firstToken = words.length;
    let lastToken = -1;
    words.forEach((token, index) => {
      if (token.start < slot.end && token.end > slot.start) {
        if (index < firstToken) firstToken = index;
        if (index > lastToken) lastToken = index;
      }
    });
    const found: Array<SlotWindow> = [];
    if (lastToken < firstToken) return found;
    for (let start = firstToken; start <= lastToken; start += 1) {
      for (let length = 1; length <= maxWindow && start + length - 1 <= lastToken; length += 1) {
        const first = words[start];
        const last = words[start + length - 1];
        if (first === undefined || last === undefined) continue;
        const before = normalizedWords[start - 1];
        const after = normalizedWords[start + length];
        if (
          (before !== undefined && TASK_DOMAIN_TOKENS.has(before)) ||
          (after !== undefined && TASK_DOMAIN_TOKENS.has(after))
        ) {
          continue;
        }
        const heard = sourceUtterance.slice(first.start, last.end).trim();
        if (heard.length === 0) continue;
        const span = normalizedWords.slice(start, start + length).join(" ");
        if (span.length === 0) continue;
        const sound = soundex(span);
        found.push({
          start: first.start,
          end: last.end,
          firstChar: first.start,
          lastChar: last.end,
          heard,
          span,
          compact: span.replace(/\s+/gu, ""),
          sound,
          tail: sound.slice(1),
          initial: span.charAt(0),
        });
      }
    }
    return found;
  };
  type ScoredSpan = Omit<RankedHit, "candidate">;
  const scoreShortlist = (
    shortlist: ReadonlySet<number>,
    slotWindows: ReadonlyArray<SlotWindow>,
  ): Map<number, ScoredSpan> => {
    const bestByCandidate = new Map<number, ScoredSpan>();
    for (const candidateIndex of shortlist) {
      const entry = compiledCandidates[candidateIndex];
      if (entry === undefined) continue;
      let best: ScoredSpan | undefined;
      for (const name of entry.names) {
        for (const window of slotWindows) {
          if (window.span === name.normalized || window.compact === name.compact) {
            const hit = {
              score: 1,
              spelling: 1,
              start: window.start,
              end: window.end,
              heard: window.heard,
            };
            if (
              best === undefined ||
              hit.score > best.score ||
              (hit.score === best.score && hit.heard.length > best.heard.length)
            ) {
              best = hit;
            }
            continue;
          }
          const spelling = Math.max(
            similarity(window.span, name.normalized),
            similarity(window.compact, name.compact),
          );
          const phonetic =
            name.sound.length > 0 && window.sound.length > 0
              ? similarity(window.sound, name.sound) * 0.92
              : 0;
          const score = Math.max(spelling, phonetic);
          if (
            best === undefined ||
            score > best.score ||
            (score === best.score && window.heard.length > best.heard.length)
          ) {
            best = { score, spelling, start: window.start, end: window.end, heard: window.heard };
          }
        }
      }
      if (best !== undefined) bestByCandidate.set(candidateIndex, best);
    }
    return bestByCandidate;
  };
  const ranked: RankedHit[] = [];
  const slot = locateSlot(sourceUtterance, input.mode ?? "explicit-or-inferred");

  // A pending confirmation is validated before anything else: if the project
  // vanished (or the catalog is empty), say so instead of silently falling
  // back to ambient context.
  if (input.confirmedCandidateId !== undefined) {
    const confirmed = input.candidates.find(
      (candidate) => candidate.id === input.confirmedCandidateId,
    );
    if (confirmed === undefined) {
      return {
        status: "needs-clarification",
        sourceUtterance,
        heard: sourceUtterance,
        prompt: "That project is no longer available. Which project did you mean?",
        candidates: labels(input.candidates),
      };
    }
    if (slot === undefined) {
      return { status: "not-mentioned", sourceUtterance, utterance: sourceUtterance };
    }
    // Canonicalize only the confirmed candidate's own best span: replacing
    // any other span would rewrite words the user never attributed to it.
    const confirmedIndex = compiledCandidates.findIndex(
      ({ candidate }) => candidate.id === confirmed.id,
    );
    const span =
      confirmedIndex < 0
        ? undefined
        : scoreShortlist(new Set([confirmedIndex]), windowsInSlot(slot)).get(confirmedIndex);
    if (span === undefined || span.score < 0.5) {
      return {
        status: "resolved",
        sourceUtterance,
        utterance: sourceUtterance,
        heard: span?.heard ?? sourceUtterance,
        match: "confirmed-pronunciation",
        project: confirmed.project,
      };
    }
    return {
      status: "resolved",
      sourceUtterance,
      utterance: canonicalizeMention(
        sourceUtterance,
        { heard: span.heard, start: span.start, end: span.end },
        confirmed.title,
      ),
      heard: span.heard,
      match: "confirmed-pronunciation",
      project: confirmed.project,
      span: { start: span.start, end: span.end },
    };
  }

  if (slot === undefined) {
    return { status: "not-mentioned", sourceUtterance, utterance: sourceUtterance };
  }
  const slotWindows = windowsInSlot(slot);
  // Exact hits across the slot resolve without any edit distance: collect
  // them straight from the index before opening the fuzzy shortlist.
  const exactHits = new Map<number, ScoredSpan>();
  for (const window of slotWindows) {
    for (const candidateIndex of exactIndex.get(window.span) ?? []) {
      const previous = exactHits.get(candidateIndex);
      if (
        previous === undefined ||
        window.heard.length > previous.heard.length ||
        (window.heard.length === previous.heard.length && window.start < previous.start)
      ) {
        exactHits.set(candidateIndex, {
          score: 1,
          spelling: 1,
          start: window.start,
          end: window.end,
          heard: window.heard,
        });
      }
    }
  }
  if (exactHits.size > 0) {
    for (const [candidateIndex, best] of exactHits) {
      const entry = compiledCandidates[candidateIndex];
      if (entry !== undefined) ranked.push({ candidate: entry.candidate, ...best });
    }
  } else {
    // Fuzzy scoring visits only blocked neighbors: same initial letter or
    // same Soundex tail as a slot window. Initial-consonant swaps (Zivil ->
    // Rivvl) survive through the tail; single trailing typos survive through
    // the initial.
    const shortlist = new Set<number>();
    for (const window of slotWindows) {
      for (const candidateIndex of initialIndex.get(window.initial) ?? []) {
        shortlist.add(candidateIndex);
      }
      for (const candidateIndex of tailIndex.get(window.tail) ?? []) {
        shortlist.add(candidateIndex);
      }
    }
    for (const [candidateIndex, best] of scoreShortlist(shortlist, slotWindows)) {
      const entry = compiledCandidates[candidateIndex];
      if (entry !== undefined) ranked.push({ candidate: entry.candidate, ...best });
    }
  }
  ranked.sort((left, right) => right.score - left.score);

  const mentionOf = (hit: RankedHit): ProjectMention => ({
    heard: hit.heard,
    start: hit.start,
    end: hit.end,
  });

  // An empty shortlist is not "no mention": the explicit-slot fallback
  // below still clarifies ("In Javis, list projects" names something, even
  // when nothing scores). Only an empty catalog ends here.
  if (ranked.length === 0 && input.candidates.length === 0) {
    return { status: "not-mentioned", sourceUtterance, utterance: sourceUtterance };
  }

  const exact = ranked.filter((hit) => hit.score === 1);
  if (exact.length === 1) {
    const hit = exact[0];
    if (hit === undefined) {
      return { status: "not-mentioned", sourceUtterance, utterance: sourceUtterance };
    }
    const mention = mentionOf(hit);
    return {
      status: "resolved",
      sourceUtterance,
      utterance: canonicalizeMention(sourceUtterance, mention, hit.candidate.title),
      heard: mention.heard,
      match: hit.candidate.title === mention.heard ? "exact" : "confirmed-pronunciation",
      project: hit.candidate.project,
      span: { start: mention.start, end: mention.end },
    };
  }
  if (exact.length > 1) {
    const earliest = [...exact].sort((left, right) => left.start - right.start)[0];
    const heard = earliest === undefined ? sourceUtterance : earliest.heard;
    return {
      status: "needs-clarification",
      sourceUtterance,
      heard,
      prompt: `More than one project matches “${heard}”. Which one did you mean?`,
      candidates: labels(exact.map(({ candidate }) => candidate)),
    };
  }

  const best = ranked[0];
  const runnerUp = ranked[1];
  const margin = best === undefined ? 0 : best.score - (runnerUp?.score ?? 0);
  if (best !== undefined && best.spelling >= 0.8 && margin >= 0.15) {
    const mention = mentionOf(best);
    return {
      status: "resolved",
      sourceUtterance,
      utterance: canonicalizeMention(sourceUtterance, mention, best.candidate.title),
      heard: mention.heard,
      match: "near",
      project: best.candidate.project,
      span: { start: mention.start, end: mention.end },
    };
  }
  const plausibleTies =
    best === undefined
      ? []
      : ranked.filter(({ score }) => score >= 0.68 && best.score - score < 0.18);
  if (plausibleTies.length > 1 && best !== undefined) {
    return {
      status: "needs-clarification",
      sourceUtterance,
      heard: best.heard,
      prompt: `More than one project sounds like “${best.heard}”. Which one did you mean?`,
      candidates: labels(
        plausibleTies.map(({ candidate }) => candidate),
        best.heard,
      ),
    };
  }
  if (best !== undefined && best.score >= 0.68 && margin >= 0.18) {
    return {
      status: "needs-confirmation",
      sourceUtterance,
      heard: best.heard,
      prompt: `Did you mean ${best.candidate.title}?`,
      project: best.candidate.project,
    };
  }
  const slotHeard = sourceUtterance.slice(slot.start, slot.end).trim();
  if (slot.explicit && slotHeard.length > 0) {
    return {
      status: "needs-clarification",
      sourceUtterance,
      heard: slotHeard,
      prompt: `I couldn't match “${slotHeard}” to an Circe project.`,
      candidates: labels(input.candidates),
    };
  }
  return { status: "not-mentioned", sourceUtterance, utterance: sourceUtterance };
}
