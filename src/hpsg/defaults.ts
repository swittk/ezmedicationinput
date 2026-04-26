import { inferRouteFromContext, inferUnitFromContext } from "../context";
import {
  DEFAULT_ROUTE_SYNONYMS,
  DEFAULT_UNIT_BY_ROUTE,
  ROUTE_TEXT
} from "../maps";
import { ParserState } from "../parser-state";
import { MedicationContext, ParseOptions, RouteCode } from "../types";
import {
  enforceHouseholdUnitPolicy,
  isDiscreteUnit,
  normalizeUnit
} from "../unit-lexicon";

export interface HpsgDefaultConstraintDeps {
  setRoute: (state: ParserState, code: RouteCode, text?: string) => void;
}

function inferUnitFromRoute(state: ParserState): string | undefined {
  if (state.routeCode) {
    const unit = DEFAULT_UNIT_BY_ROUTE[state.routeCode];
    if (unit) {
      return unit;
    }
  }
  if (state.routeText) {
    const synonym = DEFAULT_ROUTE_SYNONYMS[state.routeText.trim().toLowerCase()];
    if (synonym) {
      return DEFAULT_UNIT_BY_ROUTE[synonym.code];
    }
  }
  return undefined;
}

function applyRouteDefault(
  state: ParserState,
  context: MedicationContext | undefined,
  deps: HpsgDefaultConstraintDeps
): void {
  if (state.routeCode !== undefined) {
    return;
  }
  const route = inferRouteFromContext(context);
  if (route !== undefined) {
    deps.setRoute(state, route, ROUTE_TEXT[route]);
  }
}

function applyUnitDefault(
  state: ParserState,
  tokens: readonly { lower: string; index: number }[],
  context: MedicationContext | undefined,
  options: ParseOptions | undefined
): void {
  if (state.unit !== undefined || (state.dose === undefined && state.doseRange === undefined)) {
    return;
  }
  for (const token of tokens) {
    if (state.consumed.has(token.index)) {
      continue;
    }
    const unit = normalizeUnit(token.lower, options);
    if (unit) {
      state.unit = unit;
      state.consumed.add(token.index);
      return;
    }
  }
  state.unit =
    enforceHouseholdUnitPolicy(inferUnitFromContext(context), options) ??
    enforceHouseholdUnitPolicy(inferUnitFromRoute(state), options);
}

function applySingleDoseDefault(
  state: ParserState,
  options: ParseOptions | undefined
): void {
  if (
    options?.assumeSingleDiscreteDose &&
    state.dose === undefined &&
    state.doseRange === undefined &&
    state.unit !== undefined &&
    isDiscreteUnit(state.unit)
  ) {
    state.dose = 1;
  }
}

export function applyHpsgDefaultConstraints(
  state: ParserState,
  tokens: readonly { lower: string; index: number }[],
  options: ParseOptions | undefined,
  deps: HpsgDefaultConstraintDeps
): void {
  const context = options?.context ?? undefined;
  applyRouteDefault(state, context, deps);
  applyUnitDefault(state, tokens, context, options);
  applySingleDoseDefault(state, options);
}
