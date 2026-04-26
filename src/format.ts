import { buildCanonicalSigClauses } from "./ir";
import { ParserState } from "./parser-state";
import type { SigLocalization, SigLongContext, SigShortContext } from "./i18n";
import { getPreferredCanonicalPrnReasonText } from "./prn";
import { resolveBodySitePhrase } from "./body-site-grammar";
import {
  AdviceArgumentRole,
  AdviceRelation,
  BodySiteSpatialRelation,
  CanonicalDoseExpr,
  CanonicalScheduleExpr,
  CanonicalSigClause,
  EventTiming,
  FhirPeriodUnit,
  RouteCode
} from "./types";
import {
  getMealTimingGroup,
  inferDailyOccurrenceCount,
  type MealTimingGroup,
  type TimingSummaryOptions
} from "./timing-summary";

const ROUTE_SHORT: Partial<Record<RouteCode, string>> = {
  [RouteCode["Oral route"]]: "PO",
  [RouteCode["Sublingual route"]]: "SL",
  [RouteCode["Buccal route"]]: "BUC",
  [RouteCode["Respiratory tract route (qualifier value)"]]: "INH",
  [RouteCode["Nasal route"]]: "IN",
  [RouteCode["Topical route"]]: "TOP",
  [RouteCode["Transdermal route"]]: "TD",
  [RouteCode["Subcutaneous route"]]: "SC",
  [RouteCode["Intramuscular route"]]: "IM",
  [RouteCode["Intravenous route"]]: "IV",
  [RouteCode["Per rectum"]]: "PR",
  [RouteCode["Per vagina"]]: "PV",
  [RouteCode["Ophthalmic route"]]: "OPH",
  [RouteCode["Intravitreal route (qualifier value)"]]: "IVT"
};

const WHEN_TEXT: Partial<Record<EventTiming, string>> = {
  [EventTiming["Before Sleep"]]: "at bedtime",
  [EventTiming["Before Meal"]]: "before meals",
  [EventTiming["Before Breakfast"]]: "before breakfast",
  [EventTiming["Before Lunch"]]: "before lunch",
  [EventTiming["Before Dinner"]]: "before dinner",
  [EventTiming["After Meal"]]: "after meals",
  [EventTiming["After Breakfast"]]: "after breakfast",
  [EventTiming["After Lunch"]]: "after lunch",
  [EventTiming["After Dinner"]]: "after dinner",
  [EventTiming.Meal]: "with meals",
  [EventTiming.Breakfast]: "with breakfast",
  [EventTiming.Lunch]: "with lunch",
  [EventTiming.Dinner]: "with dinner",
  [EventTiming.Morning]: "in the morning",
  [EventTiming["Early Morning"]]: "in the early morning",
  [EventTiming["Late Morning"]]: "in the late morning",
  [EventTiming.Noon]: "at noon",
  [EventTiming.Afternoon]: "in the afternoon",
  [EventTiming["Early Afternoon"]]: "in the early afternoon",
  [EventTiming["Late Afternoon"]]: "in the late afternoon",
  [EventTiming.Evening]: "in the evening",
  [EventTiming["Early Evening"]]: "in the early evening",
  [EventTiming["Late Evening"]]: "in the late evening",
  [EventTiming.Night]: "at night",
  [EventTiming.Wake]: "after waking",
  [EventTiming["After Sleep"]]: "after sleep",
  [EventTiming.Immediate]: "immediately"
};

const DAY_NAMES: Record<string, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday"
};

const EN_TIMES_PER_DAY: Record<number, string> = {
  1: "once daily",
  2: "twice daily",
  3: "three times daily",
  4: "four times daily"
};

const SLOWLY_QUALIFIER_CODE = "419443000";
const EMPTY_STOMACH_QUALIFIER_CODE = "717154004";

interface RouteGrammar {
  verb: string;
  routePhrase?: string | ((context: { hasSite: boolean; clause: CanonicalSigClause }) => string | undefined);
  sitePreposition?: string;
}

const DEFAULT_ROUTE_GRAMMAR: RouteGrammar = { verb: "Use" };

