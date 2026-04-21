import {
  DAY_OF_WEEK_TOKENS,
  DEFAULT_BODY_SITE_HINTS,
  DEFAULT_BODY_SITE_SNOMED,
  DEFAULT_PRN_REASON_DEFINITIONS,
  DEFAULT_PRN_REASON_ENTRIES,
  DEFAULT_ROUTE_SYNONYMS,
  DEFAULT_UNIT_BY_ROUTE,
  DEFAULT_UNIT_SYNONYMS,
  EVENT_TIMING_TOKENS,
  HOUSEHOLD_VOLUME_UNITS,
  MEAL_KEYWORDS,
  ROUTE_TEXT,
  TIMING_ABBREVIATIONS,
  WORD_FREQUENCIES,
  normalizeBodySiteKey,
  normalizePrnReasonKey
} from "./maps";
import { parseAdditionalInstructions } from "./advice";
import { inferRouteFromContext, inferUnitFromContext, normalizeDosageForm } from "./context";
import { lexInput } from "./lexer/lex";
import { LexKind } from "./lexer/token-types";
import { checkDiscouraged } from "./safety";
import {
  extractExplicitSiteCandidate,
  inferRouteHintFromSitePhrase as inferRouteHintFromSitePhraseFromModule,
  selectBestResidualSiteCandidate,
  SitePhraseCandidate,
  SitePhraseServices
} from "./site-phrases";
import { ParserState, Token } from "./parser-state";
import {
  BodySiteDefinition,
  CanonicalSigClause,
  EventTiming,
  FhirCoding,
  FhirDayOfWeek,
  FhirPeriodUnit,
  MedicationContext,
  ParseOptions,
  PrnReasonDefinition,
  PrnReasonLookupRequest,
  PrnReasonResolver,
  PrnReasonSelection,
  PrnReasonSuggestion,
  PrnReasonSuggestionResolver,
  PrnReasonSuggestionsResult,
  RouteCode,
  SmartMealExpansionScope,
  SiteCodeLookupRequest,
  SiteCodeResolver,
  SiteCodeSelection,
  SiteCodeSuggestion,
  SiteCodeSuggestionResolver,
  SiteCodeSuggestionsResult,
  TextRange
} from "./types";
import { objectEntries } from "./utils/object";
import { arrayIncludes } from "./utils/array";
import {
  annotateLexTokens,
  expandDayMeaningRange,
  getDayOfWeekMeaning,
  getEventTimingMeaning,
  getPrimarySiteMeaningCandidate,
  getRouteMeaning,
  getTimingAbbreviationMeaning,
  hasTokenWordClass,
  isApplicationVerbWord,
  isCountKeywordWord,
  isDayRangeConnectorWord,
  isMealContextConnectorWord,
  isSiteAnchorWord,
  isSiteListConnectorWord,
  isSiteSurfaceModifierWord,
  isWorkflowInstructionWord,
  TokenWordClass
} from "./lexer/meaning";

const SNOMED_SYSTEM = "http://snomed.info/sct";

function buildCustomSiteHints(
  map: Record<string, BodySiteDefinition> | undefined
): Set<string> | undefined {
  if (!map) {
    return undefined;
  }
  const hints = new Set<string>();
  const addPhraseHints = (phrase: string | undefined) => {
    if (!phrase) {
      return;
    }
    const normalized = normalizeBodySiteKey(phrase);
    if (!normalized) {
      return;
    }
    for (const part of normalized.split(" ")) {
      if (part) {
        hints.add(part);
      }
    }
  };

  for (const [key, definition] of objectEntries(map)) {
    addPhraseHints(key);
    if (definition.aliases) {
      for (const alias of definition.aliases) {
        addPhraseHints(alias);
      }
    }
  }

  return hints;
}

function isBodySiteHint(word: string, customSiteHints?: Set<string>): boolean {
  return DEFAULT_BODY_SITE_HINTS.has(word) || (customSiteHints?.has(word) ?? false);
}

const SITE_CONNECTORS = new Set(["to", "in", "into", "on", "onto", "at"]);

const DURATION_UNIT_WORDS = new Set([
  "second",
  "seconds",
  "sec",
  "secs",
  "minute",
  "minutes",
  "min",
  "mins",
  "hour",
  "hours",
  "hr",
  "hrs"
]);

const SITE_FILLER_WORDS = new Set([
  "the",
  "a",
  "an",
  "your",
  "his",
  "her",
  "their",
  "my"
]);

const HOUSEHOLD_VOLUME_UNIT_SET = new Set(
  HOUSEHOLD_VOLUME_UNITS.map((unit) => unit.toLowerCase()),
);

const DISCRETE_UNIT_SET = new Set([
  "tab",
  "tabs",
  "tablet",
  "tablets",
  "cap",
  "caps",
  "capsule",
  "capsules",
  "puff",
  "puffs",
  "spray",
  "sprays",
  "drop",
  "drops",
  "patch",
  "patches",
  "suppository",
  "suppositories",
  "implant",
  "implants",
  "piece",
  "pieces",
  "stick",
  "sticks",
  "pessary",
  "pessaries",
  "lozenge",
  "lozenges"
]);

const OCULAR_DIRECTION_WORDS = new Set([
  "left",
  "right",
  "both",
  "either",
  "each",
  "bilateral"
]);

const OCULAR_SITE_WORDS = new Set([
  "eye",
  "eyes",
  "eyelid",
  "eyelids",
  "ocular",
  "ophthalmic",
  "oculus"
]);

const COMBO_EVENT_TIMINGS: Record<string, EventTiming> = {
  "early morning": EventTiming["Early Morning"],
  "late morning": EventTiming["Late Morning"],
  "early afternoon": EventTiming["Early Afternoon"],
  "late afternoon": EventTiming["Late Afternoon"],
  "early evening": EventTiming["Early Evening"],
  "late evening": EventTiming["Late Evening"],
  "after sleep": EventTiming["After Sleep"],
  "before bed": EventTiming["Before Sleep"],
  "before bedtime": EventTiming["Before Sleep"],
  "before sleep": EventTiming["Before Sleep"],
  "upon waking": EventTiming.Wake
};

const DAY_RANGE_PART_PATTERN = Object.keys(DAY_OF_WEEK_TOKENS)
  .sort((a, b) => b.length - a.length)
  .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

const DAY_RANGE_SPACED_HYPHEN_REGEX = new RegExp(
  `(^|\\s)(${DAY_RANGE_PART_PATTERN})\\s*-\\s*(${DAY_RANGE_PART_PATTERN})(?=\\s|$)`,
  "giu"
);

const COUNT_CONNECTOR_WORDS = new Set([
  "a",
  "an",
  "the",
  "total",
  "of",
  "up",
  "to",
  "no",
  "more",
  "than",
  "max",
  "maximum",
  "additional",
  "extra"
]);

const FREQUENCY_SIMPLE_WORDS: Record<string, number> = {
  once: 1,
  twice: 2,
  thrice: 3
};

const FREQUENCY_NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12
};

const FREQUENCY_TIMES_WORDS = new Set(["time", "times", "x"]);

const FREQUENCY_CONNECTOR_WORDS = new Set(["per", "a", "an", "each", "every"]);

const FREQUENCY_ADVERB_UNITS: Record<string, FhirPeriodUnit> = {
  daily: FhirPeriodUnit.Day,
  weekly: FhirPeriodUnit.Week,
  monthly: FhirPeriodUnit.Month,
  hourly: FhirPeriodUnit.Hour
};

const ROUTE_DESCRIPTOR_FILLER_WORDS = new Set([
  "per",
  "by",
  "via",
  "the",
  "a",
  "an"
]);

function normalizeRouteDescriptorPhrase(phrase: string): string {
  return phrase
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0 && !ROUTE_DESCRIPTOR_FILLER_WORDS.has(word))
    .join(" ");
}

const DEFAULT_ROUTE_DESCRIPTOR_SYNONYMS = (() => {
  const map = new Map<string, { code: RouteCode; text: string }>();
  for (const [phrase, synonym] of objectEntries(DEFAULT_ROUTE_SYNONYMS)) {
    const normalized = normalizeRouteDescriptorPhrase(phrase);
    if (normalized && !map.has(normalized)) {
      map.set(normalized, synonym);
    }
  }
  return map;
})();

const ROUTE_IMPLIED_SITE_TEXT: Partial<Record<RouteCode, string>> = {
  [RouteCode["Per rectum"]]: "rectum",
  [RouteCode["Per vagina"]]: "vagina"
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

const OPHTHALMIC_ROUTE_CODES = new Set<RouteCode>([
  RouteCode["Ophthalmic route"],
  RouteCode["Ocular route (qualifier value)"],
  RouteCode["Intravitreal route (qualifier value)"]
]);

function isOphthalmicSiteCandidate(
  candidate: { text: string; route?: RouteCode } | undefined
): boolean {
  if (!candidate) {
    return false;
  }
  return (
    /eye/i.test(candidate.text) ||
    (candidate.route !== undefined && OPHTHALMIC_ROUTE_CODES.has(candidate.route))
  );
}

const OPHTHALMIC_CONTEXT_TOKENS = new Set<string>([
  "drop",
  "drops",
  "gtt",
  "gtts",
  "eye",
  "eyes",
  "eyelid",
  "eyelids",
  "ocular",
  "ophthalmic",
  "ophth",
  "oculus",
  "os",
  "ou",
  "re",
  "le",
  "be"
]);

function normalizeTokenLower(token: Token): string {
  return token.lower.replace(/[.{};]/g, "");
}

function hasOphthalmicContextHint(tokens: Token[], index: number): boolean {
  for (let offset = -3; offset <= 3; offset++) {
    if (offset === 0) {
      continue;
    }
    const neighbor = tokens[index + offset];
    if (!neighbor) {
      continue;
    }
    const normalized = normalizeTokenLower(neighbor);
    if (OPHTHALMIC_CONTEXT_TOKENS.has(normalized) || normalized.includes("eye")) {
      return true;
    }
  }
  return false;
}

function shouldInterpretOdAsOnceDaily(
  internal: ParserState,
  tokens: Token[],
  index: number,
  treatAsSite: boolean
): boolean {
  if (treatAsSite) {
    return false;
  }

  const hasCadenceAssigned =
    internal.frequency !== undefined ||
    internal.frequencyMax !== undefined ||
    internal.period !== undefined ||
    internal.periodMax !== undefined ||
    internal.timingCode !== undefined;

  const hasPriorSiteContext = hasBodySiteContextBefore(internal, tokens, index);
  const hasUpcomingSiteContext = hasBodySiteContextAfter(internal, tokens, index);

  const previous = tokens[index - 1];
  const previousNormalized = previous ? normalizeTokenLower(previous) : undefined;
  const previousIsOd = previousNormalized === "od";
  const previousConsumed = previousIsOd && internal.consumed.has(previous.index);
  const previousOdProvidedSite = previousConsumed && /eye/i.test(internal.siteText ?? "");

  if (previousOdProvidedSite) {
    return true;
  }

  const previousSiteCandidate =
    previousNormalized && previousNormalized !== "od"
      ? getPrimarySiteMeaningCandidate(previous)
      : undefined;
  if (
    previousSiteCandidate &&
    isOphthalmicSiteCandidate(previousSiteCandidate) &&
    internal.consumed.has(previous.index)
  ) {
    return true;
  }

  if (
    previousNormalized === "od" &&
    internal.siteSource === "abbreviation" &&
    internal.siteText &&
    /eye/i.test(internal.siteText)
  ) {
    return true;
  }

  if (hasPriorSiteContext || hasUpcomingSiteContext) {
    return !hasCadenceAssigned;
  }

  if (hasCadenceAssigned) {
    return false;
  }

  if (internal.routeCode && !OPHTHALMIC_ROUTE_CODES.has(internal.routeCode)) {
    return true;
  }

  if (internal.unit && internal.unit !== "drop") {
    return true;
  }

  if (internal.siteText && !/eye/i.test(internal.siteText)) {
    return true;
  }

  const hasNonOdToken = tokens.some((token, tokenIndex) => {
    if (tokenIndex === index) {
      return false;
    }
    return normalizeTokenLower(token) !== "od";
  });

  if (!hasNonOdToken) {
    return false;
  }

  const ophthalmicContext =
    hasOphthalmicContextHint(tokens, index) ||
    (internal.routeCode !== undefined && OPHTHALMIC_ROUTE_CODES.has(internal.routeCode)) ||
    (internal.siteText !== undefined && /eye/i.test(internal.siteText));

  if (ophthalmicContext && hasSpelledOcularSiteBefore(tokens, index)) {
    return true;
  }

  return !ophthalmicContext;
}

function hasBodySiteContextBefore(
  internal: ParserState,
  tokens: Token[],
  index: number
): boolean {
  const currentToken = tokens[index];
  const currentTokenIndex = currentToken ? currentToken.index : index;

  if (internal.siteText) {
    return true;
  }

  for (const tokenIndex of internal.siteTokenIndices) {
    if (tokenIndex < currentTokenIndex) {
      return true;
    }
  }

  for (let i = 0; i < index; i++) {
    const token = tokens[i];
    if (!token) {
      continue;
    }
    if (internal.consumed.has(token.index)) {
      if (internal.siteTokenIndices.has(token.index) && token.index < currentTokenIndex) {
        return true;
      }
      continue;
    }
    const normalized = normalizeTokenLower(token);
    if (isBodySiteHint(normalized, internal.customSiteHints)) {
      return true;
    }
    if (getPrimarySiteMeaningCandidate(token)) {
      return true;
    }
  }

  return false;
}

function hasBodySiteContextAfter(
  internal: ParserState,
  tokens: Token[],
  index: number
): boolean {
  const currentToken = tokens[index];
  const currentTokenIndex = currentToken ? currentToken.index : index;

  for (const tokenIndex of internal.siteTokenIndices) {
    if (tokenIndex > currentTokenIndex) {
      return true;
    }
  }

  let seenConnector = false;
  for (let i = index + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) {
      continue;
    }
    if (internal.consumed.has(token.index)) {
      if (internal.siteTokenIndices.has(token.index) && token.index > currentTokenIndex) {
        return true;
      }
      continue;
    }
    const normalized = normalizeTokenLower(token);
    if (SITE_CONNECTORS.has(normalized)) {
      seenConnector = true;
      continue;
    }
    if (SITE_FILLER_WORDS.has(normalized)) {
      continue;
    }
    if (isBodySiteHint(normalized, internal.customSiteHints)) {
      return true;
    }
    if (seenConnector) {
      break;
    }
    if (!seenConnector) {
      break;
    }
  }
  return false;
}

function hasSpelledOcularSiteBefore(tokens: Token[], index: number): boolean {
  let hasOcularWord = false;
  let hasDirectionalCue = false;
  for (let i = 0; i < index; i++) {
    const token = tokens[i];
    if (!token) {
      continue;
    }
    const normalized = normalizeTokenLower(token);
    if (SITE_CONNECTORS.has(normalized) || OCULAR_DIRECTION_WORDS.has(normalized)) {
      hasDirectionalCue = true;
    }
    if (OCULAR_SITE_WORDS.has(normalized) || normalized.includes("eye")) {
      hasOcularWord = true;
    }
    if (hasDirectionalCue && hasOcularWord) {
      return true;
    }
  }
  return false;
}

