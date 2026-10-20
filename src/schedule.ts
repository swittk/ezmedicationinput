import { createTimingPrimitives } from "./regimen/scheduler-primitives";
import { TREATMENT_START_SYSTEM } from "./regimen/parallel-course";
import { getDosageCondition, getDosageExcludedDates, getUnresolvedDosage, DOSAGE_CONDITION_R5_URL, DOSAGE_EXCLUDED_DATES_R5_URL, toFhirR5Dosages, toDosageDetails, DOSAGE_DETAILS_R5_URL } from "./dosage-course";
import {
  getBodySiteAdministrationTargetCount
} from "./body-site-target";
import {
  EventTiming,
  EventClockMap,
  FhirDosage,
  EzDosage,
  EzDoseAndRate,
  FhirPeriodUnit,
  FhirQuantity,
  FhirTiming,
  FhirTimingRepeat,
  FrequencyFallbackTimes,
  CanonicalOccurrenceCapExpr,
  EstimatedQuantity,
  MealOffsetMap,
  MedicationContext,
  NextDueDoseConfig,
  NextDueDoseOptions,
  FhirR6DosageDetails,
  FhirR6Dosage,
  FhirR6RelativeTime,
  ParseBatchResult,
  RegimenDueTimes,
  TotalUnitsOptions,
  TotalUnitsResult
} from "./types";
import { parseAdditionalInstructions } from "./advice";
import { arrayIncludes } from "./utils/array";
import { convertValue, getBaseUnitFactor, getUnitCategory } from "./utils/units";
import { parseStrengthIntoRatio } from "./utils/strength";
import { getDoseUnitSemantics } from "./unit-lexicon";
import {
  getExactTimingOffsetMinutes,
  getTimingOccurrenceCap,
  TIMING_OCCURRENCE_CAP_EXTENSION_URL
} from "./fhir";

/**
 * Default institution times used when a dosage only specifies frequency without
 * explicit EventTiming anchors. Clinics can override these through the
 * configuration bag when desired.
 */
const DEFAULT_FREQUENCY_DEFAULTS: Required<FrequencyFallbackTimes> = {
  byCode: {
    BID: ["08:00", "20:00"],
    TID: ["08:00", "14:00", "20:00"],
    QID: ["08:00", "12:00", "16:00", "20:00"],
    QD: ["09:00"],
    QOD: ["09:00"],
    AM: ["08:00"],
    PM: ["20:00"]
  },
  byFrequency: {
    "freq:1/d": ["09:00"],
    "freq:2/d": ["08:00", "20:00"],
    "freq:3/d": ["08:00", "14:00", "20:00"],
    "freq:4/d": ["08:00", "12:00", "16:00", "20:00"]
  }
};

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_DAY = 24 * 60;
const TOTAL_UNITS_PRECISION = 1_000_000_000_000;

/** Caches expensive Intl.DateTimeFormat objects per time zone. */
const dateTimeFormatCache = new Map<string, Intl.DateTimeFormat>();
/** Separate cache for weekday formatting to avoid rebuilding formatters. */
const weekdayFormatCache = new Map<string, Intl.DateTimeFormat>();

interface TimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

interface ExpandedTime {
  time: string;
  dayShift: number;
}

interface DateTimeFormatPart {
  type: string;
  value: string;
}

interface IntlDateTimeFormatOptionsExtended extends Intl.DateTimeFormatOptions {
  calendar?: string;
  numberingSystem?: string;
}

interface DateTimeFormatWithParts extends Intl.DateTimeFormat {
  formatToParts?: (date: Date) => DateTimeFormatPart[];
}

/** Simple zero-padding helper for numeric components. */
function pad(value: number, length = 2): string {
  const absolute = Math.abs(value);
  let output = absolute.toString();
  while (output.length < length) {
    output = `0${output}`;
  }
  return value < 0 ? `-${output}` : output;
}

function formatToParts(formatter: Intl.DateTimeFormat, date: Date): DateTimeFormatPart[] {
  const withParts = formatter as DateTimeFormatWithParts;
  if (typeof withParts.formatToParts === "function") {
    return withParts.formatToParts(date);
  }
  const iso = date.toISOString();
  return [
    { type: "year", value: iso.slice(0, 4) },
    { type: "month", value: iso.slice(5, 7) },
    { type: "day", value: iso.slice(8, 10) },
    { type: "hour", value: iso.slice(11, 13) },
    { type: "minute", value: iso.slice(14, 16) },
    { type: "second", value: iso.slice(17, 19) }
  ];
}

/**
 * Normalizes HH:mm or HH:mm:ss clocks into a consistent HH:mm:ss string.
 */
function normalizeClock(clock: string): string {
  const parts = clock.split(":");
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`Invalid clock value: ${clock}`);
  }
  const [hourPart, minutePart, secondPart] = [
    parts[0],
    parts[1],
    parts[2] ?? "00"
  ];
  const hour = Number(hourPart);
  const minute = Number(minutePart);
  const second = Number(secondPart);
  if (
    Number.isNaN(hour) ||
    Number.isNaN(minute) ||
    Number.isNaN(second) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    throw new Error(`Invalid clock value: ${clock}`);
  }
  return `${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

function doseUnitSupportsPerTargetMultiplication(
  doseUnit: string | undefined,
  context: MedicationContext | undefined
): boolean {
  const semantics = getDoseUnitSemantics(doseUnit, context);
  if (!semantics) {
    return false;
  }
  return semantics.kind !== "metric" && semantics.kind !== "biologic_unit";
}

function getAdministrationTargetMultiplier(
  dosage: FhirDosage,
  context: MedicationContext | undefined
): number {
  const doseUnit = dosage.doseAndRate?.[0]?.doseQuantity?.unit;
  if (!doseUnitSupportsPerTargetMultiplication(doseUnit, context)) {
    return 1;
  }
  return getBodySiteAdministrationTargetCount(dosage.site) ?? 1;
}

/** Retrieves (and caches) an Intl formatter for calendar components. */
function getDateTimeFormat(timeZone: string): Intl.DateTimeFormat {
  let formatter = dateTimeFormatCache.get(timeZone);
  if (!formatter) {
    const options: IntlDateTimeFormatOptionsExtended = {
      timeZone,
      calendar: "iso8601",
      numberingSystem: "latn",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    };
    formatter = new Intl.DateTimeFormat("en-CA", options);
    dateTimeFormatCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Retrieves (and caches) a formatter for weekday lookups. */
function getWeekdayFormat(timeZone: string): Intl.DateTimeFormat {
  let formatter = weekdayFormatCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      weekday: "short"
    });
    weekdayFormatCache.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * Extracts calendar components for a Date interpreted within the supplied time
 * zone.
 */
function getTimeParts(date: Date, timeZone: string): TimeParts {
  const formatter = getDateTimeFormat(timeZone);
  const parts: Partial<TimeParts> = {};
  const rawParts = formatToParts(formatter, date);
  for (const part of rawParts) {
    if (part.type === "literal") {
      continue;
    }
    if (part.type === "year") {
      parts.year = Number(part.value);
    } else if (part.type === "month") {
      parts.month = Number(part.value);
    } else if (part.type === "day") {
      parts.day = Number(part.value);
    } else if (part.type === "hour") {
      parts.hour = Number(part.value);
    } else if (part.type === "minute") {
      parts.minute = Number(part.value);
    } else if (part.type === "second") {
      parts.second = Number(part.value);
    }
  }
  if (parts.hour === 24) {
    // Some locales express midnight as 24:00 of the previous day. Nudge the
    // instant forward slightly so we can capture the correct calendar date and
    // reset the hour component back to zero.
    const forward = new Date(date.getTime() + 60 * 1000);
    const forwardParts = formatToParts(formatter, forward);
    for (const part of forwardParts) {
      if (part.type === "literal") {
        continue;
      }
      if (part.type === "year") {
        parts.year = Number(part.value);
      } else if (part.type === "month") {
        parts.month = Number(part.value);
      } else if (part.type === "day") {
        parts.day = Number(part.value);
      }
    }
    parts.hour = 0;
    parts.minute = parts.minute ?? 0;
    parts.second = parts.second ?? 0;
  }
  if (
    parts.year === undefined ||
    parts.month === undefined ||
    parts.day === undefined ||
    parts.hour === undefined ||
    parts.minute === undefined ||
    parts.second === undefined
  ) {
    throw new Error("Unable to resolve time parts for provided date");
  }
  return parts as TimeParts;
}

/** Calculates the time-zone offset in minutes for a given instant. */
function getOffset(date: Date, timeZone: string): number {
  const { year, month, day, hour, minute, second } = getTimeParts(date, timeZone);
  const zonedTime = Date.UTC(year, month - 1, day, hour, minute, second);
  return (zonedTime - date.getTime()) / (SECONDS_PER_MINUTE * 1000);
}

/**
 * Renders an ISO-8601 string that reflects the provided time zone instead of
 * defaulting to UTC.
 */
function formatZonedIso(date: Date, timeZone: string): string {
  const { year, month, day, hour, minute, second } = getTimeParts(date, timeZone);
  const offsetMinutes = getOffset(date, timeZone);
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffset / SECONDS_PER_MINUTE);
  const offsetRemainder = absoluteOffset % SECONDS_PER_MINUTE;
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${offsetSign}${pad(offsetHours)}:${pad(offsetRemainder)}`;
}

/**
 * Builds a Date representing a local wall-clock time in the target time zone.
 */
function makeZonedDate(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): Date | null {
  const initialUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = new Date(initialUtc);
  let offset = getOffset(candidate, timeZone);
  candidate = new Date(initialUtc - offset * SECONDS_PER_MINUTE * 1000);
  const recalculatedOffset = getOffset(candidate, timeZone);
  if (recalculatedOffset !== offset) {
    candidate = new Date(initialUtc - recalculatedOffset * SECONDS_PER_MINUTE * 1000);
  }
  const parts = getTimeParts(candidate, timeZone);
  if (
    parts.year !== year ||
    parts.month !== month ||
    parts.day !== day ||
    parts.hour !== hour ||
    parts.minute !== minute ||
    parts.second !== second
  ) {
    return null;
  }
  return candidate;
}

/** Convenience wrapper around makeZonedDate for day-level math. */
function makeZonedDateFromDay(base: Date, timeZone: string, clock: string): Date | null {
  const { year, month, day } = getTimeParts(base, timeZone);
  const parts = clock.split(":").map((value) => Number(value));
  const hour = parts[0] ?? 0;
  const minute = parts[1] ?? 0;
  const second = parts[2] ?? 0;
  return makeZonedDate(timeZone, year, month, day, hour, minute, second);
}

/** Returns a Date pinned to the start of the local day. */
function startOfLocalDay(date: Date, timeZone: string): Date {
  const { year, month, day } = getTimeParts(date, timeZone);
  const zoned = makeZonedDate(timeZone, year, month, day, 0, 0, 0);
  if (!zoned) {
    throw new Error("Unable to resolve start of day for provided date");
  }
  return zoned;
}

/** Adds a number of calendar days while remaining aligned to the time zone. */
function addLocalDays(date: Date, days: number, timeZone: string): Date {
  const { year, month, day } = getTimeParts(date, timeZone);
  const rollover = new Date(Date.UTC(year, month - 1, day + days));
  const zoned = makeZonedDate(
    timeZone,
    rollover.getUTCFullYear(),
    rollover.getUTCMonth() + 1,
    rollover.getUTCDate(),
    0,
    0,
    0
  );
  if (!zoned) {
    throw new Error("Unable to shift local day – invalid calendar combination");
  }
  return zoned;
}

/** Computes the local weekday token (mon..sun). */
function getLocalWeekday(date: Date, timeZone: string): string {
  const formatted = getWeekdayFormat(timeZone).format(date);
  switch (formatted.toLowerCase()) {
    case "mon":
      return "mon";
    case "tue":
      return "tue";
    case "wed":
      return "wed";
    case "thu":
      return "thu";
    case "fri":
      return "fri";
    case "sat":
      return "sat";
    case "sun":
      return "sun";
    default:
      throw new Error(`Unexpected weekday token: ${formatted}`);
  }
}

function getLocalDayNumber(date: Date, timeZone: string): number {
  const { year, month, day } = getTimeParts(date, timeZone);
  return Math.floor(Date.UTC(year, month - 1, day) / (24 * 60 * 60 * 1000));
}

function getLocalMonthIndex(date: Date, timeZone: string): number {
  const { year, month } = getTimeParts(date, timeZone);
  return year * 12 + (month - 1);
}

function isDateAlignedToPeriodCycle(
  candidateDay: Date,
  anchorDay: Date,
  repeat: FhirTimingRepeat,
  timeZone: string
): boolean {
  const period = repeat.period;
  const periodUnit = repeat.periodUnit;
  if (!period || period <= 0 || !periodUnit) {
    return true;
  }

  if (periodUnit === "d") {
    const deltaDays = getLocalDayNumber(candidateDay, timeZone) - getLocalDayNumber(anchorDay, timeZone);
    return deltaDays >= 0 && deltaDays % period === 0;
  }
  if (periodUnit === "wk") {
    const deltaDays = getLocalDayNumber(candidateDay, timeZone) - getLocalDayNumber(anchorDay, timeZone);
    if (deltaDays < 0) {
      return false;
    }
    const deltaWeeks = Math.floor(deltaDays / 7);
    return deltaWeeks % period === 0;
  }
  if (periodUnit === "mo") {
    const deltaMonths = getLocalMonthIndex(candidateDay, timeZone) - getLocalMonthIndex(anchorDay, timeZone);
    return deltaMonths >= 0 && deltaMonths % period === 0;
  }
  if (periodUnit === "a") {
    const candidateYear = getTimeParts(candidateDay, timeZone).year;
    const anchorYear = getTimeParts(anchorDay, timeZone).year;
    const deltaYears = candidateYear - anchorYear;
    return deltaYears >= 0 && deltaYears % period === 0;
  }
  return true;
}