const ROUTE_GRAMMAR: Partial<Record<RouteCode, RouteGrammar>> = {
  [RouteCode["Oral route"]]: { verb: "Take", routePhrase: "orally" },
  [RouteCode["Ophthalmic route"]]: {
    verb: "Instill",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "in the eye"),
    sitePreposition: "in"
  },
  [RouteCode["Intravitreal route (qualifier value)"]]: {
    verb: "Inject",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "into the eye"),
    sitePreposition: "into"
  },
  [RouteCode["Per rectum"]]: {
    verb: "Use",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "rectally"),
    sitePreposition: "into"
  },
  [RouteCode["Per vagina"]]: {
    verb: "Insert",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "vaginally"),
    sitePreposition: "into"
  },
  [RouteCode["Topical route"]]: {
    verb: "Apply",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "topically"),
    sitePreposition: "to"
  },
  [RouteCode["Transdermal route"]]: {
    verb: "Apply",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "transdermally"),
    sitePreposition: "to"
  },
  [RouteCode["Subcutaneous route"]]: {
    verb: "Inject",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "subcutaneously"),
    sitePreposition: "into"
  },
  [RouteCode["Intramuscular route"]]: {
    verb: "Inject",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "intramuscularly"),
    sitePreposition: "into"
  },
  [RouteCode["Intravenous route"]]: {
    verb: "Inject",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "intravenously"),
    sitePreposition: "into"
  },
  [RouteCode["Otic route"]]: {
    verb: "Instill",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "in the ear"),
    sitePreposition: "in"
  },
  [RouteCode["Nasal route"]]: {
    verb: "Use",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "via nasal route"),
    sitePreposition: "into"
  },
  [RouteCode["Respiratory tract route (qualifier value)"]]: {
    verb: "Use",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "via inhalation"),
    sitePreposition: "into"
  }
};

function scheduleOf(clause: CanonicalSigClause): CanonicalScheduleExpr {
  return clause.schedule ?? {};
}

function grammarFromRouteText(text: string | undefined): RouteGrammar | undefined {
  if (!text) {
    return undefined;
  }
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes("mouth") || normalized.includes("oral")) {
    return ROUTE_GRAMMAR[RouteCode["Oral route"]];
  }
  if (normalized.includes("ophthalm")) {
    return ROUTE_GRAMMAR[RouteCode["Ophthalmic route"]];
  }
  if (normalized.includes("intravitreal")) {
    return ROUTE_GRAMMAR[RouteCode["Intravitreal route (qualifier value)"]];
  }
  if (normalized.includes("topical")) {
    return ROUTE_GRAMMAR[RouteCode["Topical route"]];
  }
  if (normalized.includes("transdermal")) {
    return ROUTE_GRAMMAR[RouteCode["Transdermal route"]];
  }
  if (normalized.includes("subcutaneous") || normalized === "sc" || normalized === "sq") {
    return ROUTE_GRAMMAR[RouteCode["Subcutaneous route"]];
  }
  if (normalized.includes("intramuscular") || normalized === "im") {
    return ROUTE_GRAMMAR[RouteCode["Intramuscular route"]];
  }
  if (normalized.includes("intravenous") || normalized === "iv") {
    return ROUTE_GRAMMAR[RouteCode["Intravenous route"]];
  }
  if (normalized.includes("rectal") || normalized.includes("rectum")) {
    return ROUTE_GRAMMAR[RouteCode["Per rectum"]];
  }
  if (normalized.includes("vagin")) {
    return ROUTE_GRAMMAR[RouteCode["Per vagina"]];
  }
  if (normalized.includes("otic") || normalized.includes("ear")) {
    return ROUTE_GRAMMAR[RouteCode["Otic route"]];
  }
  if (normalized.includes("nasal")) {
    return ROUTE_GRAMMAR[RouteCode["Nasal route"]];
  }
  if (normalized.includes("inhal")) {
    return ROUTE_GRAMMAR[RouteCode["Respiratory tract route (qualifier value)"]];
  }
  return undefined;
}

function resolveRouteGrammar(clause: CanonicalSigClause): RouteGrammar {
  const routeCode = clause.route?.code;
  if (routeCode && ROUTE_GRAMMAR[routeCode]) {
    return ROUTE_GRAMMAR[routeCode] ?? DEFAULT_ROUTE_GRAMMAR;
  }
  return grammarFromRouteText(clause.route?.text) ?? DEFAULT_ROUTE_GRAMMAR;
}

function resolveMethodVerb(clause: CanonicalSigClause, grammar: RouteGrammar): string {
  const methodText = clause.method?.text?.trim();
  if (methodText) {
    return methodText;
  }
  return grammar.verb;
}

function pluralize(unit: string, value: number): string {
  if (Math.abs(value) === 1) {
    switch (unit) {
      case "tab":
        return "tablet";
      case "cap":
        return "capsule";
      default:
        return unit;
    }
  }
  if (unit.endsWith(" ribbon")) {
    return unit;
  }
  switch (unit) {
    case "tab":
    case "tablet":
      return "tablets";
    case "cap":
    case "capsule":
      return "capsules";
    case "mL":
    case "mg":
      return unit;
    case "puff":
      return "puffs";
    case "patch":
      return "patches";
    case "drop":
      return "drops";
    case "suppository":
      return "suppositories";
    case "pump":
      return "pumps";
    case "squeeze":
      return "squeezes";
    case "applicatorful":
      return "applicatorfuls";
    case "capful":
      return "capfuls";
    case "scoop":
      return "scoops";
    case "application":
      return "applications";
    case "fingertip unit":
      return "fingertip units";
    case "finger length":
      return "finger lengths";
    default:
      return unit;
  }
}

