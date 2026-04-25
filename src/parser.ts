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
  PRODUCT_FORM_HINTS,
  ROUTE_TEXT,
  TIMING_ABBREVIATIONS,
  WORD_FREQUENCIES,
  normalizeBodySiteKey,
  normalizePrnReasonKey
} from "./maps";
import { parseAdditionalInstructions } from "./advice";
import { inferRouteFromContext, inferUnitFromContext, normalizeDosageForm } from "./context";
import {
  buildEventTriggerFromAdviceFrame,
  collectEventTriggersFromAdditionalInstructions
} from "./event-trigger";
import { buildTranslationPrimitiveElement } from "./fhir-translations";
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
  hasPrnMeaning,
  hasTokenWordClass,
  isAdministrationVerbWord,
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
const BLD_TOKENS = new Set(["bld", "b-l-d"]);
const EVERY_INTERVAL_TOKENS = new Set(["q", "every", "each"]);
const COUNT_MARKER_TOKENS = new Set(["x", "*"]);
const AT_PREFIX_TOKENS = new Set(["@", "at"]);
const AM_PM_TOKENS = new Set(["am", "pm"]);
const TIME_LIST_SEPARATORS = new Set([",", "and"]);
const MEAL_ANCHOR_TOKENS = new Set(["pc", "ac"]);
const BEFORE_AFTER_TOKENS = new Set(["before", "after"]);
const GENERIC_ANCHOR_TOKENS = new Set(["on", "with"]);
const GENERIC_CONNECTOR_TOKENS = new Set(["per", "a", "every", "each"]);
const PRN_INTRO_TOKENS = new Set(["for", "if", "when", "upon", "due", "to"]);

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
  "pump",
  "pumps",
  "squeeze",
  "squeezes",
  "applicatorful",
  "applicatorfuls",
  "capful",
  "capfuls",
  "scoop",
  "scoops",
  "application",
  "applications",
  "ribbon",
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

const STANDALONE_OCULAR_SITE_ABBREVIATIONS = new Set(["os", "ou", "re", "le"]);

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

const GENERIC_ITCH_REASON_TERMS = new Set(["itch", "itching", "itchy", "คัน"]);

enum MethodAction {
  Administer = "administer",
  Apply = "apply",
  Insert = "insert",
  Instill = "instill",
  Spray = "spray",
  Swallow = "swallow",
  Wash = "wash"
}

const METHOD_ACTION_BY_VERB: Record<string, MethodAction> = {
  apply: MethodAction.Apply,
  dab: MethodAction.Apply,
  drink: MethodAction.Swallow,
  insert: MethodAction.Insert,
  instill: MethodAction.Instill,
  lather: MethodAction.Wash,
  massage: MethodAction.Apply,
  reapply: MethodAction.Apply,
  rub: MethodAction.Apply,
  shampoo: MethodAction.Wash,
  spray: MethodAction.Spray,
  spread: MethodAction.Apply,
  swallow: MethodAction.Swallow,
  take: MethodAction.Administer,
  use: MethodAction.Administer,
  wash: MethodAction.Wash
};

const METHOD_CODING_BY_ACTION: Record<MethodAction, FhirCoding> = {
  [MethodAction.Administer]: {
    system: SNOMED_SYSTEM,
    code: "738990001",
    display: "Administer"
  },
  [MethodAction.Apply]: {
    system: SNOMED_SYSTEM,
    code: "738991002",
    display: "Apply",
    _display: buildTranslationPrimitiveElement({ th: "ทา" })
  },
  [MethodAction.Insert]: {
    system: SNOMED_SYSTEM,
    code: "738993004",
    display: "Insert",
    _display: buildTranslationPrimitiveElement({ th: "สอด" })
  },
  [MethodAction.Instill]: {
    system: SNOMED_SYSTEM,
    code: "738994005",
    display: "Instill",
    _display: buildTranslationPrimitiveElement({ th: "หยอด" })
  },
  [MethodAction.Spray]: {
    system: SNOMED_SYSTEM,
    code: "738996007",
    display: "Spray",
    _display: buildTranslationPrimitiveElement({ th: "พ่น" })
  },
  [MethodAction.Swallow]: {
    system: SNOMED_SYSTEM,
    code: "738995006",
    display: "Swallow",
    _display: buildTranslationPrimitiveElement({ th: "รับประทาน" })
  },
  [MethodAction.Wash]: {
    system: SNOMED_SYSTEM,
    code: "785900008",
    display: "Rinse or wash",
    _display: buildTranslationPrimitiveElement({ th: "ล้าง" })
  }
};

const PATIENT_INSTRUCTION_CONTEXT_TOKENS = new Set([
  "leave",
  "rinse",
  "washing",
  "wash",
  "showering",
  "shower",
  "bathing",
  "bath",
  "swimming",
  "swim",
  "outdoors",
  "outdoor",
  "outside",
  "cleansing",
  "cleanse"
]);

const WORKFLOW_EVENT_TOKENS = new Set([
  "sun",
  "exposure",
  "swimming",
  "swim",
  "outdoors",
  "outside",
  "dressing",
  "change",
  "changes",
  "bowel",
  "movement",
  "movements",
  "diaper",
  "cleansing",
  "cleanse",
  "showering",
  "shower",
  "bathing",
  "bath"
]);

