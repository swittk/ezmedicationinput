import type { CanonicalEvidence, CanonicalLexicalCategory } from "./types";
import { parseHpsgClause } from "./hpsg/clause-parser";
import { findMedicationDateListSpans } from "./date-interpretation";
import { applyHpsgDefaultConstraints } from "./hpsg/defaults";
import { buildTranslationPrimitiveElement, mergeI18nRecords } from "./fhir-translations";
import { lexInput } from "./lexer/lex";
import { annotateLexTokens } from "./lexer/meaning";
import {
  DEFAULT_BODY_SITE_SNOMED,
  DEFAULT_ROUTE_SYNONYMS,
  ROUTE_TEXT,
  normalizeBodySiteKey
} from "./maps";
import { ParserState, Token } from "./parser-state";
import { buildInstructionGraph, realizeInstructionAction } from "./instruction-graph";
import { resolveMedicationAdministrationMethod } from "./hpsg/method-lexicon";
export {
  applyPrnReasonCoding,
  applyPrnReasonCodingAsync
} from "./prn-reason-coding";
export {
  applySiteCoding,
  applySiteCodingAsync
} from "./site-coding";
import {
  AdvicePolarity,
  BodySiteDefinition,
  CanonicalScheduleSemanticField,
  CanonicalSigClause,
  EventTiming,
  FhirDayOfWeek,
  ParseOptions,
  RouteCode,
  TextRange
} from "./types";

const SNOMED_SYSTEM = "http://snomed.info/sct";

const ROUTE_REFINEMENTS = new Map<RouteCode, ReadonlySet<RouteCode>>([
  [
    RouteCode["Topical route"],
    new Set<RouteCode>([
      RouteCode["Per vagina"],
      RouteCode["Per rectum"],
      RouteCode["Ophthalmic route"],
      RouteCode["Ocular route (qualifier value)"],
      RouteCode["Intravitreal route (qualifier value)"],
      RouteCode["Otic route"],
      RouteCode["Nasal route"]
    ])
  ],
  [
    RouteCode["Oral route"],
    new Set<RouteCode>([
      RouteCode["Buccal route"],
      RouteCode["Sublingual route"]
    ])
  ],
  [
    RouteCode["Ophthalmic route"],
    new Set<RouteCode>([
      RouteCode["Ocular route (qualifier value)"],
      RouteCode["Intravitreal route (qualifier value)"]
    ])
  ],
  [
    RouteCode["Ocular route (qualifier value)"],
    new Set<RouteCode>([
      RouteCode["Intravitreal route (qualifier value)"]
    ])
  ]
]);

export function tokenize(input: string): Token[] {
  return annotateLexTokens(lexInput(input));
}

export function buildCustomSiteHints(
  map: Record<string, BodySiteDefinition> | undefined
): Set<string> | undefined {
  if (!map) {
    return undefined;
  }
  const hints = new Set<string>();
  const push = (phrase: string | undefined) => {
    const normalized = normalizeBodySiteKey(phrase ?? "");
    if (!normalized) {
      return;
    }
    for (const part of normalized.split(" ")) {
      if (part) {
        hints.add(part);
      }
    }
  };
  for (const key in map) {
    const definition = map[key];
    if (!definition) {
      continue;
    }
    push(key);
    definition.aliases?.forEach(push);
    push(definition.text);
    push(definition.coding?.display);
  }
  return hints.size ? hints : undefined;
}

function markToken(state: ParserState, token: Token): void {
  state.consumed.add(token.index);
}

function addWhen(target: EventTiming[], value: EventTiming): void {
  if (target.indexOf(value) === -1) {
    target.push(value);
  }
}

function addDayOfWeekList(state: ParserState, days: FhirDayOfWeek[]): void {
  for (const day of days) {
    if (state.dayOfWeek.indexOf(day) === -1) {
      state.dayOfWeek.push(day);
    }
  }
}

function isCompatibleRouteRefinement(
  current: RouteCode | undefined,
  next: RouteCode
): boolean {
  if (current === undefined || current === next) {
    return true;
  }
  return Boolean(ROUTE_REFINEMENTS.get(current)?.has(next));
}

function setRoute(state: ParserState, code: RouteCode, text?: string): void {
  if (!isCompatibleRouteRefinement(state.routeCode, code)) {
    return;
  }
  state.routeCode = code;
  state.routeText = text ?? ROUTE_TEXT[code];
}

function refreshMethodSurface(state: ParserState, options?: ParseOptions): void {
  const verb = state.methodVerb;
  if (!verb) return;
  const definition = resolveMedicationAdministrationMethod(verb, options);
  state.methodText = definition?.display ?? verb.charAt(0).toUpperCase() + verb.slice(1);
  state.methodTextElement = definition?.i18n
    ? buildTranslationPrimitiveElement(definition.i18n)
    : undefined;
}