function shouldTreatAbbreviatedSiteCandidateAsSite(
  internal: ParserState,
  tokens: Token[],
  index: number,
  context?: MedicationContext | null
): boolean {
  const currentToken = tokens[index];
  const normalizedSelf = normalizeTokenLower(currentToken);
  const siteCandidate = getPrimarySiteMeaningCandidate(currentToken);
  const contextRoute = inferRouteFromContext(context ?? undefined);

  if (internal.routeCode && !OPHTHALMIC_ROUTE_CODES.has(internal.routeCode)) {
    return false;
  }

  if (contextRoute && !OPHTHALMIC_ROUTE_CODES.has(contextRoute)) {
    return false;
  }

  if (internal.siteText) {
    return false;
  }

  if (internal.siteSource === "abbreviation") {
    return false;
  }

  const dosageForm = context?.dosageForm?.toLowerCase();
  const contextImpliesOphthalmic = contextRoute
    ? OPHTHALMIC_ROUTE_CODES.has(contextRoute)
    : Boolean(dosageForm && /(eye|ophth|ocular|intravit)/i.test(dosageForm));
  const eyeRouteImpliesOphthalmic =
    siteCandidate?.route === RouteCode["Intravitreal route (qualifier value)"];
  const ophthalmicContext =
    hasOphthalmicContextHint(tokens, index) ||
    (internal.routeCode !== undefined && OPHTHALMIC_ROUTE_CODES.has(internal.routeCode)) ||
    contextImpliesOphthalmic ||
    eyeRouteImpliesOphthalmic;

  if (hasBodySiteContextAfter(internal, tokens, index)) {
    return false;
  }
  if (!ophthalmicContext) {
    const hasOtherActiveTokens = tokens.some(
      (token, tokenIndex) =>
        tokenIndex !== index && !internal.consumed.has(token.index)
    );
    const onlyEyeTokens = tokens.every((token, tokenIndex) => {
      if (tokenIndex === index || internal.consumed.has(token.index)) {
        return true;
      }
      return normalizeTokenLower(token) === "od";
    });
    if (!hasOtherActiveTokens) {
      return internal.unit === undefined && internal.routeCode === undefined;
    }
    if (onlyEyeTokens) {
      return true;
    }
    return false;
  }

  for (let i = 0; i < index; i++) {
    const candidate = tokens[i];
    if (internal.consumed.has(candidate.index)) {
      continue;
    }
    const normalized = normalizeTokenLower(candidate);
    if (SITE_CONNECTORS.has(normalized)) {
      continue;
    }
    if (isBodySiteHint(normalized, internal.customSiteHints)) {
      return false;
    }
    if (isOphthalmicSiteCandidate(getPrimarySiteMeaningCandidate(candidate))) {
      return false;
    }
    if (DEFAULT_ROUTE_SYNONYMS[normalized]) {
      return false;
    }
  }

  return true;
}

function tryParseNumericCadence(
  internal: ParserState,
  tokens: Token[],
  index: number
): boolean {
  const token = tokens[index];
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(token.lower)) {
    return false;
  }
  if (
    internal.frequency !== undefined ||
    internal.frequencyMax !== undefined ||
    internal.period !== undefined ||
    internal.periodMax !== undefined
  ) {
    return false;
  }

  let nextIndex = index + 1;
  const connectors: Token[] = [];
  while (true) {
    const connector = tokens[nextIndex];
    if (!connector || internal.consumed.has(connector.index)) {
      break;
    }
    const normalized = normalizeTokenLower(connector);
    if (normalized === "per" || normalized === "a" || normalized === "each" || normalized === "every") {
      connectors.push(connector);
      nextIndex += 1;
      continue;
    }
    break;
  }

  if (!connectors.length) {
    return false;
  }

  const unitToken = tokens[nextIndex];
  if (!unitToken || internal.consumed.has(unitToken.index)) {
    return false;
  }
  const unitCode = mapIntervalUnit(normalizeTokenLower(unitToken));
  if (!unitCode) {
    return false;
  }

  const value = parseFloat(token.original);
  if (!Number.isFinite(value)) {
    return false;
  }

  internal.frequency = value;
  internal.period = 1;
  internal.periodUnit = unitCode;
  if (value === 1 && unitCode === FhirPeriodUnit.Day && !internal.timingCode) {
    internal.timingCode = "QD";
  }

  mark(internal.consumed, token);
  for (const connector of connectors) {
    mark(internal.consumed, connector);
  }
  mark(internal.consumed, unitToken);
  return true;
}

function tryParseCountBasedFrequency(
  internal: ParserState,
  tokens: Token[],
  index: number,
  options?: ParseOptions
): boolean {
  const token = tokens[index];
  if (internal.consumed.has(token.index)) {
    return false;
  }
  if (
    internal.frequency !== undefined ||
    internal.frequencyMax !== undefined ||
    internal.period !== undefined ||
    internal.periodMax !== undefined
  ) {
    return false;
  }

  const normalized = normalizeTokenLower(token);
  let value: number | undefined;
  let requiresPeriod = true;
  let requiresCue = true;

  if (/^[0-9]+(?:\.[0-9]+)?$/.test(normalized)) {
    value = parseFloat(token.original);
  } else {
    const simple = FREQUENCY_SIMPLE_WORDS[normalized];
    if (simple !== undefined) {
      value = simple;
      requiresPeriod = false;
      requiresCue = false;
    } else {
      const wordValue = FREQUENCY_NUMBER_WORDS[normalized];
      if (wordValue === undefined) {
        return false;
      }
      value = wordValue;
    }
  }

  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return false;
  }

  const nextToken = tokens[index + 1];
  if (
    nextToken &&
    !internal.consumed.has(nextToken.index) &&
    normalizeUnit(normalizeTokenLower(nextToken), options)
  ) {
    return false;
  }

  const partsToConsume: Token[] = [];
  let nextIndex = index + 1;
  let periodUnit: FhirPeriodUnit | undefined;
  let sawCue = !requiresCue;
  let sawTimesWord = false;
  let sawConnectorWord = false;

  while (true) {
    const candidate = tokens[nextIndex];
    if (!candidate || internal.consumed.has(candidate.index)) {
      break;
    }
    const lower = normalizeTokenLower(candidate);
    if (FREQUENCY_TIMES_WORDS.has(lower)) {
      partsToConsume.push(candidate);
      sawCue = true;
      sawTimesWord = true;
      nextIndex += 1;
      continue;
    }
    if (FREQUENCY_CONNECTOR_WORDS.has(lower)) {
      partsToConsume.push(candidate);
      sawCue = true;
      sawConnectorWord = true;
      nextIndex += 1;
      continue;
    }
    const adverbUnit = mapFrequencyAdverb(lower);
    if (adverbUnit) {
      periodUnit = adverbUnit;
      partsToConsume.push(candidate);
      break;
    }
    const mappedUnit = mapIntervalUnit(lower);
    if (mappedUnit) {
      periodUnit = mappedUnit;
      partsToConsume.push(candidate);
      break;
    }
    break;
  }

  if (!periodUnit) {
    if (requiresPeriod) {
      return false;
    }
    periodUnit = FhirPeriodUnit.Day;
  }

  if (requiresCue && !sawCue) {
    return false;
  }

  internal.frequency = value;
  internal.period = 1;
  internal.periodUnit = periodUnit;
  if (value === 1 && periodUnit === FhirPeriodUnit.Day && !internal.timingCode) {
    internal.timingCode = "QD";
  }

  let consumeCurrentToken = true;
  if (value === 1 && !sawConnectorWord && sawTimesWord && periodUnit !== FhirPeriodUnit.Day) {
    consumeCurrentToken = false;
  }

  if (consumeCurrentToken) {
    mark(internal.consumed, token);
  }
  for (const part of partsToConsume) {
    mark(internal.consumed, part);
  }

  return consumeCurrentToken;
}

function parseTimeToFhir(timeStr: string): string | undefined {
  const clean = timeStr.toLowerCase().trim();
  // Match 9:00, 9.00, 9:00am, 9pm, 9 am, 9
  const match =
    clean.match(/^(\d{1,2})[:.](\d{2})\s*(am|pm)?$/) ||
    clean.match(/^(\d{1,2})\s*(am|pm)$/) ||
    clean.match(/^(\d{1,2})$/);

  const compact24h = clean.match(/^(\d{3,4})$/);
  if (!match && compact24h) {
    const digits = compact24h[1];
    const hourText = digits.slice(0, digits.length - 2);
    const minuteText = digits.slice(-2);
    const hour = parseInt(hourText, 10);
    const minute = parseInt(minuteText, 10);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      const normalizedHour = hour < 10 ? `0${hour}` : `${hour}`;
      return `${normalizedHour}:${minuteText}:00`;
    }
  }

  if (!match) return undefined;

  let hour = parseInt(match[1], 10);
  let minute = 0;
  let ampm: string | undefined;

  if (match[2] && !isNaN(parseInt(match[2], 10))) {
    minute = parseInt(match[2], 10);
    ampm = match[3];
  } else {
    ampm = match[2];
  }

  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;

  const h = hour < 10 ? `0${hour}` : `${hour}`;
  const m = minute < 10 ? `0${minute}` : `${minute}`;
  return `${h}:${m}:00`;
}

function extractAttachedAtTimeToken(lower: string): string | undefined {
  if (lower.length <= 1) {
    return undefined;
  }
  if (lower.charAt(0) === "@") {
    const candidate = lower.slice(1);
    return parseTimeToFhir(candidate) ? candidate : undefined;
  }
  if (lower.startsWith("at") && lower.length > 2 && /^\d/.test(lower.charAt(2))) {
    const candidate = lower.slice(2);
    return parseTimeToFhir(candidate) ? candidate : undefined;
  }
  return undefined;
}

function isAtPrefixToken(lower: string): boolean {
  return lower === "@" || lower === "at" || extractAttachedAtTimeToken(lower) !== undefined;
}

function tryParseTimeBasedSchedule(
  internal: ParserState,
  tokens: Token[],
  index: number
): boolean {
  const token = tokens[index];
  if (internal.consumed.has(token.index)) return false;

  const attachedAtTime = extractAttachedAtTimeToken(token.lower);
  const isAtPrefix = isAtPrefixToken(token.lower);
  if (!isAtPrefix && !/^\d/.test(token.lower)) return false;

  let nextIndex = index;
  const times: string[] = [];
  const consumedIndices: number[] = [];
  const timeTokens: string[] = [];

  if (token.lower === "@" || token.lower === "at") {
    consumedIndices.push(index);
    nextIndex++;
  } else if (attachedAtTime) {
    let timeStr = attachedAtTime;
    const lookaheadIndices: number[] = [];
    if (!timeStr.includes("am") && !timeStr.includes("pm")) {
      const ampmToken = tokens[index + 1];
      if (
        ampmToken &&
        !internal.consumed.has(ampmToken.index) &&
        (ampmToken.lower === "am" || ampmToken.lower === "pm")
      ) {
        timeStr += ampmToken.lower;
        lookaheadIndices.push(index + 1);
      }
    }
    const compactTime = parseTimeToFhir(timeStr);
    if (!compactTime) {
      return false;
    }
    times.push(compactTime);
    timeTokens.push(timeStr);
    consumedIndices.push(index);
    for (const idx of lookaheadIndices) {
      consumedIndices.push(idx);
    }
    nextIndex = index + 1 + lookaheadIndices.length;
  }

  while (nextIndex < tokens.length) {
    const nextToken = tokens[nextIndex];
    if (!nextToken || internal.consumed.has(nextToken.index)) break;

    if ((nextToken.lower === "," || nextToken.lower === "and") && times.length > 0) {
      const peekToken = tokens[nextIndex + 1];
      if (peekToken && !internal.consumed.has(peekToken.index)) {
        let peekStr = peekToken.lower;
        const ampmToken = tokens[nextIndex + 2];
        if (
          ampmToken &&
          !internal.consumed.has(ampmToken.index) &&
          (ampmToken.lower === "am" || ampmToken.lower === "pm")
        ) {
          peekStr += ampmToken.lower;
        }
        if (parseTimeToFhir(peekStr)) {
          consumedIndices.push(nextIndex);
          nextIndex++;
          continue;
        }
      }
    }

    let timeStr = nextToken.lower;
    let lookaheadIndices: number[] = [];

    // Look ahead for am/pm if current token is just a number or doesn't have am/pm
    if (!timeStr.includes("am") && !timeStr.includes("pm")) {
      const nextNext = tokens[nextIndex + 1];
      if (nextNext && !internal.consumed.has(nextNext.index) && (nextNext.lower === "am" || nextNext.lower === "pm")) {
        timeStr += nextNext.lower;
        lookaheadIndices.push(nextIndex + 1);
      }
    }

    const time = parseTimeToFhir(timeStr);
    if (time) {
      times.push(time);
      timeTokens.push(timeStr);
      consumedIndices.push(nextIndex);
      for (const idx of lookaheadIndices) {
        consumedIndices.push(idx);
      }
      nextIndex += 1 + lookaheadIndices.length;

      // Support comma or space separated times
      const separatorToken = tokens[nextIndex];
      // Check if there is another time after the separator
      if (separatorToken && (separatorToken.lower === "," || separatorToken.lower === "and")) {
        // Peek for next time
        let peekIndex = nextIndex + 1;
        let peekToken = tokens[peekIndex];
        if (peekToken) {
          let peekStr = peekToken.lower;
          let peekNext = tokens[peekIndex + 1];
          if (peekNext && !internal.consumed.has(peekNext.index) && (peekNext.lower === "am" || peekNext.lower === "pm")) {
            peekStr += peekNext.lower;
          }
          if (parseTimeToFhir(peekStr)) {
            consumedIndices.push(nextIndex);
            nextIndex++;
            continue;
          }
        }
      }
      continue;
    }
    break;
  }

  if (times.length > 0) {
    if (!isAtPrefix) {
      const hasClearTimeFormat = timeTokens.some(
        (t) => t.includes(":") || t.includes("am") || t.includes("pm")
      );
      if (!hasClearTimeFormat) {
        return false;
      }
    }

    internal.timeOfDay = internal.timeOfDay || [];
    for (const time of times) {
      if (!arrayIncludes(internal.timeOfDay, time)) {
        internal.timeOfDay.push(time);
      }
    }
    for (const idx of consumedIndices) {
      mark(internal.consumed, tokens[idx]);
    }
    return true;
  }

  return false;
}

export function tokenize(input: string): Token[] {
  return annotateLexTokens(lexInput(input));
}

function computeTrimmedInputRange(input: string): TextRange | undefined {
  if (!input) {
    return undefined;
  }
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

function buildCanonicalSourceSpan(
  input: string,
  range: TextRange | undefined,
  tokenIndices?: number[]
): CanonicalSigClause["raw"] {
  const safeRange = range ?? { start: 0, end: input.length };
  return {
    start: safeRange.start,
    end: safeRange.end,
    text: input.slice(safeRange.start, safeRange.end),
    tokenIndices: tokenIndices?.length ? [...tokenIndices] : undefined
  };
}

function collectCanonicalLeftovers(
  internal: ParserState
): CanonicalSigClause["leftovers"] {
  const groups: CanonicalSigClause["leftovers"] = [];
  let current: number[] = [];

  const flush = () => {
    if (!current.length) {
      return;
    }
    const range = computeTokenRange(internal.input, internal.tokens, current);
    if (range) {
      groups.push(buildCanonicalSourceSpan(internal.input, range, current));
    }
    current = [];
  };

  for (const token of internal.tokens) {
    if (internal.consumed.has(token.index)) {
      flush();
      continue;
    }
    if (current.length > 0 && token.index !== current[current.length - 1] + 1) {
      flush();
    }
    current.push(token.index);
  }

  flush();
  return groups;
}

function computeClauseConfidence(
  internal: ParserState,
  leftovers: CanonicalSigClause["leftovers"]
): number {
  let confidence = 1;
  confidence -= Math.min(0.4, leftovers.length * 0.12);
  confidence -= Math.min(0.2, internal.warnings.length * 0.08);
  if (!internal.routeCode && !internal.routeText && !internal.siteText && !internal.timingCode) {
    confidence -= 0.05;
  }
  if (confidence < 0) {
    return 0;
  }
  if (confidence > 1) {
    return 1;
  }
  return Number(confidence.toFixed(2));
}

function createClauseBackedInternal(
  input: string,
  tokens: Token[],
  customSiteHints?: Set<string>
): ParserState {
  return new ParserState(input, tokens, customSiteHints);
}

function detectPrnPrelude(
  state: ParserState,
  tokens: Token[]
): number | undefined {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.lower === "prn") {
      state.asNeeded = true;
      mark(state.consumed, token);
      let reasonIndex = index + 1;
      if (tokens[reasonIndex]?.lower === "for") {
        mark(state.consumed, tokens[reasonIndex]);
        reasonIndex += 1;
      }
      return reasonIndex;
    }
    if (token.lower === "as" && tokens[index + 1]?.lower === "needed") {
      state.asNeeded = true;
      mark(state.consumed, token);
      mark(state.consumed, tokens[index + 1]);
      let reasonIndex = index + 2;
      if (tokens[reasonIndex]?.lower === "for") {
        mark(state.consumed, tokens[reasonIndex]);
        reasonIndex += 1;
      }
      return reasonIndex;
    }
  }
  return undefined;
}