function formatPatientInstructionSentence(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  const instruction = /^(after|before|with)\b/.test(normalized)
    ? `Use ${trimmed}`
    : trimmed;
  const sentence = /^[.!?]$/.test(instruction.slice(-1)) ? instruction : `${instruction}.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function describeFrequency(schedule: CanonicalScheduleExpr | undefined): string | undefined {
  const frequency = schedule?.frequency;
  const frequencyMax = schedule?.frequencyMax;
  const period = schedule?.period;
  const periodMax = schedule?.periodMax;
  const periodUnit = schedule?.periodUnit;
  const timingCode = schedule?.timingCode;

  if (
    frequency !== undefined &&
    frequencyMax !== undefined &&
    periodUnit === FhirPeriodUnit.Day &&
    (!period || period === 1)
  ) {
    if (frequency === 1 && frequencyMax === 1) {
      return "once daily";
    }
    if (frequency === 1 && frequencyMax === 2) {
      return "one to two times daily";
    }
    return `${stripTrailingZero(frequency)} to ${stripTrailingZero(frequencyMax)} times daily`;
  }
  if (frequency && periodUnit === FhirPeriodUnit.Day && (!period || period === 1)) {
    const dailyText = EN_TIMES_PER_DAY[frequency];
    if (dailyText) {
      return dailyText;
    }
    return `${stripTrailingZero(frequency)} times daily`;
  }
  if (periodUnit === FhirPeriodUnit.Minute && period) {
    if (periodMax && periodMax !== period) {
      return `every ${stripTrailingZero(period)} to ${stripTrailingZero(periodMax)} minutes`;
    }
    return `every ${stripTrailingZero(period)} minute${period === 1 ? "" : "s"}`;
  }
  if (periodUnit === FhirPeriodUnit.Hour && period) {
    if (periodMax && periodMax !== period) {
      return `every ${stripTrailingZero(period)} to ${stripTrailingZero(periodMax)} hours`;
    }
    return `every ${stripTrailingZero(period)} hour${period === 1 ? "" : "s"}`;
  }
  if (periodUnit === FhirPeriodUnit.Day && period && period !== 1) {
    if (period === 2 && (!periodMax || periodMax === 2)) {
      return "every other day";
    }
    if (periodMax && periodMax !== period) {
      return `every ${stripTrailingZero(period)} to ${stripTrailingZero(periodMax)} days`;
    }
    return `every ${stripTrailingZero(period)} days`;
  }
  if (periodUnit === FhirPeriodUnit.Week && period) {
    if (period === 1 && (!periodMax || periodMax === 1)) {
      return "once weekly";
    }
    if (periodMax && periodMax !== period) {
      return `every ${stripTrailingZero(period)} to ${stripTrailingZero(periodMax)} weeks`;
    }
    return `every ${stripTrailingZero(period)} weeks`;
  }
  if (periodUnit === FhirPeriodUnit.Month && period) {
    if (period === 1 && (!periodMax || periodMax === 1)) {
      return "once monthly";
    }
    if (periodMax && periodMax !== period) {
      return `every ${stripTrailingZero(period)} to ${stripTrailingZero(periodMax)} months`;
    }
    return `every ${stripTrailingZero(period)} months`;
  }
  if (periodUnit === FhirPeriodUnit.Year && period) {
    if (period === 1 && (!periodMax || periodMax === 1)) {
      return "once yearly";
    }
    if (periodMax && periodMax !== period) {
      return `every ${stripTrailingZero(period)} to ${stripTrailingZero(periodMax)} years`;
    }
    return `every ${stripTrailingZero(period)} years`;
  }
  if (timingCode) {
    if (timingCode === "WK") {
      return "once weekly";
    }
    if (timingCode === "MO") {
      return "once monthly";
    }
    const map: Record<string, string> = {
      BID: "twice daily",
      TID: "three times daily",
      QID: "four times daily",
      QD: "once daily",
      QOD: "every other day",
      Q6H: "every 6 hours",
      Q8H: "every 8 hours"
    };
    if (map[timingCode]) {
      return map[timingCode];
    }
  }
  if (frequency && periodUnit === undefined && period === undefined) {
    if (frequency === 1) {
      return "once";
    }
    return `${stripTrailingZero(frequency)} times`;
  }
  return undefined;
}

function describeFrequencyCount(count: number | undefined): string | undefined {
  if (!count || count <= 0) {
    return undefined;
  }
  const dailyText = EN_TIMES_PER_DAY[count];
  if (dailyText) {
    return dailyText;
  }
  return `${stripTrailingZero(count)} times daily`;
}

function describeStandaloneOccurrenceCount(
  schedule: CanonicalScheduleExpr | undefined
): string | undefined {
  const count = schedule?.count;
  if (!count || count <= 0) {
    return undefined;
  }
  if (
    schedule?.frequency !== undefined ||
    schedule?.frequencyMax !== undefined ||
    schedule?.period !== undefined ||
    schedule?.periodMax !== undefined ||
    schedule?.periodUnit !== undefined ||
    schedule?.dayOfWeek?.length ||
    schedule?.when?.length ||
    schedule?.timeOfDay?.length ||
    schedule?.duration !== undefined ||
    schedule?.durationMax !== undefined ||
    schedule?.durationUnit !== undefined ||
    schedule?.timingCode
  ) {
    return undefined;
  }
  switch (count) {
    case 1:
      return "once";
    case 2:
      return "twice";
    default:
      return `${stripTrailingZero(count)} times`;
  }
}

function formatDoseShort(dose: CanonicalDoseExpr | undefined): string | undefined {
  if (!dose) {
    return undefined;
  }
  if (dose.range) {
    if (dose.range.low !== undefined && dose.range.high !== undefined) {
      const base = `${stripTrailingZero(dose.range.low)}-${stripTrailingZero(dose.range.high)}`;
      if (dose.unit) {
        return `${base} ${dose.unit}`;
      }
      return base;
    }
    if (dose.range.low !== undefined) {
      const base = `>=${stripTrailingZero(dose.range.low)}`;
      if (dose.unit) {
        return `${base} ${dose.unit}`;
      }
      return base;
    }
    if (dose.range.high !== undefined) {
      const base = `<=${stripTrailingZero(dose.range.high)}`;
      if (dose.unit) {
        return `${base} ${dose.unit}`;
      }
      return base;
    }
  }
  if (dose.value !== undefined) {
    if (dose.unit) {
      return `${stripTrailingZero(dose.value)} ${dose.unit}`;
    }
    return `${stripTrailingZero(dose.value)}`;
  }
  return undefined;
}

function formatDoseLong(dose: CanonicalDoseExpr | undefined): string | undefined {
  if (!dose) {
    return undefined;
  }
  if (dose.range) {
    if (dose.range.low !== undefined && dose.range.high !== undefined) {
      if (dose.unit) {
        return `${stripTrailingZero(dose.range.low)} to ${stripTrailingZero(dose.range.high)} ${pluralize(
          dose.unit,
          dose.range.high
        )}`;
      }
      return `${stripTrailingZero(dose.range.low)} to ${stripTrailingZero(dose.range.high)}`;
    }
    if (dose.range.low !== undefined) {
      if (dose.unit) {
        return `at least ${stripTrailingZero(dose.range.low)} ${pluralize(dose.unit, dose.range.low)}`;
      }
      return `at least ${stripTrailingZero(dose.range.low)}`;
    }
    if (dose.range.high !== undefined) {
      if (dose.unit) {
        return `up to ${stripTrailingZero(dose.range.high)} ${pluralize(dose.unit, dose.range.high)}`;
      }
      return `up to ${stripTrailingZero(dose.range.high)}`;
    }
  }
  if (dose.value !== undefined) {
    if (dose.unit) {
      return `${stripTrailingZero(dose.value)} ${pluralize(dose.unit, dose.value)}`;
    }
    return `${stripTrailingZero(dose.value)}`;
  }
  return undefined;
}

function summarizeMealTimingGroup(group: MealTimingGroup): string {
  let relationText = "with";
  if (group.relation === "before") {
    relationText = "before";
  } else if (group.relation === "after") {
    relationText = "after";
  }
  return `${relationText} ${joinWithAnd(group.meals)}`;
}

function collectWhenPhrases(
  schedule: CanonicalScheduleExpr | undefined,
  options?: TimingSummaryOptions
): string[] {
  const when = schedule?.when ?? [];
  if (!when.length) {
    return [];
  }
  const unique: EventTiming[] = [];
  const seen = new Set<EventTiming>();
  let hasSpecificAfter = false;
  let hasSpecificBefore = false;
  let hasSpecificWith = false;

  for (const code of when) {
    if (!seen.has(code)) {
      seen.add(code);
      unique.push(code);
      if (
        code === EventTiming["After Breakfast"] ||
        code === EventTiming["After Lunch"] ||
        code === EventTiming["After Dinner"]
      ) {
        hasSpecificAfter = true;
      }
      if (
        code === EventTiming["Before Breakfast"] ||
        code === EventTiming["Before Lunch"] ||
        code === EventTiming["Before Dinner"]
      ) {
        hasSpecificBefore = true;
      }
      if (code === EventTiming.Breakfast || code === EventTiming.Lunch || code === EventTiming.Dinner) {
        hasSpecificWith = true;
      }
    }
  }

  const filtered: EventTiming[] = [];
  for (const code of unique) {
    if (code === EventTiming["After Meal"] && hasSpecificAfter) {
      continue;
    }
    if (code === EventTiming["Before Meal"] && hasSpecificBefore) {
      continue;
    }
    if (code === EventTiming.Meal && hasSpecificWith) {
      continue;
    }
    filtered.push(code);
  }

  const mealGroup = getMealTimingGroup(filtered, options);
  if (!mealGroup) {
    const phrases: string[] = [];
    for (const code of filtered) {
      const text = WHEN_TEXT[code] ?? code;
      if (text) {
        phrases.push(text);
      }
    }
    return phrases;
  }

  const groupedCodes = new Set<EventTiming>(mealGroup.codes);
  const phrases: string[] = [];
  let insertedGroup = false;
  for (const code of filtered) {
    if (groupedCodes.has(code)) {
      if (!insertedGroup) {
        phrases.push(summarizeMealTimingGroup(mealGroup));
        insertedGroup = true;
      }
      continue;
    }
    const text = WHEN_TEXT[code] ?? code;
    if (text) {
      phrases.push(text);
    }
  }
  return phrases;
}

function joinWithAnd(parts: string[]): string {
  if (!parts.length) {
    return "";
  }
  if (parts.length === 1) {
    return parts[0];
  }
  if (parts.length === 2) {
    return `${parts[0]} and ${parts[1]}`;
  }
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function combineFrequencyAndEvents(
  frequency: string | undefined,
  events: string[]
): { frequency?: string; event?: string } {
  if (!frequency) {
    if (!events.length) {
      return {};
    }
    return { event: joinWithAnd(events) };
  }
  if (!events.length) {
    return { frequency };
  }
  if (events.length === 1 && events[0] === "at bedtime") {
    const lowerFrequency = frequency.toLowerCase();
    if (
      lowerFrequency === "twice daily" ||
      lowerFrequency === "three times daily" ||
      lowerFrequency === "four times daily"
    ) {
      return { frequency: `${frequency} and ${events[0]}` };
    }
  }
  return { frequency, event: joinWithAnd(events) };
}

function buildRoutePhrase(
  clause: CanonicalSigClause,
  grammar: RouteGrammar,
  hasSite: boolean
): string | undefined {
  if (typeof grammar.routePhrase === "function") {
    return grammar.routePhrase({ hasSite, clause });
  }
  if (typeof grammar.routePhrase === "string") {
    return grammar.routePhrase;
  }
  const text = clause.route?.text?.trim();
  if (!text) {
    return undefined;
  }
  const normalized = text.toLowerCase();
  if (normalized.startsWith("by ") || normalized.startsWith("per ") || normalized.startsWith("via ")) {
    return text;
  }
  if (normalized === "oral") {
    return "orally";
  }
  if (normalized === "intravenous") {
    return "intravenously";
  }
  if (normalized === "intramuscular") {
    return "intramuscularly";
  }
  if (normalized === "subcutaneous") {
    return "subcutaneously";
  }
  if (normalized === "topical") {
    return "topically";
  }
  if (normalized === "transdermal") {
    return "transdermally";
  }
  if (normalized === "intranasal" || normalized === "nasal") {
    return "via nasal route";
  }
  if (normalized.includes("inhal")) {
    return "via inhalation";
  }
  return `via ${text}`;
}

const ENGLISH_SPATIAL_PREPOSITIONS: Record<string, string> = {
  above: "above",
  around: "around",
  behind: "behind",
  below: "below",
  beneath: "beneath",
  between: "between",
  inside: "in",
  near: "near",
  outside: "outside",
  under: "under"
};

function renderSpatialSiteEnglish(
  relation: BodySiteSpatialRelation | undefined,
  grammar: RouteGrammar
): string | undefined {
  if (!relation?.relationText) {
    return undefined;
  }
  const rawTarget = relation.targetText ?? relation.targetCoding?.display;
  if (!rawTarget) {
    return undefined;
  }
  const resolvedTarget = resolveBodySitePhrase(rawTarget);
  const target = resolvedTarget?.englishObjectText ??
    `the ${rawTarget.charAt(0).toLowerCase()}${rawTarget.slice(1)}`;
  const preposition = ENGLISH_SPATIAL_PREPOSITIONS[relation.relationText];
  if (preposition) {
    return `${preposition} ${target}`;
  }
  switch (relation.relationText) {
    case "back":
    case "center":
    case "centre":
    case "front":
    case "left side":
    case "middle":
    case "right side":
    case "side":
    case "both sides":
    case "bilateral sides":
    case "top":
      return `${grammar.sitePreposition ?? "at"} ${
        relation.relationText.startsWith("both") || relation.relationText.startsWith("bilateral")
          ? relation.relationText
          : `the ${relation.relationText}`
      } of ${target}`.trim();
    default:
      return undefined;
  }
}

function formatSite(clause: CanonicalSigClause, grammar: RouteGrammar): string | undefined {
  let text = clause.site?.text?.trim();
  if (!text) {
    const spatialSite = renderSpatialSiteEnglish(clause.site?.spatialRelation, grammar);
    if (spatialSite) {
      return spatialSite;
    }
  }
  if (!text) {
    const display = clause.site?.coding?.display?.trim();
    if (display) {
      text = display.charAt(0).toLowerCase() + display.slice(1);
    } else {
      text = clause.site?.coding?.code?.trim();
    }
  }
  if (!text) {
    return undefined;
  }
  const resolvedSite = resolveBodySitePhrase(text);
  const normalizedText = resolvedSite?.displayText ?? text;
  const lower = normalizedText.toLowerCase();
  const routeText = clause.route?.text?.trim().toLowerCase();
  const isRectalRoute =
    clause.route?.code === RouteCode["Per rectum"] ||
    routeText === "rectum" ||
    routeText === "rectal";
  const isVaginalRoute =
    clause.route?.code === RouteCode["Per vagina"] ||
    routeText === "vagina" ||
    routeText === "vaginal";
  if (isRectalRoute && (lower === "rectum" || lower === "rectal")) {
    return undefined;
  }
  if (isVaginalRoute && (lower === "vagina" || lower === "vaginal")) {
    return undefined;
  }
  if (resolvedSite?.features.kind === "locative") {
    return resolvedSite.englishObjectText;
  }
  const preferredPreposition = resolvedSite?.preferredPreposition;
  let preposition = grammar.sitePreposition;
  if (!preposition || (preposition === "to" && preferredPreposition && preferredPreposition !== "to")) {
    preposition = preferredPreposition;
  }
  if (!preposition) {
    preposition = "at";
  }
  const noun = resolvedSite?.englishObjectText ?? `the ${normalizedText}`;
  return `${preposition} ${noun}`.trim();
}

function describeDayOfWeek(schedule: CanonicalScheduleExpr | undefined): string | undefined {
  const dayOfWeek = schedule?.dayOfWeek ?? [];
  if (!dayOfWeek.length) {
    return undefined;
  }
  const days: string[] = [];
  for (const day of dayOfWeek) {
    days.push(DAY_NAMES[day] ?? day);
  }
  return days.length ? `on ${joinWithAnd(days)}` : undefined;
}

function formatDurationShort(schedule: CanonicalScheduleExpr): string | undefined {
  if (schedule.duration === undefined || !schedule.durationUnit) {
    return undefined;
  }
  const base = stripTrailingZero(schedule.duration);
  const qualifier =
    schedule.durationMax !== undefined && schedule.durationMax !== schedule.duration
      ? `${base}-${stripTrailingZero(schedule.durationMax)}`
      : base;
  return `x${qualifier}${schedule.durationUnit}`;
}

function describeDuration(schedule: CanonicalScheduleExpr | undefined): string | undefined {
  if (!schedule || schedule.duration === undefined || !schedule.durationUnit) {
    return undefined;
  }
  const unit = schedule.durationUnit;
  const label = (value: number): string => {
    switch (unit) {
      case FhirPeriodUnit.Minute:
        return value === 1 ? "minute" : "minutes";
      case FhirPeriodUnit.Hour:
        return value === 1 ? "hour" : "hours";
      case FhirPeriodUnit.Day:
        return value === 1 ? "day" : "days";
      case FhirPeriodUnit.Week:
        return value === 1 ? "week" : "weeks";
      case FhirPeriodUnit.Month:
        return value === 1 ? "month" : "months";
      case FhirPeriodUnit.Year:
        return value === 1 ? "year" : "years";
      default:
        return value === 1 ? "unit" : "units";
    }
  };
  if (schedule.durationMax !== undefined && schedule.durationMax !== schedule.duration) {
    return `for ${stripTrailingZero(schedule.duration)} to ${stripTrailingZero(schedule.durationMax)} ${label(schedule.durationMax)}`;
  }
  return `for ${stripTrailingZero(schedule.duration)} ${label(schedule.duration)}`;
}

function shouldUseGenericMedicationObject(clause: CanonicalSigClause): boolean {
  const methodText = clause.method?.text?.trim();
  switch (methodText) {
    case "Apply sunscreen":
    case "Reapply sunscreen":
    case "Use shampoo":
      return false;
    default:
      return true;
  }
}

function shouldSuppressRoutePhrase(
  clause: CanonicalSigClause,
  grammar: RouteGrammar,
  verb: string
): boolean {
  if (clause.route?.code !== RouteCode["Oral route"]) {
    return false;
  }
  if (grammar.routePhrase !== "orally") {
    return false;
  }
  switch (verb) {
    case "Drink":
    case "Swallow":
      return true;
    default:
      return false;
  }
}

function formatShort(clause: CanonicalSigClause): string {
  const schedule = scheduleOf(clause);
  const parts: string[] = [];
  const dosePart = formatDoseShort(clause.dose);
  if (dosePart) {
    parts.push(dosePart);
  }
  const routeCode = clause.route?.code;
  const routeText = clause.route?.text;
  if (routeCode) {
    const short = ROUTE_SHORT[routeCode];
    if (short) {
      parts.push(short);
    } else if (routeText) {
      parts.push(routeText);
    }
  } else if (routeText) {
    parts.push(routeText);
  }
  if (schedule.timingCode) {
    parts.push(schedule.timingCode);
  } else if (
    schedule.frequency !== undefined &&
    schedule.frequencyMax !== undefined &&
    schedule.periodUnit === FhirPeriodUnit.Day &&
    (!schedule.period || schedule.period === 1)
  ) {
    parts.push(`${stripTrailingZero(schedule.frequency)}-${stripTrailingZero(schedule.frequencyMax)}x/d`);
  } else if (
    schedule.frequency &&
    schedule.periodUnit === FhirPeriodUnit.Day &&
    (!schedule.period || schedule.period === 1)
  ) {
    parts.push(`${stripTrailingZero(schedule.frequency)}x/d`);
  } else if (schedule.period && schedule.periodUnit) {
    const base = stripTrailingZero(schedule.period);
    const qualifier =
      schedule.periodMax && schedule.periodMax !== schedule.period
        ? `${base}-${stripTrailingZero(schedule.periodMax)}`
        : base;
    parts.push(`Q${qualifier}${schedule.periodUnit.toUpperCase()}`);
  }
  if (schedule.when?.length) {
    parts.push(schedule.when.join(" "));
  }
  if (schedule.dayOfWeek?.length) {
    const days: string[] = [];
    for (const day of schedule.dayOfWeek) {
      days.push(day.charAt(0).toUpperCase() + day.slice(1, 3));
    }
    parts.push(days.join(","));
  }
  if (schedule.timeOfDay?.length) {
    const times: string[] = [];
    for (const time of schedule.timeOfDay) {
      times.push(time.slice(0, 5));
    }
    parts.push(times.join(","));
  }
  if (schedule.count !== undefined) {
    parts.push(`x${stripTrailingZero(schedule.count)}`);
  }
  const durationShort = formatDurationShort(schedule);
  if (durationShort) {
    parts.push(durationShort);
  }
  if (clause.prn?.enabled) {
    const reason = getPreferredCanonicalPrnReasonText(clause.prn.reason, clause.prn.reasons);
    if (reason) {
      parts.push(`PRN ${reason}`);
    } else {
      parts.push("PRN");
    }
  }
  return parts.filter(Boolean).join(" ");
}

function formatLong(clause: CanonicalSigClause, options?: TimingSummaryOptions): string {
  const schedule = scheduleOf(clause);
  const grammar = resolveRouteGrammar(clause);
  const verb = resolveMethodVerb(clause, grammar);
  const explicitDosePart = formatDoseLong(clause.dose);
  const dosePart = explicitDosePart ?? (
    shouldUseGenericMedicationObject(clause) ? "the medication" : undefined
  );
  const sitePart = formatSite(clause, grammar);
  const routePart = shouldSuppressRoutePhrase(clause, grammar, verb)
    ? undefined
    : buildRoutePhrase(clause, grammar, Boolean(sitePart));
  const standaloneOccurrenceCount = describeStandaloneOccurrenceCount(schedule);
  const frequencyPart =
    describeFrequency(schedule) ??
    standaloneOccurrenceCount ??
    describeFrequencyCount(inferDailyOccurrenceCount(schedule, options));
  const eventParts = collectWhenPhrases(schedule, options);
  if (schedule.timeOfDay?.length) {
    const timeStrings: string[] = [];
    for (const time of schedule.timeOfDay) {
      const parts = time.split(":");
      const hours = Number(parts[0]);
      const minutes = Number(parts[1]);
      if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
        continue;
      }
      const isAm = hours < 12;
      const displayHours = hours % 12 || 12;
      const displayMinutes = minutes < 10 ? `0${minutes}` : `${minutes}`;
      timeStrings.push(`${displayHours}:${displayMinutes}${isAm ? " am" : " pm"}`);
    }
    if (timeStrings.length) {
      eventParts.push(`at ${timeStrings.join(", ")}`);
    }
  }
  const timing = combineFrequencyAndEvents(frequencyPart, eventParts);
  const dayPart = describeDayOfWeek(schedule);
  const countPart =
    schedule.count !== undefined && !standaloneOccurrenceCount
      ? `for ${stripTrailingZero(schedule.count)} ${schedule.count === 1 ? "dose" : "doses"}`
      : undefined;
  const durationPart = describeDuration(schedule);
  const reason = getPreferredCanonicalPrnReasonText(clause.prn?.reason, clause.prn?.reasons);
  const asNeededPart = clause.prn?.enabled ? (reason ? `as needed for ${reason}` : "as needed") : undefined;

  const segments: string[] = [];
  if (dosePart) {
    segments.push(dosePart);
  }
  if (routePart) {
    segments.push(routePart);
  }
  if (timing.frequency) {
    segments.push(timing.frequency);
  }
  if (timing.event) {
    segments.push(timing.event);
  }
  if (dayPart) {
    segments.push(dayPart);
  }
  if (countPart) {
    segments.push(countPart);
  }
  if (durationPart) {
    segments.push(durationPart);
  }
  if (asNeededPart) {
    segments.push(asNeededPart);
  }
  if (sitePart) {
    segments.push(sitePart);
  }
  const body = segments.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const instructionPhrases: string[] = [];
  const instructionText = formatAdditionalInstructions(clause);
  if (instructionText) {
    instructionPhrases.push(instructionText);
  }
  const patientInstruction = formatPatientInstructionSentence(
    clause.patientInstruction
  );
  if (patientInstruction) {
    instructionPhrases.push(patientInstruction);
  }
  const trailingInstructionText = instructionPhrases.join(" ").trim() || undefined;
  if (!body) {
    if (!trailingInstructionText) {
      return `${verb}.`;
    }
    return `${verb}. ${trailingInstructionText}`.trim();
  }
  const baseSentence = `${verb} ${body}.`;
  return trailingInstructionText ? `${baseSentence} ${trailingInstructionText}` : baseSentence;
}

function formatAdditionalInstructions(clause: CanonicalSigClause): string | undefined {
  const instructions = clause.additionalInstructions ?? [];
  if (!instructions.length) {
    return undefined;
  }
  const phrases: string[] = [];
  const grammar = resolveRouteGrammar(clause);
  const verb = resolveMethodVerb(clause, grammar);
  for (const instruction of instructions) {
    if (instruction.coding?.code === SLOWLY_QUALIFIER_CODE) {
      const contextual = verb ? `${verb} slowly` : "Slowly";
      phrases.push(contextual);
      continue;
    }
    if (
      instruction.coding?.code === EMPTY_STOMACH_QUALIFIER_CODE ||
      instruction.frames?.some(
        (frame) =>
          frame.relation === AdviceRelation.On &&
          frame.args.some(
            (arg) =>
              arg.role === AdviceArgumentRole.MealState &&
              arg.conceptId === "empty_stomach"
          )
      )
    ) {
      phrases.push("On an empty stomach");
      continue;
    }
    const text = instruction.text ?? instruction.coding?.display;
    if (!text) {
      continue;
    }
    const trimmed = text.trim();
    if (trimmed) {
      phrases.push(trimmed);
    }
  }
  if (!phrases.length) {
    return undefined;
  }
  return phrases.map((phrase) => (/[.!?]$/.test(phrase) ? phrase : `${phrase}.`)).join(" ").trim();
}

function firstCanonicalClause(internal: ParserState): CanonicalSigClause {
  const clauses = internal.clauses;
  if (clauses.length > 0) {
    return clauses[0];
  }
  return {
    kind: "administration",
    rawText: internal.input,
    raw: { start: 0, end: internal.input.length, text: internal.input },
    leftovers: [],
    evidence: [],
    confidence: 0
  };
}

export function formatCanonicalClause(
  clause: CanonicalSigClause,
  style: "short" | "long",
  localization?: SigLocalization,
  options?: TimingSummaryOptions
): string {
  let shortDefault: string | undefined;
  let longDefault: string | undefined;

  const formatDefault = (target: "short" | "long") => {
    switch (target) {
      case "short":
        if (shortDefault === undefined) {
          shortDefault = formatShort(clause);
        }
        return shortDefault;
      case "long":
        if (longDefault === undefined) {
          longDefault = formatLong(clause, options);
        }
        return longDefault;
    }
  };

  if (!localization) {
    return formatDefault(style);
  }

  if (style === "short" && localization.formatShort) {
    const context: SigShortContext = {
      style: "short",
      clause,
      defaultText: formatDefault("short"),
      groupMealTimingsByRelation: Boolean(options?.groupMealTimingsByRelation),
      includeTimesPerDaySummary: Boolean(options?.includeTimesPerDaySummary),
      formatDefault
    };
    return localization.formatShort(context);
  }

  if (style === "long" && localization.formatLong) {
    const context: SigLongContext = {
      style: "long",
      clause,
      defaultText: formatDefault("long"),
      groupMealTimingsByRelation: Boolean(options?.groupMealTimingsByRelation),
      includeTimesPerDaySummary: Boolean(options?.includeTimesPerDaySummary),
      formatDefault
    };
    return localization.formatLong(context);
  }

  return formatDefault(style);
}

export function formatInternal(
  internal: ParserState,
  style: "short" | "long",
  localization?: SigLocalization,
  options?: TimingSummaryOptions
): string {
  return formatCanonicalClause(firstCanonicalClause(internal), style, localization, options);
}

function stripTrailingZero(value: number): string {
  const text = value.toString();
  if (text.includes(".")) {
    return text.replace(/\.0+$/, "").replace(/0+$/, "");
  }
  return text;
}
