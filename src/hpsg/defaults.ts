import { inferRouteFromContext, inferUnitFromContext } from "../context";
import {
  DEFAULT_BODY_SITE_SNOMED,
  DEFAULT_ROUTE_SYNONYMS,
  DEFAULT_UNIT_BY_ROUTE,
  ROUTE_TEXT
} from "../maps";
import { ParserState } from "../parser-state";
import { EventTiming, FhirPeriodUnit, MedicationContext, ParseOptions, RouteCode } from "../types";
import {
  enforceHouseholdUnitPolicy,
  isDiscreteUnit,
  normalizeUnit
} from "../unit-lexicon";
import { normalizeDosageForm } from "../context";

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
  if (state.unit === "puff") {
    deps.setRoute(state, RouteCode["Respiratory tract route (qualifier value)"], ROUTE_TEXT[RouteCode["Respiratory tract route (qualifier value)"]]);
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
    state.unit === undefined
  ) {
    state.unit =
      enforceHouseholdUnitPolicy(inferUnitFromContext(options.context ?? undefined), options) ??
      enforceHouseholdUnitPolicy(inferUnitFromRoute(state), options);
  }
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

const ROUTE_IMPLIED_SITE: Partial<Record<RouteCode, string>> = {
  [RouteCode["Per rectum"]]: "rectum",
  [RouteCode["Per vagina"]]: "vagina"
};

const ROUTE_REDUNDANT_SITE_CODES: Partial<Record<RouteCode, ReadonlySet<string>>> = {
  [RouteCode["Oral route"]]: new Set(["123851003"])
};

function applyRouteSiteDefault(state: ParserState): void {
  if (!state.routeCode) {
    return;
  }
  const redundantCodes = ROUTE_REDUNDANT_SITE_CODES[state.routeCode];
  if (state.siteText && redundantCodes) {
    const currentDefinition = DEFAULT_BODY_SITE_SNOMED[state.siteText.trim().toLowerCase()];
    const currentCode = state.siteCoding?.code ?? currentDefinition?.coding?.code;
    if (currentCode && redundantCodes.has(currentCode)) {
      state.siteText = undefined;
      state.siteCoding = undefined;
      state.siteSource = undefined;
      state.siteLookupRequest = undefined;
    }
  }
  const siteText = ROUTE_IMPLIED_SITE[state.routeCode];
  if (!siteText) {
    return;
  }
  const definition = DEFAULT_BODY_SITE_SNOMED[siteText];
  const impliedCode = definition?.coding?.code;
  if (state.siteText) {
    const current = state.siteText.trim().toLowerCase();
    const currentDefinition = DEFAULT_BODY_SITE_SNOMED[current];
    const currentCode = state.siteCoding?.code ?? currentDefinition?.coding?.code;
    if (
      current !== siteText &&
      impliedCode &&
      (
        currentCode === impliedCode ||
        currentDefinition?.routeHint === state.routeCode
      )
    ) {
      state.siteText = siteText;
      state.siteSource = "text";
    }
    return;
  }
  state.siteText = siteText;
  state.siteSource = "text";
  if (definition?.coding?.code) {
    state.siteCoding = {
      system: definition.coding.system ?? "http://snomed.info/sct",
      code: definition.coding.code,
      display: definition.coding.display
    };
  }
}

function hasStructuredTiming(state: ParserState): boolean {
  return Boolean(
    state.count !== undefined ||
    state.duration !== undefined ||
    state.durationMax !== undefined ||
    state.durationUnit !== undefined ||
    state.frequency !== undefined ||
    state.frequencyMax !== undefined ||
    state.period !== undefined ||
    state.periodMax !== undefined ||
    state.periodUnit !== undefined ||
    state.timingCode !== undefined ||
    state.dayOfWeek.length ||
    state.when.length ||
    state.timeOfDay?.length
  );
}

