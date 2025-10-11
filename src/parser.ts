import {
  DAY_OF_WEEK_TOKENS,
  DEFAULT_ROUTE_SYNONYMS,
  DEFAULT_UNIT_SYNONYMS,
  EVENT_TIMING_TOKENS,
  MEAL_KEYWORDS,
  ROUTE_TEXT,
  TIMING_ABBREVIATIONS,
  WORD_FREQUENCIES
} from "./maps";
import { inferUnitFromContext } from "./context";
import { checkDiscouraged } from "./safety";
import {
  EventTiming,
  FhirDayOfWeek,
  FhirPeriodUnit,
  ParseOptions,
  RouteCode
} from "./types";
import { objectEntries } from "./utils/object";
import { arrayIncludes } from "./utils/array";

export interface Token {
  original: string;
  lower: string;
  index: number;
}

export interface ParsedSigInternal {
  input: string;
  tokens: Token[];
  consumed: Set<number>;
  dose?: number;
  doseRange?: { low: number; high: number };
  unit?: string;
  routeCode?: RouteCode;
  routeText?: string;
  frequency?: number;
  frequencyMax?: number;
  period?: number;
  periodMax?: number;
  periodUnit?: FhirPeriodUnit;
  dayOfWeek: FhirDayOfWeek[];
  when: EventTiming[];
  timingCode?: string;
  asNeeded?: boolean;
  asNeededReason?: string;
  warnings: string[];
  siteText?: string;
}

const BODY_SITE_HINTS = new Set([
  "left",
  "right",
  "bilateral",
  "arm",
  "arms",
  "leg",
  "legs",
  "thigh",
  "thighs",
  "shoulder",
  "shoulders",
  "hand",
  "hands",
  "foot",
  "feet",
  "eye",
  "eyes",
  "ear",
  "ears",
  "nostril",
  "nostrils",
  "abdomen",
  "belly",
  "cheek",
  "cheeks",
  "upper",
  "lower",
  "forearm",
  "back"
]);

const COMBO_EVENT_TIMINGS: Record<string, EventTiming> = {
  "early morning": EventTiming["Early Morning"],
  "late morning": EventTiming["Late Morning"],
  "early afternoon": EventTiming["Early Afternoon"],
  "late afternoon": EventTiming["Late Afternoon"],
  "early evening": EventTiming["Early Evening"],
  "late evening": EventTiming["Late Evening"],
  "after sleep": EventTiming["After Sleep"],
  "upon waking": EventTiming.Wake
};

// Tracking explicit breakfast/lunch/dinner markers lets the meal-expansion
// logic bail early when the clinician already specified precise events.
const SPECIFIC_MEAL_TIMINGS = new Set<EventTiming>([
  EventTiming["Before Breakfast"],
  EventTiming["Before Lunch"],
  EventTiming["Before Dinner"],
  EventTiming["After Breakfast"],
  EventTiming["After Lunch"],
  EventTiming["After Dinner"],
  EventTiming.Breakfast,
  EventTiming.Lunch,
  EventTiming.Dinner
]);

// Ocular shorthand tokens commonly used in ophthalmic sigs.
const EYE_SITE_TOKENS: Record<string, { site: string; route?: RouteCode }> = {
  od: { site: "right eye", route: RouteCode["Ophthalmic route"] },
  re: { site: "right eye", route: RouteCode["Ophthalmic route"] },
  os: { site: "left eye", route: RouteCode["Ophthalmic route"] },
  le: { site: "left eye", route: RouteCode["Ophthalmic route"] },
  ou: { site: "both eyes", route: RouteCode["Ophthalmic route"] },
  be: { site: "both eyes", route: RouteCode["Ophthalmic route"] },
  vod: {
    site: "right eye",
    route: RouteCode["Intravitreal route (qualifier value)"]
  },
  vos: {
    site: "left eye",
    route: RouteCode["Intravitreal route (qualifier value)"]
  },
  ivtod: {
    site: "right eye",
    route: RouteCode["Intravitreal route (qualifier value)"]
  },
  ivtre: {
    site: "right eye",
    route: RouteCode["Intravitreal route (qualifier value)"]
  },
  ivtos: {
    site: "left eye",
    route: RouteCode["Intravitreal route (qualifier value)"]
  },
  ivtle: {
    site: "left eye",
    route: RouteCode["Intravitreal route (qualifier value)"]
  },
  ivtou: {
    site: "both eyes",
    route: RouteCode["Intravitreal route (qualifier value)"]
  },
  ivtbe: {
    site: "both eyes",
    route: RouteCode["Intravitreal route (qualifier value)"]
  }
};

