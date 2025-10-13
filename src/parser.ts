import {
  DAY_OF_WEEK_TOKENS,
  DEFAULT_ADDITIONAL_INSTRUCTION_DEFINITIONS,
  DEFAULT_ADDITIONAL_INSTRUCTION_ENTRIES,
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
  normalizeAdditionalInstructionKey,
  normalizeBodySiteKey,
  normalizePrnReasonKey
} from "./maps";
import { inferUnitFromContext } from "./context";
import { checkDiscouraged } from "./safety";
import { ParsedSigInternal, Token } from "./internal-types";
import {
  AdditionalInstructionDefinition,
  BodySiteDefinition,
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
  return BODY_SITE_HINTS.has(word) || (customSiteHints?.has(word) ?? false);
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
  "back",
  "mouth",
  "tongue",
  "tongues",
  "cheek",
  "cheeks",
  "gum",
  "gums",
  "tooth",
  "teeth",
  "nose",
  "nares",
  "hair",
  "skin",
  "scalp",
  "face",
  "forehead",
  "chin",
  "neck",
  "buttock",
  "buttocks",
  "gluteal",
  "glute",
  "muscle",
  "muscles",
  "vein",
  "veins",
  "vagina",
  "vaginal",
  "penis",
  "penile",
  "rectum",
  "rectal",
  "anus",
  "perineum",
  "temple",
  "temples"
]);

const SITE_CONNECTORS = new Set(["to", "in", "into", "on", "onto", "at"]);

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
  "upon waking": EventTiming.Wake
};

const MEAL_CONTEXT_CONNECTORS = new Set(["and", "or", "&", "+", "plus"]);

const COUNT_KEYWORDS = new Set([
  "time",
  "times",
  "dose",
  "doses",
  "application",
  "applications",
  "use",
  "uses"
]);

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

const OPHTHALMIC_ROUTE_CODES = new Set<RouteCode>([
  RouteCode["Ophthalmic route"],
  RouteCode["Intravitreal route (qualifier value)"]
]);

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
  internal: ParsedSigInternal,
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

  const previousEyeToken =
    previousNormalized && previousNormalized !== "od"
      ? EYE_SITE_TOKENS[previousNormalized]
      : undefined;
  if (previousEyeToken && internal.consumed.has(previous.index)) {
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
  internal: ParsedSigInternal,
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
    if (EYE_SITE_TOKENS[normalized]) {
      return true;
    }
  }

  return false;
}

function hasBodySiteContextAfter(
  internal: ParsedSigInternal,
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

function shouldTreatEyeTokenAsSite(
  internal: ParsedSigInternal,
  tokens: Token[],
  index: number,
  context?: MedicationContext | null
): boolean {
  const currentToken = tokens[index];
  const normalizedSelf = normalizeTokenLower(currentToken);
  const eyeMeta = EYE_SITE_TOKENS[normalizedSelf];

  if (internal.routeCode && !OPHTHALMIC_ROUTE_CODES.has(internal.routeCode)) {
    return false;
  }

  if (internal.siteText) {
    return false;
  }

  if (internal.siteSource === "abbreviation") {
    return false;
  }

  const dosageForm = context?.dosageForm?.toLowerCase();
  const contextImpliesOphthalmic = Boolean(
    dosageForm && /(eye|ophth|ocular|intravit)/i.test(dosageForm)
  );
  const eyeRouteImpliesOphthalmic =
    eyeMeta?.route === RouteCode["Intravitreal route (qualifier value)"];
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
    if (EYE_SITE_TOKENS[normalized]) {
      return false;
    }
    if (DEFAULT_ROUTE_SYNONYMS[normalized]) {
      return false;
    }
  }

  return true;
}

