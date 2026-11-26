import { TIMING_ABBREVIATIONS, WORD_FREQUENCIES } from "./maps";
import { getDoseUnitKind, getQuantityDurationUnit } from "./unit-lexicon";
import { ENGLISH_DAY_NAMES, joinLocalizedList } from "./locales/course/types";
import { ENGLISH_COURSE } from "./locales/course/en";
import type { CourseLanguage } from "./locales/course/types";
import { buildCanonicalSigClauses, canonicalClauseHasAdministrationSemantics } from "./ir";
import {
  collectLocalizedWhenPhrases,
  combineLocalizedFrequencyAndEvents,
  type LocalizedTimingGrammar
} from "./localized-timing";
import { ParserState } from "./parser-state";
import { appendClinicalConditionText, resolveNativeClauseRendering, type SigLocalization, type SigLongContext, type SigShortContext, type SigDoseScope } from "./i18n";
import { getLocalizedCanonicalPrnReasonText, getPreferredCanonicalPrnReasonText } from "./prn";
import { resolveSymptomDefinition } from "./symptom-terminology";
import { composedCodedWarningActionSources } from "./advice";
import { EN_POSITIVE_MODALITY_PREFIX } from "./instruction-action-locale-adapter";
import { medicationInstructionActionLocaleRealizerConfig, resolveMedicationInstructionAction, resolveMedicationInstructionActionForMethod } from "./instruction-action-terminology";
import { baseLanguageTag, quantityComparatorText } from "./localization";
import { getMedicationInstructionConcept } from "./instruction-concept-terminology";
import {
  instructionGraphHasNovelNonWarningContent,
  instructionGraphPrimaryAdministrationModality,
  instructionGraphPrimarySiteRelation,
  canonicalSiteOwnsPrimaryPhrase,
  instructionGraphRichPrimaryAction,
  realizeRichPrimaryWithCanonicalDose,
  instructionGraphSourceConflictsWithDose,
  instructionGraphPreparationOwnsDose,
  instructionGraphRoundTripPrimaryAction,
  instructionGraphEntailsAdviceCoding,
  instructionGraphCoversTypedWarnings,
  instructionGraphRealizesWarningText,
  instructionGraphSourceOwnedByAdvice,
  instructionGraphFullyOwnsAdvice,
  instructionGraphRepresentsText,
  instructionGraphSingleActionRepresentsText,
  instructionGraphTextParticipatesInRelation,
  realizeInstructionAction,
  realizeInstructionGraph,
  attachInstructionGraphPrimaryConditions,
  type InstructionGraphPrimaryCondition,
  instructionGraphPostAdministrationDiscourseConnector
} from "./instruction-graph";
import { resolveBodySitePhrase, realizeBodySiteRestriction } from "./body-site-grammar";
import {
  getUniqueAdviceRelationByGrammarFeature,
  getBodySiteRelationRealization,
  localizeAdviceRelation,
  relationHasGrammarFeature,
  relationHasSemanticClass
} from "./relation-terminology";
import {
  AdviceArgumentRole,
  type AdviceFrame,
  type CanonicalAdditionalInstructionExpr,
  AdvicePolarity,
  AdviceRelation,
  BodySiteSpatialRelation,
  CanonicalDoseExpr,
  CanonicalScheduleExpr,
  CanonicalSigClause,
  EventTiming,
  FhirPeriodUnit,
  RouteCode,
  type MedicationCondition
} from "./types";
import {
  getMealTimingGroup,
  intervalTimingPreviewDescriptor, isCompactIntervalTimingCode,
  TIMING_CODE_DAILY_FREQUENCIES,
  timingPreviewDescriptor,
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

export const DAY_NAMES: Record<string, string> = ENGLISH_DAY_NAMES;

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

export function routeCodeFromDisplayText(text: string | undefined, includeOtic: boolean): RouteCode | undefined {
  if (!text) {
    return undefined;
  }
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes("mouth") || normalized.includes("oral")) {
    return RouteCode["Oral route"];
  }
  if (normalized.includes("ophthalm")) {
    return RouteCode["Ophthalmic route"];
  }
  if (normalized.includes("intravitreal")) {
    return RouteCode["Intravitreal route (qualifier value)"];
  }
  if (normalized.includes("topical")) {
    return RouteCode["Topical route"];
  }
  if (normalized.includes("transdermal")) {
    return RouteCode["Transdermal route"];
  }
  if (normalized.includes("subcutaneous") || normalized === "sc" || normalized === "sq") {
    return RouteCode["Subcutaneous route"];
  }
  if (normalized.includes("intramuscular") || normalized === "im") {
    return RouteCode["Intramuscular route"];
  }
  if (normalized.includes("intravenous") || normalized === "iv") {
    return RouteCode["Intravenous route"];
  }
  if (normalized.includes("rectal") || normalized.includes("rectum")) {
    return RouteCode["Per rectum"];
  }
  if (normalized.includes("vagin")) {
    return RouteCode["Per vagina"];
  }
  // Otic text remains an English fallback; Thai requires its existing coded route.
  if (includeOtic && (normalized.includes("otic") || normalized.includes("ear"))) {
    return RouteCode["Otic route"];
  }
  if (normalized.includes("nasal")) {
    return RouteCode["Nasal route"];
  }
  if (normalized.includes("inhal")) {
    return RouteCode["Respiratory tract route (qualifier value)"];
  }
  return undefined;
}