export function tokenize(input: string): Token[] {
  const separators = /[(),]/g;
  let normalized = input.trim().replace(separators, " ");
  normalized = normalized.replace(/(\d+)\s*\/\s*(\d+)/g, (match, num, den) => {
    const numerator = parseFloat(num);
    const denominator = parseFloat(den);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
      return match;
    }
    const value = numerator / denominator;
    return value.toString();
  });
  normalized = normalized.replace(/(\d+(?:\.\d+)?[x*])([A-Za-z]+)/g, "$1 $2");
  normalized = normalized.replace(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/g, "$1-$2");
  normalized = normalized.replace(
    /(\d+(?:\.\d+)?)(tab|tabs|tablet|tablets|cap|caps|capsule|capsules|mg|mcg|ml|g|drops|drop|puff|puffs|spray|sprays|patch|patches)/gi,
    "$1 $2"
  );
  normalized = normalized.replace(/[\\/]/g, " ");
  const rawTokens = normalized
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t !== "." && t !== "-");

  const tokens: Token[] = [];
  for (let i = 0; i < rawTokens.length; i++) {
    const raw = rawTokens[i];
    const parts = splitToken(raw);
    for (const part of parts) {
      if (!part) continue;
      tokens.push({ original: part, lower: part.toLowerCase(), index: tokens.length });
    }
  }
  return tokens;
}

function splitToken(token: string): string[] {
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(token)) {
    return [token];
  }
  if (/^[A-Za-z]+$/.test(token)) {
    return [token];
  }
  const qRange = token.match(/^q([0-9]+(?:\.[0-9]+)?)-([0-9]+(?:\.[0-9]+)?)([A-Za-z]+)$/i);
  if (qRange) {
    const [, low, high, unit] = qRange;
    return [token.charAt(0), `${low}-${high}`, unit];
  }
  const match = token.match(/^([0-9]+(?:\.[0-9]+)?)([A-Za-z]+)$/);
  if (match) {
    const [, num, unit] = match;
    if (!/^x\d+/i.test(unit) && !/^q\d+/i.test(unit)) {
      return [num, unit];
    }
  }
  return [token];
}

function mark(consumed: Set<number>, token: Token) {
  consumed.add(token.index);
}

function addWhen(target: EventTiming[], code: EventTiming) {
  if (!arrayIncludes(target, code)) {
    target.push(code);
  }
}

// Removing is slightly more work than adding because a clinician might repeat
// the same token; trimming them all keeps downstream assertions tidy.
function removeWhen(target: EventTiming[], code: EventTiming) {
  let index = target.indexOf(code);
  while (index !== -1) {
    target.splice(index, 1);
    index = target.indexOf(code);
  }
}

