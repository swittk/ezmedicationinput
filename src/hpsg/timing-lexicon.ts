import { TIMING_ABBREVIATIONS } from "../maps";
import { ParserState } from "../parser-state";
import { FhirPeriodUnit } from "../types";
import { HpsgScheduleFeature } from "./signature";

export const EVERY_INTERVAL_TOKENS = new Set(["q", "every", "each"]);
export const COUNT_MARKER_TOKENS = new Set(["x", "*"]);

export const COUNT_CONNECTOR_WORDS = new Set([
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

export const FREQUENCY_SIMPLE_WORDS: Record<string, number> = {
  once: 1,
  twice: 2,
  thrice: 3
};

export const FREQUENCY_NUMBER_WORDS: Record<string, number> = {
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

export const FREQUENCY_TIMES_WORDS = new Set(["time", "times", "x"]);
export const FREQUENCY_CONNECTOR_WORDS = new Set(["per", "a", "an", "each", "every"]);

const FREQUENCY_ADVERB_UNITS: Record<string, FhirPeriodUnit> = {
  daily: FhirPeriodUnit.Day,
  weekly: FhirPeriodUnit.Week,
  monthly: FhirPeriodUnit.Month,
  hourly: FhirPeriodUnit.Hour
};

export function normalizePeriodValue(value: number, unit: FhirPeriodUnit): {
  value: number;
  unit: FhirPeriodUnit;
} {
  if (unit === FhirPeriodUnit.Hour && (!Number.isInteger(value) || value < 1)) {
    return { value: Math.round(value * 60 * 1000) / 1000, unit: FhirPeriodUnit.Minute };
  }
  return { value, unit };
}

export function normalizePeriodRange(
  low: number,
  high: number,
  unit: FhirPeriodUnit
): { low: number; high: number; unit: FhirPeriodUnit } {
  if (
    unit === FhirPeriodUnit.Hour &&
    (!Number.isInteger(low) || !Number.isInteger(high) || low < 1 || high < 1)
  ) {
    return {
      low: Math.round(low * 60 * 1000) / 1000,
      high: Math.round(high * 60 * 1000) / 1000,
      unit: FhirPeriodUnit.Minute
    };
  }
  return { low, high, unit };
}

export function periodUnitSuffix(unit: FhirPeriodUnit): string | undefined {
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

export function applyPeriod(
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

export function buildPeriodScheduleFeature(
  period: number,
  unit: FhirPeriodUnit
): HpsgScheduleFeature {
  const normalized = normalizePeriodValue(period, unit);
  let timingCode: string | undefined;
  const suffix = periodUnitSuffix(normalized.unit);
  if (suffix) {
    const key = `q${normalized.value}${suffix}`;
    const descriptor = TIMING_ABBREVIATIONS[key];
    if (descriptor?.code) {
      timingCode = descriptor.code;
    }
  }
  if (normalized.unit === FhirPeriodUnit.Week && normalized.value === 1) {
    timingCode = timingCode ?? "WK";
  }
  if (normalized.unit === FhirPeriodUnit.Month && normalized.value === 1) {
    timingCode = timingCode ?? "MO";
  }
  return {
    period: normalized.value,
    periodUnit: normalized.unit,
    frequency:
      normalized.unit === FhirPeriodUnit.Day && normalized.value === 1
        ? 1
        : undefined,
    timingCode
  };
}

export function mapIntervalUnit(token: string):
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

export function mapFrequencyAdverb(token: string): FhirPeriodUnit | undefined {
  return FREQUENCY_ADVERB_UNITS[token];
}

export function parseNumericRange(
  token: string
): { low: number; high: number } | undefined {
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

export function normalizeCountLimitValue(
  value: number | undefined
): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : undefined;
}

export function applyDurationLimit(
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

export function buildDurationScheduleFeature(
  value: number | undefined,
  unit: FhirPeriodUnit | undefined,
  max?: number
): HpsgScheduleFeature | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0 || !unit) {
    return undefined;
  }
  return {
    duration: value,
    durationMax:
      max !== undefined && Number.isFinite(max) && max > value ? max : undefined,
    durationUnit: unit
  };
}
