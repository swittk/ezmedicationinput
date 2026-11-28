import { EventTiming, FhirDayOfWeek, FhirPeriodUnit, type ParseOptions } from "./types";
import { TIMING_ABBREVIATIONS } from "./maps";
import { compactIntervalParts, INTERVAL_UNIT_TOKENS_DATA } from "./hpsg/lexical-classes";
import { mapIntervalUnit, normalizePeriodValue, normalizePeriodRange } from "./hpsg/timing-lexicon";

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
  const interval = compactIntervalParts(code);
  return Boolean(interval && INTERVAL_UNIT_TOKENS_DATA.has(interval.unitSurface));
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
  let systemless: T | undefined;
  for (const coding of timing.code?.coding ?? []) {
    if (!coding.code) continue;
    if (isStandardTimingCoding(coding)) {
      if (coding.system === FHIR_GTS_TIMING_SYSTEM) return coding;
      if (systemless === undefined) systemless = coding;
    }
    if (includePreview && preview === undefined && isPreviewTimingCoding(coding)) preview = coding;
    if (fallback === undefined) fallback = coding;
  }
  return systemless ?? preview ?? fallback;
}

/** Display-only coding is authored text, never an executable cadence. */
export function codeLessTimingDisplay(timing: { code?: { coding?: readonly { code?: string; display?: string }[] } } | undefined): string | undefined {
  for (const coding of timing?.code?.coding ?? []) {
    if (!coding.code && coding.display !== undefined) return coding.display;
  }
  return undefined;
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

/** Exact elapsed scales used to compare a numeric cadence, without assigning
 * calendar-month lengths or choosing clinic clocks. */
export const FIXED_TIMING_PERIOD_SECONDS: Readonly<Record<string, number>> = {
  s: 1, min: 60, h: 3600, d: 86400, wk: 604800,
};

/** One exact cadence comparison for execution and clinical preview. */
export function matchesDailyCodeCadence(
  daily: number, repeat: { frequency?: number; period?: number; periodUnit?: string }
): boolean {
  const seconds = repeat.periodUnit ? FIXED_TIMING_PERIOD_SECONDS[repeat.periodUnit] : undefined;
  return !!seconds && daily * repeat.period! * seconds === repeat.frequency! * 86400;
}

/** Standard coding has its own clinical meaning; free SIG shorthand stays lexical. */
export function timingCodeMeaning(coding: { system?: string; code?: string } | undefined): string | undefined {
  return coding?.system === FHIR_GTS_TIMING_SYSTEM && coding.code === "PM"
    ? EventTiming.Afternoon : coding?.code;
}

/** Emit a standard identity only when its meaning matches the parsed shorthand. */
export function standardTimingCodingFromSig(code: string | undefined): { system: string; code: string } | undefined {
  const normalized = code?.toUpperCase();
  if (!normalized || !FHIR_GTS_TIMING_CODES.has(normalized)) return undefined;
  const coding = { system: FHIR_GTS_TIMING_SYSTEM, code: normalized };
  return timingCodeMeaning(coding) === normalized ? coding : undefined;
}

const AFTERNOON_TIMING_PREVIEW: typeof TIMING_ABBREVIATIONS[string] = {
  code: EventTiming.Afternoon, when: [EventTiming.Afternoon]
};

const BEDTIME_TIMING_PREVIEW: typeof TIMING_ABBREVIATIONS[string] = {
  code: "BED", when: [EventTiming["Before Sleep"]]
};

/** Standard BED supplies an event anchor independently of the repeat cadence. */
export function timingPreviewDescriptor(code: string) {
  if (code === EventTiming.Afternoon) return AFTERNOON_TIMING_PREVIEW;
  const lower = code.toLowerCase();
  return lower === "bed" ? BEDTIME_TIMING_PREVIEW : TIMING_ABBREVIATIONS[lower];
}

/** Human previews also recognize existing SIG shorthand without treating it
 * as a standard FHIR timing identity or changing its structured projection. */
export function intervalTimingPreviewDescriptor(code: string): { period: number; periodMax?: number; periodUnit: FhirPeriodUnit } | undefined {
  const descriptor = timingPreviewDescriptor(code);
  if (descriptor?.period && descriptor.periodUnit && !descriptor.when?.length && (descriptor.frequency ?? 1) === 1)
    return descriptor as typeof descriptor & { period: number; periodUnit: FhirPeriodUnit };
  const interval = compactIntervalParts(code);
  if (!interval) return undefined;
  const unit = mapIntervalUnit(interval.unitSurface);
  if (!unit) return undefined;
  if (interval.periodMax !== undefined) {
    const range = normalizePeriodRange(interval.period, interval.periodMax, unit);
    return { period: range.low, periodMax: range.high, periodUnit: range.unit };
  }
  const normalized = normalizePeriodValue(interval.period, unit);
  return { period: normalized.value, periodUnit: normalized.unit };
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