// Translate the requested expansion context into the appropriate sequence of
// EventTiming values (e.g., AC -> ACM/ACD/ACV) for the detected frequency.
function computeMealExpansions(
  base: "before" | "after" | "with",
  frequency: number,
  pairPreference: "breakfast+dinner" | "breakfast+lunch"
): EventTiming[] | undefined {
  if (frequency < 1 || frequency > 4) {
    return undefined;
  }

  const bedtime = EventTiming["Before Sleep"];
  const beforePair =
    pairPreference === "breakfast+lunch"
      ? [EventTiming["Before Breakfast"], EventTiming["Before Lunch"]]
      : [EventTiming["Before Breakfast"], EventTiming["Before Dinner"]];
  const afterPair =
    pairPreference === "breakfast+lunch"
      ? [EventTiming["After Breakfast"], EventTiming["After Lunch"]]
      : [EventTiming["After Breakfast"], EventTiming["After Dinner"]];
  const withPair =
    pairPreference === "breakfast+lunch"
      ? [EventTiming.Breakfast, EventTiming.Lunch]
      : [EventTiming.Breakfast, EventTiming.Dinner];

  if (base === "before") {
    if (frequency === 1) return [EventTiming["Before Breakfast"]];
    if (frequency === 2) return beforePair;
    if (frequency === 3) {
      return [
        EventTiming["Before Breakfast"],
        EventTiming["Before Lunch"],
        EventTiming["Before Dinner"]
      ];
    }
    return [
      EventTiming["Before Breakfast"],
      EventTiming["Before Lunch"],
      EventTiming["Before Dinner"],
      bedtime
    ];
  }

  if (base === "after") {
    if (frequency === 1) return [EventTiming["After Breakfast"]];
    if (frequency === 2) return afterPair;
    if (frequency === 3) {
      return [
        EventTiming["After Breakfast"],
        EventTiming["After Lunch"],
        EventTiming["After Dinner"]
      ];
    }
    return [
      EventTiming["After Breakfast"],
      EventTiming["After Lunch"],
      EventTiming["After Dinner"],
      bedtime
    ];
  }

  // base === "with"
  if (frequency === 1) return [EventTiming.Breakfast];
  if (frequency === 2) return withPair;
  if (frequency === 3) {
    return [EventTiming.Breakfast, EventTiming.Lunch, EventTiming.Dinner];
  }
  return [EventTiming.Breakfast, EventTiming.Lunch, EventTiming.Dinner, bedtime];
}

// Optionally replace generic meal tokens with concrete breakfast/lunch/dinner
// EventTiming codes when the cadence makes the intent obvious.
function expandMealTimings(
  internal: ParsedSigInternal,
  options?: ParseOptions
) {
  if (!options?.smartMealExpansion) {
    return;
  }
  if (!internal.when.length) {
    return;
  }
  if (internal.when.some((code) => SPECIFIC_MEAL_TIMINGS.has(code))) {
    return;
  }

  const frequency = internal.frequency;
  if (!frequency || frequency < 1 || frequency > 4) {
    return;
  }

  if (
    internal.period !== undefined &&
    internal.periodUnit !== undefined &&
    (internal.periodUnit !== FhirPeriodUnit.Day || internal.period !== 1)
  ) {
    return;
  }
  if (
    internal.period !== undefined &&
    internal.periodUnit === undefined &&
    internal.period !== 1
  ) {
    return;
  }
  if (internal.periodUnit && internal.periodUnit !== FhirPeriodUnit.Day) {
    return;
  }
  if (internal.frequencyMax !== undefined || internal.periodMax !== undefined) {
    return;
  }

  const pairPreference = options.twoPerDayPair ?? "breakfast+dinner";

  const replacements: Array<{ general: EventTiming; specifics: EventTiming[] }> = [];

  if (arrayIncludes(internal.when, EventTiming["Before Meal"])) {
    const specifics = computeMealExpansions("before", frequency, pairPreference);
    if (specifics) {
      replacements.push({ general: EventTiming["Before Meal"], specifics });
    }
  }
  if (arrayIncludes(internal.when, EventTiming["After Meal"])) {
    const specifics = computeMealExpansions("after", frequency, pairPreference);
    if (specifics) {
      replacements.push({ general: EventTiming["After Meal"], specifics });
    }
  }
  if (arrayIncludes(internal.when, EventTiming.Meal)) {
    const specifics = computeMealExpansions("with", frequency, pairPreference);
    if (specifics) {
      replacements.push({ general: EventTiming.Meal, specifics });
    }
  }

  for (const { general, specifics } of replacements) {
    removeWhen(internal.when, general);
    for (const specific of specifics) {
      addWhen(internal.when, specific);
    }
  }
}

function setRoute(
  internal: ParsedSigInternal,
  code: RouteCode,
  text?: string
) {
  internal.routeCode = code;
  internal.routeText = text ?? ROUTE_TEXT[code];
}

