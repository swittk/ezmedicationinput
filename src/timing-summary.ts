import { EventTiming, FhirDayOfWeek, FhirPeriodUnit, type ParseOptions } from "./types";
import { TIMING_ABBREVIATIONS } from "./maps";
import { INTERVAL_UNIT_TOKENS_DATA } from "./hpsg/lexical-classes";

/** Exact standard timing identities shared by native compilation and wire
 * projection. Local codes remain text unless this vocabulary recognizes them. */
export const FHIR_GTS_TIMING_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation";
export const FHIR_GTS_TIMING_CODES = new Set([
  "BID", "TID", "QID", "AM", "PM", "QD", "QOD",
  "Q1H", "Q2H", "Q3H", "Q4H", "Q6H", "Q8H",
  "BED", "WK", "MO"
]);

/** Supported standard identity for coding selection and wire projection. */
export function isStandardTimingCoding(coding: { system?: string; code?: string } | undefined): boolean {
  return Boolean(coding?.code && (!coding.system || coding.system === FHIR_GTS_TIMING_SYSTEM) &&
    FHIR_GTS_TIMING_CODES.has(coding.code.toUpperCase()));
}

/** Existing compact interval vocabulary applies to text and systemless codes. */
export function isCompactIntervalTimingCode(code: string): boolean {
  const interval = /^q[0-9]+(?:\.[0-9]+)?(?:-[0-9]+(?:\.[0-9]+)?)?([a-z]+)$/iu.exec(code);
  return Boolean(interval && INTERVAL_UNIT_TOKENS_DATA.has(interval[1].toLowerCase()));
}

/** Existing clinical preview abbreviations include shorthand such as QHS
 * that is not emitted as a standard FHIR code. Foreign systems stay opaque. */
export function isPreviewTimingCoding(coding: { system?: string; code?: string } | undefined): boolean {
  return Boolean(coding?.code && (!coding.system || coding.system === FHIR_GTS_TIMING_SYSTEM) &&
    (FHIR_GTS_TIMING_CODES.has(coding.code.toUpperCase()) || TIMING_ABBREVIATIONS[coding.code.toLowerCase()] ||
      isCompactIntervalTimingCode(coding.code)));
}

/** Prefer an understood cadence over a local translation without changing
 * either coding or its authored order. Local-only concepts keep their first code. */
export function preferredTimingCoding<T extends { system?: string; code?: string }>(
  timing: { code?: { coding?: readonly T[] } },
  includePreview = false
): T | undefined {
  let fallback: T | undefined;
  let preview: T | undefined;
  for (const coding of timing.code?.coding ?? []) {
    if (!coding.code) continue;
    if (isStandardTimingCoding(coding)) return coding;
    if (includePreview && preview === undefined && isPreviewTimingCoding(coding)) preview = coding;
    if (fallback === undefined) fallback = coding;
  }
  return preview ?? fallback;
}

/** Preview shorthand does not change execution's standard-code preference. */
export function preferredPreviewTimingCoding<T extends { system?: string; code?: string }>(
  timing: { code?: { coding?: readonly T[] } }
): T | undefined {
  return preferredTimingCoding(timing, true);
}

/** Recognized daily cadence, independent of configured clock realization. */
export const TIMING_CODE_DAILY_FREQUENCIES: Readonly<Record<string, number>> = {
  QD: 1, QOD: 0.5, AM: 1, PM: 1, BID: 2, TID: 3, QID: 4
};

/** Exact standard elapsed intervals, separate from daily clock codes and
 * language-specific SIG abbreviation recognition. */
export const TIMING_CODE_HOURLY_PERIODS: Readonly<Record<string, number>> = {
  Q1H: 1, Q2H: 2, Q3H: 3, Q4H: 4, Q6H: 6, Q8H: 8
};

/** Standard coding has its own clinical meaning; free SIG shorthand stays lexical. */
export function timingCodeForPreview(coding: { system?: string; code?: string } | undefined): string | undefined {
  return coding?.system === FHIR_GTS_TIMING_SYSTEM && coding.code === "PM"
    ? EventTiming.Afternoon : coding?.code;
}

const AFTERNOON_TIMING_PREVIEW: typeof TIMING_ABBREVIATIONS[string] = {
  code: EventTiming.Afternoon, when: [EventTiming.Afternoon]
};

/** Standard BED and the existing QHS shorthand share the same event anchor. */
export function timingPreviewDescriptor(code: string) {
  if (code === EventTiming.Afternoon) return AFTERNOON_TIMING_PREVIEW;
  const lower = code.toLowerCase();
  return TIMING_ABBREVIATIONS[lower === "bed" ? "qhs" : lower];
}

/** Human previews also recognize existing SIG shorthand without treating it
 * as a standard FHIR timing identity or changing its structured projection. */
export function intervalTimingPreviewDescriptor(code: string): { period: number; periodUnit: FhirPeriodUnit } | undefined {
  const descriptor = timingPreviewDescriptor(code);
  if (!descriptor?.period || !descriptor.periodUnit || descriptor.when?.length || (descriptor.frequency ?? 1) !== 1)
    return undefined;
  return descriptor as typeof descriptor & { period: number; periodUnit: FhirPeriodUnit };
}