function resolveRouteGrammar(clause: CanonicalSigClause): RouteGrammar {
  const routeCode = clause.route?.code;
  if (routeCode && ROUTE_GRAMMAR[routeCode]) {
    return ROUTE_GRAMMAR[routeCode] ?? DEFAULT_ROUTE_GRAMMAR;
  }
  const textRoute = routeCodeFromDisplayText(clause.route?.text, true);
  return (textRoute ? ROUTE_GRAMMAR[textRoute] : undefined) ?? DEFAULT_ROUTE_GRAMMAR;
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

export function alternateDayEvent(
  schedule: CanonicalScheduleExpr | undefined
): EventTiming | undefined {
  if (
    schedule?.period !== 2 || schedule.periodUnit !== FhirPeriodUnit.Day ||
    (schedule.periodMax !== undefined && schedule.periodMax !== 2) ||
    schedule.when?.length !== 1 || schedule.frequency !== undefined || schedule.frequencyMax !== undefined ||
    schedule.offset !== undefined || schedule.offsetMin !== undefined || schedule.offsetMax !== undefined
  ) return undefined;
  const event = schedule.when[0];
  return event === EventTiming.Night || event === EventTiming.Morning ? event : undefined;
}

function describeAlternateEventCadenceEnglish(schedule: CanonicalScheduleExpr | undefined): string | undefined {
  const event = alternateDayEvent(schedule);
  if (event === EventTiming.Night) return "every other night";
  if (event === EventTiming.Morning) return "every other morning";
  return undefined;
}

/** Daily recurrence applies to every explicit clock, not one occurrence in total.
 * Presentation may say "daily at ..." without rewriting the stored frequency.
 * Explicit ranges and counts other than one retain their authored summary.
 * @param schedule Typed timing to realize; source text is never inspected.
 */
export function hasDailyRecurrenceAcrossClocks(schedule: CanonicalScheduleExpr | undefined): boolean {
  if (!schedule || schedule.frequencyMax !== undefined || schedule.periodMax !== undefined ||
      (schedule.period !== undefined && schedule.period !== 1)) return false;
  const daily = schedule.frequency === 1 && schedule.periodUnit === FhirPeriodUnit.Day ||
    schedule.timingCode === "QD" &&
    (schedule.frequency === undefined || schedule.frequency === 1) &&
    (schedule.periodUnit === undefined || schedule.periodUnit === FhirPeriodUnit.Day);
  const clocks = schedule.timeOfDay;
  if (!daily || !clocks || clocks.length < 2) return false;
  const first = clocks[0].length === 5 ? clocks[0] + ":00" : clocks[0];
  return clocks.some(clock => (clock.length === 5 ? clock + ":00" : clock) !== first);
}

type FrequencyDisplayMode =
  | "daily" | "daily-count" | "daily-range" | "daily-maximum"
  | "period" | "period-maximum" | "alternate-days"
  | "calendar-count" | "calendar-range" | "calendar-maximum"
  | "code" | "code-period" | "count" | "count-bounds";

interface FrequencyDisplay {
  mode: FrequencyDisplayMode;
  countPrefix: "none" | "count" | "range" | "maximum";
  frequency?: number;
  frequencyMax?: number;
  period?: number;
  periodMax?: number;
  periodUnit?: FhirPeriodUnit;
  rangeEnd?: number;
  timingCode?: string;
  codePeriod?: { period: number; periodUnit: FhirPeriodUnit };
}

/** Select clinical display meaning once; each locale retains its wording. */
export function frequencyDisplay(
  schedule: CanonicalScheduleExpr | undefined, uppercaseTimingCode = false
): FrequencyDisplay | undefined {
  if (hasDailyRecurrenceAcrossClocks(schedule)) return { mode: "daily", countPrefix: "none" };
  const frequency = schedule?.frequency;
  const frequencyMax = schedule?.frequencyMax;
  const period = schedule?.period;
  const periodMax = schedule?.periodMax;
  const periodUnit = schedule?.periodUnit;
  const timingCode = uppercaseTimingCode ? schedule?.timingCode?.toUpperCase() : schedule?.timingCode;
  const rangedPeriod = periodMax !== undefined && periodMax !== period;
  const countPrefix = frequency !== undefined &&
    (rangedPeriod || frequency !== 1 || frequencyMax !== undefined && frequencyMax !== frequency)
    ? frequencyMax !== undefined && frequencyMax !== frequency ? "range" : "count"
    : frequencyMax !== undefined && frequency === undefined ? "maximum" : "none";
  let mode: FrequencyDisplayMode | undefined;
  let rangeEnd: number | undefined;
  let codePeriod: FrequencyDisplay["codePeriod"];

  if (period === undefined && periodMax !== undefined && periodUnit) {
    mode = "period-maximum";
  } else if (frequency !== undefined && frequencyMax !== undefined &&
      periodUnit === FhirPeriodUnit.Day && (period === undefined || period === 1) && !rangedPeriod) {
    mode = frequency === 1 && frequencyMax === 1 ? "daily-count" : "daily-range";
  } else if (frequency === undefined && frequencyMax !== undefined &&
      periodUnit === FhirPeriodUnit.Day && (period === undefined || period === 1) && !rangedPeriod) {
    mode = "daily-maximum";
  } else if (frequency && periodUnit === FhirPeriodUnit.Day && (period === undefined || period === 1) && !rangedPeriod) {
    mode = "daily-count";
  } else if (periodUnit === FhirPeriodUnit.Second && period !== undefined) {
    mode = "period";
    if (periodMax !== undefined && periodMax !== period) rangeEnd = periodMax;
  } else if ((periodUnit === FhirPeriodUnit.Minute || periodUnit === FhirPeriodUnit.Hour) && period !== undefined) {
    mode = "period";
    if (periodMax !== undefined && periodMax !== period) rangeEnd = periodMax;
  } else if (periodUnit === FhirPeriodUnit.Day && period !== undefined && (period !== 1 || rangedPeriod)) {
    mode = countPrefix === "none" && period === 2 && (!periodMax || periodMax === 2)
      ? "alternate-days" : "period";
    if (periodMax !== undefined && periodMax !== period) rangeEnd = periodMax;
  } else if ((periodUnit === FhirPeriodUnit.Week || periodUnit === FhirPeriodUnit.Month ||
      periodUnit === FhirPeriodUnit.Year) && period !== undefined) {
    if (period === 1 && (!periodMax || periodMax === 1)) {
      if (frequency === undefined && frequencyMax !== undefined) mode = "calendar-maximum";
      else if (frequency !== undefined && frequencyMax !== undefined && frequencyMax !== frequency)
        mode = "calendar-range";
      else if (frequency === undefined && (
        periodUnit === FhirPeriodUnit.Week && (schedule?.dayOfWeek?.length ?? 0) > 1 ||
        periodUnit === FhirPeriodUnit.Month && (schedule?.dayOfMonth?.length ?? 0) > 1
      )) return undefined;
      else mode = "calendar-count";
    } else {
      mode = "period";
      if (periodMax !== undefined && periodMax !== period) rangeEnd = periodMax;
    }
  } else if (timingCode && timingCodeMatchesRecurrence(schedule!)) {
    switch (timingCode.toUpperCase()) {
      case "BID": case "TID": case "QID": case "QD": case "QOD": case "WK": case "MO":
        mode = "code";
        break;
      default:
        codePeriod = intervalTimingPreviewDescriptor(timingCode);
        if (codePeriod) mode = "code-period";
    }
  }
  if (!mode) {
    if (frequency === undefined && frequencyMax === undefined && period === 1 &&
        periodUnit === FhirPeriodUnit.Day && !rangedPeriod) mode = "daily";
    else if (frequencyMax !== undefined && frequencyMax !== frequency &&
        periodUnit === undefined && period === undefined) mode = "count-bounds";
    else if (frequency && periodUnit === undefined && period === undefined) mode = "count";
    else return undefined;
  }
  return { mode, countPrefix, frequency, frequencyMax, period, periodMax, periodUnit, rangeEnd, timingCode, codePeriod };
}

const EN_FREQUENCY_CODE_TEXT: Readonly<Record<string, string>> = {
  BID: "twice daily", TID: "three times daily", QID: "four times daily", QD: "once daily",
  QOD: "every other day", WK: "once weekly", MO: "once monthly"
};

function describeFrequency(schedule: CanonicalScheduleExpr | undefined, words: CourseLanguage): string | undefined {
  const display = frequencyDisplay(schedule, true);
  if (!display) return undefined;
  const { frequency, frequencyMax, period, periodMax, periodUnit, rangeEnd } = display;
  const countPrefix = display.countPrefix === "range"
    ? `${stripTrailingZero(frequency!)} to ${stripTrailingZero(frequencyMax!)} times `
    : display.countPrefix === "count"
      ? frequency === 1 ? "once " : frequency === 2 ? "twice " : `${stripTrailingZero(frequency!)} times `
      : display.countPrefix === "maximum" ? `up to ${stripTrailingZero(frequencyMax!)} times ` : "";
  switch (display.mode) {
    case "daily": return "daily";
    case "daily-count": return EN_TIMES_PER_DAY[frequency!] ?? `${stripTrailingZero(frequency!)} times daily`;
    case "daily-range": return frequency === 1 && frequencyMax === 2 ? "one to two times daily"
      : `${stripTrailingZero(frequency!)} to ${stripTrailingZero(frequencyMax!)} times daily`;
    case "daily-maximum": return `up to ${stripTrailingZero(frequencyMax!)} times daily`;
    case "period-maximum":
      return `${countPrefix}every up to ${stripTrailingZero(periodMax!)} ${words.timeUnit(periodUnit!, periodMax) ?? periodUnit}`;
    case "alternate-days": return "every other day";
    case "period": {
      const interval = rangeEnd !== undefined
        ? `${stripTrailingZero(period!)} to ${stripTrailingZero(rangeEnd)}` : stripTrailingZero(period!);
      let unit: string | undefined;
      switch (periodUnit) {
        case FhirPeriodUnit.Second: unit = words.timeUnit(periodUnit, periodMax ?? period) ?? periodUnit; break;
        case FhirPeriodUnit.Minute: unit = rangeEnd !== undefined || period !== 1 ? "minutes" : "minute"; break;
        case FhirPeriodUnit.Hour: unit = rangeEnd !== undefined || period !== 1 ? "hours" : "hour"; break;
        case FhirPeriodUnit.Day: unit = "days"; break;
        case FhirPeriodUnit.Week: unit = "weeks"; break;
        case FhirPeriodUnit.Month: unit = "months"; break;
        case FhirPeriodUnit.Year: unit = "years"; break;
      }
      return `${countPrefix}every ${interval} ${unit}`;
    }
    case "calendar-count":
    case "calendar-range":
    case "calendar-maximum": {
      const unit = periodUnit === FhirPeriodUnit.Week ? "weekly" : periodUnit === FhirPeriodUnit.Month ? "monthly" : "yearly";
      if (display.mode === "calendar-maximum") return `up to ${stripTrailingZero(frequencyMax!)} times ${unit}`;
      if (display.mode === "calendar-range") return `${stripTrailingZero(frequency!)} to ${stripTrailingZero(frequencyMax!)} times ${unit}`;
      if (frequency === 2) return `twice ${unit}`;
      return frequency !== undefined && frequency !== 1 ? `${stripTrailingZero(frequency)} times ${unit}` : `once ${unit}`;
    }
    case "code": return EN_FREQUENCY_CODE_TEXT[display.timingCode!];
    case "code-period": {
      const interval = display.codePeriod!;
      return `${countPrefix}every ${stripTrailingZero(interval.period)} ${words.timeUnit(interval.periodUnit, interval.period) ?? interval.periodUnit}`;
    }
    case "count-bounds": return countPrefix.trim();
    case "count": return frequency === 1 ? "once" : `${stripTrailingZero(frequency!)} times`;
  }
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

export function standaloneOccurrenceCount(
  schedule: CanonicalScheduleExpr | undefined
): number | undefined {
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
    schedule?.dayOfMonth?.length ||
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
  return count;
}

function describeStandaloneOccurrenceCount(schedule: CanonicalScheduleExpr | undefined): string | undefined {
  const count = standaloneOccurrenceCount(schedule);
  if (count === undefined) return undefined;
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
    const amount = `${dose.comparator ?? ""}${stripTrailingZero(dose.value)}`;
    if (dose.unit) {
      return `${amount} ${dose.unit}`;
    }
    return amount;
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
    const english = quantityComparatorText(dose.comparator, "en");
    const amount = `${english}${stripTrailingZero(dose.value)}`;
    if (dose.unit) {
      return `${amount} ${pluralize(dose.unit, dose.value)}`;
    }
    return amount;
  }
  return undefined;
}

/** A typed scalar/range, or an already complete native rich amount, can be
 * labelled without selecting it as the administration's prescribed dose. */
export function formatDoseEnglish(
  dose: CanonicalDoseExpr | string, style: "short" | "long", scope?: SigDoseScope
): string | undefined {
  const amount = typeof dose === "string" ? dose : style === "short" ? formatDoseShort(dose) : formatDoseLong(dose);
  return amount && scope ? amount + " (" + (scope.site?.perTargetText ?? "per administration target") + ")" : amount;
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

function describeEventWindowEnglish(schedule: CanonicalScheduleExpr | undefined, words: CourseLanguage): string | undefined {
  const window = schedule?.eventWindow;
  return window ? words.eventWindow(WHEN_TEXT[window.start] ?? window.start, WHEN_TEXT[window.end] ?? window.end) : undefined;
}

function formatEventOffsetQuantityEnglish(minutes: number, maximum?: number): string {
  if (maximum !== undefined && maximum !== minutes)
    return `${stripTrailingZero(minutes)}–${stripTrailingZero(maximum)} minutes`;
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
      ? getMedicationInstructionConcept(timing.activity.coding.code, timing.activity.coding.system)
      : undefined;
    const activity = definition?.display ?? timing.activity.text;
    const relation = timing.relation;
    if (timing.offsetMin !== undefined && timing.offsetMax !== undefined) {
      result.push(`${formatEventOffsetQuantityEnglish(timing.offsetMin, timing.offsetMax)} ${relation} ${activity}`);
      continue;
    }
    const value = timing.offsetMin ?? timing.offsetMax ?? timing.offset;
    if (value === undefined) {
      result.push(`${relation} ${activity}`);
      continue;
    }
    if (value === 0 && timing.offset !== undefined) {
      result.push(`immediately ${relation} ${activity}`);
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
  if (schedule.offsetMin !== undefined && schedule.offsetMax !== undefined)
    return `${formatEventOffsetQuantityEnglish(schedule.offsetMin, schedule.offsetMax)} ${eventText}`;
  const value = schedule.offsetMin ?? schedule.offsetMax ?? schedule.offset;
  if (value === undefined) return eventText;
  if (value === 0 && schedule.offset !== undefined) return `immediately ${eventText}`;
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
  return collectLocalizedWhenPhrases(timingEventPreviewSchedule(schedule), EN_TIMING_GRAMMAR, options);
}

export function joinWithAnd(parts: string[]): string {
  return joinLocalizedList(parts, "and");
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
  grammar: RouteGrammar,
  targetCount: number | undefined,
  words: CourseLanguage
): string | undefined {
  if (!relation?.relationText) {
    return undefined;
  }
  const rawTarget = relation.targetText ?? relation.targetCoding?.display;
  if (!rawTarget) {
    return undefined;
  }
  const resolvedTarget = resolveBodySitePhrase(rawTarget);
  let target = resolvedTarget?.englishObjectText ??
    `the ${rawTarget.charAt(0).toLowerCase()}${rawTarget.slice(1)}`;
  if (targetCount !== undefined && targetCount > 1 && targetCount !== resolvedTarget?.definition?.administrationTargetCount)
    target += " (" + words.applicationSites(targetCount) + ")";
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

function appendSiteRestrictionsEnglish(
  clause: CanonicalSigClause,
  sitePhrase: string
): string {
  const restrictions = clause.site?.restrictions;
  if (!restrictions?.length) return sitePhrase;
  const parts = [sitePhrase];
  for (const restriction of restrictions) {
    // Source wording remains provenance; the live predicate owns this preview.
    const relative = realizeBodySiteRestriction(restriction.predicate.text.trim()
      ? { ...restriction, sourceText: "" } : restriction, "en");
    if (relative && !parts.some((part) => part.toLowerCase().includes(relative.toLowerCase()))) {
      parts.push(relative);
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Discrete doses distribute across paired targets; metric amounts are totals. */
export function doseUnitUsesTargetScope(unit: string | undefined): boolean {
  const kind = getDoseUnitKind(unit);
  return kind !== undefined && kind !== "metric" && kind !== "biologic_unit";
}

function formatSite(
  clause: CanonicalSigClause,
  grammar: RouteGrammar,
  directObject = false,
  words: CourseLanguage = ENGLISH_COURSE
): string | undefined {
  let text = clause.site?.text?.trim();
  const spatial = clause.site?.spatialRelation;
  const targetText = (spatial?.targetText ?? spatial?.targetCoding?.display)?.trim();
  if (!text || targetText && text.toLowerCase() === targetText.toLowerCase()) {
    const spatialSite = renderSpatialSiteEnglish(spatial, grammar, clause.site?.administrationTargetCount, words);
    if (spatialSite) {
      return appendSiteRestrictionsEnglish(clause, spatialSite);
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
  const perTargetNoun = doseUnitUsesTargetScope(clause.dose?.unitIdentity ?? clause.dose?.unit)
    ? resolvedSite?.definition?.perTargetText : undefined;
  let noun = perTargetNoun ?? resolvedSite?.englishObjectText ?? `the ${normalizedText}`;
  const count = clause.site?.administrationTargetCount;
  if (count !== undefined && count > 1 && count !== resolvedSite?.definition?.administrationTargetCount)
    noun += " (" + words.applicationSites(count) + ")";
  if (resolvedSite?.features.kind === "locative" || directObject)
    return appendSiteRestrictionsEnglish(clause, noun);
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
  return appendSiteRestrictionsEnglish(clause, `${preposition} ${noun}`.trim());
}

function formatIsoCalendarDateEnglish(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return value;
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
  ];
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!months[month - 1] || !day) return value;
  return `${day} ${months[month - 1]} ${match[1]}`;
}

function describeCalendarBoundsEnglish(
  schedule: CanonicalScheduleExpr | undefined
): string | undefined {
  const start = formatIsoCalendarDateEnglish(schedule?.boundsStart);
  const end = formatIsoCalendarDateEnglish(schedule?.boundsEnd);
  if (start && end) return `from ${start} through ${end}`;
  if (start) return `starting ${start}`;
  if (end) return `through ${end}`;
  return undefined;
}

function describeCalendarEventsEnglish(
  schedule: CanonicalScheduleExpr | undefined
): string | undefined {
  const events = schedule?.calendarEvents;
  if (!events?.length) return undefined;
  const parts: string[] = [];
  for (const event of events) {
    const formatted = event.fhirDateTime ?? formatIsoCalendarDateEnglish(event.isoDate);
    if (formatted) parts.push(formatted);
  }
  return parts.length ? `on ${joinWithAnd(parts)}` : undefined;
}

/** Describe typed month-day selection independently of medication amount.
 * @param schedule Calendar-day membership from grammar or a structured import.
 * @returns An English monthly day phrase when a selection is present.
 */
function describeDayOfMonth(schedule: CanonicalScheduleExpr | undefined): string | undefined {
  const days = schedule?.dayOfMonth ?? [];
  if (!days.length) return undefined;
  const sorted = [...days].sort((a, b) => a - b);
  const contiguous = sorted.every((day, index) => !index || day === sorted[index - 1] + 1);
  if (sorted.length === 1) return `on day ${sorted[0]} of each month`;
  return contiguous ? `on days ${sorted[0]}–${sorted[sorted.length - 1]} of each month`
    : `on days ${sorted.join(" and ")} of each month`;
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
  if (days.length && schedule?.weekdayOrdinal !== undefined) {
    const names: Record<number, string> = { [-1]: "last", 1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth" };
    return `on the ${names[schedule.weekdayOrdinal]} ${joinWithAnd(days)} of each month`;
  }
  return days.length ? `on ${joinWithAnd(days)}` : undefined;
}

export function formatDurationShort(schedule: CanonicalScheduleExpr): string | undefined {
  const durationUnit = schedule.durationUnit ?? schedule.durationUnitLabel;
  const durationMaxUnit = schedule.durationMaxUnit ?? schedule.durationMaxUnitLabel;
  if (schedule.durationIsRange && schedule.duration !== undefined && schedule.durationMax !== undefined &&
      (!schedule.durationUnit || !schedule.durationMaxUnit)) {
    const low = (schedule.durationComparator ?? "") + stripTrailingZero(schedule.duration) + (durationUnit ?? "");
    const high = (schedule.durationMaxComparator ?? "") + stripTrailingZero(schedule.durationMax) + (durationMaxUnit ?? "");
    return `x${low} – ${high}`;
  }
  if ((schedule.duration === undefined && schedule.durationMax === undefined) || !durationUnit && !schedule.durationIsRange) {
    return undefined;
  }
  const upperUnit = durationMaxUnit ?? durationUnit ?? "";
  if (schedule.duration === undefined)
    return `x${schedule.durationMaxComparator ?? "<="}${stripTrailingZero(schedule.durationMax!)}${upperUnit}`;
  const base = (schedule.durationComparator ?? "") + stripTrailingZero(schedule.duration);
  if (schedule.durationMax !== undefined &&
      (schedule.durationMax !== schedule.duration || upperUnit !== durationUnit ||
        schedule.durationComparator !== undefined || schedule.durationMaxComparator !== undefined)) {
    const lowerUnit = upperUnit !== durationUnit ? durationUnit : "";
    return `x${base}${lowerUnit}-${schedule.durationMaxComparator ?? ""}${stripTrailingZero(schedule.durationMax)}${upperUnit}`;
  }
  const lowerBound = schedule.durationIsRange && schedule.durationMax === undefined &&
    (!schedule.durationComparator || schedule.durationComparator === "~") ? ">=" : "";
  return `x${lowerBound}${base}${durationUnit ?? ""}`;
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

export interface DurationWording {
  readonly locale: string;
  readonly coursePrefix: string;
  readonly administrationPrefix: string;
  readonly administrationShortPrefix: string;
  readonly range: string;
  readonly upper: string;
  readonly lower: string;
  administrationUnit(unit: FhirPeriodUnit, value: number | undefined, maximum: number | undefined,
    short: boolean, words: CourseLanguage): string;
}

const ENGLISH_DURATION_WORDING: DurationWording = {
  locale: "en", coursePrefix: "for", administrationPrefix: "over",
  administrationShortPrefix: "over", range: " to ", upper: "up to ", lower: "at least ",
  administrationUnit: (unit, value, maximum, _short, words) => words.timeUnit(unit, maximum ?? value) ?? unit
};

export function describeDuration(
  schedule: CanonicalScheduleExpr | undefined, words: CourseLanguage,
  text: DurationWording = ENGLISH_DURATION_WORDING
): string | undefined {
  if (schedule?.durationIsRange && schedule.duration !== undefined && schedule.durationMax !== undefined &&
      (!schedule.durationUnit || !schedule.durationMaxUnit)) {
    const endpoint = (value: number, unit: string | undefined, authoredUnit: string | undefined, comparator: string | undefined): string => {
      const label = unit ? words.timeUnit(unit, value) ?? authoredUnit ?? unit : authoredUnit;
      return (comparator ?? "") + stripTrailingZero(value) + (label ? " " + label : "");
    };
    return `${text.coursePrefix} ${endpoint(schedule.duration, schedule.durationUnit, schedule.durationUnitLabel, schedule.durationComparator)} – ${endpoint(schedule.durationMax, schedule.durationMaxUnit, schedule.durationMaxUnitLabel, schedule.durationMaxComparator)}`;
  }
  if (!schedule || (schedule.duration === undefined && schedule.durationMax === undefined) || !schedule.durationUnit && !schedule.durationUnitLabel && !schedule.durationIsRange) {
    return undefined;
  }
  const unit = schedule.durationUnit ?? schedule.durationUnitLabel ?? "";
  const upperUnit = schedule.durationMaxUnit ?? schedule.durationMaxUnitLabel ?? unit;
  const upperUnitCode = schedule.durationMaxUnit ?? schedule.durationUnit;
  const label = (value: number, endpointUnit = unit, unitCode = schedule.durationUnit): string =>
    unitCode ? words.timeUnit(unitCode, value) ?? endpointUnit : endpointUnit;
  if (schedule.duration === undefined)
    return `${text.coursePrefix} ${schedule.durationMaxComparator ?? text.upper}${stripTrailingZero(schedule.durationMax!)} ${label(schedule.durationMax!, upperUnit, upperUnitCode)}`.trim();
  const lower = (schedule.durationComparator ?? "") + stripTrailingZero(schedule.duration);
  if (schedule.durationMax !== undefined &&
      (schedule.durationMax !== schedule.duration || upperUnit !== unit ||
        schedule.durationComparator !== undefined || schedule.durationMaxComparator !== undefined)) {
    const lowerUnit = upperUnit !== unit ? " " + label(schedule.duration) : "";
    return `${text.coursePrefix} ${lower}${lowerUnit}${text.range}${schedule.durationMaxComparator ?? ""}${stripTrailingZero(schedule.durationMax)} ${label(schedule.durationMax, upperUnit, upperUnitCode)}`.trim();
  }
  const lowerBound = schedule.durationIsRange && schedule.durationMax === undefined &&
    (!schedule.durationComparator || schedule.durationComparator === "~") ? text.lower : "";
  return `${text.coursePrefix} ${lowerBound}${lower} ${label(schedule.duration)}`.trim();
}

export function describeAdministrationDuration(
  schedule: CanonicalScheduleExpr | undefined, short = false, words: CourseLanguage = ENGLISH_COURSE,
  text: DurationWording = ENGLISH_DURATION_WORDING, prefix = text.administrationPrefix
): string | undefined {
  const range = schedule?.administrationDurationRange;
  if (range) {
    const endpoint = (quantity: NonNullable<typeof range.low>): string => {
      const unit = quantity.code ?? quantity.unit ?? "";
      const recognizedUnit = short ? undefined : getQuantityDurationUnit(quantity);
      const label = short ? quantity.unit ?? unit :
        (recognizedUnit && words.timeUnit(recognizedUnit, quantity.value)) || quantity.unit || unit;
      return (short ? quantity.comparator ?? "" : quantityComparatorText(quantity.comparator, text.locale)) +
        (quantity.value === undefined ? "" : stripTrailingZero(quantity.value)) + (short ? "" : " ") + label;
    };
    const low = range.low?.value !== undefined ? endpoint(range.low) : undefined;
    const high = range.high?.value !== undefined ? endpoint(range.high) : undefined;
    if (low && high) return short ? text.administrationShortPrefix + low + "-" + high : prefix + " " + low + text.range + high;
    if (high) return short ? text.administrationShortPrefix + (range.high?.comparator && range.high.comparator !== "~" ? "" : "<=") + high : prefix + " " + (range.high?.comparator && range.high.comparator !== "~" ? "" : text.upper) + high;
    if (low) return short ? text.administrationShortPrefix + (range.low?.comparator && range.low.comparator !== "~" ? "" : ">=") + low : prefix + " " + (range.low?.comparator && range.low.comparator !== "~" ? "" : text.lower) + low;
    return undefined;
  }
  const value = schedule?.administrationDuration;
  const unit = schedule?.administrationDurationUnit;
  const max = schedule?.administrationDurationMax;
  if ((value === undefined && max === undefined) || !unit) return undefined;
  const lower = value === undefined
    ? (short ? "<=" : text.upper) + stripTrailingZero(max!)
    : (short ? schedule?.administrationDurationComparator ?? ""
      : quantityComparatorText(schedule?.administrationDurationComparator, text.locale)) + stripTrailingZero(value);
  const duration = value !== undefined && max !== undefined && max !== value
    ? lower + (short ? "-" : text.range) + stripTrailingZero(max)
    : lower;
  if (short) return text.administrationShortPrefix + duration + unit;
  const label = text.administrationUnit(unit, value, max, false, words);
  return `${prefix} ${duration} ${label}`;
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

/** Preserve free labels; recognized cadence prose yields to a typed recurrence. */
export function independentTimingText(
  code: string | undefined,
  recurrence?: Pick<CanonicalScheduleExpr, "frequency" | "frequencyMax" | "period" | "periodMax" | "periodUnit">
): string | undefined {
  if (!code || TIMING_CODE_DAILY_FREQUENCIES[code] !== undefined) return undefined;
  const lower = code.toLowerCase();
  if (timingPreviewDescriptor(code)) return undefined;
  if (WORD_FREQUENCIES[lower] && recurrence?.periodUnit !== undefined &&
      (recurrence.frequency !== undefined || recurrence.frequencyMax !== undefined ||
       recurrence.period !== undefined || recurrence.periodMax !== undefined)) return undefined;
  // Compact interval shorthand yields only when a typed cadence replaces it.
  // Otherwise retain the existing code when no preview descriptor expands it.
  return isCompactIntervalTimingCode(code) && recurrence?.periodUnit !== undefined &&
    (recurrence.period !== undefined || recurrence.periodMax !== undefined) ? undefined : code;
}

export function timingCodeMatchesRecurrence(
  schedule: Pick<CanonicalScheduleExpr, "timingCode" | "frequency" | "frequencyMax" | "period" | "periodMax" | "periodUnit" | "when" | "timeOfDay">,
  code = schedule.timingCode
): boolean {
  if (!code) return true;
  const daily = TIMING_CODE_DAILY_FREQUENCIES[code];
  const interval = daily === undefined || schedule.when?.length || schedule.timeOfDay?.length
    ? timingPreviewDescriptor(code) : undefined;
  if (interval?.when?.length && (schedule.when?.length
      ? interval.when.length !== schedule.when.length ||
        schedule.when.some((event, index) => event !== interval.when![index])
      : Boolean(schedule.timeOfDay?.length))) return false;
  if (daily === undefined && !interval) {
    // Free text is not a recurrence abbreviation. Typed cadence owns the
    // preview while the authored label stays on the source timing.
    return schedule.frequency === undefined &&
      schedule.frequencyMax === undefined && schedule.period === undefined &&
      schedule.periodMax === undefined && schedule.periodUnit === undefined;
  }
  const frequency = code === "QOD" ? 1 : daily ?? interval!.frequency ?? 1;
  const period = code === "QOD" ? 2 : interval?.period ?? 1;
  const unit = interval?.periodUnit ?? FhirPeriodUnit.Day;
  return (schedule.frequency === undefined || schedule.frequency === frequency) &&
    (schedule.frequencyMax === undefined || schedule.frequency !== undefined && schedule.frequencyMax === frequency) &&
    (schedule.period === undefined || schedule.period === period) &&
    (schedule.periodMax === undefined || schedule.periodMax === period) &&
    (schedule.periodUnit === undefined || schedule.periodUnit === unit);
}

/** A code-only event supplies display meaning without changing authored timing. */
export function timingEventPreviewSchedule(
  schedule: CanonicalScheduleExpr | undefined
): CanonicalScheduleExpr | undefined {
  if (!schedule?.timingCode || schedule.when?.length || schedule.timeOfDay?.length) return schedule;
  const descriptor = timingPreviewDescriptor(schedule.timingCode);
  const when = descriptor?.when;
  const anchorOnly = descriptor?.frequency === undefined && descriptor?.period === undefined &&
    descriptor?.periodUnit === undefined;
  return when?.length && (anchorOnly || timingCodeMatchesRecurrence(schedule)) ? { ...schedule, when } : schedule;
}

function formatShort(clause: CanonicalSigClause, words: CourseLanguage): string {
  const schedule = scheduleOf(clause);
  const codeText = independentTimingText(schedule.timingCode, schedule);
  const timingText = schedule.timingTextIsLiteral ? schedule.timingText
    : schedule.timingText === undefined ? codeText : independentTimingText(schedule.timingText, schedule);
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
  if (clause.site) {
    const site = formatSite(clause, resolveRouteGrammar(clause), false, words);
    if (site) parts.push(site);
  }
  if (schedule.period === undefined && schedule.periodMax !== undefined && schedule.periodUnit) {
    parts.push(describeFrequency(schedule, words)!);
  } else if (hasDailyRecurrenceAcrossClocks(schedule)) {
    parts.push("daily");
  } else if (schedule.timingCode && !codeText && timingCodeMatchesRecurrence(schedule)) {
    parts.push(schedule.timingCode);
  } else if (
    schedule.frequency === undefined && schedule.frequencyMax !== undefined &&
    schedule.periodUnit === FhirPeriodUnit.Day &&
    schedule.period === undefined &&
    (schedule.periodMax === undefined || schedule.periodMax === 1)
  ) {
    parts.push(`<=${stripTrailingZero(schedule.frequencyMax)}x/d`);
  } else if (
    schedule.frequency !== undefined &&
    schedule.frequencyMax !== undefined &&
    schedule.periodUnit === FhirPeriodUnit.Day &&
    (schedule.period === undefined || schedule.period === 1) &&
    (schedule.periodMax === undefined || schedule.periodMax === 1)
  ) {
    parts.push(`${stripTrailingZero(schedule.frequency)}-${stripTrailingZero(schedule.frequencyMax)}x/d`);
  } else if (
    schedule.frequency &&
    schedule.periodUnit === FhirPeriodUnit.Day &&
    (schedule.period === undefined || schedule.period === 1) &&
    (schedule.periodMax === undefined || schedule.periodMax === 1)
  ) {
    parts.push(`${stripTrailingZero(schedule.frequency)}x/d`);
  } else if (schedule.period !== undefined && schedule.periodUnit &&
      !(schedule.periodUnit === FhirPeriodUnit.Month && schedule.frequency === undefined && schedule.frequencyMax === undefined &&
        (schedule.dayOfMonth?.length ?? 0) > 1)) {
    const base = stripTrailingZero(schedule.period);
    const qualifier =
      schedule.periodMax !== undefined && schedule.periodMax !== schedule.period
        ? `${base}-${stripTrailingZero(schedule.periodMax)}`
        : base;
    const frequency = schedule.frequency;
    const maximum = schedule.frequencyMax;
    if (frequency !== undefined && frequency !== 1 || maximum !== undefined && maximum !== frequency) {
      const count = maximum !== undefined && maximum !== frequency
        ? frequency === undefined ? `<=${stripTrailingZero(maximum)}`
          : `${stripTrailingZero(frequency)}-${stripTrailingZero(maximum)}`
        : stripTrailingZero(frequency!);
      parts.push(`${count}x/${qualifier}${schedule.periodUnit}`);
    } else parts.push(`Q${qualifier}${schedule.periodUnit.toUpperCase()}`);
  } else if (schedule.frequency !== undefined || schedule.frequencyMax !== undefined) {
    const frequency = schedule.frequency, maximum = schedule.frequencyMax;
    const count = maximum !== undefined && maximum !== frequency
      ? frequency === undefined ? `<=${stripTrailingZero(maximum)}`
        : `${stripTrailingZero(frequency)}-${stripTrailingZero(maximum)}`
      : stripTrailingZero(frequency!);
    parts.push(`${count}x`);
  }
  if (timingText) parts.push(timingText);
  const eventSchedule = timingCodeMatchesRecurrence(schedule) ? schedule : timingEventPreviewSchedule(schedule)!;
  if (eventSchedule.when?.length) {
    parts.push(eventSchedule.offset !== undefined || eventSchedule.offsetMin !== undefined || eventSchedule.offsetMax !== undefined
      ? collectWhenPhrases(eventSchedule).join(" ") : eventSchedule.when.join(" "));
  }
  if (schedule.activityTiming?.length) parts.push(...formatActivityTimingEnglish(schedule));
  const eventWindow = describeEventWindowEnglish(schedule, words);
  if (eventWindow) parts.push(eventWindow);
  if (schedule.dayOfMonth?.length) {
    parts.push(describeDayOfMonth(schedule)!);
  }
  if (schedule.dayOfWeek?.length) {
    const days: string[] = [];
    for (const day of schedule.dayOfWeek) {
      days.push(day.charAt(0).toUpperCase() + day.slice(1, 3));
    }
    const ordinal = schedule.weekdayOrdinal;
    parts.push(days.join(",") + (ordinal === undefined ? "" : `(${ordinal === -1 ? "last" : ordinal})`));
  }
  if (schedule.timeOfDay?.length) {
    const times: string[] = [];
    for (const time of schedule.timeOfDay) {
      times.push(time.slice(0, 5));
    }
    parts.push(times.join(","));
  }
  if (schedule.calendarEvents?.length) {
    parts.push(`@${schedule.calendarEvents.map((event) => event.fhirDateTime ?? event.isoDate).join(",")}`);
  }
  if (schedule.boundsStart) {
    parts.push(`from${schedule.boundsStart}`);
  }
  if (schedule.boundsEnd) {
    parts.push(`thru${schedule.boundsEnd}`);
  }
  if (schedule.countMax !== undefined) {
    parts.push(schedule.count === undefined ? `x<=${stripTrailingZero(schedule.countMax)}`
      : `x${stripTrailingZero(schedule.count)}-${stripTrailingZero(schedule.countMax)}`);
  } else if (schedule.count !== undefined) {
    parts.push(`x${stripTrailingZero(schedule.count)}`);
  }
  const administrationDuration = describeAdministrationDuration(schedule, true, words);
  if (administrationDuration) parts.push(administrationDuration);
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
  if (!parts.length && clause.method) parts.push(resolveMethodVerb(clause, resolveRouteGrammar(clause)));
  return parts.filter(Boolean).join(" ");
}

interface LongAdministrationTimingParts {
  frequency?: string;
  event?: string;
  eventWindow?: string;
  activities: string[];
  calendarEvents?: string;
  dayOfWeek?: string;
  dayOfMonth?: string;
  calendarBounds?: string;
  count?: string;
  administrationDuration?: string;
  duration?: string;
  occurrenceCap?: string;
}

interface RichAdministrationParts {
  route?: string;
  frequencyWithoutEvent?: string;
  independentTiming?: string;
  clock?: string;
  asNeeded?: string;
  site?: string;
  coversSingleEvent: boolean;
}

/** Locale realizers supply words; their clinical timing order is shared. */
export function appendLongAdministrationTiming(
  parts: string[], timing: LongAdministrationTimingParts, richTiming?: RichAdministrationParts
): void {
  const frequency = richTiming?.coversSingleEvent ? richTiming.frequencyWithoutEvent : timing.frequency;
  if (frequency) parts.push(frequency);
  if (timing.event && !richTiming?.coversSingleEvent) parts.push(timing.event);
  else if (richTiming) {
    if (richTiming.independentTiming) parts.push(richTiming.independentTiming);
    if (richTiming.clock) parts.push(richTiming.clock);
  }
  if (timing.eventWindow) parts.push(timing.eventWindow);
  for (const activity of timing.activities) parts.push(activity);
  if (timing.calendarEvents) parts.push(timing.calendarEvents);
  if (timing.dayOfWeek) parts.push(timing.dayOfWeek);
  if (timing.dayOfMonth) parts.push(timing.dayOfMonth);
  if (timing.calendarBounds) parts.push(timing.calendarBounds);
  if (timing.count) parts.push(timing.count);
  if (timing.administrationDuration) parts.push(timing.administrationDuration);
  if (timing.duration) parts.push(timing.duration);
  if (timing.occurrenceCap) parts.push(timing.occurrenceCap);
}

export function richGraphAdministrationTail(
  clause: CanonicalSigClause,
  action: AdviceFrame,
  timing: LongAdministrationTimingParts,
  parts: RichAdministrationParts
): string[] {
  const result: string[] = [];
  if (parts.route) result.push(parts.route);
  appendLongAdministrationTiming(result, timing, parts);
  if (parts.asNeeded) result.push(parts.asNeeded);
  const actionHasSite = !canonicalSiteOwnsPrimaryPhrase(clause) &&
    action.args.some((arg) => arg.role === AdviceArgumentRole.Site);
  if (parts.site && !actionHasSite) result.push(parts.site);
  return result;
}

export function instructionGraphMatchesDose(clause: CanonicalSigClause): boolean {
  return !clause.dose || Boolean(clause.instructionGraph?.actions.some((action) =>
    action.args.some((arg) =>
      arg.role === AdviceArgumentRole.Amount &&
      arg.quantity?.value === clause.dose?.value &&
      arg.quantity?.range?.low === clause.dose?.range?.low &&
      arg.quantity?.range?.high === clause.dose?.range?.high &&
      arg.quantity?.unit === clause.dose?.unit &&
      arg.quantity?.comparator === clause.dose?.comparator
    )
  ));
}

export function normalizeInstructionText(value: string): string {
  return value.toLowerCase().replace(/[\s,;:.()]+/gu, " ").trim();
}

export function collectGraphInstructionOwnership(
  clause: CanonicalSigClause,
  hasCanonicalAdministration: boolean,
  preserveOpaqueSourceSuffix = false
) {
  const graph = clause.instructionGraph;
  const actions = graph?.actions ?? [];
  const graphWarnings = actions.filter((action) => action.polarity === AdvicePolarity.Negate);
  const codedWarningSources: string[] = [];
  const codedWarningSourcesByInstruction: string[][] = [];
  const graphOwnedAdditional: CanonicalAdditionalInstructionExpr[] = [];
  for (const instruction of clause.additionalInstructions ?? []) {
    const sources = composedCodedWarningActionSources(actions, instruction.coding);
    codedWarningSourcesByInstruction.push(sources);
    codedWarningSources.push(...sources);
    if (!instruction.text || !graph) continue;
    let owned = instructionGraphFullyOwnsAdvice(graph, instruction);
    if (!owned && instruction.coding?.code) {
      owned = !sources.length && instructionGraphEntailsAdviceCoding(graph, instruction.coding);
    } else if (!owned) {
      const normalized = normalizeInstructionText(instruction.text);
      // Source realization can retain a contiguous opaque suffix that a
      // translated action cannot claim from its shorter typed advice label.
      owned = preserveOpaqueSourceSuffix && !instruction.frames?.length && actions.some((action) => {
        const actionText = normalizeInstructionText(action.sourceText);
        return Boolean(actionText && normalized.includes(actionText) && graph.opaqueSpans?.some((opaque) =>
          opaque.start >= action.span.end && opaque.text.trim() &&
          !graph.sourceText.slice(action.span.end, opaque.start).trim()
        ));
      });
      if (!owned) {
        const representedByWarning = graphWarnings.some((action) => {
          const source = normalizeInstructionText(action.sourceText);
          return source === normalized || source.includes(normalized) || normalized.includes(source);
        });
        owned = instructionGraphCoversTypedWarnings(graph, instruction.frames) ||
          instructionGraphRealizesWarningText(graph, instruction.text) ||
          instructionGraphRepresentsText(graph, instruction.text) && (
            representedByWarning ||
            Boolean(graph.primaryAdministrationSpan) &&
              instructionGraphSingleActionRepresentsText(graph, instruction.text) &&
              instructionGraphTextParticipatesInRelation(graph, instruction.text) ||
            !hasCanonicalAdministration && instructionGraphSingleActionRepresentsText(graph, instruction.text)
          );
      }
    }
    if (owned) graphOwnedAdditional.push(instruction);
  }
  return { codedWarningSources, codedWarningSourcesByInstruction, graphOwnedAdditional, graphWarnings };
}

export function instructionGraphAdviceSourceTexts(
  clause: CanonicalSigClause,
  instructions: CanonicalAdditionalInstructionExpr[],
  additionalSources: string[] = []
): string[] {
  const sources = instructions.map((instruction) => instruction.text?.trim())
    .filter((text): text is string => Boolean(text));
  for (const instruction of instructions) {
    for (const frame of instruction.frames ?? []) {
      const source = frame.sourceText?.trim();
      if (source && sources.indexOf(source) === -1) sources.push(source);
    }
  }
  for (const source of additionalSources) {
    if (sources.indexOf(source) === -1) sources.push(source);
  }
  if (clause.instructionGraph) {
    for (const instruction of instructions) {
      for (const source of instructionGraphSourceOwnedByAdvice(clause.instructionGraph, instruction)) {
        if (sources.indexOf(source) === -1) sources.push(source);
      }
    }
  }
  return sources;
}

export function instructionGraphAdministrationFlow(
  clause: CanonicalSigClause,
  roundTrip: boolean,
  preGraphInstruction: string | undefined,
  postGraphInstruction: string | undefined
) {
  const span = clause.instructionGraph?.primaryAdministrationSpan;
  let lastPre: AdviceFrame | undefined;
  let firstPost: AdviceFrame | undefined;
  if (span) {
    for (const action of clause.instructionGraph?.actions ?? []) {
      if (action.span.end <= span.start && (!lastPre || action.span.end > lastPre.span.end)) lastPre = action;
      if (action.span.start >= span.end && (!firstPost || action.span.start < firstPost.span.start)) firstPost = action;
    }
  }
  const source = clause.instructionGraph?.sourceText ?? clause.rawText;
  return {
    preFlowsIntoAdministration: Boolean(
      !roundTrip && preGraphInstruction && span && lastPre && lastPre.polarity !== AdvicePolarity.Negate &&
      !/[.!?;]/u.test(source.slice(lastPre.span.end, span.start))
    ),
    postFlowsFromAdministration: Boolean(
      !roundTrip && postGraphInstruction && span && firstPost && firstPost.polarity !== AdvicePolarity.Negate &&
      !/[.!?;]/u.test(source.slice(span.end, firstPost.span.start))
    )
  };
}

export function instructionGraphActionHasSequenceSuccessor(
  clause: CanonicalSigClause, action: AdviceFrame | undefined
): boolean {
  const actionIndex = action && clause.instructionGraph ? clause.instructionGraph.actions.indexOf(action) : -1;
  return actionIndex >= 0 && Boolean(clause.instructionGraph?.relations?.some((relation) =>
    relationHasSemanticClass(relation.kind, "sequence") && relation.fromActionIndex === actionIndex
  ));
}

export function hasExplicitAdministrationMethod(clause: CanonicalSigClause): boolean {
  return Boolean(clause.method?.text?.trim() || clause.method?.coding?.code);
}

export function instructionGraphCanStandAlone(
  clause: CanonicalSigClause,
  timingText: string | undefined,
  graphRepresentsDose: boolean,
  richPrimaryAction: AdviceFrame | undefined,
  graphText: string | undefined,
  primaryConditions: InstructionGraphPrimaryCondition[] | undefined
): boolean {
  const schedule = scheduleOf(clause);
  const hasAdministrationTiming = Boolean(
    timingText || schedule.frequency !== undefined || schedule.frequencyMax !== undefined ||
    schedule.period !== undefined || schedule.periodMax !== undefined ||
    schedule.when?.length || schedule.eventWindow || schedule.dayOfWeek?.length || schedule.dayOfMonth?.length ||
    schedule.timeOfDay?.length || schedule.calendarEvents?.length ||
    schedule.boundsStart !== undefined || schedule.boundsEnd !== undefined ||
    schedule.count !== undefined || schedule.countMax !== undefined || schedule.timingCode ||
    schedule.duration !== undefined || schedule.durationMax !== undefined ||
    schedule.durationUnit !== undefined || schedule.administrationDuration !== undefined ||
    schedule.administrationDurationMax !== undefined || schedule.administrationDurationUnit !== undefined ||
    schedule.administrationDurationRange !== undefined || schedule.offset !== undefined ||
    schedule.offsetMin !== undefined || schedule.offsetMax !== undefined ||
    Boolean(schedule.activityTiming?.length) || schedule.occurrenceCap !== undefined
  );
  return Boolean(
    !richPrimaryAction && !hasExplicitAdministrationMethod(clause) && graphText &&
    clause.instructionGraph?.actions.length && !clause.prn?.enabled && !clause.route && !clause.site &&
    !hasAdministrationTiming && graphRepresentsDose && !primaryConditions?.length
  );
}

const SPREAD_THINLY_INSTRUCTION_CODE = "420162004";

function applyEnglishAdministrationModality(verb: string, clause: CanonicalSigClause): string {
  const modality = instructionGraphPrimaryAdministrationModality(clause);
  const prefix = modality ? EN_POSITIVE_MODALITY_PREFIX[modality] : undefined;
  if (!prefix) return verb;
  return `${prefix}${verb.charAt(0).toLowerCase()}${verb.slice(1)}`;
}

/** A source-only primary and its recognized cadence describe one medication.
 * Guard that complete primary before independent advice is composed. */
export function composeNativePrimaryDirections(
  rendered: string, authored: string | undefined,
  condition: MedicationCondition | undefined, words: CourseLanguage
): string {
  if (!authored) return condition ? appendClinicalConditionText(rendered, condition, words) : rendered;
  const current = rendered.trim().replace(/[.!?]+$/u, "");
  const source = authored.trim().replace(/[.!?]+$/u, "");
  if (!current) return condition ? appendClinicalConditionText(authored, condition, words)
    : /[.!?]$/u.test(authored.trim()) ? authored.trim() : authored.trim() + ".";
  if (current === source) return condition ? appendClinicalConditionText(rendered, condition, words) : rendered;
  const directions = words.withAuthoredDirections(current, source) + ".";
  if (!condition) return directions;
  const lead = appendClinicalConditionText("", condition, words).replace(/[.!?]+$/u, "");
  return lead.charAt(0).toUpperCase() + lead.slice(1) + ": " + directions;
}

function formatLong(clause: CanonicalSigClause, options: TimingSummaryOptions | undefined, words: CourseLanguage,
  resolvedMethod?: SigLongContext["resolvedMethod"], condition?: MedicationCondition, authoredPrimary?: string): string {
  const hasCanonicalAdministration = canonicalClauseHasAdministrationSemantics(clause);
  const schedule = scheduleOf(clause);
  const grammar = resolveRouteGrammar(clause);
  const baseVerb = resolveMethodVerb(clause, grammar);
  const verb = applyEnglishAdministrationModality(baseVerb, clause);
  const preparationSuppliesDose = instructionGraphPreparationOwnsDose(clause, options);
  const explicitDosePart = preparationSuppliesDose ? undefined : formatDoseLong(clause.dose);
  const integratedThinLayer = options?.realizationMode !== "roundtrip" &&
    !explicitDosePart &&
    (clause.additionalInstructions ?? []).find((instruction) =>
      instruction.coding?.code === SPREAD_THINLY_INSTRUCTION_CODE
    );
  const methodDefinition = resolvedMethod ?? resolveMedicationInstructionAction(clause.method?.text ?? baseVerb);
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
  const sitePart = formatSite(clause, grammar, directSiteObject, words);
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
    describeFrequency(schedule, words) ??
    standaloneOccurrenceCount ??
    describeFrequencyCount(inferDailyOccurrenceCount(schedule, options));
  const eventParts = alternateEventCadence ? [] : collectWhenPhrases(schedule, options);
  const timingText = schedule.timingTextIsLiteral ? schedule.timingText
    : independentTimingText(schedule.timingText ?? schedule.timingCode, schedule);
  if (timingText) eventParts.push(timingText);
  const eventWindowPart = describeEventWindowEnglish(schedule, words);
  let clockPart: string | undefined;
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
      clockPart = `at ${timeStrings.join(", ")}`;
      eventParts.push(clockPart);
    }
  }
  const timing = combineFrequencyAndEvents(schedule, frequencyPart, eventParts, options);
  const dayPart = describeDayOfWeek(schedule);
  const monthDayPart = describeDayOfMonth(schedule);
  const calendarEventPart = describeCalendarEventsEnglish(schedule);
  const calendarBoundsPart = describeCalendarBoundsEnglish(schedule);
  const countPart = schedule.countMax !== undefined && !standaloneOccurrenceCount
    ? schedule.count === undefined
      ? `for up to ${stripTrailingZero(schedule.countMax)} doses`
      : schedule.count === schedule.countMax
        ? schedule.count === 1 ? "once only" : `for ${stripTrailingZero(schedule.count)} doses`
        : `for ${stripTrailingZero(schedule.count)} to ${stripTrailingZero(schedule.countMax)} doses`
    : schedule.count !== undefined && !standaloneOccurrenceCount
      ? schedule.count === 1
        ? "once only"
        : `for ${stripTrailingZero(schedule.count)} doses`
      : undefined;
  const administrationDurationPart = describeAdministrationDuration(schedule, false, words);
  const durationPart = describeDuration(schedule, words);
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

  const timingParts: LongAdministrationTimingParts = {
    frequency: timing.frequency, event: timing.event, eventWindow: eventWindowPart,
    activities: formatActivityTimingEnglish(schedule), calendarEvents: calendarEventPart,
    dayOfWeek: dayPart, dayOfMonth: monthDayPart, calendarBounds: calendarBoundsPart,
    count: countPart, administrationDuration: administrationDurationPart,
    duration: durationPart, occurrenceCap: occurrenceCapPart
  };

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
  appendLongAdministrationTiming(segments, timingParts);
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
  const graphRepresentsDose = preparationSuppliesDose || instructionGraphMatchesDose(clause);
  const graphSourceIsEnglish = !clause.instructionGraph?.sourceLocale ||
    baseLanguageTag(clause.instructionGraph.sourceLocale) === "en";
  const primaryGraphAction = roundTrip
    ? instructionGraphRoundTripPrimaryAction(clause)
    : undefined;
  // If whole-source replay is unavailable in this locale, an action's partial
  // source cannot stand in for its independently structured cadence.
  const needsCurrentPrimary = Boolean(primaryGraphAction && (
    !graphSourceIsEnglish || !primaryGraphAction.sourceText.trim() || clause.sourceProjectionVerified === false ||
    !graphRepresentsDose && instructionGraphSourceConflictsWithDose(clause, options)
  ));
  const richPrimaryGraphAction = !roundTrip || !primaryGraphAction
    ? instructionGraphRichPrimaryAction(clause)
    : needsCurrentPrimary ? primaryGraphAction : undefined;
  const richPrimaryCoverage = richPrimaryGraphAction && clause.schedule?.when?.length === 1
    ? { singleScheduledEvent: false } : undefined;
  const richPrimaryGraphText = richPrimaryGraphAction
    ? realizeRichPrimaryWithCanonicalDose(richPrimaryGraphAction, clause, "en", options, richPrimaryCoverage)
    : undefined;
  const richPrimaryCoversSingleEvent = richPrimaryCoverage?.singleScheduledEvent === true;
  const graphRegimenTail = richPrimaryGraphText && richPrimaryGraphAction
    ? richGraphAdministrationTail(clause, richPrimaryGraphAction, timingParts, {
        route: routePart, frequencyWithoutEvent: frequencyPart,
        independentTiming: timingText, clock: clockPart, asNeeded: asNeededPart, site: sitePart,
        coversSingleEvent: richPrimaryCoversSingleEvent
      })
    : [];
  const richGraphAdministrationSentence = richPrimaryGraphText
    ? formatPatientInstructionSentence(
        [richPrimaryGraphText, ...graphRegimenTail].filter(Boolean).join(" ")
      )
    : undefined;
  const instructionPhrases: string[] = [];
  const { codedWarningSources, codedWarningSourcesByInstruction, graphOwnedAdditional, graphWarnings } =
    collectGraphInstructionOwnership(clause, hasCanonicalAdministration, true);
  const hasCodedAdditionalInstruction = Boolean(
    clause.additionalInstructions?.some((instruction, index) =>
      instruction.coding?.code && (
        codedWarningSourcesByInstruction[index].length > 0 ||
        !clause.instructionGraph ||
        !instructionGraphEntailsAdviceCoding(clause.instructionGraph, instruction.coding)
      ))
  );
  const positionedGraph = Boolean(clause.instructionGraph?.primaryAdministrationSpan);
  const additionalForDirectRendering = (clause.additionalInstructions ?? []).filter((instruction) =>
    graphOwnedAdditional.indexOf(instruction) === -1 && instruction !== integratedThinLayer
  );
  const additionalTexts = additionalForDirectRendering
    .map((instruction) => instruction.text?.trim())
    .filter((text): text is string => Boolean(text));
  const additionalSemanticSourceTexts = instructionGraphAdviceSourceTexts(
    clause, additionalForDirectRendering, codedWarningSources
  );
  const allAdditionalRepresentedByGraphWarnings = Boolean(
    graphWarnings.length &&
    additionalTexts.every((text) => {
      return Boolean(clause.instructionGraph &&
        instructionGraphRealizesWarningText(clause.instructionGraph, text));
    })
  );
  const primaryConditions: InstructionGraphPrimaryCondition[] | undefined =
    clause.instructionGraph?.relations?.length ? [] : undefined;
  const positionedRoundTrip = Boolean(roundTrip && positionedGraph);
  const graphWholeInstruction = clause.instructionGraph &&
    !positionedGraph &&
    !hasCodedAdditionalInstruction &&
    allAdditionalRepresentedByGraphWarnings
      ? realizeInstructionGraph(clause.instructionGraph, "en", {
          includeWarnings: true,
          omitCanonicalAdministration: clause,
          instructionActionMap: options?.instructionActionMap,
          preferSourceText: roundTrip,
          roundtripSafe: roundTrip,
          omitSourceTexts: additionalSemanticSourceTexts,
          omitRenderedAction: richPrimaryGraphAction,
          primaryConditions
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
          instructionActionMap: options?.instructionActionMap,
          preferSourceText: roundTrip,
          roundtripSafe: roundTrip,
          omitSourceTexts: additionalSemanticSourceTexts
        })
      : undefined;
    const graphWarningText = graphWarning ? formatPatientInstructionSentence(graphWarning) : undefined;
    if (graphWarningText && !instructionPhrases.some((value) =>
      normalizeInstructionText(value).includes(normalizeInstructionText(graphWarningText)) ||
      normalizeInstructionText(graphWarningText).includes(normalizeInstructionText(value))
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
        instructionActionMap: options?.instructionActionMap,
        preferSourceText: roundTrip,
        roundtripSafe: roundTrip,
        omitSourceTexts: additionalSemanticSourceTexts,
        omitRenderedAction: primaryGraphAction ?? richPrimaryGraphAction,
        position: "pre",
        primaryConditions
      })
    : undefined;
  const graphPrimaryForOmission = primaryGraphAction ?? richPrimaryGraphAction;
  const postGraphInstruction = positionedGraph && clause.instructionGraph
    ? realizeInstructionGraph(clause.instructionGraph, "en", {
        includeWarnings: true,
        omitCanonicalAdministration: clause,
        instructionActionMap: options?.instructionActionMap,
        preferSourceText: roundTrip,
        roundtripSafe: roundTrip,
        omitSourceTexts: additionalSemanticSourceTexts,
        omitRenderedAction: graphPrimaryForOmission,
        position: "post",
        primaryConditions
      })
    : undefined;
  const graphInstruction = graphWholeInstruction ?? postGraphInstruction ?? (
    !positionedGraph && clause.instructionGraph &&
    instructionGraphHasNovelNonWarningContent(clause.instructionGraph, representedInstructionTexts)
      ? realizeInstructionGraph(clause.instructionGraph, "en", {
          includeWarnings: false,
          omitCanonicalAdministration: clause,
          instructionActionMap: options?.instructionActionMap,
          preferSourceText: roundTrip,
          roundtripSafe: roundTrip,
          omitSourceTexts: additionalSemanticSourceTexts,
          omitRenderedAction: graphPrimaryForOmission,
          primaryConditions
        })
      : undefined
  );
  const graphFlow = instructionGraphAdministrationFlow(clause, roundTrip, preGraphInstruction, postGraphInstruction);
  const preFlowsIntoAdministration = graphFlow.preFlowsIntoAdministration;
  // A source-backed contrast already joins the English post-action.
  const postFlowsFromAdministration = graphFlow.postFlowsFromAdministration &&
    !instructionGraphPostAdministrationDiscourseConnector(clause.instructionGraph!);

  const graphOwnsPatientInstruction = Boolean(
    clause.patientInstruction && clause.instructionGraph && (
      richPrimaryGraphAction &&
      instructionGraphSingleActionRepresentsText(clause.instructionGraph, clause.patientInstruction) ||
      !hasCanonicalAdministration &&
      instructionGraphFullyOwnsAdvice(clause.instructionGraph, {
        text: clause.patientInstruction, frames: []
      })
    )
  );
  const patientInstruction = postFlowsFromAdministration
    ? undefined
    : formatPatientInstructionSentence(
        graphInstruction ?? (positionedGraph || graphOwnsPatientInstruction ? undefined : clause.patientInstruction)
      );
  if (patientInstruction) instructionPhrases.push(patientInstruction);
  const trailingInstructionText = instructionPhrases.join(" ").trim() || undefined;
  const hasExplicitMethod = hasExplicitAdministrationMethod(clause);
  if (
    !authoredPrimary && roundTrip && (!hasExplicitMethod || primaryGraphAction && !needsCurrentPrimary) && graphSourceIsEnglish &&
    clause.instructionGraph?.sourceText.trim() && !instructionGraphSourceConflictsWithDose(clause, options) &&
    (!condition || clause.sourceProjectionVerified !== false)
  ) {
    return clause.instructionGraph.sourceText.trim();
  }
  if (!hasCanonicalAdministration) {
    const wholeGraph = clause.instructionGraph
      ? realizeInstructionGraph(clause.instructionGraph, "en", {
          includeWarnings: true,
          omitCanonicalAdministration: clause,
          preferSourceText: roundTrip,
          roundtripSafe: roundTrip
        })
      : undefined;
    const wholeGraphText = formatPatientInstructionSentence(wholeGraph);
    const parts: string[] = [];
    for (const value of [wholeGraphText, ...instructionPhrases]) {
      if (!value) continue;
      const normalized = normalizeInstructionText(value);
      if (parts.some((existing) => {
        const candidate = normalizeInstructionText(existing);
        return candidate === normalized || candidate.includes(normalized) || normalized.includes(candidate);
      })) continue;
      parts.push(value);
    }
    if (authoredPrimary || condition)
      parts.unshift(composeNativePrimaryDirections(authoredPrimary ? "" : verb, authoredPrimary, condition, words));
    return parts.join(" ").trim() || `${verb}.`;
  }
  const leadingInstructionText = preFlowsIntoAdministration
    ? undefined
    : preGraphInstruction
      ? formatPatientInstructionSentence(preGraphInstruction)
      : undefined;
  const graphCanStandAlone = instructionGraphCanStandAlone(
    clause, timingText, graphRepresentsDose, richPrimaryGraphAction,
    trailingInstructionText, primaryConditions
  );
  if (graphCanStandAlone && !authoredPrimary) return condition
    ? appendClinicalConditionText(trailingInstructionText as string, condition, words)
    : trailingInstructionText as string;
  const primarySourceSentence = primaryGraphAction && !needsCurrentPrimary
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
  const graphContinuesWithThen = instructionGraphActionHasSequenceSuccessor(clause, richPrimaryGraphAction);
  const sequenceRelation = getUniqueAdviceRelationByGrammarFeature("defaultSequenceRelation");
  if (!sequenceRelation) throw new Error("Missing declarative default sequence relation");
  const sequenceSurface = localizeAdviceRelation(sequenceRelation, "en") ?? sequenceRelation;
  const compose = (base: string): string => {
    let effectiveBase = richGraphAdministrationSentence ?? primarySourceSentence ?? base;
    effectiveBase = composeNativePrimaryDirections(effectiveBase, authoredPrimary, condition, words);
    // Independent graph conditions remain attached to this administration
    // alongside its current structured clinical guard.
    if (primaryConditions?.length)
      effectiveBase = attachInstructionGraphPrimaryConditions(effectiveBase, primaryConditions, "en", Boolean(condition));
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
    if (!authoredPrimary && !trailingInstructionText && !leadingInstructionText && !primaryConditions?.length)
      return condition ? appendClinicalConditionText(`${verb}.`, condition, words) : `${verb}.`;
    return hasExplicitMethod ? compose(`${verb}.`) : compose("");
  }
  return compose(`${verb} ${body}.`);
}

export function isEmptyStomachInstruction(instruction: CanonicalAdditionalInstructionExpr): boolean {
  return instruction.coding?.code === EMPTY_STOMACH_QUALIFIER_CODE || Boolean(instruction.frames?.some((frame) =>
    relationHasGrammarFeature(frame.relation, "mealStateComplement") && frame.args.some((arg) =>
      arg.role === AdviceArgumentRole.MealState && arg.conceptId === "empty_stomach"
    )
  ));
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
    if (isEmptyStomachInstruction(instruction)) {
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

export function formatNativeCanonicalClause(
  clause: CanonicalSigClause,
  style: "short" | "long",
  localization?: SigLocalization,
  options?: TimingSummaryOptions,
  authoredPrimary?: string
): string {
  // Per-call vocabulary can declare method identities beyond the built-in
  // compiler dictionary. Resolve that head for every locale's display view
  // without replacing source method text or adding work to ordinary clauses.
  let resolvedMethod: SigLongContext["resolvedMethod"];
  if (options?.instructionActionMap && clause.method) {
    resolvedMethod = resolveMedicationInstructionActionForMethod(clause.method, options);
    if (resolvedMethod && resolvedMethod.display !== clause.method.text)
      clause = { ...clause, method: { ...clause.method, text: resolvedMethod.display } };
  }
  const native = resolveNativeClauseRendering(localization);
  const cycle = clause.schedule?.cycleDayConstraint;
  if (cycle) {
    const retainedQualifier = cycle.sourceText.trim();
    const sourceQualifier = clause.sourceProjectionVerified === false ? "" : retainedQualifier;
    const alreadyRealized = style === "long" && sourceQualifier &&
      clause.additionalInstructions?.some(instruction => instruction.text?.trim() === sourceQualifier);
    if (!alreadyRealized) {
      // Current typed cycle fields own display after a source disagreement.
      // Keep their old wording in source, including a duplicate advice entry,
      // but do not replay that entry alongside the edited cycle.
      const rendered = formatNativeCanonicalClause({ ...clause,
        additionalInstructions: clause.sourceProjectionVerified === false && retainedQualifier
          ? clause.additionalInstructions?.filter(instruction => instruction.text?.trim() !== retainedQualifier)
          : clause.additionalInstructions,
        schedule: { ...clause.schedule, cycleDayConstraint: undefined }
      }, style, localization, options, authoredPrimary);
      let qualifier = sourceQualifier;
      if (!qualifier) {
        let days = "";
        for (let index = 0; index < cycle.days.length;) {
          const first = cycle.days[index++];
          let last = first;
          while (index < cycle.days.length && cycle.days[index] === last + 1)
            last = cycle.days[index++];
          days += (days ? ", " : "") + first + (last === first ? "" : "-" + last);
        }
        qualifier = (localization?.course ?? ENGLISH_COURSE).unresolvedCycleTiming(
          days, cycle.periodDays, cycle.cycles, cycle.anchor
        );
      }
      return `${rendered.replace(/[.。]$/u, "")}; ${qualifier.replace(/[.。]$/u, "")}.`;
    }
  }
  const clockWindow = clause.schedule?.clockWindow;
  if (clockWindow) {
    const schedule = { ...clause.schedule, clockWindow: undefined };
    const rendered = formatNativeCanonicalClause({ ...clause, schedule }, style, localization, options, authoredPrimary);
    const start = clockWindow.start.slice(0, 5);
    const end = clockWindow.end.slice(0, 5);
    return `${rendered.replace(/[.。]$/u, "")} ${native.timing.clockWindow(start, end, Boolean(clockWindow.endInclusive))}.`;
  }
  const offset = clause.schedule?.administrationOffsetMinutes;
  if (offset !== undefined && Number.isFinite(offset)) {
    const schedule = { ...clause.schedule, administrationOffsetMinutes: undefined };
    const clocks = schedule.timeOfDay?.map(clock => {
      const parts = clock.split(":").map(Number);
      const seconds = parts[0] * 3600 + parts[1] * 60 + (parts[2] ?? 0) + offset * 60;
      const day = Math.floor(seconds / 86400);
      const normalized = ((seconds % 86400) + 86400) % 86400;
      const hour = Math.floor(normalized / 3600);
      const minute = Math.floor(normalized % 3600 / 60);
      const second = normalized % 60;
      return { day, clock: `${hour < 10 ? "0" : ""}${hour}:${minute < 10 ? "0" : ""}${minute}` +
        (second ? `:${second < 10 ? "0" : ""}${second}` : "") };
    });
    const offsetNote = native.timing.offset(offset);
    if (clocks?.length && !schedule.when?.length && clocks.every(value => Number.isFinite(value.day))) {
      const sameDayShift = clocks.every(value => value.day === clocks[0].day) ? clocks[0].day : undefined;
      if (sameDayShift === undefined) {
        // Mixed-day clocks cannot safely be displayed as an unqualified
        // same-day list. Retain their original times and state the actual
        // elapsed offset once, without fabricating an event chronology.
        const original = formatNativeCanonicalClause({ ...clause, schedule }, style, localization, options, authoredPrimary);
        return original.replace(/[.。]$/u, "") + " (" + offsetNote + ").";
      }
      schedule.timeOfDay = clocks.map(value => value.clock);
      const rendered = formatNativeCanonicalClause({ ...clause, schedule }, style, localization, options, authoredPrimary);
      if (sameDayShift === 0) return rendered;
      const note = native.timing.dayShift(sameDayShift);
      return rendered.replace(/[.。]$/u, "") + " (" + note + ").";
    }
    const rendered = formatNativeCanonicalClause({ ...clause, schedule }, style, localization, options, authoredPrimary);
    return rendered.replace(/[.。]$/u, "") + " (" + offsetNote + ").";
  }
  const words = localization?.course ?? ENGLISH_COURSE;
  return style === "short"
    ? native.short ? native.short(clause, words, resolvedMethod) : formatShort(clause, words)
    : native.long ? native.long(clause, options, words, resolvedMethod, authoredPrimary)
      : formatLong(clause, options, words, resolvedMethod, clause.clinicalAdjuncts?.condition, authoredPrimary);
}

export function formatCanonicalClause(
  clause: CanonicalSigClause,
  style: "short" | "long",
  localization?: SigLocalization,
  options?: TimingSummaryOptions,
  nativeDefault?: (target: "short" | "long") => string
): string {
  const resolvedMethod = options?.instructionActionMap && clause.method
    ? resolveMedicationInstructionActionForMethod(clause.method, options) : undefined;
  let shortDefault: string | undefined;
  let longDefault: string | undefined;

  const formatDefault = (target: "short" | "long") => {
    switch (target) {
      case "short":
        if (shortDefault === undefined) {
          shortDefault = nativeDefault ? nativeDefault("short") : formatNativeCanonicalClause(clause, "short", localization, options);
        }
        return shortDefault;
      case "long":
        if (longDefault === undefined) {
          longDefault = nativeDefault ? nativeDefault("long") : formatNativeCanonicalClause(clause, "long", localization, options);
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
      course: localization.course,
      groupMealTimingsByRelation: Boolean(options?.groupMealTimingsByRelation),
      includeTimesPerDaySummary: Boolean(options?.includeTimesPerDaySummary),
      realizationMode: options?.realizationMode ?? "normalized",
      sitePlacement: options?.sitePlacement ??
        (options?.realizationMode === "roundtrip" ? "trailing" : "natural"),
      formatDefault,
      instructionActionMap: options?.instructionActionMap,
      resolvedMethod
    };
    return localization.formatShort(context);
  }

  if (style === "long" && localization.formatLong) {
    const context: SigLongContext = {
      style: "long",
      clause,
      defaultText: formatDefault("long"),
      course: localization.course,
      groupMealTimingsByRelation: Boolean(options?.groupMealTimingsByRelation),
      includeTimesPerDaySummary: Boolean(options?.includeTimesPerDaySummary),
      realizationMode: options?.realizationMode ?? "normalized",
      sitePlacement: options?.sitePlacement ??
        (options?.realizationMode === "roundtrip" ? "trailing" : "natural"),
      formatDefault,
      instructionActionMap: options?.instructionActionMap,
      resolvedMethod
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

export function stripTrailingZero(value: number): string {
  const text = value.toString();
  if (text.includes(".")) {
    return text.replace(/\.0+$/, "").replace(/0+$/, "");
  }
  return text;
}
