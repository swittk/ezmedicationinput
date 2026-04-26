import {
  ClauseFeatureContribution,
  ClauseScheduleContribution,
  sameCoding,
  sameOptionalScalar
} from "./clause-features";
import { ParserState, Token } from "./parser-state";
import { EventTiming, FhirDayOfWeek, RouteCode } from "./types";

export interface ClauseGrammarContext {
  state: ParserState;
  tokens: Token[];
}

export type FeatureContributionMatcher<TContext extends ClauseGrammarContext = ClauseGrammarContext> = (
  context: TContext,
  index: number,
  token: Token
) => ClauseFeatureContribution | undefined;

export interface ClauseGrammarRule<TContext extends ClauseGrammarContext = ClauseGrammarContext> {
  id: string;
  precedence: number;
  matcher: FeatureContributionMatcher<TContext>;
}

export interface ClauseGrammarEngineDeps {
  addDayOfWeekList: (state: ParserState, days: FhirDayOfWeek[]) => void;
  addWhen: (target: EventTiming[], whenCode: EventTiming) => void;
  isCompatibleRouteRefinement: (current: RouteCode | undefined, next: RouteCode) => boolean;
  markToken: (state: ParserState, token: Token) => void;
  normalizeSiteText: (text: string) => string;
  recordEvidence: (state: ParserState, rule: string, startIndex: number, endIndex: number) => void;
  refreshMethodSurface: (state: ParserState) => void;
  setRoute: (state: ParserState, code: RouteCode, text?: string) => void;
}

interface ClauseGrammarCandidate {
  endIndex: number;
  consumedCount: number;
  featureCount: number;
  precedence: number;
  apply: () => number | undefined;
}

function canApplyScheduleContribution(
  state: ParserState,
  schedule: ClauseScheduleContribution
): boolean {
  return (
    sameOptionalScalar(state.timingCode, schedule.timingCode) &&
    sameOptionalScalar(state.count, schedule.count) &&
    sameOptionalScalar(state.duration, schedule.duration) &&
    sameOptionalScalar(state.durationMax, schedule.durationMax) &&
    sameOptionalScalar(state.durationUnit, schedule.durationUnit) &&
    sameOptionalScalar(state.frequency, schedule.frequency) &&
    sameOptionalScalar(state.frequencyMax, schedule.frequencyMax) &&
    sameOptionalScalar(state.period, schedule.period) &&
    sameOptionalScalar(state.periodMax, schedule.periodMax) &&
    sameOptionalScalar(state.periodUnit, schedule.periodUnit)
  );
}

function canApplyClauseContribution(
  state: ParserState,
  contribution: ClauseFeatureContribution,
  deps: ClauseGrammarEngineDeps
): boolean {
  const method = contribution.method;
  if (method && state.methodVerb && state.methodVerb !== method.verb) {
    return false;
  }

  const route = contribution.route;
  if (route && !deps.isCompatibleRouteRefinement(state.routeCode, route.code)) {
    return false;
  }

  const site = contribution.site;
  if (site) {
    if (
      site.text &&
      state.siteText &&
      deps.normalizeSiteText(site.text) !== deps.normalizeSiteText(state.siteText)
    ) {
      return false;
    }
    if (site.coding && state.siteCoding && !sameCoding(site.coding, state.siteCoding)) {
      return false;
    }
  }

  const dose = contribution.dose;
  if (dose) {
    if (!sameOptionalScalar(state.dose, dose.value)) {
      return false;
    }
    if (!sameOptionalScalar(state.unit, dose.unit)) {
      return false;
    }
    if (
      dose.range &&
      state.doseRange &&
      (dose.range.low !== state.doseRange.low || dose.range.high !== state.doseRange.high)
    ) {
      return false;
    }
  }

  const schedule = contribution.schedule;
  if (schedule && !canApplyScheduleContribution(state, schedule)) {
    return false;
  }

  return true;
}

function applyScheduleContribution(
  state: ParserState,
  schedule: ClauseScheduleContribution,
  deps: ClauseGrammarEngineDeps
): void {
  if (schedule.timingCode !== undefined) {
    state.timingCode = schedule.timingCode;
  }
  if (schedule.count !== undefined) {
    state.count = schedule.count;
  }
  if (schedule.duration !== undefined) {
    state.duration = schedule.duration;
  }
  if (schedule.durationMax !== undefined) {
    state.durationMax = schedule.durationMax;
  }
  if (schedule.durationUnit !== undefined) {
    state.durationUnit = schedule.durationUnit;
  }
  if (schedule.frequency !== undefined) {
    state.frequency = schedule.frequency;
  }
  if (schedule.frequencyMax !== undefined) {
    state.frequencyMax = schedule.frequencyMax;
  }
  if (schedule.period !== undefined) {
    state.period = schedule.period;
  }
  if (schedule.periodMax !== undefined) {
    state.periodMax = schedule.periodMax;
  }
  if (schedule.periodUnit !== undefined) {
    state.periodUnit = schedule.periodUnit;
  }
  if (schedule.when) {
    for (const whenCode of schedule.when) {
      deps.addWhen(state.when, whenCode);
    }
  }
  if (schedule.dayOfWeek) {
    deps.addDayOfWeekList(state, schedule.dayOfWeek);
  }
  if (schedule.timeOfDay?.length) {
    const existing = state.timeOfDay ? [...state.timeOfDay] : [];
    for (const time of schedule.timeOfDay) {
      if (existing.indexOf(time) === -1) {
        existing.push(time);
      }
    }
    state.timeOfDay = existing;
  }
}