/**
 * Convert hour-based values into minutes when fractional quantities appear so
 * the resulting FHIR repeat payloads avoid unwieldy decimals.
 */
function normalizePeriodValue(value: number, unit: FhirPeriodUnit): {
  value: number;
  unit: FhirPeriodUnit;
} {
  if (unit === FhirPeriodUnit.Hour && (!Number.isInteger(value) || value < 1)) {
    return { value: Math.round(value * 60 * 1000) / 1000, unit: FhirPeriodUnit.Minute };
  }
  return { value, unit };
}

/**
 * Ensure ranges expressed in hours remain consistent when fractional values
 * demand conversion into minutes.
 */
function normalizePeriodRange(
  low: number,
  high: number,
  unit: FhirPeriodUnit
): { low: number; high: number; unit: FhirPeriodUnit } {
  if (unit === FhirPeriodUnit.Hour && (!Number.isInteger(low) || !Number.isInteger(high) || low < 1 || high < 1)) {
    return {
      low: Math.round(low * 60 * 1000) / 1000,
      high: Math.round(high * 60 * 1000) / 1000,
      unit: FhirPeriodUnit.Minute
    };
  }
  return { low, high, unit };
}

function periodUnitSuffix(unit: FhirPeriodUnit): string | undefined {
  switch (unit) {
    case FhirPeriodUnit.Minute:
      return "min";
    case FhirPeriodUnit.Hour:
      return "h";
    case FhirPeriodUnit.Day:
      return "d";
    case FhirPeriodUnit.Week:
      return "wk";
    case FhirPeriodUnit.Month:
      return "mo";
    case FhirPeriodUnit.Year:
      return "a";
    default:
      return undefined;
  }
}

function maybeAssignTimingCode(
  internal: ParsedSigInternal,
  value: number,
  unit: FhirPeriodUnit
) {
  const suffix = periodUnitSuffix(unit);
  if (!suffix) {
    return;
  }
  const key = `q${value}${suffix}`;
  const descriptor = TIMING_ABBREVIATIONS[key];
  if (descriptor?.code && !internal.timingCode) {
    internal.timingCode = descriptor.code;
  }
}

/**
 * Apply the chosen period/unit pair and infer helpful timing codes when the
 * period clearly represents common cadences (daily/weekly/monthly).
 */
function applyPeriod(
  internal: ParsedSigInternal,
  period: number,
  unit: FhirPeriodUnit
) {
  const normalized = normalizePeriodValue(period, unit);
  internal.period = normalized.value;
  internal.periodUnit = normalized.unit;
  maybeAssignTimingCode(internal, normalized.value, normalized.unit);
  if (normalized.unit === FhirPeriodUnit.Day && normalized.value === 1) {
    internal.frequency = internal.frequency ?? 1;
  }
  if (normalized.unit === FhirPeriodUnit.Week && normalized.value === 1) {
    internal.timingCode = internal.timingCode ?? "WK";
  }
  if (normalized.unit === FhirPeriodUnit.Month && normalized.value === 1) {
    internal.timingCode = internal.timingCode ?? "MO";
  }
}

/**
 * Parse compact q-interval tokens like q30min, q0.5h, or q1w, optionally using
 * the following token as the unit if the compact token only carries the value.
 */
function tryParseCompactQ(
  internal: ParsedSigInternal,
  tokens: Token[],
  index: number
): boolean {
  const token = tokens[index];
  const lower = token.lower;
  const compact = lower.match(/^q([0-9]+(?:\.[0-9]+)?)([a-z]+)$/);
  if (compact) {
    const value = parseFloat(compact[1]);
    const unitCode = mapIntervalUnit(compact[2]);
    if (Number.isFinite(value) && unitCode) {
      applyPeriod(internal, value, unitCode);
      mark(internal.consumed, token);
      return true;
    }
  }
  const valueOnly = lower.match(/^q([0-9]+(?:\.[0-9]+)?)$/);
  if (valueOnly) {
    const unitToken = tokens[index + 1];
    if (!unitToken || internal.consumed.has(unitToken.index)) {
      return false;
    }
    const unitCode = mapIntervalUnit(unitToken.lower);
    if (!unitCode) {
      return false;
    }
    const value = parseFloat(valueOnly[1]);
    if (!Number.isFinite(value)) {
      return false;
    }
    applyPeriod(internal, value, unitCode);
    mark(internal.consumed, token);
    mark(internal.consumed, unitToken);
    return true;
  }
  return false;
}

