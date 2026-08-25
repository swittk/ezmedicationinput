import { buildCanonicalSigClauses, canonicalClauseHasAdministrationSemantics } from "./ir";
import {
  collectLocalizedWhenPhrases,
  combineLocalizedFrequencyAndEvents,
  type LocalizedTimingGrammar
} from "./localized-timing";
import { ParserState } from "./parser-state";
import type { SigLocalization, SigLongContext, SigShortContext } from "./i18n";
import { getLocalizedCanonicalPrnReasonText, getPreferredCanonicalPrnReasonText } from "./prn";
import { medicationInstructionActionLocaleRealizerConfig, resolveMedicationInstructionAction } from "./instruction-action-terminology";
import { baseLanguageTag } from "./localization";
import { getMedicationInstructionConcept } from "./instruction-concept-terminology";
import {
  instructionGraphHasNovelNonWarningContent,
  instructionGraphPrimaryAdministrationModality,
  instructionGraphPrimarySiteRelation,
  instructionGraphRichPrimaryAction,
  instructionGraphRoundTripPrimaryAction,
  instructionGraphRepresentsText,
  instructionGraphSingleActionRepresentsText,
  instructionGraphTextParticipatesInRelation,
  realizeInstructionAction,
  realizeInstructionGraph
} from "./instruction-graph";
import { resolveBodySitePhrase } from "./body-site-grammar";
import {
  getUniqueAdviceRelationByGrammarFeature,
  getBodySiteRelationRealization,
  localizeAdviceRelation,
  relationHasGrammarFeature,
  relationHasSemanticClass
} from "./relation-terminology";
import { resolveEventTimingExpression } from "./event-timing-expression";
import {
  AdviceArgumentRole,
  AdviceModality,
  AdvicePolarity,
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
  [RouteCode["Sublingual route"]]: { verb: "Use", routePhrase: "sublingually" },
  [RouteCode["Buccal route"]]: { verb: "Use", routePhrase: "buccally" },
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
    routePhrase: "transdermally",
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

function explicitRoundTripRoutePhrase(route: RouteCode | undefined): string | undefined {
  if (!route) return undefined;
  switch (route) {
    case RouteCode["Oral route"]: return "orally";
    case RouteCode["Ophthalmic route"]: return "via ophthalmic route";
    case RouteCode["Intravitreal route (qualifier value)"]: return "via intravitreal route";
    case RouteCode["Otic route"]: return "via otic route";
    case RouteCode["Nasal route"]: return "via nasal route";
    case RouteCode["Respiratory tract route (qualifier value)"]: return "via inhalation";
    case RouteCode["Topical route"]: return "topically";
    case RouteCode["Transdermal route"]: return "transdermally";
    case RouteCode["Subcutaneous route"]: return "subcutaneously";
    case RouteCode["Intramuscular route"]: return "intramuscularly";
    case RouteCode["Intravenous route"]: return "intravenously";
    case RouteCode["Per rectum"]: return "rectally";
    case RouteCode["Per vagina"]: return "vaginally";
    default: return undefined;
  }
}

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
      case "FTU":
        return "FTU";
      default:
        return unit;
    }
  }
  if (unit.endsWith(" ribbon")) {
    return unit;
  }
  if (unit.endsWith(" line")) {
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
    case "spray":
      return "sprays";
    case "patch":
      return "patches";
    case "ring":
      return "rings";
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
    case "palm":
      return "palms";
    case "handprint":
      return "handprints";
    case "shot glass":
      return "shot glasses";
    case "click":
      return "clicks";
    case "vial":
      return "vials";
    case "ampule":
      return "ampules";
    case "packet":
      return "packets";
    case "sachet":
      return "sachets";
    case "stick-pack":
      return "stick-packs";
    case "application":
      return "applications";
    case "FTU":
      return "FTU";
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
  const instruction = /^(after|before|with)\b/.test(normalized) && !/[,;]/.test(trimmed)
    ? `Use ${trimmed}`
    : trimmed;
  const sentence = /^[.!?]$/.test(instruction.slice(-1)) ? instruction : `${instruction}.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function describeAlternateEventCadenceEnglish(
  schedule: CanonicalScheduleExpr | undefined
): string | undefined {
  if (
    schedule?.period !== 2 || schedule.periodUnit !== FhirPeriodUnit.Day ||
    schedule.when?.length !== 1 || schedule.frequency !== undefined || schedule.frequencyMax !== undefined
  ) return undefined;
  if (schedule.when[0] === EventTiming.Night) return "every other night";
  if (schedule.when[0] === EventTiming.Morning) return "every other morning";
  return undefined;
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
    if (
      frequency !== undefined && frequencyMax !== undefined && frequencyMax !== frequency &&
      period === 1 && (!periodMax || periodMax === 1)
    ) {
      return `${stripTrailingZero(frequency)} to ${stripTrailingZero(frequencyMax)} times weekly`;
    }
    if (
      schedule?.dayOfWeek?.length && period === 1 && (!periodMax || periodMax === 1) &&
      frequency === undefined && schedule.dayOfWeek.length > 1
    ) {
      return undefined;
    }
    if (period === 1 && (!periodMax || periodMax === 1)) {
      if (frequency === 2) return "twice weekly";
      return frequency !== undefined && frequency !== 1
        ? `${stripTrailingZero(frequency)} times weekly`
        : "once weekly";
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
  if (!count || count <= 0 || schedule?.countMax !== undefined) {
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
    schedule?.offset !== undefined ||
    schedule?.offsetMin !== undefined ||
    schedule?.offsetMax !== undefined ||
    Boolean(schedule?.activityTiming?.length) ||
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

function formatEventOffsetQuantityEnglish(minutes: number): string {
  const seconds = Number((minutes * 60).toFixed(9));
  if (minutes < 1 && Number.isInteger(seconds)) {
    return `${stripTrailingZero(seconds)} second${seconds === 1 ? "" : "s"}`;
  }
  if (minutes >= 24 * 60 && minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${stripTrailingZero(days)} day${days === 1 ? "" : "s"}`;
  }
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${stripTrailingZero(hours)} hour${hours === 1 ? "" : "s"}`;
  }
  return `${stripTrailingZero(minutes)} minute${minutes === 1 ? "" : "s"}`;
}

function formatActivityTimingEnglish(schedule: CanonicalScheduleExpr | undefined): string[] {
  const result: string[] = [];
  for (const timing of schedule?.activityTiming ?? []) {
    const definition = timing.activity.coding?.code
      ? getMedicationInstructionConcept(timing.activity.coding.code)
      : undefined;
    const activity = definition?.display ?? timing.activity.text;
    const relation = timing.relation;
    const value = timing.offsetMin ?? timing.offsetMax ?? timing.offset;
    if (value === undefined) {
      result.push(`${relation} ${activity}`);
      continue;
    }
    const quantity = formatEventOffsetQuantityEnglish(value);
    const qualifier = timing.offsetMin !== undefined ? "at least "
      : timing.offsetMax !== undefined ? "at most " : "";
    result.push(`${qualifier}${quantity} ${relation} ${activity}`);
  }
  return result;
}

function formatEventOffsetEnglish(
  eventText: string,
  schedule: CanonicalScheduleExpr
): string {
  const value = schedule.offsetMin ?? schedule.offsetMax ?? schedule.offset;
  if (value === undefined) return eventText;
  const quantity = formatEventOffsetQuantityEnglish(value);
  if (schedule.offsetMin !== undefined) return `at least ${quantity} ${eventText}`;
  if (schedule.offsetMax !== undefined) return `at most ${quantity} ${eventText}`;
  return `${quantity} ${eventText}`;
}

const EN_TIMING_GRAMMAR: LocalizedTimingGrammar = {
  whenText: WHEN_TEXT,
  joinList: joinWithAnd,
  summarizeMealTimingGroup,
  formatEventOffset: formatEventOffsetEnglish,
  bedtimeJoinStyle: (dailyCount) => {
    if (dailyCount === 1) {
      return "adjacent";
    }
    if (dailyCount === 2 || dailyCount === 3 || dailyCount === 4) {
      return "conjunction";
    }
    return "separate";
  }
};

function collectWhenPhrases(
  schedule: CanonicalScheduleExpr | undefined,
  options?: TimingSummaryOptions
): string[] {
  return collectLocalizedWhenPhrases(schedule, EN_TIMING_GRAMMAR, options);
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
  schedule: CanonicalScheduleExpr | undefined,
  frequency: string | undefined,
  events: string[],
  options?: TimingSummaryOptions
): { frequency?: string; event?: string } {
  return combineLocalizedFrequencyAndEvents(
    schedule,
    frequency,
    events,
    EN_TIMING_GRAMMAR,
    options
  );
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
  const realization = getBodySiteRelationRealization(relation.relationText, "en");
  if (!realization) return undefined;
  if (realization.strategy === "prefix") {
    return `${realization.surface} ${target}`;
  }
  if (realization.strategy === "partitive") {
    const head = realization.article === "none"
      ? realization.surface
      : `the ${realization.surface}`;
    return `${grammar.sitePreposition ?? "at"} ${head} of ${target}`.trim();
  }
  return `${target} ${realization.surface}`;
}

function formatSite(
  clause: CanonicalSigClause,
  grammar: RouteGrammar,
  directObject = false
): string | undefined {
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
  const perTargetNoun = clause.dose ? resolvedSite?.definition?.perTargetText : undefined;
  const noun = perTargetNoun ?? resolvedSite?.englishObjectText ?? `the ${normalizedText}`;
  if (directObject) return noun;
  const preferredPreposition = resolvedSite?.preferredPreposition;
  const primarySiteRelation = instructionGraphPrimarySiteRelation(clause);
  const sourcePreposition = relationHasSemanticClass(primarySiteRelation, "locative")
    ? localizeAdviceRelation(primarySiteRelation, "en")
    : undefined;
  let preposition = sourcePreposition ?? grammar.sitePreposition;
  if (!preposition || (preposition === "to" && preferredPreposition && preferredPreposition !== "to")) {
    preposition = preferredPreposition;
  }
  if (!preposition) {
    preposition = "at";
  }
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

function describeOccurrenceCapEnglish(schedule: CanonicalScheduleExpr | undefined): string | undefined {
  const cap = schedule?.occurrenceCap;
  if (!cap) return undefined;
  const unit = cap.periodUnit === FhirPeriodUnit.Day ? "day"
    : cap.periodUnit === FhirPeriodUnit.Week ? "week"
      : cap.periodUnit === FhirPeriodUnit.Hour ? "hour"
        : cap.periodUnit === FhirPeriodUnit.Month ? "month"
          : cap.periodUnit === FhirPeriodUnit.Year ? "year"
            : cap.periodUnit === FhirPeriodUnit.Minute ? "minute" : cap.periodUnit;
  const period = cap.period === 1 ? unit : `${stripTrailingZero(cap.period)} ${unit}s`;
  return `maximum ${stripTrailingZero(cap.max)} doses per ${period}`;
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
  if (
    clause.route?.code === RouteCode["Topical route"] &&
    resolveMedicationInstructionAction(verb)?.code === "shampoo"
  ) {
    return true;
  }
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
  if (schedule.countMax !== undefined) {
    parts.push(`x${stripTrailingZero(schedule.count ?? 1)}-${stripTrailingZero(schedule.countMax)}`);
  } else if (schedule.count !== undefined) {
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

const SPREAD_THINLY_INSTRUCTION_CODE = "420162004";

const ENGLISH_MODALITY_PREFIX: Partial<Record<AdviceModality, string>> = {
  [AdviceModality.May]: "May",
  [AdviceModality.Can]: "Can",
  [AdviceModality.Might]: "Might",
  [AdviceModality.Could]: "Could",
  [AdviceModality.Should]: "Should",
  [AdviceModality.Must]: "Must"
};

function applyEnglishAdministrationModality(verb: string, clause: CanonicalSigClause): string {
  const modality = instructionGraphPrimaryAdministrationModality(clause);
  const prefix = modality ? ENGLISH_MODALITY_PREFIX[modality] : undefined;
  if (!prefix) return verb;
  return `${prefix} ${verb.charAt(0).toLowerCase()}${verb.slice(1)}`;
}

function formatLong(clause: CanonicalSigClause, options?: TimingSummaryOptions): string {
  const schedule = scheduleOf(clause);
  const grammar = resolveRouteGrammar(clause);
  const baseVerb = resolveMethodVerb(clause, grammar);
  const verb = applyEnglishAdministrationModality(baseVerb, clause);
  const explicitDosePart = formatDoseLong(clause.dose);
  const integratedThinLayer = options?.realizationMode !== "roundtrip" &&
    !explicitDosePart &&
    (clause.additionalInstructions ?? []).find((instruction) =>
      instruction.coding?.code === SPREAD_THINLY_INSTRUCTION_CODE
    );
  const methodDefinition = resolveMedicationInstructionAction(clause.method?.text ?? baseVerb);
  const directSiteObject = Boolean(
    !explicitDosePart && medicationInstructionActionLocaleRealizerConfig(
      methodDefinition?.realizerConfig,
      "en"
    )?.directSiteObject
  );
  const dosePart = explicitDosePart ?? (
    integratedThinLayer ? "a thin layer" :
    !directSiteObject && shouldUseGenericMedicationObject(clause) ? "the medication" : undefined
  );
  const sitePart = formatSite(clause, grammar, directSiteObject);
  const roundTrip = options?.realizationMode === "roundtrip";
  let routePart = shouldSuppressRoutePhrase(clause, grammar, baseVerb)
    ? undefined
    : buildRoutePhrase(clause, grammar, Boolean(sitePart));
  if (roundTrip && clause.route?.code) {
    routePart = explicitRoundTripRoutePhrase(clause.route.code) ?? routePart;
  }
  const standaloneOccurrenceCount = describeStandaloneOccurrenceCount(schedule);
  const alternateEventCadence = options?.realizationMode !== "roundtrip"
    ? describeAlternateEventCadenceEnglish(schedule)
    : undefined;
  const frequencyPart =
    alternateEventCadence ??
    describeFrequency(schedule) ??
    standaloneOccurrenceCount ??
    describeFrequencyCount(inferDailyOccurrenceCount(schedule, options));
  const eventParts = alternateEventCadence ? [] : collectWhenPhrases(schedule, options);
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
  const timing = combineFrequencyAndEvents(schedule, frequencyPart, eventParts, options);
  const dayPart = describeDayOfWeek(schedule);
  const countPart = schedule.countMax !== undefined && !standaloneOccurrenceCount
    ? `for up to ${stripTrailingZero(schedule.countMax)} doses`
    : schedule.count !== undefined && !standaloneOccurrenceCount
      ? `for ${stripTrailingZero(schedule.count)} ${schedule.count === 1 ? "dose" : "doses"}`
      : undefined;
  const durationPart = describeDuration(schedule);
  const occurrenceCapPart = describeOccurrenceCapEnglish(schedule);
  const reason = getLocalizedCanonicalPrnReasonText(clause.prn?.reason, clause.prn?.reasons, "en");
  const triggerReason = clause.prn?.reasons?.find((candidate) => candidate.triggerPhase === "onset") ??
    (clause.prn?.reason?.triggerPhase === "onset" ? clause.prn.reason : undefined);
  const onsetReason = triggerReason
    ? getLocalizedCanonicalPrnReasonText(triggerReason, undefined, "en")
    : undefined;
  const asNeededPart = clause.prn?.enabled
    ? onsetReason ? `at onset of ${onsetReason}`
      : reason ? `as needed for ${reason}` : "as needed"
    : undefined;

  const segments: string[] = [];
  if (dosePart) {
    segments.push(dosePart);
  }
  if (directSiteObject && sitePart) {
    segments.push(sitePart);
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
  for (const activityTiming of formatActivityTimingEnglish(schedule)) {
    segments.push(activityTiming);
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
  if (occurrenceCapPart) {
    segments.push(occurrenceCapPart);
  }
  if (roundTrip && sitePart && asNeededPart) {
    segments.push(sitePart);
  }
  if (asNeededPart) {
    segments.push(asNeededPart);
  }
  if (sitePart && !directSiteObject && !(roundTrip && asNeededPart)) {
    segments.push(sitePart);
  }
  const body = segments.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const richPrimaryGraphAction = options?.realizationMode !== "roundtrip"
    ? instructionGraphRichPrimaryAction(clause)
    : undefined;
  const richPrimaryGraphText = richPrimaryGraphAction
    ? realizeInstructionAction(richPrimaryGraphAction, "en")
    : undefined;
  const richPrimaryHasSite = Boolean(
    richPrimaryGraphAction?.args.some((arg) => arg.role === AdviceArgumentRole.Site)
  );
  const richPrimaryCoversSingleEvent = Boolean(
    richPrimaryGraphAction && schedule?.when?.length === 1 &&
    richPrimaryGraphAction.args.some((arg) => {
      if (arg.role !== AdviceArgumentRole.Time) return false;
      if (arg.normalized?.toUpperCase() === schedule.when?.[0]) return true;
      const parts = (arg.normalized ?? arg.text).toLowerCase().split(/\s+/).filter((part) => part && part !== "the");
      for (let index = 0; index < parts.length; index += 1) {
        if (resolveEventTimingExpression(parts, index)?.timing === schedule.when?.[0]) return true;
      }
      return false;
    })
  );
  const graphRegimenTail: string[] = [];
  if (richPrimaryGraphText) {
    if (routePart) graphRegimenTail.push(routePart);
    if (timing.frequency) graphRegimenTail.push(timing.frequency);
    if (timing.event && !richPrimaryCoversSingleEvent) graphRegimenTail.push(timing.event);
    graphRegimenTail.push(...formatActivityTimingEnglish(schedule));
    if (dayPart) graphRegimenTail.push(dayPart);
    if (countPart) graphRegimenTail.push(countPart);
    if (durationPart) graphRegimenTail.push(durationPart);
    if (occurrenceCapPart) graphRegimenTail.push(occurrenceCapPart);
    if (asNeededPart) graphRegimenTail.push(asNeededPart);
    if (sitePart && !richPrimaryHasSite) graphRegimenTail.push(sitePart);
  }
  const richGraphAdministrationSentence = richPrimaryGraphText
    ? formatPatientInstructionSentence(
        [richPrimaryGraphText, ...graphRegimenTail].filter(Boolean).join(" ")
      )
    : undefined;
  const primaryGraphAction = roundTrip
    ? instructionGraphRoundTripPrimaryAction(clause)
    : undefined;
  const instructionPhrases: string[] = [];
  const hasCodedAdditionalInstruction = Boolean(
    clause.additionalInstructions?.some((instruction) => instruction.coding?.code)
  );
  const normalizeInstruction = (value: string) => value.toLowerCase().replace(/[\s,;:.()]+/g, " ").trim();
  const graphWarnings = clause.instructionGraph?.actions.filter((action) =>
    action.polarity === AdvicePolarity.Negate
  ) ?? [];
  const positionedGraph = Boolean(clause.instructionGraph?.primaryAdministrationSpan);
  const graphOwnedAdditional = (clause.additionalInstructions ?? []).filter((instruction) => {
    if (instruction.coding?.code || !instruction.text || !clause.instructionGraph) return false;
    const normalized = normalizeInstruction(instruction.text);
    const representedByWarning = graphWarnings.some((action) => {
      const source = normalizeInstruction(action.sourceText);
      return source === normalized || source.includes(normalized) || normalized.includes(source);
    });
    return instructionGraphRepresentsText(clause.instructionGraph, instruction.text) && (
      representedByWarning || !instruction.frames?.length ||
      (positionedGraph &&
        instructionGraphSingleActionRepresentsText(clause.instructionGraph, instruction.text) &&
        instructionGraphTextParticipatesInRelation(clause.instructionGraph, instruction.text)) ||
      (!canonicalClauseHasAdministrationSemantics(clause) &&
        instructionGraphSingleActionRepresentsText(clause.instructionGraph, instruction.text))
    );
  });
  const additionalForDirectRendering = (clause.additionalInstructions ?? []).filter((instruction) =>
    graphOwnedAdditional.indexOf(instruction) === -1 && instruction !== integratedThinLayer
  );
  const additionalTexts = additionalForDirectRendering
    .map((instruction) => instruction.text?.trim())
    .filter((text): text is string => Boolean(text));
  const additionalSemanticSourceTexts = additionalTexts.slice();
  for (const instruction of additionalForDirectRendering) {
    for (const frame of instruction.frames ?? []) {
      const source = frame.sourceText?.trim();
      if (source && additionalSemanticSourceTexts.indexOf(source) === -1) {
        additionalSemanticSourceTexts.push(source);
      }
    }
  }
  const allAdditionalRepresentedByGraphWarnings = Boolean(
    graphWarnings.length &&
    additionalTexts.every((text) => {
      const normalized = normalizeInstruction(text);
      return graphWarnings.some((action) => {
        const source = normalizeInstruction(action.sourceText);
        return source === normalized || source.includes(normalized) || normalized.includes(source);
      });
    })
  );
  const positionedRoundTrip = Boolean(roundTrip && positionedGraph);
  const graphWholeInstruction = clause.instructionGraph &&
    !positionedGraph &&
    !hasCodedAdditionalInstruction &&
    allAdditionalRepresentedByGraphWarnings
      ? realizeInstructionGraph(clause.instructionGraph, "en", {
          includeWarnings: true,
          omitCanonicalAdministration: clause,
          preferSourceText: roundTrip,
          roundtripSafe: roundTrip,
          omitSourceTexts: additionalSemanticSourceTexts
        })
      : undefined;
  if (!graphWholeInstruction) {
    const directInstruction = formatAdditionalInstructions({
      ...clause,
      additionalInstructions: additionalForDirectRendering
    });
    if (directInstruction) instructionPhrases.push(directInstruction);
    const graphWarning = clause.instructionGraph && !positionedGraph
      ? realizeInstructionGraph(clause.instructionGraph, "en", {
          onlyWarnings: true,
          omitCanonicalAdministration: clause,
          preferSourceText: roundTrip,
          roundtripSafe: roundTrip,
          omitSourceTexts: additionalSemanticSourceTexts
        })
      : undefined;
    const graphWarningText = graphWarning ? formatPatientInstructionSentence(graphWarning) : undefined;
    if (graphWarningText && !instructionPhrases.some((value) =>
      normalizeInstruction(value).includes(normalizeInstruction(graphWarningText)) ||
      normalizeInstruction(graphWarningText).includes(normalizeInstruction(value))
    )) {
      instructionPhrases.push(graphWarningText);
    }
  }
  const representedInstructionTexts = additionalForDirectRendering
    .map((instruction) => instruction.text)
    .filter((text): text is string => Boolean(text));
  const preGraphInstruction = positionedGraph && clause.instructionGraph
    ? realizeInstructionGraph(clause.instructionGraph, "en", {
        includeWarnings: true,
        omitCanonicalAdministration: clause,
        preferSourceText: roundTrip,
        roundtripSafe: roundTrip,
        omitSourceTexts: additionalSemanticSourceTexts,
        position: "pre"
      })
    : undefined;
  const graphPrimaryForOmission = primaryGraphAction ?? richPrimaryGraphAction;
  const postGraphOmissions = graphPrimaryForOmission
    ? [...additionalSemanticSourceTexts, graphPrimaryForOmission.sourceText]
    : additionalSemanticSourceTexts;
  const postGraphInstruction = positionedGraph && clause.instructionGraph
    ? realizeInstructionGraph(clause.instructionGraph, "en", {
        includeWarnings: true,
        omitCanonicalAdministration: clause,
        preferSourceText: roundTrip,
        roundtripSafe: roundTrip,
        omitSourceTexts: postGraphOmissions,
        position: "post"
      })
    : undefined;
  const graphInstruction = graphWholeInstruction ?? postGraphInstruction ?? (
    !positionedGraph && clause.instructionGraph &&
    instructionGraphHasNovelNonWarningContent(clause.instructionGraph, representedInstructionTexts)
      ? realizeInstructionGraph(clause.instructionGraph, "en", {
          includeWarnings: false,
          omitCanonicalAdministration: clause,
          preferSourceText: roundTrip,
          roundtripSafe: roundTrip,
          omitSourceTexts: postGraphOmissions
        })
      : undefined
  );
  const primarySpanForFlow = clause.instructionGraph?.primaryAdministrationSpan;
  const graphActionsForFlow = clause.instructionGraph?.actions ?? [];
  const lastPreActionForFlow = primarySpanForFlow
    ? graphActionsForFlow.filter((action) => action.span.end <= primarySpanForFlow.start)
        .sort((a, b) => b.span.end - a.span.end)[0]
    : undefined;
  const firstPostActionForFlow = primarySpanForFlow
    ? graphActionsForFlow.filter((action) => action.span.start >= primarySpanForFlow.end)
        .sort((a, b) => a.span.start - b.span.start)[0]
    : undefined;
  const graphFlowSource = clause.instructionGraph?.sourceText ?? clause.rawText;
  const noStrongBoundaryForFlow = (start: number, end: number): boolean =>
    !/[.!?;]/u.test(graphFlowSource.slice(start, end));
  const preFlowsIntoAdministration = Boolean(
    !roundTrip && preGraphInstruction && primarySpanForFlow && lastPreActionForFlow &&
    lastPreActionForFlow.polarity !== AdvicePolarity.Negate &&
    noStrongBoundaryForFlow(lastPreActionForFlow.span.end, primarySpanForFlow.start)
  );
  const postFlowsFromAdministration = Boolean(
    !roundTrip && postGraphInstruction && primarySpanForFlow && firstPostActionForFlow &&
    firstPostActionForFlow.polarity !== AdvicePolarity.Negate &&
    noStrongBoundaryForFlow(primarySpanForFlow.end, firstPostActionForFlow.span.start)
  );

  const graphOwnsPatientInstruction = Boolean(
    richPrimaryGraphAction && clause.patientInstruction && clause.instructionGraph &&
    instructionGraphSingleActionRepresentsText(clause.instructionGraph, clause.patientInstruction)
  );
  const patientInstruction = postFlowsFromAdministration
    ? undefined
    : formatPatientInstructionSentence(
        graphInstruction ?? (positionedGraph || graphOwnsPatientInstruction ? undefined : clause.patientInstruction)
      );
  if (patientInstruction) instructionPhrases.push(patientInstruction);
  const trailingInstructionText = instructionPhrases.join(" ").trim() || undefined;
  const hasExplicitMethod = Boolean(clause.method?.text?.trim() || clause.method?.coding?.code);
  const graphSourceIsEnglish = !clause.instructionGraph?.sourceLocale ||
    baseLanguageTag(clause.instructionGraph.sourceLocale) === "en";
  if (
    roundTrip && !hasExplicitMethod && graphSourceIsEnglish &&
    clause.instructionGraph?.sourceText.trim()
  ) {
    return clause.instructionGraph.sourceText.trim();
  }
  if (!canonicalClauseHasAdministrationSemantics(clause)) {
    const wholeGraph = clause.instructionGraph
      ? realizeInstructionGraph(clause.instructionGraph, "en", {
          includeWarnings: true,
          preferSourceText: roundTrip,
          roundtripSafe: roundTrip
        })
      : undefined;
    const wholeGraphText = formatPatientInstructionSentence(wholeGraph);
    const parts: string[] = [];
    for (const value of [wholeGraphText, ...instructionPhrases]) {
      if (!value) continue;
      const normalized = normalizeInstruction(value);
      if (parts.some((existing) => {
        const candidate = normalizeInstruction(existing);
        return candidate === normalized || candidate.includes(normalized) || normalized.includes(candidate);
      })) continue;
      parts.push(value);
    }
    return parts.join(" ").trim() || `${verb}.`;
  }
  const leadingInstructionText = preFlowsIntoAdministration
    ? undefined
    : preGraphInstruction
      ? formatPatientInstructionSentence(preGraphInstruction)
      : undefined;
  const graphRepresentsDose = !clause.dose || Boolean(clause.instructionGraph?.actions.some((action) =>
    action.args.some((arg) =>
      arg.role === AdviceArgumentRole.Amount &&
      arg.quantity?.value === clause.dose?.value &&
      arg.quantity?.range?.low === clause.dose?.range?.low &&
      arg.quantity?.range?.high === clause.dose?.range?.high &&
      arg.quantity?.unit === clause.dose?.unit
    )
  ));
  const hasAdministrationTiming = Boolean(
    schedule.frequency !== undefined || schedule.frequencyMax !== undefined ||
    schedule.period !== undefined || schedule.periodMax !== undefined ||
    schedule.when?.length || schedule.dayOfWeek?.length || schedule.timeOfDay?.length ||
    schedule.count !== undefined || schedule.countMax !== undefined || schedule.timingCode ||
    schedule.duration !== undefined || schedule.durationMax !== undefined ||
    schedule.durationUnit !== undefined || schedule.offset !== undefined ||
    schedule.offsetMin !== undefined || schedule.offsetMax !== undefined ||
    Boolean(schedule.activityTiming?.length) || schedule.occurrenceCap !== undefined
  );
  const graphCanStandAlone = Boolean(
    !hasExplicitMethod && trailingInstructionText && clause.instructionGraph?.actions.length &&
    !clause.route && !clause.site && !hasAdministrationTiming && graphRepresentsDose
  );
  if (graphCanStandAlone) return trailingInstructionText as string;
  const primarySourceSentence = primaryGraphAction
    ? formatPatientInstructionSentence(primaryGraphAction.sourceText)
    : undefined;
  const primaryActionIndex = primaryGraphAction
    ? clause.instructionGraph?.actions.indexOf(primaryGraphAction)
    : undefined;
  const entersPrimaryWithThen = primaryActionIndex !== undefined && primaryActionIndex >= 0
    ? clause.instructionGraph?.relations?.some((relation) =>
        relationHasSemanticClass(relation.kind, "sequence") && relation.toActionIndex === primaryActionIndex &&
        relation.fromActionIndex !== undefined
      )
    : false;
  const richPrimaryActionIndex = richPrimaryGraphAction && clause.instructionGraph
    ? clause.instructionGraph.actions.indexOf(richPrimaryGraphAction)
    : -1;
  const graphContinuesWithThen = richPrimaryActionIndex >= 0 && Boolean(
    clause.instructionGraph?.relations?.some((relation) =>
      relationHasSemanticClass(relation.kind, "sequence") && relation.fromActionIndex === richPrimaryActionIndex
    )
  );
  const sequenceRelation = getUniqueAdviceRelationByGrammarFeature("defaultSequenceRelation");
  if (!sequenceRelation) throw new Error("Missing declarative default sequence relation");
  const sequenceSurface = localizeAdviceRelation(sequenceRelation, "en") ?? sequenceRelation;
  const compose = (base: string): string => {
    let effectiveBase = richGraphAdministrationSentence ?? primarySourceSentence ?? base;
    if (preFlowsIntoAdministration && preGraphInstruction) {
      const rawPre = preGraphInstruction.replace(/[.!?]+$/, "");
      const pre = rawPre ? rawPre.charAt(0).toUpperCase() + rawPre.slice(1) : rawPre;
      effectiveBase = `${pre}; ${sequenceSurface} ${effectiveBase.charAt(0).toLowerCase()}${effectiveBase.slice(1)}`;
    }
    if (postFlowsFromAdministration && postGraphInstruction) {
      const post = postGraphInstruction.charAt(0).toLowerCase() + postGraphInstruction.slice(1);
      effectiveBase = `${effectiveBase.replace(/[.!?]+$/, "")}; ${sequenceSurface} ${post}`;
      if (!/[.!?]$/.test(effectiveBase)) effectiveBase += ".";
    }
    if (leadingInstructionText && effectiveBase && entersPrimaryWithThen) {
      const leading = leadingInstructionText.replace(/[.!?]+$/, "");
      return [
        `${leading}; ${sequenceSurface} ${effectiveBase.charAt(0).toLowerCase()}${effectiveBase.slice(1)}`,
        trailingInstructionText
      ].filter(Boolean).join(" ").trim();
    }
    const effectiveTrailing = trailingInstructionText && graphContinuesWithThen
      ? `${sequenceSurface.charAt(0).toUpperCase()}${sequenceSurface.slice(1)} ${trailingInstructionText.charAt(0).toLowerCase()}${trailingInstructionText.slice(1)}`
      : trailingInstructionText;
    return [leadingInstructionText, effectiveBase, effectiveTrailing].filter(Boolean).join(" ").trim();
  };
  if (!body) {
    if (!trailingInstructionText && !leadingInstructionText) return `${verb}.`;
    return hasExplicitMethod ? compose(`${verb}.`) : compose("");
  }
  return compose(`${verb} ${body}.`);
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
          relationHasGrammarFeature(frame.relation, "mealStateComplement") &&
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
  return phrases.map((phrase) => {
    const sentence = phrase.charAt(0).toUpperCase() + phrase.slice(1);
    return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
  }).join(" ").trim();
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
      realizationMode: options?.realizationMode ?? "normalized",
      sitePlacement: options?.sitePlacement ??
        (options?.realizationMode === "roundtrip" ? "trailing" : "natural"),
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
      realizationMode: options?.realizationMode ?? "normalized",
      sitePlacement: options?.sitePlacement ??
        (options?.realizationMode === "roundtrip" ? "trailing" : "natural"),
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