function recordEvidence(
  state: ParserState,
  rule: string,
  startIndex: number,
  endIndex: number,
  scheduleFields?: CanonicalScheduleSemanticField[],
  lexicalCategory?: CanonicalLexicalCategory
): void {
  const clause = state.primaryClause;
  if (!clause.evidence) {
    clause.evidence = [];
  }
  const evidence: CanonicalEvidence = {
    rule,
    spans: [
      sourceSpan(
        state.input,
        computeTokenRange(
          state.tokens,
          Array.from({ length: endIndex - startIndex + 1 }, (_, offset) => startIndex + offset)
        )
      )
    ]
  };
  if (lexicalCategory) evidence.lexicalCategory = lexicalCategory;
  if (scheduleFields?.length) evidence.scheduleFields = [...scheduleFields];
  clause.evidence.push(evidence);
}

function computeTrimmedInputRange(input: string): TextRange | undefined {
  const start = input.search(/\S/);
  if (start === -1) {
    return undefined;
  }
  let end = input.length;
  while (end > start && /\s/.test(input[end - 1] ?? "")) {
    end -= 1;
  }
  return { start, end };
}

function computeTokenRange(tokens: Token[], indices: number[]): TextRange | undefined {
  let start: number | undefined;
  let end: number | undefined;
  for (const index of indices) {
    const token = tokens.find((candidate) => candidate.index === index);
    if (!token) {
      continue;
    }
    start = start === undefined ? token.sourceStart : Math.min(start, token.sourceStart);
    end = end === undefined ? token.sourceEnd : Math.max(end, token.sourceEnd);
  }
  return start === undefined || end === undefined ? undefined : { start, end };
}

function sourceSpan(
  input: string,
  range: TextRange | undefined,
  tokenIndices?: number[]
): CanonicalSigClause["raw"] {
  const safeRange = range ?? { start: 0, end: input.length };
  return {
    start: safeRange.start,
    end: safeRange.end,
    text: input.slice(safeRange.start, safeRange.end),
    tokenIndices: tokenIndices?.length ? tokenIndices.slice() : undefined
  };
}

function collectLeftovers(state: ParserState): CanonicalSigClause["leftovers"] {
  const leftovers: CanonicalSigClause["leftovers"] = [];
  let group: number[] = [];
  const flush = () => {
    if (!group.length) {
      return;
    }
    leftovers.push(sourceSpan(state.input, computeTokenRange(state.tokens, group), group));
    group = [];
  };
  for (const token of state.tokens) {
    if (state.consumed.has(token.index)) {
      flush();
      continue;
    }
    if (group.length && token.index !== group[group.length - 1] + 1) {
      flush();
    }
    group.push(token.index);
  }
  flush();
  return leftovers;
}

function cleanupClause(state: ParserState): void {
  const clause = state.primaryClause;
  const schedule = clause.schedule;
  if (schedule) {
    // A weekday-recursion sign (`every Monday`) contributes one recurrence
    // for its own weekday. A coordination of such signs licenses the summed
    // weekday/clock slots, but an explicitly stated once-weekly frequency
    // has independent evidence and must NEVER be silently promoted to twice.
    const derivedWeekdayRecurrence = clause.evidence.some(item =>
      item.rule === "hpsg.lex.schedule.weekdayRecurrence");
    const explicitFrequency = clause.evidence.some(item =>
      item.rule === "hpsg.lex.schedule.frequency" ||
      item.rule === "hpsg.lex.schedule.cadenceFirstFrequency");
    if (derivedWeekdayRecurrence && !explicitFrequency &&
        schedule.dayOfWeek && schedule.dayOfWeek.length > 1 &&
        schedule.frequency === 1 && schedule.period === 1 &&
        schedule.periodUnit === "wk" && schedule.timingCode === undefined) {
      schedule.frequency = schedule.dayOfWeek.length *
        (schedule.timeOfDay?.length ?? 1);
    }
    if (!schedule.dayOfWeek?.length) delete schedule.dayOfWeek;
    if (!schedule.when?.length) delete schedule.when;
    if (!schedule.timeOfDay?.length) delete schedule.timeOfDay;
    if (!schedule.calendarEvents?.length) delete schedule.calendarEvents;
    if (
      schedule.timingReference === undefined &&
      schedule.treatmentStartOffsetDays === undefined &&
      schedule.count === undefined &&
      schedule.countMax === undefined &&
      schedule.duration === undefined &&
      schedule.durationMax === undefined &&
      schedule.durationUnit === undefined &&
      schedule.administrationOffsetMinutes === undefined &&
      schedule.boundsStart === undefined &&
      schedule.boundsEnd === undefined &&
      schedule.frequency === undefined &&
      schedule.frequencyMax === undefined &&
      schedule.period === undefined &&
      schedule.periodMax === undefined &&
      schedule.periodUnit === undefined &&
      schedule.offset === undefined &&
      schedule.offsetMin === undefined &&
      schedule.offsetMax === undefined &&
      !schedule.activityTiming?.length &&
      schedule.eventWindow === undefined &&
      schedule.occurrenceCap === undefined &&
      !schedule.maxDosePerPeriod?.length &&
      schedule.timingCode === undefined &&
      !schedule.dayOfWeek &&
      !schedule.when &&
      !schedule.timeOfDay &&
      !schedule.calendarEvents
    ) {
      delete clause.schedule;
    }
  }
  if (clause.dose && clause.dose.value === undefined && !clause.dose.range && clause.dose.unit === undefined) {
    delete clause.dose;
  }
  if (clause.route && clause.route.code === undefined && clause.route.text === undefined) {
    delete clause.route;
  }
  if (clause.site && clause.site.text === undefined && clause.site.coding === undefined && clause.site.source === undefined) {
    delete clause.site;
  }
  if (clause.prn && !clause.prn.enabled && !clause.prn.reason && !clause.prn.reasons) {
    delete clause.prn;
  }
}