function collectMultiplicativeCadence(
  state: ParserState,
  tokens: Token[],
  options?: ParseOptions
): void {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (state.consumed.has(token.index)) {
      continue;
    }
    const combined = token.lower.match(/^([0-9]+(?:\.[0-9]+)?)[x*]([0-9]+(?:\.[0-9]+)?)$/);
    if (combined) {
      const dose = parseFloat(combined[1]);
      const frequency = parseFloat(combined[2]);
      if (state.dose === undefined) {
        state.dose = dose;
      }
      state.frequency = frequency;
      state.period = 1;
      state.periodUnit = FhirPeriodUnit.Day;
      mark(state.consumed, token);
      continue;
    }

    const hasNumericDoseBefore = (): boolean => {
      for (let cursor = index - 1; cursor >= 0; cursor--) {
        const previous = tokens[cursor];
        if (!previous) {
          continue;
        }
        if (state.consumed.has(previous.index)) {
          continue;
        }
        if (/^[0-9]+(?:\.[0-9]+)?$/.test(previous.lower)) {
          return true;
        }
        if (normalizeUnit(previous.lower, options)) {
          continue;
        }
        break;
      }
      return false;
    };

    if (state.frequency !== undefined || !hasNumericDoseBefore()) {
      continue;
    }

    const prefix = token.lower.match(/^[x*]([0-9]+(?:\.[0-9]+)?)$/);
    if (prefix) {
      const frequency = parseFloat(prefix[1]);
      if (Number.isFinite(frequency)) {
        state.frequency = frequency;
        state.period = 1;
        state.periodUnit = FhirPeriodUnit.Day;
        mark(state.consumed, token);
        continue;
      }
    }

    if (token.lower !== "x" && token.lower !== "*") {
      continue;
    }
    const next = tokens[index + 1];
    if (
      next &&
      !state.consumed.has(next.index) &&
      /^[0-9]+(?:\.[0-9]+)?$/.test(next.lower)
    ) {
      const frequency = parseFloat(next.original);
      if (Number.isFinite(frequency)) {
        state.frequency = frequency;
        state.period = 1;
        state.periodUnit = FhirPeriodUnit.Day;
        mark(state.consumed, token);
        mark(state.consumed, next);
      }
    }
  }
}

function applyClauseDefaultsAfterTokenScan(
  state: ParserState,
  tokens: Token[],
  context: MedicationContext | undefined,
  options?: ParseOptions
): void {
  if (state.unit === undefined) {
    for (const token of tokens) {
      if (state.consumed.has(token.index)) {
        continue;
      }
      const unit = normalizeUnit(token.lower, options);
      if (unit) {
        state.unit = unit;
        mark(state.consumed, token);
        break;
      }
    }
  }

  if (state.unit === undefined) {
    state.unit = enforceHouseholdUnitPolicy(
      inferUnitFromContext(context),
      options
    );
  }

  if (state.unit === undefined) {
    const fallbackUnit = enforceHouseholdUnitPolicy(
      inferUnitFromRouteHints(state),
      options
    );
    if (fallbackUnit) {
      state.unit = fallbackUnit;
    }
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

  if (
    state.frequency === undefined &&
    state.period === undefined &&
    state.timingCode
  ) {
    const descriptor = TIMING_ABBREVIATIONS[state.timingCode.toLowerCase()];
    if (descriptor) {
      if (descriptor.frequency !== undefined) {
        state.frequency = descriptor.frequency;
      }
      if (descriptor.period !== undefined) {
        state.period = descriptor.period;
      }
      if (descriptor.periodUnit) {
        state.periodUnit = descriptor.periodUnit;
      }
      if (descriptor.when) {
        for (const whenCode of descriptor.when) {
          addWhen(state.when, whenCode);
        }
      }
    }
  }

  if (
    !state.timingCode &&
    state.frequency !== undefined &&
    state.periodUnit === FhirPeriodUnit.Day &&
    (state.period === undefined || state.period === 1)
  ) {
    if (state.frequency === 2) {
      state.timingCode = "BID";
    } else if (state.frequency === 3) {
      state.timingCode = "TID";
    } else if (state.frequency === 4) {
      state.timingCode = "QID";
    }
  }

  reconcileMealTimingSpecificity(state);
  expandMealTimings(state, options);
  sortWhenValues(state, options);
}

function collectPrnReasonText(
  state: ParserState,
  tokens: Token[],
  prnReasonStart: number | undefined,
  prnSiteSuffixIndices: Set<number>,
  options?: ParseOptions
): void {
  if (!state.asNeeded || prnReasonStart === undefined) {
    return;
  }
  const reasonTokens: string[] = [];
  const reasonIndices: number[] = [];
  const reasonObjects: Token[] = [];
  const PRN_RECLAIMABLE_CONNECTORS = new Set(["at", "to", "in", "into", "on", "onto"]);
  for (let index = prnReasonStart; index < tokens.length; index++) {
    const token = tokens[index];
    if (state.consumed.has(token.index)) {
      if (!PRN_RECLAIMABLE_CONNECTORS.has(token.lower)) {
        continue;
      }
    }

    const PRN_INTRODUCTIONS = new Set(["for", "if", "when", "upon", "due", "to"]);
    if (reasonTokens.length === 0 && PRN_INTRODUCTIONS.has(token.lower)) {
      if (token.lower === "due") {
        const next = tokens[index + 1];
        if (next && next.lower === "to") {
          mark(state.consumed, token);
          mark(state.consumed, next);
          index += 1;
          continue;
        }
      }
      mark(state.consumed, token);
      continue;
    }

    reasonTokens.push(token.original);
    reasonIndices.push(token.index);
    reasonObjects.push(token);
    mark(state.consumed, token);
  }

  if (!reasonTokens.length) {
    return;
  }

  let sortedIndices = reasonIndices.slice().sort((a, b) => a - b);
  let range = computeTokenRange(state.input, tokens, sortedIndices);
  let sourceText = range ? state.input.slice(range.start, range.end) : undefined;
  if (sourceText) {
    const cutoff = determinePrnReasonCutoff(reasonObjects, sourceText);
    if (cutoff !== undefined) {
      for (let index = cutoff; index < reasonObjects.length; index++) {
        state.consumed.delete(reasonObjects[index].index);
      }
      reasonObjects.splice(cutoff);
      reasonTokens.splice(cutoff);
      reasonIndices.splice(cutoff);
      while (reasonTokens.length > 0) {
        const lastToken = reasonTokens[reasonTokens.length - 1];
        if (!lastToken || /^[;:.,-]+$/.test(lastToken.trim())) {
          const removedObject = reasonObjects.pop();
          if (removedObject) {
            state.consumed.delete(removedObject.index);
          }
          reasonTokens.pop();
          const removedIndex = reasonIndices.pop();
          if (removedIndex !== undefined) {
            state.consumed.delete(removedIndex);
          }
          continue;
        }
        break;
      }
      if (reasonTokens.length > 0) {
        sortedIndices = reasonIndices.slice().sort((a, b) => a - b);
        range = computeTokenRange(state.input, tokens, sortedIndices);
        sourceText = range ? state.input.slice(range.start, range.end) : undefined;
      } else {
        range = undefined;
        sourceText = undefined;
      }
    }
  }

  let canonicalPrefix: string | undefined;
  if (reasonTokens.length > 0) {
    const suffixInfo = findTrailingPrnSiteSuffix(reasonObjects, state, options);
    if (suffixInfo?.tokens?.length) {
      for (const token of suffixInfo.tokens) {
        prnSiteSuffixIndices.add(token.index);
      }
    }
    if (suffixInfo && suffixInfo.startIndex > 0) {
      const prefixTokens = reasonObjects
        .slice(0, suffixInfo.startIndex)
        .map((token) => token.original)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (prefixTokens) {
        canonicalPrefix = prefixTokens.replace(/[{}]/g, " ").replace(/\s+/g, " ").trim();
      }
    }
  }

  if (!reasonTokens.length) {
    return;
  }
  const joined = reasonTokens.join(" ").trim();
  if (!joined) {
    return;
  }
  let sanitized = joined.replace(/\s+/g, " ").trim();
  let isProbe = false;
  const probeMatch = sanitized.match(/^\{(.+)}$/);
  if (probeMatch) {
    isProbe = true;
    sanitized = probeMatch[1];
  }
  sanitized = sanitized.replace(/[{}]/g, " ").replace(/\s+/g, " ").trim();
  const text = sanitized || joined;
  state.asNeededReason = text;
  const normalized = text.toLowerCase();
  const canonicalSource = canonicalPrefix || sanitized || text;
  const canonical = canonicalSource
    ? normalizePrnReasonKey(canonicalSource)
    : normalizePrnReasonKey(text);
  state.prnReasonLookupRequest = {
    originalText: joined,
    text,
    normalized,
    canonical: canonical ?? "",
    isProbe,
    inputText: state.input,
    sourceText,
    range
  };
}

function collectSiteAdviceAndWarnings(
  state: ParserState,
  tokens: Token[],
  prnReasonStart: number | undefined,
  prnSiteSuffixIndices: Set<number>,
  options: ParseOptions | undefined,
  maybeApplyRouteDescriptor: (phrase: string | undefined) => boolean
): void {
  if (!state.siteText) {
    const sitePhraseServices = buildSitePhraseServices(state, tokens, options);
    for (let index = 0; index < tokens.length; index++) {
      if (prnReasonStart !== undefined && index >= prnReasonStart) {
        break;
      }
      const candidate = extractExplicitSiteCandidate(
        tokens,
        state.consumed,
        index,
        options,
        sitePhraseServices
      );
      if (
        candidate &&
        applySitePhraseCandidate(
          state,
          tokens,
          candidate,
          options,
          maybeApplyRouteDescriptor
        )
      ) {
        break;
      }
    }
  }

  if (!state.siteText) {
    const groups = findUnparsedTokenGroups(state);
    const sitePhraseServices = buildSitePhraseServices(state, tokens, options);
    const siteCandidate = selectBestResidualSiteCandidate(
      groups,
      prnSiteSuffixIndices,
      sitePhraseServices
    );
    if (siteCandidate) {
      applySitePhraseCandidate(
        state,
        tokens,
        siteCandidate,
        options,
        maybeApplyRouteDescriptor
      );
    }
  }

  if (!state.routeCode && state.siteText) {
    const routeHint = inferRouteHintFromSitePhraseFromModule(state.siteText, options, {
      lookupBodySiteDefinition
    });
    if (routeHint) {
      setRoute(state, routeHint);
    }
  }

  seedSiteFromRoute(state, options);

  if (!state.routeCode && state.siteText && hasApplicationVerbBefore(tokens, tokens.length, state.consumed)) {
    setRoute(state, RouteCode["Topical route"]);
  }

  collectAdditionalInstructions(state, tokens);

  if (
    state.routeCode === RouteCode["Intravitreal route (qualifier value)"] &&
    (!state.siteText || !/eye/i.test(state.siteText))
  ) {
    state.warnings.push(
      "Intravitreal administrations require an eye site (e.g., OD/OS/OU)."
    );
  }
}

function finalizeCanonicalClause(internal: ParserState): void {
  const clause = internal.primaryClause;

  clause.rawText = internal.input;
  const trimmedRange = computeTrimmedInputRange(internal.input);
  clause.span = trimmedRange;
  clause.raw = buildCanonicalSourceSpan(internal.input, trimmedRange);
  clause.leftovers = collectCanonicalLeftovers(internal);
  clause.confidence = computeClauseConfidence(internal, clause.leftovers);
  clause.warnings = internal.warnings.length ? [...internal.warnings] : undefined;

  if (clause.schedule) {
    if (!clause.schedule.dayOfWeek?.length) {
      delete clause.schedule.dayOfWeek;
    }
    if (!clause.schedule.when?.length) {
      delete clause.schedule.when;
    }
    if (!clause.schedule.timeOfDay?.length) {
      delete clause.schedule.timeOfDay;
    }
    if (
      clause.schedule.timingCode === undefined &&
      clause.schedule.count === undefined &&
      clause.schedule.frequency === undefined &&
      clause.schedule.frequencyMax === undefined &&
      clause.schedule.period === undefined &&
      clause.schedule.periodMax === undefined &&
      clause.schedule.periodUnit === undefined &&
      !clause.schedule.dayOfWeek &&
      !clause.schedule.when &&
      !clause.schedule.timeOfDay
    ) {
      delete clause.schedule;
    }
  }

  if (clause.dose) {
    if (!clause.dose.range && clause.dose.value === undefined && clause.dose.unit === undefined) {
      delete clause.dose;
    }
  }

  if (clause.route) {
    if (clause.route.code === undefined && clause.route.text === undefined) {
      delete clause.route;
    }
  }

  if (clause.site) {
    if (
      clause.site.text === undefined &&
      clause.site.coding === undefined &&
      clause.site.source === undefined
    ) {
      delete clause.site;
    }
  }

  if (clause.prn) {
    if (!clause.prn.reason?.text && !clause.prn.reason?.coding) {
      delete clause.prn.reason;
    }
    if (!clause.prn.enabled && !clause.prn.reason) {
      delete clause.prn;
    }
  }

  const existingInstructions = internal.additionalInstructions.length
    ? [...internal.additionalInstructions]
    : [];

  if (existingInstructions.length) {
    clause.additionalInstructions = [];
    for (const instruction of existingInstructions) {
      clause.additionalInstructions.push({
        text: instruction.text,
        coding: instruction.coding?.code
          ? {
            code: instruction.coding.code,
            display: instruction.coding.display,
            system: instruction.coding.system
          }
          : undefined,
        frames: instruction.frames?.length ? [...instruction.frames] : undefined
      });
    }
  } else {
    delete clause.additionalInstructions;
  }
}

/**
 * Locates the span of the detected site tokens within the caller's original
 * input so downstream consumers can highlight or replace the exact substring.
 */
function computeTokenRange(
  _input: string,
  tokens: Token[],
  indices: number[]
): TextRange | undefined {
  if (!indices.length) {
    return undefined;
  }
  let rangeStart: number | undefined;
  let rangeEnd: number | undefined;
  for (const tokenIndex of indices) {
    const token = tokens[tokenIndex];
    if (!token || token.sourceStart === undefined || token.sourceEnd === undefined) {
      continue;
    }
    if (rangeStart === undefined) {
      rangeStart = token.sourceStart;
      rangeEnd = token.sourceEnd;
      continue;
    }
    rangeStart = Math.min(rangeStart, token.sourceStart);
    rangeEnd = Math.max(rangeEnd ?? token.sourceEnd, token.sourceEnd);
  }
  if (rangeStart === undefined || rangeEnd === undefined) {
    return undefined;
  }
  return { start: rangeStart, end: rangeEnd };
}

export function findUnparsedTokenGroups(
  internal: ParserState
): Array<{ tokens: Token[]; range?: TextRange }> {
  const leftoverTokens = internal.tokens
    .filter((token) => !internal.consumed.has(token.index))
    .sort((a, b) => a.index - b.index);

  if (leftoverTokens.length === 0) {
    return [];
  }

  const groups: Array<{ tokens: Token[]; range?: TextRange }> = [];
  let currentGroup: Token[] = [];
  let previousIndex: number | undefined;

  const flush = () => {
    if (!currentGroup.length) {
      return;
    }
    const indices = currentGroup.map((token) => token.index);
    const range = computeTokenRange(internal.input, internal.tokens, indices);
    groups.push({ tokens: currentGroup, range });
    currentGroup = [];
    previousIndex = undefined;
  };

  for (const token of leftoverTokens) {
    if (previousIndex !== undefined && token.index !== previousIndex + 1) {
      flush();
    }
    currentGroup.push(token);
    previousIndex = token.index;
  }

  flush();

  return groups;
}
function isNumericToken(value: string): boolean {
  return /^[0-9]+(?:\.[0-9]+)?$/.test(value);
}

function isOrdinalToken(value: string): boolean {
  return /^[0-9]+(?:st|nd|rd|th)$/i.test(value);
}

function isNumericLexToken(token: Token | undefined): boolean {
  return token?.kind === LexKind.Number;
}

function isNumericRangeLexToken(token: Token | undefined): boolean {
  return token?.kind === LexKind.NumberRange;
}

function parseNumericRangeToken(token: Token | undefined): { low: number; high: number } | undefined {
  if (!token || token.kind !== LexKind.NumberRange) {
    return undefined;
  }
  if (!Number.isFinite(token.low) || !Number.isFinite(token.high)) {
    return undefined;
  }
  return { low: token.low!, high: token.high! };
}

function getPreviousActiveToken(
  tokens: Token[],
  index: number,
  consumed: Set<number>
): Token | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = tokens[cursor];
    if (!candidate || consumed.has(candidate.index)) {
      continue;
    }
    return candidate;
  }
  return undefined;
}