function applyFrequencyDescriptor(
  internal: ParsedSigInternal,
  token: Token,
  descriptor: {
    code?: string;
    frequency?: number;
    frequencyMax?: number;
    period?: number;
    periodMax?: number;
    periodUnit?: FhirPeriodUnit;
    when?: EventTiming[];
    discouraged?: string;
  },
  options?: ParseOptions
) {
  if (descriptor.discouraged) {
    const check = checkDiscouraged(token.original, options);
    if (check.warning) {
      internal.warnings.push(check.warning);
    }
  }
  if (descriptor.code) {
    internal.timingCode = descriptor.code;
  }
  if (descriptor.frequency !== undefined) {
    internal.frequency = descriptor.frequency;
  }
  if (descriptor.frequencyMax !== undefined) {
    internal.frequencyMax = descriptor.frequencyMax;
  }
  if (descriptor.period !== undefined) {
    internal.period = descriptor.period;
  }
  if (descriptor.periodMax !== undefined) {
    internal.periodMax = descriptor.periodMax;
  }
  if (descriptor.periodUnit) {
    internal.periodUnit = descriptor.periodUnit;
  }
  if (descriptor.when) {
    for (const w of descriptor.when) {
      addWhen(internal.when, w);
    }
  }
  mark(internal.consumed, token);
}

function applyWhenToken(
  internal: ParsedSigInternal,
  token: Token,
  code: EventTiming
) {
  addWhen(internal.when, code);
  mark(internal.consumed, token);
}

function parseMealContext(
  internal: ParsedSigInternal,
  tokens: Token[],
  index: number,
  code: EventTiming
) {
  const token = tokens[index];
  const next = tokens[index + 1];
  if (!next || internal.consumed.has(next.index)) {
    applyWhenToken(internal, token, code);
    return;
  }
  const meal = MEAL_KEYWORDS[next.lower];
  if (meal) {
    const whenCode =
      code === EventTiming["After Meal"]
        ? meal.pc
        : code === EventTiming["Before Meal"]
        ? meal.ac
        : code;
    applyWhenToken(internal, token, whenCode);
    mark(internal.consumed, next);
    return;
  }
  applyWhenToken(internal, token, code);
}

function parseSeparatedQ(
  internal: ParsedSigInternal,
  tokens: Token[],
  index: number,
  options?: ParseOptions
) {
  const token = tokens[index];
  const next = tokens[index + 1];
  if (!next || internal.consumed.has(next.index)) {
    return false;
  }
  const after = tokens[index + 2];
  const lowerNext = next.lower;
  const range = parseNumericRange(lowerNext);
  if (range) {
    const unitToken = after;
    if (!unitToken) {
      return false;
    }
    const unitCode = mapIntervalUnit(unitToken.lower);
    if (!unitCode) {
      return false;
    }
    const normalized = normalizePeriodRange(range.low, range.high, unitCode);
    internal.period = normalized.low;
    internal.periodMax = normalized.high;
    internal.periodUnit = normalized.unit;
    mark(internal.consumed, token);
    mark(internal.consumed, next);
    mark(internal.consumed, unitToken);
    return true;
  }
  const isNumber = /^[0-9]+(?:\.[0-9]+)?$/.test(lowerNext);
  if (!isNumber) {
    const unitCode = mapIntervalUnit(lowerNext);
    if (unitCode) {
      mark(internal.consumed, token);
      mark(internal.consumed, next);
      applyPeriod(internal, 1, unitCode);
      return true;
    }
    return false;
  }
  const unitToken = after;
  if (!unitToken) {
    return false;
  }
  const unitCode = mapIntervalUnit(unitToken.lower);
  if (!unitCode) {
    return false;
  }
  const value = parseFloat(next.original);
  applyPeriod(internal, value, unitCode);
  mark(internal.consumed, token);
  mark(internal.consumed, next);
  mark(internal.consumed, unitToken);
  return true;
}