function addWarning(state: ParserState, warning: string): void {
  if (state.warnings.indexOf(warning) === -1) {
    state.warnings.push(warning);
  }
}

function applyCompletenessWarnings(state: ParserState): void {
  if (
    state.routeCode === RouteCode["Oral route"] &&
    state.asNeeded &&
    state.dose === undefined &&
    state.doseRange === undefined
  ) {
    addWarning(state, "Incomplete sig: missing dose for oral administration.");
  }
  if (
    state.routeCode === RouteCode["Topical route"] &&
    state.siteText &&
    !state.asNeeded &&
    !hasStructuredTiming(state)
  ) {
    addWarning(state, "Incomplete sig: missing timing or PRN qualifier for topical site administration.");
  }
  if (
    state.routeCode === RouteCode["Intravitreal route (qualifier value)"] &&
    !state.siteText
  ) {
    addWarning(state, "Intravitreal administrations require an eye site (e.g., OD/OS/OU).");
  }
}

const ENTERAL_SMART_MEAL_ROUTES = new Set<RouteCode>([
  RouteCode["Oral route"],
  RouteCode["Buccal route"],
  RouteCode["Sublingual route"]
]);

const WITH_MEALS = [EventTiming.Breakfast, EventTiming.Lunch, EventTiming.Dinner] as const;
const BEFORE_MEALS = [EventTiming["Before Breakfast"], EventTiming["Before Lunch"], EventTiming["Before Dinner"]] as const;
const AFTER_MEALS = [EventTiming["After Breakfast"], EventTiming["After Lunch"], EventTiming["After Dinner"]] as const;

const MEAL_RELATION_CODES = {
  [EventTiming.Meal]: WITH_MEALS,
  [EventTiming["Before Meal"]]: BEFORE_MEALS,
  [EventTiming["After Meal"]]: AFTER_MEALS
} as const;

const MEAL_RELATION_BY_CODE: Partial<Record<EventTiming, keyof typeof MEAL_RELATION_CODES>> = {
  [EventTiming.Breakfast]: EventTiming.Meal,
  [EventTiming.Lunch]: EventTiming.Meal,
  [EventTiming.Dinner]: EventTiming.Meal,
  [EventTiming["Before Breakfast"]]: EventTiming["Before Meal"],
  [EventTiming["Before Lunch"]]: EventTiming["Before Meal"],
  [EventTiming["Before Dinner"]]: EventTiming["Before Meal"],
  [EventTiming["After Breakfast"]]: EventTiming["After Meal"],
  [EventTiming["After Lunch"]]: EventTiming["After Meal"],
  [EventTiming["After Dinner"]]: EventTiming["After Meal"]
};

const SPECIFIC_MEAL_INDEX: Partial<Record<EventTiming, number>> = {
  [EventTiming.Breakfast]: 0,
  [EventTiming.Lunch]: 1,
  [EventTiming.Dinner]: 2,
  [EventTiming["Before Breakfast"]]: 0,
  [EventTiming["Before Lunch"]]: 1,
  [EventTiming["Before Dinner"]]: 2,
  [EventTiming["After Breakfast"]]: 0,
  [EventTiming["After Lunch"]]: 1,
  [EventTiming["After Dinner"]]: 2
};