function getNextActiveToken(
  tokens: Token[],
  index: number,
  consumed: Set<number>
): Token | undefined {
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    const candidate = tokens[cursor];
    if (!candidate || consumed.has(candidate.index)) {
      continue;
    }
    return candidate;
  }
  return undefined;
}

function hasApplicationVerbBefore(
  tokens: Token[],
  index: number,
  consumed: Set<number>
): boolean {
  let inspected = 0;
  for (let cursor = index - 1; cursor >= 0 && inspected < 10; cursor -= 1) {
    const candidate = tokens[cursor];
    if (!candidate || consumed.has(candidate.index)) {
      continue;
    }
    const lower = normalizeTokenLower(candidate);
    if (hasTokenWordClass(candidate, TokenWordClass.ApplicationVerb)) {
      return true;
    }
    if (!SITE_FILLER_WORDS.has(lower) && !isSiteListConnectorWord(lower)) {
      inspected += 1;
    }
  }
  return false;
}

function hasExplicitSiteIntroduction(
  internal: ParserState,
  tokens: Token[],
  index: number,
  options?: ParseOptions
): boolean {
  if (hasApplicationVerbBefore(tokens, index, internal.consumed)) {
    return true;
  }
  let previous: Token | undefined;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = tokens[cursor];
    if (!candidate) {
      continue;
    }
    const lowerCandidate = normalizeTokenLower(candidate);
    if (/^[;:(),]+$/.test(lowerCandidate)) {
      continue;
    }
    previous = candidate;
    break;
  }
  if (!previous) {
    return false;
  }
  const lower = normalizeTokenLower(previous);
  return Boolean(
    internal.routeCode ||
    normalizeUnit(lower, options) ||
    isNumericToken(lower) ||
    DEFAULT_ROUTE_SYNONYMS[lower] ||
    TIMING_ABBREVIATIONS[lower] ||
    WORD_FREQUENCIES[lower]
  );
}

function isWorkflowInstructionContext(
  tokens: Token[],
  index: number,
  consumed: Set<number>
): boolean {
  let inspected = 0;
  for (let cursor = index - 1; cursor >= 0 && inspected < 4; cursor -= 1) {
    const candidate = tokens[cursor];
    if (!candidate || consumed.has(candidate.index)) {
      continue;
    }
    const lower = normalizeTokenLower(candidate);
    if (hasTokenWordClass(candidate, TokenWordClass.WorkflowInstruction)) {
      return true;
    }
    if (!SITE_FILLER_WORDS.has(lower) && !isSiteListConnectorWord(lower)) {
      inspected += 1;
    }
  }
  const previous = getPreviousActiveToken(tokens, index, consumed);
  if (previous) {
    const previousLower = normalizeTokenLower(previous);
    if (
      (previousLower === "after" || previousLower === "before" || previousLower === "during") &&
      (() => {
        const next = getNextActiveToken(tokens, index, consumed);
        return next ? hasTokenWordClass(next, TokenWordClass.WorkflowInstruction) : false;
      })()
    ) {
      return true;
    }
  }
  return false;
}

function isDurationPhraseNumber(
  tokens: Token[],
  index: number,
  consumed: Set<number>
): boolean {
  const token = tokens[index];
  if (!token || !isNumericToken(token.lower)) {
    return false;
  }
  const previous = getPreviousActiveToken(tokens, index, consumed);
  const next = getNextActiveToken(tokens, index, consumed);
  if (!previous || !next) {
    return false;
  }
  return normalizeTokenLower(previous) === "for" && DURATION_UNIT_WORDS.has(normalizeTokenLower(next));
}

function isLikelyMealAnchorUsage(
  tokens: Token[],
  index: number,
  consumed: Set<number>
): boolean {
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    const candidate = tokens[cursor];
    if (!candidate || consumed.has(candidate.index)) {
      continue;
    }
    const lower = normalizeTokenLower(candidate);
    if (SITE_FILLER_WORDS.has(lower) || isMealContextConnectorWord(lower) || lower === ",") {
      continue;
    }
    return Boolean(MEAL_KEYWORDS[lower]);
  }
  return false;
}

function buildSitePhraseServices(
  internal: ParserState,
  tokens: Token[],
  options?: ParseOptions
): SitePhraseServices {
  return {
    customSiteHints: internal.customSiteHints,
    siteConnectors: SITE_CONNECTORS,
    siteFillerWords: SITE_FILLER_WORDS,
    normalizeTokenLower,
    isBodySiteHint,
    hasExplicitSiteIntroduction: (startIndex: number) =>
      hasExplicitSiteIntroduction(internal, tokens, startIndex, options),
    isNumericToken,
    isOrdinalToken,
    mapFrequencyAdverb,
    mapIntervalUnit,
    normalizeUnit,
    hasRouteLikeWord: (value: string, parseOptions?: ParseOptions) =>
      Boolean(DEFAULT_ROUTE_SYNONYMS[value] || normalizeUnit(value, parseOptions)),
    hasFrequencyLikeWord: (value: string) =>
      FREQUENCY_SIMPLE_WORDS[value] !== undefined ||
      FREQUENCY_NUMBER_WORDS[value] !== undefined,
    getNextActiveToken: (index: number) => getNextActiveToken(tokens, index, internal.consumed),
    getPreviousActiveToken: (index: number) =>
      getPreviousActiveToken(tokens, index, internal.consumed),
    hasApplicationVerbBefore: (index: number) =>
      hasApplicationVerbBefore(tokens, index, internal.consumed)
  };
}

function applySitePhrase(
  internal: ParserState,
  tokens: Token[],
  indices: number[],
  options?: ParseOptions,
  routeDescriptorApplier?: (phrase: string | undefined) => boolean
): boolean {
  if (!indices.length) {
    return false;
  }

  const sortedIndices = Array.from(new Set(indices)).sort((a, b) => a - b);
  const displayWords: string[] = [];
  const displayTokenIndices: number[] = [];
  for (const index of sortedIndices) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    const lower = normalizeTokenLower(token);
    const trimmed = token.original.trim();
    const isBraceToken = trimmed.length > 0 && /^[{}]+$/.test(trimmed);
    if (
      !isBraceToken &&
      !SITE_CONNECTORS.has(lower) &&
      !SITE_FILLER_WORDS.has(lower) &&
      lower !== ","
    ) {
      displayWords.push(token.original);
      displayTokenIndices.push(token.index);
    }
    internal.siteTokenIndices.add(token.index);
    mark(internal.consumed, token);
  }

  if (options?.siteCodeMap && sortedIndices.length > 0) {
    const lastIndex = sortedIndices[sortedIndices.length - 1];
    const commaToken = tokens[lastIndex + 1];
    const trailingModifier = tokens[lastIndex + 2];
    const trailingLower = trailingModifier ? normalizeTokenLower(trailingModifier) : undefined;
    if (
      commaToken?.original === "," &&
      trailingModifier &&
      !internal.consumed.has(trailingModifier.index) &&
      (trailingLower === "left" || trailingLower === "right" || trailingLower === "bilateral")
    ) {
      displayWords.push(trailingModifier.original);
      displayTokenIndices.push(trailingModifier.index);
      internal.siteTokenIndices.add(trailingModifier.index);
      mark(internal.consumed, trailingModifier);
    }
  }
  const resolvedSiteText = displayWords.join(" ").replace(/\s+/g, " ").trim();
  if (!resolvedSiteText) {
    return false;
  }

  const tokenRange = computeTokenRange(
    internal.input,
    tokens,
    displayTokenIndices.length > 0 ? displayTokenIndices : sortedIndices
  );
  let sanitized = resolvedSiteText;
  let isProbe = false;
  const probeMatch = sanitized.match(/^\{(.+)}$/);
  if (probeMatch) {
    isProbe = true;
    sanitized = probeMatch[1];
  }
  sanitized = sanitized.replace(/[{}]/g, " ").replace(/\s+/g, " ").trim();
  const displayText = normalizeSiteDisplayText(sanitized, options?.siteCodeMap);
  if (!displayText) {
    return false;
  }

  const displayLower = displayText.toLowerCase();
  const normalizedLower = sanitized.toLowerCase();
  const strippedDescriptor = normalizeRouteDescriptorPhrase(normalizedLower);
  let hasNonSiteWords = false;
  for (const word of displayLower.split(/\s+/)) {
    if (!word) {
      continue;
    }
    if (!isBodySiteHint(word, internal.customSiteHints)) {
      hasNonSiteWords = true;
      break;
    }
  }
  const shouldAttemptRouteDescriptor =
    strippedDescriptor !== normalizedLower || hasNonSiteWords || strippedDescriptor === "mouth";
  const appliedRouteDescriptor =
    shouldAttemptRouteDescriptor && Boolean(routeDescriptorApplier?.(sanitized));
  if (appliedRouteDescriptor) {
    return true;
  }

  let range = tokenRange;
  let sourceText = range ? internal.input.slice(range.start, range.end) : undefined;
  if (isProbe && range && sourceText) {
    const openBrace = sourceText.indexOf("{");
    const closeBrace = sourceText.lastIndexOf("}");
    if (openBrace !== -1 && closeBrace > openBrace) {
      range = {
        start: range.start + openBrace + 1,
        end: range.start + closeBrace
      };
      sourceText = internal.input.slice(range.start, range.end);
    } else {
      sourceText = sanitized;
    }
  }
  const canonical = normalizeBodySiteKey(displayText);
  internal.siteLookupRequest = {
    originalText: resolvedSiteText,
    text: displayText,
    normalized: displayLower,
    canonical,
    isProbe,
    inputText: internal.input,
    sourceText,
    range
  };
  if (normalizedLower) {
    internal.siteText = displayText;
    if (!internal.siteSource) {
      internal.siteSource = "text";
    }
  }
  return true;
}

function applySitePhraseCandidate(
  internal: ParserState,
  tokens: Token[],
  candidate: SitePhraseCandidate,
  options?: ParseOptions,
  routeDescriptorApplier?: (phrase: string | undefined) => boolean
): boolean {
  return applySitePhrase(
    internal,
    tokens,
    candidate.tokenIndices,
    options,
    routeDescriptorApplier
  );
}

function seedSiteFromRoute(
  internal: ParserState,
  options?: ParseOptions
): void {
  if (internal.siteText || !internal.routeCode) {
    return;
  }
  const impliedText = ROUTE_IMPLIED_SITE_TEXT[internal.routeCode];
  if (!impliedText) {
    return;
  }
  const normalizedText = normalizeSiteDisplayText(impliedText, options?.siteCodeMap);
  const canonical = normalizeBodySiteKey(normalizedText);
  internal.siteText = normalizedText;
  internal.siteSource = "text";
  internal.siteLookupRequest = {
    originalText: impliedText,
    text: normalizedText,
    normalized: normalizedText.toLowerCase(),
    canonical,
    isProbe: false,
    inputText: internal.input,
    sourceText: impliedText,
    range: undefined
  };
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

const DEFAULT_EVENT_TIMING_WEIGHTS: Record<EventTiming, number> = {
  [EventTiming.Immediate]: 0,
  [EventTiming.Wake]: 6 * 3600,
  [EventTiming["After Sleep"]]: 6 * 3600 + 15 * 60,
  [EventTiming["Early Morning"]]: 7 * 3600,
  [EventTiming["Before Meal"]]: 7 * 3600 + 30 * 60,
  [EventTiming["Before Breakfast"]]: 7 * 3600 + 45 * 60,
  [EventTiming.Morning]: 8 * 3600,
  [EventTiming.Breakfast]: 8 * 3600 + 15 * 60,
  [EventTiming.Meal]: 8 * 3600 + 30 * 60,
  [EventTiming["After Breakfast"]]: 9 * 3600,
  [EventTiming["After Meal"]]: 9 * 3600 + 15 * 60,
  [EventTiming["Late Morning"]]: 10 * 3600 + 30 * 60,
  [EventTiming["Before Lunch"]]: 11 * 3600 + 45 * 60,
  [EventTiming.Noon]: 12 * 3600,
  [EventTiming.Lunch]: 12 * 3600 + 15 * 60,
  [EventTiming["After Lunch"]]: 12 * 3600 + 45 * 60,
  [EventTiming["Early Afternoon"]]: 13 * 3600 + 30 * 60,
  [EventTiming.Afternoon]: 15 * 3600,
  [EventTiming["Late Afternoon"]]: 16 * 3600 + 30 * 60,
  [EventTiming["Before Dinner"]]: 17 * 3600 + 30 * 60,
  [EventTiming.Dinner]: 18 * 3600,
  [EventTiming["After Dinner"]]: 19 * 3600,
  [EventTiming["Early Evening"]]: 19 * 3600 + 30 * 60,
  [EventTiming.Evening]: 20 * 3600,
  [EventTiming["Late Evening"]]: 21 * 3600,
  [EventTiming.Night]: 22 * 3600,
  [EventTiming["Before Sleep"]]: 22 * 3600 + 30 * 60,
};

function parseClockToSeconds(clock: string): number | undefined {
  const match = clock.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    return undefined;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] ? Number(match[3]) : 0;
  if (
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return undefined;
  }
  return hour * 3600 + minute * 60 + second;
}

function computeWhenWeight(code: EventTiming, options?: ParseOptions): number {
  const clock = options?.eventClock?.[code];
  if (clock) {
    const seconds = parseClockToSeconds(clock);
    if (seconds !== undefined) {
      return seconds;
    }
  }
  return DEFAULT_EVENT_TIMING_WEIGHTS[code] ?? 10000;
}