/** Parses arbitrary string/Date inputs into a valid Date instance. */
function coerceDate(value: Date | string, label: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${label} supplied to nextDueDoses`);
  }
  return date;
}

function roundCalculatedUnits(value: number): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  return Math.round((value + Number.EPSILON) * TOTAL_UNITS_PRECISION) / TOTAL_UNITS_PRECISION;
}

function resolveContextStrengthRatio(
  context?: TotalUnitsOptions["context"]
): NonNullable<TotalUnitsOptions["context"]>["strengthRatio"] | undefined {
  if (!context) {
    return undefined;
  }
  return context.strengthRatio ??
    (context.strength ? parseStrengthIntoRatio(context.strength, context) ?? undefined : undefined);
}

function estimateIngredientQuantity(
  quantity: EstimatedQuantity,
  context?: TotalUnitsOptions["context"]
): EstimatedQuantity | undefined {
  if (quantity.value === undefined || !quantity.unit) {
    return undefined;
  }
  const strength = resolveContextStrengthRatio(context);
  const numerator = strength?.numerator;
  const denominator = strength?.denominator;
  if (
    !numerator?.unit ||
    numerator.value === undefined ||
    !denominator?.unit ||
    denominator.value === undefined
  ) {
    return undefined;
  }
  const quantityCategory = getUnitCategory(quantity.unit);
  const denominatorCategory = getUnitCategory(denominator.unit);
  if (quantityCategory !== "other" && quantityCategory === denominatorCategory) {
    const quantityInDenominatorBase = quantity.value * getBaseUnitFactor(quantity.unit);
    const denominatorInBase = denominator.value * getBaseUnitFactor(denominator.unit);
    const numeratorInBase = numerator.value * getBaseUnitFactor(numerator.unit);
    if (denominatorInBase !== 0) {
      return {
        value: roundCalculatedUnits(
          (quantityInDenominatorBase * numeratorInBase) /
            denominatorInBase /
            getBaseUnitFactor(numerator.unit)
        ),
        unit: numerator.unit,
        confidence: quantity.confidence,
        basis: quantity.basis,
        source: quantity.source
      };
    }
  }
  const converted = convertValue(
    quantity.value,
    quantity.unit,
    numerator.unit,
    {
      numerator: { value: numerator.value, unit: numerator.unit },
      denominator: { value: denominator.value, unit: denominator.unit }
    }
  );
  if (converted === null) {
    return undefined;
  }
  return {
    value: roundCalculatedUnits(converted),
    unit: numerator.unit,
    confidence: quantity.confidence,
    basis: quantity.basis,
    source: quantity.source
  };
}

/**
 * Applies a minute offset to a normalized HH:mm:ss clock, tracking any day
 * rollover that might occur.
 */
function applyOffset(clock: string, offsetMinutes: number): ExpandedTime {
  const [hour, minute, second] = clock.split(":").map((part) => Number(part));
  const secondsPerHour = SECONDS_PER_MINUTE * SECONDS_PER_MINUTE;
  const secondsPerDay = MINUTES_PER_DAY * SECONDS_PER_MINUTE;
  let totalSeconds =
    hour * secondsPerHour + minute * SECONDS_PER_MINUTE + second +
    Math.round(offsetMinutes * SECONDS_PER_MINUTE);
  let dayShift = 0;
  while (totalSeconds < 0) {
    totalSeconds += secondsPerDay;
    dayShift -= 1;
  }
  while (totalSeconds >= secondsPerDay) {
    totalSeconds -= secondsPerDay;
    dayShift += 1;
  }
  const adjustedHour = Math.floor(totalSeconds / secondsPerHour);
  const remainder = totalSeconds % secondsPerHour;
  const adjustedMinute = Math.floor(remainder / SECONDS_PER_MINUTE);
  const adjustedSecond = remainder % SECONDS_PER_MINUTE;
  return {
    time: `${pad(adjustedHour)}:${pad(adjustedMinute)}:${pad(adjustedSecond)}`,
    dayShift
  };
}

function parseBoundsDurationUnit(quantity: FhirQuantity | undefined): FhirPeriodUnit | undefined {
  const candidate = quantity?.code?.trim().toLowerCase() ?? quantity?.unit?.trim().toLowerCase();
  switch (candidate) {
    case "s":
    case "sec":
    case "second":
    case "seconds":
      return FhirPeriodUnit.Second;
    case "min":
    case "mins":
    case "minute":
    case "minutes":
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
    case "wks":
    case "week":
    case "weeks":
      return FhirPeriodUnit.Week;
    case "mo":
    case "month":
    case "months":
      return FhirPeriodUnit.Month;
    case "a":
    case "yr":
    case "yrs":
    case "year":
    case "years":
      return FhirPeriodUnit.Year;
    default:
      return undefined;
  }
}

function resolveRepeatBoundsDuration(
  repeat: FhirTimingRepeat | undefined
): { value?: number; max?: number; unit?: FhirPeriodUnit } {
  if (!repeat) {
    return {};
  }
  if (repeat.boundsDuration?.value !== undefined) {
    return {
      value: repeat.boundsDuration.value,
      unit: parseBoundsDurationUnit(repeat.boundsDuration)
    };
  }
  if (!repeat.boundsRange) {
    return {};
  }
  return {
    value: repeat.boundsRange.low?.value,
    max: repeat.boundsRange.high?.value,
    unit: parseBoundsDurationUnit(repeat.boundsRange.low) ?? parseBoundsDurationUnit(repeat.boundsRange.high)
  };
}

function resolveRepeatBoundsStart(
  repeat: FhirTimingRepeat | undefined,
  timeZone: string
): Date | null {
  const value = repeat?.boundsPeriod?.start;
  if (!value) return null;
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (dateOnly) {
    return makeZonedDate(
      timeZone,
      Number(dateOnly[1]),
      Number(dateOnly[2]),
      Number(dateOnly[3]),
      0,
      0,
      0
    );
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function resolveRepeatBoundsEndExclusive(
  repeat: FhirTimingRepeat | undefined,
  timeZone: string
): Date | null {
  const value = repeat?.boundsPeriod?.end;
  if (!value) return null;
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (dateOnly) {
    const endDay = makeZonedDate(
      timeZone,
      Number(dateOnly[1]),
      Number(dateOnly[2]),
      Number(dateOnly[3]),
      0,
      0,
      0
    );
    return endDay ? addLocalDays(endDay, 1, timeZone) : null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getTime() + 1);
}

function earlierDate(left: Date | null, right: Date | null): Date | null {
  if (!left) return right;
  if (!right) return left;
  return left <= right ? left : right;
}

function resolveRepeatDurationCapEnd(
  repeat: FhirTimingRepeat | undefined,
  anchor: Date,
  timeZone: string
): Date | null {
  const bounds = resolveRepeatBoundsDuration(repeat);
  const durationValue = bounds.max ?? bounds.value;
  const durationUnit = bounds.unit;
  if (
    durationValue === undefined ||
    !Number.isFinite(durationValue) ||
    durationValue <= 0 ||
    !durationUnit
  ) {
    return null;
  }
  const stepper = createIntervalStepper(
    { period: durationValue, periodUnit: durationUnit },
    timeZone
  );
  if (!stepper) {
    return null;
  }
  return stepper(anchor) ?? null;
}

function resolveDayFilteredSeriesRepeat(
  repeat: FhirTimingRepeat,
  enforceDayFilter: boolean
): FhirTimingRepeat | undefined {
  if (!enforceDayFilter) {
    return undefined;
  }

  if (repeat.frequency) {
    return undefined;
  }

  if ((repeat.when?.length ?? 0) > 0 || (repeat.timeOfDay?.length ?? 0) > 0) {
    return undefined;
  }

  switch (repeat.periodUnit) {
    case FhirPeriodUnit.Week:
    case FhirPeriodUnit.Month:
    case FhirPeriodUnit.Year:
      return repeat.period ? repeat : undefined;
    case undefined:
      return repeat.period === undefined
        ? { ...repeat, period: 1, periodUnit: FhirPeriodUnit.Week }
        : undefined;
    default:
      return undefined;
  }
}

function repeatOccurrenceCap(repeat: FhirTimingRepeat): number | undefined {
  const raw = repeat.countMax ?? repeat.count;
  return raw === undefined ? undefined : Math.max(0, Math.floor(raw));
}

function isSingleAdministrationRepeat(repeat: FhirTimingRepeat): boolean {
  return (
    repeatOccurrenceCap(repeat) === 1 &&
    repeat.frequency === undefined &&
    repeat.frequencyMax === undefined &&
    repeat.period === undefined &&
    repeat.periodMax === undefined &&
    repeat.periodUnit === undefined &&
    (repeat.dayOfWeek?.length ?? 0) === 0 &&
    (repeat.when?.length ?? 0) === 0 &&
    (repeat.timeOfDay?.length ?? 0) === 0
  );
}

function hasUnresolvedRelationalInstruction(dosage: FhirDosage): boolean {
  const texts: string[] = [];
  if (dosage.patientInstruction?.trim()) {
    texts.push(dosage.patientInstruction.trim());
  }
  for (const instruction of dosage.additionalInstruction ?? []) {
    const text = instruction.text?.trim() || instruction.coding?.find((coding) => coding.display?.trim())?.display?.trim();
    if (text) {
      texts.push(text);
    }
  }
  for (const text of texts) {
    const parsed = parseAdditionalInstructions(
      text,
      { start: 0, end: text.length },
      { defaultPredicate: "take" }
    );
    for (const instruction of parsed) {
      for (const frame of instruction.frames) {
        if (frame.relation) {
          return true;
        }
      }
    }
  }
  return false;
}

function minDate(left: Date, right: Date | null): Date {
  if (!right) {
    return left;
  }
  return right.getTime() < left.getTime() ? right : left;
}

/** Provides the default meal pairing used for AC/PC expansions. */
function getDefaultMealPairs(config: NextDueDoseConfig): string[] {
  return [EventTiming.Breakfast, EventTiming.Lunch, EventTiming.Dinner];
}

const SPECIFIC_BEFORE_MEALS: Record<string, string> = {
  [EventTiming["Before Breakfast"]]: EventTiming.Breakfast,
  [EventTiming["Before Lunch"]]: EventTiming.Lunch,
  [EventTiming["Before Dinner"]]: EventTiming.Dinner
};

const SPECIFIC_AFTER_MEALS: Record<string, string> = {
  [EventTiming["After Breakfast"]]: EventTiming.Breakfast,
  [EventTiming["After Lunch"]]: EventTiming.Lunch,
  [EventTiming["After Dinner"]]: EventTiming.Dinner
};

function signedEventOffset(code: string, offset: number): number {
  if (
    code === EventTiming["Before Meal"] ||
    code in SPECIFIC_BEFORE_MEALS ||
    code === EventTiming["Before Sleep"]
  ) {
    return -offset;
  }
  return offset;
}

/**
 * Expands a single EventTiming code into concrete wall-clock entries.
 */
function expandTiming(
  code: string,
  config: NextDueDoseConfig,
  repeat: FhirTimingRepeat
): ExpandedTime[] {
  const mealOffsets: MealOffsetMap = config.mealOffsets ?? {};
  const eventClock = config.eventClock ?? {};
  const exactOffset = getExactTimingOffsetMinutes(repeat);
  const normalized: ExpandedTime[] = [];
  const clockValue = eventClock[code];
  if (clockValue) {
    normalized.push({ time: normalizeClock(clockValue), dayShift: 0 });
  } else if (code === EventTiming["Before Meal"]) {
    for (const meal of getDefaultMealPairs(config)) {
      const base = eventClock[meal];
      if (!base) {
        continue;
      }
      normalized.push(applyOffset(
        normalizeClock(base),
        exactOffset !== undefined ? 0 : mealOffsets[code] ?? 0
      ));
    }
  } else if (code === EventTiming["After Meal"]) {
    for (const meal of getDefaultMealPairs(config)) {
      const base = eventClock[meal];
      if (!base) {
        continue;
      }
      normalized.push(applyOffset(
        normalizeClock(base),
        exactOffset !== undefined ? 0 : mealOffsets[code] ?? 0
      ));
    }
  } else if (code === EventTiming.Meal) {
    for (const meal of getDefaultMealPairs(config)) {
      const base = eventClock[meal];
      if (!base) {
        continue;
      }
      normalized.push({ time: normalizeClock(base), dayShift: 0 });
    }
  } else if (code in SPECIFIC_BEFORE_MEALS) {
    const mealCode = SPECIFIC_BEFORE_MEALS[code];
    const base = eventClock[mealCode];
    if (base) {
      const baseClock = normalizeClock(base);
      const offset = exactOffset !== undefined
        ? 0
        : mealOffsets[code] ?? mealOffsets[EventTiming["Before Meal"]] ?? 0;
      normalized.push(offset ? applyOffset(baseClock, offset) : { time: baseClock, dayShift: 0 });
    }
  } else if (code in SPECIFIC_AFTER_MEALS) {
    const mealCode = SPECIFIC_AFTER_MEALS[code];
    const base = eventClock[mealCode];
    if (base) {
      const baseClock = normalizeClock(base);
      const offset = exactOffset !== undefined
        ? 0
        : mealOffsets[code] ?? mealOffsets[EventTiming["After Meal"]] ?? 0;
      normalized.push(offset ? applyOffset(baseClock, offset) : { time: baseClock, dayShift: 0 });
    }
  }

  if (exactOffset !== undefined && normalized.length) {
    return normalized.map((entry) => {
      const adjusted = applyOffset(entry.time, signedEventOffset(code, exactOffset ?? 0));
      return {
        time: adjusted.time,
        dayShift: entry.dayShift + adjusted.dayShift
      };
    });
  }

  return normalized;
}

/** Consolidates EventTiming arrays into a deduplicated/sorted clock list. */
function expandWhenCodes(
  whenCodes: string[],
  config: NextDueDoseConfig,
  repeat: FhirTimingRepeat
): ExpandedTime[] {
  const entries: ExpandedTime[] = [];
  const seen = new Set<string>();
  for (const code of whenCodes) {
    if (code === EventTiming.Immediate) {
      continue;
    }
    const expansions = expandTiming(code, config, repeat);
    for (const expansion of expansions) {
      const key = `${expansion.dayShift}|${expansion.time}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      entries.push(expansion);
    }
  }
  return entries.sort((a, b) => {
    if (a.dayShift !== b.dayShift) {
      return a.dayShift - b.dayShift;
    }
    return a.time.localeCompare(b.time);
  });
}

const DEFAULT_WHEN_FALLBACK_CLOCKS: Record<string, string[]> = {
  [EventTiming.Wake]: ["06:00:00"],
  [EventTiming["Early Morning"]]: ["06:00:00"],
  [EventTiming.Morning]: ["08:00:00"],
  [EventTiming["Late Morning"]]: ["10:00:00"],
  [EventTiming.Breakfast]: ["08:00:00"],
  [EventTiming["Before Breakfast"]]: ["07:30:00"],
  [EventTiming["After Breakfast"]]: ["08:30:00"],
  [EventTiming.Noon]: ["12:00:00"],
  [EventTiming.Lunch]: ["12:30:00"],
  [EventTiming["Before Lunch"]]: ["12:00:00"],
  [EventTiming["After Lunch"]]: ["13:00:00"],
  [EventTiming["Early Afternoon"]]: ["14:00:00"],
  [EventTiming.Afternoon]: ["15:00:00"],
  [EventTiming["Late Afternoon"]]: ["16:00:00"],
  [EventTiming["Early Evening"]]: ["18:00:00"],
  [EventTiming.Evening]: ["19:00:00"],
  [EventTiming["Late Evening"]]: ["20:00:00"],
  [EventTiming.Dinner]: ["18:30:00"],
  [EventTiming["Before Dinner"]]: ["18:00:00"],
  [EventTiming["After Dinner"]]: ["19:00:00"],
  [EventTiming.Night]: ["21:00:00"],
  [EventTiming["Before Sleep"]]: ["22:00:00"],
  [EventTiming["After Sleep"]]: ["06:30:00"],
  [EventTiming.Meal]: ["08:00:00", "12:30:00", "18:30:00"],
  [EventTiming["Before Meal"]]: ["07:30:00", "12:00:00", "18:00:00"],
  [EventTiming["After Meal"]]: ["08:30:00", "13:00:00", "19:00:00"]
};