const DEFAULT_EVENT_CLOCK: Record<EventTiming, string> = {
  [EventTiming.Wake]: "06:00",
  [EventTiming["Early Morning"]]: "06:00",
  [EventTiming.Morning]: "08:00",
  [EventTiming["Late Morning"]]: "10:00",
  [EventTiming["Before Breakfast"]]: "07:30",
  [EventTiming.Breakfast]: "08:00",
  [EventTiming["After Breakfast"]]: "08:30",
  [EventTiming.Noon]: "12:00",
  [EventTiming["Before Lunch"]]: "12:00",
  [EventTiming.Lunch]: "12:30",
  [EventTiming["After Lunch"]]: "13:00",
  [EventTiming["Early Afternoon"]]: "14:00",
  [EventTiming.Afternoon]: "15:00",
  [EventTiming["Late Afternoon"]]: "16:00",
  [EventTiming["Early Evening"]]: "18:00",
  [EventTiming["Before Dinner"]]: "18:00",
  [EventTiming.Dinner]: "18:30",
  [EventTiming.Evening]: "19:00",
  [EventTiming["After Dinner"]]: "19:00",
  [EventTiming["Late Evening"]]: "20:00",
  [EventTiming.Night]: "21:00",
  [EventTiming["Before Sleep"]]: "22:00",
  [EventTiming["After Sleep"]]: "06:30",
  [EventTiming.Meal]: "12:00",
  [EventTiming["Before Meal"]]: "12:00",
  [EventTiming["After Meal"]]: "13:00",
  [EventTiming.Immediate]: "00:00"
};

function normalizedFormSet(values: string[] | undefined): Set<string> {
  const result = new Set<string>();
  for (const value of values ?? []) {
    const normalized = normalizeDosageForm(value);
    if (normalized) {
      result.add(normalized);
    }
  }
  return result;
}

function smartMealExpansionAllowed(state: ParserState, options: ParseOptions): boolean {
  const scope = options.smartMealExpansionScope;
  const route = state.routeCode;
  const dosageForm = normalizeDosageForm(options.context?.dosageForm);
  const excludedRoutes = new Set(scope?.excludeRoutes ?? []);
  const includedRoutes = new Set(scope?.includeRoutes ?? []);
  const excludedForms = normalizedFormSet(scope?.excludeDosageForms);
  const includedForms = normalizedFormSet(scope?.includeDosageForms);

  if (route && excludedRoutes.has(route)) {
    return false;
  }
  if (dosageForm && excludedForms.has(dosageForm)) {
    return false;
  }
  if (route && includedRoutes.has(route)) {
    return true;
  }
  if (dosageForm && includedForms.has(dosageForm)) {
    return true;
  }
  if (includedRoutes.size || includedForms.size) {
    return false;
  }
  return !route || ENTERAL_SMART_MEAL_ROUTES.has(route);
}

function mealPair(options: ParseOptions): readonly [EventTiming, EventTiming] {
  return options.twoPerDayPair === "breakfast+lunch"
    ? [EventTiming.Breakfast, EventTiming.Lunch]
    : [EventTiming.Breakfast, EventTiming.Dinner];
}

function relationForContext(options: ParseOptions): keyof typeof MEAL_RELATION_CODES {
  const relation = options.context?.mealRelation;
  return relation === EventTiming["Before Meal"] || relation === EventTiming["After Meal"] || relation === EventTiming.Meal
    ? relation
    : EventTiming.Meal;
}

function expandRelationByFrequency(
  relation: keyof typeof MEAL_RELATION_CODES,
  frequency: number | undefined,
  options: ParseOptions
): EventTiming[] | undefined {
  if (!frequency || frequency < 1 || frequency > 4) {
    return undefined;
  }
  const baseMeals = frequency === 1
    ? [EventTiming.Breakfast]
    : frequency === 2
      ? [...mealPair(options)]
      : frequency === 3
        ? [...WITH_MEALS]
        : [...WITH_MEALS, EventTiming["Before Sleep"]];
  const related = MEAL_RELATION_CODES[relation];
  return baseMeals.map((meal) => {
    const index = SPECIFIC_MEAL_INDEX[meal];
    return index === undefined ? meal : related[index] ?? meal;
  });
}