function sortWhenValues(internal: ParserState, options?: ParseOptions) {
  if (internal.when.length < 2) {
    return;
  }
  const weighted = internal.when.map((code, index) => ({
    code,
    weight: computeWhenWeight(code, options),
    index,
  }));
  weighted.sort((a, b) => {
    if (a.weight !== b.weight) {
      return a.weight - b.weight;
    }
    return a.index - b.index;
  });
  internal.when.splice(
    0,
    internal.when.length,
    ...weighted.map((entry) => entry.code),
  );
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

function reconcileMealTimingSpecificity(internal: ParserState) {
  if (!internal.when.length) {
    return;
  }

  const convertSpecifics = (
    base: EventTiming,
    mappings: readonly [EventTiming, EventTiming][]
  ) => {
    if (!arrayIncludes(internal.when, base)) {
      return;
    }
    let replaced = false;
    for (const [general, specific] of mappings) {
      if (arrayIncludes(internal.when, general)) {
        removeWhen(internal.when, general);
        addWhen(internal.when, specific);
        replaced = true;
      }
    }
    if (replaced) {
      removeWhen(internal.when, base);
    }
  };

  convertSpecifics(EventTiming["Before Meal"], [
    [EventTiming.Breakfast, EventTiming["Before Breakfast"]],
    [EventTiming.Lunch, EventTiming["Before Lunch"]],
    [EventTiming.Dinner, EventTiming["Before Dinner"]],
  ]);

  convertSpecifics(EventTiming["After Meal"], [
    [EventTiming.Breakfast, EventTiming["After Breakfast"]],
    [EventTiming.Lunch, EventTiming["After Lunch"]],
    [EventTiming.Dinner, EventTiming["After Dinner"]],
  ]);
}

const MEAL_COMPATIBLE_ROUTE_CODES = new Set<RouteCode>([
  RouteCode["Oral route"],
  RouteCode["Gastrostomy route"],
  RouteCode["Jejunostomy route"],
  RouteCode["Nasogastric route"],
  RouteCode["Gastroenteral use"],
  RouteCode["Enteral route (qualifier value)"],
  RouteCode["Gastro-intestinal stoma route (qualifier value)"],
  RouteCode["Orogastric route (qualifier value)"],
  RouteCode["Nasojejunal route (qualifier value)"],
  RouteCode["Nasoduodenal route (qualifier value)"],
  RouteCode["Digestive tract route (qualifier value)"],
  RouteCode["Intraesophageal route (qualifier value)"],
  RouteCode["Intragastric route (qualifier value)"],
  RouteCode["Intraduodenal route (qualifier value)"],
  RouteCode["Intrajejunal route (qualifier value)"],
  RouteCode["Intestinal route (qualifier value)"],
  RouteCode["Intraileal route (qualifier value)"],
  RouteCode["Intracolonic route (qualifier value)"],
  RouteCode["Esophagostomy route"],
  RouteCode["Colostomy route (qualifier value)"],
  RouteCode["Ileostomy route (qualifier value)"]
]);

function resolveMealExpansionRoute(
  internal: ParserState,
  options?: ParseOptions
): RouteCode | undefined {
  if (internal.routeCode) {
    return internal.routeCode;
  }

  const routeText = internal.routeText?.trim().toLowerCase();
  if (routeText) {
    const synonym = DEFAULT_ROUTE_SYNONYMS[routeText];
    if (synonym?.code) {
      return synonym.code;
    }
  }

  return inferRouteFromContext(options?.context ?? undefined);
}

function hasPendingSiteCue(internal: ParserState): boolean {
  for (const token of internal.tokens) {
    if (internal.consumed.has(token.index)) {
      continue;
    }

    const lower = normalizeTokenLower(token);
    if (isBodySiteHint(lower, internal.customSiteHints)) {
      return true;
    }

    if (!SITE_CONNECTORS.has(lower)) {
      continue;
    }

    const next = internal.tokens[token.index + 1];
    if (next && !internal.consumed.has(next.index)) {
      return true;
    }
  }

  return false;
}

function normalizeSmartMealExpansionForm(form: string | undefined): string | undefined {
  if (!form) {
    return undefined;
  }
  return normalizeDosageForm(form) ?? form.trim().toLowerCase();
}

function matchesSmartMealExpansionForm(
  dosageForm: string | undefined,
  candidates: string[] | undefined
): boolean {
  if (!dosageForm || !candidates?.length) {
    return false;
  }

  return candidates.some(
    (candidate) => normalizeSmartMealExpansionForm(candidate) === dosageForm
  );
}

function resolveSmartMealExpansionScopeDecision(
  internal: ParserState,
  options?: ParseOptions
): boolean | undefined {
  const scope: SmartMealExpansionScope | undefined = options?.smartMealExpansionScope;
  if (!scope) {
    return undefined;
  }

  const route = resolveMealExpansionRoute(internal, options);
  const dosageForm = normalizeSmartMealExpansionForm(options?.context?.dosageForm ?? undefined);

  const routeExcluded = Boolean(
    route && scope.excludeRoutes && arrayIncludes(scope.excludeRoutes, route)
  );
  const formExcluded = matchesSmartMealExpansionForm(dosageForm, scope.excludeDosageForms);
  if (routeExcluded || formExcluded) {
    return false;
  }

  const hasIncludes = Boolean(
    (scope.includeRoutes && scope.includeRoutes.length > 0) ||
    (scope.includeDosageForms && scope.includeDosageForms.length > 0)
  );
  if (!hasIncludes) {
    return undefined;
  }

  const routeIncluded = Boolean(
    route && scope.includeRoutes && arrayIncludes(scope.includeRoutes, route)
  );
  const formIncluded = matchesSmartMealExpansionForm(dosageForm, scope.includeDosageForms);
  return routeIncluded || formIncluded;
}

function shouldExpandMealTimings(
  internal: ParserState,
  options?: ParseOptions
): boolean {
  const scopeDecision = resolveSmartMealExpansionScopeDecision(internal, options);
  if (scopeDecision !== undefined) {
    return scopeDecision;
  }

  const route = resolveMealExpansionRoute(internal, options);
  if (route) {
    return MEAL_COMPATIBLE_ROUTE_CODES.has(route);
  }

  // Site-specific instructions are more often topical/ocular/otic/injectable
  // than enteral, so skip cadence-only meal expansion when a site is present.
  if (internal.siteText?.trim() || hasPendingSiteCue(internal)) {
    return false;
  }

  return true;
}

// Optionally replace generic meal tokens with concrete breakfast/lunch/dinner
// EventTiming codes when the cadence or explicit meal abbreviations make the
// intent obvious.
function expandMealTimings(
  internal: ParserState,
  options?: ParseOptions
) {
  const allowSmartExpansion = options?.smartMealExpansion === true;
  if (!allowSmartExpansion) {
    return;
  }

  if (internal.when.some((code) => SPECIFIC_MEAL_TIMINGS.has(code))) {
    return;
  }

  const frequency = internal.frequency;
  if (!frequency || frequency < 1 || frequency > 4) {
    return;
  }

  const needsDefaultExpansion =
    internal.when.length === 0 && frequency >= 2;

  const hasBeforeMeal = arrayIncludes(internal.when, EventTiming["Before Meal"]);
  const hasAfterMeal = arrayIncludes(internal.when, EventTiming["After Meal"]);
  const hasWithMeal = arrayIncludes(internal.when, EventTiming.Meal);
  const hasGeneralMealToken = hasBeforeMeal || hasAfterMeal || hasWithMeal;

  if (!hasGeneralMealToken && !needsDefaultExpansion) {
    return;
  }

  if (!shouldExpandMealTimings(internal, options)) {
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

  const pairPreference = options?.twoPerDayPair ?? "breakfast+dinner";

  const replacements: Array<{
    general: EventTiming;
    specifics: EventTiming[];
    removeGeneral: boolean;
  }> = [];

  const addReplacement = (
    general: EventTiming,
    base: "before" | "after" | "with",
    removeGeneral: boolean
  ) => {
    const specifics = computeMealExpansions(base, frequency, pairPreference);
    if (specifics) {
      replacements.push({ general, specifics, removeGeneral });
    }
  };

  if (hasBeforeMeal) {
    addReplacement(EventTiming["Before Meal"], "before", true);
  }
  if (hasAfterMeal) {
    addReplacement(EventTiming["After Meal"], "after", true);
  }
  if (hasWithMeal) {
    addReplacement(EventTiming.Meal, "with", true);
  }

  if (needsDefaultExpansion) {
    const relation = options?.context?.mealRelation ?? EventTiming.Meal;
    const base =
      relation === EventTiming["Before Meal"]
        ? "before"
        : relation === EventTiming["After Meal"]
          ? "after"
          : "with";
    addReplacement(relation, base, false);
  }

  for (const { general, specifics, removeGeneral } of replacements) {
    if (removeGeneral) {
      removeWhen(internal.when, general);
    }
    for (const specific of specifics) {
      addWhen(internal.when, specific);
    }
  }
}

function setRoute(
  internal: ParserState,
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
  internal: ParserState,
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
  internal: ParserState,
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
  internal: ParserState,
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
  internal: ParserState,
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
  internal: ParserState,
  token: Token,
  code: EventTiming
) {
  addWhen(internal.when, code);
  mark(internal.consumed, token);
}

function isTimingAnchorOrPrefix(
  tokens: Token[],
  index: number,
  prnReasonStart?: number
): boolean {
  const token = tokens[index];
  if (!token) return false;

  // Cautious handling of "sleep" in PRN zone
  if (prnReasonStart !== undefined && index >= prnReasonStart && token.lower === "sleep") {
    return false;
  }

  const lower = token.lower;
  const nextToken = tokens[index + 1];
  const comboKey = nextToken ? `${lower} ${nextToken.lower}` : undefined;

  return Boolean(
    getEventTimingMeaning(token) ||
    getTimingAbbreviationMeaning(token) ||
    (comboKey && COMBO_EVENT_TIMINGS[comboKey]) ||
    (lower === "pc" || lower === "ac" || lower === "after" || lower === "before") ||
    (isAtPrefixToken(lower) || lower === "on" || lower === "with") ||
    /^\d/.test(lower)
  );
}

function addDayOfWeek(internal: ParserState, day: FhirDayOfWeek) {
  if (!arrayIncludes(internal.dayOfWeek, day)) {
    internal.dayOfWeek.push(day);
  }
}

function addDayOfWeekList(internal: ParserState, days: FhirDayOfWeek[]) {
  for (const day of days) {
    addDayOfWeek(internal, day);
  }
}

function tryConsumeDayRangeTokens(
  internal: ParserState,
  tokens: Token[],
  index: number
): number {
  const startToken = tokens[index];
  if (!startToken || internal.consumed.has(startToken.index)) {
    return 0;
  }
  const startDays = getDayOfWeekMeaning(startToken);
  if (!startDays || startDays.length !== 1) {
    return 0;
  }
  const connectorToken = tokens[index + 1];
  const endToken = tokens[index + 2];
  if (
    !connectorToken ||
    !endToken ||
    internal.consumed.has(connectorToken.index) ||
    internal.consumed.has(endToken.index)
  ) {
    return 0;
  }
  const connector = normalizeTokenLower(connectorToken);
  if (!isDayRangeConnectorWord(connector)) {
    return 0;
  }
  const endDays = getDayOfWeekMeaning(endToken);
  if (!endDays || endDays.length !== 1) {
    return 0;
  }
  const days = expandDayMeaningRange(startDays[0], endDays[0]);
  addDayOfWeekList(internal, days);
  mark(internal.consumed, startToken);
  mark(internal.consumed, connectorToken);
  mark(internal.consumed, endToken);
  return 3;
}

function parseAnchorSequence(
  internal: ParserState,
  tokens: Token[],
  index: number,
  prefixCode?: EventTiming
) {
  const token = tokens[index];
  let converted = 0;
  for (let lookahead = index + 1; lookahead < tokens.length; lookahead++) {
    const nextToken = tokens[lookahead];
    if (internal.consumed.has(nextToken.index)) {
      continue;
    }

    const lower = normalizeTokenLower(nextToken);
    if (isMealContextConnectorWord(lower) || lower === ",") {
      mark(internal.consumed, nextToken);
      continue;
    }

    const rangeConsumed = tryConsumeDayRangeTokens(internal, tokens, lookahead);
    if (rangeConsumed > 0) {
      converted++;
      lookahead += rangeConsumed - 1;
      continue;
    }

    const days = getDayOfWeekMeaning(nextToken);
    if (days) {
      addDayOfWeekList(internal, days);
      mark(internal.consumed, nextToken);
      converted++;
      continue;
    }

    const meal = MEAL_KEYWORDS[lower];
    if (meal) {
      const whenCode =
        prefixCode === EventTiming["After Meal"]
          ? meal.pc
          : prefixCode === EventTiming["Before Meal"]
            ? meal.ac
            : (EVENT_TIMING_TOKENS[lower] ?? meal.pc); // fallback to general or conservative default
      addWhen(internal.when, whenCode);
      mark(internal.consumed, nextToken);
      converted++;
      continue;
    }

    const whenCode = EVENT_TIMING_TOKENS[lower];
    if (whenCode) {
      if (prefixCode && !meal) {
        // if we have pc/ac, we only want to follow it with explicit meals
        // to avoid over-consuming anchors that should be separate (like 'pc hs')
        break;
      }
      addWhen(internal.when, whenCode);
      mark(internal.consumed, nextToken);
      converted++;
      continue;
    }

    break;
  }

  if (converted > 0) {
    mark(internal.consumed, token);
    return true;
  }
  if (prefixCode) {
    applyWhenToken(internal, token, prefixCode);
    return true;
  }
  return false;
}

function parseSeparatedInterval(
  internal: ParserState,
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

function mapFrequencyAdverb(token: string): FhirPeriodUnit | undefined {
  return FREQUENCY_ADVERB_UNITS[token];
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

function applyCountLimit(internal: ParserState, value: number | undefined): boolean {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return false;
  }
  if (internal.count !== undefined) {
    return false;
  }
  const rounded = Math.round(value);
  if (rounded <= 0) {
    return false;
  }
  internal.count = rounded;
  return true;
}

const DOSE_SCALE_MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  thousand: 1_000,
  m: 1_000_000,
  mn: 1_000_000,
  mio: 1_000_000,
  million: 1_000_000,
  b: 1_000_000_000,
  bn: 1_000_000_000,
  billion: 1_000_000_000
};

function resolveUnitTokenAt(
  tokens: Token[],
  index: number,
  consumed: Set<number>,
  options?: ParseOptions
): { unit: string; consumedIndices: number[] } | undefined {
  const token = tokens[index];
  if (!token || consumed.has(token.index)) {
    return undefined;
  }
  const normalized = normalizeTokenLower(token);
  const direct = normalizeUnit(normalized, options);
  if (direct) {
    return { unit: direct, consumedIndices: [index] };
  }
  if (normalized === "international") {
    const nextToken = tokens[index + 1];
    if (!nextToken || consumed.has(nextToken.index)) {
      return undefined;
    }
    const nextNormalized = normalizeTokenLower(nextToken);
    if (
      nextNormalized === "unit" ||
      nextNormalized === "units" ||
      nextNormalized === "u" ||
      nextNormalized === "iu" ||
      nextNormalized === "ius"
    ) {
      return { unit: "IU", consumedIndices: [index, index + 1] };
    }
  }
  return undefined;
}

function resolveNumericDoseUnit(
  tokens: Token[],
  numberIndex: number,
  value: number,
  consumed: Set<number>,
  options?: ParseOptions
): { doseValue: number; unit?: string; consumedIndices: number[] } {
  const directUnit = resolveUnitTokenAt(tokens, numberIndex + 1, consumed, options);
  if (directUnit) {
    return {
      doseValue: value,
      unit: directUnit.unit,
      consumedIndices: directUnit.consumedIndices
    };
  }

  const scaleToken = tokens[numberIndex + 1];
  if (!scaleToken || consumed.has(scaleToken.index)) {
    return { doseValue: value, consumedIndices: [] };
  }
  const multiplier = DOSE_SCALE_MULTIPLIERS[normalizeTokenLower(scaleToken)];
  if (!multiplier) {
    return { doseValue: value, consumedIndices: [] };
  }

  const scaledUnit = resolveUnitTokenAt(tokens, numberIndex + 2, consumed, options);
  if (!scaledUnit) {
    return { doseValue: value, consumedIndices: [] };
  }

  return {
    doseValue: value * multiplier,
    unit: scaledUnit.unit,
    consumedIndices: [numberIndex + 1, ...scaledUnit.consumedIndices]
  };
}

export function parseClauseState(
  input: string,
  options?: ParseOptions
): ParserState {
  const tokens = tokenize(input);
  const internal = createClauseBackedInternal(
    input,
    tokens,
    buildCustomSiteHints(options?.siteCodeMap)
  );

  const context = options?.context ?? undefined;
  const customRouteMap = options?.routeMap
    ? new Map(
      objectEntries(options.routeMap).map(([key, value]) => [
        key.toLowerCase(),
        value
      ])
    )
    : undefined;

  const customRouteDescriptorMap = customRouteMap
    ? new Map(
      Array.from(customRouteMap.entries())
        .map(([key, value]) => [normalizeRouteDescriptorPhrase(key), value] as const)
        .filter(([normalized]) => normalized.length > 0)
    )
    : undefined;

  if (tokens.length === 0) {
    finalizeCanonicalClause(internal);
    return internal;
  }

  const prnSiteSuffixIndices = new Set<number>();
  const prnReasonStart = detectPrnPrelude(internal, tokens);
  collectMultiplicativeCadence(internal, tokens, options);

  const applyRouteDescriptor = (code: RouteCode, text?: string): boolean => {
    if (internal.routeCode && internal.routeCode !== code) {
      return false;
    }
    setRoute(internal, code, text);
    return true;
  };

  const maybeApplyRouteDescriptor = (phrase: string | undefined): boolean => {
    if (!phrase) {
      return false;
    }
    const normalized = phrase.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    const customCode = customRouteMap?.get(normalized);
    if (customCode) {
      if (applyRouteDescriptor(customCode as RouteCode)) {
        return true;
      }
    }
    const synonym = DEFAULT_ROUTE_SYNONYMS[normalized];
    if (synonym) {
      if (applyRouteDescriptor(synonym.code, synonym.text)) {
        return true;
      }
    }
    const normalizedDescriptor = normalizeRouteDescriptorPhrase(normalized);
    if (normalizedDescriptor) {
      const customDescriptorCode = customRouteDescriptorMap?.get(normalizedDescriptor);
      if (customDescriptorCode) {
        if (applyRouteDescriptor(customDescriptorCode as RouteCode)) {
          return true;
        }
      }
      const fallbackSynonym = DEFAULT_ROUTE_DESCRIPTOR_SYNONYMS.get(normalizedDescriptor);
      if (fallbackSynonym) {
        if (applyRouteDescriptor(fallbackSynonym.code, fallbackSynonym.text)) {
          return true;
        }
      }
    }
    return false;
  };

  // Process tokens sequentially
  const tryRouteSynonym = (startIndex: number): boolean => {
    if (prnReasonStart !== undefined && startIndex >= prnReasonStart) {
      return false;
    }
    const maxSpan = Math.min(24, tokens.length - startIndex);
    for (let span = maxSpan; span >= 1; span--) {
      const slice = tokens.slice(startIndex, startIndex + span);
      if (slice.some((part) => internal.consumed.has(part.index))) {
        continue;
      }
      const normalizedParts = slice.filter((part) => !/^[;:(),]+$/.test(part.lower));
      const phrase = normalizedParts.map((part) => part.lower).join(" ");
      const customCode = customRouteMap?.get(phrase);
      const annotatedRoute = span === 1 ? getRouteMeaning(slice[0]) : undefined;
      const synonym = customCode
        ? { code: customCode, text: ROUTE_TEXT[customCode] }
        : annotatedRoute ?? DEFAULT_ROUTE_SYNONYMS[phrase];
      if (synonym) {
        if (phrase === "top" && slice.length === 1) {
          const nextToken = tokens[startIndex + 1];
          if (nextToken && normalizeTokenLower(nextToken) === "of") {
            continue;
          }
        }
        if (phrase === "in" && slice.length === 1) {
          if (internal.routeCode) {
            continue;
          }
          const prevToken = tokens[startIndex - 1];
          if (prevToken && !internal.consumed.has(prevToken.index)) {
            continue;
          }
        }
        setRoute(internal, synonym.code, synonym.text);
        for (const part of slice) {
          mark(internal.consumed, part);
          if (isBodySiteHint(part.lower, internal.customSiteHints)) {
            internal.siteTokenIndices.add(part.index);
          }
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
    const normalizedLower = normalizeTokenLower(token);

    if (token.lower === "bld" || token.lower === "b-l-d") {
      const check = checkDiscouraged(token.original, options);
      if (check.warning) {
        internal.warnings.push(check.warning);
      }
      applyWhenToken(internal, token, EventTiming.Meal);
      continue;
    }

    if (token.lower === "q" || token.lower === "every" || token.lower === "each") {
      if (parseSeparatedInterval(internal, tokens, i, options)) {
        continue;
      }
    }

    if (tryParseTimeBasedSchedule(internal, tokens, i)) {
      continue;
    }

    if (tryParseNumericCadence(internal, tokens, i)) {
      continue;
    }

    const siteCandidate = getPrimarySiteMeaningCandidate(token);
    const treatSiteCandidateAsSite = siteCandidate
      ? shouldTreatAbbreviatedSiteCandidateAsSite(internal, tokens, i, context)
      : false;

    const timingAbbreviation = getTimingAbbreviationMeaning(token);

    if (normalizedLower === "od") {
      if (
        timingAbbreviation &&
        shouldInterpretOdAsOnceDaily(internal, tokens, i, treatSiteCandidateAsSite)
      ) {
        applyFrequencyDescriptor(internal, token, timingAbbreviation, options);
        continue;
      }
    }

    // Frequency abbreviation map
    const freqDescriptor =
      normalizedLower === "od" || !timingAbbreviation
        ? undefined
        : timingAbbreviation;
    if (freqDescriptor) {
      applyFrequencyDescriptor(internal, token, freqDescriptor, options);
      continue;
    }

    if (tryParseCompactQ(internal, tokens, i)) {
      continue;
    }

    // Skip connectors if they are followed by recognized timing tokens or prefixes
    if (isMealContextConnectorWord(token.lower) || token.lower === ",") {
      if (isTimingAnchorOrPrefix(tokens, i + 1, prnReasonStart)) {
        mark(internal.consumed, token);
        continue;
      }
    }

    // Event timing tokens
    const nextToken = tokens[i + 1];
    if (nextToken && !internal.consumed.has(nextToken.index)) {
      const lowerNext = nextToken.lower;
      const combo = `${token.lower} ${lowerNext}`;
      const comboWhen = COMBO_EVENT_TIMINGS[combo] ?? EVENT_TIMING_TOKENS[combo];
      if (comboWhen) {
        applyWhenToken(internal, token, comboWhen);
        mark(internal.consumed, nextToken);
        continue;
      }
    }

    if (token.lower === "pc" || token.lower === "ac") {
      parseAnchorSequence(
        internal,
        tokens,
        i,
        token.lower === "pc"
          ? EventTiming["After Meal"]
          : EventTiming["Before Meal"]
      );
      continue;
    }
    if (token.lower === "after" || token.lower === "before") {
      if (isLikelyMealAnchorUsage(tokens, i, internal.consumed)) {
        parseAnchorSequence(
          internal,
          tokens,
          i,
          token.lower === "after"
            ? EventTiming["After Meal"]
            : EventTiming["Before Meal"]
        );
        continue;
      }
    }
    if (isAtPrefixToken(token.lower) || token.lower === "on" || token.lower === "with") {
      if (tryParseTimeBasedSchedule(internal, tokens, i)) {
        continue;
      }
      if (parseAnchorSequence(internal, tokens, i)) {
        continue;
      }
      if (token.lower === "on") {
        const previous = getPreviousActiveToken(tokens, i, internal.consumed);
        if (previous && hasTokenWordClass(previous, TokenWordClass.WorkflowInstruction)) {
          continue;
        }
      }
      // If none of the above consume it, and it's a known anchor prefix, mark it
      // but only if it's not "with" which might be part of other phrases later.
      if (token.lower !== "with") {
        mark(internal.consumed, token);
        continue;
      }
    }
    const customWhen = options?.whenMap?.[token.lower];
    if (customWhen) {
      applyWhenToken(internal, token, customWhen);
      continue;
    }
    const whenCode = getEventTimingMeaning(token);
    if (whenCode) {
      // If we are in the PRN zone, be cautious about common reason words like "sleep"
      // unless they were already handled by combo/anchor logic (which happens above).
      if (prnReasonStart !== undefined && i >= prnReasonStart && token.lower === "sleep") {
        // Leave for PRN reason
      } else if (isWorkflowInstructionContext(tokens, i, internal.consumed)) {
        // Keep topical workflow phrases like "rinse in the morning" intact instead
        // of converting their time reference into the medication schedule.
      } else {
        applyWhenToken(internal, token, whenCode);
        continue;
      }
    }

    // Day of week
    const rangeConsumed = tryConsumeDayRangeTokens(internal, tokens, i);
    if (rangeConsumed > 0) {
      continue;
    }
    const days = getDayOfWeekMeaning(token);
    if (days) {
      addDayOfWeekList(internal, days);
      mark(internal.consumed, token);
      continue;
    }

    // Units following numbers handled later

    if (tryRouteSynonym(i)) {
      continue;
    }

    if (siteCandidate && treatSiteCandidateAsSite) {
      internal.siteText = siteCandidate.text;
      internal.siteSource = "abbreviation";
      if (siteCandidate.route && !internal.routeCode) {
        setRoute(internal, siteCandidate.route);
      }
      mark(internal.consumed, token);
      continue;
    }

    if (internal.count === undefined) {
      const countMatch = token.lower.match(/^[x*]([0-9]+(?:\.[0-9]+)?)$/);
      if (countMatch) {
        if (applyCountLimit(internal, parseFloat(countMatch[1]))) {
          mark(internal.consumed, token);
          const nextToken = tokens[i + 1];
          if (nextToken && isCountKeywordWord(nextToken.lower)) {
            mark(internal.consumed, nextToken);
          }
          continue;
        }
      }
      if (token.lower === "x" || token.lower === "*") {
        const numericToken = tokens[i + 1];
        if (
          numericToken &&
          !internal.consumed.has(numericToken.index) &&
          /^[0-9]+(?:\.[0-9]+)?$/.test(numericToken.lower) &&
          applyCountLimit(internal, parseFloat(numericToken.original))
        ) {
          mark(internal.consumed, token);
          mark(internal.consumed, numericToken);
          const afterToken = tokens[i + 2];
          if (afterToken && isCountKeywordWord(afterToken.lower)) {
            mark(internal.consumed, afterToken);
          }
          continue;
        }
      }
      if (token.lower === "for") {
        const skipConnectors = (
          startIndex: number,
          bucket: Token[],
        ): number => {
          let cursor = startIndex;
          while (cursor < tokens.length) {
            const candidate = tokens[cursor];
            if (!candidate) {
              break;
            }
            if (internal.consumed.has(candidate.index)) {
              cursor += 1;
              continue;
            }
            if (!COUNT_CONNECTOR_WORDS.has(candidate.lower)) {
              break;
            }
            bucket.push(candidate);
            cursor += 1;
          }
          return cursor;
        };

        const preConnectors: Token[] = [];
        let lookaheadIndex = skipConnectors(i + 1, preConnectors);
        const numericToken = tokens[lookaheadIndex];
        if (
          numericToken &&
          !internal.consumed.has(numericToken.index) &&
          /^[0-9]+(?:\.[0-9]+)?$/.test(numericToken.lower)
        ) {
          const postConnectors: Token[] = [];
          lookaheadIndex = skipConnectors(lookaheadIndex + 1, postConnectors);
          const keywordToken = tokens[lookaheadIndex];
          if (
            keywordToken &&
            !internal.consumed.has(keywordToken.index) &&
            isCountKeywordWord(keywordToken.lower) &&
            applyCountLimit(internal, parseFloat(numericToken.original))
          ) {
            mark(internal.consumed, token);
            for (const connector of preConnectors) {
              mark(internal.consumed, connector);
            }
            mark(internal.consumed, numericToken);
            for (const connector of postConnectors) {
              mark(internal.consumed, connector);
            }
            mark(internal.consumed, keywordToken);
            continue;
          }
        }
      }
      if (isCountKeywordWord(token.lower)) {
        const partsToMark: Token[] = [token];
        let value: number | undefined;
        const prevToken = tokens[i - 1];
        if (prevToken && !internal.consumed.has(prevToken.index)) {
          const prevLower = prevToken.lower;
          const suffixMatch = prevLower.match(/^([0-9]+(?:\.[0-9]+)?)[x*]$/);
          const prefixMatch = prevLower.match(/^[x*]([0-9]+(?:\.[0-9]+)?)$/);
          if (suffixMatch) {
            value = parseFloat(suffixMatch[1]);
            partsToMark.push(prevToken);
          } else if (prefixMatch) {
            value = parseFloat(prefixMatch[1]);
            partsToMark.push(prevToken);
          } else if (/^[0-9]+(?:\.[0-9]+)?$/.test(prevLower)) {
            const maybeX = tokens[i - 2];
            if (
              maybeX &&
              !internal.consumed.has(maybeX.index) &&
              (maybeX.lower === "x" || maybeX.lower === "*")
            ) {
              value = parseFloat(prevToken.original);
              partsToMark.push(maybeX, prevToken);
            }
          }
        }
        if (value === undefined) {
          const nextToken = tokens[i + 1];
          if (
            nextToken &&
            !internal.consumed.has(nextToken.index) &&
            /^[0-9]+(?:\.[0-9]+)?$/.test(nextToken.lower)
          ) {
            value = parseFloat(nextToken.original);
            partsToMark.push(nextToken);
          }
        }
        if (applyCountLimit(internal, value)) {
          for (const part of partsToMark) {
            mark(internal.consumed, part);
          }
          continue;
        }
      }
    }

    // Numeric dose
    if (tryParseCountBasedFrequency(internal, tokens, i, options)) {
      continue;
    }
    const rangeValue = parseNumericRange(token.lower);
    if (rangeValue) {
      if (!internal.doseRange) {
        internal.doseRange = rangeValue;
      }
      mark(internal.consumed, token);
      const resolvedUnit = resolveUnitTokenAt(tokens, i + 1, internal.consumed, options);
      if (resolvedUnit) {
        internal.unit = resolvedUnit.unit;
        for (const consumedIndex of resolvedUnit.consumedIndices) {
          mark(internal.consumed, tokens[consumedIndex]);
        }
      }
      continue;
    }
    if (isNumericToken(token.lower)) {
      if (isDurationPhraseNumber(tokens, i, internal.consumed)) {
        continue;
      }
      const value = parseFloat(token.original);
      const resolvedDose = resolveNumericDoseUnit(tokens, i, value, internal.consumed, options);
      if (internal.dose === undefined) {
        internal.dose = resolvedDose.doseValue;
      }
      mark(internal.consumed, token);
      if (resolvedDose.unit) {
        internal.unit = resolvedDose.unit;
      }
      for (const consumedIndex of resolvedDose.consumedIndices) {
        mark(internal.consumed, tokens[consumedIndex]);
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
    if (token.lower === "per" || token.lower === "a" || token.lower === "every" || token.lower === "each") {
      mark(internal.consumed, token);
      continue;
    }
  }
  applyClauseDefaultsAfterTokenScan(internal, tokens, context, options);
  collectPrnReasonText(internal, tokens, prnReasonStart, prnSiteSuffixIndices, options);
  collectSiteAdviceAndWarnings(
    internal,
    tokens,
    prnReasonStart,
    prnSiteSuffixIndices,
    options,
    maybeApplyRouteDescriptor
  );

  finalizeCanonicalClause(internal);

  return internal;
}

/**
 * Resolves parsed site text against SNOMED dictionaries and synchronous
 * callbacks, applying the best match to the in-progress parse result.
 */
export function applyPrnReasonCoding(
  internal: ParserState,
  options?: ParseOptions
): void {
  runPrnReasonResolutionSync(internal, options);
}

export async function applyPrnReasonCodingAsync(
  internal: ParserState,
  options?: ParseOptions
): Promise<void> {
  await runPrnReasonResolutionAsync(internal, options);
}

export function applySiteCoding(
  internal: ParserState,
  options?: ParseOptions
): void {
  runSiteCodingResolutionSync(internal, options);
}

/**
 * Asynchronous counterpart to {@link applySiteCoding} that awaits resolver and
 * suggestion callbacks so remote terminology services can be used.
 */
export async function applySiteCodingAsync(
  internal: ParserState,
  options?: ParseOptions
): Promise<void> {
  await runSiteCodingResolutionAsync(internal, options);
}

/**
 * Attempts to resolve site codings using built-in dictionaries followed by any
 * provided synchronous resolvers. Suggestions are collected when resolution
 * fails or a `{probe}` placeholder requested an interactive lookup.
 */
function runSiteCodingResolutionSync(
  internal: ParserState,
  options?: ParseOptions
): void {
  internal.siteLookups = [];
  const request = internal.siteLookupRequest;
  if (!request) {
    return;
  }

  const canonical = request.canonical;
  const selection = pickSiteSelection(options?.siteCodeSelections, request);
  const customDefinition = lookupBodySiteDefinition(options?.siteCodeMap, canonical);
  let resolution = selection ?? customDefinition;

  if (!resolution) {
    // Allow synchronous resolver callbacks to claim the site.
    for (const resolver of toArray(options?.siteCodeResolvers)) {
      const result = resolver(request);
      if (isPromise(result)) {
        throw new Error(
          "Site code resolver returned a Promise; use parseSigAsync for asynchronous site resolution."
        );
      }
      if (result) {
        resolution = result;
        break;
      }
    }
  }

  const defaultDefinition = canonical ? DEFAULT_BODY_SITE_SNOMED[canonical] : undefined;
  if (!resolution && defaultDefinition) {
    // Fall back to bundled SNOMED lookups when no overrides claim the site.
    resolution = defaultDefinition;
  }

  if (resolution) {
    applySiteDefinition(internal, resolution);
  } else {
    internal.siteCoding = undefined;
  }

  const needsSuggestions = request.isProbe || !resolution;
  if (!needsSuggestions) {
    return;
  }

  const suggestionMap = new Map<string, SiteCodeSuggestion>();
  if (selection) {
    addSuggestionToMap(suggestionMap, definitionToSuggestion(selection));
  }
  if (customDefinition) {
    addSuggestionToMap(suggestionMap, definitionToSuggestion(customDefinition));
  }
  if (defaultDefinition) {
    addSuggestionToMap(suggestionMap, definitionToSuggestion(defaultDefinition));
  }

  for (const resolver of toArray(options?.siteCodeSuggestionResolvers)) {
    // Aggregates resolver suggestions while guarding against accidental async
    // usage, mirroring the behavior of site resolvers.
    const result = resolver(request);
    if (isPromise(result)) {
      throw new Error(
        "Site code suggestion resolver returned a Promise; use parseSigAsync for asynchronous site suggestions."
      );
    }
    collectSuggestionResult(suggestionMap, result);
  }

  const suggestions = Array.from(suggestionMap.values());
  if (suggestions.length || request.isProbe) {
    internal.siteLookups.push({ request, suggestions });
  }
}

/**
 * Async version of {@link runSiteCodingResolutionSync} that awaits resolver
 * results and suggestion providers, enabling remote terminology services.
 */
async function runSiteCodingResolutionAsync(
  internal: ParserState,
  options?: ParseOptions
): Promise<void> {
  internal.siteLookups = [];
  const request = internal.siteLookupRequest;
  if (!request) {
    return;
  }

  const canonical = request.canonical;
  const selection = pickSiteSelection(options?.siteCodeSelections, request);
  const customDefinition = lookupBodySiteDefinition(options?.siteCodeMap, canonical);
  let resolution = selection ?? customDefinition;

  if (!resolution) {
    // Await asynchronous resolver callbacks (e.g., HTTP terminology services).
    for (const resolver of toArray(options?.siteCodeResolvers)) {
      const result = await resolver(request);
      if (result) {
        resolution = result;
        break;
      }
    }
  }

  const defaultDefinition = canonical ? DEFAULT_BODY_SITE_SNOMED[canonical] : undefined;
  if (!resolution && defaultDefinition) {
    resolution = defaultDefinition;
  }

  if (resolution) {
    applySiteDefinition(internal, resolution);
  } else {
    internal.siteCoding = undefined;
  }

  const needsSuggestions = request.isProbe || !resolution;
  if (!needsSuggestions) {
    return;
  }

  const suggestionMap = new Map<string, SiteCodeSuggestion>();
  if (selection) {
    addSuggestionToMap(suggestionMap, definitionToSuggestion(selection));
  }
  if (customDefinition) {
    addSuggestionToMap(suggestionMap, definitionToSuggestion(customDefinition));
  }
  if (defaultDefinition) {
    addSuggestionToMap(suggestionMap, definitionToSuggestion(defaultDefinition));
  }

  for (const resolver of toArray(options?.siteCodeSuggestionResolvers)) {
    // Async suggestion providers are awaited, allowing UI workflows to fetch
    // candidate codes on demand.
    const result = await resolver(request);
    collectSuggestionResult(suggestionMap, result);
  }

  const suggestions = Array.from(suggestionMap.values());
  if (suggestions.length || request.isProbe) {
    internal.siteLookups.push({ request, suggestions });
  }
}

/**
 * Looks up a body-site definition in a caller-provided map, honoring both
 * direct keys and entries that normalize to the same canonical phrase.
 */
function lookupBodySiteDefinition(
  map: Record<string, BodySiteDefinition> | undefined,
  canonical: string
): BodySiteDefinition | undefined {
  if (!map) {
    return undefined;
  }
  const direct = map[canonical];
  if (direct) {
    return direct;
  }
  for (const [key, definition] of objectEntries(map)) {
    if (normalizeBodySiteKey(key) === canonical) {
      return definition;
    }
    if (definition.aliases) {
      for (const alias of definition.aliases) {
        if (normalizeBodySiteKey(alias) === canonical) {
          return definition;
        }
      }
    }
  }
  return undefined;
}

function pickSiteSelection(
  selections: SiteCodeSelection | SiteCodeSelection[] | undefined,
  request: SiteCodeLookupRequest
): BodySiteDefinition | undefined {
  if (!selections) {
    return undefined;
  }
  const canonical = request.canonical;
  const normalizedText = normalizeBodySiteKey(request.text);
  const requestRange = request.range;
  for (const selection of toArray(selections)) {
    if (!selection) {
      continue;
    }
    let matched = false;
    if (selection.range) {
      if (!requestRange) {
        continue;
      }
      if (
        selection.range.start !== requestRange.start ||
        selection.range.end !== requestRange.end
      ) {
        continue;
      }
      matched = true;
    }
    if (selection.canonical) {
      if (normalizeBodySiteKey(selection.canonical) !== canonical) {
        continue;
      }
      matched = true;
    } else if (selection.text) {
      const normalizedSelection = normalizeBodySiteKey(selection.text);
      if (normalizedSelection !== canonical && normalizedSelection !== normalizedText) {
        continue;
      }
      matched = true;
    }
    if (!selection.range && !selection.canonical && !selection.text) {
      continue;
    }
    if (matched) {
      return selection.resolution;
    }
  }
  return undefined;
}

/**
 * Applies the selected body-site definition onto the parser state, defaulting
 * the coding system to SNOMED CT when the definition omits one.
 */
function applySiteDefinition(internal: ParserState, definition: BodySiteDefinition) {
  const coding = definition.coding;
  internal.siteCoding = coding?.code
    ? {
      code: coding.code,
      display: coding.display,
      system: coding.system ?? SNOMED_SYSTEM
    }
    : undefined;
  if (definition.text) {
    internal.siteText = definition.text;
  } else if (!internal.siteText && internal.siteLookupRequest?.text) {
    internal.siteText = internal.siteLookupRequest.text;
  }
}

/**
 * Converts a body-site definition into a suggestion payload so all suggestion
 * sources share consistent structure.
 */
function definitionToSuggestion(
  definition: BodySiteDefinition
): SiteCodeSuggestion | undefined {
  const coding = definition.coding;
  if (!coding?.code) {
    return undefined;
  }
  return {
    coding: {
      code: coding.code,
      display: coding.display,
      system: coding.system ?? SNOMED_SYSTEM
    },
    text: definition.text
  };
}

/**
 * Inserts a suggestion into a deduplicated map keyed by system and code.
 */
function addSuggestionToMap(
  map: Map<string, SiteCodeSuggestion>,
  suggestion: SiteCodeSuggestion | undefined
) {
  if (!suggestion) {
    return;
  }
  const coding = suggestion.coding;
  if (!coding?.code) {
    return;
  }
  const key = `${coding.system ?? SNOMED_SYSTEM}|${coding.code}`;
  if (!map.has(key)) {
    map.set(key, {
      coding: {
        code: coding.code,
        display: coding.display,
        system: coding.system ?? SNOMED_SYSTEM
      },
      text: suggestion.text
    });
  }
}

/**
 * Normalizes resolver outputs into a consistent array before merging them into
 * the suggestion map.
 */
function collectSuggestionResult(
  map: Map<string, SiteCodeSuggestion>,
  result:
    | SiteCodeSuggestionsResult
    | SiteCodeSuggestion[]
    | SiteCodeSuggestion
    | null
    | undefined
) {
  if (!result) {
    return;
  }
  const suggestions = Array.isArray(result)
    ? result
    : typeof result === "object" && "suggestions" in result
      ? (result as SiteCodeSuggestionsResult).suggestions
      : [result];
  for (const suggestion of suggestions) {
    addSuggestionToMap(map, suggestion);
  }
}

const BODY_SITE_ADJECTIVE_SUFFIXES = [
  "al",
  "ial",
  "ual",
  "ic",
  "ous",
  "ive",
  "ary",
  "ory",
  "atic",
  "etic",
  "ular",
  "otic",
  "ile",
  "eal",
  "inal",
  "aneal",
  "enal"
];

const DEFAULT_SITE_SYNONYM_KEYS = (() => {
  const map = new Map<BodySiteDefinition, string[]>();
  for (const [key, definition] of objectEntries(DEFAULT_BODY_SITE_SNOMED)) {
    if (!definition) {
      continue;
    }
    const normalized = key.trim();
    if (!normalized) {
      continue;
    }
    const existing = map.get(definition);
    if (existing) {
      if (existing.indexOf(normalized) === -1) {
        existing.push(normalized);
      }
    } else {
      map.set(definition, [normalized]);
    }
  }
  return map;
})();

function normalizeSiteDisplayText(
  text: string,
  customSiteMap?: Record<string, BodySiteDefinition>
): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }

  const canonicalInput = normalizeBodySiteKey(trimmed);
  if (!canonicalInput) {
    return trimmed;
  }

  const resolvePreferred = (
    canonical: string
  ): { text: string; canonical: string } | undefined => {
    const definition =
      lookupBodySiteDefinition(customSiteMap, canonical) ??
      DEFAULT_BODY_SITE_SNOMED[canonical];
    if (!definition) {
      return undefined;
    }
    const preferred = pickPreferredBodySitePhrase(
      canonical,
      definition,
      customSiteMap
    );
    const textValue = preferred ?? canonical;
    const normalized = normalizeBodySiteKey(textValue);
    if (!normalized) {
      return undefined;
    }
    return { text: textValue, canonical: normalized };
  };

  if (isAdjectivalSitePhrase(canonicalInput)) {
    const direct = resolvePreferred(canonicalInput);
    return direct?.text ?? trimmed;
  }

  const words = canonicalInput.split(/\s+/).filter((word) => word.length > 0);
  for (let i = 1; i < words.length; i++) {
    const prefix = words.slice(0, i);
    if (!prefix.every((word) => isAdjectivalSitePhrase(word))) {
      continue;
    }
    const candidateCanonical = words.slice(i).join(" ");
    if (!candidateCanonical) {
      continue;
    }
    const candidatePreferred = resolvePreferred(candidateCanonical);
    if (!candidatePreferred) {
      continue;
    }
    const prefixMatches = prefix.every((word) => {
      const normalizedPrefix = resolvePreferred(word);
      return (
        normalizedPrefix !== undefined &&
        normalizedPrefix.canonical === candidatePreferred.canonical
      );
    });
    if (!prefixMatches) {
      continue;
    }
    return candidatePreferred.text;
  }

  return trimmed;
}

function pickPreferredBodySitePhrase(
  canonical: string,
  definition: BodySiteDefinition,
  customSiteMap?: Record<string, BodySiteDefinition>
): string | undefined {
  const synonyms = new Set<string>();
  synonyms.add(canonical);

  if (definition.aliases) {
    for (const alias of definition.aliases) {
      const normalizedAlias = normalizeBodySiteKey(alias);
      if (normalizedAlias) {
        synonyms.add(normalizedAlias);
      }
    }
  }

  const defaultSynonyms = DEFAULT_SITE_SYNONYM_KEYS.get(definition);
  if (defaultSynonyms) {
    for (const synonym of defaultSynonyms) {
      synonyms.add(synonym);
    }
  }

  if (customSiteMap) {
    for (const [key, candidate] of objectEntries(customSiteMap)) {
      if (!candidate) {
        continue;
      }
      if (candidate === definition) {
        const normalizedKey = normalizeBodySiteKey(key);
        if (normalizedKey) {
          synonyms.add(normalizedKey);
        }
        if (candidate.aliases) {
          for (const alias of candidate.aliases) {
            const normalizedAlias = normalizeBodySiteKey(alias);
            if (normalizedAlias) {
              synonyms.add(normalizedAlias);
            }
          }
        }
      }
    }
  }

  const candidates = Array.from(synonyms).filter(
    (phrase) => phrase && !isAdjectivalSitePhrase(phrase)
  );
  if (!candidates.length) {
    return undefined;
  }

  candidates.sort((a, b) => scoreBodySitePhrase(b) - scoreBodySitePhrase(a));
  const best = candidates[0];
  if (!best) {
    return undefined;
  }

  if (normalizeBodySiteKey(best) === canonical) {
    return undefined;
  }

  return best;
}

function scoreBodySitePhrase(phrase: string): number {
  const lower = phrase.toLowerCase();
  const words = lower.split(/\s+/).filter((part) => part.length > 0);
  let score = 0;
  if (!/(structure|region|entire|proper|body)/.test(lower)) {
    score += 3;
  }
  if (!lower.includes(" of ")) {
    score += 1;
  }
  if (words.length <= 2) {
    score += 1;
  }
  if (words.length === 1) {
    score += 0.5;
  }
  score -= words.length * 0.2;
  score -= lower.length * 0.01;
  return score;
}

function isAdjectivalSitePhrase(phrase: string): boolean {
  const normalized = phrase.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const words = normalized.split(/\s+/).filter((word) => word.length > 0);
  if (words.length !== 1) {
    return false;
  }
  const last = words[words.length - 1];
  if (last.length <= 3) {
    return false;
  }
  return BODY_SITE_ADJECTIVE_SUFFIXES.some((suffix) => last.endsWith(suffix));
}

function hasInstructionSeparatorBeforeRange(
  input: string,
  range: TextRange | undefined
): boolean {
  if (!range) {
    return false;
  }
  for (let cursor = range.start - 1; cursor >= 0; cursor--) {
    const char = input[cursor];
    if (char === "\n" || char === "\r") {
      return true;
    }
    if (/\s/.test(char)) {
      continue;
    }
    return char === ";" || char === ":" || char === "," || char === "-" || char === ".";
  }
  return false;
}

function inferAdditionalInstructionPredicate(
  internal: ParserState,
  tokens: Token[]
): string {
  if (hasApplicationVerbBefore(tokens, tokens.length, internal.consumed)) {
    return "apply";
  }
  if (
    internal.routeCode === RouteCode["Topical route"] ||
    internal.routeCode === RouteCode["Transdermal route"] ||
    internal.routeCode === RouteCode["Otic route"] ||
    internal.routeCode === RouteCode["Nasal route"] ||
    internal.routeCode === RouteCode["Ophthalmic route"]
  ) {
    return "apply";
  }
  if (
    internal.routeCode === RouteCode["Per rectum"] ||
    internal.routeCode === RouteCode["Per vagina"]
  ) {
    return "use";
  }
  return "take";
}

function collectAdditionalInstructions(
  internal: ParserState,
  tokens: Token[]
): void {
  if (internal.additionalInstructions.length) {
    return;
  }
  const groups = findUnparsedTokenGroups(internal);
  if (!groups.length) {
    return;
  }

  const instructions: ParserState["additionalInstructions"] = [];
  const seen = new Set<string>();
  const defaultPredicate = inferAdditionalInstructionPredicate(internal, tokens);

  for (const group of groups) {
    if (!group.tokens.length) {
      continue;
    }
    const range = group.range ?? computeTokenRange(
      internal.input,
      tokens,
      group.tokens.map((token) => token.index)
    );
    let sourceText = "";
    if (range) {
      sourceText = internal.input.slice(range.start, range.end);
    } else {
      for (const token of group.tokens) {
        if (sourceText) {
          sourceText += " ";
        }
        sourceText += token.original;
      }
    }
    sourceText = sourceText.replace(/\s+/g, " ").trim();
    if (!sourceText) {
      continue;
    }

    const separatorDetected =
      sourceText.includes(";") ||
      sourceText.includes(".") ||
      sourceText.includes("\n") ||
      sourceText.includes("\r") ||
      hasInstructionSeparatorBeforeRange(internal.input, range);

    const parsed = parseAdditionalInstructions(
      sourceText,
      range ?? { start: 0, end: sourceText.length },
      {
        defaultPredicate,
        allowFreeTextFallback: separatorDetected
      }
    );
    if (!parsed.length) {
      continue;
    }

    let groupAccepted = false;
    for (const parsedInstruction of parsed) {
      const key = parsedInstruction.coding?.code
        ? `code:${parsedInstruction.coding.system ?? SNOMED_SYSTEM}|${parsedInstruction.coding.code}`
        : parsedInstruction.text
          ? `text:${parsedInstruction.text.toLowerCase()}`
          : `frames:${parsedInstruction.frames.length}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      instructions.push({
        text: parsedInstruction.text,
        coding: parsedInstruction.coding,
        frames: parsedInstruction.frames
      });
      groupAccepted = true;
    }

    if (groupAccepted) {
      for (const token of group.tokens) {
        mark(internal.consumed, token);
      }
    }
  }

  if (instructions.length) {
    internal.additionalInstructions = instructions;
  }
}

function determinePrnReasonCutoff(tokens: Token[], sourceText: string): number | undefined {
  const separatorIndex = findPrnReasonSeparator(sourceText);
  if (separatorIndex === undefined) {
    return undefined;
  }

  const lowerSource = sourceText.toLowerCase();
  let searchOffset = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const fragment = token.original.trim();
    if (!fragment) {
      continue;
    }
    const lowerFragment = fragment.toLowerCase();
    const position = lowerSource.indexOf(lowerFragment, searchOffset);
    if (position === -1) {
      continue;
    }
    const end = position + lowerFragment.length;
    searchOffset = end;
    if (position >= separatorIndex) {
      return i;
    }
  }

  return undefined;
}

function findPrnReasonSeparator(sourceText: string): number | undefined {
  for (let i = 0; i < sourceText.length; i++) {
    const ch = sourceText[i];
    if (ch === "\n" || ch === "\r") {
      if (sourceText.slice(i + 1).trim().length > 0) {
        return i;
      }
      continue;
    }
    if (ch === ";") {
      if (sourceText.slice(i + 1).trim().length > 0) {
        return i;
      }
      continue;
    }
    if (ch === "-") {
      const prev = sourceText[i - 1];
      const next = sourceText[i + 1];
      const hasWhitespaceAround = (!prev || /\s/.test(prev)) && (!next || /\s/.test(next));
      if (hasWhitespaceAround && sourceText.slice(i + 1).trim().length > 0) {
        return i;
      }
      continue;
    }
    if (ch === ":" || ch === ".") {
      const rest = sourceText.slice(i + 1);
      if (!rest.trim().length) {
        continue;
      }
      const nextChar = rest.replace(/^\s+/, "")[0];
      if (!nextChar) {
        continue;
      }
      if (
        ch === "." &&
        /[0-9]/.test(sourceText[i - 1] ?? "") &&
        /[0-9]/.test(nextChar)
      ) {
        continue;
      }
      return i;
    }
  }

  return undefined;
}

interface PrnSiteSuffixDetection {
  tokens: Token[];
  startIndex: number;
}

function findTrailingPrnSiteSuffix(
  tokens: Token[],
  internal: ParserState,
  options?: ParseOptions
): PrnSiteSuffixDetection | undefined {
  let suffixStart: number | undefined;
  let hasSiteHint = false;
  let hasConnector = false;

  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i];
    const lower = normalizeTokenLower(token);
    if (!lower) {
      if (suffixStart !== undefined && token.original.trim()) {
        break;
      }
      continue;
    }
    if (isBodySiteHint(lower, internal.customSiteHints)) {
      hasSiteHint = true;
      suffixStart = i;
      continue;
    }
    if (suffixStart !== undefined) {
      if (SITE_CONNECTORS.has(lower)) {
        hasConnector = true;
        suffixStart = i;
        continue;
      }
      if (SITE_FILLER_WORDS.has(lower) || ROUTE_DESCRIPTOR_FILLER_WORDS.has(lower)) {
        suffixStart = i;
        continue;
      }
    }
    if (suffixStart !== undefined) {
      break;
    }
  }

  if (!hasSiteHint || !hasConnector || suffixStart === undefined || suffixStart === 0) {
    return undefined;
  }

  const suffixTokens = tokens.slice(suffixStart);
  const siteWords: string[] = [];
  const siteHintTokens: Token[] = [];
  for (const token of suffixTokens) {
    const trimmed = token.original.trim();
    if (!trimmed) {
      continue;
    }
    const lower = normalizeTokenLower(token);
    if (
      SITE_CONNECTORS.has(lower) ||
      SITE_FILLER_WORDS.has(lower) ||
      ROUTE_DESCRIPTOR_FILLER_WORDS.has(lower)
    ) {
      continue;
    }
    siteHintTokens.push(token);
    siteWords.push(trimmed);
  }

  if (!siteWords.length) {
    return undefined;
  }

  const sitePhrase = siteWords.join(" ");
  const canonical = normalizeBodySiteKey(sitePhrase);
  if (!canonical) {
    return undefined;
  }

  const definition =
    lookupBodySiteDefinition(options?.siteCodeMap, canonical) ?? DEFAULT_BODY_SITE_SNOMED[canonical];
  if (!definition) {
    return undefined;
  }

  return {
    tokens: siteHintTokens,
    startIndex: suffixStart
  };
}

function lookupPrnReasonDefinition(
  map: Record<string, PrnReasonDefinition> | undefined,
  canonical: string
): PrnReasonDefinition | undefined {
  if (!map) {
    return undefined;
  }
  const direct = map[canonical];
  if (direct) {
    return direct;
  }
  for (const [key, definition] of objectEntries(map)) {
    if (normalizePrnReasonKey(key) === canonical) {
      return definition;
    }
    if (definition.aliases) {
      for (const alias of definition.aliases) {
        if (normalizePrnReasonKey(alias) === canonical) {
          return definition;
        }
      }
    }
  }
  return undefined;
}

function pickPrnReasonSelection(
  selections: PrnReasonSelection | PrnReasonSelection[] | undefined,
  request: PrnReasonLookupRequest
): PrnReasonDefinition | undefined {
  if (!selections) {
    return undefined;
  }
  const canonical = request.canonical;
  const normalizedText = normalizePrnReasonKey(request.text);
  const requestRange = request.range;
  for (const selection of toArray(selections)) {
    if (!selection) {
      continue;
    }
    let matched = false;
    if (selection.range) {
      if (!requestRange) {
        continue;
      }
      if (
        selection.range.start !== requestRange.start ||
        selection.range.end !== requestRange.end
      ) {
        continue;
      }
      matched = true;
    }
    if (selection.canonical) {
      if (normalizePrnReasonKey(selection.canonical) !== canonical) {
        continue;
      }
      matched = true;
    } else if (selection.text) {
      const normalizedSelection = normalizePrnReasonKey(selection.text);
      if (normalizedSelection !== canonical && normalizedSelection !== normalizedText) {
        continue;
      }
      matched = true;
    }
    if (!selection.range && !selection.canonical && !selection.text) {
      continue;
    }
    if (matched) {
      return selection.resolution;
    }
  }
  return undefined;
}

function applyPrnReasonDefinition(
  internal: ParserState,
  definition: PrnReasonDefinition
) {
  const coding = definition.coding;
  internal.asNeededReasonCoding = coding?.code
    ? {
      code: coding.code,
      display: coding.display,
      system: coding.system ?? SNOMED_SYSTEM,
      i18n: definition.i18n
    }
    : undefined;
  if (definition.text && !internal.asNeededReason) {
    internal.asNeededReason = definition.text;
  }
}

function definitionToPrnSuggestion(
  definition: PrnReasonDefinition
): PrnReasonSuggestion {
  return {
    coding: definition.coding?.code
      ? {
        code: definition.coding.code,
        display: definition.coding.display,
        system: definition.coding.system ?? SNOMED_SYSTEM
      }
      : undefined,
    text: definition.text ?? definition.coding?.display
  };
}

function addReasonSuggestionToMap(
  map: Map<string, PrnReasonSuggestion>,
  suggestion: PrnReasonSuggestion | undefined
) {
  if (!suggestion) {
    return;
  }
  const coding = suggestion.coding;
  const key = coding?.code
    ? `${coding.system ?? SNOMED_SYSTEM}|${coding.code}`
    : suggestion.text
      ? `text:${suggestion.text.toLowerCase()}`
      : undefined;
  if (!key || map.has(key)) {
    return;
  }
  map.set(key, suggestion);
}

function collectReasonSuggestionResult(
  map: Map<string, PrnReasonSuggestion>,
  result:
    | PrnReasonSuggestionsResult
    | PrnReasonSuggestion[]
    | PrnReasonSuggestion
    | null
    | undefined
) {
  if (!result) {
    return;
  }
  const suggestions = Array.isArray(result)
    ? result
    : typeof result === "object" && "suggestions" in result
      ? (result as PrnReasonSuggestionsResult).suggestions
      : [result];
  for (const suggestion of suggestions) {
    addReasonSuggestionToMap(map, suggestion);
  }
}

function collectDefaultPrnReasonDefinitions(
  request: PrnReasonLookupRequest
): PrnReasonDefinition[] {
  const canonical = request.canonical;
  const normalized = request.normalized;
  const seen = new Set<PrnReasonDefinition>();
  for (const entry of DEFAULT_PRN_REASON_ENTRIES) {
    if (!entry.canonical) {
      continue;
    }
    if (entry.canonical === canonical) {
      seen.add(entry.definition);
      continue;
    }
    if (canonical && (entry.canonical.includes(canonical) || canonical.includes(entry.canonical))) {
      seen.add(entry.definition);
      continue;
    }
    for (const term of entry.terms) {
      const normalizedTerm = normalizePrnReasonKey(term);
      if (!normalizedTerm) {
        continue;
      }
      if (canonical && canonical.includes(normalizedTerm)) {
        seen.add(entry.definition);
        break;
      }
      if (normalized.includes(normalizedTerm)) {
        seen.add(entry.definition);
        break;
      }
    }
  }
  if (!seen.size) {
    for (const entry of DEFAULT_PRN_REASON_ENTRIES) {
      seen.add(entry.definition);
    }
  }
  return Array.from(seen);
}

function runPrnReasonResolutionSync(
  internal: ParserState,
  options?: ParseOptions
): void {
  internal.prnReasonLookups = [];
  const request = internal.prnReasonLookupRequest;
  if (!request) {
    return;
  }

  const canonical = request.canonical;
  const selection = pickPrnReasonSelection(options?.prnReasonSelections, request);
  const customDefinition = lookupPrnReasonDefinition(options?.prnReasonMap, canonical);
  let resolution = selection ?? customDefinition;

  if (!resolution) {
    for (const resolver of toArray(options?.prnReasonResolvers)) {
      const result = resolver(request);
      if (isPromise(result)) {
        throw new Error(
          "PRN reason resolver returned a Promise; use parseSigAsync for asynchronous PRN reason resolution."
        );
      }
      if (result) {
        resolution = result;
        break;
      }
    }
  }

  const defaultDefinition = canonical ? DEFAULT_PRN_REASON_DEFINITIONS[canonical] : undefined;
  if (!resolution && defaultDefinition) {
    resolution = defaultDefinition;
  }

  if (resolution) {
    applyPrnReasonDefinition(internal, resolution);
  } else {
    internal.asNeededReasonCoding = undefined;
  }

  const needsSuggestions = request.isProbe || !resolution;
  if (!needsSuggestions) {
    return;
  }

  const suggestionMap = new Map<string, PrnReasonSuggestion>();
  if (selection) {
    addReasonSuggestionToMap(suggestionMap, definitionToPrnSuggestion(selection));
  }
  if (customDefinition) {
    addReasonSuggestionToMap(suggestionMap, definitionToPrnSuggestion(customDefinition));
  }
  if (defaultDefinition) {
    addReasonSuggestionToMap(suggestionMap, definitionToPrnSuggestion(defaultDefinition));
  }
  for (const definition of collectDefaultPrnReasonDefinitions(request)) {
    addReasonSuggestionToMap(suggestionMap, definitionToPrnSuggestion(definition));
  }

  for (const resolver of toArray(options?.prnReasonSuggestionResolvers)) {
    const result = resolver(request);
    if (isPromise(result)) {
      throw new Error(
        "PRN reason suggestion resolver returned a Promise; use parseSigAsync for asynchronous PRN reason suggestions."
      );
    }
    collectReasonSuggestionResult(suggestionMap, result);
  }

  const suggestions = Array.from(suggestionMap.values());
  if (suggestions.length || request.isProbe) {
    internal.prnReasonLookups.push({ request, suggestions });
  }
}

async function runPrnReasonResolutionAsync(
  internal: ParserState,
  options?: ParseOptions
): Promise<void> {
  internal.prnReasonLookups = [];
  const request = internal.prnReasonLookupRequest;
  if (!request) {
    return;
  }

  const canonical = request.canonical;
  const selection = pickPrnReasonSelection(options?.prnReasonSelections, request);
  const customDefinition = lookupPrnReasonDefinition(options?.prnReasonMap, canonical);
  let resolution = selection ?? customDefinition;

  if (!resolution) {
    for (const resolver of toArray(options?.prnReasonResolvers)) {
      const result = await resolver(request);
      if (result) {
        resolution = result;
        break;
      }
    }
  }

  const defaultDefinition = canonical ? DEFAULT_PRN_REASON_DEFINITIONS[canonical] : undefined;
  if (!resolution && defaultDefinition) {
    resolution = defaultDefinition;
  }

  if (resolution) {
    applyPrnReasonDefinition(internal, resolution);
  } else {
    internal.asNeededReasonCoding = undefined;
  }

  const needsSuggestions = request.isProbe || !resolution;
  if (!needsSuggestions) {
    return;
  }

  const suggestionMap = new Map<string, PrnReasonSuggestion>();
  if (selection) {
    addReasonSuggestionToMap(suggestionMap, definitionToPrnSuggestion(selection));
  }
  if (customDefinition) {
    addReasonSuggestionToMap(suggestionMap, definitionToPrnSuggestion(customDefinition));
  }
  if (defaultDefinition) {
    addReasonSuggestionToMap(suggestionMap, definitionToPrnSuggestion(defaultDefinition));
  }
  for (const definition of collectDefaultPrnReasonDefinitions(request)) {
    addReasonSuggestionToMap(suggestionMap, definitionToPrnSuggestion(definition));
  }

  for (const resolver of toArray(options?.prnReasonSuggestionResolvers)) {
    const result = await resolver(request);
    collectReasonSuggestionResult(suggestionMap, result);
  }

  const suggestions = Array.from(suggestionMap.values());
  if (suggestions.length || request.isProbe) {
    internal.prnReasonLookups.push({ request, suggestions });
  }
}

/**
 * Wraps scalar or array configuration into an array to simplify iteration.
 */
function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/**
 * Detects thenables without relying on `instanceof Promise`, which can break
 * across execution contexts.
 */
function isPromise<T>(value: unknown): value is Promise<T> {
  return !!value && typeof (value as { then?: unknown }).then === "function";
}

function normalizeUnit(token: string, options?: ParseOptions): string | undefined {
  const override = enforceHouseholdUnitPolicy(options?.unitMap?.[token], options);
  if (override) {
    return override;
  }
  const defaultUnit = enforceHouseholdUnitPolicy(
    DEFAULT_UNIT_SYNONYMS[token],
    options,
  );
  if (defaultUnit) {
    return defaultUnit;
  }
  return undefined;
}

function enforceHouseholdUnitPolicy(
  unit: string | undefined,
  options?: ParseOptions,
): string | undefined {
  if (
    unit &&
    options?.allowHouseholdVolumeUnits === false &&
    HOUSEHOLD_VOLUME_UNIT_SET.has(unit.toLowerCase())
  ) {
    return undefined;
  }
  return unit;
}

function isDiscreteUnit(unit: string): boolean {
  if (!unit) {
    return false;
  }
  return DISCRETE_UNIT_SET.has(unit.trim().toLowerCase());
}

function inferUnitFromRouteHints(internal: ParserState): string | undefined {
  if (internal.routeCode) {
    const unit = DEFAULT_UNIT_BY_ROUTE[internal.routeCode];
    if (unit) {
      return unit;
    }
  }

  if (internal.routeText) {
    const normalized = internal.routeText.trim().toLowerCase();
    const synonym = DEFAULT_ROUTE_SYNONYMS[normalized];
    if (synonym) {
      const unit = DEFAULT_UNIT_BY_ROUTE[synonym.code];
      if (unit) {
        return unit;
      }
    }
  }

  if (internal.siteText) {
    const unit = inferUnitFromSiteText(internal.siteText);
    if (unit) {
      return unit;
    }
  }

  return undefined;
}

function inferUnitFromSiteText(siteText: string): string | undefined {
  const route = inferRouteHintFromSitePhraseFromModule(siteText, undefined, {
    lookupBodySiteDefinition
  });
  if (route) {
    const unit = DEFAULT_UNIT_BY_ROUTE[route];
    if (unit) {
      return unit;
    }
  }
  return undefined;
}