function applyClauseContribution(
  state: ParserState,
  contribution: ClauseFeatureContribution,
  tokens: Token[],
  deps: ClauseGrammarEngineDeps
): boolean {
  if (!canApplyClauseContribution(state, contribution, deps)) {
    return false;
  }

  if (contribution.method) {
    state.methodVerb = contribution.method.verb;
    if (contribution.method.text !== undefined) {
      state.methodText = contribution.method.text;
    } else {
      deps.refreshMethodSurface(state);
    }
    if (contribution.method.textElement !== undefined) {
      state.methodTextElement = contribution.method.textElement;
    }
    if (contribution.method.coding !== undefined) {
      state.methodCoding = contribution.method.coding;
    }
  }

  if (contribution.route) {
    deps.setRoute(state, contribution.route.code, contribution.route.text);
  }

  if (contribution.site) {
    if (contribution.site.text !== undefined) {
      state.siteText = contribution.site.text;
    }
    if (contribution.site.source !== undefined) {
      state.siteSource = contribution.site.source;
    }
    if (contribution.site.coding !== undefined) {
      state.siteCoding = contribution.site.coding;
    }
    if (contribution.site.lookupRequest !== undefined) {
      state.siteLookupRequest = contribution.site.lookupRequest;
    }
  }

  if (contribution.dose) {
    if (contribution.dose.value !== undefined) {
      state.dose = contribution.dose.value;
    }
    if (contribution.dose.range !== undefined) {
      state.doseRange = contribution.dose.range;
    }
    if (contribution.dose.unit !== undefined) {
      state.unit = contribution.dose.unit;
    }
  }

  if (contribution.schedule) {
    applyScheduleContribution(state, contribution.schedule, deps);
  }

  if (contribution.warnings?.length) {
    for (const warning of contribution.warnings) {
      if (state.warnings.indexOf(warning) === -1) {
        state.warnings.push(warning);
      }
    }
  }

  if (contribution.siteTokenIndices?.length) {
    for (const tokenIndex of contribution.siteTokenIndices) {
      state.siteTokenIndices.add(tokenIndex);
    }
  }

  const findTokenByIndex = (tokenIndex: number): Token | undefined => {
    const direct = tokens[tokenIndex];
    if (direct && direct.index === tokenIndex) {
      return direct;
    }
    return tokens.find((candidate) => candidate.index === tokenIndex);
  };

  for (const tokenIndex of contribution.consumedTokenIndices) {
    const parsedToken = findTokenByIndex(tokenIndex);
    if (parsedToken) {
      deps.markToken(state, parsedToken);
    }
  }

  return true;
}

function measureScheduleContribution(schedule: ClauseScheduleContribution | undefined): number {
  if (!schedule) {
    return 0;
  }
  let score = 0;
  if (schedule.timingCode !== undefined) score += 1;
  if (schedule.count !== undefined) score += 1;
  if (schedule.duration !== undefined) score += 1;
  if (schedule.durationMax !== undefined) score += 1;
  if (schedule.durationUnit !== undefined) score += 1;
  if (schedule.frequency !== undefined) score += 1;
  if (schedule.frequencyMax !== undefined) score += 1;
  if (schedule.period !== undefined) score += 1;
  if (schedule.periodMax !== undefined) score += 1;
  if (schedule.periodUnit !== undefined) score += 1;
  if (schedule.when?.length) score += schedule.when.length;
  if (schedule.dayOfWeek?.length) score += schedule.dayOfWeek.length;
  if (schedule.timeOfDay?.length) score += schedule.timeOfDay.length;
  return score;
}