const RIBBON_LENGTH_UNITS: Record<string, string> = {
  inch: "inch",
  inches: "inch",
  cm: "cm",
  cms: "cm",
  mm: "mm",
  centimeter: "cm",
  centimeters: "cm",
  centimetre: "cm",
  centimetres: "cm",
  millimeter: "mm",
  millimeters: "mm",
  millimetre: "mm",
  millimetres: "mm"
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

function hasStandaloneOcularTailContext(
  tokens: Token[],
  consumed: Set<number>,
  index: number
): boolean {
  let sawTailCue = false;
  let inPrnTail = false;
  for (let i = index + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) {
      continue;
    }
    if (consumed.has(token.index)) {
      if (hasPrnMeaning(token) || normalizeTokenLower(token) === "as") {
        sawTailCue = true;
        inPrnTail = true;
      }
      continue;
    }
    const normalized = normalizeTokenLower(token);
    const previousToken = i > index + 1 ? tokens[i - 1] : undefined;
    const previousNormalized = previousToken ? normalizeTokenLower(previousToken) : "";
    const pairedTiming =
      (previousNormalized && COMBO_EVENT_TIMINGS[`${previousNormalized} ${normalized}`]) ||
      (previousNormalized && EVENT_TIMING_TOKENS[`${previousNormalized} ${normalized}`]);
    if (!normalized || /^[;:.,()/-]+$/.test(normalized)) {
      continue;
    }
    if (inPrnTail) {
      continue;
    }
    if (
      pairedTiming ||
      (previousNormalized &&
        BEFORE_AFTER_TOKENS.has(previousNormalized) &&
        Boolean(MEAL_KEYWORDS[normalized])) ||
      isTimingAnchorOrPrefix(tokens, i) ||
      getTimingAbbreviationMeaning(token) ||
      getEventTimingMeaning(token) ||
      getDayOfWeekMeaning(token) ||
      WORD_FREQUENCIES[normalized] ||
      FREQUENCY_SIMPLE_WORDS[normalized] !== undefined ||
      GENERIC_CONNECTOR_TOKENS.has(normalized) ||
      isMealContextConnectorWord(normalized)
    ) {
      sawTailCue = true;
      continue;
    }
    if (hasPrnMeaning(token) || PRN_INTRO_TOKENS.has(normalized)) {
      sawTailCue = true;
      inPrnTail = true;
      continue;
    }
    return false;
  }
  return sawTailCue;
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
    if (
      normalizedSelf !== "od" &&
      STANDALONE_OCULAR_SITE_ABBREVIATIONS.has(normalizedSelf) &&
      isOphthalmicSiteCandidate(siteCandidate) &&
      index === 0 &&
      hasStandaloneOcularTailContext(tokens, internal.consumed, index)
    ) {
      return true;
    }
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
    if (GENERIC_CONNECTOR_TOKENS.has(normalized)) {
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
      requiresPeriod = normalized === "once";
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
  return AT_PREFIX_TOKENS.has(lower) || extractAttachedAtTimeToken(lower) !== undefined;
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

  if (AT_PREFIX_TOKENS.has(token.lower)) {
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
        AM_PM_TOKENS.has(ampmToken.lower)
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

    if (TIME_LIST_SEPARATORS.has(nextToken.lower) && times.length > 0) {
      const peekToken = tokens[nextIndex + 1];
      if (peekToken && !internal.consumed.has(peekToken.index)) {
        let peekStr = peekToken.lower;
        const ampmToken = tokens[nextIndex + 2];
        if (
          ampmToken &&
          !internal.consumed.has(ampmToken.index) &&
          AM_PM_TOKENS.has(ampmToken.lower)
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
      if (nextNext && !internal.consumed.has(nextNext.index) && AM_PM_TOKENS.has(nextNext.lower)) {
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
      if (separatorToken && TIME_LIST_SEPARATORS.has(separatorToken.lower)) {
        // Peek for next time
        let peekIndex = nextIndex + 1;
        let peekToken = tokens[peekIndex];
        if (peekToken) {
          let peekStr = peekToken.lower;
          let peekNext = tokens[peekIndex + 1];
          if (peekNext && !internal.consumed.has(peekNext.index) && AM_PM_TOKENS.has(peekNext.lower)) {
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

function applyClauseDefaultsAfterTokenScan(
  state: ParserState,
  tokens: Token[],
  context: MedicationContext | undefined,
  options?: ParseOptions
): void {
  if (
    state.unit === undefined &&
    (state.dose !== undefined || state.doseRange !== undefined)
  ) {
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
    const productFormMatch = findAnyProductFormMatch(tokens);
    if (
      fallbackUnit &&
      !suppressRouteFallbackUnitForProductForm(fallbackUnit, productFormMatch)
    ) {
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

function hasDoseValue(state: ParserState): boolean {
  return state.dose !== undefined || state.doseRange !== undefined;
}

function hasScheduleValue(state: ParserState): boolean {
  const timeOfDay = state.timeOfDay;
  return Boolean(
    state.duration !== undefined ||
    state.durationMax !== undefined ||
    state.durationUnit !== undefined ||
    state.frequency !== undefined ||
    state.frequencyMax !== undefined ||
    state.period !== undefined ||
    state.periodMax !== undefined ||
    state.timingCode !== undefined ||
    state.count !== undefined ||
    state.when.length > 0 ||
    state.dayOfWeek.length > 0 ||
    (timeOfDay ? timeOfDay.length > 0 : false)
  );
}

function hasEstablishedAdministrationContent(state: ParserState): boolean {
  return (
    hasDoseValue(state) ||
    state.routeCode !== undefined ||
    state.routeText !== undefined ||
    state.siteText !== undefined ||
    hasScheduleValue(state) ||
    Boolean(state.asNeeded)
  );
}

function cloneMethodCoding(coding: FhirCoding | undefined): FhirCoding | undefined {
  if (!coding?.code) {
    return undefined;
  }
  return {
    system: coding.system,
    code: coding.code,
    display: coding.display,
    _display: coding._display
  };
}

function buildMethodEnglishText(
  verb: string,
  productFormKey: string | undefined
): string | undefined {
  switch (verb) {
    case "apply":
      switch (productFormKey) {
        case "sunscreen":
          return "Apply sunscreen";
        default:
          return "Apply";
      }
    case "dab":
      return "Dab";
    case "drink":
      return "Drink";
    case "insert":
      return "Insert";
    case "instill":
      return "Instill";
    case "lather":
      return "Lather";
    case "massage":
      return "Massage";
    case "reapply":
      switch (productFormKey) {
        case "sunscreen":
          return "Reapply sunscreen";
        default:
          return "Reapply";
      }
    case "rub":
      return "Rub";
    case "shampoo":
      return "Shampoo";
    case "spray":
      return "Spray";
    case "spread":
      return "Apply";
    case "swallow":
      return "Swallow";
    case "take":
      return "Take";
    case "use":
      switch (productFormKey) {
        case "shampoo":
          return "Use shampoo";
        default:
          return "Use";
      }
    case "wash":
      return "Wash";
    default:
      return undefined;
  }
}

function buildMethodThaiText(
  verb: string,
  productFormKey: string | undefined
): string | undefined {
  switch (verb) {
    case "apply":
      switch (productFormKey) {
        case "sunscreen":
          return "ทากันแดด";
        default:
          return "ทา";
      }
    case "drink":
    case "swallow":
    case "take":
      return "รับประทาน";
    case "insert":
      return "สอด";
    case "instill":
      return "หยอด";
    case "reapply":
      switch (productFormKey) {
        case "sunscreen":
          return "ทากันแดดซ้ำ";
        default:
          return "ทาซ้ำ";
      }
    case "shampoo":
      return "สระ";
    case "spray":
      return "พ่น";
    case "use":
      switch (productFormKey) {
        case "shampoo":
          return "สระ";
        default:
          return undefined;
      }
    case "wash":
      return "ล้าง";
    default:
      return undefined;
  }
}

function refreshMethodSurface(state: ParserState): void {
  const verb = state.methodVerb;
  if (!verb) {
    return;
  }

  const methodText = buildMethodEnglishText(verb, state.productFormKey);
  state.methodText = methodText;

  const translatedText = buildMethodThaiText(verb, state.productFormKey);
  state.methodTextElement = translatedText
    ? buildTranslationPrimitiveElement({ th: translatedText })
    : undefined;

  const action = METHOD_ACTION_BY_VERB[verb];
  state.methodCoding = action ? cloneMethodCoding(METHOD_CODING_BY_ACTION[action]) : undefined;
}

function setMethodFromVerbToken(state: ParserState, token: Token): void {
  const normalized = normalizeTokenLower(token);
  if (state.methodVerb) {
    return;
  }
  if (!METHOD_ACTION_BY_VERB[normalized]) {
    return;
  }
  state.methodVerb = normalized;
  refreshMethodSurface(state);
}

function appendPatientInstruction(state: ParserState, text: string | undefined): void {
  const normalized = text?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return;
  }
  if (!state.patientInstruction) {
    state.patientInstruction = normalized;
    return;
  }
  const existingParts = state.patientInstruction
    .split(/\s*;\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (arrayIncludes(existingParts, normalized)) {
    return;
  }
  state.patientInstruction = `${state.patientInstruction}; ${normalized}`;
}

function normalizeWorkflowPatientInstructionText(text: string | undefined): string | undefined {
  const normalized = text?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.toLowerCase().startsWith("and ")) {
    return normalized.slice(4).trim();
  }
  return normalized;
}

function findProductFormMatch(
  tokens: Token[],
  consumed: Set<number>,
  startIndex: number
): { key: string; hint: (typeof PRODUCT_FORM_HINTS)[string]; matchedTokens: Token[] } | undefined {
  const maxSpan = Math.min(3, tokens.length - startIndex);
  for (let span = maxSpan; span >= 1; span -= 1) {
    const matchedTokens: Token[] = [];
    const parts: string[] = [];
    let blocked = false;
    for (let offset = 0; offset < span; offset += 1) {
      const token = tokens[startIndex + offset];
      if (!token || consumed.has(token.index)) {
        blocked = true;
        break;
      }
      matchedTokens.push(token);
      parts.push(normalizeTokenLower(token));
    }
    if (blocked) {
      continue;
    }
    const key = parts.join(" ");
    const hint = PRODUCT_FORM_HINTS[key];
    if (hint) {
      return { key, hint, matchedTokens };
    }
  }
  return undefined;
}

function findAnyProductFormMatch(
  tokens: Token[]
): { key: string; hint: (typeof PRODUCT_FORM_HINTS)[string]; matchedTokens: Token[] } | undefined {
  const consumed = new Set<number>();
  for (let index = 0; index < tokens.length; index += 1) {
    const match = findProductFormMatch(tokens, consumed, index);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function collectProductFormHints(state: ParserState, tokens: Token[]): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const match = findProductFormMatch(tokens, state.consumed, index);
    if (!match) {
      continue;
    }
    for (const token of match.matchedTokens) {
      mark(state.consumed, token);
    }
    if (!state.routeCode && match.hint.routeHint) {
      setRoute(state, match.hint.routeHint);
    }
    if (!state.productFormKey) {
      state.productFormKey = match.key;
    }
    if (state.methodVerb) {
      refreshMethodSurface(state);
    }
    index += match.matchedTokens.length - 1;
  }
}

function suppressRouteFallbackUnitForProductForm(
  fallbackUnit: string | undefined,
  productFormMatch: { key: string; hint: (typeof PRODUCT_FORM_HINTS)[string]; matchedTokens: Token[] } | undefined
): boolean {
  if (!fallbackUnit || !productFormMatch?.hint.routeHint) {
    return false;
  }
  switch (fallbackUnit) {
    case "suppository":
    case "pessary":
    case "patch":
      return true;
    default:
      return false;
  }
}

function isWorkflowConnectorContext(
  tokens: Token[],
  index: number,
  consumed: Set<number>
): boolean {
  const previous = getPreviousActiveToken(tokens, index, consumed);
  const next = getNextActiveToken(tokens, index, consumed);
  if (!previous || !next) {
    return false;
  }
  const previousLower = normalizeTokenLower(previous);
  if (
    previousLower !== "with" &&
    previousLower !== "after" &&
    previousLower !== "before"
  ) {
    return false;
  }
  return (
    WORKFLOW_EVENT_TOKENS.has(normalizeTokenLower(next)) ||
    hasTokenWordClass(next, TokenWordClass.WorkflowInstruction)
  );
}

function hasAdministrationVerbForRoute(
  tokens: Token[],
  routeCode: RouteCode
): boolean {
  for (const token of tokens) {
    if (!hasTokenWordClass(token, TokenWordClass.AdministrationVerb)) {
      continue;
    }
    const routeMeaning = getRouteMeaning(token);
    if (routeMeaning?.code === routeCode) {
      return true;
    }
  }
  return false;
}

function pushParserWarning(state: ParserState, warning: string): void {
  if (!arrayIncludes(state.warnings, warning)) {
    state.warnings.push(warning);
  }
}

function collectCompletenessWarnings(
  state: ParserState,
  tokens: Token[]
): void {
  if (
    !hasDoseValue(state) &&
    (state.routeCode === RouteCode["Oral route"] ||
      hasAdministrationVerbForRoute(tokens, RouteCode["Oral route"])) &&
    (state.asNeeded || state.unit !== undefined)
  ) {
    pushParserWarning(
      state,
      "Incomplete sig: missing dose for oral administration."
    );
  }

  if (
    state.siteText &&
    (state.routeCode === RouteCode["Topical route"] ||
      state.routeCode === RouteCode["Transdermal route"]) &&
    !state.asNeeded &&
    !hasScheduleValue(state)
  ) {
    pushParserWarning(
      state,
      "Incomplete sig: missing timing or PRN qualifier for topical site administration."
    );
  }
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
    const cutoff = determinePrnReasonCutoff(
      reasonObjects,
      sourceText,
      inferAdditionalInstructionPredicate(state, tokens)
    );
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

  if (reasonObjects.length > 0) {
    const leadingScheduleLength = findLeadingPrnSchedulePrefix(state, reasonObjects, options);
    if (leadingScheduleLength !== undefined && leadingScheduleLength > 0) {
      reasonObjects.splice(0, leadingScheduleLength);
      reasonTokens.splice(0, leadingScheduleLength);
      reasonIndices.splice(0, leadingScheduleLength);
      while (reasonTokens.length > 0) {
        const firstToken = reasonTokens[0];
        if (!firstToken || /^[;:.,-]+$/.test(firstToken.trim())) {
          reasonTokens.shift();
          reasonIndices.shift();
          reasonObjects.shift();
          continue;
        }
        const lowerFirstToken = firstToken.trim().toLowerCase();
        if (PRN_INTRO_TOKENS.has(lowerFirstToken)) {
          reasonTokens.shift();
          reasonIndices.shift();
          reasonObjects.shift();
          continue;
        }
        break;
      }
    }
  }

  if (reasonObjects.length > 0) {
    let trailingScheduleStart = findTrailingPrnScheduleSuffix(state, reasonObjects, options);
    if (trailingScheduleStart === undefined && reasonObjects.length > 1) {
      const trailingToken = reasonObjects[reasonObjects.length - 1];
      const trailingLower = normalizeTokenLower(trailingToken);
      if (trailingLower !== "sleep") {
        const trailingTimingAbbreviation = getTimingAbbreviationMeaning(trailingToken);
        if (trailingTimingAbbreviation && trailingLower !== "od") {
          applyFrequencyDescriptor(state, trailingToken, trailingTimingAbbreviation, options);
          trailingScheduleStart = reasonObjects.length - 1;
        } else {
          const trailingEventTiming = getEventTimingMeaning(trailingToken);
          if (trailingEventTiming) {
            applyWhenToken(state, trailingToken, trailingEventTiming);
            trailingScheduleStart = reasonObjects.length - 1;
          } else {
            const trailingWordFrequency = WORD_FREQUENCIES[trailingLower];
            if (trailingWordFrequency) {
              state.frequency = trailingWordFrequency.frequency;
              state.period = 1;
              state.periodUnit = trailingWordFrequency.periodUnit;
              mark(state.consumed, trailingToken);
              trailingScheduleStart = reasonObjects.length - 1;
            }
          }
        }
      }
    }
    if (trailingScheduleStart !== undefined) {
      reasonObjects.splice(trailingScheduleStart);
      reasonTokens.splice(trailingScheduleStart);
      reasonIndices.splice(trailingScheduleStart);
      while (reasonTokens.length > 0) {
        const lastToken = reasonTokens[reasonTokens.length - 1];
        if (!lastToken || /^[;:.,-]+$/.test(lastToken.trim())) {
          reasonTokens.pop();
          reasonIndices.pop();
          reasonObjects.pop();
          continue;
        }
        break;
      }
    }
  }

  if (reasonObjects.length > 0) {
    const durationSuffixStart = findTrailingPrnDurationSuffix(state, reasonObjects);
    if (durationSuffixStart !== undefined) {
      reasonObjects.splice(durationSuffixStart);
      reasonTokens.splice(durationSuffixStart);
      reasonIndices.splice(durationSuffixStart);
      while (reasonTokens.length > 0) {
        const lastToken = reasonTokens[reasonTokens.length - 1];
        if (!lastToken || /^[;:.,-]+$/.test(lastToken.trim())) {
          reasonTokens.pop();
          reasonIndices.pop();
          reasonObjects.pop();
          continue;
        }
        break;
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

function findTrailingPrnDurationSuffix(
  state: ParserState,
  tokens: Token[]
): number | undefined {
  if (
    state.duration !== undefined ||
    state.durationMax !== undefined ||
    state.durationUnit !== undefined ||
    tokens.length < 3
  ) {
    return undefined;
  }
  const unitIndex = tokens.length - 1;
  const unitToken = tokens[unitIndex];
  const unitCode = unitToken ? mapIntervalUnit(unitToken.lower) : undefined;
  if (!unitCode) {
    return undefined;
  }
  let numericIndex = unitIndex - 1;
  while (numericIndex >= 0 && COUNT_CONNECTOR_WORDS.has(tokens[numericIndex].lower)) {
    numericIndex -= 1;
  }
  if (numericIndex < 1) {
    return undefined;
  }
  const numericToken = tokens[numericIndex];
  const range = parseNumericRange(numericToken.lower);
  let low: number | undefined;
  let high: number | undefined;
  if (range) {
    low = range.low;
    high = range.high;
  } else if (/^[0-9]+(?:\.[0-9]+)?$/.test(numericToken.lower)) {
    low = parseFloat(numericToken.original);
  } else {
    return undefined;
  }
  let forIndex = numericIndex - 1;
  while (forIndex >= 0 && COUNT_CONNECTOR_WORDS.has(tokens[forIndex].lower)) {
    forIndex -= 1;
  }
  if (forIndex <= 0 || tokens[forIndex].lower !== "for") {
    return undefined;
  }
  if (!applyDurationLimit(state, low, unitCode, high)) {
    return undefined;
  }
  return forIndex;
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
      clause.schedule.duration === undefined &&
      clause.schedule.durationMax === undefined &&
      clause.schedule.durationUnit === undefined &&
      clause.schedule.frequency === undefined &&
      clause.schedule.frequencyMax === undefined &&
      clause.schedule.period === undefined &&
      clause.schedule.periodMax === undefined &&
      clause.schedule.periodUnit === undefined &&
      !clause.schedule.dayOfWeek &&
      !clause.schedule.when &&
      !clause.schedule.timeOfDay &&
      !clause.schedule.eventTriggers?.length
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
    if (clause.prn.reasons?.length === 0) {
      delete clause.prn.reasons;
    }
    if (!clause.prn.enabled && !clause.prn.reason && !clause.prn.reasons) {
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
    const eventTriggers = collectEventTriggersFromAdditionalInstructions(clause.additionalInstructions);
    if (eventTriggers?.length) {
      clause.schedule = clause.schedule ?? {};
      clause.schedule.eventTriggers = eventTriggers;
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
    WORD_FREQUENCIES[lower] ||
    FREQUENCY_SIMPLE_WORDS[lower] !== undefined
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
    isInstructionLikeText: (text: string) => {
      const parsed = parseAdditionalInstructions(
        text,
        { start: 0, end: text.length },
        {
          defaultPredicate: inferAdditionalInstructionPredicate(internal, tokens)
        }
      );
      for (const instruction of parsed) {
        if (instruction.frames.length || instruction.coding?.code) {
          return true;
        }
      }
      return false;
    },
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
    MEAL_ANCHOR_TOKENS.has(lower) ||
    BEFORE_AFTER_TOKENS.has(lower) ||
    isAtPrefixToken(lower) ||
    GENERIC_ANCHOR_TOKENS.has(lower) ||
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
  switch (token) {
    case "min":
    case "mins":
    case "minute":
    case "minutes":
    case "m":
      return FhirPeriodUnit.Minute;
    case "h":
    case "hr":
    case "hrs":
    case "hour":
    case "hours":
      return FhirPeriodUnit.Hour;
    case "d":
    case "day":
    case "days":
      return FhirPeriodUnit.Day;
    case "wk":
    case "w":
    case "week":
    case "weeks":
      return FhirPeriodUnit.Week;
    case "mo":
    case "month":
    case "months":
      return FhirPeriodUnit.Month;
    default:
      return undefined;
  }
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

function applyDurationLimit(
  internal: ParserState,
  value: number | undefined,
  unit: FhirPeriodUnit | undefined,
  max?: number
): boolean {
  if (value === undefined || !Number.isFinite(value) || value <= 0 || !unit) {
    return false;
  }
  if (internal.duration !== undefined || internal.durationUnit !== undefined) {
    return false;
  }
  internal.duration = value;
  internal.durationMax =
    max !== undefined && Number.isFinite(max) && max > value ? max : undefined;
  internal.durationUnit = unit;
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
  const nextToken = tokens[index + 1];
  const nextNormalized =
    nextToken && !consumed.has(nextToken.index)
      ? normalizeTokenLower(nextToken)
      : undefined;
  const ribbonLengthUnit = RIBBON_LENGTH_UNITS[normalized];
  if (ribbonLengthUnit && (nextNormalized === "ribbon" || nextNormalized === "ribbons")) {
    return { unit: `${ribbonLengthUnit} ribbon`, consumedIndices: [index, index + 1] };
  }
  const direct = normalizeUnit(normalized, options);
  if (direct) {
    if (direct === "ribbon") {
      const previousToken = tokens[index - 1];
      if (!previousToken || consumed.has(previousToken.index)) {
        return { unit: direct, consumedIndices: [index] };
      }
      const previousNormalized = normalizeTokenLower(previousToken);
      const previousRibbonUnit = RIBBON_LENGTH_UNITS[previousNormalized];
      if (previousRibbonUnit) {
        return { unit: `${previousRibbonUnit} ribbon`, consumedIndices: [index - 1, index] };
      }
    }
    return { unit: direct, consumedIndices: [index] };
  }
  if (normalized === "fingertip") {
    const nextToken = tokens[index + 1];
    if (!nextToken || consumed.has(nextToken.index)) {
      return undefined;
    }
    const nextNormalized = normalizeTokenLower(nextToken);
    if (nextNormalized === "unit" || nextNormalized === "units") {
      return { unit: "fingertip unit", consumedIndices: [index, index + 1] };
    }
  }
  if (normalized === "finger") {
    const nextToken = tokens[index + 1];
    if (!nextToken || consumed.has(nextToken.index)) {
      return undefined;
    }
    const nextNormalized = normalizeTokenLower(nextToken);
    if (nextNormalized === "length" || nextNormalized === "lengths") {
      return { unit: "finger length", consumedIndices: [index, index + 1] };
    }
  }
  if (normalized === "international") {
    if (!nextToken || consumed.has(nextToken.index)) {
      return undefined;
    }
    switch (nextNormalized) {
      case "unit":
      case "units":
      case "u":
      case "iu":
      case "ius":
        return { unit: "IU", consumedIndices: [index, index + 1] };
      default:
        break;
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

interface ClauseParseContext {
  state: ParserState;
  tokens: Token[];
  options?: ParseOptions;
  medicationContext?: MedicationContext;
  prnReasonStart?: number;
  prnSiteSuffixIndices: Set<number>;
  customRouteMap?: Map<string, RouteCode>;
  customRouteDescriptorMap?: Map<string, RouteCode>;
}

interface TokenSemanticContext {
  siteCandidate: ReturnType<typeof getPrimarySiteMeaningCandidate>;
  treatSiteCandidateAsSite: boolean;
  timingAbbreviation: ReturnType<typeof getTimingAbbreviationMeaning>;
}

type TerminalMatcher = (
  context: ClauseParseContext,
  index: number,
  token: Token
) => boolean;

type GrammarProduction = (
  context: ClauseParseContext,
  index: number,
  token: Token
) => number | undefined;

function buildCustomRouteMap(
  routeMap: ParseOptions["routeMap"] | undefined
): Map<string, RouteCode> | undefined {
  if (!routeMap) {
    return undefined;
  }
  const entries = new Map<string, RouteCode>();
  for (const [key, value] of objectEntries(routeMap)) {
    const normalized = key.toLowerCase();
    if (normalized) {
      entries.set(normalized, value);
    }
  }
  return entries.size ? entries : undefined;
}

function buildCustomRouteDescriptorMap(
  routeMap: Map<string, RouteCode> | undefined
): Map<string, RouteCode> | undefined {
  if (!routeMap) {
    return undefined;
  }
  const entries = new Map<string, RouteCode>();
  for (const [key, value] of routeMap.entries()) {
    const normalized = normalizeRouteDescriptorPhrase(key);
    if (normalized) {
      entries.set(normalized, value);
    }
  }
  return entries.size ? entries : undefined;
}

function createClauseParseContext(
  state: ParserState,
  tokens: Token[],
  options?: ParseOptions
): ClauseParseContext {
  const customRouteMap = buildCustomRouteMap(options?.routeMap);
  return {
    state,
    tokens,
    options,
    medicationContext: options?.context ?? undefined,
    prnSiteSuffixIndices: new Set<number>(),
    customRouteMap,
    customRouteDescriptorMap: buildCustomRouteDescriptorMap(customRouteMap)
  };
}

function tryApplyRouteDescriptor(
  state: ParserState,
  code: RouteCode,
  text?: string
): boolean {
  if (state.routeCode && state.routeCode !== code) {
    return false;
  }
  setRoute(state, code, text);
  return true;
}

function maybeApplyRouteDescriptorFromPhrase(
  context: ClauseParseContext,
  phrase: string | undefined
): boolean {
  if (!phrase) {
    return false;
  }
  const normalized = phrase.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const customCode = context.customRouteMap?.get(normalized);
  if (customCode) {
    if (tryApplyRouteDescriptor(context.state, customCode)) {
      return true;
    }
  }
  const synonym = DEFAULT_ROUTE_SYNONYMS[normalized];
  if (synonym) {
    if (tryApplyRouteDescriptor(context.state, synonym.code, synonym.text)) {
      return true;
    }
  }
  const normalizedDescriptor = normalizeRouteDescriptorPhrase(normalized);
  if (!normalizedDescriptor) {
    return false;
  }
  const customDescriptorCode = context.customRouteDescriptorMap?.get(normalizedDescriptor);
  if (customDescriptorCode) {
    if (tryApplyRouteDescriptor(context.state, customDescriptorCode)) {
      return true;
    }
  }
  const fallbackSynonym = DEFAULT_ROUTE_DESCRIPTOR_SYNONYMS.get(normalizedDescriptor);
  if (!fallbackSynonym) {
    return false;
  }
  return tryApplyRouteDescriptor(
    context.state,
    fallbackSynonym.code,
    fallbackSynonym.text
  );
}

function buildTokenSemanticContext(
  context: ClauseParseContext,
  index: number,
  token: Token
): TokenSemanticContext {
  const siteCandidate = getPrimarySiteMeaningCandidate(token);
  const treatSiteCandidateAsSite = siteCandidate
    ? shouldTreatAbbreviatedSiteCandidateAsSite(
      context.state,
      context.tokens,
      index,
      context.medicationContext
    )
    : false;
  return {
    siteCandidate,
    treatSiteCandidateAsSite,
    timingAbbreviation: getTimingAbbreviationMeaning(token)
  };
}

function buildEvidenceFromTokenWindow(
  state: ParserState,
  startIndex: number,
  endIndex: number
): CanonicalSigClause["evidence"][number]["spans"] {
  const indices: number[] = [];
  for (let index = startIndex; index <= endIndex; index++) {
    indices.push(index);
  }
  const range = computeTokenRange(state.input, state.tokens, indices);
  if (!range) {
    return [];
  }
  return [buildCanonicalSourceSpan(state.input, range, indices)];
}

function recordClauseEvidence(
  state: ParserState,
  rule: string,
  startIndex: number,
  endIndex: number
): void {
  const spans = buildEvidenceFromTokenWindow(state, startIndex, endIndex);
  if (!spans.length) {
    return;
  }
  state.primaryClause.evidence.push({ rule, spans });
}

function applyGrammarTerminal(
  context: ClauseParseContext,
  index: number,
  token: Token,
  rule: string,
  matcher: TerminalMatcher
): number | undefined {
  const beforeConsumed = new Set<number>();
  for (const consumedIndex of context.state.consumed) {
    beforeConsumed.add(consumedIndex);
  }
  if (!matcher(context, index, token)) {
    return undefined;
  }
  let endIndex = index;
  for (const consumedIndex of context.state.consumed) {
    if (!beforeConsumed.has(consumedIndex) && consumedIndex > endIndex) {
      endIndex = consumedIndex;
    }
  }
  recordClauseEvidence(context.state, rule, index, endIndex);
  return endIndex + 1;
}

function tryCollectRouteSynonym(
  context: ClauseParseContext,
  startIndex: number
): boolean {
  if (context.prnReasonStart !== undefined && startIndex >= context.prnReasonStart) {
    return false;
  }
  const state = context.state;
  const tokens = context.tokens;
  const maxSpan = Math.min(24, tokens.length - startIndex);
  for (let span = maxSpan; span >= 1; span--) {
    const slice: Token[] = [];
    const phraseParts: string[] = [];
    let blocked = false;
    for (let offset = 0; offset < span; offset++) {
      const part = tokens[startIndex + offset];
      if (!part) {
        blocked = true;
        break;
      }
      if (state.consumed.has(part.index)) {
        blocked = true;
        break;
      }
      slice.push(part);
      if (!/^[;:(),]+$/.test(part.lower)) {
        phraseParts.push(part.lower);
      }
    }
    if (blocked) {
      continue;
    }
    const phrase = phraseParts.join(" ");
    const customCode = context.customRouteMap?.get(phrase);
    const annotatedRoute = span === 1 ? getRouteMeaning(slice[0]) : undefined;
    const synonym = customCode
      ? { code: customCode, text: ROUTE_TEXT[customCode] }
      : annotatedRoute ?? DEFAULT_ROUTE_SYNONYMS[phrase];
    if (!synonym) {
      continue;
    }
    if (phrase === "top" && slice.length === 1) {
      const nextToken = tokens[startIndex + 1];
      if (nextToken && normalizeTokenLower(nextToken) === "of") {
        continue;
      }
    }
    if (phrase === "in" && slice.length === 1) {
      if (state.routeCode) {
        continue;
      }
      const prevToken = tokens[startIndex - 1];
      if (prevToken && !state.consumed.has(prevToken.index)) {
        continue;
      }
    }
    setRoute(state, synonym.code, synonym.text);
    for (const part of slice) {
      mark(state.consumed, part);
      if (isBodySiteHint(part.lower, state.customSiteHints)) {
        state.siteTokenIndices.add(part.index);
      }
    }
    return true;
  }
  return false;
}

function skipCountConnectors(
  tokens: Token[],
  consumed: Set<number>,
  startIndex: number,
  bucket: Token[]
): number {
  let cursor = startIndex;
  while (cursor < tokens.length) {
    const candidate = tokens[cursor];
    if (!candidate) {
      break;
    }
    if (consumed.has(candidate.index)) {
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
}

function hasCadenceContinuationAfter(
  tokens: Token[],
  consumed: Set<number>,
  startIndex: number
): boolean {
  let cursor = startIndex + 1;
  let connectorPending = false;
  while (cursor < tokens.length) {
    const candidate = tokens[cursor];
    cursor += 1;
    if (!candidate || consumed.has(candidate.index)) {
      continue;
    }
    const lower = normalizeTokenLower(candidate);
    if (!lower || /^[;:.,()/-]+$/.test(lower)) {
      continue;
    }
    if (connectorPending) {
      return Boolean(mapFrequencyAdverb(lower) || mapIntervalUnit(lower));
    }
    if (
      EVERY_INTERVAL_TOKENS.has(lower) ||
      mapFrequencyAdverb(lower) ||
      mapIntervalUnit(lower) ||
      getDayOfWeekMeaning(candidate) ||
      TIMING_ABBREVIATIONS[lower] ||
      WORD_FREQUENCIES[lower]
    ) {
      return true;
    }
    if (FREQUENCY_CONNECTOR_WORDS.has(lower)) {
      connectorPending = true;
      continue;
    }
    return false;
  }
  return false;
}

function collectBldMealTiming(
  context: ClauseParseContext,
  _index: number,
  token: Token
): boolean {
  if (!BLD_TOKENS.has(token.lower)) {
    return false;
  }
  const check = checkDiscouraged(token.original, context.options);
  if (check.warning) {
    context.state.warnings.push(check.warning);
  }
  applyWhenToken(context.state, token, EventTiming.Meal);
  return true;
}

function collectSeparatedInterval(
  context: ClauseParseContext,
  index: number,
  token: Token
): boolean {
  if (!EVERY_INTERVAL_TOKENS.has(token.lower)) {
    return false;
  }
  return parseSeparatedInterval(context.state, context.tokens, index, context.options);
}

function collectTimeBasedSchedule(
  context: ClauseParseContext,
  index: number
): boolean {
  return tryParseTimeBasedSchedule(context.state, context.tokens, index);
}

function collectNumericCadence(
  context: ClauseParseContext,
  index: number
): boolean {
  return tryParseNumericCadence(context.state, context.tokens, index);
}

function hasImmediateDoseSyntaxBefore(
  context: ClauseParseContext,
  index: number
): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const candidate = context.tokens[cursor];
    if (!candidate) {
      continue;
    }
    const lower = normalizeTokenLower(candidate);
    if (!lower || /^[;:(),]+$/.test(lower)) {
      continue;
    }
    if (
      isNumericToken(lower) ||
      parseNumericRange(lower) !== undefined ||
      normalizeUnit(lower, context.options) !== undefined ||
      /^[0-9]+(?:\.[0-9]+)?[x*]$/.test(lower)
    ) {
      return true;
    }
    return false;
  }
  return false;
}

function collectMultiplicativeCadenceTerm(
  context: ClauseParseContext,
  index: number,
  token: Token
): boolean {
  const combined = token.lower.match(/^([0-9]+(?:\.[0-9]+)?)[x*]([0-9]+(?:\.[0-9]+)?)$/);
  if (combined) {
    const dose = parseFloat(combined[1]);
    const frequency = parseFloat(combined[2]);
    if (!Number.isFinite(dose) || !Number.isFinite(frequency)) {
      return false;
    }
    if (context.state.dose === undefined) {
      context.state.dose = dose;
    }
    context.state.frequency = frequency;
    context.state.period = 1;
    context.state.periodUnit = FhirPeriodUnit.Day;
    mark(context.state.consumed, token);
    return true;
  }

  if (
    context.state.frequency !== undefined ||
    context.state.frequencyMax !== undefined ||
    context.state.period !== undefined ||
    context.state.periodMax !== undefined ||
    context.state.dose === undefined
  ) {
    return false;
  }
  if (!hasImmediateDoseSyntaxBefore(context, index)) {
    return false;
  }

  const prefix = token.lower.match(/^[x*]([0-9]+(?:\.[0-9]+)?)$/);
  if (prefix) {
    const frequency = parseFloat(prefix[1]);
    if (!Number.isFinite(frequency)) {
      return false;
    }
    context.state.frequency = frequency;
    context.state.period = 1;
    context.state.periodUnit = FhirPeriodUnit.Day;
    mark(context.state.consumed, token);
    return true;
  }

  if (!COUNT_MARKER_TOKENS.has(token.lower)) {
    return false;
  }
  const next = context.tokens[index + 1];
  if (
    !next ||
    context.state.consumed.has(next.index) ||
    !/^[0-9]+(?:\.[0-9]+)?$/.test(next.lower)
  ) {
    return false;
  }
  const frequency = parseFloat(next.original);
  if (!Number.isFinite(frequency)) {
    return false;
  }
  context.state.frequency = frequency;
  context.state.period = 1;
  context.state.periodUnit = FhirPeriodUnit.Day;
  mark(context.state.consumed, token);
  mark(context.state.consumed, next);
  return true;
}

function collectOdTimingAbbreviation(
  context: ClauseParseContext,
  index: number,
  token: Token
): boolean {
  const normalizedLower = normalizeTokenLower(token);
  if (normalizedLower !== "od") {
    return false;
  }
  const semantics = buildTokenSemanticContext(context, index, token);
  if (
    !semantics.timingAbbreviation ||
    !shouldInterpretOdAsOnceDaily(
      context.state,
      context.tokens,
      index,
      semantics.treatSiteCandidateAsSite
    )
  ) {
    return false;
  }
  applyFrequencyDescriptor(
    context.state,
    token,
    semantics.timingAbbreviation,
    context.options
  );
  return true;
}

function collectTimingAbbreviation(
  context: ClauseParseContext,
  index: number,
  token: Token
): boolean {
  const normalizedLower = normalizeTokenLower(token);
  if (normalizedLower === "od") {
    return false;
  }
  const semantics = buildTokenSemanticContext(context, index, token);
  if (!semantics.timingAbbreviation) {
    return false;
  }
  applyFrequencyDescriptor(
    context.state,
    token,
    semantics.timingAbbreviation,
    context.options
  );
  return true;
}

function collectCompactInterval(
  context: ClauseParseContext,
  index: number
): boolean {
  return tryParseCompactQ(context.state, context.tokens, index);
}

function collectTimingConnector(
  context: ClauseParseContext,
  index: number,
  token: Token
): boolean {
  if (
    !(isMealContextConnectorWord(token.lower) || token.lower === ",") ||
    !isTimingAnchorOrPrefix(context.tokens, index + 1, context.prnReasonStart)
  ) {
    return false;
  }
  mark(context.state.consumed, token);
  return true;
}

function collectComboEventTiming(
  context: ClauseParseContext,
  index: number,
  token: Token
): boolean {
  const nextToken = context.tokens[index + 1];
  if (!nextToken || context.state.consumed.has(nextToken.index)) {
    return false;
  }
  const combo = `${token.lower} ${nextToken.lower}`;
  const comboWhen = COMBO_EVENT_TIMINGS[combo] ?? EVENT_TIMING_TOKENS[combo];
  if (!comboWhen) {
    return false;
  }
  applyWhenToken(context.state, token, comboWhen);
  mark(context.state.consumed, nextToken);
  return true;
}

function collectPcAcAnchor(
  context: ClauseParseContext,
  index: number,
  token: Token
): boolean {
  if (!MEAL_ANCHOR_TOKENS.has(token.lower)) {
    return false;
  }
  return parseAnchorSequence(
    context.state,
    context.tokens,
    index,
    token.lower === "pc"
      ? EventTiming["After Meal"]
      : EventTiming["Before Meal"]
  );
}

function collectBeforeAfterAnchor(
  context: ClauseParseContext,
  index: number,
  token: Token
): boolean {
  if (!BEFORE_AFTER_TOKENS.has(token.lower)) {
    return false;
  }
  if (!isLikelyMealAnchorUsage(context.tokens, index, context.state.consumed)) {
    return false;
  }
  return parseAnchorSequence(
    context.state,
    context.tokens,
    index,
    token.lower === "after"
      ? EventTiming["After Meal"]
      : EventTiming["Before Meal"]
  );
}

function collectGenericAnchor(
  context: ClauseParseContext,
  index: number,
  token: Token
): boolean {
  if (
    !isAtPrefixToken(token.lower) &&
    !GENERIC_ANCHOR_TOKENS.has(token.lower)
  ) {
    return false;
  }
  if (tryParseTimeBasedSchedule(context.state, context.tokens, index)) {
    return true;
  }
  if (parseAnchorSequence(context.state, context.tokens, index)) {
    return true;
  }
  if (token.lower === "on") {
    return false;
  }
  if (token.lower === "with") {
    return false;
  }
  mark(context.state.consumed, token);
  return true;
}

function collectCustomWhen(
  context: ClauseParseContext,
  _index: number,
  token: Token
): boolean {
  const customWhen = context.options?.whenMap?.[token.lower];
  if (!customWhen) {
    return false;
  }
  applyWhenToken(context.state, token, customWhen);
  return true;
}

function collectEventTiming(
  context: ClauseParseContext,
  index: number,
  token: Token
): boolean {
  const whenCode = getEventTimingMeaning(token);
  if (!whenCode) {
    return false;
  }
  if (
    context.prnReasonStart !== undefined &&
    index >= context.prnReasonStart &&
    token.lower === "sleep"
  ) {
    return false;
  }
  if (isWorkflowInstructionContext(context.tokens, index, context.state.consumed)) {
    return false;
  }
  applyWhenToken(context.state, token, whenCode);
  return true;
}

function collectDayRange(
  context: ClauseParseContext,
  index: number
): boolean {
  return tryConsumeDayRangeTokens(context.state, context.tokens, index) > 0;
}

function collectDayOfWeek(
  context: ClauseParseContext,
  index: number,
  token: Token
): boolean {
  if (token.lower === "sun") {
    const nextToken = getNextActiveToken(
      context.tokens,
      index,
      context.state.consumed
    );
    if (nextToken && normalizeTokenLower(nextToken) === "exposure") {
      return false;
    }
  }
  const days = getDayOfWeekMeaning(token);
  if (!days) {
    return false;
  }
  addDayOfWeekList(context.state, days);
  mark(context.state.consumed, token);
  return true;
}

function collectRouteSynonym(
  context: ClauseParseContext,
  index: number
): boolean {
  const token = context.tokens[index];
  if (
    context.state.methodVerb &&
    hasEstablishedAdministrationContent(context.state) &&
    token &&
    (
      hasTokenWordClass(token, TokenWordClass.AdministrationVerb) ||
      isAdministrationVerbWord(token.lower)
    )
  ) {
    return false;
  }
  if (
    token &&
    normalizeTokenLower(token) === "shampoo" &&
    context.state.methodVerb === "use"
  ) {
    return false;
  }
  return tryCollectRouteSynonym(context, index);
}

function collectSiteAbbreviation(
  context: ClauseParseContext,
  index: number,
  token: Token
): boolean {
  const semantics = buildTokenSemanticContext(context, index, token);
  const siteCandidate = semantics.siteCandidate;
  if (!siteCandidate || !semantics.treatSiteCandidateAsSite) {
    return false;
  }
  context.state.siteText = siteCandidate.text;
  context.state.siteSource = "abbreviation";
  if (siteCandidate.route && !context.state.routeCode) {
    setRoute(context.state, siteCandidate.route);
  }
  mark(context.state.consumed, token);
  return true;
}

function collectCountLimit(
  context: ClauseParseContext,
  index: number,
  token: Token
): boolean {
  const state = context.state;
  const tokens = context.tokens;
  if (state.count !== undefined) {
    return false;
  }
  const countMatch = token.lower.match(/^[x*]([0-9]+(?:\.[0-9]+)?)$/);
  if (countMatch) {
    if (applyCountLimit(state, parseFloat(countMatch[1]))) {
      mark(state.consumed, token);
      const nextToken = tokens[index + 1];
      if (nextToken && isCountKeywordWord(nextToken.lower)) {
        mark(state.consumed, nextToken);
      }
      return true;
    }
  }
  if (COUNT_MARKER_TOKENS.has(token.lower)) {
    const numericToken = tokens[index + 1];
    if (
      numericToken &&
      !state.consumed.has(numericToken.index) &&
      /^[0-9]+(?:\.[0-9]+)?$/.test(numericToken.lower) &&
      applyCountLimit(state, parseFloat(numericToken.original))
    ) {
      mark(state.consumed, token);
      mark(state.consumed, numericToken);
      const afterToken = tokens[index + 2];
      if (afterToken && isCountKeywordWord(afterToken.lower)) {
        mark(state.consumed, afterToken);
      }
      return true;
    }
  }
  if (token.lower === "for") {
    const preConnectors: Token[] = [];
    let lookaheadIndex = skipCountConnectors(
      tokens,
      state.consumed,
      index + 1,
      preConnectors
    );
    const numericToken = tokens[lookaheadIndex];
    if (
      numericToken &&
      !state.consumed.has(numericToken.index) &&
      /^[0-9]+(?:\.[0-9]+)?$/.test(numericToken.lower)
    ) {
      const postConnectors: Token[] = [];
      lookaheadIndex = skipCountConnectors(
        tokens,
        state.consumed,
        lookaheadIndex + 1,
        postConnectors
      );
      const keywordToken = tokens[lookaheadIndex];
      if (
        keywordToken &&
        !state.consumed.has(keywordToken.index) &&
        isCountKeywordWord(keywordToken.lower) &&
        applyCountLimit(state, parseFloat(numericToken.original))
      ) {
        mark(state.consumed, token);
        for (const connector of preConnectors) {
          mark(state.consumed, connector);
        }
        mark(state.consumed, numericToken);
        for (const connector of postConnectors) {
          mark(state.consumed, connector);
        }
        mark(state.consumed, keywordToken);
        return true;
      }
    }
  }
  if (!isCountKeywordWord(token.lower)) {
    return false;
  }
  if (hasCadenceContinuationAfter(tokens, state.consumed, index)) {
    return false;
  }
  const partsToMark: Token[] = [token];
  let value: number | undefined;
  const prevToken = tokens[index - 1];
  if (prevToken && !state.consumed.has(prevToken.index)) {
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
      const maybeX = tokens[index - 2];
      if (
        maybeX &&
        !state.consumed.has(maybeX.index) &&
        COUNT_MARKER_TOKENS.has(maybeX.lower)
      ) {
        value = parseFloat(prevToken.original);
        partsToMark.push(maybeX, prevToken);
      }
    }
  }
  if (value === undefined) {
    const nextToken = tokens[index + 1];
    if (
      nextToken &&
      !state.consumed.has(nextToken.index) &&
      /^[0-9]+(?:\.[0-9]+)?$/.test(nextToken.lower)
    ) {
      value = parseFloat(nextToken.original);
      partsToMark.push(nextToken);
    }
  }
  if (value === undefined) {
    const simpleCount = FREQUENCY_SIMPLE_WORDS[token.lower];
    if (simpleCount !== undefined) {
      value = simpleCount;
    }
  }
  if (value === undefined) {
    const prevToken = tokens[index - 1];
    if (prevToken && !state.consumed.has(prevToken.index)) {
      const prevWordValue = FREQUENCY_NUMBER_WORDS[prevToken.lower];
      if (prevWordValue !== undefined) {
        value = prevWordValue;
        partsToMark.push(prevToken);
      }
    }
  }
  if (!applyCountLimit(state, value)) {
    return false;
  }
  for (const part of partsToMark) {
    mark(state.consumed, part);
  }
  return true;
}

function collectStandaloneSingleOccurrence(
  context: ClauseParseContext,
  index: number,
  token: Token
): boolean {
  if (token.lower !== "once") {
    return false;
  }
  if (hasCadenceContinuationAfter(context.tokens, context.state.consumed, index)) {
    return false;
  }
  if (!applyCountLimit(context.state, 1)) {
    return false;
  }
  mark(context.state.consumed, token);
  return true;
}

function collectDurationLimit(
  context: ClauseParseContext,
  index: number,
  token: Token
): boolean {
  const state = context.state;
  const tokens = context.tokens;
  if (state.duration !== undefined || state.durationUnit !== undefined) {
    return false;
  }
  if (!hasEstablishedAdministrationContent(state)) {
    return false;
  }

  const compactMatch = token.lower.match(
    /^[x*]([0-9]+(?:\.[0-9]+)?)(min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|wk|w|week|weeks|mo|month|months)$/
  );
  if (compactMatch) {
    const unitCode = mapIntervalUnit(compactMatch[2]);
    if (applyDurationLimit(state, parseFloat(compactMatch[1]), unitCode)) {
      mark(state.consumed, token);
      return true;
    }
  }

  const tryApplyFromNumericAndUnit = (
    numericToken: Token | undefined,
    unitToken: Token | undefined,
    partsToMark: Token[]
  ): boolean => {
    if (
      !numericToken ||
      !unitToken ||
      state.consumed.has(numericToken.index) ||
      state.consumed.has(unitToken.index)
    ) {
      return false;
    }
    const unitCode = mapIntervalUnit(unitToken.lower);
    if (!unitCode) {
      return false;
    }
    const range = parseNumericRange(numericToken.lower);
    if (range) {
      if (!applyDurationLimit(state, range.low, unitCode, range.high)) {
        return false;
      }
    } else if (/^[0-9]+(?:\.[0-9]+)?$/.test(numericToken.lower)) {
      if (!applyDurationLimit(state, parseFloat(numericToken.original), unitCode)) {
        return false;
      }
    } else {
      return false;
    }
    for (const part of partsToMark) {
      mark(state.consumed, part);
    }
    return true;
  };

  const prefixedMatch = token.lower.match(/^[x*]([0-9]+(?:\.[0-9]+)?)$/);
  if (prefixedMatch) {
    const unitToken = tokens[index + 1];
    const unitCode = unitToken ? mapIntervalUnit(unitToken.lower) : undefined;
    if (
      unitCode &&
      applyDurationLimit(state, parseFloat(prefixedMatch[1]), unitCode)
    ) {
      mark(state.consumed, token);
      mark(state.consumed, unitToken);
      return true;
    }
  }

  if (COUNT_MARKER_TOKENS.has(token.lower)) {
    const numericToken = tokens[index + 1];
    const unitToken = tokens[index + 2];
    if (tryApplyFromNumericAndUnit(numericToken, unitToken, [token, numericToken, unitToken])) {
      return true;
    }
  }

  if (token.lower !== "for") {
    return false;
  }

  const preConnectors: Token[] = [];
  let lookaheadIndex = skipCountConnectors(
    tokens,
    state.consumed,
    index + 1,
    preConnectors
  );
  const numericToken = tokens[lookaheadIndex];
  const postConnectors: Token[] = [];
  lookaheadIndex = skipCountConnectors(
    tokens,
    state.consumed,
    lookaheadIndex + 1,
    postConnectors
  );
  const unitToken = tokens[lookaheadIndex];
  if (
    tryApplyFromNumericAndUnit(
      numericToken,
      unitToken,
      [token, ...preConnectors, numericToken, ...postConnectors, unitToken].filter(
        Boolean
      ) as Token[]
    )
  ) {
    return true;
  }

  return false;
}

function collectCountBasedFrequency(
  context: ClauseParseContext,
  index: number
): boolean {
  return tryParseCountBasedFrequency(
    context.state,
    context.tokens,
    index,
    context.options
  );
}

function collectDoseRange(
  context: ClauseParseContext,
  index: number,
  token: Token
): boolean {
  const rangeValue = parseNumericRange(token.lower);
  if (!rangeValue) {
    return false;
  }
  if (!context.state.doseRange) {
    context.state.doseRange = rangeValue;
  }
  mark(context.state.consumed, token);
  const resolvedUnit = resolveUnitTokenAt(
    context.tokens,
    index + 1,
    context.state.consumed,
    context.options
  );
  if (resolvedUnit) {
    context.state.unit = resolvedUnit.unit;
    for (const consumedIndex of resolvedUnit.consumedIndices) {
      mark(context.state.consumed, context.tokens[consumedIndex]);
    }
  }
  return true;
}

function collectNumericDose(
  context: ClauseParseContext,
  index: number,
  token: Token
): boolean {
  if (!isNumericToken(token.lower)) {
    return false;
  }
  if (isDurationPhraseNumber(context.tokens, index, context.state.consumed)) {
    return false;
  }
  const value = parseFloat(token.original);
  const resolvedDose = resolveNumericDoseUnit(
    context.tokens,
    index,
    value,
    context.state.consumed,
    context.options
  );
  if (context.state.dose === undefined) {
    context.state.dose = resolvedDose.doseValue;
  }
  mark(context.state.consumed, token);
  if (resolvedDose.unit) {
    context.state.unit = resolvedDose.unit;
  }
  for (const consumedIndex of resolvedDose.consumedIndices) {
    mark(context.state.consumed, context.tokens[consumedIndex]);
  }
  return true;
}

function collectTimesDose(
  context: ClauseParseContext,
  _index: number,
  token: Token
): boolean {
  const timesMatch = token.lower.match(/^([0-9]+(?:\.[0-9]+)?)[x*]$/);
  if (!timesMatch) {
    return false;
  }
  const value = parseFloat(timesMatch[1]);
  if (context.state.dose === undefined) {
    context.state.dose = value;
  }
  mark(context.state.consumed, token);
  return true;
}

function collectWordFrequency(
  context: ClauseParseContext,
  _index: number,
  token: Token
): boolean {
  const wordFreq = WORD_FREQUENCIES[token.lower];
  if (!wordFreq) {
    return false;
  }
  context.state.frequency = wordFreq.frequency;
  context.state.period = 1;
  context.state.periodUnit = wordFreq.periodUnit;
  mark(context.state.consumed, token);
  return true;
}

function collectPhraseWordFrequency(
  context: ClauseParseContext,
  index: number,
  _token: Token
): boolean {
  const maxSpan = Math.min(3, context.tokens.length - index);
  for (let span = maxSpan; span >= 2; span--) {
    let blocked = false;
    const phraseParts: string[] = [];
    const matchedTokens: Token[] = [];
    for (let offset = 0; offset < span; offset++) {
      const candidate = context.tokens[index + offset];
      if (!candidate) {
        blocked = true;
        break;
      }
      if (context.state.consumed.has(candidate.index)) {
        blocked = true;
        break;
      }
      matchedTokens.push(candidate);
      phraseParts.push(candidate.lower);
    }
    if (blocked) {
      continue;
    }
    const descriptor = WORD_FREQUENCIES[phraseParts.join(" ")];
    if (!descriptor) {
      continue;
    }
    context.state.frequency = descriptor.frequency;
    context.state.period = 1;
    context.state.periodUnit = descriptor.periodUnit;
    for (const matchedToken of matchedTokens) {
      mark(context.state.consumed, matchedToken);
    }
    return true;
  }
  return false;
}

function collectGenericConnector(
  context: ClauseParseContext,
  index: number,
  token: Token
): boolean {
  if (!GENERIC_CONNECTOR_TOKENS.has(token.lower)) {
    return false;
  }
  if (
    (token.lower === "each" || token.lower === "every") &&
    isWorkflowConnectorContext(context.tokens, index, context.state.consumed)
  ) {
    return false;
  }
  mark(context.state.consumed, token);
  return true;
}

function parseScheduleTerm(
  context: ClauseParseContext,
  index: number,
  token: Token
): number | undefined {
  return (
    applyGrammarTerminal(context, index, token, "schedule.bldMeal", collectBldMealTiming) ??
    applyGrammarTerminal(context, index, token, "schedule.separatedInterval", collectSeparatedInterval) ??
    applyGrammarTerminal(context, index, token, "schedule.timeBased", collectTimeBasedSchedule) ??
    applyGrammarTerminal(context, index, token, "schedule.numericCadence", collectNumericCadence) ??
    applyGrammarTerminal(context, index, token, "schedule.multiplicativeCadence", collectMultiplicativeCadenceTerm) ??
    applyGrammarTerminal(context, index, token, "schedule.odTimingAbbreviation", collectOdTimingAbbreviation) ??
    applyGrammarTerminal(context, index, token, "schedule.timingAbbreviation", collectTimingAbbreviation) ??
    applyGrammarTerminal(context, index, token, "schedule.compactInterval", collectCompactInterval) ??
    applyGrammarTerminal(context, index, token, "schedule.timingConnector", collectTimingConnector) ??
    applyGrammarTerminal(context, index, token, "schedule.comboEventTiming", collectComboEventTiming) ??
    applyGrammarTerminal(context, index, token, "schedule.pcAcAnchor", collectPcAcAnchor) ??
    applyGrammarTerminal(context, index, token, "schedule.beforeAfterAnchor", collectBeforeAfterAnchor) ??
    applyGrammarTerminal(context, index, token, "schedule.genericAnchor", collectGenericAnchor) ??
    applyGrammarTerminal(context, index, token, "schedule.customWhen", collectCustomWhen) ??
    applyGrammarTerminal(context, index, token, "schedule.eventTiming", collectEventTiming) ??
    applyGrammarTerminal(context, index, token, "schedule.dayRange", collectDayRange) ??
    applyGrammarTerminal(context, index, token, "schedule.dayOfWeek", collectDayOfWeek) ??
    applyGrammarTerminal(context, index, token, "schedule.duration", collectDurationLimit) ??
    applyGrammarTerminal(context, index, token, "schedule.phraseWordFrequency", collectPhraseWordFrequency) ??
    applyGrammarTerminal(context, index, token, "schedule.wordFrequency", collectWordFrequency)
  );
}

function collectMethodVerb(
  context: ClauseParseContext,
  _index: number,
  token: Token
): boolean {
  const normalized = normalizeTokenLower(token);
  if (
    context.state.methodVerb &&
    hasEstablishedAdministrationContent(context.state)
  ) {
    return false;
  }
  if (
    normalized === "shampoo" &&
    context.state.methodVerb === "use"
  ) {
    return false;
  }
  if (!hasTokenWordClass(token, TokenWordClass.AdministrationVerb) && !isAdministrationVerbWord(token.lower)) {
    return false;
  }
  if (normalized === "use" && hasEstablishedAdministrationContent(context.state)) {
    return false;
  }
  setMethodFromVerbToken(context.state, token);
  const routeMeaning = getRouteMeaning(token);
  if (routeMeaning && !context.state.routeCode) {
    setRoute(context.state, routeMeaning.code, routeMeaning.text);
  }
  mark(context.state.consumed, token);
  return true;
}

function parseMethodTerm(
  context: ClauseParseContext,
  index: number,
  token: Token
): number | undefined {
  return applyGrammarTerminal(context, index, token, "method.verb", collectMethodVerb);
}

function parseRouteTerm(
  context: ClauseParseContext,
  index: number,
  token: Token
): number | undefined {
  return applyGrammarTerminal(context, index, token, "route.synonym", collectRouteSynonym);
}

function parseSiteTerm(
  context: ClauseParseContext,
  index: number,
  token: Token
): number | undefined {
  return applyGrammarTerminal(context, index, token, "site.abbreviation", collectSiteAbbreviation);
}

function parseCountTerm(
  context: ClauseParseContext,
  index: number,
  token: Token
): number | undefined {
  return (
    applyGrammarTerminal(context, index, token, "count.singleOccurrence", collectStandaloneSingleOccurrence) ??
    applyGrammarTerminal(context, index, token, "count.limit", collectCountLimit)
  );
}

function parseDoseTerm(
  context: ClauseParseContext,
  index: number,
  token: Token
): number | undefined {
  return (
    applyGrammarTerminal(context, index, token, "dose.countBasedFrequency", collectCountBasedFrequency) ??
    applyGrammarTerminal(context, index, token, "dose.range", collectDoseRange) ??
    applyGrammarTerminal(context, index, token, "dose.numeric", collectNumericDose) ??
    applyGrammarTerminal(context, index, token, "dose.times", collectTimesDose)
  );
}

function parseConnectorTerm(
  context: ClauseParseContext,
  index: number,
  token: Token
): number | undefined {
  return applyGrammarTerminal(context, index, token, "connector.generic", collectGenericConnector);
}

function parseCoreTerm(
  context: ClauseParseContext,
  index: number,
  token: Token
): number | undefined {
  return (
    parseScheduleTerm(context, index, token) ??
    parseMethodTerm(context, index, token) ??
    parseRouteTerm(context, index, token) ??
    parseSiteTerm(context, index, token) ??
    parseCountTerm(context, index, token) ??
    parseDoseTerm(context, index, token) ??
    parseConnectorTerm(context, index, token)
  );
}

/**
 * Core grammar:
 *
 * Clause        ::= CoreSequence
 * CoreSequence  ::= CoreTerm*
 * CoreTerm      ::= ScheduleTerm
 *                 | RouteTerm
 *                 | SiteTerm
 *                 | CountTerm
 *                 | DoseTerm
 *                 | ConnectorTerm
 */
function parseClauseGrammar(context: ClauseParseContext): void {
  const limit =
    context.prnReasonStart === undefined
      ? context.tokens.length
      : context.prnReasonStart;
  let index = 0;
  while (index < limit) {
    const token = context.tokens[index];
    if (!token || context.state.consumed.has(token.index)) {
      index += 1;
      continue;
    }
    const nextIndex = parseCoreTerm(context, index, token);
    if (nextIndex !== undefined && nextIndex > index) {
      index = nextIndex;
      continue;
    }
    index += 1;
  }
}

function stateHasConsumedAllTokens(state: ParserState, tokens: Token[]): boolean {
  for (const token of tokens) {
    if (!state.consumed.has(token.index)) {
      return false;
    }
  }
  return true;
}

function mergeScheduleState(target: ParserState, source: ParserState): void {
  if (source.timingCode !== undefined) {
    target.timingCode = source.timingCode;
  }
  if (source.count !== undefined) {
    target.count = source.count;
  }
  if (source.duration !== undefined) {
    target.duration = source.duration;
  }
  if (source.durationMax !== undefined) {
    target.durationMax = source.durationMax;
  }
  if (source.durationUnit !== undefined) {
    target.durationUnit = source.durationUnit;
  }
  if (source.frequency !== undefined) {
    target.frequency = source.frequency;
  }
  if (source.frequencyMax !== undefined) {
    target.frequencyMax = source.frequencyMax;
  }
  if (source.period !== undefined) {
    target.period = source.period;
  }
  if (source.periodMax !== undefined) {
    target.periodMax = source.periodMax;
  }
  if (source.periodUnit !== undefined) {
    target.periodUnit = source.periodUnit;
  }
  if (source.timeOfDay?.length) {
    target.timeOfDay = [...source.timeOfDay];
  }
  for (const whenCode of source.when) {
    addWhen(target.when, whenCode);
  }
  addDayOfWeekList(target, source.dayOfWeek);
}

function shouldPreserveStandalonePrnReasonToken(tokens: Token[]): boolean {
  return tokens.length === 1 && normalizeTokenLower(tokens[0]) === "sleep";
}

function tryApplyScheduleOnlyTokens(
  internal: ParserState,
  tokens: Token[],
  options?: ParseOptions
): boolean {
  if (!tokens.length || shouldPreserveStandalonePrnReasonToken(tokens)) {
    return false;
  }
  const probe = createClauseBackedInternal(
    internal.input,
    tokens,
    internal.customSiteHints
  );
  const probeContext = createClauseParseContext(probe, tokens, options);
  parseClauseGrammar(probeContext);
  applyClauseDefaultsAfterTokenScan(
    probe,
    tokens,
    probeContext.medicationContext,
    options
  );
  if (
    probe.dose !== undefined ||
    probe.doseRange !== undefined ||
    probe.unit !== undefined ||
    probe.routeCode !== undefined ||
    probe.siteText !== undefined ||
    probe.asNeeded
  ) {
    return false;
  }
  if (
    probe.duration === undefined &&
    probe.durationMax === undefined &&
    probe.durationUnit === undefined &&
    probe.frequency === undefined &&
    probe.frequencyMax === undefined &&
    probe.period === undefined &&
    probe.periodMax === undefined &&
    probe.periodUnit === undefined &&
    probe.timingCode === undefined &&
    probe.when.length === 0 &&
    probe.dayOfWeek.length === 0 &&
    !(probe.timeOfDay?.length)
  ) {
    return false;
  }
  if (!stateHasConsumedAllTokens(probe, tokens)) {
    return false;
  }
  mergeScheduleState(internal, probe);
  return true;
}

function findLeadingPrnSchedulePrefix(
  internal: ParserState,
  tokens: Token[],
  options?: ParseOptions
): number | undefined {
  const maxSpan = Math.min(4, tokens.length);
  for (let span = maxSpan; span >= 1; span--) {
    const prefixTokens = tokens.slice(0, span);
    if (!prefixTokens.length || prefixTokens.length === tokens.length) {
      continue;
    }
    if (tryApplyScheduleOnlyTokens(internal, prefixTokens, options)) {
      return span;
    }
  }
  return undefined;
}

function findTrailingPrnScheduleSuffix(
  internal: ParserState,
  tokens: Token[],
  options?: ParseOptions
): number | undefined {
  if (tokens.length >= 2) {
    const relationToken = tokens[tokens.length - 2];
    const mealToken = tokens[tokens.length - 1];
    const relation = relationToken ? normalizeTokenLower(relationToken) : "";
    const meal = mealToken ? MEAL_KEYWORDS[normalizeTokenLower(mealToken)] : undefined;
    if (meal && BEFORE_AFTER_TOKENS.has(relation)) {
      addWhen(
        internal.when,
        relation === "after" ? meal.pc : meal.ac
      );
      return tokens.length - 2;
    }
  }

  const maxSpan = Math.min(4, tokens.length);
  for (let span = maxSpan; span >= 1; span--) {
    const startIndex = tokens.length - span;
    if (startIndex < 0 || startIndex === 0) {
      continue;
    }
    const suffixTokens = tokens.slice(startIndex);
    if (tryApplyScheduleOnlyTokens(internal, suffixTokens, options)) {
      return startIndex;
    }
  }
  return undefined;
}

export function parseClauseState(
  input: string,
  options?: ParseOptions
): ParserState {
  const tokens = tokenize(input);
  const state = createClauseBackedInternal(
    input,
    tokens,
    buildCustomSiteHints(options?.siteCodeMap)
  );
  const parseContext = createClauseParseContext(state, tokens, options);
  if (tokens.length === 0) {
    finalizeCanonicalClause(state);
    return state;
  }
  parseContext.prnReasonStart = detectPrnPrelude(state, tokens);
  parseClauseGrammar(parseContext);
  collectProductFormHints(state, tokens);
  applyClauseDefaultsAfterTokenScan(state, tokens, parseContext.medicationContext, options);
  collectPrnReasonText(
    state,
    tokens,
    parseContext.prnReasonStart,
    parseContext.prnSiteSuffixIndices,
    options
  );
  collectSiteAdviceAndWarnings(
    state,
    tokens,
    parseContext.prnReasonStart,
    parseContext.prnSiteSuffixIndices,
    options,
    (phrase) => maybeApplyRouteDescriptorFromPhrase(parseContext, phrase)
  );
  collectCompletenessWarnings(state, tokens);
  finalizeCanonicalClause(state);
  return state;
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

function isWorkflowPatientInstructionText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const words = normalized.split(/\s+/).filter((word) => word.length > 0);
  if (!words.length) {
    return false;
  }
  for (const word of words) {
    if (PATIENT_INSTRUCTION_CONTEXT_TOKENS.has(word)) {
      return true;
    }
  }
  if (words[0] === "reapply") {
    return true;
  }
  return (
    normalized.includes(" sun exposure") ||
    normalized.includes(" outdoors") ||
    normalized.includes(" outside") ||
    normalized.includes(" swimming") ||
    normalized.includes(" diaper change") ||
    normalized.includes(" dressing change") ||
    normalized.includes(" bowel movement") ||
    normalized.includes(" leave on ") ||
    normalized.includes(" then rinse") ||
    normalized.includes(" wash off")
  );
}

function hasMethodModifierLeadIn(
  internal: ParserState,
  tokens: Token[],
  groupTokens: Token[]
): boolean {
  if (!internal.methodVerb || !groupTokens.length) {
    return false;
  }

  const firstIndex = groupTokens[0].index;
  const methodToken = tokens[firstIndex - 1];
  const separatorToken = tokens[firstIndex - 2];

  if (!methodToken || !separatorToken) {
    return false;
  }
  if (!internal.consumed.has(methodToken.index)) {
    return false;
  }
  if (methodToken.kind !== LexKind.Word) {
    return false;
  }
  if (normalizeTokenLower(methodToken) !== internal.methodVerb) {
    return false;
  }

  switch (separatorToken.kind) {
    case LexKind.Punctuation:
    case LexKind.Separator:
      return true;
    default:
      return false;
  }
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

  function appendEventTriggersFromFrames(frames: typeof instructions[number]["frames"]): void {
    if (!frames?.length) {
      return;
    }
    const clause = internal.primaryClause;
    const schedule = clause.schedule ?? (clause.schedule = {});
    const eventTriggers = schedule.eventTriggers ?? (schedule.eventTriggers = []);
    const seen = new Set(eventTriggers.map((trigger) => `${trigger.relation}|${trigger.anchorText.toLowerCase()}`));

    for (const frame of frames) {
      const trigger = buildEventTriggerFromAdviceFrame(frame);
      if (!trigger) {
        continue;
      }
      const key = `${trigger.relation}|${trigger.anchorText.toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      eventTriggers.push(trigger);
    }
  }

  for (const group of groups) {
    if (!group.tokens.length) {
      continue;
    }
    let punctuationOnly = true;
    for (const token of group.tokens) {
      if (token.kind !== LexKind.Punctuation && token.kind !== LexKind.Separator) {
        punctuationOnly = false;
        break;
      }
    }
    if (punctuationOnly) {
      for (const token of group.tokens) {
        mark(internal.consumed, token);
      }
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
    const methodModifierLeadIn = hasMethodModifierLeadIn(
      internal,
      tokens,
      group.tokens
    );
    const parsed = parseAdditionalInstructions(
      sourceText,
      range ?? { start: 0, end: sourceText.length },
      {
        defaultPredicate:
          methodModifierLeadIn && internal.methodVerb
            ? internal.methodVerb
            : defaultPredicate,
        allowFreeTextFallback: separatorDetected
      }
    );
    if (!parsed.length) {
      continue;
    }

    let groupAccepted = false;
    for (const parsedInstruction of parsed) {
      const plainText = parsedInstruction.text?.replace(/\s+/g, " ").trim();
      const resolvedPlainText =
        methodModifierLeadIn &&
        plainText &&
        !parsedInstruction.coding?.code &&
        internal.methodText
          ? `${internal.methodText} ${sourceText}`.replace(/\s+/g, " ").trim()
          : plainText;
      if (
        !parsedInstruction.coding?.code &&
        resolvedPlainText &&
        isWorkflowPatientInstructionText(resolvedPlainText)
      ) {
        appendEventTriggersFromFrames(parsedInstruction.frames);
        appendPatientInstruction(
          internal,
          normalizeWorkflowPatientInstructionText(sourceText) ?? resolvedPlainText
        );
        groupAccepted = true;
        continue;
      }
      const key = parsedInstruction.coding?.code
        ? `code:${parsedInstruction.coding.system ?? SNOMED_SYSTEM}|${parsedInstruction.coding.code}`
        : resolvedPlainText
          ? `text:${resolvedPlainText.toLowerCase()}`
          : `frames:${parsedInstruction.frames.length}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      instructions.push({
        text: resolvedPlainText,
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

function hasStructuredAdditionalInstructionTail(
  sourceText: string,
  defaultPredicate: string
): boolean {
  const parsed = parseAdditionalInstructions(
    sourceText,
    { start: 0, end: sourceText.length },
    { defaultPredicate }
  );
  for (const instruction of parsed) {
    if (instruction.coding?.code || instruction.frames.length > 0) {
      return true;
    }
  }
  return false;
}

function findStructuredPrnReasonCommaSeparator(
  sourceText: string,
  defaultPredicate: string
): number | undefined {
  for (let index = 0; index < sourceText.length; index++) {
    if (sourceText[index] !== ",") {
      continue;
    }
    const tail = sourceText.slice(index + 1).trim();
    if (!tail) {
      continue;
    }
    if (hasStructuredAdditionalInstructionTail(tail, defaultPredicate)) {
      return index;
    }
  }
  return undefined;
}

function determinePrnReasonCutoff(
  tokens: Token[],
  sourceText: string,
  defaultPredicate: string
): number | undefined {
  const separatorIndex =
    findPrnReasonSeparator(sourceText) ??
    findStructuredPrnReasonCommaSeparator(sourceText, defaultPredicate);
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

function lookupDefaultPrnReasonDefinition(
  canonical: string
): PrnReasonDefinition | undefined {
  const normalized = normalizePrnReasonKey(canonical);
  return normalized ? DEFAULT_PRN_REASON_DEFINITIONS[normalized] : undefined;
}

function inferSiteSpecificPrnReasonDefinition(
  internal: ParserState,
  request: PrnReasonLookupRequest
): PrnReasonDefinition | undefined {
  const normalizedRequest = normalizePrnReasonKey(request.text);
  if (!normalizedRequest || !GENERIC_ITCH_REASON_TERMS.has(normalizedRequest)) {
    return undefined;
  }

  const normalizedSiteText = normalizeBodySiteKey(internal.siteText ?? "");
  const siteCodingDisplay = internal.siteCoding?.display;
  const normalizedSiteCodingDisplay = siteCodingDisplay
    ? normalizeBodySiteKey(siteCodingDisplay)
    : "";
  const isOcularSite =
    (internal.routeCode !== undefined && OPHTHALMIC_ROUTE_CODES.has(internal.routeCode)) ||
    normalizedSiteText.includes("eye") ||
    normalizedSiteCodingDisplay.includes("eye");
  if (isOcularSite) {
    return lookupDefaultPrnReasonDefinition("eye itch");
  }

  const isLesionSite =
    normalizedSiteText.includes("lesion") || normalizedSiteCodingDisplay.includes("lesion");
  if (isLesionSite) {
    return lookupDefaultPrnReasonDefinition("lesion itch");
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

function createPrnReasonLookupRequestFromText(
  internal: ParserState,
  text: string
): PrnReasonLookupRequest {
  const normalized = text.toLowerCase();
  const canonical = normalizePrnReasonKey(text);
  return {
    originalText: text,
    text,
    normalized,
    canonical: canonical ?? "",
    isProbe: false,
    inputText: internal.input,
    sourceText: text,
    range: undefined
  };
}

function resolvePrnReasonDefinitionSyncForRequest(
  internal: ParserState,
  request: PrnReasonLookupRequest,
  options?: ParseOptions
): PrnReasonDefinition | undefined {
  const selection = pickPrnReasonSelection(options?.prnReasonSelections, request);
  if (selection) {
    return selection;
  }
  const customDefinition = lookupPrnReasonDefinition(options?.prnReasonMap, request.canonical);
  if (customDefinition) {
    return customDefinition;
  }
  const inferredDefinition = inferSiteSpecificPrnReasonDefinition(internal, request);
  if (inferredDefinition) {
    return inferredDefinition;
  }
  for (const resolver of toArray(options?.prnReasonResolvers)) {
    const result = resolver(request);
    if (isPromise(result)) {
      throw new Error(
        "PRN reason resolver returned a Promise; use parseSigAsync for asynchronous PRN reason resolution."
      );
    }
    if (result) {
      return result;
    }
  }
  return request.canonical ? DEFAULT_PRN_REASON_DEFINITIONS[request.canonical] : undefined;
}

async function resolvePrnReasonDefinitionAsyncForRequest(
  internal: ParserState,
  request: PrnReasonLookupRequest,
  options?: ParseOptions
): Promise<PrnReasonDefinition | undefined> {
  const selection = pickPrnReasonSelection(options?.prnReasonSelections, request);
  if (selection) {
    return selection;
  }
  const customDefinition = lookupPrnReasonDefinition(options?.prnReasonMap, request.canonical);
  if (customDefinition) {
    return customDefinition;
  }
  const inferredDefinition = inferSiteSpecificPrnReasonDefinition(internal, request);
  if (inferredDefinition) {
    return inferredDefinition;
  }
  for (const resolver of toArray(options?.prnReasonResolvers)) {
    const result = await resolver(request);
    if (result) {
      return result;
    }
  }
  return request.canonical ? DEFAULT_PRN_REASON_DEFINITIONS[request.canonical] : undefined;
}

function splitCoordinatedPrnReasonText(text: string): string[] | undefined {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return undefined;
  }
  const patterns = [
    /\s+and\/or\s+/i,
    /\s+หรือ\s+/,
    /\s+or\s+/i,
    /\s+และ\s+/,
    /\s+and\s+/i,
    /\s*\/\s*/,
    /\s*,\s*/
  ];
  for (const pattern of patterns) {
    const parts = trimmed.split(pattern).map((part) => part.trim()).filter(Boolean);
    if (parts.length > 1) {
      return parts;
    }
  }
  return undefined;
}

function maybeApplyCoordinatedPrnReasonsSync(
  internal: ParserState,
  options?: ParseOptions
): void {
  const text = internal.asNeededReason;
  if (!text || internal.asNeededReasonCoding) {
    return;
  }
  const parts = splitCoordinatedPrnReasonText(text);
  if (!parts || parts.length < 2) {
    return;
  }
  const reasons = [];
  for (const part of parts) {
    const request = createPrnReasonLookupRequestFromText(internal, part);
    const definition = resolvePrnReasonDefinitionSyncForRequest(internal, request, options);
    reasons.push({
      text: part,
      coding: definition?.coding?.code
        ? {
          code: definition.coding.code,
          display: definition.coding.display,
          system: definition.coding.system ?? SNOMED_SYSTEM,
          i18n: definition.i18n
        }
        : undefined
    });
  }
  internal.asNeededReasons = reasons;
}

async function maybeApplyCoordinatedPrnReasonsAsync(
  internal: ParserState,
  options?: ParseOptions
): Promise<void> {
  const text = internal.asNeededReason;
  if (!text || internal.asNeededReasonCoding) {
    return;
  }
  const parts = splitCoordinatedPrnReasonText(text);
  if (!parts || parts.length < 2) {
    return;
  }
  const reasons = [];
  for (const part of parts) {
    const request = createPrnReasonLookupRequestFromText(internal, part);
    const definition = await resolvePrnReasonDefinitionAsyncForRequest(internal, request, options);
    reasons.push({
      text: part,
      coding: definition?.coding?.code
        ? {
          code: definition.coding.code,
          display: definition.coding.display,
          system: definition.coding.system ?? SNOMED_SYSTEM,
          i18n: definition.i18n
        }
        : undefined
    });
  }
  internal.asNeededReasons = reasons;
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
  const inferredDefinition = inferSiteSpecificPrnReasonDefinition(internal, request);
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
  if (!resolution && inferredDefinition) {
    resolution = inferredDefinition;
  }
  if (!resolution && defaultDefinition) {
    resolution = defaultDefinition;
  }

  if (resolution) {
    applyPrnReasonDefinition(internal, resolution);
  } else {
    internal.asNeededReasonCoding = undefined;
  }
  maybeApplyCoordinatedPrnReasonsSync(internal, options);

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
  if (inferredDefinition) {
    addReasonSuggestionToMap(suggestionMap, definitionToPrnSuggestion(inferredDefinition));
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
  const inferredDefinition = inferSiteSpecificPrnReasonDefinition(internal, request);
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
  if (!resolution && inferredDefinition) {
    resolution = inferredDefinition;
  }
  if (!resolution && defaultDefinition) {
    resolution = defaultDefinition;
  }

  if (resolution) {
    applyPrnReasonDefinition(internal, resolution);
  } else {
    internal.asNeededReasonCoding = undefined;
  }
  await maybeApplyCoordinatedPrnReasonsAsync(internal, options);

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
  if (inferredDefinition) {
    addReasonSuggestionToMap(suggestionMap, definitionToPrnSuggestion(inferredDefinition));
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