function normalizeMealRelations(when: EventTiming[], options: ParseOptions): EventTiming[] {
  let relation: keyof typeof MEAL_RELATION_CODES | undefined;
  for (const code of when) {
    if (code === EventTiming["Before Meal"] || code === EventTiming["After Meal"] || code === EventTiming.Meal) {
      relation = code;
      break;
    }
    const candidate = MEAL_RELATION_BY_CODE[code];
    if (candidate && candidate !== EventTiming.Meal) {
      relation = candidate;
      break;
    }
  }
  if (!relation) {
    return when;
  }
  const hasSpecificMealTarget = when.some((code) => SPECIFIC_MEAL_INDEX[code] !== undefined);
  if (!hasSpecificMealTarget) {
    return when;
  }
  const related = MEAL_RELATION_CODES[relation];
  const normalized: EventTiming[] = [];
  for (const code of when) {
    if (code === EventTiming["Before Meal"] || code === EventTiming["After Meal"] || code === EventTiming.Meal) {
      continue;
    }
    const index = SPECIFIC_MEAL_INDEX[code];
    normalized.push(index === undefined ? code : related[index] ?? code);
  }
  return normalized.length ? normalized : when;
}

function clockMinutes(clock: string | undefined): number {
  const match = clock?.match(/^([0-9]{1,2}):([0-9]{2})/);
  if (!match) {
    return Number.MAX_SAFE_INTEGER;
  }
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

function sortWhenCodes(when: EventTiming[], options?: ParseOptions): EventTiming[] {
  const clock = { ...DEFAULT_EVENT_CLOCK, ...(options?.eventClock ?? {}) };
  return when
    .map((code, index) => ({ code, index }))
    .sort((left, right) => {
      const diff = clockMinutes(clock[left.code]) - clockMinutes(clock[right.code]);
      return diff || left.index - right.index;
    })
    .map((entry) => entry.code);
}

function uniqueWhen(values: EventTiming[]): EventTiming[] {
  const seen = new Set<EventTiming>();
  const result: EventTiming[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function replaceWhen(state: ParserState, values: EventTiming[]): void {
  const target = state.when;
  target.splice(0, target.length, ...values);
}

function applySmartMealExpansion(state: ParserState, options: ParseOptions | undefined): void {
  const effectiveOptions = options ?? {};
  if (!options?.smartMealExpansion || !smartMealExpansionAllowed(state, options)) {
    replaceWhen(
      state,
      sortWhenCodes(
        uniqueWhen(normalizeMealRelations(state.when, effectiveOptions)),
        effectiveOptions
      )
    );
    return;
  }
  const dailyCadence =
    state.frequency !== undefined &&
    state.period === 1 &&
    state.periodUnit === FhirPeriodUnit.Day;
  const hasInterval = state.period !== undefined && state.periodUnit !== undefined && !dailyCadence;
  let when = uniqueWhen(state.when);
  const genericRelation = when.find((code) =>
    code === EventTiming["Before Meal"] ||
    code === EventTiming["After Meal"] ||
    code === EventTiming.Meal
  ) as keyof typeof MEAL_RELATION_CODES | undefined;

  if (genericRelation && dailyCadence && !hasInterval) {
    const expanded = expandRelationByFrequency(genericRelation, state.frequency, options);
    if (expanded) {
      when = [
        ...when.filter((code) => code !== genericRelation),
        ...expanded
      ];
    }
  } else if (!when.length && dailyCadence) {
    const expanded = expandRelationByFrequency(relationForContext(options), state.frequency, options);
    if (expanded) {
      when = expanded;
    }
  }

  replaceWhen(state, sortWhenCodes(uniqueWhen(normalizeMealRelations(when, options)), options));
}

function applyWeeklyDefaultForDayFilters(state: ParserState): void {
  if (
    state.dayOfWeek.length &&
    state.frequency === undefined &&
    state.frequencyMax === undefined &&
    state.period === undefined &&
    state.periodMax === undefined &&
    state.periodUnit === undefined &&
    !state.when.length &&
    !state.timeOfDay?.length
  ) {
    state.period = 1;
    state.periodUnit = FhirPeriodUnit.Week;
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
  applyRouteSiteDefault(state);
  applyWeeklyDefaultForDayFilters(state);
  applySmartMealExpansion(state, options);
  applyCompletenessWarnings(state);
}