function measureContributionFeatures(contribution: ClauseFeatureContribution): number {
  let score = 0;
  if (contribution.method) {
    score += 1;
    if (contribution.method.text !== undefined) score += 1;
    if (contribution.method.textElement !== undefined) score += 1;
    if (contribution.method.coding !== undefined) score += 1;
  }
  if (contribution.route) {
    score += 1;
    if (contribution.route.text !== undefined) score += 1;
  }
  if (contribution.site) {
    score += 1;
    if (contribution.site.text !== undefined) score += 1;
    if (contribution.site.source !== undefined) score += 1;
    if (contribution.site.coding !== undefined) score += 1;
    if (contribution.site.lookupRequest !== undefined) score += 1;
  }
  if (contribution.dose) {
    score += 1;
    if (contribution.dose.value !== undefined) score += 1;
    if (contribution.dose.range !== undefined) score += 1;
    if (contribution.dose.unit !== undefined) score += 1;
  }
  score += measureScheduleContribution(contribution.schedule);
  if (contribution.warnings?.length) {
    score += contribution.warnings.length;
  }
  if (contribution.siteTokenIndices?.length) {
    score += 1;
  }
  return score;
}

function isBetterClauseGrammarCandidate(
  candidate: ClauseGrammarCandidate,
  best: ClauseGrammarCandidate | undefined
): boolean {
  if (!best) {
    return true;
  }
  if (candidate.endIndex !== best.endIndex) {
    return candidate.endIndex > best.endIndex;
  }
  if (candidate.consumedCount !== best.consumedCount) {
    return candidate.consumedCount > best.consumedCount;
  }
  if (candidate.precedence !== best.precedence) {
    return candidate.precedence > best.precedence;
  }
  if (candidate.featureCount !== best.featureCount) {
    return candidate.featureCount > best.featureCount;
  }
  return false;
}

function applyGrammarFeatureTerminal<TContext extends ClauseGrammarContext>(
  context: TContext,
  index: number,
  token: Token,
  rule: string,
  matcher: FeatureContributionMatcher<TContext>,
  deps: ClauseGrammarEngineDeps
): number | undefined {
  const contribution = matcher(context, index, token);
  if (!contribution) {
    return undefined;
  }
  if (!applyClauseContribution(context.state, contribution, context.tokens, deps)) {
    return undefined;
  }
  const findTokenPosition = (tokenIndex: number): number | undefined => {
    const direct = context.tokens[tokenIndex];
    if (direct && direct.index === tokenIndex) {
      return tokenIndex;
    }
    const foundIndex = context.tokens.findIndex((candidate) => candidate.index === tokenIndex);
    return foundIndex === -1 ? undefined : foundIndex;
  };
  let endIndex = index;
  for (const consumedIndex of contribution.consumedTokenIndices) {
    const tokenPosition = findTokenPosition(consumedIndex);
    if (tokenPosition !== undefined && tokenPosition > endIndex) {
      endIndex = tokenPosition;
    }
  }
  deps.recordEvidence(context.state, rule, index, endIndex);
  return endIndex + 1;
}

function previewFeatureGrammarRule<TContext extends ClauseGrammarContext>(
  context: TContext,
  index: number,
  token: Token,
  rule: ClauseGrammarRule<TContext>,
  deps: ClauseGrammarEngineDeps
): ClauseGrammarCandidate | undefined {
  const contribution = rule.matcher(context, index, token);
  if (!contribution) {
    return undefined;
  }
  if (!canApplyClauseContribution(context.state, contribution, deps)) {
    return undefined;
  }
  const findTokenPosition = (tokenIndex: number): number | undefined => {
    const direct = context.tokens[tokenIndex];
    if (direct && direct.index === tokenIndex) {
      return tokenIndex;
    }
    const foundIndex = context.tokens.findIndex((candidate) => candidate.index === tokenIndex);
    return foundIndex === -1 ? undefined : foundIndex;
  };
  let endIndex = index;
  for (const consumedIndex of contribution.consumedTokenIndices) {
    const tokenPosition = findTokenPosition(consumedIndex);
    if (tokenPosition !== undefined && tokenPosition > endIndex) {
      endIndex = tokenPosition;
    }
  }
  return {
    endIndex,
    consumedCount: contribution.consumedTokenIndices.length,
    featureCount: measureContributionFeatures(contribution),
    precedence: rule.precedence,
    apply: () => applyGrammarFeatureTerminal(context, index, token, rule.id, rule.matcher, deps)
  };
}

export function runBestClauseGrammarRule<TContext extends ClauseGrammarContext>(
  context: TContext,
  index: number,
  token: Token,
  rules: ClauseGrammarRule<TContext>[],
  deps: ClauseGrammarEngineDeps
): number | undefined {
  let best: ClauseGrammarCandidate | undefined;
  for (const rule of rules) {
    const candidate = previewFeatureGrammarRule(context, index, token, rule, deps);
    if (candidate && isBetterClauseGrammarCandidate(candidate, best)) {
      best = candidate;
    }
  }
  return best?.apply();
}
