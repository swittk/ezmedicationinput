import type { CanonicalAdditionalInstructionExpr, CanonicalEvidence, CanonicalLexicalCategory } from "./types";
import { parseHpsgClause } from "./hpsg/clause-parser";
import { getProceduralFrames } from "./hpsg/procedural-context";
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
import { buildInstructionGraph, instructionGraphAdviceAssociation, instructionSourceRange, realizeInstructionAction } from "./instruction-graph";
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
      schedule.administrationDuration === undefined &&
      schedule.administrationDurationMax === undefined &&
      schedule.administrationDurationUnit === undefined &&
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
      !schedule.dayOfMonth?.length &&
      schedule.weekdayOrdinal === undefined &&
      schedule.clockWindow === undefined &&
      schedule.cycleDayConstraint === undefined &&
      schedule.repeatCycle === undefined &&
      schedule.repeatCount === undefined &&
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

function promoteGraphDirectivesToAdditionalInstructions(clause: CanonicalSigClause): void {
  const graph = clause.instructionGraph;
  if (!graph) return;
  const primary = graph.primaryAdministrationSpan;
  let instructions = clause.additionalInstructions;
  let associations: ReturnType<typeof instructionGraphAdviceAssociation>[] | undefined;
  let source: string | undefined;
  for (let index = 0; index < graph.actions.length; index += 1) {
    const warning = graph.actions[index];
    const sourceText = warning.sourceText.trim();
    if (!sourceText || (warning.polarity !== AdvicePolarity.Negate &&
        (!warning.modality || !primary ||
          warning.span.end > primary.start && warning.span.start < primary.end))) continue;
    if (!associations) associations = (instructions ?? []).map(instruction =>
      instructionGraphAdviceAssociation(graph, instruction));
    let rowIndex = -1;
    let uncodedBindings = 0;
    for (let candidate = 0; candidate < associations.length; candidate += 1) {
      if (associations[candidate].actionIndices.indexOf(index) < 0) continue;
      const coded = Boolean(instructions![candidate].coding?.code);
      if (rowIndex < 0 || !coded && instructions![rowIndex].coding?.code) rowIndex = candidate;
      if (!coded) uncodedBindings += 1;
    }
    let previous: CanonicalAdditionalInstructionExpr | undefined;
    let range: TextRange | undefined;
    if (rowIndex >= 0) {
      previous = instructions![rowIndex];
      // One daughter cannot replace a split or wider selected instruction.
      if (previous.coding?.code || uncodedBindings !== 1 || previous.frames?.length !== 1 ||
          associations[rowIndex].actionIndices.length !== 1) continue;
      range = instructionSourceRange(graph, previous.text,
        source ??= graph.sourceText.toLocaleLowerCase("en"));
      if (range && (range.start < warning.span.start || range.end > warning.span.end)) continue;
    }
    const wordingRange = range ?? warning.span;
    const composedSource = warning.polaritySource === "shared" || warning.args.some(argument =>
      argument.span && (argument.span.start < wordingRange.start || argument.span.end > wordingRange.end));
    if (previous) {
      const frame = previous.frames![0];
      const richerModalSource = warning.modality !== undefined &&
        (frame.modality !== warning.modality ||
          warning.span.start < frame.span.start || warning.span.end > frame.span.end ||
          !range || range.start !== warning.span.start || range.end !== warning.span.end);
      if (!composedSource && !richerModalSource) {
        if (frame !== warning) instructions![rowIndex] = { ...previous, frames: [warning] };
        continue;
      }
    }
    // A daughter source cannot express inherited polarity or arguments owned
    // outside that source extent; realize the complete selected composition.
    const text = composedSource
      ? realizeInstructionAction(warning, "en")
      : sourceText.charAt(0).toUpperCase() + sourceText.slice(1);
    if (!text.trim()) continue;
    const translated = composedSource ? realizeInstructionAction(warning, "th") : undefined;
    const selected: CanonicalAdditionalInstructionExpr = previous
      ? { ...previous, text, frames: [warning] } : { text, frames: [warning] };
    if (translated) selected.i18n = { ...previous?.i18n, th: translated };
    if (previous) instructions![rowIndex] = selected;
    else (instructions ??= clause.additionalInstructions = []).push(selected);
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
    semanticOwnershipRanges,
    getProceduralFrames({ state, options })
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
