import { TIMING_ABBREVIATIONS } from "../maps";
import { ParserState } from "../parser-state";
import { FhirPeriodUnit } from "../types";
import {
  COUNT_CONNECTOR_WORDS_DATA,
  COUNT_MARKER_TOKENS_DATA,
  EVERY_INTERVAL_TOKENS_DATA,
  FREQUENCY_ADVERB_UNITS_DATA,
  FREQUENCY_CONNECTOR_WORDS_DATA,
  FREQUENCY_NUMBER_WORDS_DATA,
  FREQUENCY_SIMPLE_WORDS_DATA,
  FREQUENCY_TIMES_WORDS_DATA,
  INTERVAL_UNIT_TOKENS_DATA
} from "./lexical-classes";
import { HpsgScheduleFeature } from "./signature";

export const EVERY_INTERVAL_TOKENS = EVERY_INTERVAL_TOKENS_DATA;
export const COUNT_MARKER_TOKENS = COUNT_MARKER_TOKENS_DATA;
export const COUNT_CONNECTOR_WORDS = COUNT_CONNECTOR_WORDS_DATA;
export const FREQUENCY_SIMPLE_WORDS: Record<string, number> = FREQUENCY_SIMPLE_WORDS_DATA;
export const FREQUENCY_NUMBER_WORDS: Record<string, number> = FREQUENCY_NUMBER_WORDS_DATA;
export const FREQUENCY_TIMES_WORDS = FREQUENCY_TIMES_WORDS_DATA;
export const FREQUENCY_CONNECTOR_WORDS = FREQUENCY_CONNECTOR_WORDS_DATA;

function mapPeriodUnitLabel(label: string): FhirPeriodUnit | undefined {
  return FhirPeriodUnit[label as keyof typeof FhirPeriodUnit];
}

const FREQUENCY_ADVERB_UNITS = new Map<string, FhirPeriodUnit>(
  Array.from(FREQUENCY_ADVERB_UNITS_DATA.entries())
    .map(([token, label]) => [token, mapPeriodUnitLabel(label)] as const)
    .filter((entry): entry is readonly [string, FhirPeriodUnit] => Boolean(entry[1]))
);

const INTERVAL_UNITS = new Map<string, FhirPeriodUnit>(
  Array.from(INTERVAL_UNIT_TOKENS_DATA.entries())
    .map(([token, label]) => [token, mapPeriodUnitLabel(label)] as const)
    .filter((entry): entry is readonly [string, FhirPeriodUnit] => Boolean(entry[1]))
);

export function normalizePeriodValue(value: number, unit: FhirPeriodUnit): {
  value: number;
  unit: FhirPeriodUnit;
} {
  // Avoid fractional-hour repeats in FHIR output: q0.5h/q0.25h become minutes.
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

function deriveDefaultTimingForPeriod(
  value: number,
  unit: FhirPeriodUnit,
  currentTimingCode?: string
): { frequency?: number; timingCode?: string } {
  let timingCode = currentTimingCode;
  const suffix = periodUnitSuffix(unit);
  if (suffix) {
    const key = `q${value}${suffix}`;
    const descriptor = TIMING_ABBREVIATIONS[key];
    if (descriptor?.code) {
      timingCode = timingCode ?? descriptor.code;
    }
  }
  if (unit === FhirPeriodUnit.Week && value === 1) {
    timingCode = timingCode ?? "WK";
  }
  if (unit === FhirPeriodUnit.Month && value === 1) {
    timingCode = timingCode ?? "MO";
  }
  return {
    frequency: unit === FhirPeriodUnit.Day && value === 1 ? 1 : undefined,
    timingCode
  };
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
  const defaults = deriveDefaultTimingForPeriod(
    normalized.value,
    normalized.unit,
    internal.timingCode
  );
  if (defaults.frequency !== undefined) {
    internal.frequency = internal.frequency ?? defaults.frequency;
  }
  internal.timingCode = defaults.timingCode;
}

export function buildPeriodScheduleFeature(
  period: number,
  unit: FhirPeriodUnit
): HpsgScheduleFeature {
  const normalized = normalizePeriodValue(period, unit);
  const defaults = deriveDefaultTimingForPeriod(normalized.value, normalized.unit);
  return {
    period: normalized.value,
    periodUnit: normalized.unit,
    frequency: defaults.frequency,
    timingCode: defaults.timingCode
  };
}

export function mapIntervalUnit(token: string):
  | FhirPeriodUnit.Minute
  | FhirPeriodUnit.Hour
  | FhirPeriodUnit.Day
  | FhirPeriodUnit.Week
  | FhirPeriodUnit.Month
  | undefined {
  const unit = INTERVAL_UNITS.get(token);
  return unit === FhirPeriodUnit.Minute ||
    unit === FhirPeriodUnit.Hour ||
    unit === FhirPeriodUnit.Day ||
    unit === FhirPeriodUnit.Week ||
    unit === FhirPeriodUnit.Month
    ? unit
    : undefined;
}

export function mapFrequencyAdverb(token: string): FhirPeriodUnit | undefined {
  return FREQUENCY_ADVERB_UNITS.get(token);
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
