import { TREATMENT_START_SYSTEM } from "./regimen/parallel-course";
import { getMissingCourseContext, getDosageAlternativeChoice, DOSAGE_ALTERNATIVE_CHOICE_URL, getDosageCondition, getDosageCalendarDayCondition, getDosageExcludedDates, getDosageExcludedWeekdays, DOSAGE_CONDITION_R5_URL, DOSAGE_EXCLUDED_DATES_R5_URL, DOSAGE_EXCLUDED_WEEKDAYS_R5_URL, toFhirR5Dosages, toDosageDetails, DOSAGE_DETAILS_R5_URL, PARALLEL_COMPONENT_PHASE_ORIGIN_URL } from "./dosage-course";
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
  FhirR6RelativeTime,
  ParseBatchResult,
  RegimenDueTimes,
  TotalUnitsOptions,
  TotalUnitsResult
} from "./types";
import { arrayIncludes } from "./utils/array";
import { convertValue, getBaseUnitFactor, getUnitCategory } from "./utils/units";
import { parseStrengthIntoRatio } from "./utils/strength";
import { getDoseUnitSemantics } from "./unit-lexicon";
import {
  getExactTimingOffsetMinutes,
  parseActivityTimingExtensions,
  getAdministrationOffsetMinutes,
  getAnchoredCourseDuration,
  ADMINISTRATION_OFFSET_EXTENSION_URL,
  getTimingOccurrenceCap,
  getCycleDayConstraint,
  getTimingClockWindow,
  getTimingEventWindow,
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

/** Numeric meanings of common institution-clock codes. Reuse one map:
 * this executes for every frequency-only schedule, including supply counts.
 */
const DAILY_FREQUENCY_BY_TIMING_CODE: Readonly<Record<string, number>> = {
  QD: 1, AM: 1, PM: 1, BID: 2, TID: 3, QID: 4
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

interface DateTimeFormatWithParts {
  formatToParts?: (date?: number | Date) => DateTimeFormatPart[];
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
  dosage: Pick<FhirDosage, "timing" | "modifierExtension">,
  anchor: Date,
  timeZone: string
): Date | null {
  const repeat = dosage.timing?.repeat;
  const retained = getAnchoredCourseDuration(dosage);
  if (!repeat && !retained) return null;
  const durationAnchor = retained
    ? resolveRepeatBoundsStart(repeat, timeZone) ?? anchor : anchor;

  const advance = (quantity: FhirQuantity | undefined): Date | null => {
    const value = quantity?.value;
    const unit = parseBoundsDurationUnit(quantity);
    if (quantity?.comparator || value === undefined || !Number.isFinite(value) ||
        value <= 0 || !unit) {
      return null;
    }
    const stepper = createIntervalStepper({ period: value, periodUnit: unit }, timeZone);
    const result = stepper?.(durationAnchor);
    return result && result > durationAnchor ? result : null;
  };

  // boundsDuration is the more explicit course bound when an imported object
  // happens to contain both choices. For a duration range, the upper bound is
  // the useful maximum-plan horizon; fall back to the lower bound if only it
  // is executable. The original range remains untouched on the dosage.
  const durationEnd = advance(repeat?.boundsDuration ?? retained?.valueQuantity);
  if (durationEnd) return durationEnd;
  const range = repeat?.boundsRange ?? retained?.valueRange;
  return advance(range?.high) ?? advance(range?.low);
}

function validateRepeatBoundsPeriod(
  repeat: FhirTimingRepeat | undefined,
  timeZone: string
): { start: Date | null; end: Date | null } {
  const start = resolveRepeatBoundsStart(repeat, timeZone);
  const end = resolveRepeatBoundsEndExclusive(repeat, timeZone);
  if (repeat?.boundsPeriod?.start && !start)
    throw new Error("Timing.repeat.boundsPeriod.start is invalid");
  if (repeat?.boundsPeriod?.end && !end)
    throw new Error("Timing.repeat.boundsPeriod.end is invalid");
  if (start && end && end <= start)
    throw new Error("Timing.repeat.boundsPeriod end must be after its start");
  return { start, end };
}

function positiveInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value : undefined;
}

function positiveNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value : undefined;
}

/**
 * Make an executable copy of imported range timing without changing the
 * preserved FHIR object. Scheduling APIs return timestamps rather than a
 * range, so an unanchored range uses its maximum frequency and shortest valid
 * period. Explicit clocks/event anchors are kept and remain authoritative.
 */
function prepareBestEffortTiming(dosage: FhirDosage): FhirDosage {
  const timing = dosage.timing;
  const repeat = timing?.repeat;
  if (!timing || !repeat) return dosage;

  // Keep the ordinary path allocation-free. It is also important not to
  // normalize an explicit zero count into "unlimited": range handling only
  // needs an operational copy when a range is actually present.
  if (repeat.countMax === undefined && repeat.frequencyMax === undefined &&
      repeat.periodMax === undefined) return dosage;

  const explicitAnchors = Boolean(
    timing.event?.length || repeat.timeOfDay?.length || repeat.when?.length ||
    recognizedDailyTimingCode(timing) !== undefined
  );
  const frequency = positiveInteger(repeat.frequency);
  const frequencyMax = positiveInteger(repeat.frequencyMax);
  const period = positiveNumber(repeat.period);
  const periodMax = positiveNumber(repeat.periodMax);
  const count = positiveInteger(repeat.count);
  const countMax = positiveInteger(repeat.countMax);
  const executableFrequency = explicitAnchors
    ? repeat.frequency
    : frequencyMax && (!frequency || frequencyMax >= frequency)
      ? frequencyMax : repeat.frequency;
  const executablePeriod = period ?? periodMax ?? repeat.period;
  const executableCount = countMax && (!count || countMax >= count)
    ? countMax : repeat.count;
  const nextRepeat: FhirTimingRepeat = {
    ...repeat,
    count: executableCount,
    countMax: undefined,
    frequency: executableFrequency,
    frequencyMax: undefined,
    period: executablePeriod,
    periodMax: undefined
  };
  return {
    ...dosage,
    timing: { ...timing, repeat: nextRepeat }
  };
}

/** A once-daily frequency uses the institution/default administration clock;
 * longer or non-daily intervals remain anchored to the treatment start. */
function usesIntervalCadence(repeat: FhirTimingRepeat): boolean {
  if (!repeat.period || !repeat.periodUnit) return false;
  if (repeat.frequency === undefined) return true;
  if (repeat.frequency !== 1) return false;
  return repeat.periodUnit !== FhirPeriodUnit.Day || repeat.period > 1;
}

function calendarScanLimit(start: Date, end: Date | null | undefined, resultLimit: number): number {
  const minimum = Math.max(366, Math.ceil(resultLimit) * 366);
  if (!end) return minimum;
  const spanDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86_400_000));
  return Math.max(minimum, spanDays + 3);
}