function inferWhenFallbackEntries(
  whenCodes: string[],
  repeat: FhirTimingRepeat
): ExpandedTime[] {
  const entries: ExpandedTime[] = [];
  const seen = new Set<string>();
  const exactOffset = getExactTimingOffsetMinutes(repeat);

  const addClock = (clock: string, code: string) => {
    const normalized = normalizeClock(clock);
    const adjusted = exactOffset !== undefined
      ? applyOffset(normalized, signedEventOffset(code, exactOffset ?? 0))
      : { time: normalized, dayShift: 0 };
    const key = `${adjusted.dayShift}|${adjusted.time}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    entries.push(adjusted);
  };

  for (const code of whenCodes) {
    if (code === EventTiming.Immediate) {
      continue;
    }
    let fallbackClocks = DEFAULT_WHEN_FALLBACK_CLOCKS[code];
    if (exactOffset !== undefined) {
      if (code === EventTiming["Before Meal"] || code === EventTiming["After Meal"]) {
        fallbackClocks = DEFAULT_WHEN_FALLBACK_CLOCKS[EventTiming.Meal];
      } else if (code in SPECIFIC_BEFORE_MEALS) {
        fallbackClocks = DEFAULT_WHEN_FALLBACK_CLOCKS[SPECIFIC_BEFORE_MEALS[code]];
      } else if (code in SPECIFIC_AFTER_MEALS) {
        fallbackClocks = DEFAULT_WHEN_FALLBACK_CLOCKS[SPECIFIC_AFTER_MEALS[code]];
      }
    }
    if (!fallbackClocks) {
      continue;
    }
    for (const clock of fallbackClocks) {
      addClock(clock, code);
    }
  }

  return entries.sort((a, b) => {
    if (a.dayShift !== b.dayShift) {
      return a.dayShift - b.dayShift;
    }
    return a.time.localeCompare(b.time);
  });
}

function exactTimingEventOccurrences(
  timing: FhirTiming,
  repeat: FhirTimingRepeat | undefined,
  config: NextDueDoseConfig,
  from: Date,
  orderedAt: Date | null,
  courseEnd: Date | null,
  timeZone: string,
  limit: number,
  priorCount: number,
  derivePriorCount: boolean
): string[] | undefined {
  if (!timing.event?.length) return undefined;

  const whenCodes = repeat?.when ?? [];
  const expanded = repeat ? expandWhenCodes(whenCodes, config, repeat) : [];
  for (const clock of repeat?.timeOfDay ?? []) {
    expanded.push({ time: normalizeClock(clock), dayShift: 0 });
  }
  if (!expanded.length && repeat && whenCodes.length) {
    expanded.push(...inferWhenFallbackEntries(whenCodes, repeat));
  }

  const candidates: Date[] = [];
  for (const value of timing.event) {
    const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
    if (dateOnly) {
      const day = makeZonedDate(
        timeZone,
        Number(dateOnly[1]),
        Number(dateOnly[2]),
        Number(dateOnly[3]),
        0,
        0,
        0
      );
      if (!day) continue;
      if (expanded.length) {
        for (const entry of expanded) {
          const targetDay = entry.dayShift === 0 ? day : addLocalDays(day, entry.dayShift, timeZone);
          const target = makeZonedDateFromDay(targetDay, timeZone, entry.time);
          if (target) candidates.push(target);
        }
      } else {
        candidates.push(day);
      }
      continue;
    }

    const instant = new Date(value);
    if (!Number.isNaN(instant.getTime())) candidates.push(instant);
  }

  candidates.sort((left, right) => left.getTime() - right.getTime());
  const unique: Date[] = [];
  let historicalCount = 0;
  let previousTime: number | undefined;
  for (const candidate of candidates) {
    const time = candidate.getTime();
    if (time === previousTime) continue;
    previousTime = time;
    if (
      derivePriorCount &&
      orderedAt &&
      candidate >= orderedAt &&
      candidate < from &&
      (!courseEnd || candidate < courseEnd)
    ) {
      historicalCount += 1;
    }
    if (candidate < from) continue;
    if (orderedAt && candidate < orderedAt) continue;
    if (courseEnd && candidate >= courseEnd) continue;
    unique.push(candidate);
  }

  const countCap = repeat ? repeatOccurrenceCap(repeat) : undefined;
  const effectivePriorCount = derivePriorCount ? historicalCount : priorCount;
  const remaining = countCap === undefined
    ? limit
    : Math.max(0, Math.min(limit, countCap - effectivePriorCount));
  return unique.slice(0, remaining).map((candidate) => formatZonedIso(candidate, timeZone));
}

function mergeFrequencyDefaults(
  base?: FrequencyFallbackTimes,
  override?: FrequencyFallbackTimes
): FrequencyFallbackTimes | undefined {
  if (!base && !override) {
    return undefined;
  }
  const merged: FrequencyFallbackTimes = {};
  if (base?.byCode || override?.byCode) {
    merged.byCode = { ...(base?.byCode ?? {}), ...(override?.byCode ?? {}) };
  }
  if (base?.byFrequency || override?.byFrequency) {
    merged.byFrequency = { ...(base?.byFrequency ?? {}), ...(override?.byFrequency ?? {}) };
  }
  return merged;
}

function inferDailyFrequencyClocks(frequency: number): string[] {
  if (!Number.isFinite(frequency) || frequency <= 0) {
    return [];
  }
  if (frequency === 1) {
    return ["09:00:00"];
  }
  const startMinutes = 8 * 60;
  const endMinutes = 20 * 60;
  const spanMinutes = endMinutes - startMinutes;
  const clocks = new Set<string>();
  for (let index = 0; index < frequency; index += 1) {
    const minutes = startMinutes + Math.round((spanMinutes * index) / (frequency - 1));
    const hour = Math.floor(minutes / SECONDS_PER_MINUTE);
    const minute = minutes % SECONDS_PER_MINUTE;
    clocks.add(`${pad(hour)}:${pad(minute)}:00`);
  }
  return Array.from(clocks).sort();
}

/** Resolves fallback clock arrays for frequency-only schedules. */
function resolveFrequencyClocks(
  timing: FhirTiming,
  config: NextDueDoseConfig
): string[] {
  const defaults: Required<FrequencyFallbackTimes> = {
    byCode: {
      ...DEFAULT_FREQUENCY_DEFAULTS.byCode,
      ...(config.frequencyDefaults?.byCode ?? {})
    },
    byFrequency: {
      ...DEFAULT_FREQUENCY_DEFAULTS.byFrequency,
      ...(config.frequencyDefaults?.byFrequency ?? {})
    }
  };
  const collected = new Set<string>();
  const code = timing.code?.coding?.find((coding) => coding.code)?.code;
  const normalizedCode = code?.toUpperCase();
  if (normalizedCode && defaults.byCode?.[normalizedCode]) {
    for (const clock of defaults.byCode[normalizedCode]) {
      collected.add(normalizeClock(clock));
    }
  }
  const repeat = timing.repeat;
  if (repeat?.frequency && repeat.period && repeat.periodUnit) {
    const key = `freq:${repeat.frequency}/${repeat.periodUnit}`;
    if (defaults.byFrequency?.[key]) {
      for (const clock of defaults.byFrequency[key]) {
        collected.add(normalizeClock(clock));
      }
    }
    const perPeriodKey = `freq:${repeat.frequency}/per:${repeat.period}${repeat.periodUnit}`;
    if (defaults.byFrequency?.[perPeriodKey]) {
      for (const clock of defaults.byFrequency[perPeriodKey]) {
        collected.add(normalizeClock(clock));
      }
    }
    if (collected.size === 0 && repeat.period === 1 && repeat.periodUnit === "d") {
      for (const clock of inferDailyFrequencyClocks(repeat.frequency)) {
        collected.add(clock);
      }
    }
  }
  return Array.from(collected).sort();
}

function occurrenceCapBucketKey(
  date: Date,
  cap: CanonicalOccurrenceCapExpr,
  timeZone: string
): string {
  switch (cap.periodUnit) {
    case FhirPeriodUnit.Second:
      return `s:${Math.floor(date.getTime() / (cap.period * 1000))}`;
    case FhirPeriodUnit.Minute:
      return `min:${Math.floor(date.getTime() / (cap.period * 60 * 1000))}`;
    case FhirPeriodUnit.Hour:
      return `h:${Math.floor(date.getTime() / (cap.period * 60 * 60 * 1000))}`;
    case FhirPeriodUnit.Day:
      return `d:${Math.floor(getLocalDayNumber(date, timeZone) / cap.period)}`;
    case FhirPeriodUnit.Week: {
      const mondayWeek = Math.floor((getLocalDayNumber(date, timeZone) + 3) / 7);
      return `wk:${Math.floor(mondayWeek / cap.period)}`;
    }
    case FhirPeriodUnit.Month:
      return `mo:${Math.floor(getLocalMonthIndex(date, timeZone) / cap.period)}`;
    case FhirPeriodUnit.Year: {
      const { year } = getTimeParts(date, timeZone);
      return `a:${Math.floor(year / cap.period)}`;
    }
    default:
      return `raw:${date.getTime()}`;
  }
}

function applyOccurrenceCap(
  candidates: string[],
  cap: CanonicalOccurrenceCapExpr,
  priorDoseTimes: Array<Date | string> | undefined,
  timeZone: string,
  limit: number
): string[] {
  const priorCounts = new Map<string, number>();
  for (const value of priorDoseTimes ?? []) {
    const date = coerceDate(value, "priorDoseTimes");
    const key = occurrenceCapBucketKey(date, cap, timeZone);
    priorCounts.set(key, (priorCounts.get(key) ?? 0) + 1);
  }
  const generatedCounts = new Map<string, number>();
  const accepted: string[] = [];
  for (const candidate of candidates) {
    const date = coerceDate(candidate, "candidate");
    const key = occurrenceCapBucketKey(date, cap, timeZone);
    const used = (priorCounts.get(key) ?? 0) + (generatedCounts.get(key) ?? 0);
    if (used >= cap.max) continue;
    generatedCounts.set(key, (generatedCounts.get(key) ?? 0) + 1);
    accepted.push(candidate);
    if (accepted.length >= limit) break;
  }
  return accepted;
}

/** Maximum medication quantity per time window is not the same as a
 * frequency cap: divide by the actual per-administration quantity first.
 * Do not silently discard a limit when the dose unit cannot be compared. */
function executableQuantityCaps(dosage: FhirDosage): CanonicalOccurrenceCapExpr[] {
  const limits = dosage.maxDosePerPeriod ?? [];
  if (!limits.length) return [];
  const doseRates = dosage.doseAndRate ?? [];
  const dose = doseRates.length === 1 ? doseRates[0].doseQuantity : undefined;
  if (!dose || dose.comparator || !dose.value || !Number.isFinite(dose.value) ||
      dose.value <= 0) {
    throw new Error("A per-period maximum needs one known positive administered quantity");
  }
  const normalizeUnit = (unit: string) => {
    const text = unit.trim().toLowerCase();
    if (["tab", "tabs", "tablet", "tablets"].indexOf(text) >= 0) return "tab";
    if (["cap", "caps", "capsule", "capsules"].indexOf(text) >= 0) return "cap";
    if (["drop", "drops"].indexOf(text) >= 0) return "drop";
    return text;
  };
  const caps: CanonicalOccurrenceCapExpr[] = [];
  for (const ratio of limits) {
    const numerator = ratio.numerator, denominator = ratio.denominator;
    const maximum = numerator?.value;
    const period = denominator?.value;
    const periodUnit = denominator?.code ?? denominator?.unit;
    if (numerator?.comparator || denominator?.comparator ||
        maximum === undefined || !Number.isFinite(maximum) || maximum < 0 ||
        period === undefined || !Number.isInteger(period) || period <= 0 ||
        !periodUnit ||
        ["s", "min", "h", "d", "wk", "mo", "a"].indexOf(periodUnit) < 0) {
      throw new Error("Unsupported dose maximum period; cannot safely enforce the quantity limit");
    }
    const actualUnit = dose.code ?? dose.unit ?? "";
    const maximumUnit = numerator?.code ?? numerator?.unit ?? "";
    const normalizedActual = normalizeUnit(actualUnit);
    const normalizedMaximum = normalizeUnit(maximumUnit);
    const equivalentDose = normalizedActual === normalizedMaximum
      ? dose.value
      : convertValue(dose.value, actualUnit, maximumUnit);
    if (equivalentDose === null || !Number.isFinite(equivalentDose) ||
        equivalentDose <= 0) {
      throw new Error("Cannot enforce a dose maximum without compatible units or a medication strength");
    }
    caps.push({
      max: Math.floor(maximum / equivalentDose + 1e-9),
      period, periodUnit: periodUnit as FhirPeriodUnit
    });
  }
  return caps;
}

function applyQuantityCaps(
  candidates: string[],
  caps: readonly CanonicalOccurrenceCapExpr[],
  priorDoseTimes: Array<Date | string> | undefined,
  zone: string,
  limit: number
): string[] {
  if (!caps.length) return candidates.slice(0, Math.floor(limit));
  // R5 Dosage.maxDosePerPeriod means a maximum QUANTITY in a duration.
  // It is not a calendar-midnight reset: two 2-tablet administrations
  // before midnight must not license another 4 tablets after midnight.
  const prior = (priorDoseTimes ?? []).map(time => coerceDate(time, "priorDoseTimes").getTime())
    .sort((a, b) => a - b);
  const accepted: string[] = [];
  const acceptedTimes: number[] = [];
  const after = (sorted: readonly number[], boundary: number) => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid] <= boundary) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const windowStart = (at: Date, cap: CanonicalOccurrenceCapExpr): number => {
    const quantity = cap.period;
    switch (cap.periodUnit) {
      case FhirPeriodUnit.Second: return at.getTime() - quantity * 1000;
      case FhirPeriodUnit.Minute: return at.getTime() - quantity * 60_000;
      case FhirPeriodUnit.Hour: return at.getTime() - quantity * 3_600_000;
      case FhirPeriodUnit.Day: return at.getTime() - quantity * 86_400_000;
      case FhirPeriodUnit.Week: return at.getTime() - quantity * 7 * 86_400_000;
      case FhirPeriodUnit.Month: return addCalendarMonths(at, -quantity, zone).getTime();
      case FhirPeriodUnit.Year: return addCalendarMonths(at, -quantity * 12, zone).getTime();
      default: throw new Error("Unsupported maximum dose interval");
    }
  };
  for (const iso of candidates) {
    const at = new Date(iso);
    const timestamp = at.getTime();
    const fitsEveryCap = caps.every(cap => {
      const first = windowStart(at, cap);
      const existing = after(prior, timestamp) - after(prior, first);
      const upcoming = after(acceptedTimes, timestamp) - after(acceptedTimes, first);
      return existing + upcoming < cap.max;
    });
    if (!fitsEveryCap) continue;
    accepted.push(iso);
    acceptedTimes.push(timestamp);
    if (accepted.length >= limit) break;
  }
  return accepted;
}

/** Maxima copied from an R5 dosage are executable when every R6 dose
 * limit can be lowered to a standard quantity or ratio. Unknown clinical
 * safety expressions still need a dedicated evaluator. */
function executableR6Safety(component: FhirR6Dosage): boolean {
  const safety = component.safety;
  if (!safety) return true;
  if (safety.ifExceeded || safety.modifierExtension?.length ||
      safety.extension?.length) return false;
  return (safety.doseLimit ?? []).every(limit => {
    if (limit.extension?.length || limit.modifierExtension?.length ||
        limit.valueQuantity?.comparator ||
        limit.valueQuantity?.value === undefined) return false;
    if (limit.scope === "administration") return true;
    if (limit.scope === "period") {
      return !!limit.period?.value && !limit.period.comparator &&
        (limit.period.code !== undefined || limit.period.unit !== undefined);
    }
    // Lifetime and unqualified per-dosage expressions cannot be evaluated
    // from future timestamps and partial administration history.
    return false;
  });
}

function withoutOccurrenceCap(dosage: FhirDosage): FhirDosage {
  const timing = dosage.timing;
  const repeat = timing?.repeat;
  if (!timing || !repeat) return dosage;
  const extensions = (repeat.extension ?? []).filter(
    (extension) => extension.url !== TIMING_OCCURRENCE_CAP_EXTENSION_URL
  );
  return {
    ...dosage,
    timing: {
      ...timing,
      repeat: {
        ...repeat,
        extension: extensions.length ? extensions : undefined
      }
    }
  };
}

/**
 * Resolve a FHIR R6 RelativeTime tied to the standard "treatment-start"
 * event. Unlike Timing.repeat.startOffset, this is an offset from the
 * beginning of the entire treatment. Unsupported anchors are not guessed.
 */
function treatmentRelativeInstant(
  relative: FhirR6RelativeTime,
  orderedAt: Date,
  timeZone: string
): Date {
  const codes = relative.contextCode?.coding ?? [];
  const knownAnchor = codes.some(coding =>
    coding.system === TREATMENT_START_SYSTEM && coding.code === "treatment-start"
  );
  const duration = relative.offsetDuration;
  const quantity = duration?.value;
  const unit = duration?.code ?? duration?.unit;
  if (!knownAnchor || relative.contextReference || relative.contextDefinition ||
      relative.contextPath || relative.offsetRange ||
      quantity === undefined || !Number.isInteger(quantity) || quantity < 0) {
    throw new Error("Unsupported R6 step RelativeTime: requires an exact treatment-start offset");
  }
  switch (unit) {
    case "d": case "wk": {
      const days = unit === "wk" ? quantity * 7 : quantity;
      const parts = getTimeParts(orderedAt, timeZone);
      const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
      const result = makeZonedDate(timeZone, shifted.getUTCFullYear(),
        shifted.getUTCMonth() + 1, shifted.getUTCDate(), parts.hour, parts.minute, parts.second);
      if (!result) throw new Error("Invalid R6 treatment-day offset");
      return result;
    }
    case "mo": case "a":
      return addCalendarMonths(orderedAt, quantity * (unit === "a" ? 12 : 1), timeZone);
    default:
      throw new Error("Unsupported R6 treatment-start time unit");
  }
}

/**
 * Administer one global step at a time, while retaining its simultaneous
 * site-specific components. All absolute boundaries derive from orderedAt;
 * querying halfway through a treatment cannot reset the course clock.
 */
function scheduleTreatmentRelativeCourse(
  course: FhirR6DosageDetails, options: NextDueDoseOptions
): string[] {
  if (options.orderedAt === undefined)
    throw new Error("orderedAt is required for relative treatment-step scheduling");
  if (options.priorCount !== undefined)
    throw new Error("priorCount is ambiguous across concurrent treatment components");
  const timeZone = options.timeZone ?? options.config?.timeZone;
  if (!timeZone) throw new Error("timeZone is required for relative treatment-step scheduling");
  const from = coerceDate(options.from, "from");
  const anchor = coerceDate(options.orderedAt, "orderedAt");
  const limit = Math.floor(options.limit ?? 10);
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const flattened = toFhirR5Dosages(course);
  const doses: string[] = [];
  let previousEnd = anchor;
  let componentIndex = 0;
  for (let index = 0; index < course.step.length; index++) {
    const step = course.step[index];
    const start = step.start
      ? treatmentRelativeInstant(step.start, anchor, timeZone)
      : previousEnd;
    const end = step.end
      ? treatmentRelativeInstant(step.end, anchor, timeZone)
      : undefined;
    if (start.getTime() !== previousEnd.getTime() ||
        end && end.getTime() <= start.getTime() ||
        !end && index + 1 < course.step.length) {
      throw new Error("R6 treatment steps must be ordered, contiguous and finitely ended before the final step");
    }
    for (const component of step.component) {
      const original = flattened[componentIndex++];
      if (!original) throw new Error("R6 course component projection is incomplete");
      if (component.timing?.repeat?.boundsDuration ||
          component.timing?.repeat?.boundsPeriod ||
          component.timing?.repeat?.boundsRange) {
        throw new Error("Unsupported overlapping R6 component and global step bounds");
      }
      const dosage = {
        ...original,
        modifierExtension: original.modifierExtension?.filter(ext =>
          ext.url !== DOSAGE_DETAILS_R5_URL)
      };
      if (end && from >= end) continue;
      const effectiveFrom = from > start ? from : start;
      const candidateTimes = nextDueDoses(dosage, {
        ...options, from: effectiveFrom, orderedAt: start, limit
      });
      for (const time of candidateTimes) {
        if (end && Date.parse(time) >= end.getTime()) break;
        doses.push(time);
      }
    }
    if (end) previousEnd = end;
  }
  return doses.sort((left, right) => Date.parse(left) - Date.parse(right))
    .slice(0, limit);
}

/**
 * Produces the next dose timestamps in ascending order according to the
 * provided configuration and dosage metadata.
 */
export function nextDueDoses(
  dosage: FhirDosage | readonly FhirDosage[] | FhirR6DosageDetails | ParseBatchResult,
  options: NextDueDoseOptions
): string[] {
  // The most ergonomic call accepts parseSig() directly.
  if (dosage && !Array.isArray(dosage) && "items" in dosage) {
    const result = dosage as ParseBatchResult;
    // Whole-course public result also carries a strict R6 projection.
    // Use it so step-level rules cannot be lost by flattening the array.
    return nextDueDoses(result.fhirNext, options);
  }
  if (Array.isArray(dosage) || (dosage && "step" in dosage)) {
    if (Array.isArray(dosage) && dosage.some((item: FhirDosage) =>
      item.modifierExtension?.some(extension => extension.url === DOSAGE_DETAILS_R5_URL))) {
      // This is a strict R5 projection of a course with extra semantics.
      // Restore its original step boundaries rather than executing a flat
      // representation that cannot express those relative starts.
      return nextDueDoses(toDosageDetails(dosage), options);
    }
    const r6Course = !Array.isArray(dosage) && "step" in dosage
      ? dosage as FhirR6DosageDetails : undefined;
    if (r6Course && (
      r6Course.repeatCycle || r6Course.safety ||
      r6Course.step.some(step => step.count !== undefined || step.safety ||
        step.component.some(component =>
          !executableR6Safety(component)))
    )) {
      throw new Error("This R6 course has unsupported safety/cycle rules and requires an R6-aware scheduler");
    }
    if (r6Course && r6Course.step.some(step => step.start || step.end)) {
      return scheduleTreatmentRelativeCourse(r6Course, options);
    }
    const items = Array.isArray(dosage) ? [...dosage] :
      toFhirR5Dosages(r6Course!).map(item => ({
        ...item,
        // The course retention marker is for downstream R5 consumers. We
        // already hold the authoritative R6 object and have checked its
        // unsupported execution semantics above.
        modifierExtension: item.modifierExtension?.filter(ext => ext.url !== DOSAGE_DETAILS_R5_URL)
      }));
    const limit = options?.limit ?? 10;
    if (!Number.isFinite(limit) || limit <= 0) return [];
    // Body-site references and dose expressions affect the administration
    // target/amount, not the clock. They must not block timing enumeration.
    // Quantity limits are checked by nextDueDosesSingle for each member.
    if (items.some(item => {
      const extended = item as EzDosage;
      return extended.safety && !item.maxDosePerPeriod &&
        !item.maxDosePerAdministration && !item.maxDosePerLifetime;
    })) {
      throw new Error("An unsupported safety limit requires a dedicated evaluator");
    }
    const episodes = scheduleRegimen(items, { ...options, limit });
    return episodes.reduce<string[]>((all, episode) => {
      all.push(...episode.timestamps);
      return all;
    }, []).sort((a, b) => Date.parse(a) - Date.parse(b)).slice(0, Math.floor(limit));
  }
  const one = dosage as FhirDosage;
  const unresolved = getUnresolvedDosage(one);
  if (unresolved) throw new Error(`Cannot schedule unresolved dosage: ${unresolved}`);
  const guard = getDosageCondition(one);
  const exclusions = getDosageExcludedDates(one);
  if (guard || exclusions.length) {
    const limit = options?.limit ?? 10;
    if (!Number.isFinite(limit) || limit <= 0) return [];
    if (guard && !options?.evaluateCondition) {
      throw new Error("Conditional dosage requires evaluateCondition(at) for safe scheduling");
    }
    const timeZone = options?.timeZone ?? options?.config?.timeZone;
    if (!timeZone) throw new Error("A timeZone is required for exclusion-date scheduling");
    // Native EzDosage mirrors conditional/date semantics as direct fields
    // AND in R5 modifiers. Clear both representations before enumerating
    // candidate times, otherwise recursively re-enter this very filter.
    const { condition: _condition, excludedDates: _excludedDates, ...plainDosage } =
      one as EzDosage;
    const quantityCaps = executableQuantityCaps(one);
    const unconstrained: FhirDosage = {
      ...plainDosage,
      maxDosePerPeriod: undefined,
      modifierExtension: plainDosage.modifierExtension?.filter(extension =>
        extension.url !== DOSAGE_CONDITION_R5_URL &&
        extension.url !== DOSAGE_EXCLUDED_DATES_R5_URL)
    };
    let candidateLimit = Math.min(10000, Math.max(16, Math.floor(limit) * 2));
    while (true) {
      const candidates = nextDueDoses(unconstrained, { ...options, limit: candidateLimit });
      const accepted: string[] = [];
      for (const at of candidates) {
        if (exclusions.length) {
          const { year, month, day } = getTimeParts(new Date(at), timeZone);
          const localDate = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
          if (exclusions.indexOf(localDate) >= 0) continue;
        }
        if (guard) {
          const eligible = options.evaluateCondition!(guard, at);
          if (eligible === undefined) {
            throw new Error("Conditional dosage evaluator returned unknown; cannot issue an unconditional dose");
          }
          if (!eligible) continue;
        }
        accepted.push(at);
        if (!quantityCaps.length && accepted.length >= limit) break;
      }
      // A conditional occurrence that is not administered does not consume
      // the quantity allowance. Apply the cap AFTER exclusions/predicates.
      const capped = applyQuantityCaps(accepted, quantityCaps,
        options.priorDoseTimes, timeZone, limit);
      if (capped.length >= limit || candidates.length < candidateLimit || candidateLimit === 10000) {
        return capped;
      }
      candidateLimit = Math.min(10000, candidateLimit * 2);
    }
  }

  return nextDueDosesSingle(one, options);
}

function nextDueDosesSingle(dosage: FhirDosage, options: NextDueDoseOptions): string[] {
  if (!options || typeof options !== "object") {
    throw new Error("Options argument is required for nextDueDoses");
  }
  if (options.from === undefined) {
    throw new Error("The 'from' option is required for nextDueDoses");
  }
  const limit = options.limit ?? 10;
  if (!Number.isFinite(limit) || limit <= 0) {
    return [];
  }

  let from = coerceDate(options.from, "from");
  const orderedAt =
    options.orderedAt === undefined ? null : coerceDate(options.orderedAt, "orderedAt");
  const priorCountInput = options.priorCount;
  if (priorCountInput !== undefined) {
    if (!Number.isFinite(priorCountInput) || priorCountInput < 0) {
      throw new Error("Invalid priorCount supplied to nextDueDoses");
    }
  }
  let priorCount = priorCountInput !== undefined ? Math.floor(priorCountInput) : 0;
  const needsDerivedPriorCount = priorCountInput === undefined && !!orderedAt;

  const providedConfig = options.config;
  const timeZone = options.timeZone ?? providedConfig?.timeZone;
  if (!timeZone) {
    throw new Error("Configuration with a valid timeZone is required");
  }
  if (dosage.maxDosePerLifetime)
    throw new Error("Lifetime dose maximum requires complete historical dose data");
  if (dosage.maxDosePerAdministration) {
    const dose = dosage.doseAndRate?.length === 1
      ? dosage.doseAndRate[0].doseQuantity : undefined;
    const maximum = dosage.maxDosePerAdministration;
    if (!dose?.value || !maximum.value || dose.value <= 0 ||
        dose.comparator || maximum.comparator)
      throw new Error("Cannot enforce per-administration maximum without an actual dose quantity");
    const unit = dose.code ?? dose.unit ?? "";
    const targetUnit = maximum.code ?? maximum.unit ?? "";
    const actual = unit.toLowerCase() === targetUnit.toLowerCase()
      ? dose.value : convertValue(dose.value, unit, targetUnit);
    if (actual === null || actual > maximum.value + 1e-9)
      throw new Error("Prescribed dose exceeds per-administration maximum or has incompatible units");
  }
  const quantityCaps = executableQuantityCaps(dosage);
  if (quantityCaps.length) {
    const requestLimit = Math.floor(limit);
    let candidateLimit = Math.min(10000, Math.max(16, requestLimit * 4));
    const unsafeguarded: FhirDosage = { ...dosage, maxDosePerPeriod: undefined };
    while (true) {
      const candidates = nextDueDoses(unsafeguarded, { ...options, limit: candidateLimit });
      const accepted = applyQuantityCaps(candidates, quantityCaps,
        options.priorDoseTimes, timeZone, requestLimit);
      if (accepted.length >= requestLimit || candidates.length < candidateLimit ||
          candidateLimit >= 10000) return accepted;
      candidateLimit = Math.min(10000, candidateLimit * 2);
    }
  }
  const occurrenceCap = getTimingOccurrenceCap(dosage.timing?.repeat);
  if (occurrenceCap) {
    const requestedLimit = Math.floor(limit);
    let candidateLimit = Math.min(10000, Math.max(16, requestedLimit * 4));
    while (true) {
      const uncapped = nextDueDoses(withoutOccurrenceCap(dosage), {
        ...options,
        limit: candidateLimit,
        priorDoseTimes: undefined
      });
      const capped = applyOccurrenceCap(
        uncapped,
        occurrenceCap,
        options.priorDoseTimes,
        timeZone,
        requestedLimit
      );
      if (
        capped.length >= requestedLimit ||
        uncapped.length < candidateLimit ||
        candidateLimit >= 10000
      ) return capped;
      candidateLimit = Math.min(10000, candidateLimit * 2);
    }
  }
  const eventClock: EventClockMap = {
    ...(providedConfig?.eventClock ?? {}),
    ...(options.eventClock ?? {})
  };
  const mealOffsets: MealOffsetMap = {
    ...(providedConfig?.mealOffsets ?? {}),
    ...(options.mealOffsets ?? {})
  };
  const frequencyDefaults = mergeFrequencyDefaults(
    providedConfig?.frequencyDefaults,
    options.frequencyDefaults
  );
  const config: NextDueDoseConfig = {
    timeZone,
    eventClock,
    mealOffsets,
    frequencyDefaults
  };
  const timing: FhirTiming | undefined = dosage.timing;
  const repeat: FhirTimingRepeat | undefined = timing?.repeat;
  const boundsStart = resolveRepeatBoundsStart(repeat, timeZone);
  if (boundsStart && boundsStart > from) {
    from = boundsStart;
  }
  const effectiveOrderedAt =
    orderedAt && boundsStart && boundsStart > orderedAt ? boundsStart : orderedAt;
  const baseCandidate = effectiveOrderedAt ?? boundsStart ?? from;
  const baseTime = boundsStart && boundsStart > baseCandidate ? boundsStart : baseCandidate;
  const courseEnd = timing && repeat
    ? earlierDate(
      resolveRepeatDurationCapEnd(repeat, baseTime, timeZone),
      resolveRepeatBoundsEndExclusive(repeat, timeZone)
    )
    : null;

  if (timing) {
    const exactEvents = exactTimingEventOccurrences(
      timing,
      repeat,
      config,
      from,
      effectiveOrderedAt,
      courseEnd,
      timeZone,
      Math.floor(limit),
      priorCount,
      needsDerivedPriorCount
    );
    if (exactEvents !== undefined) {
      return exactEvents;
    }
  }

  if (
    needsDerivedPriorCount &&
    effectiveOrderedAt &&
    timing &&
    repeat &&
    repeatOccurrenceCap(repeat) !== undefined
  ) {
    priorCount = derivePriorCountFromHistory(
      timing,
      repeat,
      config,
      effectiveOrderedAt,
      from,
      timeZone
    );
  }

  if (!timing || !repeat) {
    return [];
  }
  if (courseEnd && from >= courseEnd) {
    return [];
  }

  const normalizedCount = repeatOccurrenceCap(repeat);
  if (normalizedCount === 0) {
    return [];
  }
  const remainingCount =
    normalizedCount === undefined ? undefined : Math.max(0, normalizedCount - priorCount);
  if (remainingCount === 0) {
    return [];
  }
  const effectiveLimit =
    remainingCount !== undefined ? Math.min(limit, remainingCount) : limit;

  if (isSingleAdministrationRepeat(repeat)) {
    if (hasUnresolvedRelationalInstruction(dosage)) {
      return [];
    }
    const anchor = orderedAt ?? from;
    if ((orderedAt && orderedAt < from) || (courseEnd && anchor >= courseEnd)) {
      return [];
    }
    return [formatZonedIso(anchor, timeZone)].slice(0, effectiveLimit);
  }

  const results: string[] = [];
  const seen = new Set<string>();
  const dayFilter = new Set((repeat.dayOfWeek ?? []).map((day) => day.toLowerCase()));
  const enforceDayFilter = dayFilter.size > 0;
  const dayFilteredSeriesRepeat = resolveDayFilteredSeriesRepeat(repeat, enforceDayFilter);

  const whenCodes = repeat.when ?? [];
  const timeOfDayEntries = repeat.timeOfDay ?? [];
  if (whenCodes.length > 0 || timeOfDayEntries.length > 0) {
    const cadenceAnchor = resolveRepeatBoundsStart(repeat, timeZone) ?? orderedAt ?? from;
    const expanded = resolveExplicitClockEntries(repeat, config, enforceDayFilter);
    const includesImmediate = arrayIncludes(whenCodes, EventTiming.Immediate);
    if (includesImmediate) {
      const immediateSource = orderedAt ?? from;
      if ((!orderedAt || orderedAt >= from) && (!courseEnd || immediateSource < courseEnd)) {
        const instantIso = formatZonedIso(immediateSource, timeZone);
        if (!seen.has(instantIso)) {
          seen.add(instantIso);
          results.push(instantIso);
        }
      }
    }
    if (results.length >= effectiveLimit) {
      return results.slice(0, effectiveLimit);
    }
    const canFallbackToFrequency =
      expanded.length === 0 &&
      timeOfDayEntries.length === 0 &&
      !!repeat.frequency &&
      !!repeat.period &&
      !!repeat.periodUnit;

    if (!canFallbackToFrequency) {
      if (expanded.length === 0) {
        return results.slice(0, effectiveLimit);
      }
      let currentDay = startOfLocalDay(from, timeZone);
      let iterations = 0;
      const maxIterations = effectiveLimit * 31;
      while (
        results.length < effectiveLimit &&
        iterations < maxIterations &&
        (!courseEnd || currentDay < courseEnd)
      ) {
        const weekday = getLocalWeekday(currentDay, timeZone);
        if ((!enforceDayFilter || dayFilter.has(weekday)) && clockCadenceEligible(currentDay, cadenceAnchor, repeat, timeZone, enforceDayFilter)) {
          for (const entry of expanded) {
            const targetDay = entry.dayShift === 0
              ? currentDay
              : addLocalDays(currentDay, entry.dayShift, timeZone);
            const zoned = makeZonedDateFromDay(targetDay, timeZone, entry.time);
            if (!zoned) {
              continue;
            }
            if (zoned < from) {
              continue;
            }
            if (orderedAt && zoned < orderedAt) {
              continue;
            }
            if (courseEnd && zoned >= courseEnd) {
              continue;
            }
            const iso = formatZonedIso(zoned, timeZone);
            if (!seen.has(iso)) {
              seen.add(iso);
              results.push(iso);
              if (results.length === effectiveLimit) {
                break;
              }
            }
          }
        }
        if (results.length >= effectiveLimit) {
          break;
        }
        currentDay = addLocalDays(currentDay, 1, timeZone);
        iterations += 1;
      }
      return results.slice(0, effectiveLimit);
    }
  }

  const treatAsInterval =
    !!repeat.period &&
    !!repeat.periodUnit &&
    (!repeat.frequency ||
      repeat.periodUnit !== "d" ||
      (repeat.frequency === 1 && repeat.period > 1));

  const supportsDayFilteredInterval = isDayFilteredIntervalSupported(
    repeat,
    enforceDayFilter
  );

  if (treatAsInterval && supportsDayFilteredInterval) {
    // True interval schedules advance from the order start in fixed units. The
    // timing.code remains advisory so we only rely on the period/unit fields.
    const candidates = generateIntervalSeries(
      baseTime,
      from,
      effectiveLimit,
      repeat,
      timeZone,
      dayFilter,
      enforceDayFilter,
      orderedAt,
      courseEnd
    );
    return candidates;
  }

  if (dayFilteredSeriesRepeat) {
    return generateDayFilteredPeriodSeries({
      repeat: dayFilteredSeriesRepeat,
      timeZone,
      dayFilter,
      anchorDay: startOfLocalDay(baseTime, timeZone),
      startDay: from,
      from,
      to: courseEnd ?? undefined,
      orderedAt,
      limit: effectiveLimit,
      defaultClock: toLocalClock(baseTime, timeZone)
    }).slice(0, effectiveLimit);
  }

  if (repeat.frequency && repeat.period && repeat.periodUnit) {
    // Pure frequency schedules (e.g., BID/TID) rely on institution clocks that
    // clinicians expect. These can be overridden via configuration when
    // facilities use bespoke medication rounds.
    const clocks = resolveFrequencyClocks(timing, config);
    if (clocks.length === 0) {
      return [];
    }
    let currentDay = startOfLocalDay(from, timeZone);
    let iterations = 0;
    const maxIterations = effectiveLimit * 31;
    while (
      results.length < effectiveLimit &&
      iterations < maxIterations &&
      (!courseEnd || currentDay < courseEnd)
    ) {
      const weekday = getLocalWeekday(currentDay, timeZone);
      if (!enforceDayFilter || dayFilter.has(weekday)) {
        for (const clock of clocks) {
          const zoned = makeZonedDateFromDay(currentDay, timeZone, clock);
          if (!zoned) {
            continue;
          }
          if (zoned < from) {
            continue;
          }
          if (orderedAt && zoned < orderedAt) {
            continue;
          }
          if (courseEnd && zoned >= courseEnd) {
            continue;
          }
          const iso = formatZonedIso(zoned, timeZone);
          if (!seen.has(iso)) {
            seen.add(iso);
            results.push(iso);
            if (results.length === effectiveLimit) {
              break;
            }
          }
        }
      }
      currentDay = addLocalDays(currentDay, 1, timeZone);
      iterations += 1;
    }
    return results.slice(0, effectiveLimit);
  }

  return [];
}

function derivePriorCountFromHistory(
  timing: FhirTiming,
  repeat: FhirTimingRepeat,
  config: NextDueDoseConfig,
  orderedAt: Date,
  from: Date,
  timeZone: string
): number {
  if (from <= orderedAt) {
    return 0;
  }

  const normalizedCount = repeatOccurrenceCap(repeat);

  if (normalizedCount === 0) {
    return 0;
  }

  const dayFilter = new Set((repeat.dayOfWeek ?? []).map((day) => day.toLowerCase()));
  const enforceDayFilter = dayFilter.size > 0;
  const dayFilteredSeriesRepeat = resolveDayFilteredSeriesRepeat(repeat, enforceDayFilter);
  const seen = new Set<string>();
  let count = 0;

  const recordCandidate = (candidate: Date | null) => {
    if (!candidate) {
      return false;
    }
    if (candidate < orderedAt || candidate >= from) {
      return false;
    }
    const iso = formatZonedIso(candidate, timeZone);
    if (seen.has(iso)) {
      return false;
    }
    seen.add(iso);
    count += 1;
    return true;
  };

  const whenCodes = repeat.when ?? [];
  const timeOfDayEntries = repeat.timeOfDay ?? [];

  if (whenCodes.length > 0 || timeOfDayEntries.length > 0) {
    const cadenceAnchor = resolveRepeatBoundsStart(repeat, timeZone) ?? orderedAt ?? from;
    const expanded = resolveExplicitClockEntries(repeat, config, enforceDayFilter);

    if (arrayIncludes(whenCodes, EventTiming.Immediate)) {
      if (recordCandidate(orderedAt) && normalizedCount !== undefined && seen.size >= normalizedCount) {
        return count;
      }
    }

    const canFallbackToFrequency =
      expanded.length === 0 &&
      timeOfDayEntries.length === 0 &&
      !!repeat.frequency &&
      !!repeat.period &&
      !!repeat.periodUnit;

    if (!canFallbackToFrequency) {
      if (expanded.length === 0) {
        return count;
      }

      let currentDay = startOfLocalDay(orderedAt, timeZone);
      let iterations = 0;
      const maxIterations = normalizedCount !== undefined ? normalizedCount * 31 : 31 * 365;
      while (currentDay < from && iterations < maxIterations) {
        const weekday = getLocalWeekday(currentDay, timeZone);
        if ((!enforceDayFilter || dayFilter.has(weekday)) && clockCadenceEligible(currentDay, cadenceAnchor, repeat, timeZone, enforceDayFilter)) {
          for (const entry of expanded) {
            const targetDay = entry.dayShift === 0
              ? currentDay
              : addLocalDays(currentDay, entry.dayShift, timeZone);
            const zoned = makeZonedDateFromDay(targetDay, timeZone, entry.time);
            if (!zoned) {
              continue;
            }
            if (zoned < orderedAt || zoned >= from) {
              continue;
            }
            if (recordCandidate(zoned) && normalizedCount !== undefined && seen.size >= normalizedCount) {
              return count;
            }
          }
        }
        currentDay = addLocalDays(currentDay, 1, timeZone);
        iterations += 1;
      }

      return count;
    }
  }

  const treatAsInterval =
    !!repeat.period &&
    !!repeat.periodUnit &&
    (!repeat.frequency ||
      repeat.periodUnit !== "d" ||
      (repeat.frequency === 1 && repeat.period > 1));

  const supportsDayFilteredInterval = isDayFilteredIntervalSupported(
    repeat,
    enforceDayFilter
  );

  if (treatAsInterval && supportsDayFilteredInterval) {
    const increment = createIntervalStepper(repeat, timeZone);
    if (!increment) {
      return count;
    }

    let current = orderedAt;
    let guard = 0;
    const maxIterations = normalizedCount !== undefined ? normalizedCount * 1000 : 1000;
    while (current < from && guard < maxIterations) {
      const weekday = getLocalWeekday(current, timeZone);
      if (!enforceDayFilter || dayFilter.has(weekday)) {
        if (recordCandidate(current) && normalizedCount !== undefined && seen.size >= normalizedCount) {
          return count;
        }
      }
      const next = increment(current);
      if (!next || next.getTime() === current.getTime()) {
        break;
      }
      current = next;
      guard += 1;
    }

    return count;
  }

  if (dayFilteredSeriesRepeat) {
    const generated = generateDayFilteredPeriodSeries({
      repeat: dayFilteredSeriesRepeat,
      timeZone,
      dayFilter,
      anchorDay: startOfLocalDay(orderedAt, timeZone),
      startDay: orderedAt,
      from: orderedAt,
      to: from,
      orderedAt,
      limit: normalizedCount ?? 31 * 365,
      defaultClock: toLocalClock(orderedAt, timeZone)
    });
    return count + generated.length;
  }

  if (repeat.frequency && repeat.period && repeat.periodUnit) {
    const clocks = resolveFrequencyClocks(timing, config);
    if (clocks.length === 0) {
      return count;
    }

    let currentDay = startOfLocalDay(orderedAt, timeZone);
    let iterations = 0;
    const maxIterations = normalizedCount !== undefined ? normalizedCount * 31 : 31 * 365;
    while (currentDay < from && iterations < maxIterations) {
      const weekday = getLocalWeekday(currentDay, timeZone);
      if (!enforceDayFilter || dayFilter.has(weekday)) {
        for (const clock of clocks) {
          const zoned = makeZonedDateFromDay(currentDay, timeZone, clock);
          if (!zoned) {
            continue;
          }
          if (zoned < orderedAt || zoned >= from) {
            continue;
          }
          if (recordCandidate(zoned) && normalizedCount !== undefined && seen.size >= normalizedCount) {
            return count;
          }
        }
      }
      currentDay = addLocalDays(currentDay, 1, timeZone);
      iterations += 1;
    }
  }

  return count;
}

/**
 * Generates an interval-based series by stepping forward from the base time
 * until the requested number of timestamps have been produced.
 */
function generateIntervalSeries(
  baseTime: Date,
  from: Date,
  effectiveLimit: number,
  repeat: FhirTimingRepeat,
  timeZone: string,
  dayFilter: Set<string>,
  enforceDayFilter: boolean,
  orderedAt: Date | null,
  upperBound?: Date | null
): string[] {
  const increment = createIntervalStepper(repeat, timeZone);
  if (!increment) {
    return [];
  }
  const results: string[] = [];
  const seen = new Set<string>();
  let current = baseTime;
  let guard = 0;
  const maxIterations = effectiveLimit * 1000;
  while (current < from && guard < maxIterations) {
    const next = increment(current);
    if (!next || next.getTime() === current.getTime()) {
      break;
    }
    current = next;
    guard += 1;
  }
  while (
    results.length < effectiveLimit &&
    guard < maxIterations &&
    (!upperBound || current < upperBound)
  ) {
    const weekday = getLocalWeekday(current, timeZone);
    if (!enforceDayFilter || dayFilter.has(weekday)) {
      if (current < from) {
        // Ensure the current candidate respects the evaluation window.
        guard += 1;
        const next = increment(current);
        if (!next || next.getTime() === current.getTime()) {
          break;
        }
        current = next;
        continue;
      }
      if (orderedAt && current < orderedAt) {
        guard += 1;
        const next = increment(current);
        if (!next || next.getTime() === current.getTime()) {
          break;
        }
        current = next;
        continue;
      }
      if (upperBound && current >= upperBound) {
        break;
      }
      const iso = formatZonedIso(current, timeZone);
      if (!seen.has(iso)) {
        seen.add(iso);
        results.push(iso);
      }
    }
    const next = increment(current);
    if (!next || next.getTime() === current.getTime()) {
      break;
    }
    current = next;
    guard += 1;
  }
  return results.slice(0, effectiveLimit);
}

/**
 * Builds a function that advances a Date according to repeat.period/unit.
 *
 * @param repeat FHIR repeat object containing `period` and `periodUnit`.
 * @param timeZone IANA timezone used for calendar-aware month/year stepping.
 * @returns Stepper function advancing one interval, or `null` when unsupported.
 */
function createIntervalStepper(
  repeat: FhirTimingRepeat,
  timeZone: string
): ((value: Date) => Date | null) | null {
  const { period, periodUnit } = repeat;
  if (!period || !periodUnit) {
    return null;
  }
  if (periodUnit === "s" || periodUnit === "min" || periodUnit === "h") {
    const multiplier = periodUnit === "s" ? 1000 : periodUnit === "min" ? 60 * 1000 : 60 * 60 * 1000;
    const delta = period * multiplier;
    return (value: Date) => new Date(value.getTime() + delta);
  }
  if (periodUnit === "d") {
    const delta = period * 24 * 60 * 60 * 1000;
    return (value: Date) => new Date(value.getTime() + delta);
  }
  if (periodUnit === "wk") {
    const delta = period * 7 * 24 * 60 * 60 * 1000;
    return (value: Date) => new Date(value.getTime() + delta);
  }
  if (periodUnit === "mo") {
    return (value: Date) => addCalendarMonths(value, period, timeZone);
  }
  if (periodUnit === "a") {
    return (value: Date) => addCalendarMonths(value, period * 12, timeZone);
  }
  return null;
}

/**
 * Adds calendar months while respecting varying month lengths and DST.
 *
 * @param date Starting instant.
 * @param months Number of calendar months to add.
 * @param timeZone IANA timezone used for wall-clock preservation.
 * @returns Shifted date preserving local clock and clamped day-of-month.
 */
function addCalendarMonths(date: Date, months: number, timeZone: string): Date {
  const { year, month, day, hour, minute, second } = getTimeParts(date, timeZone);
  const targetMonthIndex = month - 1 + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth = (targetMonthIndex % 12 + 12) % 12;
  const candidate = makeZonedDate(
    timeZone,
    targetYear,
    targetMonth + 1,
    1,
    hour,
    minute,
    second
  );
  if (!candidate) {
    throw new Error("Unable to compute candidate month while scheduling");
  }
  const maxDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const resolvedDay = Math.min(day, maxDay);
  const final = makeZonedDate(
    timeZone,
    targetYear,
    targetMonth + 1,
    resolvedDay,
    hour,
    minute,
    second
  );
  if (!final) {
    throw new Error("Unable to resolve monthly advancement – invalid calendar date");
  }
  return final;
}

/**
 * Determines whether interval stepping can safely combine with a day-of-week filter.
 *
 * @param repeat FHIR timing repeat object containing period unit metadata.
 * @param enforceDayFilter Whether a `dayOfWeek` filter is active for this schedule.
 * @returns `true` when interval stepping should be used directly; otherwise fallback logic is required.
 */
function isDayFilteredIntervalSupported(
  repeat: FhirTimingRepeat,
  enforceDayFilter: boolean
): boolean {
  if (!enforceDayFilter) {
    return true;
  }
  return (
    repeat.periodUnit === "s" ||
    repeat.periodUnit === "min" ||
    repeat.periodUnit === "h" ||
    repeat.periodUnit === "d"
  );
}

type DayFilteredPeriodSeriesOptions = {
  repeat: FhirTimingRepeat;
  timeZone: string;
  dayFilter: Set<string>;
  anchorDay: Date;
  startDay: Date;
  from: Date;
  to?: Date;
  orderedAt?: Date | null;
  limit: number;
  defaultClock?: string;
};

/**
 * Expands weekly/monthly/yearly day-filtered schedules into concrete dose timestamps.
 *
 * @param options Configuration describing bounds, cadence, and clock defaults.
 * @param options.repeat FHIR repeat block driving cadence and cycle alignment.
 * @param options.timeZone IANA timezone used for local weekday and clock resolution.
 * @param options.dayFilter Set of lowercased weekdays that are allowed (e.g. `mon`, `tue`).
 * @param options.anchorDay Cycle anchor day used to determine period alignment.
 * @param options.startDay First local day to begin scanning.
 * @param options.from Inclusive lower bound for candidate timestamps.
 * @param options.to Optional exclusive upper bound for candidate timestamps.
 * @param options.orderedAt Optional lower bound representing the order start.
 * @param options.limit Maximum number of timestamps to emit.
 * @param options.defaultClock Default local clock (`HH:MM:SS`) when no explicit clock is provided.
 * @returns Sorted zoned ISO timestamps matching the requested cadence and bounds.
 */
function generateDayFilteredPeriodSeries(
  options: DayFilteredPeriodSeriesOptions
): string[] {
  const {
    repeat,
    timeZone,
    dayFilter,
    anchorDay,
    startDay,
    from,
    to,
    orderedAt,
    limit,
    defaultClock
  } = options;
  if (limit <= 0) {
    return [];
  }

  const results: string[] = [];
  const seen = new Set<string>();
  const clocks = [defaultClock ?? "08:00:00"];
  let currentDay = startOfLocalDay(startDay, timeZone);
  let iterations = 0;
  const startMs = currentDay.getTime();
  const estimatedDays = to
    ? Math.max(1, Math.ceil((to.getTime() - startMs) / (24 * 60 * 60 * 1000)))
    : limit * 31;
  const maxIterations = Math.max(limit * 31, estimatedDays + 31);

  while (
    results.length < limit &&
    iterations < maxIterations &&
    (!to || currentDay < to)
  ) {
    const weekday = getLocalWeekday(currentDay, timeZone);
    const inPeriodCycle = isDateAlignedToPeriodCycle(
      currentDay,
      anchorDay,
      repeat,
      timeZone
    );
    if (inPeriodCycle && dayFilter.has(weekday)) {
      for (const clock of clocks) {
        const zoned = makeZonedDateFromDay(currentDay, timeZone, clock);
        if (!zoned) {
          continue;
        }
        if (zoned < from) {
          continue;
        }
        if (to && zoned >= to) {
          continue;
        }
        if (orderedAt && zoned < orderedAt) {
          continue;
        }
        const iso = formatZonedIso(zoned, timeZone);
        if (!seen.has(iso)) {
          seen.add(iso);
          results.push(iso);
          if (results.length === limit) {
            break;
          }
        }
      }
    }
    currentDay = addLocalDays(currentDay, 1, timeZone);
    iterations += 1;
  }

  return results;
}

/**
 * Formats a date into a local `HH:MM:SS` clock for the supplied timezone.
 *
 * @param date Source instant.
 * @param timeZone IANA timezone to interpret the instant.
 * @returns Local wall-clock time in `HH:MM:SS` format.
 */
function toLocalClock(date: Date, timeZone: string): string {
  const parts = getTimeParts(date, timeZone);
  const twoDigits = (value: number): string => (value < 10 ? `0${value}` : `${value}`);
  const h = twoDigits(parts.hour);
  const m = twoDigits(parts.minute);
  const s = twoDigits(parts.second);
  return `${h}:${m}:${s}`;
}




/**
 * Internal helper to count dose events within a time range.
 *
 * @param dosage Dosage definition with timing metadata.
 * @param from Inclusive lower time bound for counting.
 * @param to Exclusive upper time bound for counting.
 * @param config Scheduling configuration (timezone, clocks, offsets).
 * @param baseTime Anchor instant used for interval alignment.
 * @param orderedAt Optional order timestamp used as an additional lower bound.
 * @param limit Optional hard cap on emitted candidates to avoid runaway loops.
 * @returns Number of unique dose events in the requested window.
 */
function countScheduleEvents(
  dosage: FhirDosage,
  from: Date,
  to: Date,
  config: NextDueDoseConfig,
  baseTime: Date,
  orderedAt: Date | null,
  limit?: number
): number {
  const timing = dosage.timing;
  const repeat = timing?.repeat;
  if (!timing || !repeat) return 0;

  const normalizedCount = repeatOccurrenceCap(repeat);
  if (normalizedCount === 0) {
    return 0;
  }

  const dayFilter = new Set((repeat.dayOfWeek ?? []).map((day) => day.toLowerCase()));
  const enforceDayFilter = dayFilter.size > 0;
  const dayFilteredSeriesRepeat = resolveDayFilteredSeriesRepeat(repeat, enforceDayFilter);
  const seen = new Set<string>();
  let count = 0;
  const timeZone = config.timeZone!;
  const priorCount =
    normalizedCount !== undefined && orderedAt && from > orderedAt
      ? derivePriorCountFromHistory(timing, repeat, config, orderedAt, from, timeZone)
      : 0;
  const countLimit = normalizedCount === undefined
    ? (limit ?? Number.POSITIVE_INFINITY)
    : Math.min(limit ?? normalizedCount, Math.max(0, normalizedCount - priorCount));
  if (countLimit <= 0) {
    return 0;
  }
  const hardLimit = Number.isFinite(countLimit) ? countLimit : 365 * 31;

  if (isSingleAdministrationRepeat(repeat)) {
    if (hasUnresolvedRelationalInstruction(dosage)) {
      return 0;
    }
    const anchor = orderedAt ?? baseTime;
    if (anchor < from || anchor >= to) {
      return 0;
    }
    return 1;
  }

  const recordCandidate = (candidate: Date | null) => {
    if (!candidate) return false;
    if (candidate < from || candidate >= to) return false;
    const iso = formatZonedIso(candidate, timeZone);
    if (seen.has(iso)) return false;
    seen.add(iso);
    count += 1;
    return true;
  };

  const whenCodes = repeat.when ?? [];
  const timeOfDayEntries = repeat.timeOfDay ?? [];

  if (whenCodes.length > 0 || timeOfDayEntries.length > 0) {
    const cadenceAnchor = resolveRepeatBoundsStart(repeat, timeZone) ?? orderedAt ?? from;
    const expanded = resolveExplicitClockEntries(repeat, config, enforceDayFilter);

    if (arrayIncludes(whenCodes, EventTiming.Immediate)) {
      const immediateSource = orderedAt ?? from;
      if (!orderedAt || orderedAt >= from) {
        recordCandidate(immediateSource);
      }
    }

    const canFallbackToFrequency =
      expanded.length === 0 &&
      timeOfDayEntries.length === 0 &&
      !!repeat.frequency &&
      !!repeat.period &&
      !!repeat.periodUnit;

    if (!canFallbackToFrequency) {
      if (expanded.length === 0) return count;

      let currentDay = startOfLocalDay(from, timeZone);
      let iterations = 0;
      const maxIterations = hardLimit * 31;
      while (count < countLimit && currentDay < to && iterations < maxIterations) {
        const weekday = getLocalWeekday(currentDay, timeZone);
        if ((!enforceDayFilter || dayFilter.has(weekday)) && clockCadenceEligible(currentDay, cadenceAnchor, repeat, timeZone, enforceDayFilter)) {
          for (const entry of expanded) {
            const targetDay = entry.dayShift === 0
              ? currentDay
              : addLocalDays(currentDay, entry.dayShift, timeZone);
            const zoned = makeZonedDateFromDay(targetDay, timeZone, entry.time);
            if (zoned) recordCandidate(zoned);
          }
        }
        currentDay = addLocalDays(currentDay, 1, timeZone);
        iterations += 1;
      }
      return count;
    }
  }

  const treatAsInterval =
    !!repeat.period &&
    !!repeat.periodUnit &&
    (!repeat.frequency ||
      repeat.periodUnit !== "d" ||
      (repeat.frequency === 1 && repeat.period > 1));

  const supportsDayFilteredInterval = isDayFilteredIntervalSupported(
    repeat,
    enforceDayFilter
  );

  if (treatAsInterval && supportsDayFilteredInterval) {
    const increment = createIntervalStepper(repeat, timeZone);
    if (!increment) return count;

    let current = baseTime;
    let guard = 0;
    const maxIterations = hardLimit * 1000;

    // Advance to "from"
    while (current < from && guard < maxIterations) {
      const next = increment(current);
      if (!next || next.getTime() === current.getTime()) break;
      current = next;
      guard++;
    }

    while (current < to && count < countLimit && guard < maxIterations) {
      const weekday = getLocalWeekday(current, timeZone);
      if (!enforceDayFilter || dayFilter.has(weekday)) {
        recordCandidate(current);
      }
      const next = increment(current);
      if (!next || next.getTime() === current.getTime()) break;
      current = next;
      guard += 1;
    }
    return count;
  }

  if (repeat.frequency && repeat.period && repeat.periodUnit) {
    const clocks = resolveFrequencyClocks(timing, config);
    if (clocks.length === 0) return count;

    let currentDay = startOfLocalDay(from, timeZone);
    let iterations = 0;
    const maxIterations = hardLimit * 31;
    while (count < countLimit && currentDay < to && iterations < maxIterations) {
      const weekday = getLocalWeekday(currentDay, timeZone);
      if (!enforceDayFilter || dayFilter.has(weekday)) {
        for (const clock of clocks) {
          const zoned = makeZonedDateFromDay(currentDay, timeZone, clock);
          if (zoned) recordCandidate(zoned);
        }
      }
      currentDay = addLocalDays(currentDay, 1, timeZone);
      iterations += 1;
    }
  }

  // Fallback for dayOfWeek with period/periodUnit but no explicit frequency/clocks
  if (dayFilteredSeriesRepeat) {
    const generated = generateDayFilteredPeriodSeries({
      repeat: dayFilteredSeriesRepeat,
      timeZone,
      dayFilter,
      anchorDay: startOfLocalDay(baseTime, timeZone),
      startDay: from,
      from,
      to,
      orderedAt,
      limit: hardLimit,
      defaultClock: toLocalClock(baseTime, timeZone)
    });
    return count + generated.length;
  }

  return count;
}

/** Supply math is deterministic only when the administered amount is known.
 * Clinical conditions/PRN are represented as a maximum permitted supply,
 * not as a claim that every available dose will actually be administered. */
export class MedicationQuantityCalculationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "MedicationQuantityCalculationError";
  }
}

function calculationHorizon(options: TotalUnitsOptions, zone: string): Date {
  if (!Number.isFinite(options.durationValue) || options.durationValue <= 0)
    throw new MedicationQuantityCalculationError("invalid-horizon",
      "Supply duration must be a positive number of supported calendar/time units.");
  const advance = createIntervalStepper({
    period: options.durationValue, periodUnit: options.durationUnit
  }, zone);
  if (!advance) throw new MedicationQuantityCalculationError("unsupported-horizon",
    "The requested dispensing duration has no supported time unit; supply a duration in minutes, hours, days, weeks, months or years.");
  const from = coerceDate(options.from, "from");
  const end = advance(from);
  if (!end || end <= from) throw new MedicationQuantityCalculationError("invalid-horizon",
    "Dispensing duration does not produce a date after the start of the dispensing window.");
  return end;
}

function prepareMeasuredDose(dosage: FhirDosage, options: TotalUnitsOptions): FhirDosage {
  const values = dosage.doseAndRate ?? [];
  if (values.some(entry => (entry as EzDoseAndRate).doseExpression ||
      (entry as EzDoseAndRate).rateExpression)) {
    throw new MedicationQuantityCalculationError("dose-expression-needs-evaluation",
      "The prescription contains a calculated dose/rate expression. Provide the evaluated patient-specific dose before calculating medication supply.");
  }
  const first = values.length === 1 ? values[0] : undefined;
  if (!first) throw new MedicationQuantityCalculationError("missing-dose",
    "The prescribed quantity per administration is missing or contains alternative doses. Select the applicable dose before calculating supply.");
  let quantity = first.doseQuantity;
  // The usual known tablet/drop/capsule amount needs no object allocation,
  // expression evaluation or rate conversion. This is also the dominant
  // calculation path for pre-existing callers.
  if (quantity && Number.isFinite(quantity.value) && quantity.value! > 0 &&
      !quantity.comparator && !/\/kg$/i.test(quantity.code ?? quantity.unit ?? ""))
    return dosage;
  if (!quantity && (first.rateQuantity || first.rateRatio)) {
    const repeat = dosage.timing?.repeat;
    const duration = repeat?.duration;
    const durationUnit = repeat?.durationUnit;
    if (duration === undefined || !durationUnit || duration <= 0)
      throw new MedicationQuantityCalculationError("infusion-duration-required",
        "Infusion rate is specified, but duration per infusion is not. Supply the infusion duration before computing volume/amount.");
    const timeSeconds: Record<string, number> = {
      s: 1, min: 60, h: 3600, d: 86400, wk: 604800
    };
    let amount: number | undefined, unit: string | undefined;
    if (first.rateQuantity?.value !== undefined && first.rateQuantity.unit) {
      const match = first.rateQuantity.unit.match(/^(.+?)\/(s|min|h|d|wk)$/i);
      if (match) {
        const denominator = match[2].toLowerCase();
        const divisor = timeSeconds[denominator];
        const numerator = timeSeconds[durationUnit];
        if (divisor && numerator) {
          amount = first.rateQuantity.value * duration * numerator / divisor;
          unit = match[1];
        }
      }
    } else if (first.rateRatio?.numerator?.value !== undefined &&
        first.rateRatio.denominator?.value !== undefined) {
      const numerator = first.rateRatio.numerator;
      const denominator = first.rateRatio.denominator;
      const divisor = timeSeconds[denominator.code ?? denominator.unit ?? ""];
      const seconds = timeSeconds[durationUnit];
      if (divisor && seconds && denominator.value! > 0) {
        amount = numerator.value! / denominator.value! * duration * seconds / divisor;
        unit = numerator.unit ?? numerator.code;
      }
    }
    if (amount === undefined || !Number.isFinite(amount) || amount <= 0)
      throw new MedicationQuantityCalculationError("rate-units-unresolved",
        "The infusion rate's units cannot be converted to the provided duration. Supply a compatible rate/duration pair or a computed dose quantity.");
    quantity = { value: amount, unit };
  }
  if (!quantity && first.doseRange?.low && first.doseRange.high &&
      first.doseRange.low.value === first.doseRange.high.value) {
    quantity = first.doseRange.low;
  }
  if (!quantity || quantity.value === undefined || !Number.isFinite(quantity.value) ||
      quantity.value <= 0 || quantity.comparator) {
    throw new MedicationQuantityCalculationError("dose-amount-unresolved",
      "The administered dose is not a single known positive quantity. Provide the applicable dose, range choice, or evaluated expression.");
  }
  const perKg = (quantity.code ?? quantity.unit ?? "").match(/^(.+?)\/kg$/i);
  if (perKg) {
    const weight = options.patientWeightKg;
    if (weight === undefined || !Number.isFinite(weight) || weight <= 0)
      throw new MedicationQuantityCalculationError("patient-weight-required",
        "This dose is prescribed per kilogram. Provide patientWeightKg to calculate an actual medication quantity.");
    quantity = {
      ...quantity, value: roundCalculatedUnits(quantity.value * weight),
      unit: perKg[1], code: quantity.code ? perKg[1] : undefined
    };
  }
  return {
    ...dosage,
    doseAndRate: [{ ...first, doseQuantity: quantity }]
  };
}

function sumCourseUnits(
  entries: Array<{ total: TotalUnitsResult; unit: string | undefined }>,
  options: TotalUnitsOptions
): TotalUnitsResult {
  let commonUnit: string | undefined;
  let totalUnits = 0;
  let approximate: TotalUnitsResult["totalApproximateQuantity"];
  let ingredient: TotalUnitsResult["totalApproximateIngredientQuantity"];
  let mixedApproximate = false, mixedIngredient = false;
  let maximum = false;
  const details: string[] = [];
  for (const { total, unit } of entries) {
    let quantity = total.totalUnits;
    if (commonUnit !== undefined && unit !== undefined &&
        commonUnit.toLowerCase() !== unit.toLowerCase()) {
      const translated = convertValue(quantity, unit, commonUnit,
        resolveContextStrengthRatio(options.context) as any);
      if (translated === null)
        throw new MedicationQuantityCalculationError("incompatible-dose-units",
          `Cannot sum medication supply expressed in ${commonUnit} and ${unit}. Provide a product strength or equivalent conversion before combining the dosages.`);
      quantity = translated;
    } else if (commonUnit === undefined) {
      commonUnit = unit;
    }
    totalUnits = roundCalculatedUnits(totalUnits + quantity);
    if (total.quantityKind === "maximum") maximum = true;
    if (total.explanation) details.push(total.explanation);
    if (total.totalApproximateQuantity && !mixedApproximate) {
      const q = total.totalApproximateQuantity;
      if (!approximate) approximate = { ...q };
      else if (approximate.unit === q.unit && approximate.confidence === q.confidence &&
          approximate.basis === q.basis && approximate.source === q.source)
        approximate.value = roundCalculatedUnits((approximate.value ?? 0) + (q.value ?? 0));
      else { approximate = undefined; mixedApproximate = true; }
    } else if (!total.totalApproximateQuantity && approximate) {
      approximate = undefined; mixedApproximate = true;
    }
    if (total.totalApproximateIngredientQuantity && !mixedIngredient) {
      const q = total.totalApproximateIngredientQuantity;
      if (!ingredient) ingredient = { ...q };
      else if (ingredient.unit === q.unit && ingredient.confidence === q.confidence &&
          ingredient.basis === q.basis && ingredient.source === q.source)
        ingredient.value = roundCalculatedUnits((ingredient.value ?? 0) + (q.value ?? 0));
      else { ingredient = undefined; mixedIngredient = true; }
    } else if (!total.totalApproximateIngredientQuantity && ingredient) {
      ingredient = undefined; mixedIngredient = true;
    }
  }
  const result: TotalUnitsResult = {
    totalUnits, ...(commonUnit ? { unit: commonUnit } : {}),
    quantityKind: maximum ? "maximum" : "scheduled",
    ...(maximum ? { explanation: [...new Set(details)].join(" ") ||
      "Maximum scheduled supply; PRN/conditional administrations may not all be used." } : {}),
    ...(approximate ? { totalApproximateQuantity: approximate } : {}),
    ...(ingredient ? { totalApproximateIngredientQuantity: ingredient } : {})
  };
  const context = options.context;
  if (context?.containerValue && context.containerValue > 0) {
    const containerUnit = context.containerUnit;
    const packageUnit = context.packageUnit;
    const estimateValue = approximate?.value;
    const estimateUnit = approximate?.unit;
    const useEstimate = estimateValue !== undefined && estimateUnit && containerUnit &&
      estimateUnit.toLowerCase() === containerUnit.toLowerCase();
    const matchesPackage = commonUnit && packageUnit &&
      commonUnit.toLowerCase() === packageUnit.toLowerCase();
    if (useEstimate || matchesPackage) {
      const effective = useEstimate ? estimateValue! : totalUnits;
      const divisor = matchesPackage && !useEstimate ? 1 : context.containerValue;
      result.totalContainers = Math.ceil(effective / divisor);
      if (containerUnit) result.totalContainerQuantity = {
        value: useEstimate ? estimateValue! : roundCalculatedUnits(result.totalContainers * context.containerValue),
        unit: containerUnit
      };
    } else if (commonUnit && containerUnit && commonUnit.toLowerCase() === containerUnit.toLowerCase()) {
      result.totalContainers = Math.ceil(totalUnits / context.containerValue);
      result.totalContainerQuantity = { value: totalUnits, unit: containerUnit };
    }
  }
  return result;
}

function calculateTotalUnitsSingle(
  options: Omit<TotalUnitsOptions, "dosage"> & { dosage: FhirDosage }
): TotalUnitsResult {
  const { dosage: sourceDosage, durationValue, durationUnit, roundToMultiple, context } = options;
  const unresolved = getUnresolvedDosage(sourceDosage);
  if (unresolved) {
    throw new MedicationQuantityCalculationError("unresolved-regimen",
      `Cannot calculate supply because the instruction has an unresolved clinical schedule (${unresolved}). Clarify the missing/contradictory instruction before dispensing.`);
  }
  const dosage = prepareMeasuredDose(sourceDosage, options);
  // These maxima apply regardless of whether a dose needs date/condition
  // filtering. The schedule path already enforces them; supply must not
  // silently bypass the check on the common arithmetic-count path.
  if (dosage.maxDosePerLifetime)
    throw new MedicationQuantityCalculationError("lifetime-dose-history-required",
      "The prescription specifies a lifetime dose maximum. Provide complete prior administered-dose history and its unit before calculating remaining supply.");
  if (dosage.maxDosePerAdministration) {
    const dose = dosage.doseAndRate?.[0]?.doseQuantity;
    const limit = dosage.maxDosePerAdministration;
    if (!dose?.value || limit.value === undefined)
      throw new MedicationQuantityCalculationError("administration-dose-unknown",
        "The maximum per administration cannot be compared: provide the administered dose quantity and the maximum quantity.");
    const fromUnit = dose.code ?? dose.unit ?? "";
    const limitUnit = limit.code ?? limit.unit ?? "";
    const actual = fromUnit.toLowerCase() === limitUnit.toLowerCase()
      ? dose.value : convertValue(dose.value, fromUnit, limitUnit);
    if (actual === null || !Number.isFinite(actual))
      throw new MedicationQuantityCalculationError("administration-dose-units",
        "The prescribed administration quantity and its maximum have incompatible units. Provide medication strength or an equivalent unit conversion.");
    if (actual > limit.value + 1e-9)
      throw new MedicationQuantityCalculationError("per-administration-maximum-exceeded",
        "The prescribed amount per administration exceeds the specified maximum; revise the dose or safety limit before calculating supply.");
  }
  const conditional = getDosageCondition(dosage);
  const excludedDates = getDosageExcludedDates(dosage);
  const useMaximalPlan = !!dosage.asNeeded ||
    (!!conditional && !options.evaluateCondition);

  const from = coerceDate(options.from, "from");
  const orderedAtDate =
    options.orderedAt === undefined ? null : coerceDate(options.orderedAt, "orderedAt");
  const providedConfig = options.config;
  const timeZone = options.timeZone ?? providedConfig?.timeZone;
  if (!timeZone) {
    throw new Error("timeZone is required for calculateTotalUnits");
  }

  const eventClock: EventClockMap = {
    ...(providedConfig?.eventClock ?? {}),
    ...(options.eventClock ?? {})
  };
  const mealOffsets: MealOffsetMap = {
    ...(providedConfig?.mealOffsets ?? {}),
    ...(options.mealOffsets ?? {})
  };
  const frequencyDefaults = mergeFrequencyDefaults(
    providedConfig?.frequencyDefaults,
    options.frequencyDefaults
  );

  const config: NextDueDoseConfig = {
    timeZone,
    eventClock,
    mealOffsets,
    frequencyDefaults
  };

  // Calculate end date based on duration
  let endDay: Date;
  const dummyRepeat: FhirTimingRepeat = { period: durationValue, periodUnit: durationUnit };
  const stepper = createIntervalStepper(dummyRepeat, timeZone);
  if (stepper) {
    endDay = stepper(from) || from;
  } else {
    endDay = from;
  }
  const repeat = dosage.timing?.repeat;
  const boundsStart = resolveRepeatBoundsStart(repeat, timeZone);
  const countFrom = boundsStart && boundsStart > from ? boundsStart : from;
  const effectiveOrderedAt =
    orderedAtDate && boundsStart && boundsStart > orderedAtDate ? boundsStart : orderedAtDate;
  const baseCandidate = effectiveOrderedAt ?? boundsStart ?? countFrom;
  const baseTime = boundsStart && boundsStart > baseCandidate ? boundsStart : baseCandidate;
  endDay = minDate(
    endDay,
    resolveRepeatDurationCapEnd(repeat, baseTime, timeZone)
  );
  endDay = minDate(
    endDay,
    resolveRepeatBoundsEndExclusive(repeat, timeZone)
  );

  const needsFilteredEnumeration = conditional || excludedDates.length ||
    !!dosage.maxDosePerPeriod?.length || !!getTimingOccurrenceCap(repeat);
  let count: number;
  if (endDay <= countFrom) {
    count = 0;
  } else if (needsFilteredEnumeration) {
    // A constrained course may exclude individual administration instants
    // (dates, conditions or quantity limits); counting the raw cadence would
    // silently inflate supply. Enumerate only within the requested window.
    const endInclusive = new Date(endDay.getTime() - 1).toISOString();
    const boundedRepeat: FhirTimingRepeat = {
      ...(repeat ?? {}),
      boundsPeriod: {
        ...(repeat?.boundsPeriod?.start ? { start: repeat.boundsPeriod.start } : {}),
        end: endInclusive
      }
    };
    const bounded: FhirDosage = {
      ...dosage,
      timing: { ...(dosage.timing ?? {}), repeat: boundedRepeat }
    };
    const maximumCandidates = 10000;
    const scheduled = nextDueDoses(bounded, {
      ...options, from: countFrom, limit: maximumCandidates,
      orderedAt: effectiveOrderedAt ?? options.orderedAt,
      evaluateCondition: options.evaluateCondition ?? (() => true)
    });
    if (scheduled.length === maximumCandidates &&
        Date.parse(scheduled[scheduled.length - 1]) < endDay.getTime()) {
      throw new MedicationQuantityCalculationError("schedule-horizon-too-dense",
        "More than 10,000 administrations could occur in the requested supply window. Use a shorter calculation window or a verified interval-count integration.");
    }
    count = scheduled.filter(date => Date.parse(date) < endDay.getTime()).length;
  } else {
    const exactEvents = dosage.timing
      ? exactTimingEventOccurrences(
        dosage.timing,
        repeat,
        config,
        countFrom,
        effectiveOrderedAt,
        endDay,
        timeZone,
        100000,
        0,
        Boolean(effectiveOrderedAt)
      )
      : undefined;
    count = exactEvents !== undefined
      ? exactEvents.length
      : countScheduleEvents(
        dosage, countFrom, endDay, config, baseTime, effectiveOrderedAt, 100000
      );
  }

  const doseQuantity = dosage.doseAndRate?.[0]?.doseQuantity?.value ?? 0;
  const targetMultiplier = getAdministrationTargetMultiplier(dosage, context);
  let totalUnits = roundCalculatedUnits(count * doseQuantity * targetMultiplier);

  if (roundToMultiple && roundToMultiple > 0) {
    totalUnits = roundCalculatedUnits(Math.ceil(totalUnits / roundToMultiple) * roundToMultiple);
  }

  const result: TotalUnitsResult = {
    totalUnits,
    ...(useMaximalPlan ? {
      quantityKind: "maximum" as const,
      explanation: conditional && !options.evaluateCondition
        ? "Maximum possible supply: every scheduled clinical condition was assumed true. Supply an evaluateCondition callback to calculate a patient-specific conditional schedule."
        : "Maximum possible supply: PRN doses may be used less frequently than the available scheduled opportunities."
    } : {})
  };

  // Handle containers
  const containerValue = context?.containerValue;
  const containerUnit = context?.containerUnit;
  const packageUnit = context?.packageUnit;
  const doseUnit = dosage.doseAndRate?.[0]?.doseQuantity?.unit;
  const unitSemantics = getDoseUnitSemantics(doseUnit, context);
  if (unitSemantics?.approximateQuantity) {
    const approximation = unitSemantics.approximateQuantity;
    result.totalApproximateQuantity = {
      value: roundCalculatedUnits(totalUnits * approximation.value),
      unit: approximation.unit,
      confidence: approximation.confidence,
      basis: approximation.basis,
      source: approximation.source
    };
    result.totalApproximateIngredientQuantity = estimateIngredientQuantity(
      result.totalApproximateQuantity,
      context
    );
  }

  if (containerValue && containerValue > 0) {
    let effectiveUnits = totalUnits;
    let effectiveContainerValue = containerValue;
    if (
      containerUnit &&
      result.totalApproximateQuantity?.unit &&
      result.totalApproximateQuantity.value !== undefined &&
      result.totalApproximateQuantity.unit.trim().toLowerCase() === containerUnit.trim().toLowerCase()
    ) {
      effectiveUnits = result.totalApproximateQuantity.value;
      result.totalContainerQuantity = {
        value: result.totalApproximateQuantity.value,
        unit: containerUnit
      };
    } else if (
      packageUnit &&
      doseUnit &&
      doseUnit.trim().toLowerCase() === packageUnit.trim().toLowerCase()
    ) {
      effectiveUnits = totalUnits;
      effectiveContainerValue = 1;
      if (containerUnit) {
        result.totalContainerQuantity = {
          value: roundCalculatedUnits(totalUnits * containerValue),
          unit: containerUnit
        };
      }
    } else if (containerUnit && doseUnit && containerUnit !== doseUnit) {
      const strength = resolveContextStrengthRatio(context);
      const converted = convertValue(totalUnits, doseUnit, containerUnit, strength as any);
      if (converted !== null) {
        effectiveUnits = converted;
      }
    }
    result.totalContainers = Math.ceil(effectiveUnits / effectiveContainerValue);
  }

  return result;
}

/**
 * Calculate a complete sequential/parallel regimen with the same global R6
 * step windows that the scheduler uses. Supply is summed per component,
 * never by pretending that all stages run through the whole request window.
 */
function calculateCourseTotalUnits(
  course: FhirR6DosageDetails, options: TotalUnitsOptions
): TotalUnitsResult {
  if (course.repeatCycle)
    throw new MedicationQuantityCalculationError("course-repeat-cycle",
      "A repeated whole-course cycle needs an explicit cycle count or stop rule; specify how many cycles are being dispensed.");
  if (course.safety)
    throw new MedicationQuantityCalculationError("course-wide-safety",
      "Whole-course safety limits need to be evaluated across all treatment stages before calculating the permitted supply.");
  if (course.step.some(step => step.count !== undefined || step.safety))
    throw new MedicationQuantityCalculationError("step-level-r6-rule",
      "An R6 step has a separate repetition count or safety limit. Supply requires that rule to be resolved, not mistaken for a normal phase duration.");
  if (course.step.some(step => step.component.some(component =>
    !executableR6Safety(component))))
    throw new MedicationQuantityCalculationError("unsupported-component-safety-rule",
      "A dosage component contains a safety expression, lifetime limit or exceeded-action rule requiring clinical evaluation beyond calendar scheduling. Resolve that rule before calculating supply.");
  const zone = options.timeZone ?? options.config?.timeZone;
  if (!zone)
    throw new MedicationQuantityCalculationError("time-zone-required",
      "Provide timeZone to calculate local administration times and calendar-month transitions.");
  const queryStart = coerceDate(options.from, "from");
  const queryEnd = calculationHorizon(options, zone);
  if (!course.step.length) return { totalUnits: 0 };
  const anchored = options.orderedAt !== undefined;
  if (course.step.length > 1 && !anchored &&
      !course.step.every(step => step.component.every(component =>
        Boolean(component.timing?.repeat?.boundsPeriod?.start)))) {
    throw new MedicationQuantityCalculationError("treatment-start-required",
      "Provide orderedAt, the original treatment start date/time: sequential relative dosage phases cannot be positioned using the future supply-window start alone.");
  }
  const treatmentStart = anchored ? coerceDate(options.orderedAt!, "orderedAt") : queryStart;
  const flattened = toFhirR5Dosages(course);
  const entries: Array<{ total: TotalUnitsResult; unit: string | undefined }> = [];
  let cursor = treatmentStart, dosageIndex = 0;
  for (let index = 0; index < course.step.length; index++) {
    const step = course.step[index];
    const start = step.start
      ? treatmentRelativeInstant(step.start, treatmentStart, zone)
      : cursor;
    const dosages: FhirDosage[] = [];
    const starts: Date[] = [];
    const ends: Array<Date | null> = [];
    for (const _component of step.component) {
      const dosage = flattened[dosageIndex++];
      if (!dosage) throw new MedicationQuantityCalculationError("invalid-course",
        "The R6 treatment course contains a different number of components from its dosage projection.");
      const unresolved = getUnresolvedDosage(dosage);
      if (unresolved)
        throw new MedicationQuantityCalculationError("unresolved-regimen",
          "A dosage has an unresolved schedule (" + unresolved + "). Clarify its timing before requesting a numeric supply.");
      dosages.push(dosage);
      const repeat = dosage.timing?.repeat;
      const individualStart = resolveRepeatBoundsStart(repeat, zone) ?? start;
      if (individualStart < start)
        throw new MedicationQuantityCalculationError("overlapping-course",
          "A dosage begins before its enclosing global treatment stage; review its bounds.");
      starts.push(individualStart);
      ends.push(earlierDate(
        resolveRepeatDurationCapEnd(repeat, individualStart, zone),
        resolveRepeatBoundsEndExclusive(repeat, zone)
      ));
    }
    const nextStep = course.step[index + 1];
    let stepEnd = step.end
      ? treatmentRelativeInstant(step.end, treatmentStart, zone) : undefined;
    if (!stepEnd && nextStep?.start)
      stepEnd = treatmentRelativeInstant(nextStep.start, treatmentStart, zone);
    if (!stepEnd && nextStep) {
      if (!ends.length || ends.some(value => !value))
        throw new MedicationQuantityCalculationError("phase-duration-required",
          "Stage " + (index + 1) + " has no finite stop rule before the next stage. Specify the phase duration (e.g. x7d), end date or the next stage start.");
      stepEnd = ends.reduce<Date>((latest, value) =>
        value && value > latest ? value : latest, start);
    }
    if (stepEnd && stepEnd <= start)
      throw new MedicationQuantityCalculationError("invalid-stage-order",
        "Stage " + (index + 1) + " ends at or before its start. Review the stage duration/date.");
    if (index > 0 && start < cursor)
      throw new MedicationQuantityCalculationError("overlapping-course",
        "The prescribed treatment stages overlap despite sequential ordering. Correct the stage dates or represent independent concurrent tracks.");
    for (let j = 0; j < dosages.length; j++) {
      const dosage = dosages[j];
      const begin = starts[j];
      const ownEnd = ends[j];
      const end = [queryEnd, ...(stepEnd ? [stepEnd] : []),
        ...(ownEnd ? [ownEnd] : [])].reduce((earliest, candidate) =>
        candidate < earliest ? candidate : earliest, queryEnd);
      if (end <= begin || end <= queryStart) continue;
      if (!dosage.timing?.repeat)
        throw new MedicationQuantityCalculationError("timing-required",
          "Stage " + (index + 1) + " has no executable frequency or dosing time for one component.");
      const bounded: FhirDosage = {
        ...dosage,
        modifierExtension: dosage.modifierExtension?.filter(ext => ext.url !== DOSAGE_DETAILS_R5_URL),
        timing: {
          ...dosage.timing,
          repeat: {
            ...dosage.timing.repeat,
            // Global stage cut has already applied any boundsDuration;
            // never re-anchor it from the supply-window start.
            boundsDuration: undefined,
            boundsPeriod: {
              start: begin.toISOString(),
              end: new Date(end.getTime() - 1).toISOString()
            }
          }
        }
      };
      const measured = prepareMeasuredDose(bounded, options);
      const calculated = calculateTotalUnitsSingle({
        ...options, dosage: bounded, orderedAt: begin,
        roundToMultiple: undefined
      });
      entries.push({
        total: calculated,
        unit: measured.doseAndRate?.[0]?.doseQuantity?.unit ??
          measured.doseAndRate?.[0]?.doseQuantity?.code
      });
    }
    if (stepEnd) cursor = stepEnd;
  }
  const combined = sumCourseUnits(entries, options);
  if (options.roundToMultiple && options.roundToMultiple > 0)
    combined.totalUnits = roundCalculatedUnits(
      Math.ceil(combined.totalUnits / options.roundToMultiple) * options.roundToMultiple
    );
  return combined;
}

export function calculateTotalUnits(options: TotalUnitsOptions): TotalUnitsResult {
  if (!options || !options.dosage)
    throw new MedicationQuantityCalculationError("missing-regimen",
      "A medication dosage or complete treatment course is required for supply calculation.");
  const input = options.dosage;
  if (!Array.isArray(input) && "items" in input)
    return calculateCourseTotalUnits((input as ParseBatchResult).fhirNext, options);
  if (!Array.isArray(input) && "step" in input)
    return calculateCourseTotalUnits(input as FhirR6DosageDetails, options);
  if (Array.isArray(input))
    return calculateCourseTotalUnits(toDosageDetails(input as FhirDosage[]), options);
  if (Array.isArray(options.dosage)) {
    const sequences = new Set(options.dosage.map(dose => dose.sequence ?? 1));
    if (sequences.size > 1) {
      throw new Error("Cannot total sequential R5 taper stages independently over one window; a phase-aware supply calculator is required");
    }
    const hasAnyDosage = options.dosage.length > 0;
    if (!hasAnyDosage) {
      return { totalUnits: 0 };
    }
    let totalUnits = 0;
    let totalContainers = 0;
    let totalContainerQuantity: TotalUnitsResult["totalContainerQuantity"];
    let totalApproximateQuantity: TotalUnitsResult["totalApproximateQuantity"];
    let totalApproximateIngredientQuantity: TotalUnitsResult["totalApproximateIngredientQuantity"];
    let mixedTotalContainerQuantities = false;
    let mixedApproximateQuantities = false;
    let mixedApproximateIngredientQuantities = false;
    let sawContainers = false;
    for (const dosage of options.dosage) {
      const result = calculateTotalUnitsSingle({
        ...options,
        dosage
      });
      totalUnits = roundCalculatedUnits(totalUnits + result.totalUnits);
      if (result.totalApproximateQuantity && !mixedApproximateQuantities) {
        if (
          totalApproximateQuantity &&
          totalApproximateQuantity.unit === result.totalApproximateQuantity.unit &&
          totalApproximateQuantity.confidence === result.totalApproximateQuantity.confidence &&
          totalApproximateQuantity.basis === result.totalApproximateQuantity.basis &&
          totalApproximateQuantity.source === result.totalApproximateQuantity.source
        ) {
          totalApproximateQuantity.value = roundCalculatedUnits(
            (totalApproximateQuantity.value ?? 0) + (result.totalApproximateQuantity.value ?? 0)
          );
        } else if (!totalApproximateQuantity) {
          totalApproximateQuantity = { ...result.totalApproximateQuantity };
        } else {
          totalApproximateQuantity = undefined;
          mixedApproximateQuantities = true;
        }
      }
      if (result.totalApproximateIngredientQuantity && !mixedApproximateIngredientQuantities) {
        if (
          totalApproximateIngredientQuantity &&
          totalApproximateIngredientQuantity.unit === result.totalApproximateIngredientQuantity.unit &&
          totalApproximateIngredientQuantity.confidence === result.totalApproximateIngredientQuantity.confidence &&
          totalApproximateIngredientQuantity.basis === result.totalApproximateIngredientQuantity.basis &&
          totalApproximateIngredientQuantity.source === result.totalApproximateIngredientQuantity.source
        ) {
          totalApproximateIngredientQuantity.value = roundCalculatedUnits(
            (totalApproximateIngredientQuantity.value ?? 0) +
            (result.totalApproximateIngredientQuantity.value ?? 0)
          );
        } else if (!totalApproximateIngredientQuantity) {
          totalApproximateIngredientQuantity = { ...result.totalApproximateIngredientQuantity };
        } else {
          totalApproximateIngredientQuantity = undefined;
          mixedApproximateIngredientQuantities = true;
        }
      }
      if (result.totalContainers !== undefined) {
        totalContainers += result.totalContainers;
        sawContainers = true;
      }
      if (result.totalContainerQuantity && !mixedTotalContainerQuantities) {
        if (
          totalContainerQuantity &&
          totalContainerQuantity.unit === result.totalContainerQuantity.unit &&
          totalContainerQuantity.system === result.totalContainerQuantity.system &&
          totalContainerQuantity.code === result.totalContainerQuantity.code
        ) {
          totalContainerQuantity.value = roundCalculatedUnits(
            (totalContainerQuantity.value ?? 0) + (result.totalContainerQuantity.value ?? 0)
          );
        } else if (!totalContainerQuantity) {
          totalContainerQuantity = { ...result.totalContainerQuantity };
        } else {
          totalContainerQuantity = undefined;
          mixedTotalContainerQuantities = true;
        }
      }
    }
    return {
      totalUnits,
      ...(sawContainers ? { totalContainers } : {}),
      ...(!mixedTotalContainerQuantities && totalContainerQuantity ? { totalContainerQuantity } : {}),
      ...(!mixedApproximateQuantities && totalApproximateQuantity ? { totalApproximateQuantity } : {}),
      ...(!mixedApproximateIngredientQuantities && totalApproximateIngredientQuantity
        ? { totalApproximateIngredientQuantity }
        : {})
    };
  }
  return calculateTotalUnitsSingle(options as Omit<TotalUnitsOptions, "dosage"> & { dosage: FhirDosage });
}

const { resolveExplicitClockEntries, clockCadenceEligible } = createTimingPrimitives({
  expandWhenCodes, normalizeClock, inferWhenFallbackEntries, getLocalDayNumber, getLocalMonthIndex,
  getTimeParts, addCalendarMonths, isDateAlignedToPeriodCycle
});


/**
 * Generate due times for one whole medication regimen using R5 sequence / R6 steps.
 * The public nextDueDoses accepts a single Dosage, an array, or DosageDetails.
 *
 * A phase boundary must be known (explicit date or finite duration). If not,
 * reject rather than accidentally running later phases at the same time.
 * "orderedAt" is required for relative multi-phase regimens, so a later
 * "from" query does not shift the treatment's start date.
 */
function scheduleRegimen(
  dosages: FhirDosage[],
  options: NextDueDoseOptions
): RegimenDueTimes[] {
  if (dosages.length === 0) return [];
  if (dosages.some(dosage => dosage.modifierExtension?.some(extension =>
    extension.url === DOSAGE_DETAILS_R5_URL
  ))) {
    // Explicit R5 exports may carry the whole R6 source for lossless round
    // trips. We recognize that modifier rather than treating it as an
    // unknown extension; only unsupported R6-only execution rules are blocked.
    const restored = toDosageDetails(dosages);
    if (restored.repeatCycle || restored.safety ||
      restored.step.some(step => step.start || step.end ||
        step.count !== undefined || step.safety ||
        step.component.some(component =>
          !executableR6Safety(component)))) {
      throw new Error("R6 course-specific safety or cycle semantics require an R6-aware scheduler");
    }
    dosages = dosages.map(item => ({
      ...item,
      modifierExtension: item.modifierExtension?.filter(ext =>
        ext.url !== DOSAGE_DETAILS_R5_URL)
    }));
  }
  const zone = options.timeZone ?? options.config?.timeZone;
  if (!zone) throw new Error("A timeZone is required for multi-phase scheduling");
  const sequences = dosages.map(dosage => dosage.sequence ?? 1);
  if (sequences.some(value => !Number.isInteger(value) || value < 1)) {
    throw new Error("Invalid FHIR Dosage.sequence");
  }
  const distinct = Array.from(new Set(sequences)).sort((a, b) => a - b);
  if (distinct.length > 1 && options.orderedAt === undefined) {
    const everyPhaseAnchored = dosages.every(dosage => Boolean(dosage.timing?.repeat?.boundsPeriod?.start));
    if (!everyPhaseAnchored) throw new Error("orderedAt is required to schedule relative sequential dosage phases");
  }
  const from = coerceDate(options.from, "from");
  let cursor = options.orderedAt !== undefined ? coerceDate(options.orderedAt, "orderedAt") : from;
  const output: RegimenDueTimes[] = [];
  for (let phaseIndex = 0; phaseIndex < distinct.length; phaseIndex++) {
    const sequence = distinct[phaseIndex];
    const members = dosages.map((dosage, dosageIndex) => ({ dosage, dosageIndex }))
      .filter((_, index) => sequences[index] === sequence);
    const explicitStarts = members
      .map(({ dosage }) => resolveRepeatBoundsStart(dosage.timing?.repeat, zone))
      .filter((date): date is Date => Boolean(date));
    if (explicitStarts.length > 0) {
      const earliest = explicitStarts[0].getTime();
      if (explicitStarts.some(date => date.getTime() !== earliest)) {
        throw new Error("Concurrent dosage items in one phase have different start dates");
      }
      if (explicitStarts[0] < cursor && phaseIndex > 0) {
        throw new Error("Sequential dosage phase starts before its predecessor has ended");
      }
      cursor = explicitStarts[0];
    }
    const phaseStart = cursor;
    for (const member of members) {
      const startWindow = from > phaseStart ? from : phaseStart;
      output.push({
        dosageIndex: member.dosageIndex,
        sequence,
        phaseStart: phaseStart.toISOString(),
        timestamps: nextDueDoses(member.dosage, {
          ...options,
          from: startWindow,
          orderedAt: phaseStart
        })
      });
    }
    if (phaseIndex + 1 >= distinct.length) continue;
    const ends = members.map(({ dosage }) => {
      const repeat = dosage.timing?.repeat;
      if (!repeat) return null;
      const start = resolveRepeatBoundsStart(repeat, zone) ?? phaseStart;
      return earlierDate(
        resolveRepeatDurationCapEnd(repeat, start, zone),
        resolveRepeatBoundsEndExclusive(repeat, zone)
      );
    });
    if (ends.some(date => !date)) {
      throw new Error("Cannot schedule the next phase: predecessor has no finite duration or end date");
    }
    cursor = ends.reduce<Date>((latest, date) => date && date > latest ? date : latest, phaseStart);
    if (cursor <= phaseStart) {
      throw new Error("Cannot schedule the next phase: invalid or empty phase bounds");
    }
  }
  return output.sort((a, b) => a.dosageIndex - b.dosageIndex);
}