function tryParseNumericCadence(
  internal: ParsedSigInternal,
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
  internal: ParsedSigInternal,
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

const SITE_UNIT_ROUTE_HINTS: Array<{ pattern: RegExp; route: RouteCode }> = [
  { pattern: /\beye(s)?\b/i, route: RouteCode["Ophthalmic route"] },
  { pattern: /\beyelid(s)?\b/i, route: RouteCode["Ophthalmic route"] },
  { pattern: /\bintravitreal\b/i, route: RouteCode["Intravitreal route (qualifier value)"] },
  { pattern: /\bear(s)?\b/i, route: RouteCode["Otic route"] },
  { pattern: /\bnostril(s)?\b/i, route: RouteCode["Nasal route"] },
  { pattern: /\bnares?\b/i, route: RouteCode["Nasal route"] },
  { pattern: /\bnose\b/i, route: RouteCode["Nasal route"] },
  { pattern: /\bmouth\b/i, route: RouteCode["Oral route"] },
  { pattern: /\boral\b/i, route: RouteCode["Oral route"] },
  { pattern: /\bunder (the )?tongue\b/i, route: RouteCode["Sublingual route"] },
  { pattern: /\btongue\b/i, route: RouteCode["Sublingual route"] },
  { pattern: /\bcheek(s)?\b/i, route: RouteCode["Buccal route"] },
  { pattern: /\blung(s)?\b/i, route: RouteCode["Respiratory tract route (qualifier value)"] },
  { pattern: /\brespiratory tract\b/i, route: RouteCode["Respiratory tract route (qualifier value)"] },
  { pattern: /\bskin\b/i, route: RouteCode["Topical route"] },
  { pattern: /\bscalp\b/i, route: RouteCode["Topical route"] },
  { pattern: /\bface\b/i, route: RouteCode["Topical route"] },
  { pattern: /\bhand(s)?\b/i, route: RouteCode["Topical route"] },
  { pattern: /(\bfoot\b|\bfeet\b)/i, route: RouteCode["Topical route"] },
  { pattern: /\belbow(s)?\b/i, route: RouteCode["Topical route"] },
  { pattern: /\bknee(s)?\b/i, route: RouteCode["Topical route"] },
  { pattern: /\bleg(s)?\b/i, route: RouteCode["Topical route"] },
  { pattern: /\barm(s)?\b/i, route: RouteCode["Topical route"] },
  { pattern: /\bpatch(es)?\b/i, route: RouteCode["Transdermal route"] },
  { pattern: /\babdomen\b/i, route: RouteCode["Subcutaneous route"] },
  { pattern: /\bbelly\b/i, route: RouteCode["Subcutaneous route"] },
  { pattern: /\bstomach\b/i, route: RouteCode["Subcutaneous route"] },
  { pattern: /\bthigh(s)?\b/i, route: RouteCode["Subcutaneous route"] },
  { pattern: /\bupper arm\b/i, route: RouteCode["Subcutaneous route"] },
  { pattern: /\bbuttock(s)?\b/i, route: RouteCode["Intramuscular route"] },
  { pattern: /\bglute(al)?\b/i, route: RouteCode["Intramuscular route"] },
  { pattern: /\bdeltoid\b/i, route: RouteCode["Intramuscular route"] },
  { pattern: /\bmuscle(s)?\b/i, route: RouteCode["Intramuscular route"] },
  { pattern: /\bvein(s)?\b/i, route: RouteCode["Intravenous route"] },
  { pattern: /\brectum\b/i, route: RouteCode["Per rectum"] },
  { pattern: /\banus\b/i, route: RouteCode["Per rectum"] },
  { pattern: /\brectal\b/i, route: RouteCode["Per rectum"] },
  { pattern: /\bvagina\b/i, route: RouteCode["Per vagina"] },
  { pattern: /\bvaginal\b/i, route: RouteCode["Per vagina"] }
];

export function tokenize(input: string): Token[] {
  const separators = /[(),;]/g;
  let normalized = input.trim().replace(separators, " ");
  normalized = normalized.replace(/\s-\s/g, " ; ");
  normalized = normalized.replace(
    /(\d+(?:\.\d+)?)\s*\/\s*(d|day|days|wk|w|week|weeks|mo|month|months|hr|hrs|hour|hours|h|min|mins|minute|minutes)\b/gi,
    (_match, value, unit) => `${value} per ${unit}`
  );
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

/**
 * Locates the span of the detected site tokens within the caller's original
 * input so downstream consumers can highlight or replace the exact substring.
 */
function computeTokenRange(
  input: string,
  tokens: Token[],
  indices: number[]
): TextRange | undefined {
  if (!indices.length) {
    return undefined;
  }
  const lowerInput = input.toLowerCase();
  let searchStart = 0;
  let rangeStart: number | undefined;
  let rangeEnd: number | undefined;
  for (const tokenIndex of indices) {
    const token = tokens[tokenIndex];
    if (!token) {
      continue;
    }
    const segment = token.original.trim();
    if (!segment) {
      continue;
    }
    const lowerSegment = segment.toLowerCase();
    const foundIndex = lowerInput.indexOf(lowerSegment, searchStart);
    if (foundIndex === -1) {
      return undefined;
    }
    const segmentEnd = foundIndex + lowerSegment.length;
    if (rangeStart === undefined) {
      rangeStart = foundIndex;
    }
    rangeEnd = segmentEnd;
    searchStart = segmentEnd;
  }
  if (rangeStart === undefined || rangeEnd === undefined) {
    return undefined;
  }
  return { start: rangeStart, end: rangeEnd };
}

/**
 * Prefers highlighting the sanitized site text when it can be located directly
 * in the original input; otherwise falls back to the broader token-derived
 * range.
 */
function refineSiteRange(
  input: string,
  sanitized: string,
  tokenRange: TextRange | undefined
): TextRange | undefined {
  if (!input) {
    return tokenRange;
  }
  const trimmed = sanitized.trim();
  if (!trimmed) {
    return tokenRange;
  }
  const lowerInput = input.toLowerCase();
  const lowerSanitized = trimmed.toLowerCase();
  let startIndex = tokenRange ? lowerInput.indexOf(lowerSanitized, tokenRange.start) : -1;
  if (startIndex === -1) {
    startIndex = lowerInput.indexOf(lowerSanitized);
  }
  if (startIndex === -1) {
    return tokenRange;
  }
  return { start: startIndex, end: startIndex + lowerSanitized.length };
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

function sortWhenValues(internal: ParsedSigInternal, options?: ParseOptions) {
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

function reconcileMealTimingSpecificity(internal: ParsedSigInternal) {
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
  let converted = 0;
  for (let lookahead = index + 1; lookahead < tokens.length; lookahead++) {
    const nextToken = tokens[lookahead];
    if (internal.consumed.has(nextToken.index)) {
      continue;
    }
    if (MEAL_CONTEXT_CONNECTORS.has(nextToken.lower)) {
      mark(internal.consumed, nextToken);
      continue;
    }
    const meal = MEAL_KEYWORDS[nextToken.lower];
    if (!meal) {
      break;
    }
    const whenCode =
      code === EventTiming["After Meal"]
        ? meal.pc
        : code === EventTiming["Before Meal"]
        ? meal.ac
        : code;
    addWhen(internal.when, whenCode);
    mark(internal.consumed, nextToken);
    converted++;
  }
  if (converted > 0) {
    mark(internal.consumed, token);
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

function applyCountLimit(internal: ParsedSigInternal, value: number | undefined): boolean {
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
    warnings: [],
    siteTokenIndices: new Set<number>(),
    siteLookups: [],
    customSiteHints: buildCustomSiteHints(options?.siteCodeMap),
    prnReasonLookups: [],
    additionalInstructions: []
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

  const customRouteDescriptorMap = customRouteMap
    ? new Map(
        Array.from(customRouteMap.entries())
          .map(([key, value]) => [normalizeRouteDescriptorPhrase(key), value] as const)
          .filter(([normalized]) => normalized.length > 0)
      )
    : undefined;

  if (tokens.length === 0) {
    return internal;
  }

  // PRN detection
  let prnReasonStart: number | undefined;
  const prnSiteSuffixIndices = new Set<number>();
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
    if (normalizedDescriptor && normalizedDescriptor !== normalized) {
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
      const synonym = customCode
        ? { code: customCode, text: ROUTE_TEXT[customCode] }
        : DEFAULT_ROUTE_SYNONYMS[phrase];
      if (synonym) {
        if (phrase === "in" && slice.length === 1) {
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

    if (token.lower === "q") {
      if (parseSeparatedQ(internal, tokens, i, options)) {
        continue;
      }
    }

    if (tryParseNumericCadence(internal, tokens, i)) {
      continue;
    }

    const eyeSite = EYE_SITE_TOKENS[normalizedLower];
    const treatEyeTokenAsSite = eyeSite
      ? shouldTreatEyeTokenAsSite(internal, tokens, i, context)
      : false;

    if (normalizedLower === "od") {
      const descriptor = TIMING_ABBREVIATIONS.od;
      if (
        descriptor &&
        shouldInterpretOdAsOnceDaily(internal, tokens, i, treatEyeTokenAsSite)
      ) {
        applyFrequencyDescriptor(internal, token, descriptor, options);
        continue;
      }
    }

    // Frequency abbreviation map
    const freqDescriptor =
      normalizedLower === "od"
        ? undefined
        : TIMING_ABBREVIATIONS[token.lower] ?? TIMING_ABBREVIATIONS[normalizedLower];
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

    if (eyeSite && treatEyeTokenAsSite) {
      internal.siteText = eyeSite.site;
      internal.siteSource = "abbreviation";
      if (eyeSite.route && !internal.routeCode) {
        setRoute(internal, eyeSite.route);
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
          if (nextToken && COUNT_KEYWORDS.has(nextToken.lower)) {
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
          if (afterToken && COUNT_KEYWORDS.has(afterToken.lower)) {
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
            COUNT_KEYWORDS.has(keywordToken.lower) &&
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
      if (COUNT_KEYWORDS.has(token.lower)) {
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
    if (token.lower === "per" || token.lower === "a" || token.lower === "every" || token.lower === "each") {
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
    internal.unit = enforceHouseholdUnitPolicy(
      inferUnitFromContext(context),
      options,
    );
  }

  if (internal.unit === undefined) {
    const fallbackUnit = enforceHouseholdUnitPolicy(
      inferUnitFromRouteHints(internal),
      options,
    );
    if (fallbackUnit) {
      internal.unit = fallbackUnit;
    }
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

  reconcileMealTimingSpecificity(internal);

  // Expand generic meal markers into specific EventTiming codes when asked to.
  expandMealTimings(internal, options);

  sortWhenValues(internal, options);

  // PRN reason text
  if (internal.asNeeded && prnReasonStart !== undefined) {
    const reasonTokens: string[] = [];
    const reasonIndices: number[] = [];
    const reasonObjects: Token[] = [];
    for (let i = prnReasonStart; i < tokens.length; i++) {
      const token = tokens[i];
      if (internal.consumed.has(token.index)) {
        internal.consumed.delete(token.index);
      }
      reasonTokens.push(token.original);
      reasonIndices.push(token.index);
      reasonObjects.push(token);
      mark(internal.consumed, token);
    }
    if (reasonTokens.length > 0) {
      let sortedIndices = reasonIndices.slice().sort((a, b) => a - b);
      let range = computeTokenRange(internal.input, tokens, sortedIndices);
      let sourceText = range ? internal.input.slice(range.start, range.end) : undefined;
      if (sourceText) {
        const cutoff = determinePrnReasonCutoff(reasonObjects, sourceText);
        if (cutoff !== undefined) {
          for (let i = cutoff; i < reasonObjects.length; i++) {
            internal.consumed.delete(reasonObjects[i].index);
          }
          reasonObjects.splice(cutoff);
          reasonTokens.splice(cutoff);
          reasonIndices.splice(cutoff);
          while (reasonTokens.length > 0) {
            const lastToken = reasonTokens[reasonTokens.length - 1];
            if (!lastToken || /^[;:.,-]+$/.test(lastToken.trim())) {
              const removedObject = reasonObjects.pop();
              if (removedObject) {
                internal.consumed.delete(removedObject.index);
              }
              reasonTokens.pop();
              const removedIndex = reasonIndices.pop();
              if (removedIndex !== undefined) {
                internal.consumed.delete(removedIndex);
              }
              continue;
            }
            break;
          }
          if (reasonTokens.length > 0) {
            sortedIndices = reasonIndices.slice().sort((a, b) => a - b);
            range = computeTokenRange(internal.input, tokens, sortedIndices);
            sourceText = range ? internal.input.slice(range.start, range.end) : undefined;
          } else {
            range = undefined;
            sourceText = undefined;
          }
        }
      }
      let canonicalPrefix: string | undefined;
      if (reasonTokens.length > 0) {
        const suffixInfo = findTrailingPrnSiteSuffix(reasonObjects, internal, options);
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
      if (reasonTokens.length > 0) {
        const joined = reasonTokens.join(" ").trim();
        if (joined) {
          let sanitized = joined.replace(/\s+/g, " ").trim();
          let isProbe = false;
          const probeMatch = sanitized.match(/^\{(.+)}$/);
          if (probeMatch) {
            isProbe = true;
            sanitized = probeMatch[1];
          }
          sanitized = sanitized.replace(/[{}]/g, " ").replace(/\s+/g, " ").trim();
          const text = sanitized || joined;
          internal.asNeededReason = text;
          const normalized = text.toLowerCase();
          const canonicalSource = canonicalPrefix || sanitized || text;
          const canonical = canonicalSource
            ? normalizePrnReasonKey(canonicalSource)
            : normalizePrnReasonKey(text);
          internal.prnReasonLookupRequest = {
            originalText: joined,
            text,
            normalized,
            canonical: canonical ?? "",
            isProbe,
            inputText: internal.input,
            sourceText,
            range
          };
        }
      }
    }
  }

  collectAdditionalInstructions(internal, tokens);

  // Determine site text from leftover tokens (excluding PRN reason tokens)
  const leftoverTokens = tokens.filter((t) => !internal.consumed.has(t.index));
  const siteCandidateIndices = new Set<number>();
  const leftoverSiteIndices = new Set<number>();
  for (const token of leftoverTokens) {
    if (prnSiteSuffixIndices.has(token.index)) {
      continue;
    }
    const normalized = normalizeTokenLower(token);
    if (isBodySiteHint(normalized, internal.customSiteHints)) {
      siteCandidateIndices.add(token.index);
      leftoverSiteIndices.add(token.index);
      continue;
    }
    if (SITE_CONNECTORS.has(normalized)) {
      const next = tokens[token.index + 1];
      if (next && !internal.consumed.has(next.index) && !prnSiteSuffixIndices.has(next.index)) {
        siteCandidateIndices.add(next.index);
      }
    }
  }
  if (leftoverSiteIndices.size === 0) {
    for (const idx of internal.siteTokenIndices) {
      if (prnSiteSuffixIndices.has(idx)) {
        continue;
      }
      siteCandidateIndices.add(idx);
    }
  }
  if (siteCandidateIndices.size > 0) {
    const indicesToInclude = new Set<number>(siteCandidateIndices);
    for (const idx of siteCandidateIndices) {
      let prev = idx - 1;
      while (prev >= 0) {
        const token = tokens[prev];
        if (!token) {
          break;
        }
        const lower = normalizeTokenLower(token);
        if (
          SITE_CONNECTORS.has(lower) ||
          isBodySiteHint(lower, internal.customSiteHints) ||
          ROUTE_DESCRIPTOR_FILLER_WORDS.has(lower)
        ) {
          indicesToInclude.add(token.index);
          prev -= 1;
          continue;
        }
        break;
      }
      let next = idx + 1;
      while (next < tokens.length) {
        const token = tokens[next];
        if (!token) {
          break;
        }
        const lower = normalizeTokenLower(token);
        if (
          SITE_CONNECTORS.has(lower) ||
          isBodySiteHint(lower, internal.customSiteHints) ||
          ROUTE_DESCRIPTOR_FILLER_WORDS.has(lower)
        ) {
          indicesToInclude.add(token.index);
          next += 1;
          continue;
        }
        break;
      }
    }
    const sortedIndices = Array.from(indicesToInclude).sort((a, b) => a - b);
    const displayWords: string[] = [];
    for (const index of sortedIndices) {
      const token = tokens[index];
      if (!token) {
        continue;
      }
      const lower = normalizeTokenLower(token);
      const trimmed = token.original.trim();
      const isBraceToken = trimmed.length > 0 && /^[{}]+$/.test(trimmed);
      if (!isBraceToken && !SITE_CONNECTORS.has(lower) && !SITE_FILLER_WORDS.has(lower)) {
        displayWords.push(token.original);
      }
      mark(internal.consumed, token);
    }
    const normalizedSite = displayWords
      .filter((word) => !SITE_CONNECTORS.has(word.trim().toLowerCase()))
      .join(" ")
      .trim();
    if (normalizedSite) {
      const tokenRange = computeTokenRange(internal.input, tokens, sortedIndices);
      let sanitized = normalizedSite;
      let isProbe = false;
      const probeMatch = sanitized.match(/^\{(.+)}$/);
      if (probeMatch) {
        // `{site}` placeholders flag interactive lookups so consumers can prompt
        // for a coded selection even when the parser cannot resolve the entry.
        isProbe = true;
        sanitized = probeMatch[1];
      }
      // Remove stray braces and normalize whitespace so lookups and downstream
      // displays operate on a clean phrase.
      sanitized = sanitized.replace(/[{}]/g, " ").replace(/\s+/g, " ").trim();
      const range = refineSiteRange(internal.input, sanitized, tokenRange);
      const sourceText = range ? internal.input.slice(range.start, range.end) : undefined;
      const displayText = normalizeSiteDisplayText(sanitized, options?.siteCodeMap);
      const displayLower = displayText.toLowerCase();
      const canonical = displayText ? normalizeBodySiteKey(displayText) : "";
      internal.siteLookupRequest = {
        originalText: normalizedSite,
        text: displayText,
        normalized: displayLower,
        canonical,
        isProbe,
        inputText: internal.input,
        sourceText,
        range
      };
      if (displayText) {
        const normalizedLower = sanitized.toLowerCase();
        const strippedDescriptor = normalizeRouteDescriptorPhrase(normalizedLower);
        const siteWords = displayLower.split(/\s+/).filter((word) => word.length > 0);
        const hasNonSiteWords = siteWords.some(
          (word) => !isBodySiteHint(word, internal.customSiteHints)
        );
        const shouldAttemptRouteDescriptor =
          strippedDescriptor !== normalizedLower || hasNonSiteWords || strippedDescriptor === "mouth";
        const appliedRouteDescriptor =
          shouldAttemptRouteDescriptor && maybeApplyRouteDescriptor(sanitized);
        if (!appliedRouteDescriptor) {
          // Preserve the clean site text for FHIR output and resolver context
          // whenever we keep the original phrase.
          internal.siteText = displayText;
          if (!internal.siteSource) {
            internal.siteSource = "text";
          }
        }
      }
    }
  }

  if (!internal.routeCode && internal.siteText) {
    for (const { pattern, route } of SITE_UNIT_ROUTE_HINTS) {
      if (pattern.test(internal.siteText)) {
        setRoute(internal, route);
        break;
      }
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

/**
 * Resolves parsed site text against SNOMED dictionaries and synchronous
 * callbacks, applying the best match to the in-progress parse result.
 */
export function applyPrnReasonCoding(
  internal: ParsedSigInternal,
  options?: ParseOptions
): void {
  runPrnReasonResolutionSync(internal, options);
}

export async function applyPrnReasonCodingAsync(
  internal: ParsedSigInternal,
  options?: ParseOptions
): Promise<void> {
  await runPrnReasonResolutionAsync(internal, options);
}

export function applySiteCoding(
  internal: ParsedSigInternal,
  options?: ParseOptions
): void {
  runSiteCodingResolutionSync(internal, options);
}

/**
 * Asynchronous counterpart to {@link applySiteCoding} that awaits resolver and
 * suggestion callbacks so remote terminology services can be used.
 */
export async function applySiteCodingAsync(
  internal: ParsedSigInternal,
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
  internal: ParsedSigInternal,
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
  internal: ParsedSigInternal,
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
function applySiteDefinition(internal: ParsedSigInternal, definition: BodySiteDefinition) {
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

function findAdditionalInstructionDefinition(
  text: string,
  canonical: string
): AdditionalInstructionDefinition | undefined {
  if (!canonical) {
    return undefined;
  }
  for (const entry of DEFAULT_ADDITIONAL_INSTRUCTION_ENTRIES) {
    if (!entry.canonical) {
      continue;
    }
    if (entry.canonical === canonical) {
      return entry.definition;
    }
    if (canonical.includes(entry.canonical) || entry.canonical.includes(canonical)) {
      return entry.definition;
    }
    for (const term of entry.terms) {
      const normalizedTerm = normalizeAdditionalInstructionKey(term);
      if (!normalizedTerm) {
        continue;
      }
      if (canonical.includes(normalizedTerm) || normalizedTerm.includes(canonical)) {
        return entry.definition;
      }
    }
  }
  return undefined;
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

function collectAdditionalInstructions(
  internal: ParsedSigInternal,
  tokens: Token[]
): void {
  if (internal.additionalInstructions.length) {
    return;
  }
  const punctuationOnly = /^[;:.,-]+$/;
  const trailing: Token[] = [];
  let expectedIndex: number | undefined;
  for (let cursor = tokens.length - 1; cursor >= 0; cursor--) {
    const token = tokens[cursor];
    if (!token) {
      continue;
    }
    if (internal.consumed.has(token.index)) {
      if (trailing.length > 0) {
        break;
      }
      continue;
    }
    if (expectedIndex !== undefined && token.index !== expectedIndex - 1) {
      break;
    }
    trailing.unshift(token);
    expectedIndex = token.index;
  }
  if (!trailing.length) {
    return;
  }
  const contentTokens = trailing.filter((token) => !punctuationOnly.test(token.original));
  if (!contentTokens.length) {
    return;
  }
  const trailingIndices = trailing.map((token) => token.index).sort((a, b) => a - b);
  const lastIndex = trailingIndices[trailingIndices.length - 1];
  for (let i = lastIndex + 1; i < tokens.length; i++) {
    const nextToken = tokens[i];
    if (!nextToken) {
      continue;
    }
    if (!internal.consumed.has(nextToken.index)) {
      return;
    }
  }
  const joined = contentTokens
    .map((token) => token.original)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!joined) {
    return;
  }
  const contentIndices = contentTokens.map((token) => token.index).sort((a, b) => a - b);
  const lowerInput = internal.input.toLowerCase();
  let trailingRange: TextRange | undefined;
  let searchEnd = lowerInput.length;
  let rangeStart: number | undefined;
  let rangeEnd: number | undefined;
  for (let i = contentTokens.length - 1; i >= 0; i--) {
    const fragment = contentTokens[i].original.trim();
    if (!fragment) {
      continue;
    }
    const lowerFragment = fragment.toLowerCase();
    const foundIndex = lowerInput.lastIndexOf(lowerFragment, searchEnd - 1);
    if (foundIndex === -1) {
      rangeStart = undefined;
      rangeEnd = undefined;
      break;
    }
    rangeStart = foundIndex;
    if (rangeEnd === undefined) {
      rangeEnd = foundIndex + lowerFragment.length;
    }
    searchEnd = foundIndex;
  }
  if (rangeStart !== undefined && rangeEnd !== undefined) {
    trailingRange = { start: rangeStart, end: rangeEnd };
  }
  const range = trailingRange ?? computeTokenRange(internal.input, tokens, contentIndices);
  let separatorDetected = false;
  if (range) {
    for (let cursor = range.start - 1; cursor >= 0; cursor--) {
      const ch = internal.input[cursor];
      if (ch === "\n" || ch === "\r") {
        separatorDetected = true;
        break;
      }
      if (/\s/.test(ch)) {
        continue;
      }
      if (/-|;|:|\.|,/.test(ch)) {
        separatorDetected = true;
      }
      break;
    }
  }
  const sourceText = range
    ? internal.input.slice(range.start, range.end)
    : joined;
  if (!separatorDetected && !/[-;:.]/.test(sourceText)) {
    return;
  }
  const normalized = sourceText
    .replace(/\s*[-:]+\s*/g, "; ")
    .replace(/\s*(?:\r?\n)+\s*/g, "; ")
    .replace(/\s+/g, " ");
  const segments = normalized
    .split(/(?:;|\.)/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const phrases = segments.length ? segments : [joined];
  const seen = new Set<string>();
  const instructions: Array<{ text?: string; coding?: FhirCoding }> = [];
  for (const phrase of phrases) {
    const canonical = normalizeAdditionalInstructionKey(phrase);
    const definition =
      DEFAULT_ADDITIONAL_INSTRUCTION_DEFINITIONS[canonical] ??
      findAdditionalInstructionDefinition(phrase, canonical);
    const key = definition?.coding?.code
      ? `code:${definition.coding.system ?? SNOMED_SYSTEM}|${definition.coding.code}`
      : canonical
      ? `text:${canonical}`
      : phrase.toLowerCase();
    if (key && seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (definition) {
      instructions.push({
        text: definition.text ?? phrase,
        coding: definition.coding?.code
          ? {
              code: definition.coding.code,
              display: definition.coding.display,
              system: definition.coding.system ?? SNOMED_SYSTEM
            }
          : undefined
      });
    } else {
      instructions.push({ text: phrase });
    }
  }
  if (instructions.length) {
    internal.additionalInstructions = instructions;
    for (const token of trailing) {
      mark(internal.consumed, token);
    }
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
  internal: ParsedSigInternal,
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
  internal: ParsedSigInternal,
  definition: PrnReasonDefinition
) {
  const coding = definition.coding;
  internal.asNeededReasonCoding = coding?.code
    ? {
        code: coding.code,
        display: coding.display,
        system: coding.system ?? SNOMED_SYSTEM
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
  internal: ParsedSigInternal,
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
  internal: ParsedSigInternal,
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

function inferUnitFromRouteHints(internal: ParsedSigInternal): string | undefined {
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
  for (const { pattern, route } of SITE_UNIT_ROUTE_HINTS) {
    if (pattern.test(siteText)) {
      const unit = DEFAULT_UNIT_BY_ROUTE[route];
      if (unit) {
        return unit;
      }
    }
  }
  return undefined;
}