function mapIntervalUnit(token: string):
  | FhirPeriodUnit.Minute
  | FhirPeriodUnit.Hour
  | FhirPeriodUnit.Day
  | FhirPeriodUnit.Week
  | FhirPeriodUnit.Month
  | undefined {
  if (
    token === "min" ||
    token === "mins" ||
    token === "minute" ||
    token === "minutes" ||
    token === "m"
  ) {
    return FhirPeriodUnit.Minute;
  }
  if (token === "h" || token === "hr" || token === "hrs" || token === "hour" || token === "hours") {
    return FhirPeriodUnit.Hour;
  }
  if (token === "d" || token === "day" || token === "days") {
    return FhirPeriodUnit.Day;
  }
  if (token === "wk" || token === "w" || token === "week" || token === "weeks") {
    return FhirPeriodUnit.Week;
  }
  if (token === "mo" || token === "month" || token === "months") {
    return FhirPeriodUnit.Month;
  }
  return undefined;
}

function parseNumericRange(token: string): { low: number; high: number } | undefined {
  const rangeMatch = token.match(/^([0-9]+(?:\.[0-9]+)?)-([0-9]+(?:\.[0-9]+)?)$/);
  if (!rangeMatch) {
    return undefined;
  }
  const low = parseFloat(rangeMatch[1]);
  const high = parseFloat(rangeMatch[2]);
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    return undefined;
  }
  return { low, high };
}