function normalizedSafetyText(value: string): string {
  return value.toLowerCase().replace(/[\s,;:.()]+/g, " ").trim();
}

function promoteGraphDirectivesToAdditionalInstructions(clause: CanonicalSigClause): void {
  const graph = clause.instructionGraph;
  const primary = graph?.primaryAdministrationSpan;
  const directives = graph?.actions.filter((frame) => {
    if (!frame.sourceText.trim()) return false;
    if (frame.polarity === AdvicePolarity.Negate) return true;
    if (!frame.modality || !primary) return false;
    return frame.span.end <= primary.start || frame.span.start >= primary.end;
  }) ?? [];
  if (!directives.length) return;
  const instructions = clause.additionalInstructions ?? (clause.additionalInstructions = []);
  for (const warning of directives) {
    const sourceText = warning.sourceText.trim();
    // The shared polarity of a coordinated verb belongs to the COMPOSED
    // typed directive. Its raw daughter source ("drink ...") has no "not".
    const sharedNegation = warning.polaritySource === "shared";
    const composedWording = sharedNegation;
    const text = composedWording
      ? realizeInstructionAction(warning, "en")
      : sourceText
        ? sourceText.charAt(0).toUpperCase() + sourceText.slice(1)
        : sourceText;
    const translated = composedWording ? realizeInstructionAction(warning, "th") : undefined;
    const normalized = normalizedSafetyText(text);
    if (!normalized) continue;
    const representedIndex = instructions.findIndex((instruction) =>
      instruction.frames?.some((frame) =>
        frame.predicate.lemma === warning.predicate.lemma &&
        frame.polarity === warning.polarity &&
        frame.span.start < warning.span.end &&
        warning.span.start < frame.span.end
      )
    );
    if (representedIndex >= 0) {
      // A coded combined safety instruction already semantically owns the
      // daughter action. Keep that compound meaning instead of generating a
      // redundant "do not chew" directive beside its coded equivalent.
      const previous = instructions[representedIndex];
      if (composedWording && !previous.coding?.code) {
        instructions[representedIndex] = {
          ...previous, text,
          i18n: { ...(previous.i18n ?? {}), ...(translated ? { th: translated } : {}) }
        };
      } else if (warning.modality && !previous.coding?.code &&
          normalizedSafetyText(sourceText).length > normalizedSafetyText(previous.text ?? "").length) {
        // The typed modal owns the fuller source phrase. Preserve its
        // relation and condition verbatim rather than realizing the partial
        // daughter ("take with food" instead of "should take with food").
        instructions[representedIndex] = {
          ...previous,
          text: sourceText.charAt(0).toUpperCase() + sourceText.slice(1)
        };
      }
      continue;
    }
    const overlapIndex = instructions.findIndex((instruction) => {
      const existing = normalizedSafetyText(instruction.text ?? "");
      return Boolean(existing && (existing === normalized || existing.includes(normalized) || normalized.includes(existing)));
    });
    if (overlapIndex >= 0) {
      const existing = instructions[overlapIndex];
      const frames = [...(existing.frames ?? [])];
      if (!frames.some((frame) =>
        frame.predicate.lemma === warning.predicate.lemma &&
        frame.polarity === warning.polarity &&
        frame.span.start < warning.span.end && warning.span.start < frame.span.end
      )) {
        frames.push(warning);
      }
      const shouldUseWarningText = !existing.coding?.code &&
        normalizedSafetyText(existing.text ?? "").length < normalized.length;
      instructions[overlapIndex] = {
        ...existing,
        ...(shouldUseWarningText || composedWording ? { text } : {}),
        ...(composedWording && translated ? { i18n: { ...(existing.i18n ?? {}), th: translated } } : {}),
        frames
      };
      continue;
    }
    instructions.push({ text, ...(translated ? { i18n: { th: translated } } : {}), frames: [warning] });
  }
}