export interface TimingSummaryOptions {
  /** Scoped vocabulary in the original parse/format request. Do not build
   * any second registry or retain it on the canonical clinical course. */
  instructionActionMap?: ParseOptions["instructionActionMap"];
  realizationMode?: "normalized" | "roundtrip";
  groupMealTimingsByRelation?: boolean;
  includeTimesPerDaySummary?: boolean;
  sitePlacement?: "natural" | "trailing";
}

export type MealRelation = "before" | "after" | "with";
export type MealName = "breakfast" | "lunch" | "dinner";

export interface MealTimingGroup {
  relation: MealRelation;
  meals: MealName[];
  codes: EventTiming[];
}

export interface TimingSummaryInput {
  frequency?: number;
  frequencyMax?: number;
  period?: number;
  periodMax?: number;
  periodUnit?: FhirPeriodUnit;
  timingCode?: string;
  dayOfWeek?: FhirDayOfWeek[];
  when?: EventTiming[];
  timeOfDay?: string[];
}

const MEAL_TIMING_DETAILS: Partial<Record<EventTiming, { relation: MealRelation; meal: MealName }>> = {
  [EventTiming["Before Breakfast"]]: { relation: "before", meal: "breakfast" },
  [EventTiming["Before Lunch"]]: { relation: "before", meal: "lunch" },
  [EventTiming["Before Dinner"]]: { relation: "before", meal: "dinner" },
  [EventTiming["After Breakfast"]]: { relation: "after", meal: "breakfast" },
  [EventTiming["After Lunch"]]: { relation: "after", meal: "lunch" },
  [EventTiming["After Dinner"]]: { relation: "after", meal: "dinner" },
  [EventTiming.Breakfast]: { relation: "with", meal: "breakfast" },
  [EventTiming.Lunch]: { relation: "with", meal: "lunch" },
  [EventTiming.Dinner]: { relation: "with", meal: "dinner" }
};

const MEAL_ORDER: Record<MealName, number> = {
  breakfast: 0,
  lunch: 1,
  dinner: 2
};

const INFERABLE_DAILY_EVENT_TIMINGS = new Set<EventTiming>([
  EventTiming["Before Sleep"],
  EventTiming["Before Breakfast"],
  EventTiming["Before Lunch"],
  EventTiming["Before Dinner"],
  EventTiming["After Breakfast"],
  EventTiming["After Lunch"],
  EventTiming["After Dinner"],
  EventTiming.Breakfast,
  EventTiming.Lunch,
  EventTiming.Dinner,
  EventTiming.Morning,
  EventTiming["Early Morning"],
  EventTiming["Late Morning"],
  EventTiming.Noon,
  EventTiming.Afternoon,
  EventTiming["Early Afternoon"],
  EventTiming["Late Afternoon"],
  EventTiming.Evening,
  EventTiming["Early Evening"],
  EventTiming["Late Evening"],
  EventTiming.Night,
  EventTiming.Wake,
  EventTiming["After Sleep"]
]);

function uniqueValues<T>(values: T[]): T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

export function getMealTimingGroup(
  when: EventTiming[],
  options?: TimingSummaryOptions
): MealTimingGroup | undefined {
  if (!options?.groupMealTimingsByRelation) {
    return undefined;
  }

  const uniqueWhen = uniqueValues(when);
  if (uniqueWhen.length < 2) {
    return undefined;
  }

  let relation: MealRelation | undefined;
  const meals: MealName[] = [];
  const groupedCodes: EventTiming[] = [];
  let sawFirstMeal = false;
  for (let i = 0; i < uniqueWhen.length; i += 1) {
    const code = uniqueWhen[i];
    const detail = MEAL_TIMING_DETAILS[code];
    if (!detail) {
      if (sawFirstMeal) {
        break;
      }
      continue;
    }
    if (!sawFirstMeal) {
      sawFirstMeal = true;
    }
    if (!relation) {
      relation = detail.relation;
    } else if (relation !== detail.relation && detail.relation !== "with") {
      break;
    }
    meals.push(detail.meal);
    groupedCodes.push(code);
  }

  if (groupedCodes.length < 2) {
    return undefined;
  }

  for (let i = 1; i < meals.length; i += 1) {
    const current = meals[i];
    let j = i - 1;
    while (j >= 0 && MEAL_ORDER[meals[j]] > MEAL_ORDER[current]) {
      meals[j + 1] = meals[j];
      j -= 1;
    }
    meals[j + 1] = current;
  }

  if (!relation) {
    return undefined;
  }

  return {
    relation,
    meals,
    codes: groupedCodes
  };
}

export function inferDailyOccurrenceCount(
  input: TimingSummaryInput,
  options?: TimingSummaryOptions
): number | undefined {
  if (!options?.includeTimesPerDaySummary) {
    return undefined;
  }

  if (input.frequency !== undefined || input.frequencyMax !== undefined || input.timingCode) {
    return undefined;
  }
  if (input.period !== undefined || input.periodMax !== undefined || input.periodUnit !== undefined) {
    return undefined;
  }
  if ((input.dayOfWeek?.length ?? 0) > 0) {
    return undefined;
  }

  const uniqueWhen = uniqueValues(input.when ?? []);
  for (let i = 0; i < uniqueWhen.length; i += 1) {
    if (!INFERABLE_DAILY_EVENT_TIMINGS.has(uniqueWhen[i])) {
      return undefined;
    }
  }

  const uniqueTimes = uniqueValues(input.timeOfDay ?? []);
  const occurrences = uniqueWhen.length + uniqueTimes.length;
  if (occurrences === 0) {
    return undefined;
  }
  return occurrences;
}