export function parseInternal(
  input: string,
  options?: ParseOptions
): ParsedSigInternal {
  const tokens = tokenize(input);
  const internal: ParsedSigInternal = {
    input,
    tokens,
    consumed: new Set<number>(),
    dayOfWeek: [],
    when: [],
    warnings: []
  };

  const context = options?.context ?? undefined;
  const customRouteMap = options?.routeMap
    ? new Map(
        objectEntries(options.routeMap).map(([key, value]) => [
          key.toLowerCase(),
          value
        ])
      )
    : undefined;

  if (tokens.length === 0) {
    return internal;
  }

  // PRN detection
  let prnReasonStart: number | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.lower === "prn") {
      internal.asNeeded = true;
      mark(internal.consumed, token);
      prnReasonStart = i + 1;
      break;
    }
    if (token.lower === "as" && tokens[i + 1]?.lower === "needed") {
      internal.asNeeded = true;
      mark(internal.consumed, token);
      mark(internal.consumed, tokens[i + 1]);
      let reasonIndex = i + 2;
      if (tokens[reasonIndex]?.lower === "for") {
        mark(internal.consumed, tokens[reasonIndex]);
        reasonIndex += 1;
      }
      prnReasonStart = reasonIndex;
      break;
    }
  }

  // Multiplicative tokens like 1x3
  for (const token of tokens) {
    if (internal.consumed.has(token.index)) continue;
    const match = token.lower.match(/^([0-9]+(?:\.[0-9]+)?)[x*]([0-9]+(?:\.[0-9]+)?)$/);
    if (match) {
      const dose = parseFloat(match[1]);
      const freq = parseFloat(match[2]);
      if (internal.dose === undefined) {
        internal.dose = dose;
      }
      internal.frequency = freq;
      internal.period = 1;
      internal.periodUnit = FhirPeriodUnit.Day;
      mark(internal.consumed, token);
    }
  }

  // Process tokens sequentially
  const tryRouteSynonym = (startIndex: number): boolean => {
    const maxSpan = Math.min(24, tokens.length - startIndex);
    for (let span = maxSpan; span >= 1; span--) {
      const slice = tokens.slice(startIndex, startIndex + span);
      if (slice.some((part) => internal.consumed.has(part.index))) {
        continue;
      }
      const phrase = slice.map((part) => part.lower).join(" ");
      const customCode = customRouteMap?.get(phrase);
      const synonym = customCode
        ? { code: customCode, text: ROUTE_TEXT[customCode] }
        : DEFAULT_ROUTE_SYNONYMS[phrase];
      if (synonym) {
        setRoute(internal, synonym.code, synonym.text);
        for (const part of slice) {
          mark(internal.consumed, part);
        }
        return true;
      }
    }
    return false;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (internal.consumed.has(token.index)) {
      continue;
    }

    if (token.lower === "bld" || token.lower === "b-l-d") {
      const check = checkDiscouraged(token.original, options);
      if (check.warning) {
        internal.warnings.push(check.warning);
      }
      applyWhenToken(internal, token, EventTiming.Meal);
      continue;
    }

    if (token.lower === "q") {
      if (parseSeparatedQ(internal, tokens, i, options)) {
        continue;
      }
    }

    // Frequency abbreviation map
    const freqDescriptor = TIMING_ABBREVIATIONS[token.lower];
    if (freqDescriptor) {
      applyFrequencyDescriptor(internal, token, freqDescriptor, options);
      continue;
    }

    if (tryParseCompactQ(internal, tokens, i)) {
      continue;
    }

    // Event timing tokens
    if (token.lower === "pc" || token.lower === "ac") {
      parseMealContext(
        internal,
        tokens,
        i,
        token.lower === "pc"
          ? EventTiming["After Meal"]
          : EventTiming["Before Meal"]
      );
      continue;
    }
    const nextToken = tokens[i + 1];
    if (nextToken && !internal.consumed.has(nextToken.index)) {
      const combo = `${token.lower} ${nextToken.lower}`;
      const comboWhen = COMBO_EVENT_TIMINGS[combo] ?? EVENT_TIMING_TOKENS[combo];
      if (comboWhen) {
        applyWhenToken(internal, token, comboWhen);
        mark(internal.consumed, nextToken);
        continue;
      }
    }
    const customWhen = options?.whenMap?.[token.lower];
    if (customWhen) {
      applyWhenToken(internal, token, customWhen);
      continue;
    }
    const whenCode = EVENT_TIMING_TOKENS[token.lower];
    if (whenCode) {
      applyWhenToken(internal, token, whenCode);
      continue;
    }

    // Day of week
    const day = DAY_OF_WEEK_TOKENS[token.lower];
    if (day) {
      if (!arrayIncludes(internal.dayOfWeek, day)) {
        internal.dayOfWeek.push(day);
      }
      mark(internal.consumed, token);
      continue;
    }

    // Units following numbers handled later

    if (tryRouteSynonym(i)) {
      continue;
    }

    const eyeSite = EYE_SITE_TOKENS[token.lower];
    if (eyeSite) {
      internal.siteText = eyeSite.site;
      if (eyeSite.route && !internal.routeCode) {
        setRoute(internal, eyeSite.route);
      }
      mark(internal.consumed, token);
      continue;
    }

    // Numeric dose
    const rangeValue = parseNumericRange(token.lower);
    if (rangeValue) {
      if (!internal.doseRange) {
        internal.doseRange = rangeValue;
      }
      mark(internal.consumed, token);
      const unitToken = tokens[i + 1];
      if (unitToken && !internal.consumed.has(unitToken.index)) {
        const unit = normalizeUnit(unitToken.lower, options);
        if (unit) {
          internal.unit = unit;
          mark(internal.consumed, unitToken);
        }
      }
      continue;
    }
    if (/^[0-9]+(?:\.[0-9]+)?$/.test(token.lower)) {
      const value = parseFloat(token.original);
      if (internal.dose === undefined) {
        internal.dose = value;
      }
      mark(internal.consumed, token);
      const unitToken = tokens[i + 1];
      if (unitToken && !internal.consumed.has(unitToken.index)) {
        const unit = normalizeUnit(unitToken.lower, options);
        if (unit) {
          internal.unit = unit;
          mark(internal.consumed, unitToken);
        }
      }
      continue;
    }

    // Patterns like 1x or 2x
    const timesMatch = token.lower.match(/^([0-9]+(?:\.[0-9]+)?)[x*]$/);
    if (timesMatch) {
      const val = parseFloat(timesMatch[1]);
      if (internal.dose === undefined) {
        internal.dose = val;
      }
      mark(internal.consumed, token);
      continue;
    }

    // Words for frequency
    const wordFreq = WORD_FREQUENCIES[token.lower];
    if (wordFreq) {
      internal.frequency = wordFreq.frequency;
      internal.period = 1;
      internal.periodUnit = wordFreq.periodUnit;
      mark(internal.consumed, token);
      continue;
    }

    // Skip generic connectors
    if (token.lower === "per" || token.lower === "a" || token.lower === "every") {
      mark(internal.consumed, token);
      continue;
    }
  }

  // Units from trailing tokens if still undefined
  if (internal.unit === undefined) {
    for (const token of tokens) {
      if (internal.consumed.has(token.index)) continue;
      const unit = normalizeUnit(token.lower, options);
      if (unit) {
        internal.unit = unit;
        mark(internal.consumed, token);
        break;
      }
    }
  }

  if (internal.unit === undefined) {
    internal.unit = inferUnitFromContext(context);
  }

  // Frequency defaults when timing code implies it
  if (
    internal.frequency === undefined &&
    internal.period === undefined &&
    internal.timingCode
  ) {
    const descriptor = TIMING_ABBREVIATIONS[internal.timingCode.toLowerCase()];
    if (descriptor) {
      if (descriptor.frequency !== undefined) {
        internal.frequency = descriptor.frequency;
      }
      if (descriptor.period !== undefined) {
        internal.period = descriptor.period;
      }
      if (descriptor.periodUnit) {
        internal.periodUnit = descriptor.periodUnit;
      }
      if (descriptor.when) {
        for (const w of descriptor.when) {
          addWhen(internal.when, w);
        }
      }
    }
  }

  if (
    !internal.timingCode &&
    internal.frequency !== undefined &&
    internal.periodUnit === FhirPeriodUnit.Day &&
    (internal.period === undefined || internal.period === 1)
  ) {
    if (internal.frequency === 2) {
      internal.timingCode = "BID";
    } else if (internal.frequency === 3) {
      internal.timingCode = "TID";
    } else if (internal.frequency === 4) {
      internal.timingCode = "QID";
    }
  }

  // Expand generic meal markers into specific EventTiming codes when asked to.
  expandMealTimings(internal, options);

  // Determine site text from leftover tokens (excluding PRN reason tokens)
  const leftoverTokens = tokens.filter((t) => !internal.consumed.has(t.index));
  if (leftoverTokens.length > 0) {
    const siteCandidates = leftoverTokens.filter((t) => BODY_SITE_HINTS.has(t.lower));
    if (siteCandidates.length > 0) {
      const indices = new Set(siteCandidates.map((t) => t.index));
      const words: string[] = [];
      for (const token of leftoverTokens) {
        if (indices.has(token.index) || BODY_SITE_HINTS.has(token.lower)) {
          words.push(token.original);
          mark(internal.consumed, token);
        }
      }
      if (words.length > 0) {
        internal.siteText = words.join(" ");
      }
    }
  }

  // PRN reason text
  if (internal.asNeeded && prnReasonStart !== undefined) {
    const reasonTokens: string[] = [];
    for (let i = prnReasonStart; i < tokens.length; i++) {
      const token = tokens[i];
      if (internal.consumed.has(token.index)) {
        continue;
      }
      reasonTokens.push(token.original);
      mark(internal.consumed, token);
    }
    if (reasonTokens.length > 0) {
      internal.asNeededReason = reasonTokens.join(" ");
    }
  }

  if (
    internal.routeCode === RouteCode["Intravitreal route (qualifier value)"] &&
    (!internal.siteText || !/eye/i.test(internal.siteText))
  ) {
    internal.warnings.push(
      "Intravitreal administrations require an eye site (e.g., OD/OS/OU)."
    );
  }

  return internal;
}

function normalizeUnit(token: string, options?: ParseOptions): string | undefined {
  const override = options?.unitMap?.[token];
  if (override) {
    return override;
  }
  const defaultUnit = DEFAULT_UNIT_SYNONYMS[token];
  if (defaultUnit) {
    return defaultUnit;
  }
  return undefined;
}