function resolveDayFilteredSeriesRepeat(
  repeat: FhirTimingRepeat,
  enforceDayFilter: boolean
): FhirTimingRepeat | undefined {
  if (!enforceDayFilter) {
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

interface MonthlyWeekdayOrdinal {
  ordinal: number;
}

const WEEKDAY_TEXT: Readonly<Record<string, string>> = {
  monday: "mon", tuesday: "tue", wednesday: "wed", thursday: "thu",
  friday: "fri", saturday: "sat", sunday: "sun"
};

/** Execute the typed monthly ordinal emitted by grammar or an import.
 * @param repeat Structured cadence, weekday and optional ordinal extension.
 * @param anchor Existing recurrence origin used when no ordinal was supplied.
 * @param timeZone Calendar zone for the recurrence origin.
 * @returns The supplied ordinal or the existing anchor-based monthly occurrence.
 */
function resolveMonthlyWeekdayOrdinal(
  repeat: FhirTimingRepeat,
  anchor: Date,
  timeZone: string
): MonthlyWeekdayOrdinal | undefined {
  if (repeat.periodUnit !== FhirPeriodUnit.Month || !(repeat.dayOfWeek?.length)) {
    return undefined;
  }
  for (const extension of repeat.extension ?? []) {
    if (!/(?:weekday-ordinal|week-of-month|weekdayOrdinal)$/iu.test(extension.url)) continue;
    const value = extension.valueInteger;
    if (value === -1 || value !== undefined && Number.isInteger(value) && value >= 1 && value <= 5) {
      return { ordinal: value };
    }
  }
  const parts = getTimeParts(anchor, timeZone);
  const nextWeek = addLocalDays(startOfLocalDay(anchor, timeZone), 7, timeZone);
  const isLast = getTimeParts(nextWeek, timeZone).month !== parts.month;
  return { ordinal: isLast ? -1 : Math.ceil(parts.day / 7) };
}

function matchesMonthlyWeekdayOrdinal(
  date: Date,
  ordinal: MonthlyWeekdayOrdinal | undefined,
  timeZone: string
): boolean {
  if (!ordinal) return true;
  const parts = getTimeParts(date, timeZone);
  if (ordinal.ordinal === -1) {
    return getTimeParts(addLocalDays(date, 7, timeZone), timeZone).month !== parts.month;
  }
  return Math.ceil(parts.day / 7) === ordinal.ordinal;
}

function matchesCalendarDay(
  date: Date,
  dayFilter: Set<string>,
  enforceDayFilter: boolean,
  monthlyOrdinal: MonthlyWeekdayOrdinal | undefined,
  timeZone: string
): boolean {
  return (!enforceDayFilter || dayFilter.has(getLocalWeekday(date, timeZone))) &&
    matchesMonthlyWeekdayOrdinal(date, monthlyOrdinal, timeZone);
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
      (!orderedAt || candidate >= orderedAt) &&
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
  const repeat = timing.repeat;
  const codeFrequency = normalizedCode
    ? DAILY_FREQUENCY_BY_TIMING_CODE[normalizedCode]
    : undefined;
  const liveDailyFrequency = repeat?.frequency !== undefined &&
    repeat.period === 1 && repeat.periodUnit === "d"
    ? repeat.frequency
    : undefined;
  const staleDailyCode = codeFrequency !== undefined &&
    liveDailyFrequency !== undefined && codeFrequency !== liveDailyFrequency;
  const codeClocks = !staleDailyCode && normalizedCode
    ? defaults.byCode?.[normalizedCode]
    : undefined;
  if (codeClocks) {
    for (const clock of codeClocks) {
      collected.add(normalizeClock(clock));
    }
  }
  // A recognized code represents the SAME schedule, not another set of
  // administrations. Use the frequency fallback only when the code has no
  // configured institutional clock mapping.
  if (!codeClocks && repeat?.frequency && repeat.period && repeat.periodUnit) {
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

function recognizedDailyTimingCode(timing: FhirTiming): number | undefined {
  const code = timing.code?.coding?.find((coding) => coding.code)?.code?.toUpperCase();
  return code ? DAILY_FREQUENCY_BY_TIMING_CODE[code] : undefined;
}

/** An occurrence ceiling without cadence cannot supply actual dose instants.
 * @param dosage Typed dose; explicit events and cadence remain authoritative.
 */
function unscheduledOccurrenceCapacity(dosage: FhirDosage): CanonicalOccurrenceCapExpr | undefined {
  const repeat = dosage.timing?.repeat;
  const cap = getTimingOccurrenceCap(repeat);
  return cap && !dosage.timing?.event?.length && !dosage.timing?.code &&
    !repeat?.timeOfDay?.length && !repeat?.when?.length &&
    repeat?.frequency === undefined && repeat?.frequencyMax === undefined &&
    repeat?.period === undefined && repeat?.periodMax === undefined &&
    (dosage.asNeeded || !repeat || !isSingleAdministrationRepeat(repeat)) ? cap : undefined;
}

function occurrenceCapBucketIndex(
  date: Date,
  cap: CanonicalOccurrenceCapExpr,
  timeZone: string
): number {
  switch (cap.periodUnit) {
    case FhirPeriodUnit.Second:
      return Math.floor(date.getTime() / (cap.period * 1000));
    case FhirPeriodUnit.Minute:
      return Math.floor(date.getTime() / (cap.period * 60 * 1000));
    case FhirPeriodUnit.Hour:
      return Math.floor(date.getTime() / (cap.period * 60 * 60 * 1000));
    case FhirPeriodUnit.Day:
      return Math.floor(getLocalDayNumber(date, timeZone) / cap.period);
    case FhirPeriodUnit.Week: {
      const mondayWeek = Math.floor((getLocalDayNumber(date, timeZone) + 3) / 7);
      return Math.floor(mondayWeek / cap.period);
    }
    case FhirPeriodUnit.Month:
      return Math.floor(getLocalMonthIndex(date, timeZone) / cap.period);
    case FhirPeriodUnit.Year: {
      const { year } = getTimeParts(date, timeZone);
      return Math.floor(year / cap.period);
    }
    default:
      return date.getTime();
  }
}

function occurrenceCapBucketKey(
  date: Date, cap: CanonicalOccurrenceCapExpr, timeZone: string
): string {
  return `${cap.periodUnit}:${occurrenceCapBucketIndex(date, cap, timeZone)}`;
}

/** Pack possible administrations as early as the known ceilings allow.
 * These are mathematical capacity allocations, never scheduled patient doses.
 * Earlier feasible allocations cannot reduce a later rolling-window allowance.
 * @param intervals Eligible calendar intervals, with exclusive end points.
 * @param cap Calendar-period occurrence ceiling.
 * @param quantityCaps Rolling medication-quantity ceilings converted to dose counts.
 * @param priorDoseTimes Administrations already consuming the ceilings.
 * @param zone Calendar zone shared with the existing cap executor.
 */
function maximumCapacityWithRollingLimits(
  intervals: readonly { start: number; end: number }[],
  cap: CanonicalOccurrenceCapExpr,
  quantityCaps: readonly CanonicalOccurrenceCapExpr[],
  priorDoseTimes: TotalUnitsOptions["priorDoseTimes"],
  zone: string
): number {
  if (!intervals.length) return 0;
  const end = intervals[intervals.length - 1].end;
  const prior = (priorDoseTimes ?? []).map(value => ({
    at: coerceDate(value, "priorDoseTimes").getTime(), count: 1
  }));
  const allocated: Array<{ at: number; count: number }> = [];
  const used = new Map<number, number>();
  for (const item of prior) {
    const bucket = occurrenceCapBucketIndex(new Date(item.at), cap, zone);
    used.set(bucket, (used.get(bucket) ?? 0) + item.count);
  }
  const firstInstant = (from: number, fits: (at: number) => boolean): number => {
    if (!fits(end - 1)) return end;
    let lo = from, hi = end - 1;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (fits(mid)) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  let count = 0;
  let at = intervals[0].start;
  for (const interval of intervals) {
    at = Math.max(at, interval.start);
    while (at < interval.end) {
      const bucket = occurrenceCapBucketIndex(new Date(at), cap, zone);
      let room = cap.max - (used.get(bucket) ?? 0);
      if (room <= 0) {
        at = firstInstant(at + 1, value => occurrenceCapBucketIndex(new Date(value), cap, zone) > bucket);
        continue;
      }
      let release = at;
      for (const limit of quantityCaps) {
        const first = quantityCapWindowStart(new Date(at), limit, zone);
        let occupied = 0, oldest = Number.POSITIVE_INFINITY;
        for (const history of [prior, allocated]) {
          for (const item of history) {
            if (item.at > first && item.at <= at) {
              occupied += item.count;
              oldest = Math.min(oldest, item.at);
            }
          }
        }
        room = Math.min(room, limit.max - occupied);
        if (occupied >= limit.max) {
          release = Math.max(release, firstInstant(at + 1,
            value => quantityCapWindowStart(new Date(value), limit, zone) >= oldest));
        }
      }
      if (room <= 0) {
        at = Math.max(at + 1, release);
      } else {
        allocated.push({ at, count: room });
        count += room;
        used.set(bucket, (used.get(bucket) ?? 0) + room);
      }
    }
  }
  return count;
}

/** Count permitted capacity, not invented clocks, in each explicit cap period.
 * @param dosage Typed calendar restrictions on the dosage.
 * @param cap Per-period maximum administration count.
 * @param from Inclusive query start clipped to treatment start.
 * @param end Exclusive course/query end.
 * @param options Known previous administrations.
 * @param timeZone Resolved calendar zone shared with the cap executor.
 * @param quantityCaps Additional rolling medication-quantity limits.
 */
function maximumUnscheduledCapCount(
  dosage: FhirDosage, cap: CanonicalOccurrenceCapExpr, from: Date, end: Date,
  options: TotalUnitsOptions, timeZone: string,
  quantityCaps: readonly CanonicalOccurrenceCapExpr[] = []
): number {
  if (from >= end) return 0;
  const repeat = dosage.timing?.repeat;
  const allowed = new Set((repeat?.dayOfWeek ?? []).map(day => day.toLowerCase()));
  const excluded = new Set<string>(getDosageExcludedWeekdays(dosage));
  const dates = new Set(getDosageExcludedDates(dosage));
  const dayCondition = getDosageCalendarDayCondition(dosage);
  const ordinal = repeat ? resolveMonthlyWeekdayOrdinal(repeat, from, timeZone) : undefined;
  const ranges: Array<{ first: number; last: number }> = [];
  const intervals: Array<{ start: number; end: number }> = [];
  let day = startOfLocalDay(from, timeZone);
  while (day < end) {
    const next = addLocalDays(day, 1, timeZone);
    if (matchesCalendarDay(day, allowed, allowed.size > 0, ordinal, timeZone) &&
        !excluded.has(getLocalWeekday(day, timeZone)) &&
        !dates.has(formatZonedIso(day, timeZone).slice(0, 10)) &&
        (!dayCondition || !options.evaluateCondition ||
          options.evaluateCondition(dayCondition, formatZonedIso(new Date(Math.max(+from, +day)), timeZone)) !== false)) {
      const start = Math.max(+from, +day), stop = Math.min(+end, +next);
      if (quantityCaps.length) intervals.push({ start, end: stop });
      const first = occurrenceCapBucketIndex(new Date(start), cap, timeZone);
      const last = occurrenceCapBucketIndex(new Date(stop - 1), cap, timeZone);
      const previous = ranges[ranges.length - 1];
      if (previous && first <= previous.last + 1) previous.last = Math.max(previous.last, last);
      else ranges.push({ first, last });
    }
    day = next;
  }
  if (quantityCaps.length) {
    return maximumCapacityWithRollingLimits(intervals, cap, quantityCaps, options.priorDoseTimes, timeZone);
  }
  let count = ranges.reduce((total, range) => total + (range.last - range.first + 1) * cap.max, 0);
  const used = new Map<number, number>();
  for (const at of options.priorDoseTimes ?? []) {
    const bucket = occurrenceCapBucketIndex(coerceDate(at, 'priorDoseTimes'), cap, timeZone);
    if (ranges.some(range => range.first <= bucket && bucket <= range.last)) {
      used.set(bucket, (used.get(bucket) ?? 0) + 1);
    }
  }
  for (const value of used.values()) count -= Math.min(cap.max, value);
  return Math.max(0, count);
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
function executableQuantityCaps(
  dosage: FhirDosage,
  context?: MedicationContext
): CanonicalOccurrenceCapExpr[] {
  const limits = dosage.maxDosePerPeriod ?? [];
  if (!limits.length) return [];
  const doseRates = dosage.doseAndRate ?? [];
  const dose = doseRates.length === 1 ? doseRates[0].doseQuantity : undefined;
  if (!dose || dose.comparator || !dose.value || !Number.isFinite(dose.value) ||
      dose.value <= 0) {
    return [];
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
      continue;
    }
    const actualUnit = dose.code ?? dose.unit ?? "";
    const maximumUnit = numerator?.code ?? numerator?.unit ?? "";
    const normalizedActual = normalizeUnit(actualUnit);
    const normalizedMaximum = normalizeUnit(maximumUnit);
    const perTargetDose = normalizedActual === normalizedMaximum
      ? dose.value
      : convertValue(dose.value, actualUnit, maximumUnit);
    if (perTargetDose === null || !Number.isFinite(perTargetDose) ||
        perTargetDose <= 0) {
      continue;
    }
    const equivalentDose = perTargetDose * getAdministrationTargetMultiplier(dosage, context);
    const max = Math.floor(maximum / equivalentDose + 1e-9);
    if (max < 1) {
      continue;
    }
    caps.push({ max, period, periodUnit: periodUnit as FhirPeriodUnit });
  }
  return caps;
}

/** Start of the existing rolling medication-quantity window at a hypothetical instant. */
function quantityCapWindowStart(at: Date, cap: CanonicalOccurrenceCapExpr, zone: string): number {
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

  for (const iso of candidates) {
    const at = new Date(iso);
    const timestamp = at.getTime();
    const fitsEveryCap = caps.every(cap => {
      const first = quantityCapWindowStart(at, cap, zone);
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
  const duration = relative.offsetDuration ?? relative.offsetRange?.low ?? relative.offsetRange?.high;
  const quantity = duration?.value;
  const unit = duration?.code ?? duration?.unit;
  if (!knownAnchor || relative.contextReference || relative.contextDefinition ||
      relative.contextPath ||
      quantity === undefined || !Number.isInteger(quantity) || quantity < 0) {
    throw new Error("Unsupported R6 step RelativeTime: requires a treatment-start offset");
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

function parallelComponentCadenceOrigin(
  dosage: FhirDosage,
  treatmentStart: Date,
  timeZone: string,
  fallback: Date
): Date {
  const markers = dosage.modifierExtension?.filter(extension =>
    extension.url === PARALLEL_COMPONENT_PHASE_ORIGIN_URL) ?? [];
  if (!markers.length) return fallback;
  if (markers.length !== 1 || !markers[0].valueQuantity) {
    throw new Error("Parallel component phase origin is malformed or conflicting");
  }
  return treatmentRelativeInstant({
    contextCode: {
      coding: [{ system: TREATMENT_START_SYSTEM, code: "treatment-start" }]
    },
    offsetDuration: markers[0].valueQuantity
  }, treatmentStart, timeZone);
}

function durationStepper(
  quantity: FhirQuantity | undefined,
  timeZone: string
): ((value: Date) => Date | null) | null {
  const value = quantity?.value;
  const periodUnit = parseBoundsDurationUnit(quantity);
  if (quantity?.comparator || value === undefined || !Number.isFinite(value) ||
      value <= 0 || !periodUnit) return null;
  return createIntervalStepper({ period: value, periodUnit }, timeZone);
}

/**
 * Administer one global step at a time, while retaining its simultaneous
 * site-specific components. All absolute boundaries derive from orderedAt;
 * querying halfway through a treatment cannot reset the course clock.
 */
/** Resolve the source-typed window shared by relative execution and cycle
 * overlap discovery. A repeat period is not a substitute for an explicit end.
 * @param course Non-repeating typed course.
 * @param index Step whose independent or sequential window is being resolved.
 * @param anchor Treatment/cycle start in the caller's calendar zone.
 * @param previousEnd End of the preceding step when no explicit start exists.
 * @param timeZone Calendar zone for relative quantities and component bounds.
 */
function treatmentStepWindow(
  course: FhirR6DosageDetails, index: number, anchor: Date,
  previousEnd: Date, timeZone: string
): { start: Date; end: Date | undefined } {
  const step = course.step[index];
  const start = step.start ? treatmentRelativeInstant(step.start, anchor, timeZone) : previousEnd;
  let end = step.end ? treatmentRelativeInstant(step.end, anchor, timeZone) : undefined;
  if (!end) {
    const componentEnds = step.component.map(component => earlierDate(
      resolveRepeatDurationCapEnd(component, start, timeZone),
      resolveRepeatBoundsEndExclusive(component.timing?.repeat, timeZone)
    )).filter((value): value is Date => Boolean(value));
    if (componentEnds.length === step.component.length && componentEnds.length) {
      end = componentEnds.reduce((latest, value) => value > latest ? value : latest, start);
    } else if (course.step[index + 1]?.start) {
      end = treatmentRelativeInstant(course.step[index + 1].start!, anchor, timeZone);
    }
  }
  if (end && end <= start) throw new Error("R6 treatment step end must be after its start");
  return { start, end };
}

/** Latest finite source bound in one cycle, retaining a prior cycle's tail.
 * Unbounded components still restart at the next cycle, as before.
 * @param course Typed course without repeatCycle.
 * @param anchor Start of this cycle.
 * @param nextCycle Start of the following cycle, the default unbounded cutover.
 * @param timeZone Calendar zone; month offsets are never approximated as days.
 */
function repeatedCourseHorizon(
  course: FhirR6DosageDetails, anchor: Date, nextCycle: Date, timeZone: string
): Date {
  let horizon = nextCycle;
  let previousEnd = anchor;
  for (let index = 0; index < course.step.length; index++) {
    const { start, end } = treatmentStepWindow(course, index, anchor, previousEnd, timeZone);
    if (end) {
      if (end > horizon) horizon = end;
      previousEnd = end;
    } else {
      // Independently bounded concurrent components need not share an end.
      for (const component of course.step[index].component) {
        const ownEnd = earlierDate(
          resolveRepeatDurationCapEnd(component, start, timeZone),
          resolveRepeatBoundsEndExclusive(component.timing?.repeat, timeZone)
        );
        if (ownEnd && ownEnd > horizon) horizon = ownEnd;
      }
      if (index + 1 < course.step.length) break;
    }
  }
  return horizon;
}

/** Whether this source step still participates in the numbered repeat cycle.
 * @param step Typed course step, with an optional finite repetition count.
 * @param cycleIndex Zero-based cycle, or undefined for non-cyclic execution.
 */
function stepOccursInCycle(step: FhirR6DosageDetails["step"][number], cycleIndex?: number): boolean {
  return cycleIndex === undefined || step.count === undefined || cycleIndex < step.count;
}

function scheduleTreatmentRelativeCourse(
  course: FhirR6DosageDetails, options: NextDueDoseOptions,
  cycleDefaultEnd?: Date, cycleIndex?: number
): string[] {
  const timeZone = options.timeZone ?? options.config?.timeZone;
  if (!timeZone) throw new Error("timeZone is required for relative treatment-step scheduling");
  const from = coerceDate(options.from, "from");
  const anchor = options.orderedAt !== undefined
    ? coerceDate(options.orderedAt, "orderedAt")
    : from;
  const limit = Math.floor(options.limit ?? 10);
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const flattened = toFhirR5Dosages(course);
  const doses: string[] = [];
  let previousEnd = anchor;
  let componentIndex = 0;
  for (let index = 0; index < course.step.length; index++) {
    const step = course.step[index];
    const { start, end } = treatmentStepWindow(course, index, anchor, previousEnd, timeZone);
    for (const component of step.component) {
      const original = flattened[componentIndex++];
      if (!original) throw new Error("R6 course component projection is incomplete");
      if (!stepOccursInCycle(step, cycleIndex)) continue;
      const repeat = component.timing?.repeat;
      const absoluteStart = resolveRepeatBoundsStart(repeat, timeZone);
      if (repeat?.boundsPeriod?.start && !absoluteStart)
        throw new Error("Invalid absolute component start date in R6 course");
      const absoluteEnd = resolveRepeatBoundsEndExclusive(repeat, timeZone);
      if (repeat?.boundsPeriod?.end && !absoluteEnd)
        throw new Error("Invalid absolute component end date in R6 course");
      if (absoluteStart && absoluteEnd && absoluteEnd <= absoluteStart)
        throw new Error("Absolute calendar component end precedes its start");
      const dosage = {
        ...original,
        modifierExtension: original.modifierExtension?.filter(ext =>
          ext.url !== DOSAGE_DETAILS_R5_URL)
      };
      const effectiveEnd = end ?? (cycleDefaultEnd ? earlierDate(
        resolveRepeatDurationCapEnd(dosage, start, timeZone), absoluteEnd
      ) ?? cycleDefaultEnd : undefined);
      if (effectiveEnd && from >= effectiveEnd) continue;
      // A calendar track may begin before the first relative treatment step:
      // its absolute start is independent of orderedAt. Later global steps
      // must still clip it at their own start to avoid duplicate doses.
      const stageStart = index === 0 && repeat?.boundsPeriod ? from : start;
      const effectiveFrom = from > stageStart ? from : stageStart;
      // A calendar track keeps its own recurrence origin across global step
      // cuts. Otherwise QOD / monthly cadence would restart at every taper.
      const cadenceOrigin = repeat?.boundsPeriod
        ? (absoluteStart ?? anchor)
        : parallelComponentCadenceOrigin(dosage, anchor, timeZone, start);
      const candidateTimes = nextDueDoses({
        ...dosage,
        modifierExtension: dosage.modifierExtension?.filter(ext =>
          ext.url !== PARALLEL_COMPONENT_PHASE_ORIGIN_URL)
      }, {
        ...options, from: effectiveFrom, orderedAt: cadenceOrigin, limit
      });
      for (const time of candidateTimes) {
        if (effectiveEnd && Date.parse(time) >= effectiveEnd.getTime()) break;
        doses.push(time);
      }
    }
    if (end) previousEnd = end;
    else if (index + 1 < course.step.length) break;
  }
  return doses.sort((left, right) => Date.parse(left) - Date.parse(right))
    .slice(0, limit);
}

function scheduleRepeatedCourse(
  course: FhirR6DosageDetails,
  options: NextDueDoseOptions,
  timeZone: string
): string[] {
  const advance = durationStepper(course.repeatCycle, timeZone);
  if (!advance) return scheduleTreatmentRelativeCourse(
    { ...course, repeatCycle: undefined },
    { ...options, orderedAt: options.orderedAt ?? options.from }
  );
  const from = coerceDate(options.from, "from");
  const anchor = options.orderedAt === undefined
    ? from : coerceDate(options.orderedAt, "orderedAt");
  const limit = Math.floor(options.limit ?? 10);
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const results: string[] = [];
  const singleCycle = { ...course, repeatCycle: undefined };
  let cycleStart = anchor;
  let guard = 0;
  const maxCycles = Math.max(366, limit * 366);
  while (guard < maxCycles && course.step.some(step => stepOccursInCycle(step, guard))) {
    const cycleEnd = advance(cycleStart);
    if (!cycleEnd || cycleEnd <= cycleStart) break;
    const horizon = repeatedCourseHorizon(singleCycle, cycleStart, cycleEnd, timeZone);
    if (horizon > from) {
      const candidates = scheduleTreatmentRelativeCourse(singleCycle, {
        ...options, from: from > cycleStart ? from : cycleStart,
        orderedAt: cycleStart, priorCount: undefined, limit
      }, cycleEnd, guard);
      results.push(...candidates);
      // Keep multiplicity: two active cycle components at the same instant
      // are two administrations, not duplicate representation artifacts.
      results.sort((left, right) => Date.parse(left) - Date.parse(right));
      if (results.length > limit) results.length = limit;
    }
    cycleStart = cycleEnd;
    guard += 1;
    // A future cycle cannot precede its own start. Stop only after all cycles
    // that could contribute an earlier occurrence than the last result ran.
    if (results.length === limit && cycleStart.getTime() > Date.parse(results[limit - 1])) break;
  }
  return results;
}

/**
 * Produces the next dose timestamps in ascending order according to the
 * provided configuration and dosage metadata.
 */
/** A choice modifier changes execution, never the ability to parse/edit a SIG.
 * @param dosage A native R5/R6 administration component.
 * @returns Whether the original explicitly contains the choice marker.
 */
function hasAlternativeChoice(dosage: Pick<FhirDosage, "modifierExtension">): boolean {
  return dosage.modifierExtension?.some(extension => extension.url === DOSAGE_ALTERNATIVE_CHOICE_URL) ?? false;
}

/** Read mandatory membership while preserving malformed input for correction.
 * @param dosage An administration with an explicit choice modifier.
 */
function executionChoice(dosage: Pick<FhirDosage, "modifierExtension">) {
  const choice = getDosageAlternativeChoice(dosage);
  if (!choice && hasAlternativeChoice(dosage)) {
    throw new MedicationQuantityCalculationError("invalid-alternative-choice",
      "An alternative-choice modifier has incomplete group/branch data. Edit or clear that choice on the affected dosage before calculating; the original instruction and all branches are retained.");
  }
  return choice;
}

/** Resolve exactly-one groups from structured memberships, never source text.
 * Returned execution copies omit the resolved modifier; caller-owned editable
 * dosages and their full retained source are untouched.
 * @param members Every relevant member of the course (possibly three or more branches).
 * @param options Explicit branch choices supplied by the clinician/application.
 */
function selectedAlternativeMembers<T extends Pick<FhirDosage, "modifierExtension">>(
  members: readonly T[], options: NextDueDoseOptions
): T[] {
  if (!members.some(hasAlternativeChoice)) return [...members];
  const groups = new Map<string, Set<string>>();
  for (const member of members) {
    const choice = executionChoice(member);
    if (!choice) continue;
    const branches = groups.get(choice.groupId) ?? new Set<string>();
    branches.add(choice.branchId); groups.set(choice.groupId, branches);
  }
  for (const [group, branches] of groups) {
    const selected = options.alternativeChoices?.[group];
    if (!selected || !branches.has(selected)) {
      const code = selected ? "unknown-alternative-branch" : "alternative-choice-required";
      throw new MedicationQuantityCalculationError(code,
        `Choose one branch for '${group}' using alternativeChoices['${group}']: ${[...branches].join(", ")}. The alternatives remain editable; both are never administered or summed together.`);
    }
  }
  return members.filter(member => {
    const choice = getDosageAlternativeChoice(member);
    return !choice || options.alternativeChoices?.[choice.groupId] === choice.branchId;
  }).map(member => hasAlternativeChoice(member) ? {
    ...member,
    modifierExtension: member.modifierExtension?.filter(extension =>
      extension.url !== DOSAGE_ALTERNATIVE_CHOICE_URL)
  } : member);
}

/** Keep exact step timing while choosing one branch in a whole course.
 * @param course Native R6 course whose modifier fields survived R5/R6 lowering.
 * @param options Clinician-selected branch ids.
 */
function selectedAlternativeCourse(
  course: FhirR6DosageDetails, options: NextDueDoseOptions
): FhirR6DosageDetails {
  // Ordinary courses stay allocation-free; only an explicit modifier needs
  // group selection. Flatten once, not by repeated growing-array copying.
  if (!course.step.some(step => step.component.some(hasAlternativeChoice))) return course;
  const members: FhirR6DosageDetails["step"][number]["component"] = [];
  for (const step of course.step) members.push(...step.component);
  // Validate against the WHOLE group, not one component/step at a time.
  selectedAlternativeMembers(members, options);
  return {
    ...course,
    renderedInstruction: undefined,
    step: course.step.map(step => ({
      ...step,
      component: step.component.filter(component => {
        const choice = getDosageAlternativeChoice(component);
        return !choice || options.alternativeChoices?.[choice.groupId] === choice.branchId;
      }).map(component => hasAlternativeChoice(component) ? {
        ...component,
        modifierExtension: component.modifierExtension?.filter(extension =>
          extension.url !== DOSAGE_ALTERNATIVE_CHOICE_URL)
      } : component)
    })).filter(step => step.component.length > 0)
  };
}

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
      ? selectedAlternativeCourse(dosage as FhirR6DosageDetails, options) : undefined;
    if (r6Course && getMissingCourseContext(r6Course) !== undefined)
      throw new MedicationQuantityCalculationError("missing-course-context",
        "Supply the complete dosage array or restore its shared course metadata before scheduling; the surviving rows remain editable.");
    const zone = options?.timeZone ?? options?.config?.timeZone;
    if (r6Course?.repeatCycle && zone) {
      return scheduleRepeatedCourse(r6Course, options, zone);
    }
    if (r6Course && r6Course.step.some(step => step.start || step.end)) {
      return scheduleTreatmentRelativeCourse(r6Course, options);
    }
    const items = Array.isArray(dosage) ? selectedAlternativeMembers(dosage, options) :
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
    const episodes = scheduleRegimen(items, { ...options, limit });
    return episodes.reduce<string[]>((all, episode) => {
      all.push(...episode.timestamps);
      return all;
    }, []).sort((a, b) => Date.parse(a) - Date.parse(b)).slice(0, Math.floor(limit));
  }
  const one = dosage as FhirDosage;
  // A scalar wire row carries its own phase metadata. Shared cycle context,
  // when required, must accompany that row before enumerating administrations.
  if (one.modifierExtension?.some(extension => extension.url === DOSAGE_DETAILS_R5_URL)) {
    return nextDueDoses(toDosageDetails([one]), options);
  }
  const choice = executionChoice(one);
  if (choice) {
    const selected = options.alternativeChoices?.[choice.groupId];
    if (!selected) {
      throw new MedicationQuantityCalculationError("alternative-choice-required",
        `Select a branch for '${choice.groupId}' in alternativeChoices before scheduling. This dosage is '${choice.branchId}'; all alternatives remain editable.`);
    }
    if (selected !== choice.branchId) return [];
    return nextDueDoses({
      ...one,
      modifierExtension: one.modifierExtension?.filter(extension => extension.url !== DOSAGE_ALTERNATIVE_CHOICE_URL)
    }, options);
  }
  const administrationOffset = getAdministrationOffsetMinutes(one);
  if (administrationOffset !== undefined) {
    const zone = options.timeZone ?? options.config?.timeZone;
    if (!zone) throw new Error("A timeZone is required for administration offsets");
    const delta = administrationOffset * 60_000;
    const shifted = (value: Date | string, amount: number) =>
      formatZonedIso(new Date(coerceDate(value, "administration time").getTime() + amount), zone);
    const base: FhirDosage = {
      ...one,
      modifierExtension: one.modifierExtension?.filter(extension => extension.url !== ADMINISTRATION_OFFSET_EXTENSION_URL)
    };
    return nextDueDoses(base, {
      ...options,
      from: shifted(options.from, -delta),
      priorDoseTimes: options.priorDoseTimes?.map(value => shifted(value, -delta)),
      evaluateCondition: options.evaluateCondition
        ? (condition, at) => options.evaluateCondition!(condition, shifted(at, delta)) : undefined
    }).map(value => shifted(value, delta));
  }
  if (unscheduledOccurrenceCapacity(one)) return [];
  const guard = getDosageCondition(one);
  const exclusions = getDosageExcludedDates(one);
  const excludedWeekdays = new Set<string>(getDosageExcludedWeekdays(one));
  if (guard || exclusions.length || excludedWeekdays.size) {
    const limit = options?.limit ?? 10;
    if (!Number.isFinite(limit) || limit <= 0) return [];
    // A fully excluded week has no administration opportunities. This follows
    // the typed exclusion set; the prescription remains editable, and the
    // source and original cadence are not silently rewritten.
    if (Object.keys(WEEKDAY_TEXT).every(day => excludedWeekdays.has(WEEKDAY_TEXT[day]))) {
      return [];
    }
    const timeZone = options?.timeZone ?? options?.config?.timeZone;
    if (!timeZone) throw new Error("A timeZone is required for excluded-date/weekday scheduling");
    // Native EzDosage mirrors conditional/date semantics as direct fields
    // AND in R5 modifiers. Clear both representations before enumerating
    // candidate times, otherwise recursively re-enter this very filter.
    const { condition: _condition, excludedDates: _excludedDates, ...plainDosage } =
      one as EzDosage;
    const quantityCaps = executableQuantityCaps(one);
    const occurrenceCap = getTimingOccurrenceCap(one.timing?.repeat);
    // The cap is an allowance for *administered* doses, not for candidate
    // opportunities. Remove it while evaluating exclusions and conditions,
    // then apply it to the accepted administrations below.
    const unconstrained: FhirDosage = withoutOccurrenceCap({
      ...plainDosage,
      maxDosePerPeriod: undefined,
      // Drop only the filter markers during recursive candidate enumeration.
      // Their original FHIR payload stays intact on the caller's dosage.
      extension: plainDosage.extension?.filter(extension =>
        extension.url !== DOSAGE_EXCLUDED_WEEKDAYS_R5_URL),
      modifierExtension: plainDosage.modifierExtension?.filter(extension =>
        extension.url !== DOSAGE_CONDITION_R5_URL &&
        extension.url !== DOSAGE_EXCLUDED_DATES_R5_URL)
    });
    let candidateLimit = Math.min(10000, Math.max(16, Math.floor(limit) * 2));
    while (true) {
      const candidates = nextDueDoses(unconstrained, { ...options, limit: candidateLimit });
      const accepted: string[] = [];
      for (const at of candidates) {
        if (excludedWeekdays.size && excludedWeekdays.has(getLocalWeekday(new Date(at), timeZone))) {
          continue;
        }
        if (exclusions.length) {
          const { year, month, day } = getTimeParts(new Date(at), timeZone);
          const localDate = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
          if (exclusions.indexOf(localDate) >= 0) continue;
        }
        if (guard && options.evaluateCondition) {
          const eligible = options.evaluateCondition(guard, at);
          if (!eligible) continue;
        }
        accepted.push(at);
        if (!quantityCaps.length && !occurrenceCap && accepted.length >= limit) break;
      }
      // A conditionally withheld/excluded dose does not consume either cap.
      // The periodic cap must see ALL accepted opportunities before quantity
      // caps determine which can actually be given within the rolling limit.
      const periodicallyCapped = occurrenceCap
        ? applyOccurrenceCap(accepted, occurrenceCap, options.priorDoseTimes,
          timeZone, Number.MAX_SAFE_INTEGER)
        : accepted;
      const capped = applyQuantityCaps(periodicallyCapped, quantityCaps,
        options.priorDoseTimes, timeZone, limit);
      if (capped.length >= limit || candidates.length < candidateLimit || candidateLimit === 10000) {
        return capped;
      }
      candidateLimit = Math.min(10000, candidateLimit * 2);
    }
  }

  return nextDueDosesSingle(one, options);
}

/** A window of recurring opportunities is distinct from one punctual
 * WAKE dose. Typed FHIR event-window extensions are the authority; an existing
 * WAKE+subday interval is retained for legacy structured representations.
 */
function intervalEventWindow(
  repeat: FhirTimingRepeat | undefined
): { start: EventTiming; end: EventTiming } | undefined {
  if (!repeat || (repeat.timeOfDay?.length ?? 0) !== 0 ||
      !usesIntervalCadence(repeat) ||
      (repeat.periodUnit !== FhirPeriodUnit.Second &&
       repeat.periodUnit !== FhirPeriodUnit.Minute &&
       repeat.periodUnit !== FhirPeriodUnit.Hour)) return undefined;
  const typed = getTimingEventWindow(repeat);
  if (typed) return typed;
  const when = repeat.when;
  return when?.length === 1 && when[0] === EventTiming.Wake
    ? { start: EventTiming.Wake, end: EventTiming["Before Sleep"] }
    : undefined;
}

function isWakingHoursInterval(repeat: FhirTimingRepeat | undefined): boolean {
  return intervalEventWindow(repeat) !== undefined ||
    Boolean(getTimingClockWindow(repeat) && repeat && usesIntervalCadence(repeat));
}

/** Execute WAKE as the daily recurrence origin and HS as the exclusive end of
 * the caller's configured waking window. Absent clocks are never guessed. */
function generateWakingHoursIntervalSeries(
  repeat: FhirTimingRepeat,
  config: NextDueDoseConfig,
  from: Date,
  orderedAt: Date | null,
  courseEnd: Date | null,
  timeZone: string,
  limit: number,
  dayFilter: Set<string>,
  enforceDayFilter: boolean,
  monthlyOrdinal: MonthlyWeekdayOrdinal | undefined
): string[] | undefined {
  const window = intervalEventWindow(repeat);
  const clockWindow = usesIntervalCadence(repeat) ? getTimingClockWindow(repeat) : undefined;
  if (!window && !clockWindow) return undefined;
  const wakeValue = clockWindow?.start ?? (window && config.eventClock?.[window.start]);
  const sleepValue = clockWindow?.end ?? (window && config.eventClock?.[window.end]);
  const includeEnd = clockWindow?.endInclusive ?? false;
  if (!wakeValue || !sleepValue) {
    throw new Error(
      "Cannot execute a waking-hours interval without configured WAKE and HS event clocks"
    );
  }
  const wakeClock = normalizeClock(wakeValue);
  const sleepClock = normalizeClock(sleepValue);
  const advance = createIntervalStepper(repeat, timeZone);
  if (!advance) return undefined;

  // A patient may wake in the evening and go to sleep the next morning.
  // Anchor weekday rules to the wake date, not to the spillover date.
  const overnight = sleepClock < wakeClock;
  const firstTreatmentDay = overnight && orderedAt ? startOfLocalDay(orderedAt, timeZone) : null;
  const results: string[] = [];
  let currentDay = startOfLocalDay(from, timeZone);
  if (overnight) currentDay = addLocalDays(currentDay, -1, timeZone);
  let dayIterations = 0;
  const maxDays = calendarScanLimit(currentDay, courseEnd, limit);
  while (results.length < limit && dayIterations < maxDays &&
      (!courseEnd || currentDay < courseEnd)) {
    if ((!firstTreatmentDay || currentDay >= firstTreatmentDay) && matchesCalendarDay(
      currentDay, dayFilter, enforceDayFilter, monthlyOrdinal, timeZone
    )) {
      const wake = makeZonedDateFromDay(currentDay, timeZone, wakeClock);
      const sleepDay = overnight ? addLocalDays(currentDay, 1, timeZone) : currentDay;
      const sleep = makeZonedDateFromDay(sleepDay, timeZone, sleepClock);
      if (!wake || !sleep || sleep <= wake) {
        throw new Error(
          "Cannot execute a waking-hours interval unless configured WAKE precedes HS"
        );
      }
      let candidate = wake;
      let intervalIterations = 0;
      while ((candidate < sleep || includeEnd && candidate.getTime() === sleep.getTime()) && intervalIterations < 10_000) {
        if (candidate >= from && (!orderedAt || candidate >= orderedAt) &&
            (!courseEnd || candidate < courseEnd)) {
          results.push(formatZonedIso(candidate, timeZone));
          if (results.length >= limit) break;
        }
        const next = advance(candidate);
        if (!next || next <= candidate) break;
        candidate = next;
        intervalIterations += 1;
      }
    }
    currentDay = addLocalDays(currentDay, 1, timeZone);
    dayIterations += 1;
  }
  return results;
}

/** Known cycle-day eligibility cannot be replaced by an independent HS/QD cadence.
 * @param dosage The selected dosage; unknown modifiers and editable source remain untouched.
 */
function requireResolvedCycleDays(dosage: FhirDosage): void {
  const cycle = getCycleDayConstraint(dosage);
  if (cycle) {
    throw new MedicationQuantityCalculationError("unresolved-cycle-eligibility",
      `Cannot calculate cycle-day administrations until the cycle is resolved (${cycle.reason}). The dose, route, timing and source remain editable.`);
  }
}

function nextDueDosesSingle(dosage: FhirDosage, options: NextDueDoseOptions): string[] {
  requireResolvedCycleDays(dosage);
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
  // A PRN opportunity is not proof of administration. Apply known history
  // when supplied; otherwise enumerate the maximum remaining opportunity set.
  const prnCountCapped = !!dosage.asNeeded &&
    (dosage.timing?.repeat?.count !== undefined ||
      dosage.timing?.repeat?.countMax !== undefined);
  if (prnCountCapped && orderedAt && from > orderedAt && priorCountInput === undefined) {
    for (const stamp of options.priorDoseTimes ?? []) {
      const actual = coerceDate(stamp, "priorDoseTimes");
      if (actual >= orderedAt && actual < from) priorCount++;
    }
  }
  const needsDerivedPriorCount =
    priorCountInput === undefined && !!orderedAt && !dosage.asNeeded;

  const providedConfig = options.config;
  const timeZone = options.timeZone ?? providedConfig?.timeZone;
  if (!timeZone) {
    throw new Error("Configuration with a valid timeZone is required");
  }
  dosage = prepareBestEffortTiming(dosage);
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
  const boundsPeriod = validateRepeatBoundsPeriod(repeat, timeZone);
  const boundsStart = boundsPeriod.start;
  if (boundsStart && boundsStart > from) {
    from = boundsStart;
  }
  const effectiveOrderedAt =
    orderedAt && boundsStart && boundsStart > orderedAt ? boundsStart : orderedAt;
  const baseCandidate = effectiveOrderedAt ?? boundsStart ?? from;
  const baseTime = boundsStart && boundsStart > baseCandidate ? boundsStart : baseCandidate;
  const courseEnd = timing && repeat
    ? earlierDate(
      resolveRepeatDurationCapEnd(dosage, baseTime, timeZone),
      boundsPeriod.end
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
      priorCountInput === undefined && !dosage.asNeeded
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
      dosage,
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
    if (parseActivityTimingExtensions(repeat)?.length) {
      return [];
    }
    // A single future-dated administration is anchored to the later of
    // the order instant and the explicit start, not to an earlier order.
    // Without orderedAt, a boundsPeriod.start still anchors the one-time
    // dose so later queries cannot execute it a second time.
    const anchor = effectiveOrderedAt ?? boundsStart ?? from;
    if (anchor < from || (courseEnd && anchor >= courseEnd)) {
      return [];
    }
    return [formatZonedIso(anchor, timeZone)].slice(0, effectiveLimit);
  }

  const results: string[] = [];
  const seen = new Set<string>();
  const dayFilter = new Set((repeat.dayOfWeek ?? []).map((day) => day.toLowerCase()));
  const enforceDayFilter = dayFilter.size > 0;
  const dayFilteredSeriesRepeat = resolveDayFilteredSeriesRepeat(repeat, enforceDayFilter);
  const monthlyOrdinal = resolveMonthlyWeekdayOrdinal(repeat, baseTime, timeZone);

  const wakingHours = generateWakingHoursIntervalSeries(
    repeat,
    config,
    from,
    orderedAt,
    courseEnd,
    timeZone,
    effectiveLimit,
    dayFilter,
    enforceDayFilter,
    monthlyOrdinal
  );
  if (wakingHours) return wakingHours;
  const elapsedOrigin = clockAnchoredElapsedOrigin(repeat, baseTime, timeZone);
  if (elapsedOrigin) {
    return generateIntervalSeries(elapsedOrigin, from, effectiveLimit, repeat, timeZone,
      dayFilter, enforceDayFilter, orderedAt, courseEnd, monthlyOrdinal);
  }

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
      const maxIterations = calendarScanLimit(currentDay, courseEnd, effectiveLimit);
      while (
        results.length < effectiveLimit &&
        iterations < maxIterations &&
        (!courseEnd || currentDay < courseEnd)
      ) {
        if (matchesCalendarDay(currentDay, dayFilter, enforceDayFilter, monthlyOrdinal, timeZone) &&
            clockCadenceEligible(currentDay, cadenceAnchor, repeat, timeZone, enforceDayFilter)) {
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

  const treatAsInterval = usesIntervalCadence(repeat);

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
      defaultClock: toLocalClock(baseTime, timeZone),
      monthlyOrdinal
    }).slice(0, effectiveLimit);
  }

  if (repeat.frequency && repeat.period && repeat.periodUnit) {
    // Pure frequency schedules (e.g., BID/TID) rely on institution clocks that
    // clinicians expect. These can be overridden via configuration when
    // facilities use bespoke medication rounds.
    const clocks = resolveFrequencyClocks(timing, config);
    const codedDaily = recognizedDailyTimingCode(timing) !== undefined;
    const ordinaryDaily = repeat.period === 1 && repeat.periodUnit === FhirPeriodUnit.Day;
    if (!codedDaily && !ordinaryDaily) {
      return generateFrequencyPerPeriodSeries(
        baseTime, from, effectiveLimit, repeat, timeZone, orderedAt, courseEnd, clocks
      );
    }
    if (clocks.length === 0) return [];
    let currentDay = startOfLocalDay(from, timeZone);
    let iterations = 0;
    const maxIterations = calendarScanLimit(currentDay, courseEnd, effectiveLimit);
    while (
      results.length < effectiveLimit &&
      iterations < maxIterations &&
      (!courseEnd || currentDay < courseEnd)
    ) {
      if (matchesCalendarDay(currentDay, dayFilter, enforceDayFilter, monthlyOrdinal, timeZone)) {
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
  dosage: FhirDosage,
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
  const monthlyOrdinal = resolveMonthlyWeekdayOrdinal(repeat, orderedAt, timeZone);
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

  const elapsedOrigin = clockAnchoredElapsedOrigin(repeat,
    resolveRepeatBoundsStart(repeat, timeZone) ?? orderedAt, timeZone);
  if (elapsedOrigin) {
    return generateIntervalSeries(elapsedOrigin, orderedAt, normalizedCount ?? 100000,
      repeat, timeZone, dayFilter, enforceDayFilter, orderedAt, from, monthlyOrdinal).length;
  }

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
      const maxIterations = calendarScanLimit(currentDay, from, normalizedCount ?? 1);
      while (currentDay < from && iterations < maxIterations) {
        if (matchesCalendarDay(currentDay, dayFilter, enforceDayFilter, monthlyOrdinal, timeZone) &&
            clockCadenceEligible(currentDay, cadenceAnchor, repeat, timeZone, enforceDayFilter)) {
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

  const treatAsInterval = usesIntervalCadence(repeat);

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
      defaultClock: toLocalClock(orderedAt, timeZone),
      monthlyOrdinal
    });
    return count + generated.length;
  }

  if (repeat.frequency && repeat.period && repeat.periodUnit) {
    const clocks = resolveFrequencyClocks(timing, config);
    const codedDaily = recognizedDailyTimingCode(timing) !== undefined;
    const ordinaryDaily = repeat.period === 1 && repeat.periodUnit === FhirPeriodUnit.Day;
    if (!codedDaily && !ordinaryDaily) {
      return count + generateFrequencyPerPeriodSeries(
        orderedAt,
        orderedAt,
        normalizedCount ?? 100000,
        repeat,
        timeZone,
        orderedAt,
        from,
        clocks
      ).length;
    }
    if (clocks.length === 0) {
      return count;
    }

    let currentDay = startOfLocalDay(orderedAt, timeZone);
    let iterations = 0;
    const maxIterations = calendarScanLimit(currentDay, from, normalizedCount ?? 1);
    while (currentDay < from && iterations < maxIterations) {
      if (matchesCalendarDay(currentDay, dayFilter, enforceDayFilter, monthlyOrdinal, timeZone)) {
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

/** A single explicit clock anchors an elapsed-time recurrence; it does not erase its period.
 * Calendar-day recurrences and explicit clock lists keep their existing wall-clock semantics.
 * @param repeat Typed interval and clock, never interpreted source text.
 * @param baseTime Effective start of the treatment phase.
 * @param timeZone Calendar zone for the first explicit wall-clock instant only.
 */
function clockAnchoredElapsedOrigin(repeat: FhirTimingRepeat, baseTime: Date, timeZone: string): Date | undefined {
  if (repeat.timeOfDay?.length !== 1 || repeat.when?.length ||
      (repeat.periodUnit !== FhirPeriodUnit.Second && repeat.periodUnit !== FhirPeriodUnit.Minute &&
       repeat.periodUnit !== FhirPeriodUnit.Hour) || !usesIntervalCadence(repeat)) return undefined;
  const clock = normalizeClock(repeat.timeOfDay[0]);
  const day = startOfLocalDay(baseTime, timeZone);
  const first = makeZonedDateFromDay(day, timeZone, clock);
  if (first && first >= baseTime) return first;
  return makeZonedDateFromDay(addLocalDays(day, 1, timeZone), timeZone, clock) ?? undefined;
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
  upperBound?: Date | null,
  monthlyOrdinal?: MonthlyWeekdayOrdinal
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
    if (matchesCalendarDay(current, dayFilter, enforceDayFilter, monthlyOrdinal, timeZone)) {
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

/** Evenly place a frequency within a multi-day/non-daily period when no
 * weekday or event anchors were supplied. Calendar periods retain the local
 * anchor clock and use whole-day offsets where possible (2/week => day 0 and
 * day 3), avoiding surprising half-day wall-clock drift.
 */
function generateFrequencyPerPeriodSeries(
  baseTime: Date,
  from: Date,
  effectiveLimit: number,
  repeat: FhirTimingRepeat,
  timeZone: string,
  orderedAt: Date | null,
  upperBound?: Date | null,
  clocks: readonly string[] = []
): string[] {
  const frequency = positiveInteger(repeat.frequency);
  const period = positiveNumber(repeat.period);
  const periodUnit = repeat.periodUnit;
  if (!frequency || !period || !periodUnit || effectiveLimit <= 0) return [];
  const advanceCycle = createIntervalStepper({ period, periodUnit }, timeZone);
  if (!advanceCycle) return [];
  const results: string[] = [];
  const seen = new Set<string>();
  let cycleStart = baseTime;
  let guard = 0;
  const maxCycles = Math.max(366, effectiveLimit * 366);

  while (guard < maxCycles) {
    const next = advanceCycle(cycleStart);
    if (!next || next <= cycleStart) return results;
    if (next > from) break;
    cycleStart = next;
    guard += 1;
  }

  while (results.length < effectiveLimit && guard < maxCycles &&
      (!upperBound || cycleStart < upperBound)) {
    const cycleEnd = advanceCycle(cycleStart);
    if (!cycleEnd || cycleEnd <= cycleStart) break;
    const calendarUnit = periodUnit === FhirPeriodUnit.Day ||
      periodUnit === FhirPeriodUnit.Week || periodUnit === FhirPeriodUnit.Month ||
      periodUnit === FhirPeriodUnit.Year;
    const spanDays = calendarUnit
      ? Math.max(1, getLocalDayNumber(cycleEnd, timeZone) - getLocalDayNumber(cycleStart, timeZone))
      : 0;
    const baseClock = toLocalClock(cycleStart, timeZone);
    for (let index = 0; index < frequency && results.length < effectiveLimit; index++) {
      let candidate: Date | null;
      if (calendarUnit && frequency <= spanDays) {
        const day = addLocalDays(startOfLocalDay(cycleStart, timeZone),
          Math.floor(index * spanDays / frequency), timeZone);
        const clock = clocks[index % Math.max(1, clocks.length)] ?? baseClock;
        candidate = makeZonedDateFromDay(day, timeZone, clock);
      } else {
        candidate = new Date(cycleStart.getTime() +
          Math.floor((cycleEnd.getTime() - cycleStart.getTime()) * index / frequency));
      }
      if (!candidate || candidate < from || candidate < cycleStart || candidate >= cycleEnd ||
          orderedAt && candidate < orderedAt || upperBound && candidate >= upperBound) continue;
      const iso = formatZonedIso(candidate, timeZone);
      if (!seen.has(iso)) {
        seen.add(iso);
        results.push(iso);
      }
    }
    cycleStart = cycleEnd;
    guard += 1;
  }
  return results;
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
  monthlyOrdinal?: MonthlyWeekdayOrdinal;
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
    defaultClock,
    monthlyOrdinal
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
    : limit * 366;
  const maxIterations = Math.max(limit * 366, estimatedDays + 31);

  while (
    results.length < limit &&
    iterations < maxIterations &&
    (!to || currentDay < to)
  ) {
    const inPeriodCycle = isDateAlignedToPeriodCycle(
      currentDay,
      anchorDay,
      repeat,
      timeZone
    );
    if (inPeriodCycle && matchesCalendarDay(
      currentDay, dayFilter, true, monthlyOrdinal, timeZone
    )) {
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
  limit?: number,
  explicitPriorCount = 0,
  derivePriorCount = true
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
  const monthlyOrdinal = resolveMonthlyWeekdayOrdinal(repeat, baseTime, timeZone);
  const priorCount = derivePriorCount &&
    normalizedCount !== undefined && orderedAt && from > orderedAt
      ? derivePriorCountFromHistory(dosage, timing, repeat, config, orderedAt, from, timeZone)
      : explicitPriorCount;
  const countLimit = normalizedCount === undefined
    ? (limit ?? Number.POSITIVE_INFINITY)
    : Math.min(limit ?? normalizedCount, Math.max(0, normalizedCount - priorCount));
  if (countLimit <= 0) {
    return 0;
  }
  const hardLimit = Number.isFinite(countLimit) ? countLimit : 365 * 31;

  if (isSingleAdministrationRepeat(repeat)) {
    if (parseActivityTimingExtensions(repeat)?.length) {
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

  const elapsedOrigin = clockAnchoredElapsedOrigin(repeat, baseTime, timeZone);
  if (elapsedOrigin) {
    return generateIntervalSeries(elapsedOrigin, from, hardLimit, repeat, timeZone,
      dayFilter, enforceDayFilter, orderedAt, to, monthlyOrdinal).length;
  }

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
      const maxIterations = calendarScanLimit(currentDay, to, hardLimit);
      while (count < countLimit && currentDay < to && iterations < maxIterations) {
        if (matchesCalendarDay(currentDay, dayFilter, enforceDayFilter, monthlyOrdinal, timeZone) &&
            clockCadenceEligible(currentDay, cadenceAnchor, repeat, timeZone, enforceDayFilter)) {
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

  const treatAsInterval = usesIntervalCadence(repeat);

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
    const codedDaily = recognizedDailyTimingCode(timing) !== undefined;
    const ordinaryDaily = repeat.period === 1 && repeat.periodUnit === FhirPeriodUnit.Day;
    if (!codedDaily && !ordinaryDaily) {
      return count + generateFrequencyPerPeriodSeries(
        baseTime, from, hardLimit, repeat, timeZone, orderedAt, to, clocks
      ).length;
    }
    if (clocks.length === 0) return count;

    let currentDay = startOfLocalDay(from, timeZone);
    let iterations = 0;
    const maxIterations = calendarScanLimit(currentDay, to, hardLimit);
    while (count < countLimit && currentDay < to && iterations < maxIterations) {
      if (matchesCalendarDay(currentDay, dayFilter, enforceDayFilter, monthlyOrdinal, timeZone)) {
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
      defaultClock: toLocalClock(baseTime, timeZone),
      monthlyOrdinal
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
  let end: Date | null;
  if ((options.durationUnit === FhirPeriodUnit.Day ||
       options.durationUnit === FhirPeriodUnit.Week) &&
      Number.isInteger(options.durationValue)) {
    const days = options.durationValue *
      (options.durationUnit === FhirPeriodUnit.Week ? 7 : 1);
    const parts = getTimeParts(from, zone);
    const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
    end = makeZonedDate(
      zone,
      shifted.getUTCFullYear(),
      shifted.getUTCMonth() + 1,
      shifted.getUTCDate(),
      parts.hour,
      parts.minute,
      parts.second
    ) ?? advance(from);
  } else {
    end = advance(from);
  }
  if (!end || end <= from) throw new MedicationQuantityCalculationError("invalid-horizon",
    "Dispensing duration does not produce a date after the start of the dispensing window.");
  return end;
}

function prepareMaximumSupplyTiming(dosage: FhirDosage): {
  dosage: FhirDosage;
  countMaximum: boolean;
  frequencyMaximum: boolean;
  periodMinimum: boolean;
  infusionDurationMaximum: boolean;
} {
  const repeat = dosage.timing?.repeat;
  if (!repeat) return {
    dosage, countMaximum: false, frequencyMaximum: false,
    periodMinimum: false, infusionDurationMaximum: false
  };
  let nextRepeat = repeat;
  let countMaximum = false;
  let frequencyMaximum = false;
  let periodMinimum = false;
  let infusionDurationMaximum = false;

  const count = positiveInteger(repeat.count);
  const countMax = positiveInteger(repeat.countMax);
  if (countMax && (!count || countMax >= count) && countMax !== count) {
    nextRepeat = { ...nextRepeat, count: countMax, countMax: undefined };
    countMaximum = true;
  }

  const frequency = positiveInteger(repeat.frequency);
  const frequencyMax = positiveInteger(repeat.frequencyMax);
  if (!dosage.timing?.event?.length &&
      frequencyMax && (!frequency || frequencyMax >= frequency) &&
      frequencyMax !== frequency && positiveNumber(repeat.period ?? repeat.periodMax) &&
      repeat.periodUnit) {
      nextRepeat = {
        ...nextRepeat,
        frequency: frequencyMax,
        frequencyMax: undefined
      };
      frequencyMaximum = true;
  }

  const period = positiveNumber(repeat.period);
  const periodMax = positiveNumber(repeat.periodMax);
  if (periodMax && (!period || periodMax >= period) && periodMax !== period) {
    // The lower/shorter period produces the maximum number of opportunities.
    // If only the upper endpoint is executable, it is still more useful than
    // discarding the entire cadence.
    nextRepeat = { ...nextRepeat, period: period ?? periodMax, periodMax: undefined };
    periodMinimum = true;
  }

  const first = dosage.doseAndRate?.length === 1 ? dosage.doseAndRate[0] : undefined;
  const isRateDose = !!first && !first.doseQuantity && !!(first.rateQuantity || first.rateRatio);
  if (isRateDose && repeat.durationMax !== undefined) {
    const duration = positiveNumber(repeat.duration);
    const durationMax = positiveNumber(repeat.durationMax);
    if (durationMax && (!duration || durationMax >= duration) && repeat.durationUnit &&
        durationMax !== duration) {
      nextRepeat = { ...nextRepeat, duration: durationMax, durationMax: undefined };
      infusionDurationMaximum = true;
    }
  }

  return {
    dosage: nextRepeat === repeat ? dosage : {
      ...dosage,
      timing: {
        ...dosage.timing!,
        repeat: nextRepeat
      }
    },
    countMaximum,
    frequencyMaximum,
    periodMinimum,
    infusionDurationMaximum
  };
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
  if (!quantity && first.doseRange) {
    const high = first.doseRange.high;
    const low = first.doseRange.low;
    quantity = high?.value !== undefined && Number.isFinite(high.value) &&
      high.value > 0 && !high.comparator
      ? high
      : low?.value !== undefined && Number.isFinite(low.value) &&
          low.value > 0 && !low.comparator
        ? low : undefined;
  }
  if (!quantity || quantity.value === undefined || !Number.isFinite(quantity.value) ||
      quantity.value <= 0 || quantity.comparator) {
    throw new MedicationQuantityCalculationError("dose-amount-unresolved",
      "The administered dose is not a single known positive quantity. Provide the applicable dose, range choice, or evaluated expression.");
  }
  const perKg = (quantity.code ?? quantity.unit ?? "").match(/^(.+?)\/kg$/i);
  if (perKg) {
    const weight = options.patientWeightKg;
    if (weight !== undefined && Number.isFinite(weight) && weight > 0) {
      quantity = {
        ...quantity, value: roundCalculatedUnits(quantity.value * weight),
        unit: perKg[1], code: quantity.code ? perKg[1] : undefined
      };
    }
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
  // Round only the combined supply, never each treatment stage separately.
  const scheduledUnits = totalUnits;
  if (options.roundToMultiple && options.roundToMultiple > 0)
    totalUnits = roundCalculatedUnits(
      Math.ceil(totalUnits / options.roundToMultiple) * options.roundToMultiple
    );
  if (scheduledUnits > 0 && totalUnits !== scheduledUnits) {
    // Each per-stage approximation describes its unrounded supply. Estimate
    // the extra dispensed units at the same combined per-unit rate; otherwise
    // bottle counts and strength estimates disagree with totalUnits.
    const roundedShare = totalUnits / scheduledUnits;
    if (approximate?.value !== undefined) {
      approximate.value = roundCalculatedUnits(approximate.value * roundedShare);
      // Recompute ingredient amount from the rounded volume/weight and
      // product strength, just like the single-dosage path.
      ingredient = estimateIngredientQuantity(approximate, options.context) ??
        (ingredient?.value !== undefined
          ? { ...ingredient, value: roundCalculatedUnits(ingredient.value * roundedShare) }
          : undefined);
    } else if (ingredient?.value !== undefined) {
      ingredient.value = roundCalculatedUnits(ingredient.value * roundedShare);
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
        // Quantity describes the prescribed amount, not the capacity of all
        // dispensed packages. A half-bottle course requires 60 mL from a
        // 120 mL bottle even though totalContainers is one.
        value: useEstimate ? estimateValue! : roundCalculatedUnits(totalUnits * context.containerValue),
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
  const { dosage: sourceDosage, roundToMultiple, context } = options;
  requireResolvedCycleDays(sourceDosage);
  const providedConfig = options.config;
  const timeZone = options.timeZone ?? providedConfig?.timeZone;
  if (!timeZone) throw new Error("timeZone is required for calculateTotalUnits");
  const from = coerceDate(options.from, "from");
  const administrationOffset = getAdministrationOffsetMinutes(sourceDosage);
  if (administrationOffset !== undefined) {
    const delta = administrationOffset * 60_000;
    const shift = (value: Date | string, amount: number) => new Date(coerceDate(value, "administration time").getTime() + amount);
    const end = calculationHorizon(options, timeZone);
    return calculateTotalUnitsSingle({
      ...options,
      dosage: {
        ...sourceDosage,
        modifierExtension: sourceDosage.modifierExtension?.filter(extension => extension.url !== ADMINISTRATION_OFFSET_EXTENSION_URL)
      },
      from: shift(from, -delta),
      durationValue: (end.getTime() - from.getTime()) / 1000,
      durationUnit: FhirPeriodUnit.Second,
      priorDoseTimes: options.priorDoseTimes?.map(value => shift(value, -delta)),
      evaluateCondition: options.evaluateCondition
        ? (condition, at) => options.evaluateCondition!(condition, formatZonedIso(shift(at, delta), timeZone)) : undefined
    });
  }
  if (options.priorCount !== undefined &&
      (!Number.isFinite(options.priorCount) || options.priorCount < 0))
    throw new MedicationQuantityCalculationError("invalid-prior-count",
      "priorCount must be a non-negative finite number.");
  // Validate single-dosage horizons exactly like whole-course horizons,
  // before unrelated dose details can mask an invalid dispensing window.
  let endDay = calculationHorizon(options, timeZone);

  const maximalTiming = prepareMaximumSupplyTiming(sourceDosage);
  const dosage = prepareMeasuredDose(maximalTiming.dosage, options);
  let unevaluatedMaximumDose = false;
  let lifetimeMaximum: number | undefined;
  const strength = resolveContextStrengthRatio(context) as any;
  const doseForLimits = dosage.doseAndRate?.[0]?.doseQuantity;
  const doseUnitForLimits = doseForLimits?.code ?? doseForLimits?.unit ?? "";
  const lifetime = dosage.maxDosePerLifetime;
  if (lifetime?.value !== undefined && Number.isFinite(lifetime.value) &&
      lifetime.value >= 0 && !lifetime.comparator) {
    const lifetimeUnit = lifetime.code ?? lifetime.unit ?? "";
    const converted = lifetimeUnit.toLowerCase() === doseUnitForLimits.toLowerCase()
      ? lifetime.value
      : convertValue(lifetime.value, lifetimeUnit, doseUnitForLimits, strength);
    if (converted !== null && Number.isFinite(converted)) {
      const knownPrior = (options.priorDoseTimes?.length ?? 0) *
        (doseForLimits?.value ?? 0) * getAdministrationTargetMultiplier(dosage, context);
      lifetimeMaximum = Math.max(0, converted - knownPrior);
    } else {
      unevaluatedMaximumDose = true;
    }
  } else if (lifetime) {
    unevaluatedMaximumDose = true;
  }
  if (dosage.maxDosePerAdministration) {
    const dose = dosage.doseAndRate?.[0]?.doseQuantity;
    const limit = dosage.maxDosePerAdministration;
    if (!dose?.value || limit.value === undefined || !Number.isFinite(limit.value) ||
        limit.value < 0 || limit.comparator) {
      unevaluatedMaximumDose = true;
    } else {
      const fromUnit = dose.code ?? dose.unit ?? "";
      const limitUnit = limit.code ?? limit.unit ?? "";
      const perTarget = fromUnit.toLowerCase() === limitUnit.toLowerCase()
        ? dose.value : convertValue(dose.value, fromUnit, limitUnit, strength);
      if (perTarget === null || !Number.isFinite(perTarget)) {
        unevaluatedMaximumDose = true;
      } else {
        const actual = perTarget * getAdministrationTargetMultiplier(dosage, context);
        if (actual > limit.value + 1e-9)
          unevaluatedMaximumDose = true;
      }
    }
  }
  if (dosage.maxDosePerPeriod?.length &&
      executableQuantityCaps(dosage, context).length < dosage.maxDosePerPeriod.length) {
    unevaluatedMaximumDose = true;
  }
  const hasPartialR6Safety = Boolean((dosage as EzDosage).safety);
  const conditional = getDosageCondition(dosage);
  const excludedDates = getDosageExcludedDates(dosage);
  const excludedWeekdays = getDosageExcludedWeekdays(dosage);
  const useMaximalPlan = !!dosage.asNeeded ||
    (!!conditional && !options.evaluateCondition) ||
    maximalTiming.countMaximum || maximalTiming.frequencyMaximum ||
    maximalTiming.periodMinimum || maximalTiming.infusionDurationMaximum ||
    lifetimeMaximum !== undefined || unevaluatedMaximumDose || hasPartialR6Safety;

  const orderedAtDate =
    options.orderedAt === undefined ? null : coerceDate(options.orderedAt, "orderedAt");

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

  const repeat = dosage.timing?.repeat;
  const capacityCap = unscheduledOccurrenceCapacity(dosage);
  const boundsPeriod = validateRepeatBoundsPeriod(repeat, timeZone);
  const boundsStart = boundsPeriod.start;
  const countFrom = boundsStart && boundsStart > from ? boundsStart : from;
  const effectiveOrderedAt =
    orderedAtDate && boundsStart && boundsStart > orderedAtDate ? boundsStart : orderedAtDate;
  const baseCandidate = effectiveOrderedAt ?? boundsStart ?? countFrom;
  const baseTime = boundsStart && boundsStart > baseCandidate ? boundsStart : baseCandidate;
  endDay = minDate(
    endDay,
    resolveRepeatDurationCapEnd(dosage, baseTime, timeZone)
  );
  endDay = minDate(
    endDay,
    boundsPeriod.end
  );

  const needsFilteredEnumeration = conditional || excludedDates.length || excludedWeekdays.length ||
    !!dosage.maxDosePerPeriod?.length || !!getTimingOccurrenceCap(repeat) ||
    isWakingHoursInterval(repeat);
  let count: number;
  if (endDay <= countFrom) {
    count = 0;
  } else if (capacityCap) {
    const begin = effectiveOrderedAt && effectiveOrderedAt > countFrom ? effectiveOrderedAt : countFrom;
    count = maximumUnscheduledCapCount(dosage, capacityCap, begin, endDay, options, timeZone,
      executableQuantityCaps(dosage, context));
    const totalCap = repeat ? repeatOccurrenceCap(repeat) : undefined;
    if (totalCap !== undefined) {
      count = Math.min(count, Math.max(0, totalCap -
        (options.priorCount ?? options.priorDoseTimes?.length ?? 0)));
    }
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
        options.priorCount === undefined ? 0 : Math.floor(options.priorCount),
        options.priorCount === undefined && !dosage.asNeeded
      )
      : undefined;
    count = exactEvents !== undefined
      ? exactEvents.length
      : countScheduleEvents(
        dosage, countFrom, endDay, config, baseTime, effectiveOrderedAt, 100000,
        options.priorCount === undefined ? 0 : Math.floor(options.priorCount),
        options.priorCount === undefined && !dosage.asNeeded
      );
  }

  if (maximalTiming.frequencyMaximum && dosage.timing?.repeat) {
    // Scheduling keeps every stated clock/code as the concrete partial plan.
    // Numeric supply can still report the prescribed upper bound without
    // mutating or deleting those anchors on the caller's FHIR object.
    const maximumRepeat: FhirTimingRepeat = {
      ...dosage.timing.repeat,
      timeOfDay: undefined,
      when: undefined,
      boundsPeriod: {
        ...(dosage.timing.repeat.boundsPeriod?.start
          ? { start: dosage.timing.repeat.boundsPeriod.start } : {}),
        end: new Date(endDay.getTime() - 1).toISOString()
      }
    };
    const maximumDosage: FhirDosage = {
      ...dosage,
      text: undefined,
      patientInstruction: undefined,
      timing: { ...dosage.timing, event: undefined, code: undefined, repeat: maximumRepeat }
    };
    const upperBoundTimes = nextDueDoses(maximumDosage, {
      ...options,
      from: countFrom,
      orderedAt: effectiveOrderedAt ?? options.orderedAt,
      evaluateCondition: options.evaluateCondition ?? (() => true),
      limit: 10000
    });
    count = Math.max(count,
      upperBoundTimes.filter(date => Date.parse(date) < endDay.getTime()).length);
  }

  const doseQuantity = dosage.doseAndRate?.[0]?.doseQuantity?.value ?? 0;
  const targetMultiplier = getAdministrationTargetMultiplier(dosage, context);
  let totalUnits = roundCalculatedUnits(count * doseQuantity * targetMultiplier);

  if (roundToMultiple && roundToMultiple > 0) {
    totalUnits = roundCalculatedUnits(Math.ceil(totalUnits / roundToMultiple) * roundToMultiple);
  }
  if (lifetimeMaximum !== undefined) {
    totalUnits = roundCalculatedUnits(Math.min(totalUnits, lifetimeMaximum));
  }

  const maximumExplanations: string[] = [];
  if (capacityCap)
    maximumExplanations.push("the remaining capacity of each intersecting cap period was used without assigning administration times");
  if (conditional && capacityCap)
    maximumExplanations.push(getDosageCalendarDayCondition(dosage) && options.evaluateCondition
      ? "source-certified calendar-day conditions were evaluated per eligible day without assigning administration times"
      : "conditional use remains a capacity ceiling because administration times are unspecified");
  else if (conditional && !options.evaluateCondition)
    maximumExplanations.push("every scheduled clinical condition was assumed true; supply an evaluateCondition callback to calculate a patient-specific conditional schedule");
  if (dosage.asNeeded)
    maximumExplanations.push("PRN doses may be used less frequently than the available opportunities");
  if (maximalTiming.countMaximum)
    maximumExplanations.push("the upper count bound was used");
  if (maximalTiming.frequencyMaximum)
    maximumExplanations.push("the upper bound of the prescribed frequency range was used");
  if (maximalTiming.periodMinimum)
    maximumExplanations.push("the shortest executable period bound was used");
  if (maximalTiming.infusionDurationMaximum)
    maximumExplanations.push("the upper bound of the infusion-duration range was used");
  if (lifetimeMaximum !== undefined)
    maximumExplanations.push(options.priorDoseTimes?.length
      ? "the lifetime maximum was reduced by the supplied prior administrations"
      : "the full lifetime maximum was treated as still available because no prior administrations were supplied");
  if (unevaluatedMaximumDose)
    maximumExplanations.push("an unevaluable maximum-dose constraint was retained but could not be applied");
  if (hasPartialR6Safety)
    maximumExplanations.push("R6 safety details not expressible as numeric calendar limits were retained but not evaluated");

  const result: TotalUnitsResult = {
    totalUnits,
    ...((dosage.doseAndRate?.[0]?.doseQuantity?.unit ??
      dosage.doseAndRate?.[0]?.doseQuantity?.code) ? {
        unit: dosage.doseAndRate?.[0]?.doseQuantity?.unit ??
          dosage.doseAndRate?.[0]?.doseQuantity?.code
    } : {}),
    ...(useMaximalPlan || capacityCap ? {
      quantityKind: "maximum" as const,
      explanation: `Maximum possible supply: ${maximumExplanations.join("; ")}.`
    } : {})
  };

  if (/\/kg$/i.test(result.unit ?? "") &&
      !(options.patientWeightKg !== undefined && Number.isFinite(options.patientWeightKg) &&
        options.patientWeightKg > 0)) {
    result.quantityKind = "scheduled";
    result.explanation = "Weight-normalized total; provide patientWeightKg for an absolute quantity.";
  }

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
    } else if (containerUnit && doseUnit &&
               containerUnit.trim().toLowerCase() === doseUnit.trim().toLowerCase()) {
      // The prescription already counts in the container's exact unit.
      result.totalContainerQuantity = { value: totalUnits, unit: containerUnit };
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
  course: FhirR6DosageDetails, options: TotalUnitsOptions,
  cycleDefaultEnd?: Date, cycleIndex?: number
): TotalUnitsResult {
  course = selectedAlternativeCourse(course, options);
  if (getMissingCourseContext(course) !== undefined)
    throw new MedicationQuantityCalculationError("missing-course-context",
      "Supply the complete dosage array or restore its shared course metadata before calculating; the surviving rows remain editable.");
  const zone = options.timeZone ?? options.config?.timeZone;
  if (!zone)
    throw new MedicationQuantityCalculationError("time-zone-required",
      "Provide timeZone to calculate local administration times and calendar-month transitions.");
  const queryStart = coerceDate(options.from, "from");
  const queryEnd = calculationHorizon(options, zone);
  if (!course.step.length || course.step.every(step => !step.component.length))
    throw new MedicationQuantityCalculationError("missing-regimen",
      "A medication dosage or complete treatment course is required for supply calculation.");
  const cycleAdvance = durationStepper(course.repeatCycle, zone);
  if (cycleAdvance) {
    const anchor = options.orderedAt === undefined
      ? queryStart : coerceDate(options.orderedAt, "orderedAt");
    const entries: Array<{ total: TotalUnitsResult; unit: string | undefined }> = [];
    const singleCycle = { ...course, repeatCycle: undefined };
    let cycleStart = anchor;
    let guard = 0;
    while (cycleStart < queryEnd && guard < 10000 &&
        course.step.some(step => stepOccursInCycle(step, guard))) {
      const cycleEnd = cycleAdvance(cycleStart);
      if (!cycleEnd || cycleEnd <= cycleStart) break;
      const horizon = repeatedCourseHorizon(singleCycle, cycleStart, cycleEnd, zone);
      const windowStart = cycleStart > queryStart ? cycleStart : queryStart;
      const windowEnd = horizon < queryEnd ? horizon : queryEnd;
      if (windowEnd > windowStart) {
        const total = calculateCourseTotalUnits(singleCycle, {
          ...options, from: windowStart, orderedAt: cycleStart,
          durationValue: (windowEnd.getTime() - windowStart.getTime()) / 1000,
          durationUnit: FhirPeriodUnit.Second, priorCount: undefined,
          roundToMultiple: undefined
        }, cycleEnd, guard);
        entries.push({ total, unit: total.unit });
      }
      cycleStart = cycleEnd;
      guard += 1;
    }
    return sumCourseUnits(entries, options);
  }
  const anchored = options.orderedAt !== undefined;
  const assumedTreatmentStart = course.step.length > 1 && !anchored;
  const treatmentStart = anchored ? coerceDate(options.orderedAt!, "orderedAt") : queryStart;
  const flattened = toFhirR5Dosages(course);
  const entries: Array<{ total: TotalUnitsResult; unit: string | undefined }> = [];
  let assumedOpenTransition = false;
  let cursor = treatmentStart, dosageIndex = 0;
  let predecessorPoint: Date | undefined;
  for (let index = 0; index < course.step.length; index++) {
    const step = course.step[index];
    const start = step.start
      ? treatmentRelativeInstant(step.start, treatmentStart, zone)
      : cursor;
    const dosages: FhirDosage[] = [];
    const starts: Date[] = [];
    const ends: Array<Date | null> = [];
    const pointCompletions: Array<Date | undefined> = [];
    const cadenceOrigins: Date[] = [];
    for (const _component of step.component) {
      const dosage = flattened[dosageIndex++];
      if (!dosage) throw new MedicationQuantityCalculationError("invalid-course",
        "The R6 treatment course contains a different number of components from its dosage projection.");
      dosages.push(dosage);
      const repeat = dosage.timing?.repeat;
      const calendarStart = resolveRepeatBoundsStart(repeat, zone);
      if (repeat?.boundsPeriod?.start && !calendarStart)
        throw new MedicationQuantityCalculationError("invalid-calendar-bounds",
          "A calendar-bound dosage has an invalid start date; correct the date before calculating supply.");
      const calendarEnd = resolveRepeatBoundsEndExclusive(repeat, zone);
      if (repeat?.boundsPeriod?.end && !calendarEnd)
        throw new MedicationQuantityCalculationError("invalid-calendar-bounds",
          "A calendar-bound dosage has an invalid end date; correct the date before calculating supply.");
      if (calendarStart && calendarEnd && calendarEnd <= calendarStart)
        throw new MedicationQuantityCalculationError("invalid-calendar-order",
          "The calendar-bound dosage ends before its stated start date; correct the date interval.");
      // This stage clips administration times, but absolute-bound members
      // may have started BEFORE the stage cut. Keep their original cadence
      // anchored to the stated date rather than resetting it each time.
      const implicitStart = successorIntervalStart(dosage, predecessorPoint, start, zone);
      const cadenceOrigin = repeat?.boundsPeriod
        ? (calendarStart ?? treatmentStart)
        : parallelComponentCadenceOrigin(dosage, treatmentStart, zone, implicitStart);
      cadenceOrigins.push(cadenceOrigin);
      // Before the first global relative cut, an independent calendar member
      // is allowed to start before orderedAt. Subsequent step cuts still
      // intersect the calendar window with the global step.
      const stageStart = index === 0 && repeat?.boundsPeriod
        ? (calendarStart ?? start) : implicitStart;
      starts.push(calendarStart && calendarStart > stageStart ? calendarStart : stageStart);
      const bound = earlierDate(resolveRepeatDurationCapEnd(dosage, cadenceOrigin, zone), calendarEnd);
      const completion = finiteAdministrationCompletion(dosage, cadenceOrigin, options, zone);
      const countEnd = completion ? new Date(completion.end.getTime() + (completion.point ? 1 : 0)) : null;
      const end = earlierDate(bound, countEnd);
      ends.push(end);
      pointCompletions.push(completion?.point && end?.getTime() === countEnd?.getTime()
        ? completion.end : undefined);
    }
    const nextStep = course.step[index + 1];
    let stepEnd = step.end
      ? treatmentRelativeInstant(step.end, treatmentStart, zone) : undefined;
    if (!stepEnd && nextStep?.start)
      stepEnd = treatmentRelativeInstant(nextStep.start, treatmentStart, zone);
    if (!stepEnd && nextStep) {
      if (!ends.length || ends.some(value => !value)) {
        // Keep the current phase through the requested horizon when the text
        // did not specify a cutover. The later phase remains in the regimen
        // for clinician correction instead of making supply calculation fail.
        stepEnd = queryEnd;
        assumedOpenTransition = true;
      } else {
        stepEnd = ends.reduce<Date>((latest, value) =>
          value && value > latest ? value : latest, start);
      }
    }
    if (stepEnd && stepEnd <= start)
      throw new MedicationQuantityCalculationError("invalid-stage-order",
        "Stage " + (index + 1) + " ends at or before its start. Review the stage duration/date.");
    // Explicit overlapping stage dates remain usable as written. They are
    // summed independently rather than rejecting the entire clinician draft.
    for (let j = 0; j < dosages.length; j++) {
      if (!stepOccursInCycle(step, cycleIndex)) continue;
      const dosage = dosages[j];
      const begin = starts[j];
      const ownEnd = ends[j];
      const cadenceOrigin = cadenceOrigins[j];
      const end = [queryEnd, ...(stepEnd ? [stepEnd] : []),
        ...(ownEnd ? [ownEnd] : []),
        ...(!stepEnd && !ownEnd && cycleDefaultEnd ? [cycleDefaultEnd] : [])]
        .reduce((earliest, candidate) =>
        candidate < earliest ? candidate : earliest, queryEnd);
      if (end <= begin || end <= queryStart) continue;
      if (!dosage.timing?.repeat)
        throw new MedicationQuantityCalculationError("timing-required",
          "Stage " + (index + 1) + " has no executable frequency or dosing time for one component.");
      const bounded: FhirDosage = {
        ...dosage,
        modifierExtension: dosage.modifierExtension?.filter(ext =>
          ext.url !== DOSAGE_DETAILS_R5_URL &&
          ext.url !== PARALLEL_COMPONENT_PHASE_ORIGIN_URL),
        timing: {
          ...dosage.timing,
          repeat: {
            ...dosage.timing.repeat,
            // Global stage cut has already applied any boundsDuration;
            // never re-anchor it from the supply-window start.
            boundsDuration: undefined,
            boundsPeriod: {
              // Keep the true cadence origin while the supply-window `from`
              // below applies the later step cut (without changing recurrence).
              start: cadenceOrigin.toISOString(),
              end: new Date(end.getTime() - 1).toISOString()
            }
          }
        }
      };
      const measured = prepareMeasuredDose(bounded, options);
      const calculated = calculateTotalUnitsSingle({
        ...options, dosage: bounded,
        from: begin > queryStart ? begin : queryStart,
        orderedAt: cadenceOrigin, roundToMultiple: undefined
      });
      entries.push({
        total: calculated,
        unit: measured.doseAndRate?.[0]?.doseQuantity?.unit ??
          measured.doseAndRate?.[0]?.doseQuantity?.code
      });
    }
    if (stepEnd) {
      const point = pointCompletions.find(value => value && value.getTime() + 1 === stepEnd!.getTime());
      predecessorPoint = point;
      cursor = point ?? stepEnd;
    }
  }
  const result = sumCourseUnits(entries, options);
  const assumptions: string[] = [];
  if (assumedTreatmentStart)
    assumptions.push("Treatment start was assumed to be the requested from time because orderedAt was not supplied.");
  if (assumedOpenTransition)
    assumptions.push("A stage without a stated cutover was continued through the requested calculation horizon.");
  if (assumptions.length)
    result.explanation = [result.explanation, ...assumptions].filter(Boolean).join(" ");
  const hasPartialSafety = Boolean(course.safety) || course.step.some(step =>
    Boolean(step.safety) || step.component.some(component => Boolean(component.safety))
  );
  if (!hasPartialSafety) return result;
  const note = "R6 safety details that are not numeric calendar limits were retained but not evaluated.";
  return {
    ...result,
    quantityKind: "maximum",
    explanation: result.explanation ? `${result.explanation} ${note}` : note
  };
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
  const one = input as FhirDosage;
  if (one.modifierExtension?.some(extension => extension.url === DOSAGE_DETAILS_R5_URL)) {
    return calculateCourseTotalUnits(toDosageDetails([one]), options);
  }
  const choice = executionChoice(one);
  if (choice) {
    const selected = options.alternativeChoices?.[choice.groupId];
    if (!selected) {
      throw new MedicationQuantityCalculationError("alternative-choice-required",
        `Select a branch for '${choice.groupId}' in alternativeChoices before calculating supply. This dosage is '${choice.branchId}'; all alternatives remain editable.`);
    }
    if (selected !== choice.branchId) {
      return { totalUnits: 0, unit: one.doseAndRate?.[0]?.doseQuantity?.unit,
        quantityKind: "scheduled", explanation: "This is an unselected alternative; it contributes no administrations or supply." };
    }
    return calculateTotalUnitsSingle({ ...options, dosage: {
      ...one,
      modifierExtension: one.modifierExtension?.filter(extension => extension.url !== DOSAGE_ALTERNATIVE_CHOICE_URL)
    } });
  }
  return calculateTotalUnitsSingle(options as Omit<TotalUnitsOptions, "dosage"> & { dosage: FhirDosage });
}

interface ClockEntry { time: string; dayShift: number }

/** Occurrence enumeration, historical caps and totals use exactly the same clock defaults. */
function resolveExplicitClockEntries(repeat: FhirTimingRepeat, config: NextDueDoseConfig, dayFiltered: boolean): ClockEntry[] {
  const when = repeat.when ?? [], clocks = repeat.timeOfDay ?? [];
  const entries = expandWhenCodes(when, config, repeat);
  // "BID with food" specifies TWO administrations chosen from the meal
  // context, not every breakfast/lunch/dinner. An exclusion weekday used
  // to force enumeration of three C/AC/PC meal clocks and thereby inflate
  // the prescribed BID dose count. Fall back to the exact frequency's
  // configured clocks when an unspecific meal window has more candidates
  // than the explicitly prescribed daily frequency.
  if (when.length === 1 && clocks.length === 0 &&
      (when[0] === "C" || when[0] === "AC" || when[0] === "PC") &&
      repeat.period === 1 && repeat.periodUnit === "d" &&
      repeat.frequency !== undefined && entries.length !== repeat.frequency) {
    return [];
  }
  for (const clock of clocks) entries.push({ time: normalizeClock(clock), dayShift: 0 });
  if (clocks.length) entries.sort((a,b)=>a.dayShift-b.dayShift || a.time.localeCompare(b.time));
  if (!entries.length && !clocks.length && (dayFiltered || !repeat.frequency || !repeat.period || !repeat.periodUnit))
    entries.push(...inferWhenFallbackEntries(when, repeat));
  return entries;
}
/** Clock anchors restrict time within an eligible period; they do not erase its cadence. */
function clockCadenceEligible(day: Date, anchor: Date, repeat: FhirTimingRepeat, timeZone: string, dayFiltered: boolean): boolean {
  if (!repeat.period || !repeat.periodUnit || repeat.periodUnit === 'd' && repeat.period <= 1) return true;
  if (repeat.periodUnit === 'wk' && !dayFiltered) {
    const delta = getLocalDayNumber(day,timeZone)-getLocalDayNumber(anchor,timeZone);
    return delta >= 0 && delta % (7*repeat.period) === 0;
  }
  if ((repeat.periodUnit === 'mo' || repeat.periodUnit === 'a') && !dayFiltered) {
    const months=getLocalMonthIndex(day,timeZone)-getLocalMonthIndex(anchor,timeZone);
    const period=repeat.period*(repeat.periodUnit === 'a' ? 12 : 1);
    if (months<0 || months%period !== 0) return false;
    return getTimeParts(day,timeZone).day === getTimeParts(addCalendarMonths(anchor,months,timeZone),timeZone).day;
  }
  return isDateAlignedToPeriodCycle(day,anchor,repeat,timeZone);
}


/**
 * Generate due times for one whole medication regimen using R5 sequence / R6 steps.
 * The public nextDueDoses accepts a single Dosage, an array, or DosageDetails.
 *
 * A phase boundary must be known (explicit date or finite duration). If not,
 * return the schedulable prefix rather than inventing a later phase boundary.
 * "orderedAt" is required for relative multi-phase regimens, so a later
 * "from" query does not shift the treatment's start date.
 */
/** An unanchored interval successor starts one interval after a point event. */
function successorIntervalStart(
  dosage: FhirDosage, predecessorPoint: Date | undefined, fallback: Date, zone: string
): Date {
  const repeat = dosage.timing?.repeat;
  if (predecessorPoint && repeat?.period && repeat.periodUnit &&
      !repeat.when?.length && !repeat.timeOfDay?.length && !repeat.dayOfWeek?.length &&
      !dosage.timing?.code?.coding?.length) {
    return createIntervalStepper({
      period: repeat.period / (repeat.frequency ?? 1), periodUnit: repeat.periodUnit
    }, zone)?.(predecessorPoint) ?? fallback;
  }
  return fallback;
}

/** Completion of a finite administration count, independent of query window. */
function finiteAdministrationCompletion(
  dosage: FhirDosage,
  start: Date,
  options: NextDueDoseOptions,
  zone: string
): { end: Date; point: boolean } | undefined {
  const repeat = dosage.timing?.repeat;
  if (!repeat) return undefined;
  const count = repeat.count ?? (arrayIncludes(repeat.when ?? [], EventTiming.Immediate) ? 1 : undefined);
  if (count === undefined || !Number.isInteger(count) || count <= 0 ||
      repeat.countMax !== undefined && repeat.countMax !== count) return undefined;
  // The enclosing course has already supplied the predecessor/cycle context
  // and resolved this component's cadence origin. Count only this local
  // execution copy, rather than reopening it as an isolated persisted row.
  const local = dosage.modifierExtension?.some(extension => extension.url === DOSAGE_DETAILS_R5_URL)
    ? { ...dosage, modifierExtension: dosage.modifierExtension.filter(extension => extension.url !== DOSAGE_DETAILS_R5_URL) }
    : dosage;
  const due = nextDueDoses(local, { ...options, from: start, orderedAt: start, limit: count });
  if (due.length !== count) return undefined;
  const last = new Date(due[due.length - 1]);
  if (repeat.duration && repeat.durationUnit) {
    const advance = createIntervalStepper({ period: repeat.duration, periodUnit: repeat.durationUnit }, zone);
    const end = advance?.(last);
    if (end) return { end, point: false };
  }
  return { end: last, point: true };
}

function scheduleRegimen(
  dosages: FhirDosage[],
  options: NextDueDoseOptions
): RegimenDueTimes[] {
  if (dosages.length === 0) return [];
  if (dosages.some(dosage => dosage.modifierExtension?.some(extension =>
    extension.url === DOSAGE_DETAILS_R5_URL
  ))) {
    // Restore typed local phase metadata before dropping the R5 storage
    // marker from execution copies. The caller's editable rows stay intact.
    const restored = toDosageDetails(dosages);
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
  const from = coerceDate(options.from, "from");
  let cursor = options.orderedAt !== undefined ? coerceDate(options.orderedAt, "orderedAt") : from;
  const output: RegimenDueTimes[] = [];
  let predecessorPoint: Date | undefined;
  for (let phaseIndex = 0; phaseIndex < distinct.length; phaseIndex++) {
    const sequence = distinct[phaseIndex];
    const members = dosages.map((dosage, dosageIndex) => ({ dosage, dosageIndex }))
      .filter((_, index) => sequences[index] === sequence);
    const memberStarts = members.map(({ dosage }) => {
      const repeat = dosage.timing?.repeat;
      const explicit = resolveRepeatBoundsStart(repeat, zone);
      if (explicit) return explicit;
      return successorIntervalStart(dosage, predecessorPoint, cursor, zone);
    });
    const phaseStart = memberStarts.reduce((earliest, start) =>
      start < earliest ? start : earliest, cursor);
    for (let memberIndex = 0; memberIndex < members.length; memberIndex++) {
      const member = members[memberIndex];
      const memberStart = memberStarts[memberIndex];
      let startWindow = from > memberStart ? from : memberStart;
      if (predecessorPoint && startWindow <= predecessorPoint &&
          !arrayIncludes(member.dosage.timing?.repeat?.when ?? [], EventTiming.Immediate)) {
        startWindow = new Date(predecessorPoint.getTime() + 1);
      }
      output.push({
        dosageIndex: member.dosageIndex,
        sequence,
        phaseStart: memberStart.toISOString(),
        timestamps: nextDueDoses(member.dosage, {
          ...options,
          from: startWindow,
          orderedAt: memberStart
        })
      });
    }
    if (phaseIndex + 1 >= distinct.length) continue;
    const completions = members.map(({ dosage }, memberIndex) => {
      const repeat = dosage.timing?.repeat;
      if (!repeat) return undefined;
      const start = memberStarts[memberIndex];
      const bound = earlierDate(
        resolveRepeatDurationCapEnd(dosage, start, zone),
        resolveRepeatBoundsEndExclusive(repeat, zone)
      );
      const counted = finiteAdministrationCompletion(dosage, start, options, zone);
      if (bound && (!counted || bound <= counted.end)) return { end: bound, point: false };
      return counted;
    });
    // Finite counts and immediate point events are genuine completion facts,
    // just like a course duration. An actually unbounded predecessor remains
    // visible but does not acquire a fabricated completion time.
    if (completions.some(value => !value)) break;
    const latest = completions.reduce((left, right) =>
      right && (!left || right.end > left.end) ? right : left, completions[0]);
    if (!latest || latest.end < phaseStart) break;
    cursor = latest.end;
    predecessorPoint = latest.point ? latest.end : undefined;
  }
  return output.sort((a, b) => a.dosageIndex - b.dosageIndex);
}
