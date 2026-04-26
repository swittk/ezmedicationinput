import { parseHpsgClause } from "./hpsg/clause-parser";
import { applyHpsgDefaultConstraints } from "./hpsg/defaults";
import { buildTranslationPrimitiveElement } from "./fhir-translations";
import { lexInput } from "./lexer/lex";
import { annotateLexTokens } from "./lexer/meaning";
import {
  DEFAULT_BODY_SITE_SNOMED,
  DEFAULT_ROUTE_SYNONYMS,
  ROUTE_TEXT,
  normalizeBodySiteKey
} from "./maps";
import { ParserState, Token } from "./parser-state";
export {
  applyPrnReasonCoding,
  applyPrnReasonCodingAsync
} from "./prn-reason-coding";
export {
  applySiteCoding,
  applySiteCodingAsync
} from "./site-coding";
import {
  BodySiteDefinition,
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

const METHOD_TEXT_BY_VERB: Record<string, string> = {
  administer: "Administer",
  apply: "Apply",
  bathe: "Bathe",
  chew: "Chew",
  drink: "Drink",
  gargle: "Gargle",
  inhale: "Inhale",
  inject: "Inject",
  insert: "Insert",
  instill: "Instill",
  rinse: "Rinse",
  spray: "Spray",
  swallow: "Swallow",
  take: "Take",
  use: "Use"
};

const METHOD_THAI_BY_VERB: Record<string, string> = {
  apply: "ทา",
  drink: "รับประทาน",
  insert: "สอด",
  instill: "หยอด",
  spray: "พ่น",
  swallow: "รับประทาน",
  take: "รับประทาน",
  wash: "ล้าง"
};

export function tokenize(input: string): Token[] {
  return annotateLexTokens(lexInput(input));
}

function buildCustomSiteHints(
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

function refreshMethodSurface(state: ParserState): void {
  const verb = state.methodVerb;
  if (!verb) {
    return;
  }
  state.methodText = METHOD_TEXT_BY_VERB[verb] ?? verb.charAt(0).toUpperCase() + verb.slice(1);
  const thai = METHOD_THAI_BY_VERB[verb];
  state.methodTextElement = thai
    ? buildTranslationPrimitiveElement({ th: thai })
    : undefined;
}

function recordEvidence(
  state: ParserState,
  rule: string,
  startIndex: number,
  endIndex: number
): void {
  const clause = state.primaryClause;
  if (!clause.evidence) {
    clause.evidence = [];
  }
  clause.evidence.push({
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
  });
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
    if (
      schedule.count === undefined &&
      schedule.duration === undefined &&
      schedule.durationMax === undefined &&
      schedule.durationUnit === undefined &&
      schedule.frequency === undefined &&
      schedule.frequencyMax === undefined &&
      schedule.period === undefined &&
      schedule.periodMax === undefined &&
      schedule.periodUnit === undefined &&
      schedule.timingCode === undefined &&
      !schedule.dayOfWeek &&
      !schedule.when &&
      !schedule.timeOfDay
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

function finalizeClause(state: ParserState): void {
  const clause = state.primaryClause;
  const range = computeTrimmedInputRange(state.input);
  clause.rawText = state.input;
  clause.span = range;
  clause.raw = sourceSpan(state.input, range);
  clause.leftovers = collectLeftovers(state);
  clause.warnings = state.warnings.length ? state.warnings.slice() : undefined;
  clause.confidence = Math.max(0, Number((1 - Math.min(0.6, clause.leftovers.length * 0.12)).toFixed(2)));
  cleanupClause(state);
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
    display: definition.coding.display
  };
}

export function parseClauseState(input: string, options?: ParseOptions): ParserState {
  const tokens = tokenize(input);
  const state = new ParserState(input, tokens, buildCustomSiteHints(options?.siteCodeMap));

  parseHpsgClause({
    state,
    tokens,
    options,
    limit: tokens.length,
    deps: {
      addDayOfWeekList,
      addWhen,
      isCompatibleRouteRefinement,
      markToken,
      normalizeSiteText: normalizeBodySiteKey,
      recordEvidence,
      refreshMethodSurface,
      setRoute
    },
    project: true
  });

  applyHpsgDefaultConstraints(state, tokens, options, { setRoute });
  seedKnownRouteFromSurface(state);
  seedKnownSiteCoding(state);
  finalizeClause(state);
  return state;
}