function finalizeClause(
  state: ParserState,
  options?: ParseOptions,
  semanticOwnershipRanges?: readonly TextRange[]
): void {
  const clause = state.primaryClause;
  const range = computeTrimmedInputRange(state.input);
  clause.rawText = state.input;
  clause.span = range;
  clause.raw = sourceSpan(state.input, range);
  clause.leftovers = collectLeftovers(state);
  clause.warnings = state.warnings.length ? state.warnings.slice() : undefined;
  clause.confidence = Math.max(0, Number((1 - Math.min(0.6, clause.leftovers.length * 0.12)).toFixed(2)));
  cleanupClause(state);
  clause.instructionGraph = buildInstructionGraph(
    state.input,
    clause,
    options,
    semanticOwnershipRanges
  );
  promoteGraphDirectivesToAdditionalInstructions(clause);
}

export function findUnparsedTokenGroups(
  state: ParserState
): Array<{ tokens: Token[]; range?: TextRange }> {
  const groups: Array<{ tokens: Token[]; range?: TextRange }> = [];
  let current: Token[] = [];
  const flush = () => {
    if (!current.length) {
      return;
    }
    groups.push({
      tokens: current,
      range: computeTokenRange(state.tokens, current.map((token) => token.index))
    });
    current = [];
  };
  for (const token of state.tokens) {
    if (state.consumed.has(token.index)) {
      flush();
      continue;
    }
    if (current.length && token.index !== current[current.length - 1].index + 1) {
      flush();
    }
    current.push(token);
  }
  flush();
  return groups;
}

function seedKnownRouteFromSurface(state: ParserState): void {
  const phrase = state.input.trim().toLowerCase();
  const route = DEFAULT_ROUTE_SYNONYMS[phrase];
  if (!route || state.routeCode !== undefined) {
    return;
  }
  setRoute(state, route.code, route.text);
  for (const token of state.tokens) {
    markToken(state, token);
  }
}

function seedKnownSiteCoding(state: ParserState): void {
  if (!state.siteText || state.siteCoding) {
    return;
  }
  const definition = DEFAULT_BODY_SITE_SNOMED[normalizeBodySiteKey(state.siteText)];
  if (!definition?.coding?.code) {
    return;
  }
  state.siteCoding = {
    system: definition.coding.system ?? SNOMED_SYSTEM,
    code: definition.coding.code,
    display: definition.coding.display,
    i18n: mergeI18nRecords(definition.i18n, definition.coding.i18n)
  };
  if (state.siteAdministrationTargetCount === undefined) {
    state.siteAdministrationTargetCount = definition.administrationTargetCount;
  }
}

function parseTypedClauseSign(
  state: ParserState,
  tokens: Token[],
  options: ParseOptions | undefined,
  project: boolean
) {
  return parseHpsgClause({
    state,
    tokens,
    options,
    dateSpans: findMedicationDateListSpans(state.input, options),
    limit: tokens.length,
    clinicalCache: {},
    deps: {
      addDayOfWeekList,
      addWhen,
      isCompatibleRouteRefinement,
      markToken,
      normalizeSiteText: normalizeBodySiteKey,
      sourceText: (start, end) => state.input.slice(start, end),
      recordEvidence,
      refreshMethodSurface: (target) => refreshMethodSurface(target, options),
      setRoute
    },
    project
  });
}

/** Raw typed analysis for grammar/treebank tests; no canonical or FHIR projection. */
export function parseClauseSign(input: string, options?: ParseOptions) {
  const tokens = tokenize(input);
  const state = new ParserState(input, tokens, buildCustomSiteHints(options?.siteCodeMap));
  return parseTypedClauseSign(state, tokens, options, false);
}

export function parseClauseState(
  input: string,
  options?: ParseOptions,
  customSiteHints = buildCustomSiteHints(options?.siteCodeMap)
): ParserState {
  const tokens = tokenize(input);
  const state = new ParserState(input, tokens, customSiteHints);

  const sign = parseTypedClauseSign(state, tokens, options, true);

  applyHpsgDefaultConstraints(state, tokens, options, { setRoute });
  seedKnownRouteFromSurface(state);
  seedKnownSiteCoding(state);
  const schedule = sign?.synsem.head.schedule;
  finalizeClause(
    state,
    options,
    schedule?.attachmentClass !== "procedure" ? schedule?.sourceRanges : undefined
  );
  return state;
}
