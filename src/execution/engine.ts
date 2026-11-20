/** Version-neutral medication execution kernel. All interchange decoding
 * happens in adapters/canonical-course. Calendar, count, phase and supply
 * calculations operate on native clinical facts, never FHIR storage markers. */
import {
  pad,
  normalizeClock,
  getTimeParts,
  getOffset,
  calendarOffsetTransition,
  formatZonedIso,
  makeZonedDate,
  calendarBoundaryDate,
  makeZonedDateFromDay,
  startOfLocalDay,
  addLocalDays,
  addCalendarDaysAtClock,
  calendarDayStepper,
  getLocalWeekday,
  getLocalDayNumber,
  getLocalMonthIndex,
  coerceDate,
  addCalendarMonths,
  toLocalClock,
  TimeParts,
  SECONDS_PER_MINUTE,
} from "./calendar";
import {
  DurationUnit,
  TimingEvent,
  numericAdministrationLimits,
  normalizeQuantityCapUnit,
  hasPeriodLimits,
  measureOperator as getQuantityComparator,
  administrationCondition as getDosageCondition,
  administrationCalendarCondition as getDosageCalendarDayCondition,
  administrationExcludedDates as getDosageExcludedDates,
  administrationExcludedWeekdays as getDosageExcludedWeekdays,
  administrationChoice as getDosageAlternativeChoice,
  courseContextIssue as getCourseContextIssue,
  recurrenceOffset as getExactTimingOffsetMinutes,
  recurrenceActivities as parseActivityTimingExtensions,
  administrationDelay as getAdministrationOffsetMinutes,
  anchoredDuration as getAnchoredCourseDuration,
  recurrenceMonthDays as getTimingMonthDays,
  recurrenceCap as getTimingOccurrenceCap,
  administrationCycleDays as getCycleDayConstraint,
  recurrenceClockWindow as getTimingClockWindow,
  recurrenceEventWindow as getTimingEventWindow,
} from "../canonical/course";
import type {
  CanonicalAdministration,
  CanonicalAmount,
  CanonicalMeasure,
  CanonicalTiming,
  CanonicalRecurrence,
  CanonicalCourse,
  CanonicalStage,
  CanonicalBoundary,
  CanonicalScheduleInput,
  CanonicalSupplyOptions,
} from "../canonical/course";
import type {
  EventClockMap,
  FrequencyFallbackTimes,
  CanonicalOccurrenceCapExpr,
  EstimatedQuantity,
  MealOffsetMap,
  MedicationContext,
  NextDueDoseConfig,
  NextDueDoseOptions,
  TotalUnitsResult,
} from "../types";
import { ChronologicalQueue, type ChronologicalEvent } from "./chronological-queue";
import { arrayIncludes } from "../utils/array";
import { convertValue, getBaseUnitFactor, getUnitCategory } from "../utils/units";
import { parseStrengthIntoRatio } from "../utils/strength";
import { getDoseQuantityUnit } from "../maps";
import { getDoseUnitSemantics } from "../unit-lexicon";

/** A canonical stage array already owns order; only the compatibility array
 * input needs grouping. No retained wire metadata is read by these helpers. */
function courseFromCanonicalRows(rows: readonly CanonicalAdministration[]): CanonicalCourse {
  const groups = new Map<number, CanonicalAdministration[]>();
  for (const row of rows) {
    const sequence = row.stageOrdinal ?? 1;
    if (!Number.isInteger(sequence) || sequence < 1) throw new Error("Invalid FHIR Dosage.sequence");
    let list = groups.get(sequence);
    if (!list) groups.set(sequence, (list = []));
    list.push(row);
  }
  return {
    kind: "course",
    stages: [...groups.keys()].sort((a, b) => a - b).map((key) => ({ administrations: groups.get(key)! })),
  };
}
/**
 * Default institution times used when a dosage only specifies frequency without
 * explicit TimingEvent anchors. Clinics can override these through the
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
    PM: ["20:00"],
  },
  byFrequency: {
    "freq:1/d": ["09:00"],
    "freq:2/d": ["08:00", "20:00"],
    "freq:3/d": ["08:00", "14:00", "20:00"],
    "freq:4/d": ["08:00", "12:00", "16:00", "20:00"],
  },
};
/** Numeric meanings of common institution-clock codes. Reuse one map:
 * this executes for every frequency-only schedule, including supply counts.
 */
const DAILY_FREQUENCY_BY_TIMING_CODE: Readonly<Record<string, number>> = {
  QD: 1,
  AM: 1,
  PM: 1,
  BID: 2,
  TID: 3,
  QID: 4,
};
const MINUTES_PER_DAY = 24 * 60;
const TOTAL_UNITS_PRECISION = 1000000000000;
interface ExpandedTime {
  time: string;
  dayShift: number;
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
  dosage: CanonicalAdministration,
  context: MedicationContext | undefined
): number {
  const doseUnit = dosage.amounts?.[0]?.quantity?.unit;
  if (!doseUnitSupportsPerTargetMultiplication(doseUnit, context)) {
    return 1;
  }
  return dosage.targetCount ?? 1;
}
function isDateAlignedToPeriodCycle(
  candidateDay: Date,
  anchorDay: Date,
  repeat: CanonicalRecurrence,
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
function roundCalculatedUnits(value: number): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  return Math.round((value + Number.EPSILON) * TOTAL_UNITS_PRECISION) / TOTAL_UNITS_PRECISION;
}
function resolveContextStrengthRatio(
  context?: CanonicalSupplyOptions["context"]
): NonNullable<CanonicalSupplyOptions["context"]>["strengthRatio"] | undefined {
  if (!context) {
    return undefined;
  }
  return (
    context.strengthRatio ??
    (context.strength ? parseStrengthIntoRatio(context.strength, context) ?? undefined : undefined)
  );
}
/** Unit conversion requires an actual concentration with both measured
 * endpoints. FHIR's optional Ratio fields are not a valid strength bridge
 * until those numeric/unit facts exist; no unchecked casts or unit guesses. */
function measuredStrengthRatio(
  context?: CanonicalSupplyOptions["context"]
): { numerator: { value: number; unit: string }; denominator: { value: number; unit: string } } | undefined {
  const ratio = resolveContextStrengthRatio(context);
  const numerator = ratio?.numerator, denominator = ratio?.denominator;
  return numerator?.value !== undefined && numerator.unit &&
    denominator?.value !== undefined && denominator.unit
    ? { numerator: { value: numerator.value, unit: numerator.unit },
        denominator: { value: denominator.value, unit: denominator.unit } }
    : undefined;
}
function estimateIngredientQuantity(
  quantity: EstimatedQuantity,
  context?: CanonicalSupplyOptions["context"]
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
        source: quantity.source,
      };
    }
  }
  const converted = convertValue(quantity.value, quantity.unit, numerator.unit, {
    numerator: { value: numerator.value, unit: numerator.unit },
    denominator: { value: denominator.value, unit: denominator.unit },
  });
  if (converted === null) {
    return undefined;
  }
  return {
    value: roundCalculatedUnits(converted),
    unit: numerator.unit,
    confidence: quantity.confidence,
    basis: quantity.basis,
    source: quantity.source,
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
    hour * secondsPerHour +
    minute * SECONDS_PER_MINUTE +
    second +
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
    dayShift,
  };
}
function parseBoundsDurationUnit(quantity: CanonicalMeasure | undefined): DurationUnit | undefined {
  const candidate = quantity?.code?.trim().toLowerCase() ?? quantity?.unit?.trim().toLowerCase();
  switch (candidate) {
    case "s":
    case "sec":
    case "second":
    case "seconds":
      return DurationUnit.Second;
    case "min":
    case "mins":
    case "minute":
    case "minutes":
      return DurationUnit.Minute;
    case "h":
    case "hr":
    case "hrs":
    case "hour":
    case "hours":
      return DurationUnit.Hour;
    case "d":
    case "day":
    case "days":
      return DurationUnit.Day;
    case "wk":
    case "wks":
    case "week":
    case "weeks":
      return DurationUnit.Week;
    case "mo":
    case "month":
    case "months":
      return DurationUnit.Month;
    case "a":
    case "yr":
    case "yrs":
    case "year":
    case "years":
      return DurationUnit.Year;
    default:
      return undefined;
  }
}
function resolveRepeatBoundsStart(
  repeat: Pick<CanonicalRecurrence, "calendarWindow"> | undefined,
  timeZone: string
): Date | null {
  const value = repeat?.calendarWindow?.start;
  if (!value) return null;
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (dateOnly) {
    return calendarBoundaryDate(timeZone, Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]), 0, 0, 0);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function resolveRepeatBoundsEndExclusive(
  repeat: Pick<CanonicalRecurrence, "calendarWindow"> | undefined,
  timeZone: string
): Date | null {
  const value = repeat?.calendarWindow?.end;
  if (!value) return null;
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (dateOnly) {
    const endDay = calendarBoundaryDate(
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
  dosage: Pick<CanonicalAdministration, "anchoredLength" | "schedule">,
  anchor: Date,
  timeZone: string,
  sourceClock?: TreatmentWallClock
): Date | null {
  const repeat = dosage.schedule?.recurrence;
  const retained = getAnchoredCourseDuration(dosage);
  if (!repeat && !retained) return null;
  const durationAnchor = retained ? resolveRepeatBoundsStart(repeat, timeZone) ?? anchor : anchor;
  const advance = (quantity: CanonicalMeasure | undefined): Date | null => {
    // A <=7-day course has a usable upper horizon, unlike a <=7-day
    // recurrence with no single interval. Reuse calendar/elapsed stepping
    // while keeping those two semantic owners explicit and the source intact.
    const capClock = retained && resolveRepeatBoundsStart(repeat, timeZone) ? undefined : sourceClock;
    const result = durationStepper(
      quantity,
      timeZone,
      durationAnchor,
      "upper-bound",
      capClock
    )?.(durationAnchor);
    return result && result > durationAnchor ? result : null;
  };
  // boundsDuration is the more explicit course bound when an imported object
  // happens to contain both choices. For a duration range, the upper bound is
  // the useful maximum-plan horizon; fall back to the lower bound if only it
  // is executable. The original range remains untouched on the dosage.
  const durationEnd = advance(repeat?.courseLength ?? retained?.quantity);
  if (durationEnd) return durationEnd;
  const range = repeat?.courseLengthRange ?? retained?.range;
  return advance(range?.high) ?? advance(range?.low);
}
function validateRepeatBoundsPeriod(
  repeat: CanonicalRecurrence | undefined,
  timeZone: string
): {
  start: Date | null;
  end: Date | null;
} {
  const start = resolveRepeatBoundsStart(repeat, timeZone);
  const end = resolveRepeatBoundsEndExclusive(repeat, timeZone);
  if (repeat?.calendarWindow?.start && !start) throw new Error("Timing.repeat.boundsPeriod.start is invalid");
  if (repeat?.calendarWindow?.end && !end) throw new Error("Timing.repeat.boundsPeriod.end is invalid");
  if (start && end && end <= start) throw new Error("Timing.repeat.boundsPeriod end must be after its start");
  return { start, end };
}
function positiveInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}
function positiveNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}
/**
 * Make an executable copy of imported range timing without changing the
 * preserved FHIR object. Scheduling APIs return timestamps rather than a
 * range, so an unanchored range uses its maximum frequency and shortest valid
 * period. Explicit clocks/event anchors are kept and remain authoritative.
 */
function prepareBestEffortTiming(dosage: CanonicalAdministration): CanonicalAdministration {
  const timing = dosage.schedule;
  const repeat = timing?.recurrence;
  if (!timing || !repeat) return dosage;
  // Keep the ordinary path allocation-free. It is also important not to
  // normalize an explicit zero count into "unlimited": range handling only
  // needs an operational copy when a range is actually present.
  if (repeat.countMax === undefined && repeat.frequencyMax === undefined && repeat.periodMax === undefined)
    return dosage;
  const explicitAnchors = Boolean(
    timing.explicitEvents?.length ||
      repeat.clocks?.length ||
      repeat.anchors?.length ||
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
    ? frequencyMax
    : repeat.frequency;
  const executablePeriod = period ?? periodMax ?? repeat.period;
  const executableCount = countMax && (!count || countMax >= count) ? countMax : repeat.count;
  const nextRepeat: CanonicalRecurrence = {
    ...repeat,
    count: executableCount,
    countMax: undefined,
    frequency: executableFrequency,
    frequencyMax: undefined,
    period: executablePeriod,
    periodMax: undefined,
  };
  return {
    ...dosage,
    schedule: { ...timing, recurrence: nextRepeat },
  };
}
/** A once-daily frequency uses the institution/default administration clock;
 * longer or non-daily intervals remain anchored to the treatment start. */
function usesIntervalCadence(repeat: CanonicalRecurrence): boolean {
  if (!repeat.period || !repeat.periodUnit) return false;
  if (repeat.frequency === undefined) return true;
  if (repeat.frequency !== 1) return false;
  return repeat.periodUnit !== DurationUnit.Day || repeat.period > 1;
}
function calendarScanLimit(start: Date, end: Date | null | undefined, resultLimit: number): number {
  const minimum = Math.max(366, Math.ceil(resultLimit) * 366);
  if (!end) return minimum;
  const spanDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000));
  return Math.max(minimum, spanDays + 3);
}
function resolveDayFilteredSeriesRepeat(
  repeat: CanonicalRecurrence,
  enforceDayFilter: boolean
): CanonicalRecurrence | undefined {
  if (!enforceDayFilter) {
    return undefined;
  }
  if ((repeat.anchors?.length ?? 0) > 0 || (repeat.clocks?.length ?? 0) > 0) {
    return undefined;
  }
  switch (repeat.periodUnit) {
    case DurationUnit.Week:
    case DurationUnit.Month:
    case DurationUnit.Year:
      return repeat.period ? repeat : undefined;
    case undefined:
      return repeat.period === undefined
        ? { ...repeat, period: 1, periodUnit: DurationUnit.Week }
        : undefined;
    default:
      return undefined;
  }
}
interface CalendarDaySelection {
  ordinal?: number;
  dayOfMonth?: readonly number[];
}
const WEEKDAY_TEXT: Readonly<Record<string, string>> = {
  monday: "mon",
  tuesday: "tue",
  wednesday: "wed",
  thursday: "thu",
  friday: "fri",
  saturday: "sat",
  sunday: "sun",
};
/** Resolve typed calendar-day restrictions from grammar or an imported Timing.
 * @param repeat Cadence with month-day membership and optional weekday ordinal.
 * @param anchor Existing recurrence origin used when no weekday ordinal was supplied.
 * @param timeZone Calendar zone for the recurrence origin.
 * @returns The specified day membership and any monthly weekday occurrence.
 */
function resolveCalendarDaySelection(
  repeat: CanonicalRecurrence,
  anchor: Date,
  timeZone: string
): CalendarDaySelection | undefined {
  const dayOfMonth = getTimingMonthDays(repeat);
  const membership = dayOfMonth?.length ? { dayOfMonth } : undefined;
  if (repeat.periodUnit !== DurationUnit.Month || !repeat.dayOfWeek?.length) {
    return membership;
  }
  const value = repeat.weekdayOrdinal;
  if (value === -1 || (value !== undefined && Number.isInteger(value) && value >= 1 && value <= 5))
    return { ...membership, ordinal: value };
  const parts = getTimeParts(anchor, timeZone);
  const nextWeek = addLocalDays(startOfLocalDay(anchor, timeZone), 7, timeZone);
  const isLast = getTimeParts(nextWeek, timeZone).month !== parts.month;
  return { ...membership, ordinal: isLast ? -1 : Math.ceil(parts.day / 7) };
}
/** Match explicit month days and any resolved weekday ordinal.
 * @param date Candidate administration date.
 * @param selection Typed restrictions, absent for an unrestricted calendar.
 * @param timeZone Calendar zone used to read the local day.
 * @returns Whether the candidate satisfies every supplied restriction.
 */
function matchesCalendarDaySelection(
  date: Date,
  selection: CalendarDaySelection | undefined,
  timeZone: string
): boolean {
  if (!selection) return true;
  const parts = getTimeParts(date, timeZone);
  if (selection.dayOfMonth && !arrayIncludes(selection.dayOfMonth, parts.day)) return false;
  if (selection.ordinal === undefined) return true;
  if (selection.ordinal === -1) {
    return getTimeParts(addLocalDays(date, 7, timeZone), timeZone).month !== parts.month;
  }
  return Math.ceil(parts.day / 7) === selection.ordinal;
}
function matchesCalendarDay(
  date: Date,
  dayFilter: Set<string>,
  enforceDayFilter: boolean,
  calendarDays: CalendarDaySelection | undefined,
  timeZone: string
): boolean {
  return (
    (!enforceDayFilter || dayFilter.has(getLocalWeekday(date, timeZone))) &&
    matchesCalendarDaySelection(date, calendarDays, timeZone)
  );
}
function repeatOccurrenceCap(repeat: CanonicalRecurrence): number | undefined {
  const raw = repeat.countMax ?? repeat.count;
  return raw === undefined ? undefined : Math.max(0, Math.floor(raw));
}
/** A declared exact count can end an implicit stage; countMax alone is only
 * a ceiling on possible administrations, not proof that N were completed. */
function hasDefiniteAdministrationCount(
  repeat: CanonicalRecurrence | undefined
): repeat is CanonicalRecurrence & {
  count: number;
} {
  return repeat?.count !== undefined && (repeat.countMax === undefined || repeat.countMax === repeat.count);
}
function isSingleAdministrationRepeat(repeat: CanonicalRecurrence): boolean {
  return (
    repeatOccurrenceCap(repeat) === 1 &&
    repeat.frequency === undefined &&
    repeat.frequencyMax === undefined &&
    repeat.period === undefined &&
    repeat.periodMax === undefined &&
    repeat.periodUnit === undefined &&
    (repeat.dayOfWeek?.length ?? 0) === 0 &&
    (repeat.anchors?.length ?? 0) === 0 &&
    (repeat.clocks?.length ?? 0) === 0
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
  return [TimingEvent.Breakfast, TimingEvent.Lunch, TimingEvent.Dinner];
}
const SPECIFIC_BEFORE_MEALS: Record<string, string> = {
  [TimingEvent["Before Breakfast"]]: TimingEvent.Breakfast,
  [TimingEvent["Before Lunch"]]: TimingEvent.Lunch,
  [TimingEvent["Before Dinner"]]: TimingEvent.Dinner,
};
const SPECIFIC_AFTER_MEALS: Record<string, string> = {
  [TimingEvent["After Breakfast"]]: TimingEvent.Breakfast,
  [TimingEvent["After Lunch"]]: TimingEvent.Lunch,
  [TimingEvent["After Dinner"]]: TimingEvent.Dinner,
};
function signedEventOffset(code: string, offset: number): number {
  if (
    code === TimingEvent["Before Meal"] ||
    code in SPECIFIC_BEFORE_MEALS ||
    code === TimingEvent["Before Sleep"]
  ) {
    return -offset;
  }
  return offset;
}
/**
 * Expands a single TimingEvent code into concrete wall-clock entries.
 */
function expandTiming(code: string, config: NextDueDoseConfig, repeat: CanonicalRecurrence): ExpandedTime[] {
  const mealOffsets: MealOffsetMap = config.mealOffsets ?? {};
  const eventClock = config.eventClock ?? {};
  const exactOffset = getExactTimingOffsetMinutes(repeat);
  const normalized: ExpandedTime[] = [];
  const clockValue = eventClock[code];
  if (clockValue) {
    normalized.push({ time: normalizeClock(clockValue), dayShift: 0 });
  } else if (code === TimingEvent["Before Meal"]) {
    for (const meal of getDefaultMealPairs(config)) {
      const base = eventClock[meal];
      if (!base) {
        continue;
      }
      normalized.push(
        applyOffset(normalizeClock(base), exactOffset !== undefined ? 0 : mealOffsets[code] ?? 0)
      );
    }
  } else if (code === TimingEvent["After Meal"]) {
    for (const meal of getDefaultMealPairs(config)) {
      const base = eventClock[meal];
      if (!base) {
        continue;
      }
      normalized.push(
        applyOffset(normalizeClock(base), exactOffset !== undefined ? 0 : mealOffsets[code] ?? 0)
      );
    }
  } else if (code === TimingEvent.Meal) {
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
      const offset =
        exactOffset !== undefined ? 0 : mealOffsets[code] ?? mealOffsets[TimingEvent["Before Meal"]] ?? 0;
      normalized.push(offset ? applyOffset(baseClock, offset) : { time: baseClock, dayShift: 0 });
    }
  } else if (code in SPECIFIC_AFTER_MEALS) {
    const mealCode = SPECIFIC_AFTER_MEALS[code];
    const base = eventClock[mealCode];
    if (base) {
      const baseClock = normalizeClock(base);
      const offset =
        exactOffset !== undefined ? 0 : mealOffsets[code] ?? mealOffsets[TimingEvent["After Meal"]] ?? 0;
      normalized.push(offset ? applyOffset(baseClock, offset) : { time: baseClock, dayShift: 0 });
    }
  }
  if (exactOffset !== undefined && normalized.length) {
    return normalized.map((entry) => {
      const adjusted = applyOffset(entry.time, signedEventOffset(code, exactOffset ?? 0));
      return {
        time: adjusted.time,
        dayShift: entry.dayShift + adjusted.dayShift,
      };
    });
  }
  return normalized;
}
/** Consolidates TimingEvent arrays into a deduplicated/sorted clock list. */
function expandWhenCodes(
  whenCodes: string[],
  config: NextDueDoseConfig,
  repeat: CanonicalRecurrence
): ExpandedTime[] {
  const entries: ExpandedTime[] = [];
  const seen = new Set<string>();
  for (const code of whenCodes) {
    if (code === TimingEvent.Immediate) {
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
  [TimingEvent.Wake]: ["06:00:00"],
  [TimingEvent["Early Morning"]]: ["06:00:00"],
  [TimingEvent.Morning]: ["08:00:00"],
  [TimingEvent["Late Morning"]]: ["10:00:00"],
  [TimingEvent.Breakfast]: ["08:00:00"],
  [TimingEvent["Before Breakfast"]]: ["07:30:00"],
  [TimingEvent["After Breakfast"]]: ["08:30:00"],
  [TimingEvent.Noon]: ["12:00:00"],
  [TimingEvent.Lunch]: ["12:30:00"],
  [TimingEvent["Before Lunch"]]: ["12:00:00"],
  [TimingEvent["After Lunch"]]: ["13:00:00"],
  [TimingEvent["Early Afternoon"]]: ["14:00:00"],
  [TimingEvent.Afternoon]: ["15:00:00"],
  [TimingEvent["Late Afternoon"]]: ["16:00:00"],
  [TimingEvent["Early Evening"]]: ["18:00:00"],
  [TimingEvent.Evening]: ["19:00:00"],
  [TimingEvent["Late Evening"]]: ["20:00:00"],
  [TimingEvent.Dinner]: ["18:30:00"],
  [TimingEvent["Before Dinner"]]: ["18:00:00"],
  [TimingEvent["After Dinner"]]: ["19:00:00"],
  [TimingEvent.Night]: ["21:00:00"],
  [TimingEvent["Before Sleep"]]: ["22:00:00"],
  [TimingEvent["After Sleep"]]: ["06:30:00"],
  [TimingEvent.Meal]: ["08:00:00", "12:30:00", "18:30:00"],
  [TimingEvent["Before Meal"]]: ["07:30:00", "12:00:00", "18:00:00"],
  [TimingEvent["After Meal"]]: ["08:30:00", "13:00:00", "19:00:00"],
};
function inferWhenFallbackEntries(whenCodes: string[], repeat: CanonicalRecurrence): ExpandedTime[] {
  const entries: ExpandedTime[] = [];
  const seen = new Set<string>();
  const exactOffset = getExactTimingOffsetMinutes(repeat);
  const addClock = (clock: string, code: string) => {
    const normalized = normalizeClock(clock);
    const adjusted =
      exactOffset !== undefined
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
    if (code === TimingEvent.Immediate) {
      continue;
    }
    let fallbackClocks = DEFAULT_WHEN_FALLBACK_CLOCKS[code];
    if (exactOffset !== undefined) {
      if (code === TimingEvent["Before Meal"] || code === TimingEvent["After Meal"]) {
        fallbackClocks = DEFAULT_WHEN_FALLBACK_CLOCKS[TimingEvent.Meal];
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
  timing: CanonicalTiming,
  repeat: CanonicalRecurrence | undefined,
  config: NextDueDoseConfig,
  from: Date,
  orderedAt: Date | null,
  courseEnd: Date | null,
  timeZone: string,
  limit: number,
  priorCount: number,
  derivePriorCount: boolean
): string[] | undefined {
  if (!timing.explicitEvents?.length) return undefined;
  const whenCodes = repeat?.anchors ?? [];
  const expanded = repeat ? expandWhenCodes(whenCodes, config, repeat) : [];
  for (const clock of repeat?.clocks ?? []) {
    expanded.push({ time: normalizeClock(clock), dayShift: 0 });
  }
  if (!expanded.length && repeat && whenCodes.length) {
    expanded.push(...inferWhenFallbackEntries(whenCodes, repeat));
  }
  // Explicit dates already select their occurrences; never infer an ordinal
  // from the query anchor. Apply only the supplied month-day membership here.
  const dayOfMonth = getTimingMonthDays(repeat);
  const calendarDays = dayOfMonth ? { dayOfMonth } : undefined;
  const candidates: Date[] = [];
  for (const value of timing.explicitEvents) {
    const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
    if (dateOnly) {
      const day = calendarBoundaryDate(
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
    if (!matchesCalendarDaySelection(candidate, calendarDays, timeZone)) continue;
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
  const remaining =
    countCap === undefined ? limit : Math.max(0, Math.min(limit, countCap - effectivePriorCount));
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
function resolveFrequencyClocks(timing: CanonicalTiming, config: NextDueDoseConfig): string[] {
  const defaults: Required<FrequencyFallbackTimes> = {
    byCode: {
      ...DEFAULT_FREQUENCY_DEFAULTS.byCode,
      ...(config.frequencyDefaults?.byCode ?? {}),
    },
    byFrequency: {
      ...DEFAULT_FREQUENCY_DEFAULTS.byFrequency,
      ...(config.frequencyDefaults?.byFrequency ?? {}),
    },
  };
  const collected = new Set<string>();
  const code = timing.code?.coding?.find((coding) => coding.code)?.code;
  const normalizedCode = code?.toUpperCase();
  const repeat = timing.recurrence;
  const codeFrequency = normalizedCode ? DAILY_FREQUENCY_BY_TIMING_CODE[normalizedCode] : undefined;
  const liveDailyFrequency =
    repeat?.frequency !== undefined && repeat.period === 1 && repeat.periodUnit === "d"
      ? repeat.frequency
      : undefined;
  const staleDailyCode =
    codeFrequency !== undefined && liveDailyFrequency !== undefined && codeFrequency !== liveDailyFrequency;
  const codeClocks = !staleDailyCode && normalizedCode ? defaults.byCode?.[normalizedCode] : undefined;
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
function recognizedDailyTimingCode(timing: CanonicalTiming): number | undefined {
  const code = timing.code?.coding?.find((coding) => coding.code)?.code?.toUpperCase();
  return code ? DAILY_FREQUENCY_BY_TIMING_CODE[code] : undefined;
}
/** A known daily code and an exact complete repeat both describe the same
 * recurrence. Contradictory external facts have no unique executable cadence. */
function requireConsistentTimingCode(timing: CanonicalTiming | undefined): void {
  const repeat = timing?.recurrence;
  if (!timing?.code || repeat?.frequency === undefined || repeat.period === undefined || !repeat.periodUnit)
    return;
  const daily = recognizedDailyTimingCode(timing);
  if (daily === undefined ||
      (repeat.frequencyMax !== undefined && repeat.frequencyMax !== repeat.frequency) ||
      (repeat.periodMax !== undefined && repeat.periodMax !== repeat.period)) return;
  const seconds = INFUSION_TIME_SECONDS[repeat.periodUnit];
  if (seconds && daily * repeat.period * seconds === repeat.frequency * 86400) return;
  throw new MedicationQuantityCalculationError("timing-code-repeat-conflict",
    "The timing code conflicts with the complete repeat recurrence. Resolve the conflicting schedule before scheduling or calculating supply.");
}
/** An occurrence ceiling without cadence cannot supply actual dose instants.
 * @param dosage Typed dose; explicit events and cadence remain authoritative.
 */
function unscheduledOccurrenceCapacity(
  dosage: CanonicalAdministration
): CanonicalOccurrenceCapExpr | undefined {
  const repeat = dosage.schedule?.recurrence;
  const cap = getTimingOccurrenceCap(repeat);
  return cap &&
    !dosage.schedule?.explicitEvents?.length &&
    !dosage.schedule?.code &&
    !repeat?.clocks?.length &&
    !repeat?.anchors?.length &&
    repeat?.frequency === undefined &&
    repeat?.frequencyMax === undefined &&
    repeat?.period === undefined &&
    repeat?.periodMax === undefined &&
    (dosage.asNeeded || !repeat || !isSingleAdministrationRepeat(repeat))
    ? cap
    : undefined;
}
function occurrenceCapBucketIndex(date: Date, cap: CanonicalOccurrenceCapExpr, timeZone: string): number {
  switch (cap.periodUnit) {
    case DurationUnit.Second:
      return Math.floor(date.getTime() / (cap.period * 1000));
    case DurationUnit.Minute:
      return Math.floor(date.getTime() / (cap.period * 60 * 1000));
    case DurationUnit.Hour:
      return Math.floor(date.getTime() / (cap.period * 60 * 60 * 1000));
    case DurationUnit.Day:
      return Math.floor(getLocalDayNumber(date, timeZone) / cap.period);
    case DurationUnit.Week: {
      const mondayWeek = Math.floor((getLocalDayNumber(date, timeZone) + 3) / 7);
      return Math.floor(mondayWeek / cap.period);
    }
    case DurationUnit.Month:
      return Math.floor(getLocalMonthIndex(date, timeZone) / cap.period);
    case DurationUnit.Year: {
      const { year } = getTimeParts(date, timeZone);
      return Math.floor(year / cap.period);
    }
    default:
      return date.getTime();
  }
}
function occurrenceCapBucketKey(date: Date, cap: CanonicalOccurrenceCapExpr, timeZone: string): string {
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
/** Earliest release of an actual calendar-month/year quantity window.
 * Clamping a long month into a short month and DST can make the cutoff
 * retreat, so a binary search over the whole requested horizon is invalid.
 * Jump directly to the candidate expiry date, then search only monotone
 * pieces separated by civil days and source/target offset transitions. */
function calendarQuantityWindowCuts(
  begin: number, stop: number, cap: CanonicalOccurrenceCapExpr, zone: string
): number[] {
const day = startOfLocalDay(new Date(begin), zone), nextDay = addLocalDays(day, 1, zone);
const cuts = [begin, stop];
  const sourceTransition = calendarOffsetTransition(day, nextDay, zone);
  if (sourceTransition !== undefined && sourceTransition > begin && sourceTransition < stop)
    cuts.push(sourceTransition);
  const target = new Date(quantityCapWindowStart(new Date(begin), cap, zone));
  const targetDay = startOfLocalDay(target, zone), targetNext = addLocalDays(targetDay, 1, zone);
  const targetTransition = calendarOffsetTransition(targetDay, targetNext, zone);
  if (targetTransition !== undefined) {
    // A target gap's shifted clocks jump back at the end of its gap;
    // a target fold has two possible offsets. Place both wall-clock
    // edges into this source day, using both of its actual offsets.
    const before = getTimeParts(new Date(targetTransition - 1), zone);
    const after = getTimeParts(new Date(targetTransition), zone);
    const edges = [before.hour * 3600 + before.minute * 60 + before.second + 1,
      after.hour * 3600 + after.minute * 60 + after.second];
    const source = getTimeParts(day, zone);
    const offsets = [getOffset(day, zone), getOffset(new Date(nextDay.getTime() - 1), zone)];
    for (const edge of edges) for (const offset of offsets) {
      const at = Date.UTC(source.year, source.month - 1, source.day) + edge * 1000 - offset * 60000;
      if (at <= begin || at >= stop) continue;
      const actual = getTimeParts(new Date(at), zone);
      if (actual.year === source.year && actual.month === source.month && actual.day === source.day &&
          actual.hour * 3600 + actual.minute * 60 + actual.second === edge) cuts.push(at);
    }
  }
  cuts.sort((a, b) => a - b);
  return cuts;
}

function calendarQuantityCapRelease(
  from: number, oldest: number, cap: CanonicalOccurrenceCapExpr, end: number, zone: string
): number {
  const months = cap.period * (cap.periodUnit === DurationUnit.Year ? 12 : 1);
  const earliest = addCalendarMonths(new Date(oldest), months, zone);
  let day = startOfLocalDay(new Date(Math.max(from, startOfLocalDay(earliest, zone).getTime())), zone);
  while (day.getTime() < end) {
    const nextDay = addLocalDays(day, 1, zone);
    const begin = Math.max(from, day.getTime()), stop = Math.min(end, nextDay.getTime());
    const cuts = calendarQuantityWindowCuts(begin, stop, cap, zone);
    for (let index = 0; index + 1 < cuts.length; index++) {
      let low = cuts[index], high = cuts[index + 1] - 1;
      if (low > high) continue;
      if (quantityCapWindowStart(new Date(low), cap, zone) >= oldest) return low;
      if (quantityCapWindowStart(new Date(high), cap, zone) < oldest) continue;
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (quantityCapWindowStart(new Date(middle), cap, zone) >= oldest) high = middle;
        else low = middle + 1;
      }
      return low;
    }
    day = nextDay;
  }
  return end;
}

interface SupplyAllocation { at: number; count: number; quantity?: number; quota?: string }
interface SupplyCapacityInterval { start: number; end: number; quota?: string }
interface SupplyCapacityWindow {
  start: number;
  end: number;
  quota?: { id: string; maximum: number; start: number; end: number };
}
function maximumCapacityWithRollingLimits(
  intervals: readonly SupplyCapacityInterval[],
  cap: CanonicalOccurrenceCapExpr,
  quantityCaps: readonly CanonicalOccurrenceCapExpr[],
  priorDoseTimes: CanonicalSupplyOptions["priorDoseTimes"],
  zone: string,
  allocations?: SupplyAllocation[],
  range?: ExecutableDoseRange,
  weightedPrior?: readonly SupplyAllocation[],
  remainingCount = Infinity,
  quotaLimits?: ReadonlyMap<string, number>
): number {
  if (!intervals.length || remainingCount <= 0) return 0;
  let end = intervals[intervals.length - 1].end;
  if (quotaLimits) for (const interval of intervals) end = Math.max(end, interval.end);
  const prior: SupplyAllocation[] = (priorDoseTimes ?? []).map((value) => ({
    at: coerceDate(value, "priorDoseTimes").getTime(),
    count: 1,
  }));
  if (weightedPrior?.length) prior.push(...weightedPrior);
  const allocated: SupplyAllocation[] = allocations ?? [];
  const used = new Map<number, number>();
  for (const item of prior) {
    const bucket = occurrenceCapBucketIndex(new Date(item.at), cap, zone);
    used.set(bucket, (used.get(bucket) ?? 0) + item.count);
  }
  const firstInstant = (from: number, fits: (at: number) => boolean): number => {
    if (!fits(end - 1)) return end;
    let lo = from,
      hi = end - 1;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (fits(mid)) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  let count = 0;
  const quotaUsed = quotaLimits ? new Map<string, number>() : undefined;
  let at = intervals[0].start;
  for (const interval of intervals) {
    at = Math.max(at, interval.start);
    while (at < interval.end && count < remainingCount) {
      const bucket = occurrenceCapBucketIndex(new Date(at), cap, zone);
      const quotaRoom = interval.quota === undefined ? Infinity
        : (quotaLimits?.get(interval.quota) ?? Infinity) - (quotaUsed?.get(interval.quota) ?? 0);
      if (quotaRoom <= 0) break;
      let room = Math.min(cap.max - (used.get(bucket) ?? 0), remainingCount - count, quotaRoom);
      if (room <= 0) {
        at = firstInstant(at + 1, (value) => occurrenceCapBucketIndex(new Date(value), cap, zone) > bucket);
        continue;
      }
      let release = at, quantityRoom = Number.POSITIVE_INFINITY;
      for (const limit of quantityCaps) {
        const first = quantityCapWindowStart(new Date(at), limit, zone);
        let occupied = 0,
          oldest = Number.POSITIVE_INFINITY;
        for (const history of [prior, allocated]) {
          for (const item of history) {
            if (item.at > first && item.at <= at) {
              occupied += range ? item.quantity ?? item.count * range.high : item.count;
              oldest = Math.min(oldest, item.at);
            }
          }
        }
        const available = Math.max(0, limit.max - occupied);
        if (range) {
          quantityRoom = Math.min(quantityRoom, available);
          room = Math.min(room, available > 0
            ? range.low > 0
              ? range.strictLow ? Math.ceil(available / range.low) - 1 : Math.floor(available / range.low + 1e-9)
              : room : 0);
        } else room = Math.min(room, available);
        if (range ? !rangeDoseFits(available, range) : occupied >= limit.max) {
          release = Math.max(
            release,
            limit.periodUnit === DurationUnit.Month || limit.periodUnit === DurationUnit.Year
              ? calendarQuantityCapRelease(at + 1, oldest, limit, end, zone)
              : firstInstant(at + 1, (value) => quantityCapWindowStart(new Date(value), limit, zone) >= oldest)
          );
        }
      }
      if (room <= 0) {
        at = Math.max(at + 1, release);
      } else {
        const quantity = range ? Math.min(room * range.high, quantityRoom) : undefined;
        // Use the fewest administrations that deliver this maximum amount.
        // Spending two one-tablet slots instead of one two-tablet slot can
        // wrongly prevent a later dose when a shorter rolling cap expires.
        const taken = quantity === undefined ? room : Math.min(room, Math.ceil(quantity / range!.high - 1e-9));
        allocated.push({ at, count: taken, ...(quantity === undefined ? {} : { quantity }),
          ...(interval.quota === undefined ? {} : { quota: interval.quota }) });
        if (interval.quota !== undefined) quotaUsed?.set(interval.quota, (quotaUsed.get(interval.quota) ?? 0) + taken);
        count += taken;
        used.set(bucket, (used.get(bucket) ?? 0) + taken);
      }
    }
  }
  return count;
}
/** This search is restricted to untimed ranged supply with interacting
 * occurrence/quantity allowances. Ordinary schedules and scalar doses never
 * enter it. Cheap attainable bounds handle common long-horizon capacity. */
const MAX_CAPACITY_SLOTS = 32;
const MAX_CAPACITY_STATES = 50000;
function capacityComplexity(): never {
  throw new MedicationQuantityCalculationError("ranged-capacity-complexity",
    "The ranged dose and interacting quantity/use limits exceed the exact supply planner's 32-slot or 50,000-state bound. Use a shorter supply window or provide a resolved per-administration quantity; the original constraints remain retained.");
}
interface QuantityDifferenceEdge { from: number; to: number; value: number; strict?: boolean }
function fixedCapacityQuantities(
  times: readonly number[], caps: readonly CanonicalOccurrenceCapExpr[],
  prior: readonly SupplyAllocation[], range: ExecutableDoseRange, zone: string, objectiveStart = 0
): { quantity: number; values: number[]; attained: boolean } | undefined {
  const edges: QuantityDifferenceEdge[] = [];
  for (let index = 1; index <= times.length; index++) {
    edges.push({ from: index - 1, to: index, value: range.high, strict: range.strictHigh });
    edges.push({ from: index, to: index - 1, value: -range.low, strict: range.strictLow });
    for (const cap of caps) {
      const since = quantityCapWindowStart(new Date(times[index - 1]), cap, zone);
      let first = 0;
      while (first < index && times[first] <= since) first++;
      let used = 0;
      for (const item of prior) if (item.at > since && item.at <= times[index - 1])
        used += item.quantity ?? item.count * range.high;
      edges.push({ from: first, to: index, value: cap.max - used });
    }
  }
  // Prefix sums turn all rolling quantities and per-dose endpoints into
  // difference inequalities. The shortest path from the query prefix fixes
  // its largest feasible remaining sum; a negative cycle means these event slots cannot fit.
  const solve = (strict: boolean, objective?: number) => {
    const graph = objective === undefined ? edges :
      [...edges, { from: times.length, to: objectiveStart, value: -objective }];
    const values = new Array<number>(times.length + 1).fill(Infinity);
    const infinitesimal = new Array<number>(times.length + 1).fill(0);
    values[objectiveStart] = 0;
    for (let pass = 0; pass <= times.length; pass++) {
      let changed = false;
      for (const edge of graph) {
        if (!Number.isFinite(values[edge.from])) continue;
        const candidate = values[edge.from] + edge.value;
        const epsilon = infinitesimal[edge.from] - (strict && edge.strict ? 1 : 0);
        const delta = candidate - values[edge.to];
        if (delta < -1e-10 || (Math.abs(delta) <= 1e-10 && epsilon < infinitesimal[edge.to])) {
          values[edge.to] = candidate; infinitesimal[edge.to] = epsilon; changed = true;
        }
      }
      if (!changed) return { values, infinitesimal, graph };
      if (pass === times.length) return undefined;
    }
    return undefined;
  };
  const closed = solve(false);
  if (!closed) return undefined;
  const quantity = closed.values[times.length];
  if (!range.strictLow && !range.strictHigh) return { quantity, attained: true,
    values: times.map((_, i) => closed.values[i + 1] - closed.values[i]) };
  if (!solve(true)) return undefined;
  const exact = solve(true, quantity);
  if (!exact) return { quantity, values: [], attained: false };
  // Choose a real positive perturbation satisfying every strict edge while
  // retaining the exact objective, rather than treating >low as >=low.
  let epsilon = Math.max(1, range.high) * 1e-7;
  for (const edge of exact.graph) {
    const slack = edge.value - (exact.values[edge.to] - exact.values[edge.from]);
    const coefficient = exact.infinitesimal[edge.to] - exact.infinitesimal[edge.from];
    if (slack > 1e-10 && coefficient > 0) epsilon = Math.min(epsilon, slack / (coefficient + 1) / 2);
  }
  const values = times.map((_, index) =>
    exact.values[index + 1] - exact.values[index] +
    epsilon * (exact.infinitesimal[index + 1] - exact.infinitesimal[index]));
  return { quantity, values, attained: true };
}
function elapsedCapMilliseconds(cap: CanonicalOccurrenceCapExpr): number | undefined {
  switch (cap.periodUnit) {
    case DurationUnit.Second: return cap.period * 1000;
    case DurationUnit.Minute: return cap.period * 60000;
    case DurationUnit.Hour: return cap.period * 3600000;
    case DurationUnit.Day: return cap.period * 86400000;
    case DurationUnit.Week: return cap.period * 604800000;
    default: return undefined;
  }
}
function maximumRangedCapacity(
  intervals: readonly SupplyCapacityInterval[], cap: CanonicalOccurrenceCapExpr,
  quantityCaps: readonly CanonicalOccurrenceCapExpr[], priorDoseTimes: CanonicalSupplyOptions["priorDoseTimes"],
  zone: string, allocations: SupplyAllocation[], range: ExecutableDoseRange,
  weightedPrior: readonly SupplyAllocation[] | undefined, slotBudget: number,
  quotaLimits?: ReadonlyMap<string, number>
): number {
  const sum = (plan: readonly SupplyAllocation[]) => plan.reduce((value, item) => value +
    (item.quantity ?? item.count * range.high), 0);
  const greedyAttained = !range.strictHigh || allocations.every(item =>
    (item.quantity ?? item.count * range.high) < item.count * range.high);
  let bestQuantity = greedyAttained ? sum(allocations) : 0;
  let best = greedyAttained ? allocations.slice() : [];
  const from = intervals[0]?.start;
  let end = intervals[intervals.length - 1]?.end;
  if (from === undefined || end === undefined || slotBudget <= 0) return 0;
  if (quotaLimits) for (const interval of intervals) end = Math.max(end, interval.end);
  let upper = slotBudget * range.high;
  for (const limit of quantityCaps) {
    const width = elapsedCapMilliseconds(limit);
    if (width) {
      const blocks = Math.ceil((end - from) / width);
      upper = Math.min(upper, blocks * limit.max);
      if (range.low > 0) slotBudget = Math.min(slotBudget, blocks *
        (range.strictLow ? Math.ceil(limit.max / range.low) - 1 : Math.floor(limit.max / range.low + 1e-9)));
    }
  }
  upper = Math.min(upper, slotBudget * range.high);
  if (bestQuantity >= upper - 1e-9) return best.reduce((n, item) => n + item.count, 0);
  if (slotBudget > MAX_CAPACITY_SLOTS) capacityComplexity();
  const prior: SupplyAllocation[] = (priorDoseTimes ?? []).map(value => ({
    at: coerceDate(value, "priorDoseTimes").getTime(), count: 1, quantity: range.high,
  }));
  if (weightedPrior?.length) prior.push(...weightedPrior);
  const priorByBucket = new Map<number, number>();
  for (const item of prior) {
    const key = occurrenceCapBucketIndex(new Date(item.at), cap, zone);
    priorByBucket.set(key, (priorByBucket.get(key) ?? 0) + item.count);
  }
  const eligible = (at: number) => intervals.some(interval => at >= interval.start && at < interval.end);
  const base = new Set<number>();
  let states = 0;
  const spend = () => { if (++states > MAX_CAPACITY_STATES) capacityComplexity(); };
  for (const interval of intervals) {
    base.add(interval.start);
    let at = interval.start;
    while (at < interval.end) {
      spend();
      const bucket = occurrenceCapBucketIndex(new Date(at), cap, zone);
      if (occurrenceCapBucketIndex(new Date(interval.end - 1), cap, zone) === bucket) break;
      let low = at + 1, high = interval.end - 1;
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (occurrenceCapBucketIndex(new Date(middle), cap, zone) > bucket) high = middle;
        else low = middle + 1;
      }
      base.add(low); at = low;
    }
  }
  const expiries = (oldest: number, out: Set<number>) => {
    for (const limit of quantityCaps) {
      const width = elapsedCapMilliseconds(limit);
      if (width) {
        const at = oldest + width;
        if (eligible(at)) out.add(at);
      } else {
        // A calendar cutoff can release, re-include, and release the same
        // history again. Enumerate every civil/offset monotone piece.
        for (const interval of intervals) {
          const cuts = calendarQuantityWindowCuts(interval.start, interval.end, limit, zone);
          for (let index = 0; index + 1 < cuts.length; index++) {
            spend();
            let low = cuts[index], high = cuts[index + 1] - 1;
            out.add(low);
            if (quantityCapWindowStart(new Date(high), limit, zone) < oldest) continue;
            while (low < high) {
              const middle = low + Math.floor((high - low) / 2);
              if (quantityCapWindowStart(new Date(middle), limit, zone) >= oldest) high = middle;
              else low = middle + 1;
            }
            out.add(low);
          }
        }
      }
    }
  };
  for (const item of prior) expiries(item.at, base);
  let supremum = bestQuantity;
  const times: number[] = [], used = new Map<number, number>();
  const chosenQuotas: Array<string | undefined> = [], usedQuotas = new Map<string, number>();
  const eligibleQuotas = (at: number): Array<string | undefined> => {
    if (!quotaLimits) return [undefined];
    const choices = new Set<string | undefined>();
    for (const interval of intervals) if (at >= interval.start && at < interval.end) choices.add(interval.quota);
    return Array.from(choices);
  };
  const explore = (candidates: readonly number[]): void => {
    if (bestQuantity >= upper - 1e-9 || times.length >= slotBudget) return;
    const minimum = times.length ? times[times.length - 1] : from;
    for (const at of candidates) {
      if (at < minimum) continue;
      spend();
      const bucket = occurrenceCapBucketIndex(new Date(at), cap, zone);
      if ((used.get(bucket) ?? 0) + (priorByBucket.get(bucket) ?? 0) >= cap.max) continue;
      for (const quota of eligibleQuotas(at)) {
        if (quotaLimits) spend();
        const quotaCount = quota === undefined ? 0 : usedQuotas.get(quota) ?? 0;
        if (quota !== undefined && quotaCount >= (quotaLimits?.get(quota) ?? Infinity)) continue;
        times.push(at); chosenQuotas.push(quota);
        const plan = fixedCapacityQuantities(times, quantityCaps, prior, range, zone);
        if (plan) {
          supremum = Math.max(supremum, plan.quantity);
          if (plan.attained && plan.quantity > bestQuantity + 1e-9) {
            bestQuantity = plan.quantity;
            best = [];
            for (let index = 0; index < times.length; index++) if (plan.values[index] > 0)
              best.push({ at: times[index], count: 1, quantity: plan.values[index],
                ...(chosenQuotas[index] === undefined ? {} : { quota: chosenQuotas[index] }) });
          }
          if (times.length < slotBudget && plan.quantity + (slotBudget - times.length) * range.high > bestQuantity + 1e-9) {
            used.set(bucket, (used.get(bucket) ?? 0) + 1);
            if (quota !== undefined) usedQuotas.set(quota, quotaCount + 1);
            const next = new Set(candidates);
            expiries(at, next);
            explore(Array.from(next).sort((a, b) => a - b));
            used.set(bucket, used.get(bucket)! - 1);
            if (quota !== undefined) usedQuotas.set(quota, quotaCount);
          }
        }
        times.pop(); chosenQuotas.pop();
        if (bestQuantity >= upper - 1e-9) return;
      }
    }
  };
  explore(Array.from(base).sort((a, b) => a - b));
  if (supremum > bestQuantity + 1e-9)
    throw new MedicationQuantityCalculationError("ranged-capacity-open-maximum",
      "These strict dose endpoints have a finite supply supremum but no attainable maximum. Provide a resolved per-administration quantity or a closed dose range before calculating supply; all source constraints remain retained.");
  allocations.splice(0, allocations.length, ...best);
  return best.reduce((n, item) => n + item.count, 0);
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
  dosage: CanonicalAdministration,
  cap: CanonicalOccurrenceCapExpr,
  from: Date,
  end: Date,
  options: CanonicalSupplyOptions,
  timeZone: string,
  quantityCaps: readonly CanonicalOccurrenceCapExpr[] = [],
  allocations?: SupplyAllocation[],
  range?: ExecutableDoseRange,
  weightedPrior?: readonly SupplyAllocation[],
  activeWindows?: readonly SupplyCapacityWindow[]
): number {
  if (from >= end) return 0;
  const repeat = dosage.schedule?.recurrence;
  const allowed = new Set((repeat?.dayOfWeek ?? []).map((day) => day.toLowerCase()));
  const excluded = new Set<string>(getDosageExcludedWeekdays(dosage));
  const dates = new Set(getDosageExcludedDates(dosage));
  const dayCondition = getDosageCalendarDayCondition(dosage);
  const ranges: Array<{
    first: number;
    last: number;
  }> = [];
  const intervals: SupplyCapacityInterval[] = [];
  let quotaLimits: Map<string, number> | undefined;
  for (const window of activeWindows ?? [{ start: +from, end: +end }]) {
    const quota = window.quota;
    if (quota && !quotaLimits?.has(quota.id)) {
      let used = 0;
      for (const stamp of options.priorDoseTimes ?? []) {
        const at = coerceDate(stamp, "priorDoseTimes").getTime();
        if (at >= quota.start && at < quota.end) used++;
      }
      for (const allocation of weightedPrior ?? []) if (allocation.quota === quota.id) used += allocation.count;
      (quotaLimits ??= new Map()).set(quota.id, Math.max(0, quota.maximum - used));
    }
    const begin = new Date(Math.max(+from, window.start));
    const stopAt = new Date(Math.min(+end, window.end));
    const ordinal = repeat ? resolveCalendarDaySelection(repeat, begin, timeZone) : undefined;
    let day = startOfLocalDay(begin, timeZone);
    while (day < stopAt) {
      const next = addLocalDays(day, 1, timeZone);
      if (
        matchesCalendarDay(day, allowed, allowed.size > 0, ordinal, timeZone) &&
        !excluded.has(getLocalWeekday(day, timeZone)) &&
        !dates.has(formatZonedIso(day, timeZone).slice(0, 10)) &&
        (!dayCondition ||
          !options.evaluateCondition ||
          options.evaluateCondition(dayCondition, formatZonedIso(new Date(Math.max(+begin, +day)), timeZone)) !==
            false)
      ) {
        const start = Math.max(+begin, +day),
          stop = Math.min(+stopAt, +next);
        if (quantityCaps.length || allocations) {
          const previous = intervals[intervals.length - 1];
          if (activeWindows && previous && previous.quota === quota?.id && previous.end >= start)
            previous.end = Math.max(previous.end, stop);
          else intervals.push({ start, end: stop, ...(quota ? { quota: quota.id } : {}) });
        }
        const first = occurrenceCapBucketIndex(new Date(start), cap, timeZone);
        const last = occurrenceCapBucketIndex(new Date(stop - 1), cap, timeZone);
        const previous = ranges[ranges.length - 1];
        if (previous && first <= previous.last + 1) previous.last = Math.max(previous.last, last);
        else ranges.push({ first, last });
      }
      day = next;
    }
  }
  const total = repeat ? repeatOccurrenceCap(repeat) : undefined;
  const remaining = total === undefined ? Infinity
    : Math.max(0, total - Math.floor(options.priorCount ?? options.priorDoseTimes?.length ?? 0));
  if (quantityCaps.length || allocations) {
    const packed = allocations ?? [];
    const count = maximumCapacityWithRollingLimits(
      intervals, cap, quantityCaps, options.priorDoseTimes, timeZone, packed, range, weightedPrior, remaining, quotaLimits
    );
    if (!range || !quantityCaps.length || (range.low === range.high && !quotaLimits)) return count;
    let possibleSlots = ranges.reduce((total, range) => total + (range.last - range.first + 1) * cap.max, 0);
    if (options.priorDoseTimes?.length || weightedPrior?.length) {
      const used = new Map<number, number>();
      const record = (at: number, count: number) => {
        const bucket = occurrenceCapBucketIndex(new Date(at), cap, timeZone);
        if (ranges.some(range => range.first <= bucket && bucket <= range.last))
          used.set(bucket, (used.get(bucket) ?? 0) + count);
      };
      for (const value of options.priorDoseTimes ?? []) record(coerceDate(value, "priorDoseTimes").getTime(), 1);
      for (const item of weightedPrior ?? []) record(item.at, item.count);
      for (const count of used.values()) possibleSlots -= Math.min(cap.max, count);
    }
    let quotaSlots = Infinity;
    if (quotaLimits && intervals.every(interval => interval.quota !== undefined)) {
      quotaSlots = 0;
      for (const remaining of quotaLimits.values()) quotaSlots += remaining;
    }
    const slotBudget = Math.min(remaining, possibleSlots, quotaSlots);
    return maximumRangedCapacity(intervals, cap, quantityCaps, options.priorDoseTimes,
      timeZone, packed, range, weightedPrior, slotBudget, quotaLimits);

  }
  let count = ranges.reduce((total, range) => total + (range.last - range.first + 1) * cap.max, 0);
  const used = new Map<number, number>();
  for (const at of options.priorDoseTimes ?? []) {
    const bucket = occurrenceCapBucketIndex(coerceDate(at, "priorDoseTimes"), cap, timeZone);
    if (ranges.some((range) => range.first <= bucket && bucket <= range.last)) {
      used.set(bucket, (used.get(bucket) ?? 0) + 1);
    }
  }
  for (const value of used.values()) count -= Math.min(cap.max, value);
  return Math.min(remaining, Math.max(0, count));
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
function isQuantityCapPeriodUnit(unit: string | undefined): boolean {
  switch (unit) {
    case "s": case "min": case "h": case "d":
    case "wk": case "mo": case "a": return true;
    default: return false;
  }
}
/** A rate-only infusion has a measurable PER-ADMINISTRATION quantity only
 * when its authored infusion duration resolves against the rate's time unit.
 * This conversion is shared by supply and the chronological cap ledger:
 * scheduling never guesses a quantity from a bare rate or unknown duration.
 * Regular scalar tablet/drop paths never invoke the rate calculation. */
const INFUSION_TIME_SECONDS: Readonly<Record<string, number>> = {
  s: 1, min: 60, h: 3600, d: 86400, wk: 604800,
};
/** A positive quotient reverses the denominator's inequality. Two qualified
 * inputs determine a single bound only when their resulting directions agree. */
function measuredRateComparator(
  numerator: CanonicalMeasure["comparator"],
  denominator: CanonicalMeasure["comparator"]
): CanonicalMeasure["comparator"] {
  const inverse = denominator === "<" ? ">" : denominator === "<=" ? ">="
    : denominator === ">" ? "<" : denominator === ">=" ? "<=" : denominator;
  if (!numerator) return inverse;
  if (!inverse) return numerator;
  if (numerator === "~" && inverse === "~") return "~";
  if (numerator[0] === "<" && inverse[0] === "<")
    return numerator === "<" || inverse === "<" ? "<" : "<=";
  if (numerator[0] === ">" && inverse[0] === ">")
    return numerator === ">" || inverse === ">" ? ">" : ">=";
  throw new MedicationQuantityCalculationError("rate-ratio-bound-unresolved",
    "The rate ratio's quantity bounds do not determine a usable dose bound. Retain the ratio and supply the applicable rate before calculating.");
}
function measuredRateQuantity(
  amount: CanonicalAmount,
  recurrence: CanonicalRecurrence | undefined
): CanonicalMeasure | undefined {
  const duration = recurrence?.occurrenceDuration;
  const durationUnit = recurrence?.occurrenceDurationUnit;
  const seconds = durationUnit ? INFUSION_TIME_SECONDS[durationUnit] : undefined;
  if (duration === undefined || !Number.isFinite(duration) || duration <= 0 || !seconds)
    return undefined;
  let value: number | undefined;
  let unit: string | undefined;
  let code: string | undefined, system: string | undefined;
  let comparator: CanonicalMeasure["comparator"];
  if (amount.rate?.value !== undefined) {
    // The UCUM code owns a coded rate's dimension; the display label may
    // be absent or localized. Uncoded authoring retains its unit-label path.
    const rateUnit = amount.rate.system === "http://unitsofmeasure.org"
      ? amount.rate.code ?? amount.rate.unit : amount.rate.unit ?? amount.rate.code;
    const match = rateUnit?.match(/^(.+?)\/(s|min|h|d|wk)$/i);
    const per = match ? INFUSION_TIME_SECONDS[match[2].toLowerCase()] : undefined;
    if (per) {
      value = amount.rate.value * duration * seconds / per;
      unit = match![1];
      comparator = amount.rate.comparator;
    }
  } else if (
    amount.rateRatio?.numerator?.value !== undefined &&
    amount.rateRatio.denominator?.value !== undefined
  ) {
    const numerator = amount.rateRatio.numerator;
    const denominator = amount.rateRatio.denominator;
    const per = INFUSION_TIME_SECONDS[(denominator.code ?? denominator.unit ?? "").toLowerCase()];
    if (per && denominator.value! > 0) {
      value = (numerator.value! / denominator.value!) * duration * seconds / per;
      unit = numerator.unit ?? numerator.code;
      code = numerator.code;
      system = numerator.system;
      comparator = measuredRateComparator(numerator.comparator, denominator.comparator);
    }
  }
  if (value === undefined || !Number.isFinite(value) || value <= 0 || !unit)
    return undefined;
  return { value, unit, ...(code ? { code } : {}), ...(system ? { system } : {}),
    ...(comparator ? { comparator } : {}) };
}
function executableQuantityCaps(
  dosage: CanonicalAdministration,
  context?: MedicationContext,
  asQuantity = false
): CanonicalOccurrenceCapExpr[] {
  const limits = dosage.limits ?? [];
  if (!limits.length) return [];
  const doseRates = dosage.amounts ?? [];
  const first = doseRates.length === 1 ? doseRates[0] : undefined;
  const dose = first?.quantity ??
    (first && !first.expression && !first.rateExpression &&
      (first.rate || first.rateRatio)
      ? measuredRateQuantity(first, dosage.schedule?.recurrence) : undefined);
  const doseOperator = getQuantityComparator(dose);
  // Approximate amounts deliberately use their authored nominal values.
  // An inequality does not determine a unique dose-count conversion.
  if (
    !dose ||
    (doseOperator && doseOperator !== "~" &&
      !(asQuantity && (doseOperator === "<" || doseOperator === "<="))) ||
    !dose.value ||
    !Number.isFinite(dose.value) ||
    dose.value <= 0
  ) {
    return [];
  }
  const caps: CanonicalOccurrenceCapExpr[] = [];
  for (const limit of limits) {
    if (limit.scope !== "period" || limit.expression) continue;
    const numerator = limit.amount,
      denominator = limit.period;
    const maximum = numerator?.value;
    const period = denominator?.value;
    const periodUnit = denominator?.code ?? denominator?.unit;
    const maximumOperator = getQuantityComparator(numerator);
    const periodOperator = getQuantityComparator(denominator);
    // EMA and native operators have identical meaning. A qualified window
    // like >=2 days is not a known two-day rolling ceiling; preserve it
    // unevaluated, while returning the other known supply information.
    if (
      (maximumOperator && maximumOperator !== "~") ||
      (periodOperator && periodOperator !== "~") ||
      maximum === undefined ||
      !Number.isFinite(maximum) ||
      maximum < 0 ||
      period === undefined ||
      !Number.isInteger(period) ||
      period <= 0 ||
      !isQuantityCapPeriodUnit(periodUnit)
    ) {
      continue;
    }
    const actualUnit = getDoseQuantityUnit(dose);
    const maximumUnit = getDoseQuantityUnit(numerator);
    const normalizedActual = normalizeQuantityCapUnit(actualUnit);
    const normalizedMaximum = normalizeQuantityCapUnit(maximumUnit);
    const perTargetDose =
      normalizedActual === normalizedMaximum ? dose.value : convertValue(dose.value, actualUnit, maximumUnit, measuredStrengthRatio(context));
    if (perTargetDose === null || !Number.isFinite(perTargetDose) || perTargetDose <= 0) {
      continue;
    }
    const equivalentDose = perTargetDose * getAdministrationTargetMultiplier(dosage, context);
    const max = asQuantity ? maximum / equivalentDose * dose.value
      : Math.floor(maximum / equivalentDose + 1e-9);
    // A stated ceiling below the authored dose is contradictory. Preserve
    // the clinician's editable schedule rather than turning a suggestion
    // conflict into a universal zero-dose veto; supply will retain the
    // unevaluable limit as a maximum instead.
    if (asQuantity ? max <= 0 : max < 1) continue;
    caps.push({ max, period, periodUnit: periodUnit as DurationUnit });
  }
  return caps;
}
interface ExecutableDoseRange {
  low: number;
  high: number;
  strictLow: boolean;
  strictHigh: boolean;
  multiplier: number;
  caps: CanonicalOccurrenceCapExpr[];
}
/** Only a supply projection contains both a range and its selected numeric
 * quantity. Keep real amounts in the ledger for this path: a 1–2 tablet
 * range with a 3-tablet ceiling can admit 2+1, not merely one 2-tablet dose. */
function executableDoseRange(
  dosage: CanonicalAdministration, context?: MedicationContext
): ExecutableDoseRange | undefined {
  const amount = dosage.amounts?.length === 1 ? dosage.amounts[0] : undefined;
  const range = amount?.range, high = amount?.quantity;
  if (!range || !high?.value || !range.high?.value) return undefined;
  const highOperator = getQuantityComparator(high);
  if (highOperator && highOperator !== "~" && highOperator !== "<=" && highOperator !== "<") return undefined;
  const unit = getDoseQuantityUnit(high), lowUnit = getDoseQuantityUnit(range.low);
  const low = range.low?.value === undefined ? 0
    : normalizeQuantityCapUnit(unit) === normalizeQuantityCapUnit(lowUnit)
      ? range.low.value : convertValue(range.low.value, lowUnit, unit, measuredStrengthRatio(context));
  if (low === null || !Number.isFinite(low) || low < 0 || low > high.value) return undefined;
  const strictLow = range.low?.comparator === ">";
  const caps = executableQuantityCaps(dosage, context, true).filter(cap =>
    strictLow ? cap.max > low : cap.max >= low);
  if (!caps.length) return undefined;
  return { low, high: high.value, strictLow, strictHigh: highOperator === "<",
    multiplier: getAdministrationTargetMultiplier(dosage, context), caps };
}
function rangeDoseFits(value: number, range: ExecutableDoseRange): boolean {
  return value > 0 && (range.strictLow ? value > range.low : value + 1e-9 >= range.low);
}
/** Start of the existing rolling medication-quantity window at a hypothetical instant. */
function quantityCapWindowStart(at: Date, cap: CanonicalOccurrenceCapExpr, zone: string): number {
  const quantity = cap.period;
  switch (cap.periodUnit) {
    case DurationUnit.Second:
      return at.getTime() - quantity * 1000;
    case DurationUnit.Minute:
      return at.getTime() - quantity * 60000;
    case DurationUnit.Hour:
      return at.getTime() - quantity * 3600000;
    case DurationUnit.Day:
      return at.getTime() - quantity * 86400000;
    case DurationUnit.Week:
      return at.getTime() - quantity * 7 * 86400000;
    case DurationUnit.Month:
      return addCalendarMonths(at, -quantity, zone).getTime();
    case DurationUnit.Year:
      return addCalendarMonths(at, -quantity * 12, zone).getTime();
    default:
      throw new Error("Unsupported maximum dose interval");
  }
}
/** A clamped month/year cutoff can return to an earlier clock within its
 * target civil day. That day's boundary is a safe history-retirement floor. */
function quantityCapHistoryFloor(at: Date, cap: CanonicalOccurrenceCapExpr, zone: string): number {
  const start = quantityCapWindowStart(at, cap, zone);
  return cap.periodUnit === DurationUnit.Month || cap.periodUnit === DurationUnit.Year
    ? startOfLocalDay(new Date(start), zone).getTime() : start;
}
function applyQuantityCaps(
  candidates: string[],
  caps: readonly CanonicalOccurrenceCapExpr[],
  priorDoseTimes: Array<Date | string> | undefined,
  zone: string,
  limit: number,
  occurrence?: CanonicalOccurrenceCapExpr
): string[] {
  if (!caps.length) return occurrence
    ? applyOccurrenceCap(candidates, occurrence, priorDoseTimes, zone, limit)
    : candidates.slice(0, Math.floor(limit));
  // R5 Dosage.maxDosePerPeriod means a maximum QUANTITY in a duration.
  // It is not a calendar-midnight reset: two 2-tablet administrations
  // before midnight must not license another 4 tablets after midnight.
  const prior = (priorDoseTimes ?? [])
    .map((time) => coerceDate(time, "priorDoseTimes").getTime())
    .sort((a, b) => a - b);
  const accepted: string[] = [];
  const acceptedTimes: number[] = [];
  // All constraints admit the SAME candidate before either allowance is
  // consumed. A rolling-quantity rejection cannot spend the calendar-period
  // occurrence allowance and thereby hide a later eligible administration.
  const occurrenceCounts = occurrence ? new Map<string, number>() : undefined;
  if (occurrence && occurrenceCounts) {
    for (const timestamp of prior) {
      const key = occurrenceCapBucketKey(new Date(timestamp), occurrence, zone);
      occurrenceCounts.set(key, (occurrenceCounts.get(key) ?? 0) + 1);
    }
  }
  const after = (sorted: readonly number[], boundary: number) => {
    let lo = 0,
      hi = sorted.length;
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
    const occurrenceKey = occurrence ? occurrenceCapBucketKey(at, occurrence, zone) : undefined;
    if (occurrenceKey !== undefined && occurrence &&
        (occurrenceCounts!.get(occurrenceKey) ?? 0) >= occurrence.max) continue;
    const fitsEveryCap = caps.every((cap) => {
      const first = quantityCapWindowStart(at, cap, zone);
      const existing = after(prior, timestamp) - after(prior, first);
      const upcoming = after(acceptedTimes, timestamp) - after(acceptedTimes, first);
      return existing + upcoming < cap.max;
    });
    if (!fitsEveryCap) continue;
    accepted.push(iso);
    acceptedTimes.push(timestamp);
    if (occurrenceKey !== undefined)
      occurrenceCounts!.set(occurrenceKey, (occurrenceCounts!.get(occurrenceKey) ?? 0) + 1);
    if (accepted.length >= limit) break;
  }
  return accepted;
}
function withoutOccurrenceCap(dosage: CanonicalAdministration): CanonicalAdministration {
  const timing = dosage.schedule;
  const repeat = timing?.recurrence;
  if (!timing || !repeat?.occurrenceCap) return dosage;
  return {
    ...dosage,
    schedule: {
      ...timing,
      recurrence: {
        ...repeat,
        occurrenceCap: undefined,
      },
    },
  };
}
/**
 * Resolve a FHIR R6 RelativeTime tied to the standard "treatment-start"
 * event. Unlike Timing.repeat.startOffset, this is an offset from the
 * beginning of the entire treatment. Unsupported anchors are not guessed.
 */
type TreatmentWallClock = Pick<TimeParts, "hour" | "minute" | "second">;
/** Calendar-relative stages inherit the original treatment wall clock.
 * A DST gap may shift this cycle's Date but must not redefine later days,
 * weeks, months or years to the shifted clock. */
function treatmentRelativeInstant(
  relative: CanonicalBoundary,
  orderedAt: Date,
  timeZone: string,
  sourceClock?: TreatmentWallClock
): Date {
  const knownAnchor = relative.anchor === "treatment-start";
  const duration =
    relative.displacement ?? relative.displacementRange?.low ?? relative.displacementRange?.high;
  const quantity = duration?.value;
  const unit = duration?.code ?? duration?.unit;
  if (
    !knownAnchor ||
    getQuantityComparator(duration) ||
    quantity === undefined ||
    !Number.isInteger(quantity) ||
    quantity < 0
  ) {
    throw new Error("Unsupported R6 step RelativeTime: requires a treatment-start offset");
  }
  switch (unit) {
    case "s":
    case "min":
    case "h":
      return new Date(
        orderedAt.getTime() + quantity * (unit === "h" ? 3600000 : unit === "min" ? 60000 : 1000)
      );
    case "d":
    case "wk": {
      if (quantity === 0) return new Date(orderedAt.getTime());
      const days = unit === "wk" ? quantity * 7 : quantity;
      const result = addCalendarDaysAtClock(orderedAt, days, timeZone, sourceClock ?? getTimeParts(orderedAt, timeZone));
      if (!result) throw new Error("Invalid R6 treatment-day offset");
      return result;
    }
    case "mo":
    case "a":
      return quantity === 0 ? new Date(orderedAt.getTime())
        : addCalendarMonths(orderedAt, quantity * (unit === "a" ? 12 : 1), timeZone, sourceClock);
    default:
      throw new Error("Unsupported R6 treatment-start time unit");
  }
}
/** A treatment stage has its own logical calendar clock. Calendar-relative
 * starts preserve the original prescribed wall clock across a DST gap;
 * elapsed hour/minute/second offsets establish a NEW stage-local clock.
 * Never apply a parent course's 02:30 clock to a stage started +3 hours at
 * 05:30, or that stage's 28-day cap would end three hours too early. */
function stageCalendarClock(
  course: CanonicalCourse,
  index: number,
  start: Date,
  timeZone: string,
  sourceClock?: TreatmentWallClock,
  predecessorClock?: TreatmentWallClock
): TreatmentWallClock | undefined {
  if (!sourceClock) return undefined;
  const relative = course.stages[index].start ?? (index > 0 ? course.stages[index - 1].end : undefined);
  if (!relative) {
    // An implicit successor inherits the predecessor's logical clock, not
    // the original course's clock or a gap-shifted physical timestamp.
    return predecessorClock ?? sourceClock;
  }
  const offset = relative.displacement ?? relative.displacementRange?.low ?? relative.displacementRange?.high;
  const unit = offset?.code ?? offset?.unit;
  if (unit === DurationUnit.Second || unit === DurationUnit.Minute || unit === DurationUnit.Hour)
    return getTimeParts(start, timeZone);
  return sourceClock;
}
/** Each component phase marker owns BOTH its cadence start and the civil
 * clock used by its calendar duration cap. Elapsed offsets create a fresh
 * local wall clock; calendar offsets inherit the prescribed source clock.
 * Without a marker the caller's established stage clock is unchanged.
 * Discover the marker once instead of filtering the extension array. */
function parallelComponentCadence(
  dosage: Pick<CanonicalAdministration, "phaseOrigin" | "phaseOriginIssue">,
  treatmentStart: Date,
  timeZone: string,
  fallback: Date,
  sourceClock?: TreatmentWallClock,
  stageClock?: TreatmentWallClock
): {
  origin: Date;
  capClock?: TreatmentWallClock;
  hasPhaseOrigin: boolean;
} {
  if (dosage.phaseOriginIssue) throw new Error("Parallel component phase origin is malformed or conflicting");
  const offset = dosage.phaseOrigin;
  if (!offset) return { origin: fallback, capClock: stageClock, hasPhaseOrigin: false };
  const origin = treatmentRelativeInstant(
    { anchor: "treatment-start", displacement: offset },
    treatmentStart,
    timeZone,
    sourceClock
  );
  const unit = offset.code ?? offset.unit;
  const elapsed = unit === DurationUnit.Second || unit === DurationUnit.Minute || unit === DurationUnit.Hour;
  return {
    origin,
    capClock: elapsed
      ? getTimeParts(origin, timeZone)
      : stageClock ?? sourceClock ?? getTimeParts(treatmentStart, timeZone),
    hasPhaseOrigin: true,
  };
}
/** A calendar recurrence is defined by its NORMALIZED whole local-day
 * or local-month interval, not by whether the input number is an integer.
 * Thus 0.25 year and 3 months share a civil clock, while 24 hours and
 * fractional days remain elapsed durations. Scheduling, caps and supply
 * must all use this exact same classification. */
function normalizedCalendarInterval(
  value: number | undefined,
  unit: DurationUnit | undefined
):
  | {
      days?: number;
      months?: number;
    }
  | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  if (unit === DurationUnit.Day || unit === DurationUnit.Week) {
    const days = value * (unit === DurationUnit.Week ? 7 : 1);
    return Number.isInteger(days) ? { days } : undefined;
  }
  if (unit === DurationUnit.Month || unit === DurationUnit.Year) {
    const months = value * (unit === DurationUnit.Year ? 12 : 1);
    return Number.isInteger(months) ? { months } : undefined;
  }
  return undefined;
}
function durationStepper(
  quantity: CanonicalMeasure | undefined,
  timeZone: string,
  anchor: Date,
  purpose: "recurrence" | "upper-bound" = "recurrence",
  sourceClock?: TreatmentWallClock
): ((value: Date) => Date | null) | null {
  const value = quantity?.value;
  const periodUnit = parseBoundsDurationUnit(quantity);
  // Approximate course length has an authored numeric center: run the
  // best-effort recurrence at that value, retaining "~" in the source.
  // An inequality is different: it does not determine one cycle length.
  const comparator = getQuantityComparator(quantity);
  if (
    (comparator &&
      comparator !== "~" &&
      !(purpose === "upper-bound" && (comparator === "<" || comparator === "<="))) ||
    value === undefined ||
    !Number.isFinite(value) ||
    value <= 0 ||
    !periodUnit
  )
    return null;
  // Day/week course cycles follow calendar dates, not elapsed 24-hour
  // intervals. q24h interval scheduling still uses createIntervalStepper.
  const calendar = normalizedCalendarInterval(value, periodUnit);
  if (calendar?.days !== undefined) return calendarDayStepper(anchor, calendar.days, timeZone, sourceClock);
  if (sourceClock && calendar?.months !== undefined)
    return (instant) => addCalendarMonths(instant, calendar.months!, timeZone, sourceClock);
  return createIntervalStepper({ period: value, periodUnit }, timeZone);
}
/**
 * Administer one global step at a time, while retaining its simultaneous
 * site-specific components. All absolute boundaries derive from orderedAt;
 * querying halfway through a treatment cannot reset the course clock.
 */
/** A stage's final point and its exclusive clipping boundary are distinct.
 * The point determines an implicit successor's cadence/civil clock; the
 * exclusive boundary only prevents scheduling the same dose twice. */
/** A resolved administration has three independently owned timestamps:
 * recurrenceOrigin controls cadence, eligibleFrom controls membership, and
 * endExclusive clips the course. A final administration is a point, never
 * the artificially exclusive (+1ms) boundary used to avoid replay. */
interface ResolvedAdministrationWindow {
  administration: CanonicalAdministration;
  recurrenceOrigin: Date;
  eligibleFrom: Date;
  endExclusive: Date | null;
  completionPoint?: Date;
  countEligibilityStart?: Date;
  capClock?: TreatmentWallClock;
  completionPending?: boolean;
}
interface TreatmentStepWindow {
  start: Date;
  end?: Date;
  completionPoint?: Date;
  capClock?: TreatmentWallClock;
  administrations: ResolvedAdministrationWindow[];
  completionPending?: boolean;
}
/** Resolve clinical phase semantics ONCE for both event enumeration and
 * numerical supply. No caller is allowed to reconstruct a second onset/cap
 * policy from raw dosing fields. Ordinarily this is one linear component
 * walk; only an authored finite count needs occurrence enumeration.
 *
 * Absolute-calendar tracks keep their own cadence across global cuts.
 * An implicit counted successor inherits its predecessor's actual final
 * point, but its first eligible administration is strictly after that point.
 */
function treatmentStepWindow(
  course: CanonicalCourse,
  index: number,
  anchor: Date,
  previousEnd: Date,
  timeZone: string,
  sourceClock?: TreatmentWallClock,
  predecessorClock?: TreatmentWallClock,
  options?: NextDueDoseOptions,
  predecessorPoint?: Date,
  deferFiniteCompletion = false,
  capContext?: MedicationContext
): TreatmentStepWindow {
  const stage = course.stages[index];
  const start = stage.start
    ? treatmentRelativeInstant(stage.start, anchor, timeZone, sourceClock)
    : predecessorPoint ?? previousEnd;
  const capClock = stageCalendarClock(course, index, start, timeZone, sourceClock, predecessorClock);
  const administrations: ResolvedAdministrationWindow[] = [];
  let allFinite = stage.administrations.length > 0;
  let completionPending = false;
  let latest: { end: Date; point?: Date } | undefined;
  const successorFloor =
    predecessorPoint && !stage.start ? new Date(predecessorPoint.getTime() + 1) : undefined;
  for (const administration of stage.administrations) {
    const recurrence = administration.schedule?.recurrence;
    const absoluteStart = resolveRepeatBoundsStart(recurrence, timeZone);
    const absoluteEnd = resolveRepeatBoundsEndExclusive(recurrence, timeZone);
    if (recurrence?.calendarWindow?.start && !absoluteStart)
      throw new MedicationQuantityCalculationError(
        "invalid-calendar-bounds",
        "A calendar-bound dosage has an invalid start date; correct the date before execution."
      );
    if (recurrence?.calendarWindow?.end && !absoluteEnd)
      throw new MedicationQuantityCalculationError(
        "invalid-calendar-bounds",
        "A calendar-bound dosage has an invalid end date; correct the date before execution."
      );
    if (absoluteStart && absoluteEnd && absoluteEnd <= absoluteStart)
      throw new MedicationQuantityCalculationError(
        "invalid-calendar-order",
        "Absolute calendar component end precedes its start: the calendar-bound dosage ends before its stated start date; correct the date interval."
      );
    const implicitStart = stage.start
      ? start
      : successorIntervalStart(administration, predecessorPoint, start, timeZone);
    const componentClock = implicitStart > start ? getTimeParts(implicitStart, timeZone) : capClock;
    const cadence = recurrence?.calendarWindow
      ? { origin: absoluteStart ?? anchor, capClock, hasPhaseOrigin: false }
      : parallelComponentCadence(
          administration,
          anchor,
          timeZone,
          implicitStart,
          sourceClock,
          componentClock
        );
    const stageStart = index === 0 && !stage.start && recurrence?.calendarWindow
      ? absoluteStart ?? start : implicitStart;
    let eligibleFrom = absoluteStart && absoluteStart > stageStart ? absoluteStart : stageStart;
    if (cadence.hasPhaseOrigin && cadence.origin > eligibleFrom) eligibleFrom = cadence.origin;
    if (successorFloor && successorFloor > eligibleFrom) eligibleFrom = successorFloor;
    const countEligibilityStart =
      !cadence.hasPhaseOrigin &&
      eligibleFrom > cadence.origin &&
      hasDefiniteAdministrationCount(recurrence)
        ? eligibleFrom
        : undefined;
    let endExclusive = earlierDate(
      resolveRepeatDurationCapEnd(administration, cadence.origin, timeZone, cadence.capClock),
      absoluteEnd
    );
    let completionPoint: Date | undefined;
    if (administration.schedule?.explicitEvents?.length) {
      // A finite authored event list owns its last possible administration.
      // Its future events may extend beyond the next cycle's default clip.
      const completion = explicitAdministrationCompletion(administration, cadence.origin,
        eligibleFrom, options ?? { from: cadence.origin, timeZone }, timeZone);
      if (completion) {
        const fence = completion.point ? new Date(completion.end.getTime() + 1) : completion.end;
        if (!endExclusive || fence <= endExclusive) {
          endExclusive = fence;
          if (completion.point) completionPoint = completion.end;
        }
      }
    }
    // Overlapping capped cycles cannot close an exact-count phase using
    // its LOCAL pre-cap completion point: earlier accepted administrations
    // from another cycle may defer this component's third actual dose.
    // The shared chronological acceptor owns count completion ONLY when this
    // component has a cap shared across cycles. An uncapped counted loading
    // component still completes locally, even when a later maintenance
    // component triggers chronological collection for its own rolling cap.
    const hasCountCompletion = recurrence?.count !== undefined ||
      arrayIncludes(recurrence?.anchors ?? [], TimingEvent.Immediate);
    const deferCount = deferFiniteCompletion && hasCountCompletion &&
      Boolean(getTimingOccurrenceCap(recurrence) || (hasPeriodLimits(administration) &&
        (executableDoseRange(administration, capContext)?.caps.length ??
          executableQuantityCaps(administration, capContext).length)));
    if (deferCount) completionPending = true;
    if (hasCountCompletion && !deferCount) {
      const completion = finiteAdministrationCompletion(
        administration,
        cadence.origin,
        options ?? { from: cadence.origin, orderedAt: cadence.origin, timeZone },
        timeZone,
        countEligibilityStart ?? cadence.origin
      );
      if (completion) {
        const fence = completion.point ? new Date(completion.end.getTime() + 1) : completion.end;
        if (!endExclusive || fence <= endExclusive) {
          endExclusive = fence;
          if (completion.point) completionPoint = completion.end;
        }
      }
    }
    administrations.push({
      administration,
      recurrenceOrigin: cadence.origin,
      eligibleFrom,
      endExclusive,
      completionPoint,
      countEligibilityStart,
      capClock: cadence.capClock,
      ...(deferCount ? { completionPending: true } : {}),
    });
    if (!endExclusive) allFinite = false;
    else if (!latest || endExclusive > latest.end) latest = { end: endExclusive, point: completionPoint };
    else if (endExclusive.getTime() === latest.end.getTime() && !completionPoint) latest.point = undefined;
  }
  let end = stage.end ? treatmentRelativeInstant(stage.end, anchor, timeZone, sourceClock) : undefined;
  let completionPoint: Date | undefined;
  if (!end && allFinite && latest) {
    end = latest.end;
    completionPoint = latest.point;
  } else if (!end && course.stages[index + 1]?.start) {
    end = treatmentRelativeInstant(course.stages[index + 1].start!, anchor, timeZone, sourceClock);
  }
  if (end && end <= start)
    throw new MedicationQuantityCalculationError(
      "invalid-stage-order",
      "R6 treatment step end must be after its start"
    );
  return { start, end, completionPoint, capClock, administrations,
    ...(!stage.end && completionPending ? { completionPending: true } : {}) };
}
/** A repeated step keeps its authored civil duration when both boundaries
 * use a compatible calendar unit. Other resolved spans remain elapsed; an
 * implicit finite-count step instead restarts after its accepted completion. */
function stepRepeatSpan(stage: CanonicalStage, window: TreatmentStepWindow, implicitTreatmentStart: boolean): CanonicalMeasure | undefined {
  if (!window.end || window.completionPoint) return undefined;
  const start = stage.start?.displacement;
  const end = stage.end?.displacement;
  if (end && !end.comparator && (!start || !start.comparator)) {
    const unit = parseBoundsDurationUnit(end), startUnit = parseBoundsDurationUnit(start);
    const z = normalizedCalendarInterval(end.value, unit);
    const a = (start?.value === 0 || (!stage.start && implicitTreatmentStart)) && z
      ? z.days !== undefined ? { days: 0 } : { months: 0 }
      : start ? normalizedCalendarInterval(start.value, startUnit) : undefined;
    if (a?.days !== undefined && z?.days !== undefined && z.days > a.days)
      return { value: z.days - a.days, unit: DurationUnit.Day };
    if (a?.months !== undefined && z?.months !== undefined && z.months > a.months)
      return { value: z.months - a.months, unit: DurationUnit.Month };
    // A missing start is only a zero offset for the first treatment step;
    // validate the resulting span against the resolved window below.
  }
  for (const member of window.administrations) {
    if (member.endExclusive?.getTime() !== window.end.getTime() ||
        member.recurrenceOrigin.getTime() !== window.start.getTime()) continue;
    const duration = member.administration.anchoredLength?.quantity ??
      member.administration.schedule?.recurrence?.courseLength;
    if (duration && !duration.comparator) return duration;
  }
  return { value: (window.end.getTime() - window.start.getTime()) / 1000, unit: DurationUnit.Second };
}

interface PlannedTreatmentStep {
  index: number;
  stage: CanonicalStage;
  window: TreatmentStepWindow;
}
interface AcceptedStageCompletion { end: Date; point?: Date }

/** One phase traversal for horizon, scheduling and supply. step.count repeats
 * this step locally in EACH course cycle; it never limits the number of
 * whole-course cycles. A chronological acceptor can resume a suspended phase
 * with its actual accepted completion, so a rejected candidate cannot open
 * the next step or the next repetition. */
function* treatmentStepWindows(
  course: CanonicalCourse,
  anchor: Date,
  timeZone: string,
  sourceClock?: TreatmentWallClock,
  options?: NextDueDoseOptions,
  deferFiniteCompletion = false,
  capContext?: MedicationContext
): Generator<PlannedTreatmentStep, void, AcceptedStageCompletion | undefined> {
  let previousEnd = anchor;
  let predecessorPoint: Date | undefined, predecessorClock = sourceClock;
  for (let index = 0; index < course.stages.length; index++) {
    const stage = course.stages[index];
    const repetitions = positiveInteger(stage.count) ?? 1;
    let localAnchor = anchor, localCourse = course, localClock = sourceClock;
    let advance: ((at: Date) => Date | null) | null | undefined;
    let civilRepetition = false;
    for (let repetition = 0; repetition < repetitions; repetition++) {
      const window = treatmentStepWindow(localCourse, index, localAnchor, previousEnd,
        timeZone, localClock, predecessorClock, options, predecessorPoint,
        deferFiniteCompletion, capContext);
      const accepted = yield { index, stage, window };
      if (accepted) {
        window.end = accepted.end;
        window.completionPoint = accepted.point;
      }
      if (!window.end) {
        if (repetition + 1 < repetitions)
          throw new MedicationQuantityCalculationError("step-repeat-unresolved",
            "The repeated treatment step has no resolved completion or duration. Retain the step and supply its boundary before execution.");
        return;
      }
      previousEnd = window.end;
      predecessorPoint = window.completionPoint;
      predecessorClock = window.completionPoint
        ? getTimeParts(window.completionPoint, timeZone) : window.capClock;
      if (repetition + 1 < repetitions) {
        if (window.completionPoint) {
          // A finite administration sequence owns a completion point, not an
          // elapsed duration. Its next occurrence starts strictly after that
          // point using the same successor cadence rule as any other stage.
          if (localCourse === course) {
            const stages = course.stages.slice();
            stages[index] = { ...stage, start: undefined, end: undefined };
            localCourse = { ...course, stages };
          }
          localAnchor = window.completionPoint;
          localClock = predecessorClock;
        } else {
          if (advance === undefined) {
            const span = stepRepeatSpan(stage, window, index === 0 && window.start.getTime() === localAnchor.getTime());
            civilRepetition = !!normalizedCalendarInterval(span?.value, parseBoundsDurationUnit(span));
            advance = durationStepper(span, timeZone, localAnchor, "recurrence", localClock);
          }
          const next = advance?.(localAnchor);
          if (!next || next <= localAnchor)
            throw new MedicationQuantityCalculationError("step-repeat-unresolved",
              "The repeated treatment step does not define a usable duration.");
          localAnchor = next;
          // The original source clock belongs only to civil repetition.
          if (!civilRepetition)
            localClock = getTimeParts(localAnchor, timeZone);
        }
      }
    }
  }
}

/** Latest finite source bound in one cycle, retaining a prior cycle's tail.
 * Unbounded components still restart at the next cycle, as before. */
function repeatedCourseHorizon(
  course: CanonicalCourse,
  anchor: Date,
  nextCycle: Date,
  timeZone: string,
  sourceClock?: TreatmentWallClock,
  options?: NextDueDoseOptions
): Date {
  let horizon = nextCycle;
  for (const { window } of treatmentStepWindows(course, anchor, timeZone, sourceClock, options)) {
    if (window.end && window.end > horizon) horizon = window.end;
    for (const member of window.administrations)
      if (member.endExclusive && member.endExclusive > horizon) horizon = member.endExclusive;
  }
  return horizon;
}
function hasRepeatedStep(course: CanonicalCourse): boolean {
  for (const stage of course.stages) if (stage.count !== undefined && stage.count > 1) return true;
  return false;
}
/** Component-local accepted administrations across repeat-cycle boundaries.
 * Allocate only for a course that actually declares a rolling cap. */
type RollingCycleUsage = Map<string, string[]>;
/** Lifetime supply is a quantity ceiling, not a ban on concrete scheduling.
 * Retain already calculated quantity (including a partial last allowance),
 * independently of the rolling ledger's finite timestamp window. */
type LifetimeCycleUsage = Map<string, number>;
type RangeCycleUsage = Map<string, SupplyAllocation[]>;
function hasLifetimeLimit(member: CanonicalAdministration): boolean {
  for (const limit of member.limits ?? []) if (limit.scope === "lifetime") return true;
  return false;
}
function lifetimeCycleUsage(course: CanonicalCourse): LifetimeCycleUsage | undefined {
  for (const stage of course.stages)
    for (const member of stage.administrations)
      if (hasLifetimeLimit(member)) return new Map();
  return undefined;
}
/** A cycle's exact administration count is independent of other cycles.
 * Shared rolling limits, however, are evaluated globally in timestamp order.
 * Quota is retained by the pending events of this one member/cycle; no map
 * of every historical cycle is required. */
interface UncommittedCycleEvent extends ChronologicalEvent {
  key: string;
  member: CanonicalAdministration;
  quota: CycleEventQuota;
  /** Actual PRN history, already charged to the quantity ledger. */
  recorded?: true;
  /** Accepted total amount, including target multiplication, for ranged supply. */
  quantity?: number;
}
interface CycleEventQuota {
  remaining: number | undefined;
  /** Only recorded use inside this PRN phase consumes its finite allowance. */
  historyStart?: number;
  historyEnd?: number;
  recordedTimes?: number[];
  recordedIndex?: number;
  /** Lazily advance a finite capped phase after its candidate is decided. */
  advance?: (at: number, accepted: boolean) => void;
}
type EmitCycleOpportunity = (
  iso: string, key: string, member: CanonicalAdministration,
  quota: CycleEventQuota
) => void;
function hasRollingCycleLimit(course: CanonicalCourse): boolean {
  for (const stage of course.stages)
    for (const component of stage.administrations)
      if (hasPeriodLimits(component) || getTimingOccurrenceCap(component.schedule?.recurrence))
        return true;
  return false;
}
/** Compare relative spans only when their calendar/elapsed meanings agree.
 * A 24-hour phase is not bounded by every one-day cycle at a clock change. */
function durationFitsEveryCycle(bound: CanonicalMeasure, cycle: CanonicalMeasure | undefined): boolean {
  if (!cycle || bound.value === undefined || cycle.value === undefined ||
      bound.value <= 0 || cycle.value <= 0 ||
      (bound.comparator && bound.comparator !== "~" && bound.comparator !== "<" && bound.comparator !== "<="))
    return false;
  const boundUnit = parseBoundsDurationUnit(bound), cycleUnit = parseBoundsDurationUnit(cycle);
  if (!boundUnit || !cycleUnit) return false;
  const left = normalizedCalendarInterval(bound.value, boundUnit);
  const right = normalizedCalendarInterval(cycle.value, cycleUnit);
  if (left || right) return !!left && !!right && (
    left.days !== undefined && right.days !== undefined && left.days <= right.days ||
    left.months !== undefined && right.months !== undefined && left.months <= right.months);
  const seconds = (value: number, unit: DurationUnit) => unit === DurationUnit.Second ? value :
    unit === DurationUnit.Minute ? value * 60 : unit === DurationUnit.Hour ? value * 3600 :
    unit === DurationUnit.Day ? value * 86400 : unit === DurationUnit.Week ? value * 604800 : NaN;
  return seconds(bound.value, boundUnit) <= seconds(cycle.value, cycleUnit);
}
/** Unbounded scalar members are clipped at the next cycle. Explicit civil
 * or elapsed lengths also prove nonoverlap when both spans share a scale.
 * Exact counted schedules and absolute event lists may extend farther. */
function definitelyNonOverlappingCycle(course: CanonicalCourse, cycle?: CanonicalMeasure): boolean {
  if (course.stages.length !== 1) return false;
  const stage = course.stages[0];
  if (stage.start || stage.end || (stage.count !== undefined && stage.count !== 1)) return false;
  for (const member of stage.administrations) {
    const repeat = member.schedule?.recurrence;
    if (member.phaseOrigin || member.phaseOriginIssue ||
        member.anchoredLength || member.delayMinutes ||
        repeat?.calendarWindow?.end || repeat?.calendarWindow?.start ||
        (repeat?.count !== undefined && !unscheduledOccurrenceCapacity(member)) ||
        repeat?.occurrenceDuration !== undefined ||
        repeat?.startOffset || repeat?.endOffset ||
        member.schedule?.explicitEvents?.length) return false;
    if (repeat?.courseLength && !durationFitsEveryCycle(repeat.courseLength, cycle)) return false;
    if (repeat?.courseLengthRange && (!repeat.courseLengthRange.high ||
        !durationFitsEveryCycle(repeat.courseLengthRange.high, cycle))) return false;
  }
  return true;
}

function rollingCycleKey(stage: number, component: number): string {
  return stage + ":" + component;
}
function rollingPriorTimes(
  usage: RollingCycleUsage | undefined,
  key: string,
  original: Array<Date | string> | undefined
): Array<Date | string> | undefined {
  const carried = usage?.get(key);
  if (!carried?.length) return original;
  return original?.length ? [...original, ...carried] : carried;
}
/** Keep only history that could still influence the NEXT cycle's
 * eligibility. Both rolling quantity and occurrence caps use their authored
 * periods; no query-global unbounded array and no per-candidate history scan
 * across every past cycle. This runs ONLY for capped repeated courses. */
function trimRollingCycleHistory<T extends string | SupplyAllocation>(
  course: CanonicalCourse, usage: Map<string, T[]>, upcoming: Date, zone: string
): void {
  for(let index=0;index<course.stages.length;index++) {
    const members=course.stages[index].administrations;
    for(let memberIndex=0;memberIndex<members.length;memberIndex++) {
      const key=rollingCycleKey(index,memberIndex),times=usage.get(key);
      if(!times?.length)continue;
      const member=members[memberIndex];
      let oldest=upcoming.getTime(),found=false;
      for(const limit of member.limits??[]) {
        if(limit.scope!=="period")continue;
        const period=limit.period?.value,unit=limit.period?.code??limit.period?.unit;
        if(period===undefined||!Number.isInteger(period)||period<=0||
            !isQuantityCapPeriodUnit(unit))continue;
        const since=quantityCapHistoryFloor(upcoming,
          {max:1,period,periodUnit:unit as DurationUnit},zone);
        if(since<oldest)oldest=since;
        found=true;
      }
      const occurrence=getTimingOccurrenceCap(member.schedule?.recurrence);
      if(occurrence) {
        const since=quantityCapHistoryFloor(upcoming,occurrence,zone);
        if(since<oldest)oldest=since;
        found=true;
      }
      if(!found){usage.delete(key);continue;}
      // A source's events can overlap adjacent cycles. Keep stable event
      // order without assuming they were sorted or copying the whole list.
      let write=0;
      for(const item of times)if((typeof item === "string" ? Date.parse(item) : item.at)>oldest)times[write++]=item;
      times.length=write;
      if(!write)usage.delete(key);
    }
  }
}

function scheduleTreatmentRelativeCourse(
  course: CanonicalCourse,
  options: NextDueDoseOptions,
  cycleDefaultEnd?: Date,
  cycleIndex?: number,
  sourceClock?: TreatmentWallClock,
  rollingUsage?: RollingCycleUsage,
  collect?: EmitCycleOpportunity,
  capContext?: MedicationContext
): string[] {
  const limit = Math.floor(options.limit ?? 10);
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const timeZone = options.timeZone ?? options.config?.timeZone;
  if (!timeZone) throw new Error("timeZone is required for relative treatment-step scheduling");
  const from = coerceDate(options.from, "from");
  const anchor = options.orderedAt !== undefined ? coerceDate(options.orderedAt, "orderedAt") : from;
  const doses: string[] = [];
  const planner = treatmentStepWindows(course, anchor, timeZone, sourceClock, options, Boolean(collect), capContext);
  const consume = (planned = planner.next()): void => {
    while (!planned.done) {
      const { index, stage, window } = planned.value;
      // All members must complete before an implicit successor can begin.
      // Only genuinely finite counted members can resolve a deferred end;
      // an unbounded member remains unbounded, not a fabricated transition.
      let pending = 0, canComplete = Boolean(collect && (window.completionPending || !window.end));
      let latest: AcceptedStageCompletion | undefined;
      if (canComplete) {
        for (const member of window.administrations) {
          if (member.completionPending && hasDefiniteAdministrationCount(member.administration.schedule?.recurrence)) {
            pending++;
          } else if (member.endExclusive) {
            if (!latest || member.endExclusive > latest.end)
              latest = { end: member.endExclusive, point: member.completionPoint };
            else if (member.endExclusive.getTime() === latest.end.getTime() && !member.completionPoint)
              latest.point = undefined;
          } else if (hasDefiniteAdministrationCount(member.administration.schedule?.recurrence)) {
            pending++;
          } else { canComplete = false; break; }
        }
      }
      const suspended = canComplete && pending > 0;
      const finishMember = (completion: AcceptedStageCompletion) => {
        if (!latest || completion.end > latest.end) latest = completion;
        else if (completion.end.getTime() === latest.end.getTime() && !completion.point)
          latest.point = undefined;
        if (--pending === 0 && latest) consume(planner.next(latest));
      };
      for (let memberIndex = 0; memberIndex < window.administrations.length; memberIndex++) {
        const member = window.administrations[memberIndex];
        const key = rollingCycleKey(index, memberIndex);
        const deferred = canComplete && (member.completionPending || !member.endExclusive);
        const effectiveEnd = earlierDate(window.end ?? null, member.endExclusive) ??
          (deferred ? undefined : cycleDefaultEnd);
        if (effectiveEnd && from >= effectiveEnd) continue;
        const effectiveFrom = from > member.eligibleFrom ? from : member.eligibleFrom;
        const original = member.administration;
        if (collect && unscheduledOccurrenceCapacity(original)) continue;
        const originalRepeat = original.schedule?.recurrence;
        const quota: CycleEventQuota = {
          remaining: collect && originalRepeat ? repeatOccurrenceCap(originalRepeat) : undefined,
        };
        if (collect && original.asNeeded && quota.remaining !== undefined) {
          quota.historyStart = member.eligibleFrom.getTime();
          quota.historyEnd = effectiveEnd?.getTime();
        }
        // Only the acceptor can spend an overlapping phase's count/caps.
        const counted = collect && originalRepeat && !isSingleAdministrationRepeat(originalRepeat)
          ? { ...originalRepeat, count: undefined, countMax: undefined, occurrenceCap: undefined }
          : originalRepeat;
        const execution: CanonicalAdministration = {
          ...original, phaseOrigin: undefined, phaseOriginIssue: undefined,
          ...(collect ? { limits: original.limits?.filter(item => item.scope !== "period") } : {}),
          ...(collect && originalRepeat ? {
            schedule: { ...original.schedule, recurrence: {
              ...counted, occurrenceCap: undefined,
              ...(effectiveEnd ? { calendarWindow: {
                ...originalRepeat.calendarWindow,
                end: new Date(effectiveEnd.getTime() - 1).toISOString(),
              } } : {}),
            } },
          } : rollingUsage && effectiveEnd && originalRepeat ? {
            schedule: { ...original.schedule, recurrence: {
              ...originalRepeat, calendarWindow: {
                ...originalRepeat.calendarWindow,
                end: new Date(effectiveEnd.getTime() - 1).toISOString(),
              },
            } },
          } : {}),
        };
        const localOptions = {
          ...options, from: effectiveFrom, orderedAt: member.recurrenceOrigin,
          ...(collect ? { priorDoseTimes: undefined } : rollingUsage
            ? { priorDoseTimes: rollingPriorTimes(rollingUsage, key, options.priorDoseTimes) } : {}),
          ...(member.countEligibilityStart ? { countEligibilityStart: member.countEligibilityStart } : {}),
        } as PhaseCountOptions;
        if (deferred && collect) {
          const emitNext = (after: Date) => {
            const next = nextDueDoses(execution, { ...localOptions, from: after, limit: 1 })[0];
            if (next && (!effectiveEnd || Date.parse(next) < effectiveEnd.getTime()))
              collect(next, key, original, quota);
            else if (effectiveEnd) finishMember({ end: effectiveEnd });
          };
          quota.advance = (at, accepted) => {
            if (accepted && quota.remaining === 0) {
              const completion = completionAfterAcceptedAdministration(original, new Date(at), timeZone);
              const end = completion.point ? new Date(completion.end.getTime() + 1) : completion.end;
              finishMember(effectiveEnd && end > effectiveEnd ? { end: effectiveEnd } :
                { end, point: completion.point ? completion.end : undefined });
            } else emitNext(new Date(at + 1));
          };
          emitNext(effectiveFrom);
          continue;
        }
        const times = nextDueDoses(execution, { ...localOptions, limit });
        let history = rollingUsage?.get(key);
        for (const at of times) {
          if (effectiveEnd && Date.parse(at) >= effectiveEnd.getTime()) break;
          if (collect) collect(at, key, original, quota);
          else {
            doses.push(at);
            if (rollingUsage) {
              if (!history) rollingUsage.set(key, history = []);
              history.push(at);
            }
          }
        }
      }
      if (suspended) return;
      planned = planner.next();
    }
  };
  consume();
  return collect ? [] : doses.sort((left, right) => Date.parse(left) - Date.parse(right)).slice(0, limit);
}
/** One clock-ownership decision for both repeated-course scheduling
 * and supply. Integral calendar day/week/month/year cycles keep the
 * source-prescribed local clock through DST. An elapsed cycle (e.g.
 * 24 hours, 168 hours, or fractional day/week) starts its own stage
 * at that cycle's actual wall time. Do not reuse the old course clock
 * after an elapsed cycle crosses a DST transition. */
function repeatedCycleWallClock(
  calendarCycle: boolean,
  firstClock: TreatmentWallClock,
  cycleStart: Date,
  timeZone: string
): TreatmentWallClock {
  // Calendar classification is computed once per course; only elapsed
  // cycles require a fresh time-zone lookup at each actual cycle start.
  return calendarCycle ? firstClock : getTimeParts(cycleStart, timeZone);
}
/** Approximate cycle ordinal from a civil or elapsed duration without
 * enumerating every historic cycle. No stage count, choice, or overlap state
 * is modified; callers can skip only when the real first cycle has no tail. */
function cycleOrdinalNearQuery(
  quantity: CanonicalMeasure | undefined, anchor: Date, from: Date, zone: string
): number {
  if (from <= anchor) return 0;
  const value = quantity?.value;
  const unit = parseBoundsDurationUnit(quantity);
  if (!value || !unit) return 0;
  const calendar = normalizedCalendarInterval(value, unit);
  if (calendar?.days) {
    const elapsed = getLocalDayNumber(from, zone) - getLocalDayNumber(anchor, zone);
    return Math.max(0, Math.floor(elapsed / calendar.days) - 1);
  }
  if (calendar?.months) {
    const origin = getTimeParts(anchor, zone);
    // Month-end recurrence may clamp February 31st, changing subsequent
    // month starts; never approximate that source cadence by a direct jump.
    if (origin.day >= 29) return 0;
    const elapsed = getLocalMonthIndex(from, zone) - getLocalMonthIndex(anchor, zone);
    return Math.max(0, Math.floor(elapsed / calendar.months) - 1);
  }
  const elapsed =
    unit === DurationUnit.Second ? value * 1000 :
    unit === DurationUnit.Minute ? value * 60000 :
    unit === DurationUnit.Hour ? value * 3600000 :
    unit === DurationUnit.Day || unit === DurationUnit.Week
      ? value * (unit === DurationUnit.Week ? 7 : 1) * 86400000 : undefined;
  return elapsed ? Math.max(0, Math.floor((from.getTime() - anchor.getTime()) / elapsed) - 1) : 0;
}

/** A cap ledger uses one chronologically appended stream per component.
 * Each accepted timestamp advances each cap's head at most once; unlike
 * repeatedly calling applyQuantityCaps on copied histories, this is O(C)
 * amortized per opportunity (C = authored number of caps). */
interface ChronologicalCapLedger {
  caps: CanonicalOccurrenceCapExpr[];
  times: number[];
  heads: number[];
  range?: ExecutableDoseRange;
  rangePlan?: TimedRangeLedger;
  quantityPrefix?: number[];
  occurrence?: CanonicalOccurrenceCapExpr;
  occurrenceKey?: string;
  occurrenceUsed: number;
  /** Supplied actual doses grouped once, not rescanned for every bucket. */
  priorByBucket?: Map<string, number[]>;
}
function upperBoundTimestamp(sorted: readonly number[], target: number): number {
  let low = 0,
    high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sorted[mid] <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}

interface TimedRangeLedger {
  candidates: UncommittedCycleEvent[];
  selected: UncommittedCycleEvent[];
  quotas: Map<CycleEventQuota, number | undefined>;
}
interface ChronologicalAcceptor {
  (event: UncommittedCycleEvent): boolean;
  finish(events: UncommittedCycleEvent[], from: number): UncommittedCycleEvent[];
}
/** Fixed authored clocks are opportunities, not greedy maximum quantities.
 * Solve their dose amounts together; only genuinely interacting selections
 * use the same bounded exact search as untimed range capacity. */
function maximumTimedRangePlan(
  ledger: TimedRangeLedger, sourceRange: ExecutableDoseRange, priorTimes: readonly number[],
  zone: string, from: number
): UncommittedCycleEvent[] {
  const candidates = ledger.candidates;
  if (!candidates.length) return [];
  const range = sourceRange.low === 0 ? { ...sourceRange, strictLow: true } : sourceRange;
  const prior = priorTimes.map(at => ({ at, count: 1, quantity: range.high }));
  const occurrence = getTimingOccurrenceCap(candidates[0].member.schedule?.recurrence);
  const buckets: string[] = [], supplied: number[] = [];
  const priorBuckets = new Map<string, number[]>();
  if (occurrence) for (const at of priorTimes) {
    const bucket = occurrenceCapBucketKey(new Date(at), occurrence, zone);
    let values = priorBuckets.get(bucket);
    if (!values) priorBuckets.set(bucket, values = []);
    values.push(at);
  }
  const futureCounts = new Map<CycleEventQuota, number>();
  let firstFuture = Infinity, lastFuture = -Infinity;
  for (const event of candidates) {
    if (event.at >= from) {
      futureCounts.set(event.quota, (futureCounts.get(event.quota) ?? 0) + 1);
      firstFuture = Math.min(firstFuture, event.at); lastFuture = event.at;
    }
    const bucket = occurrence ? occurrenceCapBucketKey(new Date(event.at), occurrence, zone) : "";
    buckets.push(bucket);
    const actual = priorBuckets.get(bucket);
    supplied.push(actual ? upperBoundTimestamp(actual, event.at) : 0);
  }
  if (!Number.isFinite(firstFuture)) return [];
  let upper = 0;
  for (const [quota, count] of futureCounts) upper += Math.min(count, ledger.quotas.get(quota) ?? count) * range.high;
  for (const cap of range.caps) {
    const width = elapsedCapMilliseconds(cap);
    if (width) upper = Math.min(upper, Math.ceil((lastFuture - firstFuture + 1) / width) * cap.max);
  }
  const required = new Set(ledger.selected.filter(event => event.at < from));
  const completed = new Map<CycleEventQuota, number>();
  for (const [quota, count] of ledger.quotas)
    if (quota.advance && quota.remaining === 0 && count !== undefined) completed.set(quota, count);
  const assign = (events: readonly UncommittedCycleEvent[], values: readonly number[]) => {
    const result: UncommittedCycleEvent[] = [];
    for (let index = 0; index < events.length; index++) {
      events[index].quantity = values[index] * range.multiplier;
      if (events[index].at >= from) result.push(events[index]);
    }
    return result;
  };
  // Long independent or completely filled ranges have a linear proof and
  // never enter the combinatorial planner or allocate a constraint graph.
  for (const value of [range.high, range.low]) {
    if (!rangeDoseFits(value, range) || (range.strictHigh && value >= range.high)) continue;
    let feasible = true, quantity = 0;
    const times = ledger.selected.map(event => event.at);
    for (let index = 0; index < times.length && feasible; index++) {
      const at = times[index];
      if (at >= from) quantity += value;
      for (const cap of range.caps) {
        const since = quantityCapWindowStart(new Date(at), cap, zone);
        const used = (index + 1 - upperBoundTimestamp(times, since)) * value +
          (upperBoundTimestamp(priorTimes, at) - upperBoundTimestamp(priorTimes, since)) * range.high;
        if (used > cap.max + 1e-9) { feasible = false; break; }
      }
    }
    if (feasible && quantity >= upper - 1e-9)
      return assign(ledger.selected, new Array(ledger.selected.length).fill(value));
  }
  let bestQuantity = 0, supremum = 0;
  let best: UncommittedCycleEvent[] = [], bestValues: number[] = [];
  const consider = (events: readonly UncommittedCycleEvent[]) => {
    const times = events.map(event => event.at);
    let objectiveStart = 0;
    while (objectiveStart < times.length && times[objectiveStart] < from) objectiveStart++;
    const plan = fixedCapacityQuantities(times, range.caps, prior, range, zone, objectiveStart);
    if (!plan) return undefined;
    const counts = new Map<CycleEventQuota, number>();
    let requiredCount = 0;
    for (const event of events) {
      counts.set(event.quota, (counts.get(event.quota) ?? 0) + 1);
      if (required.has(event)) requiredCount++;
    }
    if (requiredCount !== required.size) return plan;
    for (const [quota, count] of completed) if ((counts.get(quota) ?? 0) !== count) return plan;
    supremum = Math.max(supremum, plan.quantity);
    if (plan.attained && (plan.quantity > bestQuantity + 1e-9 || !best.length)) {
      bestQuantity = plan.quantity; best = events.slice(); bestValues = plan.values;
    }
    return plan;
  };
  // The ordinary all-slot convex plan often attains the cap bound directly.
  // A larger graph is still polynomial; subset search remains limited to 32.
  if (ledger.selected.length <= 512) consider(ledger.selected);
  if (bestQuantity >= upper - 1e-9) return assign(best, bestValues);
  if (candidates.length > MAX_CAPACITY_SLOTS) capacityComplexity();
  const chosen: UncommittedCycleEvent[] = [];
  const usedQuota = new Map<CycleEventQuota, number>(), usedBucket = new Map<string, number>();
  let states = 0;
  const explore = (start: number): void => {
    for (let index = start; index < candidates.length; index++) {
      if (++states > MAX_CAPACITY_STATES) capacityComplexity();
      const event = candidates[index], quotaCount = usedQuota.get(event.quota) ?? 0;
      const quotaMax = ledger.quotas.get(event.quota), bucket = buckets[index];
      const bucketCount = usedBucket.get(bucket) ?? 0;
      if ((quotaMax === undefined || quotaCount < quotaMax) &&
          (!occurrence || bucketCount + supplied[index] < occurrence.max)) {
        chosen.push(event); usedQuota.set(event.quota, quotaCount + 1); usedBucket.set(bucket, bucketCount + 1);
        if (consider(chosen) && bestQuantity < upper - 1e-9) explore(index + 1);
        chosen.pop(); usedQuota.set(event.quota, quotaCount); usedBucket.set(bucket, bucketCount);
      }
      if (bestQuantity >= upper - 1e-9 || required.has(event)) return;
    }
  };
  explore(0);
  if (supremum > bestQuantity + 1e-9)
    throw new MedicationQuantityCalculationError("ranged-capacity-open-maximum",
      "These strict dose endpoints have a finite supply supremum but no attainable maximum. Provide a resolved per-administration quantity or a closed dose range before calculating supply; all source constraints remain retained.");
  return assign(best, bestValues);
}
/** Shared chronological allowance decision. Scalar members use counts;
 * ranged supply members carry the quantity actually admitted at each event. */
function chronologicalCapAcceptor(
  prior: number[], zone: string, context?: MedicationContext
): ChronologicalAcceptor {
  const ledgers = new Map<string, ChronologicalCapLedger>();
  let hasRanges = false;
  const accept = (event: UncommittedCycleEvent): boolean => {
    let state = ledgers.get(event.key);
    if (!state) {
      const range = executableDoseRange(event.member, context);
      if (range) hasRanges = true;
      const caps = range?.caps ?? executableQuantityCaps(event.member, context);
      const occurrence = getTimingOccurrenceCap(event.member.schedule?.recurrence);
      let priorByBucket: Map<string, number[]> | undefined;
      if (occurrence && prior.length) {
        priorByBucket = new Map();
        for (const timestamp of prior) {
          const bucket = occurrenceCapBucketKey(new Date(timestamp), occurrence, zone);
          let values = priorByBucket.get(bucket);
          if (!values) priorByBucket.set(bucket, (values = []));
          values.push(timestamp);
        }
      }
      state = {
        caps,
        times: [],
        heads: new Array(caps.length).fill(0),
        range,
        rangePlan: range ? { candidates: [], selected: [], quotas: new Map() } : undefined,
        quantityPrefix: range ? [0] : undefined,
        occurrence,
        occurrenceUsed: 0,
        priorByBucket,
      };
      ledgers.set(event.key, state);
    }
    if (state.rangePlan) {
      state.rangePlan.candidates.push(event);
      if (!state.rangePlan.quotas.has(event.quota))
        state.rangePlan.quotas.set(event.quota, event.quota.remaining);
    }
    if (event.quota.remaining !== undefined && event.quota.remaining <= 0) return false;
    const at = event.at;
    const date = new Date(at);
    const quantity = state.range?.low;
    for (let index = 0; index < state.caps.length; index++) {
      const cap = state.caps[index],
        since = quantityCapWindowStart(date, cap, zone);
      let head = state.heads[index];
      if (cap.periodUnit === DurationUnit.Month || cap.periodUnit === DurationUnit.Year) {
        // Clamping March 30/31 back into February can move this cutoff
        // backwards. Membership is reversible; elapsed-window heads remain
        // amortized O(1) and never pay a binary search.
        head = upperBoundTimestamp(state.times, since);
      } else {
        while (head < state.times.length && state.times[head] <= since) head++;
      }
      state.heads[index] = head;
      const previously = prior.length
        ? upperBoundTimestamp(prior, at) - upperBoundTimestamp(prior, since)
        : 0;
      if (state.range && state.quantityPrefix) {
        const used = state.quantityPrefix[state.times.length] - state.quantityPrefix[head] +
          previously * state.range.high;
        const available = cap.max - used;
        if (state.range.strictLow || state.range.low === 0
          ? available <= state.range.low + 1e-10 : available < state.range.low - 1e-10) return false;
      } else if (state.times.length - head + previously >= cap.max) return false;
    }
    const occurrence = state.occurrence;
    if (occurrence) {
      const bucket = occurrenceCapBucketKey(date, occurrence, zone);
      if (state.occurrenceKey !== bucket) {
        state.occurrenceKey = bucket;
        state.occurrenceUsed = 0;
      }
      // Binary-search only this bucket's supplied dates. Later supplied
      // timestamps inside the same bucket must not count before they occur.
      const supplied = state.priorByBucket?.get(bucket);
      const past = supplied ? upperBoundTimestamp(supplied, at) : 0;
      if (state.occurrenceUsed + past >= occurrence.max) return false;
    }
    if (event.quota.remaining !== undefined) event.quota.remaining--;
    state.rangePlan?.selected.push(event);
    if (state.caps.length) {
      state.times.push(at);
      if (state.quantityPrefix) {
        state.quantityPrefix.push(state.quantityPrefix[state.quantityPrefix.length - 1] + quantity!);
      }
      if (state.times.length > 256) {
        let trim = state.heads[0];
        for (let index = 0; index < state.heads.length; index++) {
          const cap = state.caps[index];
          // Later dates may reuse any part of the clamped target day.
          // Retire only history older than that day's boundary.
          const safeHead = cap.periodUnit === DurationUnit.Month || cap.periodUnit === DurationUnit.Year
            ? upperBoundTimestamp(state.times, quantityCapHistoryFloor(date, cap, zone))
            : state.heads[index];
          if (safeHead < trim) trim = safeHead;
        }
        if (trim >= 128) {
          state.times.splice(0, trim);
          state.quantityPrefix?.splice(0, trim);
          for (let index = 0; index < state.heads.length; index++) state.heads[index] -= trim;
        }
      }
    }
    if (occurrence) state.occurrenceUsed++;
    return true;
  };
  return Object.assign(accept, { finish(events: UncommittedCycleEvent[], from: number) {
    if (!hasRanges) return events;
    const selected = events.filter(event => !ledgers.get(event.key)?.rangePlan && event.at >= from);
    for (const state of ledgers.values()) if (state.rangePlan)
      selected.push(...maximumTimedRangePlan(state.rangePlan, state.range!, prior, zone, from));
    selected.sort((a, b) => a.at - b.at || a.serial - b.serial);
    return selected;
  } });
}

/** Supported overlapping treatment cycles require global chronological
 * acceptance. Source cycles are generated in ordinal order, but their
 * opportunities are queued until the next cycle's start proves that NO
 * later cycle can precede them. Shared rolling caps then see earlier
 * administrations before later ones. Scheduling and numeric supply both
 * consume this SAME event stream, without a second cap algorithm.
 *
 * This path is needed when overlapping capped cycles are possible. A
 * structural clipping proof keeps ordinary nonoverlapping cycles fast. */
function chronologicalRepeatedEvents(
  course: CanonicalCourse,
  options: NextDueDoseOptions,
  zone: string,
  until: Date | undefined,
  resultLimit: number,
  context?: MedicationContext
): UncommittedCycleEvent[] {
  const from = coerceDate(options.from, "from"),
    anchor = options.orderedAt === undefined ? from : coerceDate(options.orderedAt, "orderedAt");
  const advance = durationStepper(course.cycleInterval, zone, anchor);
  if (course.cycleInterval && !advance)
    throw new MedicationQuantityCalculationError(
      "repeat-cycle-unresolved",
      "The supplied repeatCycle does not define a usable numeric interval."
    );
  const firstClock = getTimeParts(anchor, zone);
  const calendar = !!normalizedCalendarInterval(
    course.cycleInterval?.value,
    parseBoundsDurationUnit(course.cycleInterval)
  );
  const singleCycle = { ...course, cycleInterval: undefined };
  const queue = new ChronologicalQueue<UncommittedCycleEvent>();
  const results: UncommittedCycleEvent[] = [];
  const prior: number[] = [];
  for (const stamp of options.priorDoseTimes ?? []) prior.push(coerceDate(stamp, "priorDoseTimes").getTime());
  if (prior.length > 1) prior.sort((a, b) => a - b);
  let serial = 0;
  const actualReplay = prior.length ? new Map<string, Set<number>>() : undefined;
  const emit: EmitCycleOpportunity = (iso, key, member, quota) => {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return;
    if (actualReplay && quota.historyStart !== undefined) {
      let unmatched = actualReplay.get(key);
      if (!unmatched) actualReplay.set(key, unmatched = new Set(prior));
      for (const recorded of unmatched) {
        if (recorded < quota.historyStart || recorded >= from.getTime() ||
            quota.historyEnd !== undefined && recorded >= quota.historyEnd) continue;
        unmatched.delete(recorded);
        (quota.recordedTimes ??= []).push(recorded);
      }
      // Select applicable history once per phase, never on every opportunity.
      quota.historyStart = undefined;
      quota.recordedIndex = 0;
    }
    if (quota.recordedTimes) {
      while (quota.recordedIndex! < quota.recordedTimes.length) {
        const recorded = quota.recordedTimes[quota.recordedIndex!++];
        queue.push({ at: recorded, iso: formatZonedIso(new Date(recorded), zone),
          key, member, quota, recorded: true, serial: serial++ });
        // Deferred phases resume after the actual timestamp. Earlier unrecorded
        // PRN clocks did not happen and must not complete the phase or spend uses.
        if (quota.advance) return;
      }
      quota.recordedTimes = undefined;
    }
    if (!until || at < until.getTime())
      queue.push({ at, iso, key, member, quota, serial: serial++ });
  };
  const accept = chronologicalCapAcceptor(prior, zone, context);
  const drain = (before: number): void => {
    let next = queue.first();
    while (next && next.at < before) {
      const event = queue.pop()!;
      let actual = event.recorded === true;
      if (!actual && actualReplay && event.at < from.getTime()) {
        let unmatched = actualReplay.get(event.key);
        if (!unmatched) actualReplay.set(event.key, unmatched = new Set(prior));
        actual = unmatched.delete(event.at);
      }
      // A recorded administration already occupies the rolling ledger. Its
      // matching replay spends its finite phase count, never another amount.
      // Earlier PRN opportunities are not evidence of administration.
      const accepted = actual || ((event.at >= from.getTime() || !event.member.asNeeded) && accept(event));
      if (actual && event.quota.remaining !== undefined && event.quota.remaining > 0) event.quota.remaining--;
      event.quota.advance?.(event.at, accepted);
      if (accepted && event.at >= from.getTime()) {
        results.push(event);
        if (results.length >= resultLimit) return;
      }
      next = queue.first();
    }
  };
  let cycleStart = anchor,
    cycleIndex = 0;
  while (
    cycleIndex < (advance ? Math.min(10000, positiveInteger(course.cycleCount) ?? Infinity) : 1) &&
    (!until || cycleStart < until)
  ) {
    const next = advance?.(cycleStart);
    if (advance && (!next || next <= cycleStart)) break;
    const sourceClock = repeatedCycleWallClock(calendar, firstClock, cycleStart, zone);
    scheduleTreatmentRelativeCourse(
      singleCycle,
      {
        ...options,
        from: cycleStart,
        orderedAt: cycleStart,
        priorCount: undefined,
        priorDoseTimes: undefined,
        limit: 10000,
      },
      next ?? undefined,
      cycleIndex,
      sourceClock,
      undefined,
      emit,
      context
    );
    drain(next?.getTime() ?? until?.getTime() ?? Number.POSITIVE_INFINITY);
    if (!next) break;
    cycleStart = next;
    cycleIndex++;
    if (results.length >= resultLimit) break;
  }
  if (results.length < resultLimit) drain(until?.getTime() ?? Number.POSITIVE_INFINITY);
  return accept.finish(results, from.getTime());
}

function scheduleRepeatedCourse(
  course: CanonicalCourse,
  options: NextDueDoseOptions,
  timeZone: string
): string[] {
  const from = coerceDate(options.from, "from");
  const anchor = options.orderedAt === undefined ? from : coerceDate(options.orderedAt, "orderedAt");
  const advance = durationStepper(course.cycleInterval, timeZone, anchor);
  const firstClock = getTimeParts(anchor, timeZone);
  const calendarCycle = !!normalizedCalendarInterval(
    course.cycleInterval?.value,
    parseBoundsDurationUnit(course.cycleInterval)
  );
  if (!advance)
    throw new MedicationQuantityCalculationError(
      "repeat-cycle-unresolved",
      "The supplied repeatCycle does not define a usable numeric interval. Original recurrence is preserved; correct its unit or choose a duration before scheduling."
    );
  const limit = Math.floor(options.limit ?? 10);
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const results: string[] = [];
  const singleCycle = { ...course, cycleInterval: undefined };
  const rollingUsage = hasRollingCycleLimit(singleCycle) ? new Map<string, string[]>() : undefined;
  if (rollingUsage && !definitelyNonOverlappingCycle(singleCycle, course.cycleInterval)) {
    // An elapsed phase can outlast a later civil cycle after a clock change,
    // even when the first cycle fits. Only structural clipping proves that
    // every cycle is disjoint; otherwise admit events in timestamp order.
    const events = chronologicalRepeatedEvents(course, options, timeZone, undefined, limit);
    return events.map(event => event.iso);
  }
  let cycleStart = anchor;
  let guard = 0;
  const historicalOrdinal = cycleOrdinalNearQuery(course.cycleInterval, anchor, from, timeZone);
  if (!rollingUsage && historicalOrdinal > 0 && course.stages.length === 1 &&
      !course.stages[0].start && !course.stages[0].end) {
    const noOverlap = definitelyNonOverlappingCycle(singleCycle, course.cycleInterval);
    if (noOverlap) {
      const interval = normalizedCalendarInterval(
        course.cycleInterval?.value, parseBoundsDurationUnit(course.cycleInterval)
      );
      if (interval?.days) {
        cycleStart = addCalendarDaysAtClock(anchor, historicalOrdinal * interval.days, timeZone, firstClock) ?? anchor;
        guard = historicalOrdinal;
      } else if (interval?.months) {
        cycleStart = addCalendarMonths(anchor, historicalOrdinal * interval.months, timeZone, firstClock);
        guard = historicalOrdinal;
      } else {
        // Elapsed cycles need their exact authored period, never a quotient
        // derived from the calendar query distance.
        const unit = parseBoundsDurationUnit(course.cycleInterval);
        const value = course.cycleInterval?.value ?? 0;
        const span = unit === DurationUnit.Second ? value * 1000 :
          unit === DurationUnit.Minute ? value * 60000 :
          unit === DurationUnit.Hour ? value * 3600000 : 0;
        if (span > 0) {
          cycleStart = new Date(anchor.getTime() + historicalOrdinal * span);
          guard = historicalOrdinal;
        }
      }
    }
  }
  // The historical lookup horizon is independent of the requested output
  // count. One future result cannot cap a two-year course at 366 cycles.
  const maxCycles = Math.min(positiveInteger(course.cycleCount) ?? Infinity,
    Math.max(366, limit * 366, historicalOrdinal + 366));
  while (guard < maxCycles) {
    const cycleEnd = advance(cycleStart);
    if (!cycleEnd || cycleEnd <= cycleStart) break;
    const sourceClock = repeatedCycleWallClock(calendarCycle, firstClock, cycleStart, timeZone);
    const horizon = repeatedCourseHorizon(singleCycle, cycleStart, cycleEnd, timeZone, sourceClock, options);
    if (horizon > from || rollingUsage) {
      const candidates = scheduleTreatmentRelativeCourse(
        singleCycle,
        {
          ...options,
          // Earlier administrations are history for a rolling limit, not
          // results requested by the caller. Only capped courses do this.
          from: rollingUsage ? cycleStart : from > cycleStart ? from : cycleStart,
          orderedAt: cycleStart,
          priorCount: undefined,
          limit: rollingUsage ? 10000 : limit,
        },
        cycleEnd,
        guard,
        sourceClock,
        rollingUsage
      );
      if (rollingUsage) {
        for (const at of candidates) if (Date.parse(at) >= from.getTime()) results.push(at);
      } else results.push(...candidates);
      // Keep multiplicity: two active cycle components at the same instant
      // are two administrations, not duplicate representation artifacts.
      results.sort((left, right) => Date.parse(left) - Date.parse(right));
      if (results.length > limit) results.length = limit;
    }
    if(rollingUsage)trimRollingCycleHistory(singleCycle,rollingUsage,cycleEnd,timeZone);
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
function hasAlternativeChoice(dosage: Pick<CanonicalAdministration, "choice" | "choiceIssue">): boolean {
  return Boolean(dosage.choice || dosage.choiceIssue);
}
/** Read mandatory membership while preserving malformed input for correction.
 * @param dosage An administration with an explicit choice modifier.
 */
function executionChoice(dosage: CanonicalAdministration) {
  const choice = getDosageAlternativeChoice(dosage);
  if (!choice && hasAlternativeChoice(dosage)) {
    throw new MedicationQuantityCalculationError(
      "invalid-alternative-choice",
      "An alternative-choice modifier has incomplete group/branch data. Edit or clear that choice on the affected dosage before calculating; the original instruction and all branches are retained."
    );
  }
  return choice;
}
/** Resolve exactly-one groups from structured memberships, never source text.
 * Returned execution copies omit the resolved modifier; caller-owned editable
 * dosages and their full retained source are untouched.
 * @param members Every relevant member of the course (possibly three or more branches).
 * @param options Explicit branch choices supplied by the clinician/application.
 */
function selectedAlternativeMembers<T extends CanonicalAdministration>(
  members: readonly T[],
  options: NextDueDoseOptions
): T[] {
  if (!members.some(hasAlternativeChoice)) return [...members];
  const groups = new Map<string, Set<string>>();
  for (const member of members) {
    const choice = executionChoice(member);
    if (!choice) continue;
    const branches = groups.get(choice.groupId) ?? new Set<string>();
    branches.add(choice.branchId);
    groups.set(choice.groupId, branches);
  }
  for (const [group, branches] of groups) {
    const selected = options.alternativeChoices?.[group];
    if (!selected || !branches.has(selected)) {
      const code = selected ? "unknown-alternative-branch" : "alternative-choice-required";
      throw new MedicationQuantityCalculationError(
        code,
        `Choose one branch for '${group}' using alternativeChoices['${group}']: ${[...branches].join(
          ", "
        )}. The alternatives remain editable; both are never administered or summed together.`
      );
    }
  }
  return members
    .filter((member) => {
      const choice = getDosageAlternativeChoice(member);
      return !choice || options.alternativeChoices?.[choice.groupId] === choice.branchId;
    })
    .map((member) =>
      hasAlternativeChoice(member)
        ? {
            ...member,
            choice: undefined,
            choiceIssue: undefined,
          }
        : member
    );
}
/** Keep exact step timing while choosing one branch in a whole course.
 * @param course Native R6 course whose modifier fields survived R5/R6 lowering.
 * @param options Clinician-selected branch ids.
 */
function selectedAlternativeCourse(course: CanonicalCourse, options: NextDueDoseOptions): CanonicalCourse {
  // Ordinary courses stay allocation-free; only an explicit modifier needs
  // group selection. Flatten once, not by repeated growing-array copying.
  if (!course.stages.some((step) => step.administrations.some(hasAlternativeChoice))) return course;
  const members: CanonicalCourse["stages"][number]["administrations"] = [];
  for (const step of course.stages) members.push(...step.administrations);
  // Validate against the WHOLE group, not one component/step at a time.
  selectedAlternativeMembers(members, options);
  return {
    ...course,
    instruction: undefined,
    stages: course.stages
      .map((step) => ({
        ...step,
        administrations: step.administrations
          .filter((component) => {
            const choice = getDosageAlternativeChoice(component);
            return !choice || options.alternativeChoices?.[choice.groupId] === choice.branchId;
          })
          .map((component) =>
            hasAlternativeChoice(component)
              ? {
                  ...component,
                  choice: undefined,
                  choiceIssue: undefined,
                }
              : component
          ),
      }))
      .filter((step) => step.administrations.length > 0),
  };
}
/**
 * Interpret R6 Timing.repeat interlacing offsets for numeric execution only.
 * The authored R6/R5 course remains untouched and editable. The ordinary
 * no-offset route returns by reference, without an extra grammar/validation
 * pass. A single active-window track can use the existing repeat-cycle,
 * relative-step and per-period schedulers without another cadence algorithm.
 * Complex overlapping tracks remain non-executable instead of silently
 * administering outside their explicitly prescribed active window.
 */
function executionCourseWithPeriodOffsets(course: CanonicalCourse): CanonicalCourse {
  const step = course.stages[0];
  const one =
    course.stages.length === 1 && step?.administrations.length === 1 ? step.administrations[0] : undefined;
  const repeat = one?.schedule?.recurrence;
  if (!repeat?.startOffset && !repeat?.endOffset) {
    if (
      one ||
      !course.stages.some((item) =>
        item.administrations.some(
          (component) =>
            component.schedule?.recurrence?.startOffset || component.schedule?.recurrence?.endOffset
        )
      )
    ) {
      return course;
    }
    throw new MedicationQuantityCalculationError(
      "unsupported-r6-period-offset",
      "Interlaced R6 offsets in multiple components or steps cannot be executed reliably; the complete prescription remains editable."
    );
  }
  const fail = (): never => {
    throw new MedicationQuantityCalculationError(
      "unsupported-r6-period-offset",
      "R6 period offsets need a finite day/week cycle with exact active days; the original timing remains available for clinician review."
    );
  };
  if (
    !one ||
    !repeat ||
    step.start ||
    step.end ||
    repeat.frequency === undefined ||
    !Number.isInteger(repeat.frequency) ||
    repeat.frequency <= 1 ||
    repeat.period === undefined ||
    repeat.frequencyMax !== undefined ||
    repeat.periodMax !== undefined ||
    repeat.calendarWindow ||
    repeat.courseLength ||
    repeat.courseLengthRange ||
    repeat.count !== undefined ||
    repeat.countMax !== undefined
  )
    return fail();
  const periodUnit = repeat.periodUnit;
  const periodDays =
    periodUnit === DurationUnit.Day
      ? repeat.period
      : periodUnit === DurationUnit.Week
      ? repeat.period * 7
      : undefined;
  const offsetDays = (quantity: CanonicalMeasure | undefined): number | undefined => {
    if (!quantity) return 0;
    const unit = parseBoundsDurationUnit(quantity);
    // An approximate offset has a usable nominal day. An inequality does
    // not identify one start/rest boundary; never silently make it exact.
    const operator = getQuantityComparator(quantity);
    if ((operator && operator !== "~") || quantity.value === undefined) return undefined;
    return unit === DurationUnit.Day
      ? quantity.value
      : unit === DurationUnit.Week
      ? quantity.value * 7
      : undefined;
  };
  const startDays = offsetDays(repeat.startOffset);
  const endDays = offsetDays(repeat.endOffset);
  const activeDays =
    periodDays !== undefined && startDays !== undefined && endDays !== undefined
      ? periodDays - startDays - endDays
      : undefined;
  const cycleDays = course.cycleInterval ? offsetDays(course.cycleInterval) : periodDays;
  if (
    periodDays === undefined ||
    startDays === undefined ||
    endDays === undefined ||
    activeDays === undefined ||
    cycleDays !== periodDays ||
    !Number.isInteger(periodDays) ||
    !Number.isInteger(startDays) ||
    !Number.isInteger(endDays) ||
    !Number.isInteger(activeDays) ||
    activeDays <= 0 ||
    startDays < 0 ||
    endDays < 0
  )
    return fail();
  const relativeDay = (value: number): CanonicalBoundary => ({
    anchor: "treatment-start",
    displacement: { value, unit: "d", code: "d" },
  });
  const { startOffset: _startOffset, endOffset: _endOffset, ...schedule } = repeat;
  // The existing weekly day-filtered scheduler owns weekday eligibility.
  // Replacing its week with a shorter day period would dispatch to the
  // frequency distributor, which does not apply dayOfWeek restrictions.
  const weekdayFiltered = Boolean(repeat.dayOfWeek?.length);
  if (
    weekdayFiltered &&
    (repeat.periodUnit !== DurationUnit.Week ||
      repeat.period !== 1 ||
      repeat.frequency !== repeat.dayOfWeek?.length ||
      repeat.anchors?.length ||
      repeat.clocks?.length)
  )
    return fail();
  const cadence = weekdayFiltered
    ? schedule
    : {
        ...schedule,
        frequency: repeat.frequency,
        period: activeDays,
        periodUnit: DurationUnit.Day,
      };
  return {
    ...course,
    cycleInterval: course.cycleInterval ?? { value: periodDays, unit: "d", code: "d" },
    stages: [
      {
        ...step,
        start: relativeDay(startDays),
        end: relativeDay(periodDays - endDays),
        administrations: [
          {
            ...one,
            schedule: { ...one.schedule, recurrence: cadence },
          },
        ],
      },
    ],
  };
}
/** Internal phase execution must distinguish recurrence origin from first
 * eligible administration. This never becomes public options or FHIR state. */
type PhaseCountOptions = NextDueDoseOptions & {
  countEligibilityStart?: Date;
  /** Actual doses already counted while replaying a finite capped course. */
  countedActualTimes?: ReadonlySet<number>;
};
function unrecordedCountCandidates(candidates: string[], options: NextDueDoseOptions): string[] {
  const recorded = (options as PhaseCountOptions).countedActualTimes;
  return recorded ? candidates.filter(iso => !recorded.has(Date.parse(iso))) : candidates;
}
export function nextDueDoses(dosage: CanonicalScheduleInput, options: NextDueDoseOptions): string[] {
  if (Array.isArray(dosage))
    return nextDueDoses(courseFromCanonicalRows(selectedAlternativeMembers(dosage, options)), options);
  if (dosage && "stages" in dosage) {
    const course = executionCourseWithPeriodOffsets(
      selectedAlternativeCourse(dosage as CanonicalCourse, options)
    );
    requireExecutableCourseContext(course, "scheduling");
    const zone = options.timeZone ?? options.config?.timeZone;
    if (course.cycleInterval && zone) return scheduleRepeatedCourse(course, options, zone);
    const stage = course.stages.length === 1 ? course.stages[0] : undefined;
    const single = stage?.administrations.length === 1 ? stage.administrations[0] : undefined;
    // A one-administration course has no inter-stage relationship to
    // resolve. This is a proven scalar fast path, not another course model.
    if (single && (stage?.count === undefined || stage.count === 1) && !stage?.start && !stage?.end && !single.phaseOrigin && !single.phaseOriginIssue)
      return nextDueDoses(single, options);
    if (zone && hasRepeatedStep(course) && hasRollingCycleLimit(course)) {
      const events = chronologicalRepeatedEvents(course, options, zone, undefined, options.limit ?? 10);
      return events.map(event => event.iso);
    }
    return scheduleTreatmentRelativeCourse(course, options);
  }
  const one = dosage as CanonicalAdministration;
  requireConsistentTimingCode(one.schedule);
  if (one.phaseOrigin || one.phaseOriginIssue ||
      one.schedule?.recurrence?.startOffset || one.schedule?.recurrence?.endOffset)
    return nextDueDoses(courseFromCanonicalRows([one]), options);
  // The successor's cadence can be anchored to its predecessor's last
  // administration, even though that point belongs to the PREVIOUS phase.
  // Enumerate the first N actual eligible administrations once with the count
  // removed, using the ordinary conditional/capped clock implementation.
  // Late queries filter that same N rather than consuming the old origin.
  const eligibleAt = (options as PhaseCountOptions).countEligibilityStart;
  const repeatForCount = one.schedule?.recurrence;
  // countMax is a maximum allowance, not a finite authored sequence of
  // administrations. Only a definite count can define a successor's phase
  // completion and eligibility-owned count.
  const finiteCount = hasDefiniteAdministrationCount(repeatForCount)
    ? repeatOccurrenceCap(repeatForCount)
    : undefined;
  // A recurrence's total count is another allowance on ADMINISTERED doses.
  // A periodic/quantity cap must not spend it on rejected raw opportunities.
  // countMax participates here as a ceiling, without becoming a phase-end
  // promise. A one-time count-only instruction keeps its unique identity.
  const capCount = repeatForCount &&
      (repeatForCount.count !== undefined || repeatForCount.countMax !== undefined) &&
      !isSingleAdministrationRepeat(repeatForCount) &&
      (hasPeriodLimits(one) || getTimingOccurrenceCap(repeatForCount))
    ? repeatOccurrenceCap(repeatForCount) : undefined;
  const acceptedCount = eligibleAt && !one.asNeeded ? finiteCount : capCount;
  if (acceptedCount !== undefined) {
    const requestedLimit = options.limit ?? 10;
    if (!Number.isFinite(requestedLimit) || requestedLimit <= 0) return [];
    if (options.priorCount !== undefined && (!Number.isFinite(options.priorCount) || options.priorCount < 0))
      throw new Error("Invalid priorCount supplied to nextDueDoses");
    const requestedFrom = coerceDate(options.from, "from");
    const zone = options.timeZone ?? options.config?.timeZone;
    if (!zone) throw new Error("A timeZone is required for counted capped scheduling");
    const origin = eligibleAt ?? resolveRepeatBoundsStart(repeatForCount, zone) ??
      (options.orderedAt === undefined ? requestedFrom : coerceDate(options.orderedAt, "orderedAt"));
    let used = options.priorCount ?? 0;
    let countedActualTimes: Set<number> | undefined;
    if (options.priorCount === undefined) {
      // Actual history consumes the total count once. A coincident planned
      // event is the same administration, so omit it from inferred replay
      // before either rolling or occurrence ceilings are admitted.
      for (const stamp of options.priorDoseTimes ?? []) {
        const actual = coerceDate(stamp, "priorDoseTimes");
        if (actual >= origin && actual < requestedFrom) {
          used++;
          (countedActualTimes ??= new Set()).add(actual.getTime());
        }
      }
    }
    const available = Math.max(0, acceptedCount - Math.floor(used));
    if (!available) return [];
    const capped = Math.min(available, 10000);
    const uncapped: CanonicalAdministration = {
      ...one,
      schedule: {
        ...one.schedule,
        recurrence: {
          ...repeatForCount,
          count: undefined,
          countMax: undefined,
        },
      },
    };
    const candidates = nextDueDoses(uncapped, {
      ...options,
      countEligibilityStart: undefined,
      countedActualTimes,
      priorCount: undefined,
      from: one.asNeeded || (options.priorCount !== undefined && !eligibleAt)
        ? requestedFrom : origin,
      limit: capped,
    } as PhaseCountOptions);
    if (available > capped && candidates.length === capped)
      throw new MedicationQuantityCalculationError(
        "schedule-horizon-too-dense",
        "A counted successor exceeds 10,000 eligible administrations; shorten the clinically verified window."
      );
    return candidates
      .filter((iso) => Date.parse(iso) >= requestedFrom.getTime())
      .slice(0, Math.floor(requestedLimit));
  }
  const choice = executionChoice(one);
  if (choice) {
    const selected = options.alternativeChoices?.[choice.groupId];
    if (!selected) {
      throw new MedicationQuantityCalculationError(
        "alternative-choice-required",
        `Select a branch for '${choice.groupId}' in alternativeChoices before scheduling. This dosage is '${choice.branchId}'; all alternatives remain editable.`
      );
    }
    if (selected !== choice.branchId) return [];
    return nextDueDoses(
      {
        ...one,
        choice: undefined,
        choiceIssue: undefined,
      },
      options
    );
  }
  const administrationOffset = getAdministrationOffsetMinutes(one);
  if (administrationOffset !== undefined) {
    const zone = options.timeZone ?? options.config?.timeZone;
    if (!zone) throw new Error("A timeZone is required for administration offsets");
    const delta = administrationOffset * 60000;
    const shifted = (value: Date | string, amount: number) =>
      formatZonedIso(new Date(coerceDate(value, "administration time").getTime() + amount), zone);
    const base: CanonicalAdministration = {
      ...one,
      delayMinutes: undefined,
    };
    return nextDueDoses(base, {
      ...options,
      from: shifted(options.from, -delta),
      priorDoseTimes: options.priorDoseTimes?.map((value) => shifted(value, -delta)),
      evaluateCondition: options.evaluateCondition
        ? (condition, at) => options.evaluateCondition!(condition, shifted(at, delta))
        : undefined,
    }).map((value) => shifted(value, delta));
  }
  if (unscheduledOccurrenceCapacity(one)) return [];
  const guard = getDosageCondition(one);
  const exclusions = getDosageExcludedDates(one);
  // Small exclusion sets are common; avoid allocating a Set for one date.
  // Larger lists must not perform O(doses × excludedDates) array searches.
  const excludedDateSet = exclusions.length > 1 ? new Set(exclusions) : undefined;
  const excludedWeekdays = new Set<string>(getDosageExcludedWeekdays(one));
  if (guard || exclusions.length || excludedWeekdays.size) {
    const limit = options?.limit ?? 10;
    if (!Number.isFinite(limit) || limit <= 0) return [];
    // A fully excluded week has no administration opportunities. This follows
    // the typed exclusion set; the prescription remains editable, and the
    // source and original cadence are not silently rewritten.
    if (Object.keys(WEEKDAY_TEXT).every((day) => excludedWeekdays.has(WEEKDAY_TEXT[day]))) {
      return [];
    }
    const timeZone = options?.timeZone ?? options?.config?.timeZone;
    if (!timeZone) throw new Error("A timeZone is required for excluded-date/weekday scheduling");
    const from = coerceDate(options.from, "from");
    // Native EzDosage mirrors conditional/date semantics as direct fields
    // AND in R5 modifiers. Clear both representations before enumerating
    // candidate times, otherwise recursively re-enter this very filter.
    const {
      predicate: _condition,
      excludedDates: _excludedDates,
      excludedWeekdays: _excludedWeekdays,
      ...plainDosage
    } = one;
    const quantityCaps = executableQuantityCaps(one, (options as Partial<CanonicalSupplyOptions>).context);
    const occurrenceCap = getTimingOccurrenceCap(one.schedule?.recurrence);
    // The cap is an allowance for *administered* doses, not for candidate
    // opportunities. Remove it while evaluating exclusions and conditions,
    // then apply it to the accepted administrations below.
    const sourceRepeat = one.schedule?.recurrence;
    const exactCount = hasDefiniteAdministrationCount(sourceRepeat) && !one.asNeeded
      ? repeatOccurrenceCap(sourceRepeat) : undefined;
    const maximumEligible = exactCount === undefined ? undefined
      : Math.max(0, exactCount - Math.floor(options.priorCount ?? 0));
    if (maximumEligible === 0) return [];
    // The exact administration count belongs to accepted doses, NOT to
    // Tuesday/PRN opportunities later excluded by the clinician's predicate.
    // Evaluate a finite course from its stable order/bounds origin even when
    // the caller queries midway through treatment. Never re-anchor at from.
    const sourceOrigin = exactCount === undefined ? undefined :
      resolveRepeatBoundsStart(sourceRepeat, timeZone) ??
      (options.orderedAt === undefined ? from : coerceDate(options.orderedAt, "orderedAt"));
    // An explicit priorCount is the caller's already-consumed history.
    // Do not recount those same earlier administrations while also
    // subtracting them. Without priorCount, replay from the authored
    // origin to infer exact accepted administrations after exclusions.
    const eligibleFrom = options.priorCount !== undefined
      ? from : sourceOrigin && sourceOrigin < from ? sourceOrigin : from;
    const unconstrained: CanonicalAdministration = withoutOccurrenceCap({
      ...plainDosage,
      limits: one.limits?.filter((item) => item.scope !== "period"),
      ...(exactCount !== undefined && sourceRepeat && !isSingleAdministrationRepeat(sourceRepeat) ? {
        // Only multi-opportunity recurrences need their count removed
        // while evaluating eligibility. An authored one-time count=1
        // has NO cadence without this identity; keep its unique instant.
        schedule: { ...one.schedule, recurrence: {
          ...sourceRepeat, count: undefined, countMax: undefined
        } }
      } : {}),
      predicate: undefined,
      excludedDates: undefined,
      excludedWeekdays: undefined,
    });
    let candidateLimit = Math.min(10000,
      Math.max(16, Math.floor((maximumEligible ?? limit) * 2)));
    while (true) {
      const candidates = nextDueDoses(unconstrained, {
        ...options, from: eligibleFrom, priorCount: undefined, limit: candidateLimit,
      });
      const accepted: string[] = [];
      for (const at of candidates) {
        if (excludedWeekdays.size && excludedWeekdays.has(getLocalWeekday(new Date(at), timeZone))) {
          continue;
        }
        if (exclusions.length) {
          const { year, month, day } = getTimeParts(new Date(at), timeZone);
          const localDate = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
          if (excludedDateSet ? excludedDateSet.has(localDate) : exclusions[0] === localDate) continue;
        }
        if (guard && options.evaluateCondition) {
          const eligible = options.evaluateCondition(guard, at);
          if (!eligible) continue;
        }
        accepted.push(at);
        if (!quantityCaps.length && !occurrenceCap &&
            accepted.length >= (maximumEligible ?? limit)) break;
      }
      // A conditionally withheld/excluded dose does not consume either cap.
      // Nor may a dose rejected by one cap consume the other's allowance.
      // Commit the eligible candidate only after every authored cap accepts it.
      const capped = applyQuantityCaps(
        unrecordedCountCandidates(accepted, options),
        quantityCaps,
        options.priorDoseTimes,
        timeZone,
        maximumEligible ?? limit,
        occurrenceCap
      );
      // Date queries after the treatment start must not count prior accepted
      // doses as new results, but they still consume the source count.
      const relevant: string[] = [];
      for (const instant of capped) if (Date.parse(instant) >= from.getTime()) {
        relevant.push(instant);
        if (relevant.length >= limit) break;
      }
      if (relevant.length >= limit ||
          (maximumEligible !== undefined && capped.length >= maximumEligible) ||
          candidates.length < candidateLimit || candidateLimit === 10000) {
        return relevant;
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
function intervalEventWindow(repeat: CanonicalRecurrence | undefined):
  | {
      start: TimingEvent;
      end: TimingEvent;
    }
  | undefined {
  if (
    !repeat ||
    (repeat.clocks?.length ?? 0) !== 0 ||
    !usesIntervalCadence(repeat) ||
    (repeat.periodUnit !== DurationUnit.Second &&
      repeat.periodUnit !== DurationUnit.Minute &&
      repeat.periodUnit !== DurationUnit.Hour)
  )
    return undefined;
  const typed = getTimingEventWindow(repeat);
  if (typed) return typed;
  const when = repeat.anchors;
  return when?.length === 1 && when[0] === TimingEvent.Wake
    ? { start: TimingEvent.Wake, end: TimingEvent["Before Sleep"] }
    : undefined;
}
function isWakingHoursInterval(repeat: CanonicalRecurrence | undefined): boolean {
  return (
    intervalEventWindow(repeat) !== undefined ||
    Boolean(getTimingClockWindow(repeat) && repeat && usesIntervalCadence(repeat))
  );
}
/** Execute WAKE as the daily recurrence origin and HS as the exclusive end of
 * the caller's configured waking window. Absent clocks are never guessed. */
function generateWakingHoursIntervalSeries(
  repeat: CanonicalRecurrence,
  config: NextDueDoseConfig,
  from: Date,
  orderedAt: Date | null,
  courseEnd: Date | null,
  timeZone: string,
  limit: number,
  dayFilter: Set<string>,
  enforceDayFilter: boolean,
  calendarDays: CalendarDaySelection | undefined
): string[] | undefined {
  const window = intervalEventWindow(repeat);
  const clockWindow = usesIntervalCadence(repeat) ? getTimingClockWindow(repeat) : undefined;
  if (!window && !clockWindow) return undefined;
  const wakeValue = clockWindow?.start ?? (window && config.eventClock?.[window.start]);
  const sleepValue = clockWindow?.end ?? (window && config.eventClock?.[window.end]);
  const includeEnd = clockWindow?.endInclusive ?? false;
  if (!wakeValue || !sleepValue) {
    throw new Error("Cannot execute a waking-hours interval without configured WAKE and HS event clocks");
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
  while (results.length < limit && dayIterations < maxDays && (!courseEnd || currentDay < courseEnd)) {
    if (
      (!firstTreatmentDay || currentDay >= firstTreatmentDay) &&
      matchesCalendarDay(currentDay, dayFilter, enforceDayFilter, calendarDays, timeZone)
    ) {
      const wake = makeZonedDateFromDay(currentDay, timeZone, wakeClock);
      const sleepDay = overnight ? addLocalDays(currentDay, 1, timeZone) : currentDay;
      const sleep = makeZonedDateFromDay(sleepDay, timeZone, sleepClock);
      if (!wake || !sleep || sleep <= wake) {
        throw new Error("Cannot execute a waking-hours interval unless configured WAKE precedes HS");
      }
      let candidate = wake;
      let intervalIterations = 0;
      while (
        (candidate < sleep || (includeEnd && candidate.getTime() === sleep.getTime())) &&
        intervalIterations < 10000
      ) {
        if (
          candidate >= from &&
          (!orderedAt || candidate >= orderedAt) &&
          (!courseEnd || candidate < courseEnd)
        ) {
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
function requireResolvedCycleDays(dosage: CanonicalAdministration): void {
  const cycle = getCycleDayConstraint(dosage);
  if (cycle) {
    throw new MedicationQuantityCalculationError(
      "unresolved-cycle-eligibility",
      `Cannot calculate cycle-day administrations until the cycle is resolved (${cycle.reason}). The dose, route, timing and source remain editable.`
    );
  }
}
function nextDueDosesSingle(dosage: CanonicalAdministration, options: NextDueDoseOptions): string[] {
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
  const orderedAt = options.orderedAt === undefined ? null : coerceDate(options.orderedAt, "orderedAt");
  const priorCountInput = options.priorCount;
  if (priorCountInput !== undefined) {
    if (!Number.isFinite(priorCountInput) || priorCountInput < 0) {
      throw new Error("Invalid priorCount supplied to nextDueDoses");
    }
  }
  let priorCount = priorCountInput !== undefined ? Math.floor(priorCountInput) : 0;
  // A PRN opportunity is not proof of administration. Apply known history
  // when supplied; otherwise enumerate the maximum remaining opportunity set.
  const prnCountCapped =
    !!dosage.asNeeded &&
    (dosage.schedule?.recurrence?.count !== undefined || dosage.schedule?.recurrence?.countMax !== undefined);
  if (prnCountCapped && orderedAt && from > orderedAt && priorCountInput === undefined) {
    for (const stamp of options.priorDoseTimes ?? []) {
      const actual = coerceDate(stamp, "priorDoseTimes");
      if (actual >= orderedAt && actual < from) priorCount++;
    }
  }
  const needsDerivedPriorCount = priorCountInput === undefined && !!orderedAt && !dosage.asNeeded;
  const providedConfig = options.config;
  const timeZone = options.timeZone ?? providedConfig?.timeZone;
  if (!timeZone) {
    throw new Error("Configuration with a valid timeZone is required");
  }
  dosage = prepareBestEffortTiming(dosage);
  const quantityCaps = executableQuantityCaps(dosage, (options as Partial<CanonicalSupplyOptions>).context);
  if (quantityCaps.length) {
    const requestLimit = Math.floor(limit);
    let candidateLimit = Math.min(10000, Math.max(16, requestLimit * 4));
    const occurrence = getTimingOccurrenceCap(dosage.schedule?.recurrence);
    const unsafeguarded: CanonicalAdministration = withoutOccurrenceCap({
      ...dosage,
      limits: dosage.limits?.filter((limit) => limit.scope !== "period"),
    });
    while (true) {
      const candidates = nextDueDoses(unsafeguarded, { ...options, limit: candidateLimit });
      const accepted = applyQuantityCaps(
        unrecordedCountCandidates(candidates, options),
        quantityCaps,
        options.priorDoseTimes,
        timeZone,
        requestLimit,
        occurrence
      );
      if (accepted.length >= requestLimit || candidates.length < candidateLimit || candidateLimit >= 10000)
        return accepted;
      candidateLimit = Math.min(10000, candidateLimit * 2);
    }
  }
  const occurrenceCap = getTimingOccurrenceCap(dosage.schedule?.recurrence);
  if (occurrenceCap) {
    const requestedLimit = Math.floor(limit);
    let candidateLimit = Math.min(10000, Math.max(16, requestedLimit * 4));
    while (true) {
      const uncapped = nextDueDoses(withoutOccurrenceCap(dosage), {
        ...options,
        limit: candidateLimit,
        priorDoseTimes: undefined,
      });
      const capped = applyOccurrenceCap(
        unrecordedCountCandidates(uncapped, options),
        occurrenceCap,
        options.priorDoseTimes,
        timeZone,
        requestedLimit
      );
      if (capped.length >= requestedLimit || uncapped.length < candidateLimit || candidateLimit >= 10000)
        return capped;
      candidateLimit = Math.min(10000, candidateLimit * 2);
    }
  }
  const eventClock: EventClockMap = {
    ...(providedConfig?.eventClock ?? {}),
    ...(options.eventClock ?? {}),
  };
  const mealOffsets: MealOffsetMap = {
    ...(providedConfig?.mealOffsets ?? {}),
    ...(options.mealOffsets ?? {}),
  };
  const frequencyDefaults = mergeFrequencyDefaults(
    providedConfig?.frequencyDefaults,
    options.frequencyDefaults
  );
  const config: NextDueDoseConfig = {
    timeZone,
    eventClock,
    mealOffsets,
    frequencyDefaults,
  };
  const timing: CanonicalTiming | undefined = dosage.schedule;
  const repeat: CanonicalRecurrence | undefined = timing?.recurrence;
  const boundsPeriod = validateRepeatBoundsPeriod(repeat, timeZone);
  const boundsStart = boundsPeriod.start;
  if (boundsStart && boundsStart > from) {
    from = boundsStart;
  }
  const effectiveOrderedAt = orderedAt && boundsStart && boundsStart > orderedAt ? boundsStart : orderedAt;
  const baseCandidate = effectiveOrderedAt ?? boundsStart ?? from;
  const baseTime = boundsStart && boundsStart > baseCandidate ? boundsStart : baseCandidate;
  const courseEnd =
    timing && repeat
      ? earlierDate(resolveRepeatDurationCapEnd(dosage, baseTime, timeZone), boundsPeriod.end)
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
  const effectiveLimit = remainingCount !== undefined ? Math.min(limit, remainingCount) : limit;
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
  const calendarDays = resolveCalendarDaySelection(repeat, baseTime, timeZone);
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
    calendarDays
  );
  if (wakingHours) return wakingHours;
  const elapsedOrigin = clockAnchoredElapsedOrigin(repeat, baseTime, timeZone);
  if (elapsedOrigin) {
    return generateIntervalSeries(
      elapsedOrigin,
      from,
      effectiveLimit,
      repeat,
      timeZone,
      dayFilter,
      enforceDayFilter,
      orderedAt,
      courseEnd,
      calendarDays
    );
  }
  const whenCodes = repeat.anchors ?? [];
  const timeOfDayEntries = repeat.clocks ?? [];
  if (whenCodes.length > 0 || timeOfDayEntries.length > 0) {
    const cadenceAnchor = resolveRepeatBoundsStart(repeat, timeZone) ?? orderedAt ?? from;
    const expanded = resolveExplicitClockEntries(repeat, config, enforceDayFilter);
    const includesImmediate = arrayIncludes(whenCodes, TimingEvent.Immediate);
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
      if (hasDistributedClockFrequency(repeat, expanded, enforceDayFilter)) {
        return results
          .concat(
            generateFrequencyPerPeriodSeries(
              startOfLocalDay(cadenceAnchor, timeZone),
              from,
              effectiveLimit - results.length,
              repeat,
              timeZone,
              orderedAt,
              courseEnd,
              expanded,
              calendarDays
            )
          )
          .slice(0, effectiveLimit);
      }
      let currentDay = firstClockAnchorDay(from, expanded, timeZone, orderedAt);
      const firstShift = expanded[0].dayShift;
      // Shifted anchors can interlace adjacent source days. Merge only that
      // family before spending result limits or the caller's cap allowance.
      const pending = firstShift !== expanded[expanded.length - 1].dayShift
        ? new ChronologicalQueue<ChronologicalEvent>() : undefined;
      let serial = 0;
      let iterations = 0;
      const maxIterations = calendarScanLimit(currentDay, courseEnd, effectiveLimit) + Math.max(0, -firstShift);
      while (
        results.length < effectiveLimit &&
        iterations < maxIterations &&
        (!courseEnd || (firstShift < 0 ? addLocalDays(currentDay, firstShift, timeZone) : currentDay) < courseEnd)
      ) {
        if (
          matchesCalendarDay(currentDay, dayFilter, enforceDayFilter, calendarDays, timeZone) &&
          clockCadenceEligible(currentDay, cadenceAnchor, repeat, timeZone, enforceDayFilter)
        ) {
          for (const entry of expanded) {
            const targetDay =
              entry.dayShift === 0 ? currentDay : addLocalDays(currentDay, entry.dayShift, timeZone);
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
              if (pending) pending.push({ at: zoned.getTime(), iso, serial: serial++ });
              else results.push(iso);
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
        if (pending) {
          const before = (firstShift === 0 ? currentDay : addLocalDays(currentDay, firstShift, timeZone)).getTime();
          while (pending.first() && pending.first()!.at < before && results.length < effectiveLimit)
            results.push(pending.pop()!.iso);
        }
        iterations += 1;
      }
      while (pending?.first() && results.length < effectiveLimit) results.push(pending.pop()!.iso);
      return results.slice(0, effectiveLimit);
    }
  }
  const treatAsInterval = usesIntervalCadence(repeat);
  const supportsDayFilteredInterval = isDayFilteredIntervalSupported(repeat, enforceDayFilter);
  if (treatAsInterval && supportsDayFilteredInterval) {
    // Known code/repeat conflicts were rejected before dispatch. A compatible
    // interval recurrence advances from the order start in fixed units.
    const candidates = generateIntervalSeries(
      baseTime,
      from,
      effectiveLimit,
      repeat,
      timeZone,
      dayFilter,
      enforceDayFilter,
      orderedAt,
      courseEnd,
      calendarDays
    );
    return candidates;
  }
  if (dayFilteredSeriesRepeat) {
    return generateDayFilteredPeriodSeries({
      recurrence: dayFilteredSeriesRepeat,
      timeZone,
      dayFilter,
      anchorDay: startOfLocalDay(baseTime, timeZone),
      startDay: from,
      from,
      to: courseEnd ?? undefined,
      orderedAt,
      limit: effectiveLimit,
      defaultClock: toLocalClock(baseTime, timeZone),
      calendarDays,
    }).slice(0, effectiveLimit);
  }
  if (repeat.frequency && repeat.period && repeat.periodUnit) {
    // Pure frequency schedules (e.g., BID/TID) rely on institution clocks that
    // clinicians expect. These can be overridden via configuration when
    // facilities use bespoke medication rounds.
    const clocks = resolveFrequencyClocks(timing, config);
    const codedDaily = recognizedDailyTimingCode(timing) !== undefined;
    const ordinaryDaily = repeat.period === 1 && repeat.periodUnit === DurationUnit.Day;
    if (!codedDaily && !ordinaryDaily) {
      return generateFrequencyPerPeriodSeries(
        baseTime,
        from,
        effectiveLimit,
        repeat,
        timeZone,
        orderedAt,
        courseEnd,
        clocks,
        calendarDays
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
      if (matchesCalendarDay(currentDay, dayFilter, enforceDayFilter, calendarDays, timeZone)) {
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
  dosage: CanonicalAdministration,
  timing: CanonicalTiming,
  repeat: CanonicalRecurrence,
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
  const calendarDays = resolveCalendarDaySelection(repeat, orderedAt, timeZone);
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
  const waking = generateWakingHoursIntervalSeries(repeat, config, orderedAt,
    orderedAt, from, timeZone, normalizedCount ?? 100000, dayFilter,
    enforceDayFilter, calendarDays);
  if (waking) return waking.length;
  const elapsedOrigin = clockAnchoredElapsedOrigin(
    repeat,
    resolveRepeatBoundsStart(repeat, timeZone) ?? orderedAt,
    timeZone
  );
  if (elapsedOrigin) {
    return generateIntervalSeries(
      elapsedOrigin,
      orderedAt,
      normalizedCount ?? 100000,
      repeat,
      timeZone,
      dayFilter,
      enforceDayFilter,
      orderedAt,
      from,
      calendarDays
    ).length;
  }
  const whenCodes = repeat.anchors ?? [];
  const timeOfDayEntries = repeat.clocks ?? [];
  if (whenCodes.length > 0 || timeOfDayEntries.length > 0) {
    const cadenceAnchor = resolveRepeatBoundsStart(repeat, timeZone) ?? orderedAt ?? from;
    const expanded = resolveExplicitClockEntries(repeat, config, enforceDayFilter);
    if (arrayIncludes(whenCodes, TimingEvent.Immediate)) {
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
      if (hasDistributedClockFrequency(repeat, expanded, enforceDayFilter)) {
        return (
          count +
          generateFrequencyPerPeriodSeries(
            startOfLocalDay(cadenceAnchor, timeZone),
            orderedAt,
            (normalizedCount ?? 100000) - count,
            repeat,
            timeZone,
            orderedAt,
            from,
            expanded,
            calendarDays
          ).length
        );
      }
      let currentDay = startOfLocalDay(orderedAt, timeZone);
      let iterations = 0;
      const maxIterations = calendarScanLimit(currentDay, from, normalizedCount ?? 1);
      while (currentDay < from && iterations < maxIterations) {
        if (
          matchesCalendarDay(currentDay, dayFilter, enforceDayFilter, calendarDays, timeZone) &&
          clockCadenceEligible(currentDay, cadenceAnchor, repeat, timeZone, enforceDayFilter)
        ) {
          for (const entry of expanded) {
            const targetDay =
              entry.dayShift === 0 ? currentDay : addLocalDays(currentDay, entry.dayShift, timeZone);
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
  const supportsDayFilteredInterval = isDayFilteredIntervalSupported(repeat, enforceDayFilter);
  if (treatAsInterval && supportsDayFilteredInterval) {
    const increment = createIntervalStepper(repeat, timeZone);
    if (!increment) {
      return count;
    }
    let current = orderedAt;
    let guard = 0;
    const maxIterations = normalizedCount !== undefined ? normalizedCount * 1000 : 1000;
    while (current < from && guard < maxIterations) {
      if (matchesCalendarDay(current, dayFilter, enforceDayFilter, calendarDays, timeZone)) {
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
      recurrence: dayFilteredSeriesRepeat,
      timeZone,
      dayFilter,
      anchorDay: startOfLocalDay(orderedAt, timeZone),
      startDay: orderedAt,
      from: orderedAt,
      to: from,
      orderedAt,
      limit: normalizedCount ?? 31 * 365,
      defaultClock: toLocalClock(orderedAt, timeZone),
      calendarDays,
    });
    return count + generated.length;
  }
  if (repeat.frequency && repeat.period && repeat.periodUnit) {
    const clocks = resolveFrequencyClocks(timing, config);
    const codedDaily = recognizedDailyTimingCode(timing) !== undefined;
    const ordinaryDaily = repeat.period === 1 && repeat.periodUnit === DurationUnit.Day;
    if (!codedDaily && !ordinaryDaily) {
      return (
        count +
        generateFrequencyPerPeriodSeries(
          orderedAt,
          orderedAt,
          normalizedCount ?? 100000,
          repeat,
          timeZone,
          orderedAt,
          from,
          clocks,
          calendarDays
        ).length
      );
    }
    if (clocks.length === 0) {
      return count;
    }
    let currentDay = startOfLocalDay(orderedAt, timeZone);
    let iterations = 0;
    const maxIterations = calendarScanLimit(currentDay, from, normalizedCount ?? 1);
    while (currentDay < from && iterations < maxIterations) {
      if (matchesCalendarDay(currentDay, dayFilter, enforceDayFilter, calendarDays, timeZone)) {
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
function clockAnchoredElapsedOrigin(
  repeat: CanonicalRecurrence,
  baseTime: Date,
  timeZone: string
): Date | undefined {
  if (
    repeat.clocks?.length !== 1 ||
    repeat.anchors?.length ||
    (repeat.periodUnit !== DurationUnit.Second &&
      repeat.periodUnit !== DurationUnit.Minute &&
      repeat.periodUnit !== DurationUnit.Hour) ||
    !usesIntervalCadence(repeat)
  )
    return undefined;
  const clock = normalizeClock(repeat.clocks[0]);
  const day = startOfLocalDay(baseTime, timeZone);
  const first = makeZonedDateFromDay(day, timeZone, clock);
  if (first && first >= baseTime) return first;
  return makeZonedDateFromDay(addLocalDays(day, 1, timeZone), timeZone, clock) ?? undefined;
}
/** Seek by source recurrence arithmetic, NOT by the requested output limit.
 * Elapsed seconds/minutes/hours jump by a fixed timestamp multiplier. Whole
 * civil days/weeks jump by calendar day count with the original clock; month
 * jumps are safe when month-end clipping cannot change the anchor day.
 * All irregular calendar intervals retain their real stepper semantics.
 * This is only an initial position; eligibility and caps remain untouched. */
function seekIntervalNearQuery(
  base: Date, from: Date, repeat: CanonicalRecurrence, zone: string
): Date {
  if (from <= base || !repeat.period || !repeat.periodUnit) return base;
  const unit = repeat.periodUnit;
  const elapsedUnit =
    unit === DurationUnit.Second ? 1000 :
    unit === DurationUnit.Minute ? 60000 :
    unit === DurationUnit.Hour ? 3600000 : undefined;
  if (elapsedUnit !== undefined) {
    const increment = repeat.period * elapsedUnit;
    const count = Math.max(0, Math.floor((from.getTime() - base.getTime()) / increment));
    return new Date(base.getTime() + count * increment);
  }
  const clock = getTimeParts(base, zone);
  const wholeDays =
    unit === DurationUnit.Day ? repeat.period :
    unit === DurationUnit.Week ? repeat.period * 7 : undefined;
  if (wholeDays !== undefined && Number.isInteger(wholeDays)) {
    const elapsedDays = getLocalDayNumber(from, zone) - getLocalDayNumber(base, zone);
    const count = Math.max(0, Math.floor(elapsedDays / wholeDays) - 1);
    return count ? addCalendarDaysAtClock(base, count * wholeDays, zone, clock) ?? base : base;
  }
  const months = unit === DurationUnit.Month ? repeat.period
    : unit === DurationUnit.Year ? repeat.period * 12 : undefined;
  if (months !== undefined && Number.isInteger(months) && clock.day <= 28) {
    const elapsedMonths = getLocalMonthIndex(from, zone) - getLocalMonthIndex(base, zone);
    const count = Math.max(0, Math.floor(elapsedMonths / months) - 1);
    return count ? addCalendarMonths(base, count * months, zone, clock) : base;
  }
  return base;
}

/**
 * Generates an interval-based series by stepping forward from the base time
 * until the requested number of timestamps have been produced.
 */
function generateIntervalSeries(
  baseTime: Date,
  from: Date,
  effectiveLimit: number,
  repeat: CanonicalRecurrence,
  timeZone: string,
  dayFilter: Set<string>,
  enforceDayFilter: boolean,
  orderedAt: Date | null,
  upperBound?: Date | null,
  calendarDays?: CalendarDaySelection
): string[] {
  const increment = createIntervalStepper(repeat, timeZone);
  if (!increment) {
    return [];
  }
  const results: string[] = [];
  const seen = new Set<string>();
  let current = seekIntervalNearQuery(baseTime, from, repeat, timeZone);
  // The day/month stepper captures its source clock on the FIRST call.
  // Seed it from the true anchor, not a DST-shifted jump target.
  if (current !== baseTime) increment(baseTime);
  let guard = 0;
  // The lookback is a separate concern from the number of emitted results.
  // A one-result request made months later is not a 1000-step history budget.
  while (current < from) {
    const next = increment(current);
    if (!next || next.getTime() === current.getTime()) break;
    current = next;
  }
  const maxIterations = effectiveLimit * 1000;
  while (results.length < effectiveLimit && guard < maxIterations && (!upperBound || current < upperBound)) {
    if (matchesCalendarDay(current, dayFilter, enforceDayFilter, calendarDays, timeZone)) {
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
  repeat: CanonicalRecurrence,
  timeZone: string,
  orderedAt: Date | null,
  upperBound?: Date | null,
  clocks: readonly (string | ClockEntry)[] = [],
  calendarDays?: CalendarDaySelection
): string[] {
  const frequency = positiveInteger(repeat.frequency);
  const period = positiveNumber(repeat.period);
  const periodUnit = repeat.periodUnit;
  if (!frequency || !period || !periodUnit || effectiveLimit <= 0) return [];
  // Explicit calendar clocks own the same hour across a DST boundary.
  // Only exact per-day clock schedules take this branch: ordinary elapsed
  // intervals and generic frequency distributions keep their old semantics.
  const dayCount =
    periodUnit === DurationUnit.Day ? period : periodUnit === DurationUnit.Week ? period * 7 : undefined;
  const exactDailyClocks =
    dayCount !== undefined &&
    Number.isInteger(dayCount) &&
    clocks.length > 0 &&
    frequency === dayCount * clocks.length;
  // An integral FHIR day/week period is a CALENDAR interval even with no
  // specified clock: q7d/once-weekly preserves the source local clock at
  // DST, just like 7/21d and 42/21d. Only explicit hour/minute/second units
  // (q24h/q168h), fractional periods and other elapsed definitions drift.
  const clocklessCalendarPeriod =
    dayCount !== undefined && Number.isInteger(dayCount) && dayCount >= 1 && clocks.length === 0;
  const advanceCycle =
    exactDailyClocks || clocklessCalendarPeriod
      ? calendarDayStepper(baseTime, dayCount!, timeZone)
      : createIntervalStepper({ period, periodUnit }, timeZone);
  const implicitClock = clocklessCalendarPeriod ? toLocalClock(baseTime, timeZone) : undefined;
  if (!advanceCycle) return [];
  const results: string[] = [];
  const seen = new Set<string>();
  let earliestDayShift = 0;
  let latestDayShift = 0;
  for (const entry of clocks)
    if (typeof entry === "object") {
      earliestDayShift = Math.min(earliestDayShift, entry.dayShift);
      latestDayShift = Math.max(latestDayShift, entry.dayShift);
    }
  let cycleStart = baseTime;
  let guard = 0;
  const maxCycles = Math.max(366, effectiveLimit * 366);
  while (guard < maxCycles) {
    const next = advanceCycle(cycleStart);
    if (!next || next <= cycleStart) return results;
    if ((latestDayShift ? addLocalDays(next, latestDayShift, timeZone) : next) > from) break;
    cycleStart = next;
    guard += 1;
  }
  while (
    results.length < effectiveLimit &&
    guard < maxCycles &&
    (!upperBound ||
      (earliestDayShift ? addLocalDays(cycleStart, earliestDayShift, timeZone) : cycleStart) < upperBound)
  ) {
    const cycleEnd = advanceCycle(cycleStart);
    if (!cycleEnd || cycleEnd <= cycleStart) break;
    const calendarUnit =
      periodUnit === DurationUnit.Day ||
      periodUnit === DurationUnit.Week ||
      periodUnit === DurationUnit.Month ||
      periodUnit === DurationUnit.Year;
    const spanDays = calendarUnit
      ? Math.max(1, getLocalDayNumber(cycleEnd, timeZone) - getLocalDayNumber(cycleStart, timeZone))
      : 0;
    const baseClock = implicitClock ?? toLocalClock(cycleStart, timeZone);
    // Explicit daily clocks must remain authoritative when a multi-day
    // frequency is their exact total (e.g. 42 doses/21 days at 08:00/20:00).
    // Without a matching clock count, retain the existing distributor.
    const clockedDays = calendarUnit && clocks.length > 0 && frequency === spanDays * clocks.length;
    // A cycle may begin partway through a local day. The first day's
    // earlier clocks are excluded, but the following boundary day's
    // earlier clocks still belong to this cycle. Inspect that final
    // partial day instead of silently scheduling one dose fewer.
    const candidates = frequency + (clockedDays ? clocks.length : 0);
    for (let index = 0; index < candidates && results.length < effectiveLimit; index++) {
      let candidate: Date | null;
      let shiftedClock = false;
      if (calendarUnit && (frequency <= spanDays || clockedDays || clocklessCalendarPeriod)) {
        const entry = clocks[index % Math.max(1, clocks.length)];
        const dayShift = typeof entry === "object" ? entry.dayShift : 0;
        shiftedClock = dayShift !== 0;
        // Cross-midnight shifted clocks are already accounted for by their
        // source day; an extra shifted anchor could invent a next-cycle dose.
        if (index >= frequency && shiftedClock) continue;
        const day = addLocalDays(
          startOfLocalDay(cycleStart, timeZone),
          (clockedDays ? Math.floor(index / clocks.length) : Math.floor((index * spanDays) / frequency)) +
            dayShift,
          timeZone
        );
        const clock = typeof entry === "string" ? entry : entry?.time ?? baseClock;
        // The inferred original clock survives DST gaps as a valid
        // calendar boundary, without permanently adopting a gap shift.
        if (implicitClock) {
          // Distribute 42/21d into two source-clock-anchored slots per
          // calendar date. Fractional elapsed Date milliseconds would drift
          // across DST and even produce invalid fractional ISO offsets.
          const exactDay = (index * spanDays) / frequency;
          // <= one dose/day uses its original whole-day slots (2/week
          // means day 0 and day 3, not day 3 at noon). Only multiple
          // administrations per local date need fractional clocks.
          const fractionalDay = frequency > spanDays ? exactDay - Math.floor(exactDay) : 0;
          const [hour, minute, second] = clock.split(":").map(Number);
          const totalSeconds =
            (hour ?? 0) * 3600 + (minute ?? 0) * 60 + (second ?? 0) + Math.round(fractionalDay * 86400);
          const shiftedDay = Math.floor(totalSeconds / 86400);
          const clockSeconds = ((totalSeconds % 86400) + 86400) % 86400;
          const localDay = shiftedDay ? addLocalDays(day, shiftedDay, timeZone) : day;
          const parts = getTimeParts(localDay, timeZone);
          candidate = calendarBoundaryDate(
            timeZone,
            parts.year,
            parts.month,
            parts.day,
            Math.floor(clockSeconds / 3600),
            Math.floor((clockSeconds % 3600) / 60),
            clockSeconds % 60
          );
        } else {
          candidate = makeZonedDateFromDay(day, timeZone, clock);
        }
      } else {
        candidate = new Date(
          cycleStart.getTime() + Math.floor(((cycleEnd.getTime() - cycleStart.getTime()) * index) / frequency)
        );
      }
      // Meal offsets may place the administration outside its anchor cycle.
      // Keep those occurrences when they are inside the actual query window.
      if (
        !candidate ||
        candidate < from ||
        (!shiftedClock && (candidate < cycleStart || candidate >= cycleEnd)) ||
        (orderedAt && candidate < orderedAt) ||
        (upperBound && candidate >= upperBound) ||
        !matchesCalendarDaySelection(candidate, calendarDays, timeZone)
      )
        continue;
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
  repeat: CanonicalRecurrence,
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
  if (periodUnit === "d" || periodUnit === "wk") {
    const days = period * (periodUnit === "wk" ? 7 : 1);
    if (Number.isInteger(days)) {
      // A source period in days/weeks is a local calendar recurrence.
      // This is distinct from explicitly elapsed q24h/q168h, which use
      // the hour branch above. Capture the original civil clock once:
      // a spring-gap 02:30->03:30 must not permanently change the series.
      let sourceClock: Pick<TimeParts, "hour" | "minute" | "second"> | undefined;
      return (instant) => {
        if (!sourceClock) sourceClock = getTimeParts(instant, timeZone);
        return addCalendarDaysAtClock(instant, days, timeZone, sourceClock);
      };
    }
    const delta = days * 24 * 60 * 60 * 1000;
    return (instant) => new Date(instant.getTime() + delta);
  }
  if (periodUnit === "mo" || periodUnit === "a") {
    const months = periodUnit === "mo" ? period : period * 12;
    let clock: Pick<TimeParts, "hour" | "minute" | "second"> | undefined;
    return (value: Date) => {
      // Calendar recurrence owns the original wall clock, even when an
      // intervening cycle boundary has to pass through a DST gap.
      if (!clock) {
        const { hour, minute, second } = getTimeParts(value, timeZone);
        clock = { hour, minute, second };
      }
      return addCalendarMonths(value, months, timeZone, clock);
    };
  }
  return null;
}
/**
 * Determines whether interval stepping can safely combine with a day-of-week filter.
 *
 * @param repeat FHIR timing repeat object containing period unit metadata.
 * @param enforceDayFilter Whether a `dayOfWeek` filter is active for this schedule.
 * @returns `true` when interval stepping should be used directly; otherwise fallback logic is required.
 */
function isDayFilteredIntervalSupported(repeat: CanonicalRecurrence, enforceDayFilter: boolean): boolean {
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
  recurrence: CanonicalRecurrence;
  timeZone: string;
  dayFilter: Set<string>;
  anchorDay: Date;
  startDay: Date;
  from: Date;
  to?: Date;
  orderedAt?: Date | null;
  limit: number;
  defaultClock?: string;
  calendarDays?: CalendarDaySelection;
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
function generateDayFilteredPeriodSeries(options: DayFilteredPeriodSeriesOptions): string[] {
  const {
    recurrence: repeat,
    timeZone,
    dayFilter,
    anchorDay,
    startDay,
    from,
    to,
    orderedAt,
    limit,
    defaultClock,
    calendarDays,
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
  while (results.length < limit && iterations < maxIterations && (!to || currentDay < to)) {
    const inPeriodCycle = isDateAlignedToPeriodCycle(currentDay, anchorDay, repeat, timeZone);
    if (inPeriodCycle && matchesCalendarDay(currentDay, dayFilter, true, calendarDays, timeZone)) {
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
/** Resolved clock entries are sorted by dayShift. The last entry determines
 * how many earlier anchor dates may still yield an event inside this query. */
function firstClockAnchorDay(
  from: Date, entries: readonly ExpandedTime[], zone: string, orderedAt?: Date | null
): Date {
  const day = startOfLocalDay(from, zone);
  const shift = entries[entries.length - 1]?.dayShift ?? 0;
  if (shift <= 0) return day;
  const first = addLocalDays(day, -shift, zone);
  const treatmentDay = orderedAt ? startOfLocalDay(orderedAt, zone) : undefined;
  return treatmentDay && treatmentDay > first ? treatmentDay : first;
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
  dosage: CanonicalAdministration,
  from: Date,
  to: Date,
  config: NextDueDoseConfig,
  baseTime: Date,
  orderedAt: Date | null,
  limit?: number,
  explicitPriorCount = 0,
  derivePriorCount = true
): number {
  const timing = dosage.schedule;
  const repeat = timing?.recurrence;
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
  const calendarDays = resolveCalendarDaySelection(repeat, baseTime, timeZone);
  const priorCount =
    derivePriorCount && normalizedCount !== undefined && orderedAt && from > orderedAt
      ? derivePriorCountFromHistory(dosage, timing, repeat, config, orderedAt, from, timeZone)
      : explicitPriorCount;
  const countLimit =
    normalizedCount === undefined
      ? limit ?? Number.POSITIVE_INFINITY
      : Math.min(limit ?? normalizedCount, Math.max(0, normalizedCount - priorCount));
  if (countLimit <= 0) {
    return 0;
  }
  const hardLimit = Number.isFinite(countLimit) ? countLimit : 365 * 31;
  if (isSingleAdministrationRepeat(repeat)) {
    if (parseActivityTimingExtensions(repeat)?.length) {
      // A one-time activity trigger has no executable timestamp. Supply may
      // still need one administration after the order, but never before it.
      return orderedAt && to <= orderedAt ? 0 : 1;
    }
    const anchor = orderedAt ?? baseTime;
    if (anchor < from || anchor >= to) {
      return 0;
    }
    return 1;
  }
  const recordCandidate = (candidate: Date | null) => {
    // A calendar day may contain multiple prescribed clocks. Enforce the
    // exact remaining count when recording each dose, not only per-day.
    if (!candidate || count >= countLimit) return false;
    if (candidate < from || candidate >= to) return false;
    const iso = formatZonedIso(candidate, timeZone);
    if (seen.has(iso)) return false;
    seen.add(iso);
    count += 1;
    return true;
  };
  const elapsedOrigin = clockAnchoredElapsedOrigin(repeat, baseTime, timeZone);
  if (elapsedOrigin) {
    return generateIntervalSeries(
      elapsedOrigin,
      from,
      hardLimit,
      repeat,
      timeZone,
      dayFilter,
      enforceDayFilter,
      orderedAt,
      to,
      calendarDays
    ).length;
  }
  const whenCodes = repeat.anchors ?? [];
  const timeOfDayEntries = repeat.clocks ?? [];
  if (whenCodes.length > 0 || timeOfDayEntries.length > 0) {
    const cadenceAnchor = resolveRepeatBoundsStart(repeat, timeZone) ?? orderedAt ?? from;
    const expanded = resolveExplicitClockEntries(repeat, config, enforceDayFilter);
    if (arrayIncludes(whenCodes, TimingEvent.Immediate)) {
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
      if (hasDistributedClockFrequency(repeat, expanded, enforceDayFilter)) {
        return (
          count +
          generateFrequencyPerPeriodSeries(
            startOfLocalDay(cadenceAnchor, timeZone),
            from,
            hardLimit - count,
            repeat,
            timeZone,
            orderedAt,
            to,
            expanded,
            calendarDays
          ).length
        );
      }
      let currentDay = firstClockAnchorDay(from, expanded, timeZone, orderedAt);
      let iterations = 0;
      const maxIterations = calendarScanLimit(currentDay, to, hardLimit);
      while (count < countLimit && currentDay < to && iterations < maxIterations) {
        if (
          matchesCalendarDay(currentDay, dayFilter, enforceDayFilter, calendarDays, timeZone) &&
          clockCadenceEligible(currentDay, cadenceAnchor, repeat, timeZone, enforceDayFilter)
        ) {
          for (const entry of expanded) {
            if (count >= countLimit) break;
            const targetDay =
              entry.dayShift === 0 ? currentDay : addLocalDays(currentDay, entry.dayShift, timeZone);
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
  const supportsDayFilteredInterval = isDayFilteredIntervalSupported(repeat, enforceDayFilter);
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
      if (matchesCalendarDay(current, dayFilter, enforceDayFilter, calendarDays, timeZone)) {
        recordCandidate(current);
      }
      const next = increment(current);
      if (!next || next.getTime() === current.getTime()) break;
      current = next;
      guard += 1;
    }
    return count;
  }
  // Weekday membership owns non-daily frequency placement, not a generic distributor.
  if (dayFilteredSeriesRepeat) {
    const generated = generateDayFilteredPeriodSeries({
      recurrence: dayFilteredSeriesRepeat,
      timeZone,
      dayFilter,
      anchorDay: startOfLocalDay(baseTime, timeZone),
      startDay: from,
      from,
      to,
      orderedAt,
      limit: hardLimit,
      defaultClock: toLocalClock(baseTime, timeZone),
      calendarDays,
    });
    return count + generated.length;
  }
  if (repeat.frequency && repeat.period && repeat.periodUnit) {
    const clocks = resolveFrequencyClocks(timing, config);
    const codedDaily = recognizedDailyTimingCode(timing) !== undefined;
    const ordinaryDaily = repeat.period === 1 && repeat.periodUnit === DurationUnit.Day;
    if (!codedDaily && !ordinaryDaily) {
      return (
        count +
        generateFrequencyPerPeriodSeries(
          baseTime,
          from,
          hardLimit,
          repeat,
          timeZone,
          orderedAt,
          to,
          clocks,
          calendarDays
        ).length
      );
    }
    if (clocks.length === 0) return count;
    let currentDay = startOfLocalDay(from, timeZone);
    let iterations = 0;
    const maxIterations = calendarScanLimit(currentDay, to, hardLimit);
    while (count < countLimit && currentDay < to && iterations < maxIterations) {
      if (matchesCalendarDay(currentDay, dayFilter, enforceDayFilter, calendarDays, timeZone)) {
        for (const clock of clocks) {
          if (count >= countLimit) break;
          const zoned = makeZonedDateFromDay(currentDay, timeZone, clock);
          if (zoned) recordCandidate(zoned);
        }
      }
      currentDay = addLocalDays(currentDay, 1, timeZone);
      iterations += 1;
    }
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
/** Require an unambiguous phase context for numerical utilities.
 * @param course Editable course whose context may be missing or contradictory.
 * @param operation The numeric operation reported to the caller.
 */
function requireExecutableCourseContext(
  course: CanonicalCourse,
  operation: "scheduling" | "calculating"
): void {
  const issue = getCourseContextIssue(course);
  if (issue)
    throw new MedicationQuantityCalculationError(
      issue,
      issue === "conflicting-course-phase"
        ? `Resolve conflicting course phase metadata before ${operation}; the surviving rows remain editable.`
        : `Supply the complete dosage array or restore its shared course metadata before ${operation}; the surviving rows remain editable.`
    );
}
function calculationHorizon(options: CanonicalSupplyOptions, zone: string): Date {
  if (!Number.isFinite(options.durationValue) || options.durationValue <= 0)
    throw new MedicationQuantityCalculationError(
      "invalid-horizon",
      "Supply duration must be a positive number of supported calendar/time units."
    );
  const advance = createIntervalStepper(
    {
      period: options.durationValue,
      periodUnit: options.durationUnit,
    },
    zone
  );
  if (!advance)
    throw new MedicationQuantityCalculationError(
      "unsupported-horizon",
      "The requested dispensing duration has no supported time unit; supply a duration in minutes, hours, days, weeks, months or years."
    );
  const from = coerceDate(options.from, "from");
  const end = advance(from);
  if (!end || end <= from)
    throw new MedicationQuantityCalculationError(
      "invalid-horizon",
      "Dispensing duration does not produce a date after the start of the dispensing window."
    );
  return end;
}
function prepareMaximumSupplyTiming(dosage: CanonicalAdministration): {
  dosage: CanonicalAdministration;
  countMaximum: boolean;
  frequencyMaximum: boolean;
  periodMinimum: boolean;
  infusionDurationMaximum: boolean;
} {
  const repeat = dosage.schedule?.recurrence;
  if (!repeat)
    return {
      dosage,
      countMaximum: false,
      frequencyMaximum: false,
      periodMinimum: false,
      infusionDurationMaximum: false,
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
  if (
    !dosage.schedule?.explicitEvents?.length &&
    frequencyMax &&
    (!frequency || frequencyMax >= frequency) &&
    frequencyMax !== frequency &&
    positiveNumber(repeat.period ?? repeat.periodMax) &&
    repeat.periodUnit
  ) {
    nextRepeat = {
      ...nextRepeat,
      frequency: frequencyMax,
      frequencyMax: undefined,
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
  const first = dosage.amounts?.length === 1 ? dosage.amounts[0] : undefined;
  const isRateDose = !!first && !first.quantity && !!(first.rate || first.rateRatio);
  if (isRateDose && repeat.occurrenceDurationMax !== undefined) {
    const duration = positiveNumber(repeat.occurrenceDuration);
    const durationMax = positiveNumber(repeat.occurrenceDurationMax);
    if (
      durationMax &&
      (!duration || durationMax >= duration) &&
      repeat.occurrenceDurationUnit &&
      durationMax !== duration
    ) {
      nextRepeat = { ...nextRepeat, occurrenceDuration: durationMax, occurrenceDurationMax: undefined };
      infusionDurationMaximum = true;
    }
  }
  return {
    dosage:
      nextRepeat === repeat
        ? dosage
        : {
            ...dosage,
            schedule: {
              ...dosage.schedule!,
              recurrence: nextRepeat,
            },
          },
    countMaximum,
    frequencyMaximum,
    periodMinimum,
    infusionDurationMaximum,
  };
}
/** Measure a timed range plan with the same quantity-aware acceptor used
 * across course cycles. Counts are spent only after all caps admit a dose. */
function measureRangedSchedule(
  dosage: CanonicalAdministration, options: CanonicalSupplyOptions,
  from: Date, end: Date, origin: Date, zone: string
): { count: number; quantity: number; times: string[] } {
  const repeat = dosage.schedule?.recurrence;
  const totalCount = repeat ? repeatOccurrenceCap(repeat) : undefined;
  const prior: number[] = [];
  let used = options.priorCount ?? 0;
  let countedActual: Set<number> | undefined;
  for (const stamp of options.priorDoseTimes ?? []) {
    const at = coerceDate(stamp, "priorDoseTimes").getTime();
    prior.push(at);
    if (at >= origin.getTime() && at < from.getTime()) {
      if (options.priorCount === undefined) used++;
      (countedActual ??= new Set()).add(at);
    }
  }
  const quota: CycleEventQuota = { remaining: totalCount === undefined ? undefined :
    Math.max(0, totalCount - used) };
  if (prior.length > 1) prior.sort((a, b) => a - b);
  const accept = chronologicalCapAcceptor(prior, zone, options.context);
  const begin = totalCount !== undefined && !dosage.asNeeded && options.priorCount === undefined
    ? origin : from;
  const execution: CanonicalAdministration = {
    ...dosage, limits: dosage.limits?.filter(limit => limit.scope !== "period"),
    schedule: { ...dosage.schedule, recurrence: {
      ...repeat,
      ...(!isSingleAdministrationRepeat(repeat ?? {}) ? { count: undefined, countMax: undefined } : {}),
      occurrenceCap: undefined,
      calendarWindow: { ...repeat?.calendarWindow, end: new Date(end.getTime() - 1).toISOString() },
    } },
  };
  const candidates = nextDueDoses(execution, {
    ...options, from: begin, orderedAt: origin, priorCount: undefined,
    priorDoseTimes: undefined, limit: 10000,
    evaluateCondition: options.evaluateCondition ?? (() => true),
  });
  if (candidates.length === 10000 && Date.parse(candidates[9999]) < end.getTime())
    throw new MedicationQuantityCalculationError("schedule-horizon-too-dense",
      "More than 10,000 administrations could occur in the requested supply window. Use a shorter calculation window.");
  const accepted: UncommittedCycleEvent[] = [];
  for (let index = 0; index < candidates.length; index++) {
    const iso = candidates[index], at = Date.parse(iso);
    if (countedActual?.has(at)) continue;
    const event: UncommittedCycleEvent = { at, iso, key: "range", member: dosage, quota, serial: index };
    if (accept(event)) accepted.push(event);
  }
  const selected = accept.finish(accepted, from.getTime());
  let quantity = 0;
  const times: string[] = [];
  for (const event of selected) {
    quantity += event.quantity ?? 0;
    times.push(event.iso);
  }
  return { count: selected.length, quantity, times };
}
function hasTimedRangedCaps(course: CanonicalCourse): boolean {
  for (const stage of course.stages) for (const member of stage.administrations)
    if (member.amounts?.[0]?.range && hasPeriodLimits(member) && !unscheduledOccurrenceCapacity(member))
      return true;
  return false;
}
/** The ordinary schedule remains the clinician's CONCRETE clocks. Numeric
 * supply, however, may use the upper frequency/count/infusion-duration
 * choices. For overlapping capped cycles those extra opportunities MUST
 * pass through the same chronological cap ledger, not a post hoc count.
 *
 * Only repeated supply with shared caps constructs this shallow
 * projection. Preserve the original member for units, explanations and
 * source metadata; the projected member exists solely for scheduling.
 */
function maximumChronologicalSupplyCourse(
  course: CanonicalCourse,
  options: CanonicalSupplyOptions,
  preserveClocks = false
): {
  course: CanonicalCourse;
  hasClockAlternative: boolean;
  originalOf: Map<CanonicalAdministration, CanonicalAdministration>;
} {
  let alteredStages: CanonicalStage[] | undefined;
  let hasClockAlternative = false;
  const originalOf = new Map<CanonicalAdministration, CanonicalAdministration>();
  for (let i = 0; i < course.stages.length; i++) {
    const stage = course.stages[i];
    let members: CanonicalAdministration[] | undefined;
    for (let j = 0; j < stage.administrations.length; j++) {
      const source = stage.administrations[j];
      const maximal = prepareMaximumSupplyTiming(source);
      let generated = maximal.dosage;
      // The cap ledger must count the same per-administration quantity as
      // numeric supply. A range has no scalar amount until its applicable
      // maximum is selected; otherwise overlapping cycles bypass the cap
      // while the final measurement still multiplies by the upper dose.
      // Use the existing supply measurer ONLY for this capped range branch.
      // The original authored range stays on the source member.
      const amounts = generated.amounts;
      if (amounts?.length === 1 && !amounts[0].quantity && amounts[0].range &&
          hasPeriodLimits(generated))
        generated = prepareMeasuredDose(generated, options);
      if (maximal.frequencyMaximum && !preserveClocks) {
        const repeat = generated.schedule!.recurrence!;
        hasClockAlternative ||= !!(repeat.clocks?.length || repeat.anchors?.length || generated.schedule!.code);
        generated = {
          ...generated,
          schedule: {
            ...generated.schedule!,
            code: undefined,
            recurrence: { ...repeat, clocks: undefined, anchors: undefined },
          },
        };
      }
      if (generated === source) continue;
      if (!members) members = stage.administrations.slice();
      members[j] = generated;
      originalOf.set(generated, source);
    }
    if (members) {
      if (!alteredStages) alteredStages = course.stages.slice();
      alteredStages[i] = { ...stage, administrations: members };
    }
  }
  return {
    course: alteredStages ? { ...course, stages: alteredStages } : course,
    hasClockAlternative, originalOf,
  };
}
function prepareMeasuredDose(
  dosage: CanonicalAdministration,
  options: CanonicalSupplyOptions
): CanonicalAdministration {
  const values = dosage.amounts ?? [];
  if (
    values.some((entry) => (entry as CanonicalAmount).expression || (entry as CanonicalAmount).rateExpression)
  ) {
    throw new MedicationQuantityCalculationError(
      "dose-expression-needs-evaluation",
      "The prescription contains a calculated dose/rate expression. Provide the evaluated patient-specific dose before calculating medication supply."
    );
  }
  const first = values.length === 1 ? values[0] : undefined;
  if (!first)
    throw new MedicationQuantityCalculationError(
      "missing-dose",
      "The prescribed quantity per administration is missing or contains alternative doses. Select the applicable dose before calculating supply."
    );
  let quantity = first.quantity;
  const operator = quantity?.comparator;
  if (operator === ">" || operator === ">=")
    throw new MedicationQuantityCalculationError(
      "dose-amount-lower-bound",
      "The prescribed dose is a lower bound, so required supply has no finite numeric upper estimate. Provide the applicable dose before calculating supply."
    );
  // The usual known tablet/drop/capsule amount needs no object allocation,
  // expression evaluation or rate conversion. This is also the dominant
  // calculation path for pre-existing callers.
  if (
    quantity &&
    Number.isFinite(quantity.value) &&
    quantity.value! > 0 &&
    !/\/kg$/i.test(quantity.code ?? quantity.unit ?? "")
  )
    // The known numeric amount stays useful even when qualified by <=,
    // >= or ~. Its original comparator remains in the caller's FHIR data.
    return dosage;
  if (!quantity && (first.rate || first.rateRatio)) {
    const repeat = dosage.schedule?.recurrence;
    if (repeat?.occurrenceDuration === undefined ||
        !repeat.occurrenceDurationUnit ||
        repeat.occurrenceDuration <= 0)
      throw new MedicationQuantityCalculationError(
        "infusion-duration-required",
        "Infusion rate is specified, but duration per infusion is not. Supply the infusion duration before computing volume/amount."
      );
    quantity = measuredRateQuantity(first, repeat);
    if (!quantity)
      throw new MedicationQuantityCalculationError(
        "rate-units-unresolved",
        "The infusion rate's units cannot be converted to the provided duration. Supply a compatible rate/duration pair or a computed dose quantity."
      );
  }
  if (!quantity && first.range) {
    const high = first.range.high;
    const low = first.range.low;
    quantity = high?.value !== undefined && Number.isFinite(high.value) && high.value > 0
      ? high : undefined;
    if (!quantity && low?.value !== undefined && Number.isFinite(low.value) && low.value > 0) {
      const maximum = numericAdministrationLimits(dosage, measuredStrengthRatio(options.context), getDoseQuantityUnit).administration;
      const operator = maximum?.comparator;
      if (maximum?.value !== undefined && (!operator || operator === "~" || operator === "<=")) {
        const unit = getDoseQuantityUnit(low), maxUnit = getDoseQuantityUnit(maximum);
        const amount = normalizeQuantityCapUnit(unit) === normalizeQuantityCapUnit(maxUnit)
          ? maximum.value : convertValue(maximum.value, maxUnit, unit, measuredStrengthRatio(options.context));
        const value = amount === null ? undefined : amount / getAdministrationTargetMultiplier(dosage, options.context);
        if (value !== undefined && (low.comparator === ">" ? value > low.value : value >= low.value))
          quantity = { ...low, value, comparator: undefined };
      }
      if (!quantity) throw new MedicationQuantityCalculationError("dose-amount-lower-bound",
        "The prescribed dose range has no finite upper bound. Provide the applicable dose or a compatible administration maximum before calculating supply.");
    }
    if (quantity) {
      const maximum = numericAdministrationLimits(dosage, measuredStrengthRatio(options.context), getDoseQuantityUnit).administration;
      const operator = maximum?.comparator;
      if (maximum?.value !== undefined && (!operator || operator === "~" || operator === "<=")) {
        const unit = getDoseQuantityUnit(quantity), maxUnit = getDoseQuantityUnit(maximum);
        const converted = normalizeQuantityCapUnit(unit) === normalizeQuantityCapUnit(maxUnit)
          ? maximum.value : convertValue(maximum.value, maxUnit, unit, measuredStrengthRatio(options.context));
        const bound = converted === null ? undefined : converted / getAdministrationTargetMultiplier(dosage, options.context);
        const lowUnit = getDoseQuantityUnit(low);
        const minimum = low?.value === undefined ? 0 :
          normalizeQuantityCapUnit(unit) === normalizeQuantityCapUnit(lowUnit) ? low.value :
            convertValue(low.value, lowUnit, unit, measuredStrengthRatio(options.context));
        if (bound !== undefined && minimum !== null && bound < quantity.value! &&
            (low?.comparator === ">" ? bound > minimum : bound >= minimum))
          quantity = { ...quantity, value: bound, comparator: undefined };
      }
    }
  }
  if (!quantity || quantity.value === undefined || !Number.isFinite(quantity.value) || quantity.value <= 0) {
    throw new MedicationQuantityCalculationError(
      "dose-amount-unresolved",
      "The administered dose is not a single known positive quantity. Provide the applicable dose, range choice, or evaluated expression."
    );
  }
  if (quantity.comparator === ">" || quantity.comparator === ">=")
    throw new MedicationQuantityCalculationError("dose-amount-lower-bound",
      "The prescribed dose is a lower bound, so required supply has no finite numeric upper estimate. Provide the applicable dose before calculating supply.");
  const perKg = (quantity.code ?? quantity.unit ?? "").match(/^(.+?)\/kg$/i);
  if (perKg) {
    const weight = options.patientWeightKg;
    if (weight !== undefined && Number.isFinite(weight) && weight > 0) {
      quantity = {
        ...quantity,
        value: roundCalculatedUnits(quantity.value * weight),
        unit: perKg[1],
        code: quantity.code ? perKg[1] : undefined,
      };
    }
  }
  return {
    ...dosage,
    amounts: [{ ...first, quantity: quantity }],
  };
}
function sumCourseUnits(
  entries: Array<{
    total: TotalUnitsResult;
    unit: string | undefined;
  }>,
  options: CanonicalSupplyOptions
): TotalUnitsResult {
  let commonUnit: string | undefined;
  let totalUnits = 0;
  let approximate: TotalUnitsResult["totalApproximateQuantity"];
  let ingredient: TotalUnitsResult["totalApproximateIngredientQuantity"];
  let mixedApproximate = false,
    mixedIngredient = false;
  let maximum = false;
  const details: string[] = [];
  for (const { total, unit } of entries) {
    let quantity = total.totalUnits;
    if (commonUnit !== undefined && unit !== undefined && commonUnit.toLowerCase() !== unit.toLowerCase()) {
      const translated = convertValue(
        quantity,
        unit,
        commonUnit,
        measuredStrengthRatio(options.context)
      );
      if (translated === null)
        throw new MedicationQuantityCalculationError(
          "incompatible-dose-units",
          `Cannot sum medication supply expressed in ${commonUnit} and ${unit}. Provide a product strength or equivalent conversion before combining the dosages.`
        );
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
      else if (
        approximate.unit === q.unit &&
        approximate.confidence === q.confidence &&
        approximate.basis === q.basis &&
        approximate.source === q.source
      )
        approximate.value = roundCalculatedUnits((approximate.value ?? 0) + (q.value ?? 0));
      else {
        approximate = undefined;
        mixedApproximate = true;
      }
    } else if (!total.totalApproximateQuantity && approximate) {
      approximate = undefined;
      mixedApproximate = true;
    }
    if (total.totalApproximateIngredientQuantity && !mixedIngredient) {
      const q = total.totalApproximateIngredientQuantity;
      if (!ingredient) ingredient = { ...q };
      else if (
        ingredient.unit === q.unit &&
        ingredient.confidence === q.confidence &&
        ingredient.basis === q.basis &&
        ingredient.source === q.source
      )
        ingredient.value = roundCalculatedUnits((ingredient.value ?? 0) + (q.value ?? 0));
      else {
        ingredient = undefined;
        mixedIngredient = true;
      }
    } else if (!total.totalApproximateIngredientQuantity && ingredient) {
      ingredient = undefined;
      mixedIngredient = true;
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
      ingredient =
        estimateIngredientQuantity(approximate, options.context) ??
        (ingredient?.value !== undefined
          ? { ...ingredient, value: roundCalculatedUnits(ingredient.value * roundedShare) }
          : undefined);
    } else if (ingredient?.value !== undefined) {
      ingredient.value = roundCalculatedUnits(ingredient.value * roundedShare);
    }
  }
  const result: TotalUnitsResult = {
    totalUnits,
    ...(commonUnit ? { unit: commonUnit } : {}),
    quantityKind: maximum ? "maximum" : "scheduled",
    ...(maximum
      ? {
          explanation:
            [...new Set(details)].join(" ") ||
            "Maximum scheduled supply; PRN/conditional administrations may not all be used.",
        }
      : {}),
    ...(approximate ? { totalApproximateQuantity: approximate } : {}),
    ...(ingredient ? { totalApproximateIngredientQuantity: ingredient } : {}),
  };
  const context = options.context;
  if (context?.containerValue && context.containerValue > 0) {
    const containerUnit = context.containerUnit;
    const packageUnit = context.packageUnit;
    const estimateValue = approximate?.value;
    const estimateUnit = approximate?.unit;
    const useEstimate =
      estimateValue !== undefined &&
      estimateUnit &&
      containerUnit &&
      estimateUnit.toLowerCase() === containerUnit.toLowerCase();
    const matchesPackage =
      commonUnit && packageUnit && commonUnit.toLowerCase() === packageUnit.toLowerCase();
    if (useEstimate || matchesPackage) {
      const effective = useEstimate ? estimateValue! : totalUnits;
      const divisor = matchesPackage && !useEstimate ? 1 : context.containerValue;
      result.totalContainers = Math.ceil(effective / divisor);
      if (containerUnit)
        result.totalContainerQuantity = {
          // Quantity describes the prescribed amount, not the capacity of all
          // dispensed packages. A half-bottle course requires 60 mL from a
          // 120 mL bottle even though totalContainers is one.
          value: useEstimate ? estimateValue! : roundCalculatedUnits(totalUnits * context.containerValue),
          unit: containerUnit,
        };
    } else if (commonUnit && containerUnit && commonUnit.toLowerCase() === containerUnit.toLowerCase()) {
      result.totalContainers = Math.ceil(totalUnits / context.containerValue);
      result.totalContainerQuantity = { value: totalUnits, unit: containerUnit };
    }
  }
  return result;
}
function calculateTotalUnitsSingle(
  options: Omit<CanonicalSupplyOptions, "dosage"> & {
    dosage: CanonicalAdministration;
  },
  acceptedEventCount?: number,
  supplyAccounting?: {
    usedQuantity?: number;
    actualPriorCount: number;
    /** Accepted plan history for another supply cycle, never patient due times. */
    acceptedTimes?: string[];
    acceptedQuantity?: number;
    rangePrior?: readonly SupplyAllocation[];
    rangeAccepted?: SupplyAllocation[];
    capacityWindows?: readonly SupplyCapacityWindow[];
  }
): TotalUnitsResult {
  const { dosage: sourceDosage, roundToMultiple, context } = options;
  requireConsistentTimingCode(sourceDosage.schedule);
  requireResolvedCycleDays(sourceDosage);
  const providedConfig = options.config;
  const timeZone = options.timeZone ?? providedConfig?.timeZone;
  if (!timeZone) throw new Error("timeZone is required for calculateTotalUnits");
  const from = coerceDate(options.from, "from");
  const administrationOffset = getAdministrationOffsetMinutes(sourceDosage);
  if (administrationOffset !== undefined) {
    const delta = administrationOffset * 60000;
    const shift = (value: Date | string, amount: number) =>
      new Date(coerceDate(value, "administration time").getTime() + amount);
    const end = calculationHorizon(options, timeZone);
    const localAccounting = supplyAccounting?.acceptedTimes
      ? { ...supplyAccounting, acceptedTimes: [] as string[] } : supplyAccounting;
    const result = calculateTotalUnitsSingle({
      ...options,
      dosage: {
        ...sourceDosage,
        delayMinutes: undefined,
      },
      from: shift(from, -delta),
      durationValue: (end.getTime() - from.getTime()) / 1000,
      durationUnit: DurationUnit.Second,
      priorDoseTimes: options.priorDoseTimes?.map((value) => shift(value, -delta)),
      evaluateCondition: options.evaluateCondition
        ? (condition, at) => options.evaluateCondition!(condition, formatZonedIso(shift(at, delta), timeZone))
        : undefined,
    }, acceptedEventCount, localAccounting);
    if (supplyAccounting?.acceptedTimes && localAccounting?.acceptedTimes)
      for (const stamp of localAccounting.acceptedTimes)
        supplyAccounting.acceptedTimes.push(shift(stamp, delta).toISOString());
    return result;
  }
  if (options.priorCount !== undefined && (!Number.isFinite(options.priorCount) || options.priorCount < 0))
    throw new MedicationQuantityCalculationError(
      "invalid-prior-count",
      "priorCount must be a non-negative finite number."
    );
  // Validate single-dosage horizons exactly like whole-course horizons,
  // before unrelated dose details can mask an invalid dispensing window.
  let endDay = calculationHorizon(options, timeZone);
  const maximalTiming = prepareMaximumSupplyTiming(sourceDosage);
  const dosage = prepareMeasuredDose(maximalTiming.dosage, options);
  const rangePlan = dosage.amounts?.[0]?.range ? executableDoseRange(dosage, context) : undefined;
  const strength = measuredStrengthRatio(context);
  const numericLimits = numericAdministrationLimits(dosage, strength, getDoseQuantityUnit);
  // Applicable maxima intersect; retained incomplete bounds still explain
  // why only part of the authored constraints could be evaluated.
  let unevaluatedMaximumDose = numericLimits.multiple;
  let lifetimeMaximum: number | undefined;
  const doseForLimits = dosage.amounts?.[0]?.quantity;
  const doseUnitForLimits = getDoseQuantityUnit(doseForLimits);
  const lifetime = numericLimits.lifetime;
  const lifetimeOperator = getQuantityComparator(lifetime);
  if (
    lifetime?.value !== undefined &&
    Number.isFinite(lifetime.value) &&
    lifetime.value >= 0 &&
    (!lifetimeOperator || lifetimeOperator === "~" || lifetimeOperator === "<=")
  ) {
    const lifetimeUnit = getDoseQuantityUnit(lifetime);
    const converted =
      normalizeQuantityCapUnit(lifetimeUnit) === normalizeQuantityCapUnit(doseUnitForLimits)
        ? lifetime.value
        : convertValue(lifetime.value, lifetimeUnit, doseUnitForLimits, strength);
    if (converted !== null && Number.isFinite(converted)) {
      const knownPrior =
        (supplyAccounting?.actualPriorCount ?? options.priorDoseTimes?.length ?? 0) *
        (doseForLimits?.value ?? 0) *
        getAdministrationTargetMultiplier(dosage, context);
      lifetimeMaximum = Math.max(0, converted - knownPrior - (supplyAccounting?.usedQuantity ?? 0));
    } else {
      unevaluatedMaximumDose = true;
    }
  } else if (lifetime) {
    unevaluatedMaximumDose = true;
  }
  const perAdministration = numericLimits.administration;
  if (perAdministration) {
    const dose = dosage.amounts?.[0]?.quantity;
    const limit = perAdministration;
    const limitOperator = getQuantityComparator(limit);
    if (
      !dose?.value ||
      limit.value === undefined ||
      !Number.isFinite(limit.value) ||
      limit.value < 0 ||
      (limitOperator && limitOperator !== "~" && limitOperator !== "<=")
    ) {
      unevaluatedMaximumDose = true;
    } else {
      const fromUnit = getDoseQuantityUnit(dose);
      const limitUnit = getDoseQuantityUnit(limit);
      const perTarget =
        fromUnit.toLowerCase() === limitUnit.toLowerCase()
          ? dose.value
          : convertValue(dose.value, fromUnit, limitUnit, strength);
      if (perTarget === null || !Number.isFinite(perTarget)) {
        unevaluatedMaximumDose = true;
      } else {
        const actual = perTarget * getAdministrationTargetMultiplier(dosage, context);
        if (actual > limit.value + 1e-9) unevaluatedMaximumDose = true;
      }
    }
  }
  if (hasPeriodLimits(dosage)) {
    let suppliedPeriodLimits = 0;
    for (const limit of dosage.limits ?? []) if (limit.scope === "period") suppliedPeriodLimits++;
    if ((rangePlan?.caps ?? executableQuantityCaps(dosage, context)).length < suppliedPeriodLimits)
      unevaluatedMaximumDose = true;
  }
  const hasPartialR6Safety = Boolean((dosage as CanonicalAdministration).safety);
  const unresolvedOneTimeActivity = Boolean(
    dosage.schedule?.recurrence &&
      isSingleAdministrationRepeat(dosage.schedule.recurrence) &&
      parseActivityTimingExtensions(dosage.schedule.recurrence)?.length
  );
  const conditional = getDosageCondition(dosage);
  const excludedDates = getDosageExcludedDates(dosage);
  const excludedWeekdays = getDosageExcludedWeekdays(dosage);
  const useMaximalPlan =
    !!dosage.asNeeded ||
    (!!conditional && !options.evaluateCondition) ||
    maximalTiming.countMaximum ||
    maximalTiming.frequencyMaximum ||
    maximalTiming.periodMinimum ||
    maximalTiming.infusionDurationMaximum ||
    !!sourceDosage.amounts?.[0]?.range ||
    doseForLimits?.comparator === "<" || doseForLimits?.comparator === "<=" ||
    lifetimeMaximum !== undefined ||
    unevaluatedMaximumDose ||
    hasPartialR6Safety ||
    unresolvedOneTimeActivity;
  const orderedAtDate = options.orderedAt === undefined ? null : coerceDate(options.orderedAt, "orderedAt");
  const eventClock: EventClockMap = {
    ...(providedConfig?.eventClock ?? {}),
    ...(options.eventClock ?? {}),
  };
  const mealOffsets: MealOffsetMap = {
    ...(providedConfig?.mealOffsets ?? {}),
    ...(options.mealOffsets ?? {}),
  };
  const frequencyDefaults = mergeFrequencyDefaults(
    providedConfig?.frequencyDefaults,
    options.frequencyDefaults
  );
  const config: NextDueDoseConfig = {
    timeZone,
    eventClock,
    mealOffsets,
    frequencyDefaults,
  };
  const repeat = dosage.schedule?.recurrence;
  const capacityCap = unscheduledOccurrenceCapacity(dosage);
  const boundsPeriod = validateRepeatBoundsPeriod(repeat, timeZone);
  const boundsStart = boundsPeriod.start;
  const countFrom = boundsStart && boundsStart > from ? boundsStart : from;
  const effectiveOrderedAt =
    orderedAtDate && boundsStart && boundsStart > orderedAtDate ? boundsStart : orderedAtDate;
  const baseCandidate = effectiveOrderedAt ?? boundsStart ?? countFrom;
  const baseTime = boundsStart && boundsStart > baseCandidate ? boundsStart : baseCandidate;
  endDay = minDate(endDay, resolveRepeatDurationCapEnd(dosage, baseTime, timeZone));
  endDay = minDate(endDay, boundsPeriod.end);
  const needsFilteredEnumeration =
    conditional ||
    excludedDates.length ||
    excludedWeekdays.length ||
    hasPeriodLimits(dosage) ||
    !!getTimingOccurrenceCap(repeat) ||
    isWakingHoursInterval(repeat) ||
    Boolean((options as PhaseCountOptions).countEligibilityStart && hasDefiniteAdministrationCount(repeat));
  let count: number;
  let measuredRangeQuantity: number | undefined;
  let selectedTimes: string[] | undefined;
  const capacityAllocations = capacityCap && (supplyAccounting?.acceptedTimes || rangePlan)
    ? [] as SupplyAllocation[] : undefined;
  if (acceptedEventCount !== undefined) {
    // The overlapping-cycle ledger has already evaluated and accepted every
    // concrete opportunity in global timestamp order. Count its accepted
    // administrations directly: the ordinary Timing.event reader correctly
    // deduplicates repeated spellings of ONE event, but two overlapping
    // treatment cycles can prescribe TWO real doses at the same instant.
    count = acceptedEventCount;
  } else if (endDay <= countFrom) {
    count = 0;
  } else if (capacityCap) {
    const begin = effectiveOrderedAt && effectiveOrderedAt > countFrom ? effectiveOrderedAt : countFrom;
    count = maximumUnscheduledCapCount(
      dosage,
      capacityCap,
      begin,
      endDay,
      options,
      timeZone,
      rangePlan?.caps ?? executableQuantityCaps(dosage, context),
      capacityAllocations, rangePlan, supplyAccounting?.rangePrior, supplyAccounting?.capacityWindows
    );
  } else if (rangePlan) {
    const concrete = measureRangedSchedule(dosage, options, countFrom, endDay, baseTime, timeZone);
    let selected = concrete;
    if (maximalTiming.frequencyMaximum && dosage.schedule?.recurrence) {
      const maximum: CanonicalAdministration = { ...dosage, schedule: {
        ...dosage.schedule, code: undefined,
        recurrence: { ...dosage.schedule.recurrence, clocks: undefined, anchors: undefined },
      } };
      const upper = measureRangedSchedule(maximum, options, countFrom, endDay, baseTime, timeZone);
      if (upper.quantity > concrete.quantity) selected = upper;
    }
    count = selected.count;
    measuredRangeQuantity = selected.quantity;
    selectedTimes = selected.times;
  } else if (needsFilteredEnumeration) {
    // A constrained course may exclude individual administration instants
    // (dates, conditions or quantity limits); counting the raw cadence would
    // silently inflate supply. Enumerate only within the requested window.
    const endInclusive = new Date(endDay.getTime() - 1).toISOString();
    const boundedRepeat: CanonicalRecurrence = {
      ...(repeat ?? {}),
      calendarWindow: {
        ...(repeat?.calendarWindow?.start ? { start: repeat.calendarWindow.start } : {}),
        end: endInclusive,
      },
    };
    const bounded: CanonicalAdministration = {
      ...dosage,
      schedule: { ...(dosage.schedule ?? {}), recurrence: boundedRepeat },
    };
    const maximumCandidates = 10000;
    const scheduled = nextDueDoses(bounded, {
      ...options,
      from: countFrom,
      limit: maximumCandidates,
      orderedAt: effectiveOrderedAt ?? options.orderedAt,
      evaluateCondition: options.evaluateCondition ?? (() => true),
    });
    if (
      scheduled.length === maximumCandidates &&
      Date.parse(scheduled[scheduled.length - 1]) < endDay.getTime()
    ) {
      throw new MedicationQuantityCalculationError(
        "schedule-horizon-too-dense",
        "More than 10,000 administrations could occur in the requested supply window. Use a shorter calculation window or a verified interval-count integration."
      );
    }
    count = scheduled.filter((date) => Date.parse(date) < endDay.getTime()).length;
    if (supplyAccounting?.acceptedTimes) selectedTimes = scheduled;
  } else {
    const exactEvents = dosage.schedule
      ? exactTimingEventOccurrences(
          dosage.schedule,
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
    // An unresolved one-time activity has no generated event history.
    // Caller-supplied administrations therefore own its remaining capacity.
    const activityPriorCount = unresolvedOneTimeActivity ? options.priorDoseTimes?.length ?? 0 : 0;
    count =
      exactEvents !== undefined
        ? exactEvents.length
        : countScheduleEvents(
            dosage,
            countFrom,
            endDay,
            config,
            baseTime,
            effectiveOrderedAt,
            100000,
            options.priorCount === undefined ? activityPriorCount : Math.floor(options.priorCount),
            options.priorCount === undefined && !dosage.asNeeded && !unresolvedOneTimeActivity
          );
  }
  if (acceptedEventCount === undefined && !rangePlan && maximalTiming.frequencyMaximum && dosage.schedule?.recurrence) {
    // Scheduling keeps every stated clock/code as the concrete partial plan.
    // Numeric supply can still report the prescribed upper bound without
    // mutating or deleting those anchors on the caller's FHIR object.
    const maximumRepeat: CanonicalRecurrence = {
      ...dosage.schedule.recurrence,
      clocks: undefined,
      anchors: undefined,
      calendarWindow: {
        ...(dosage.schedule.recurrence.calendarWindow?.start
          ? { start: dosage.schedule.recurrence.calendarWindow.start }
          : {}),
        end: new Date(endDay.getTime() - 1).toISOString(),
      },
    };
    const maximumDosage: CanonicalAdministration = {
      ...dosage,
      text: undefined,
      patientInstruction: undefined,
      schedule: { ...dosage.schedule, explicitEvents: undefined, code: undefined, recurrence: maximumRepeat },
    };
    const upperBoundTimes = nextDueDoses(maximumDosage, {
      ...options,
      from: countFrom,
      orderedAt: effectiveOrderedAt ?? options.orderedAt,
      evaluateCondition: options.evaluateCondition ?? (() => true),
      limit: 10000,
    });
    const upperCount = upperBoundTimes.filter((date) => Date.parse(date) < endDay.getTime()).length;
    if (upperCount > count) {
      count = upperCount;
      if (supplyAccounting?.acceptedTimes) selectedTimes = upperBoundTimes;
    }
  }
  if (rangePlan && capacityAllocations) {
    measuredRangeQuantity = 0;
    let remaining = count;
    for (const allocation of capacityAllocations) {
      const take = Math.min(remaining, allocation.count);
      if (!take) break;
      const quantity = Math.min(allocation.quantity ?? allocation.count * rangePlan.high, take * rangePlan.high);
      measuredRangeQuantity += quantity * rangePlan.multiplier;
      supplyAccounting?.rangeAccepted?.push({ at: allocation.at, count: take, quantity });
      remaining -= take;
    }
  }
  if (supplyAccounting?.acceptedTimes) {
    // A subsequent cycle consumes the SAME plan that produced this number.
    // Capacity allocations are mathematical placements under known ceilings,
    // not newly invented clinical times; they stay inside supply accounting.
    const history = supplyAccounting.acceptedTimes;
    let remaining = count;
    if (capacityAllocations) {
      for (const allocation of capacityAllocations) {
        const take = Math.min(remaining, allocation.count);
        const stamp = new Date(allocation.at).toISOString();
        for (let index = 0; index < take; index++) history.push(stamp);
        remaining -= take;
        if (!remaining) break;
      }
    } else if (selectedTimes) {
      for (const stamp of selectedTimes) {
        if (!remaining) break;
        if (Date.parse(stamp) >= endDay.getTime()) continue;
        history.push(stamp);
        remaining--;
      }
    }
  }
  const doseQuantity = dosage.amounts?.[0]?.quantity?.value ?? 0;
  const targetMultiplier = getAdministrationTargetMultiplier(dosage, context);
  let totalUnits = roundCalculatedUnits(supplyAccounting?.acceptedQuantity ??
    measuredRangeQuantity ?? count * doseQuantity * targetMultiplier);
  if (roundToMultiple && roundToMultiple > 0) {
    totalUnits = roundCalculatedUnits(Math.ceil(totalUnits / roundToMultiple) * roundToMultiple);
  }
  if (lifetimeMaximum !== undefined) {
    totalUnits = roundCalculatedUnits(Math.min(totalUnits, lifetimeMaximum));
  }
  const maximumExplanations: string[] = [];
  if (sourceDosage.amounts?.[0]?.range) {
    maximumExplanations.push(rangePlan
      ? "the largest admissible amount within the prescribed dose range was used for each accepted administration"
      : "the upper bound of the prescribed dose range was used");
    if ((supplyAccounting?.actualPriorCount ?? options.priorDoseTimes?.length ?? 0) > 0)
      maximumExplanations.push(
        `each recorded prior ranged administration was assumed to use the upper dose bound (${roundCalculatedUnits(doseQuantity * targetMultiplier)} ${doseUnitForLimits ?? "units"})`
      );
  }
  if (doseForLimits?.comparator === "<" || doseForLimits?.comparator === "<=")
    maximumExplanations.push("the prescribed upper dose bound was used");
  if (capacityCap)
    maximumExplanations.push(
      "the remaining capacity of each intersecting cap period was used without assigning administration times"
    );
  if (conditional && capacityCap)
    maximumExplanations.push(
      getDosageCalendarDayCondition(dosage) && options.evaluateCondition
        ? "source-certified calendar-day conditions were evaluated per eligible day without assigning administration times"
        : "conditional use remains a capacity ceiling because administration times are unspecified"
    );
  else if (conditional && !options.evaluateCondition)
    maximumExplanations.push(
      "every scheduled clinical condition was assumed true; supply an evaluateCondition callback to calculate a patient-specific conditional schedule"
    );
  if (dosage.asNeeded)
    maximumExplanations.push("PRN doses may be used less frequently than the available opportunities");
  if (maximalTiming.countMaximum) maximumExplanations.push("the upper count bound was used");
  if (maximalTiming.frequencyMaximum)
    maximumExplanations.push("the upper bound of the prescribed frequency range was used");
  if (maximalTiming.periodMinimum) maximumExplanations.push("the shortest executable period bound was used");
  if (maximalTiming.infusionDurationMaximum)
    maximumExplanations.push("the upper bound of the infusion-duration range was used");
  if (lifetimeMaximum !== undefined)
    maximumExplanations.push(
      (supplyAccounting?.usedQuantity ?? 0) > 0
        ? (supplyAccounting?.actualPriorCount ?? options.priorDoseTimes?.length ?? 0) > 0
          ? "the lifetime maximum was reduced by supplied prior administrations and accepted earlier cycle supply"
          : "the lifetime maximum was reduced by accepted earlier cycle supply"
        : (supplyAccounting?.actualPriorCount ?? options.priorDoseTimes?.length ?? 0) > 0
          ? "the lifetime maximum was reduced by the supplied prior administrations"
          : "the full lifetime maximum was treated as still available because no prior administrations were supplied"
    );
  if (unevaluatedMaximumDose)
    maximumExplanations.push("an unevaluable maximum-dose constraint was retained but could not be applied");
  if (hasPartialR6Safety)
    maximumExplanations.push(
      "R6 safety details not expressible as numeric calendar limits were retained but not evaluated"
    );
  if (unresolvedOneTimeActivity)
    maximumExplanations.push(
      "the activity trigger has no known timestamp; a one-time dose is only a maximum supply estimate, not a scheduled administration"
    );
  const result: TotalUnitsResult = {
    totalUnits,
    ...(dosage.amounts?.[0]?.quantity?.unit ?? dosage.amounts?.[0]?.quantity?.code
      ? {
          unit: dosage.amounts?.[0]?.quantity?.unit ?? dosage.amounts?.[0]?.quantity?.code,
        }
      : {}),
    ...(useMaximalPlan || capacityCap
      ? {
          quantityKind: "maximum" as const,
          explanation: `Maximum possible supply: ${maximumExplanations.join("; ")}.`,
        }
      : {}),
  };
  if (
    /\/kg$/i.test(result.unit ?? "") &&
    !(
      options.patientWeightKg !== undefined &&
      Number.isFinite(options.patientWeightKg) &&
      options.patientWeightKg > 0
    )
  ) {
    result.quantityKind = "scheduled";
    result.explanation = "Weight-normalized total; provide patientWeightKg for an absolute quantity.";
  }
  // Handle containers
  const containerValue = context?.containerValue;
  const containerUnit = context?.containerUnit;
  const packageUnit = context?.packageUnit;
  const doseUnit = dosage.amounts?.[0]?.quantity?.unit;
  const unitSemantics = getDoseUnitSemantics(doseUnit, context);
  if (unitSemantics?.approximateQuantity) {
    const approximation = unitSemantics.approximateQuantity;
    result.totalApproximateQuantity = {
      value: roundCalculatedUnits(totalUnits * approximation.value),
      unit: approximation.unit,
      confidence: approximation.confidence,
      basis: approximation.basis,
      source: approximation.source,
    };
    result.totalApproximateIngredientQuantity = estimateIngredientQuantity(
      result.totalApproximateQuantity,
      context
    );
  }
  if (containerValue && containerValue > 0) {
    let effectiveUnits = totalUnits;
    let effectiveContainerValue = containerValue;
    let containerComparable = true;
    if (
      containerUnit &&
      result.totalApproximateQuantity?.unit &&
      result.totalApproximateQuantity.value !== undefined &&
      result.totalApproximateQuantity.unit.trim().toLowerCase() === containerUnit.trim().toLowerCase()
    ) {
      effectiveUnits = result.totalApproximateQuantity.value;
      result.totalContainerQuantity = {
        value: result.totalApproximateQuantity.value,
        unit: containerUnit,
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
          unit: containerUnit,
        };
      }
    } else if (
      containerUnit &&
      doseUnit &&
      containerUnit.trim().toLowerCase() === doseUnit.trim().toLowerCase()
    ) {
      // The prescription already counts in the container's exact unit.
      result.totalContainerQuantity = { value: totalUnits, unit: containerUnit };
    } else if (containerUnit && doseUnit && containerUnit !== doseUnit) {
      const strength = resolveContextStrengthRatio(context);
      const converted = convertValue(totalUnits, doseUnit, containerUnit, measuredStrengthRatio(context));
      if (converted !== null) {
        effectiveUnits = converted;
      } else {
        // A multi-ingredient strength cannot provide a single concentration
        // to infer container volume. Do not equate incompatible dose units.
        containerComparable = false;
      }
    }
    if (containerComparable) {
      result.totalContainers = Math.ceil(effectiveUnits / effectiveContainerValue);
    }
  }
  return result;
}
function calculateChronologicalCourseUnits(
  course: CanonicalCourse, originalOf: Map<CanonicalAdministration, CanonicalAdministration>,
  options: CanonicalSupplyOptions, zone: string, queryStart: Date, queryEnd: Date,
  anchor: Date, lifetimeUsage?: LifetimeCycleUsage
): TotalUnitsResult {
      const events=chronologicalRepeatedEvents(course,{
        ...options,from:queryStart,orderedAt:anchor,limit:10000
      },zone,queryEnd,Number.POSITIVE_INFINITY,options.context);
      // Each accepted cycle event is one clinical administration, even when
      // two cycles overlap at the exact same clock time. Keep its count,
      // not a deduplicated list of dates or a second scheduling projection.
      const byMember=new Map<string,{member:CanonicalAdministration;count:number;quantity?:number}>();
      for(const event of events){
        let group=byMember.get(event.key);
        if(!group) {
          group={member:originalOf.get(event.member) ?? event.member,count:0};
          byMember.set(event.key,group);
        }
        group.count++;
        if (event.quantity !== undefined) group.quantity = (group.quantity ?? 0) + event.quantity;
      }
      const entries:Array<{total:TotalUnitsResult;unit:string|undefined}>=[];
      for(const [key, group] of byMember){
        const dosage:CanonicalAdministration={
          ...group.member,
          delayMinutes:undefined,phaseOrigin:undefined,phaseOriginIssue:undefined,
          // Retain authored period limits for the final supply explanation.
          // The acceptedEventCount path never re-enforces them; any cap that
          // could NOT be executed in the chronological ledger must still be
          // visible as an unevaluated maximum, rather than vanishing.
          // Eligibility was already evaluated on each concrete event.
          // Without a patient-specific condition evaluator, the accepted
          // opportunities still represent a MAXIMUM rather than a promise
          // of doses administered, so retain that typed condition as an
          // explanation source for calculateTotalUnitsSingle.
          predicate:options.evaluateCondition?undefined:group.member.predicate,
          calendarPredicate:options.evaluateCondition?undefined:group.member.calendarPredicate,
          excludedDates:undefined,excludedWeekdays:undefined,
        };
        const total=calculateTotalUnitsSingle({
          ...options,dosage,from:queryStart,orderedAt:anchor,
          durationValue:(queryEnd.getTime()-queryStart.getTime())/1000,
          durationUnit:DurationUnit.Second,roundToMultiple:undefined,
          evaluateCondition:undefined,
        }, group.count, lifetimeUsage || group.quantity !== undefined ? {
          usedQuantity: lifetimeUsage?.get(key) ?? 0,
          actualPriorCount: options.priorDoseTimes?.length ?? 0,
          acceptedQuantity: group.quantity,
        } : undefined);
        if (lifetimeUsage && hasLifetimeLimit(group.member))
          lifetimeUsage.set(key, (lifetimeUsage.get(key) ?? 0) + total.totalUnits);
        entries.push({total,unit:total.unit});
      }
      return sumCourseUnits(entries,options);
}
/** A single component shares its rolling quantity ceiling across active
 * cycles. If a feasible plan fills a cap-width partition of this query, no
 * alternative clock plan can increase its total. Calendar month/year caps
 * need their actual cutoff history and do not use this elapsed-time proof. */
function attainedChronologicalSupplyBound(
  course: CanonicalCourse, result: TotalUnitsResult, options: CanonicalSupplyOptions,
  start: Date, end: Date
): boolean {
  if (course.stages.length !== 1 || course.stages[0].administrations.length !== 1) return false;
  const member = course.stages[0].administrations[0];
  const quantity = member.amounts?.length === 1 ? member.amounts[0].quantity : undefined;
  const unit = quantity?.unit ?? quantity?.code;
  if (!quantity || result.unit !== unit || /\/kg$/i.test(unit ?? "")) return false;
  const range = member.amounts![0].range ? executableDoseRange(member, options.context) : undefined;
  if (member.amounts![0].range && !range) return false;
  const multiplier = getAdministrationTargetMultiplier(member, options.context);
  const caps = range?.caps ?? executableQuantityCaps(member, options.context);
  for (const cap of caps) {
    const width = elapsedCapMilliseconds(cap);
    if (!width || !Number.isFinite(width) || !Number.isFinite(cap.max) || cap.max <= 0) continue;
    let bound = Math.ceil((end.getTime() - start.getTime()) / width) * cap.max *
      (range ? 1 : quantity.value!) * multiplier;
    if (options.roundToMultiple && options.roundToMultiple > 0)
      bound = Math.ceil(bound / options.roundToMultiple) * options.roundToMultiple;
    if (result.totalUnits >= bound - 1e-9) return true;
  }
  return false;
}
/** Compare complete feasible supply plans; inferred upper-frequency clocks
 * cannot erase larger authored-clock quantities in a short query window. */
function maximumChronologicalTimedCourseUnits(
  course: CanonicalCourse, options: CanonicalSupplyOptions, zone: string,
  queryStart: Date, queryEnd: Date, anchor: Date, lifetimeUsage?: LifetimeCycleUsage
): TotalUnitsResult {
  const maximum = maximumChronologicalSupplyCourse(course, options);
  if (!maximum.hasClockAlternative) return calculateChronologicalCourseUnits(
    maximum.course, maximum.originalOf, options, zone, queryStart, queryEnd, anchor, lifetimeUsage);
  const upperUsage = lifetimeUsage ? new Map(lifetimeUsage) : undefined;
  const upper = calculateChronologicalCourseUnits(maximum.course, maximum.originalOf,
    options, zone, queryStart, queryEnd, anchor, upperUsage);
  if (attainedChronologicalSupplyBound(maximum.course, upper, options, queryStart, queryEnd)) {
    if (lifetimeUsage && upperUsage) {
      lifetimeUsage.clear();
      for (const [key, value] of upperUsage) lifetimeUsage.set(key, value);
    }
    return upper;
  }
  const authored = maximumChronologicalSupplyCourse(course, options, true);
  const authoredUsage = lifetimeUsage ? new Map(lifetimeUsage) : undefined;
  const concrete = calculateChronologicalCourseUnits(authored.course, authored.originalOf,
    options, zone, queryStart, queryEnd, anchor, authoredUsage);
  const selected = concrete.totalUnits > upper.totalUnits ? concrete : upper;
  const selectedUsage = selected === concrete ? authoredUsage : upperUsage;
  if (lifetimeUsage && selectedUsage) {
    lifetimeUsage.clear();
    for (const [key, value] of selectedUsage) lifetimeUsage.set(key, value);
  }
  return selected;
}
/** Untimed use allowances have no event timestamps. Resolve their original
 * phase windows through the capacity planner alongside the timed ledger. */
function maximumChronologicalCourseUnits(
  course: CanonicalCourse, options: CanonicalSupplyOptions, zone: string,
  queryStart: Date, queryEnd: Date, anchor: Date, lifetimeUsage?: LifetimeCycleUsage
): TotalUnitsResult {
  const timed = maximumChronologicalTimedCourseUnits(
    course, { ...options, roundToMultiple: undefined }, zone, queryStart, queryEnd, anchor, lifetimeUsage);
  for (const stage of course.stages) for (const member of stage.administrations) {
    if (!unscheduledOccurrenceCapacity(member)) continue;
    const capacity = calculateCourseTotalUnits(course, { ...options, roundToMultiple: undefined },
      undefined, undefined, undefined, undefined, lifetimeUsage, undefined, true);
    return sumCourseUnits([{ total: timed, unit: timed.unit },
      { total: capacity, unit: capacity.unit }], options);
  }
  return options.roundToMultiple ? sumCourseUnits([{ total: timed, unit: timed.unit }], options) : timed;
}
interface UnscheduledWindowPlan {
  dosage: CanonicalAdministration;
  windows: SupplyCapacityWindow[];
}
/**
 * Calculate a complete sequential/parallel regimen with the same global R6
 * step windows that the scheduler uses. Supply is summed per component,
 * never by pretending that all stages run through the whole request window.
 */
function calculateCourseTotalUnits(
  course: CanonicalCourse,
  options: CanonicalSupplyOptions,
  cycleDefaultEnd?: Date,
  cycleIndex?: number,
  sourceClock?: TreatmentWallClock,
  rollingUsage?: RollingCycleUsage,
  lifetimeUsage?: LifetimeCycleUsage,
  rangeUsage?: RangeCycleUsage,
  capacityOnly = false,
  capacityWindows?: Map<string, UnscheduledWindowPlan>
): TotalUnitsResult {
  if (capacityOnly && !capacityWindows) {
    const collected = new Map<string, UnscheduledWindowPlan>();
    const ordinary = calculateCourseTotalUnits(course, { ...options, roundToMultiple: undefined },
      cycleDefaultEnd, cycleIndex, sourceClock, rollingUsage, lifetimeUsage, rangeUsage, true, collected);
    const entries = [{ total: ordinary, unit: ordinary.unit }];
    for (const [key, plan] of collected) {
      plan.windows.sort((a, b) => a.start - b.start);
      const source = plan.dosage;
      const dosage: CanonicalAdministration = { ...source, phaseOrigin: undefined, phaseOriginIssue: undefined,
        schedule: { ...source.schedule, recurrence: { ...source.schedule?.recurrence,
          count: undefined, countMax: undefined,
          courseLength: undefined, courseLengthRange: undefined, calendarWindow: undefined } } };
      const from = coerceDate(options.from, "from").getTime();
      const past: SupplyCapacityWindow[] = [], future: SupplyCapacityWindow[] = [];
      for (const window of plan.windows) {
        if (window.start < from) past.push({ ...window, end: Math.min(from, window.end) });
        if (window.end > from) future.push({ ...window, start: Math.max(from, window.start) });
      }
      const ranged = !!source.amounts?.[0]?.range;
      const history: SupplyAllocation[] = [], historyTimes: string[] = [];
      if (past.length) calculateTotalUnitsSingle({ ...options, dosage,
        from: new Date(past[0].start), durationValue: (from - past[0].start) / 1000,
        durationUnit: DurationUnit.Second, roundToMultiple: undefined,
      }, undefined, { actualPriorCount: options.priorDoseTimes?.length ?? 0, capacityWindows: past,
        ...(ranged ? { rangeAccepted: history } : { acceptedTimes: historyTimes }) });
      const total = calculateTotalUnitsSingle({ ...options, dosage, roundToMultiple: undefined,
        ...(!ranged && historyTimes.length ? {
          priorDoseTimes: [...(options.priorDoseTimes ?? []), ...historyTimes],
        } : {}),
      }, undefined, {
        actualPriorCount: options.priorDoseTimes?.length ?? 0,
        usedQuantity: lifetimeUsage?.get(key) ?? 0, capacityWindows: future,
        ...(ranged && history.length ? { rangePrior: history } : {}),
      });
      if (lifetimeUsage && hasLifetimeLimit(source))
        lifetimeUsage.set(key, (lifetimeUsage.get(key) ?? 0) + total.totalUnits);
      entries.push({ total, unit: total.unit });
    }
    return sumCourseUnits(entries, options);
  }
  course = executionCourseWithPeriodOffsets(selectedAlternativeCourse(course, options));
  requireExecutableCourseContext(course, "calculating");
  const zone = options.timeZone ?? options.config?.timeZone;
  if (!zone)
    throw new MedicationQuantityCalculationError(
      "time-zone-required",
      "Provide timeZone to calculate local administration times and calendar-month transitions."
    );
  const queryStart = coerceDate(options.from, "from");
  const queryEnd = calculationHorizon(options, zone);
  if (!course.stages.length || course.stages.every((step) => !step.administrations.length))
    throw new MedicationQuantityCalculationError(
      "missing-regimen",
      "A medication dosage or complete treatment course is required for supply calculation."
    );
  const anchor = options.orderedAt === undefined ? queryStart : coerceDate(options.orderedAt, "orderedAt");
  const repeatedStep = hasRepeatedStep(course);
  if (repeatedStep) lifetimeUsage ??= lifetimeCycleUsage(course);
  if (!capacityOnly && !course.cycleInterval && repeatedStep && hasRollingCycleLimit(course)) {
    return maximumChronologicalCourseUnits(course, options, zone, queryStart, queryEnd, anchor, lifetimeUsage);
  }
  const cycleAdvance = durationStepper(course.cycleInterval, zone, anchor);
  if (course.cycleInterval && !cycleAdvance)
    throw new MedicationQuantityCalculationError(
      "repeat-cycle-unresolved",
      "The supplied repeatCycle does not define a usable numeric interval. Original recurrence is preserved; correct its unit or choose a duration before calculating supply."
    );
  if (cycleAdvance) {
    const firstClock = getTimeParts(anchor, zone);
    const calendarCycle = !!normalizedCalendarInterval(
      course.cycleInterval?.value,
      parseBoundsDurationUnit(course.cycleInterval)
    );
    const entries: Array<{
      total: TotalUnitsResult;
      unit: string | undefined;
    }> = [];
    const singleCycle = { ...course, cycleInterval: undefined };
    const priorCycleUsage = hasRollingCycleLimit(singleCycle)
      ? new Map<string, string[]>() : undefined;
    // Lifetime consumption before this requested supply plan belongs to
    // supplied ACTUAL administrations, exactly as in the single-cycle API.
    // Do not invent historic consumption from scheduled opportunities. This
    // ledger carries only accepted quantity within the current supply plan.
    lifetimeUsage ??= lifetimeCycleUsage(singleCycle);
    if (!rangeUsage) for (const stage of singleCycle.stages) for (const member of stage.administrations)
      if (member.amounts?.[0]?.range && hasPeriodLimits(member) && unscheduledOccurrenceCapacity(member)) {
        rangeUsage = new Map(); break;
      }
    const timedRangedCaps = priorCycleUsage && hasTimedRangedCaps(singleCycle);
    if (!capacityOnly && priorCycleUsage && (timedRangedCaps || rangeUsage || !definitelyNonOverlappingCycle(singleCycle, course.cycleInterval))) {
      return maximumChronologicalCourseUnits(course, options, zone,
        queryStart, queryEnd, anchor, lifetimeUsage);
    }
    let cycleStart = anchor;
    let guard = 0;
    while (
      cycleStart < queryEnd &&
      guard < Math.min(10000, positiveInteger(course.cycleCount) ?? Infinity)
    ) {
      const cycleEnd = cycleAdvance(cycleStart);
      if (!cycleEnd || cycleEnd <= cycleStart) break;
      const originalClock = repeatedCycleWallClock(calendarCycle, firstClock, cycleStart, zone);
      const horizon = repeatedCourseHorizon(singleCycle, cycleStart, cycleEnd, zone, originalClock, options);
      const windowStart = cycleStart > queryStart ? cycleStart : queryStart;
      const windowEnd = horizon < queryEnd ? horizon : queryEnd;
      if (priorCycleUsage && cycleStart < queryStart) {
        // Establish the existing rolling history from the same maximum
        // supply plan, including cap-only capacity. These prior plan
        // allocations do not claim actual historical lifetime consumption.
        const priorEnd = horizon < queryStart ? horizon : queryStart;
        if (priorEnd > cycleStart) calculateCourseTotalUnits(singleCycle, {
          ...options, from: cycleStart, orderedAt: cycleStart,
          durationValue: (priorEnd.getTime() - cycleStart.getTime()) / 1000,
          durationUnit: DurationUnit.Second, priorCount: undefined,
          roundToMultiple: undefined,
        }, cycleEnd, guard, originalClock, priorCycleUsage, undefined, rangeUsage, capacityOnly, capacityWindows);
      }
      if (windowEnd > windowStart) {
        const total = calculateCourseTotalUnits(
          singleCycle,
          {
            ...options,
            from: windowStart,
            orderedAt: cycleStart,
            durationValue: (windowEnd.getTime() - windowStart.getTime()) / 1000,
            durationUnit: DurationUnit.Second,
            priorCount: undefined,
            roundToMultiple: undefined,
          },
          cycleEnd,
          guard,
          originalClock,
          priorCycleUsage,
          lifetimeUsage,
          rangeUsage,
          capacityOnly,
          capacityWindows
        );
        entries.push({ total, unit: total.unit });
      }
      if(priorCycleUsage)trimRollingCycleHistory(singleCycle,priorCycleUsage,cycleEnd,zone);
      if(rangeUsage)trimRollingCycleHistory(singleCycle,rangeUsage,cycleEnd,zone);
      cycleStart = cycleEnd;
      guard += 1;
    }
    return sumCourseUnits(entries, options);
  }
  const anchored = options.orderedAt !== undefined;
  const assumedTreatmentStart = course.stages.length > 1 && !anchored;
  const treatmentStart = anchored ? coerceDate(options.orderedAt!, "orderedAt") : queryStart;
  const entries: Array<{ total: TotalUnitsResult; unit: string | undefined }> = [];
  let assumedOpenTransition = false;
  for (const { index, window } of treatmentStepWindows(
    course, treatmentStart, zone, sourceClock, options
  )) {
    if (!window.end && index + 1 < course.stages.length) assumedOpenTransition = true;
    for (let memberIndex=0;memberIndex<window.administrations.length;memberIndex++) {
      const member = window.administrations[memberIndex];
      const dosage = member.administration,
        begin = member.eligibleFrom;
      if (capacityOnly && !unscheduledOccurrenceCapacity(dosage)) continue;
      const nativeEnd = earlierDate(window.end ?? null, member.endExclusive);
      const end = minDate(queryEnd, nativeEnd ?? cycleDefaultEnd ?? null);
      if (end <= begin || end <= queryStart) continue;
      // A pooled ranged plan keeps every resolved cycle/step count as a
      // separate quota; amounts can then be optimized across those windows
      // without turning their counts into a single global allowance.
      if (capacityWindows && !dosage.delayMinutes) {
        const repeat = dosage.schedule?.recurrence;
        const count = repeat ? repeatOccurrenceCap(repeat) : undefined;
        const cap = unscheduledOccurrenceCapacity(dosage)!;
        const buckets = occurrenceCapBucketIndex(new Date(end.getTime() - 1), cap, zone) -
          occurrenceCapBucketIndex(begin, cap, zone) + 1;
        if (count === undefined || (options.priorCount === undefined &&
            ((dosage.amounts?.[0]?.range && hasPeriodLimits(dosage)) ||
             (!options.priorDoseTimes?.length && buckets * cap.max <= count)))) {
          const key = rollingCycleKey(index, memberIndex);
          let plan = capacityWindows.get(key);
          if (!plan) capacityWindows.set(key, plan = { dosage, windows: [] });
          plan.windows.push({ start: Math.max(begin.getTime(), queryStart.getTime()), end: end.getTime(),
            ...(count === undefined ? {} : { quota: {
              id: (cycleIndex ?? 0) + ":" + window.start.getTime(), maximum: count,
              start: begin.getTime(), end: nativeEnd?.getTime() ?? cycleDefaultEnd?.getTime() ?? Infinity,
            } }) });
          continue;
        }
      }
      if (!dosage.schedule?.recurrence && !dosage.schedule?.explicitEvents?.length)
        throw new MedicationQuantityCalculationError(
          "timing-required",
          "Stage " + (index + 1) + " has no executable frequency or dosing time for one component."
        );
      const bounded: CanonicalAdministration = {
        ...dosage,
        phaseOrigin: undefined,
        phaseOriginIssue: undefined,
        schedule: {
          ...dosage.schedule,
          recurrence: {
            ...dosage.schedule.recurrence,
            // The resolved plan already owns the cap. This local copy
            // clips accounting without changing the recurrence origin.
            courseLength: undefined,
            courseLengthRange: undefined,
            calendarWindow: {
              start: member.recurrenceOrigin.toISOString(),
              end: new Date(end.getTime() - 1).toISOString(),
            },
          },
        },
      };
      const key = rollingCycleKey(index, memberIndex);
      const weighted = rangeUsage && dosage.amounts?.[0]?.range && unscheduledOccurrenceCapacity(dosage);
      const rangeAccepted: SupplyAllocation[] | undefined = weighted ? [] : undefined;
      const rangePrior = weighted ? rangeUsage!.get(key) : undefined;
      const acceptedTimes: string[] | undefined = rollingUsage &&
          (hasPeriodLimits(dosage) || getTimingOccurrenceCap(dosage.schedule?.recurrence))
        ? [] : undefined;
      const total = calculateTotalUnitsSingle({
        ...options,
        dosage: bounded,
        from: begin > queryStart ? begin : queryStart,
        orderedAt: member.recurrenceOrigin,
        roundToMultiple: undefined,
        ...(rollingUsage && !weighted ? { priorDoseTimes: rollingPriorTimes(
          rollingUsage, key, options.priorDoseTimes
        ) } : {}),
        ...(member.countEligibilityStart ? { countEligibilityStart: member.countEligibilityStart } : {}),
      } as CanonicalSupplyOptions & PhaseCountOptions & { dosage: CanonicalAdministration },
        undefined, lifetimeUsage || acceptedTimes || rangeAccepted ? {
          usedQuantity: lifetimeUsage?.get(key) ?? 0,
          actualPriorCount: options.priorDoseTimes?.length ?? 0,
          acceptedTimes, rangePrior, rangeAccepted,
        } : undefined);
      if (rangeAccepted?.length && rangeUsage) {
        if (rangePrior) (rangePrior as SupplyAllocation[]).push(...rangeAccepted);
        else rangeUsage.set(key, rangeAccepted);
      }
      if (acceptedTimes?.length && rollingUsage) {
        const history = rollingUsage.get(key);
        if (history) history.push(...acceptedTimes);
        else rollingUsage.set(key, acceptedTimes);
      }
      if (lifetimeUsage && hasLifetimeLimit(dosage))
        lifetimeUsage.set(key, (lifetimeUsage.get(key) ?? 0) + total.totalUnits);
      entries.push({ total, unit: total.unit });
    }
  }
  const result = sumCourseUnits(entries, options);
  const assumptions: string[] = [];
  if (assumedTreatmentStart)
    assumptions.push(
      "Treatment start was assumed to be the requested from time because orderedAt was not supplied."
    );
  if (assumedOpenTransition)
    assumptions.push(
      "A stage without a stated cutover was continued through the requested calculation horizon."
    );
  if (assumptions.length) result.explanation = [result.explanation, ...assumptions].filter(Boolean).join(" ");
  const hasPartialSafety =
    Boolean(course.safety) ||
    course.stages.some(
      (step) =>
        Boolean(step.safety) || step.administrations.some((component) => Boolean(component.safety))
    );
  if (!hasPartialSafety) return result;
  const note = "R6 safety details that are not numeric calendar limits were retained but not evaluated.";
  return {
    ...result,
    quantityKind: "maximum",
    explanation: result.explanation ? `${result.explanation} ${note}` : note,
  };
}
export function calculateTotalUnits(options: CanonicalSupplyOptions): TotalUnitsResult {
  if (!options || !options.dosage)
    throw new MedicationQuantityCalculationError(
      "missing-regimen",
      "A medication dosage or complete treatment course is required for supply calculation."
    );
  const input = options.dosage;
  if (!Array.isArray(input) && "stages" in input)
    return calculateCourseTotalUnits(input as CanonicalCourse, options);
  if (Array.isArray(input)) return calculateCourseTotalUnits(courseFromCanonicalRows(input), options);
  const one = input as CanonicalAdministration;
  if (one.phaseOrigin || one.phaseOriginIssue ||
      one.schedule?.recurrence?.startOffset || one.schedule?.recurrence?.endOffset)
    return calculateCourseTotalUnits(courseFromCanonicalRows([one]), options);
  const choice = executionChoice(one);
  if (choice) {
    const selected = options.alternativeChoices?.[choice.groupId];
    if (!selected) {
      throw new MedicationQuantityCalculationError(
        "alternative-choice-required",
        `Select a branch for '${choice.groupId}' in alternativeChoices before calculating supply. This dosage is '${choice.branchId}'; all alternatives remain editable.`
      );
    }
    if (selected !== choice.branchId) {
      return {
        totalUnits: 0,
        unit: one.amounts?.[0]?.quantity?.unit,
        quantityKind: "scheduled",
        explanation: "This is an unselected alternative; it contributes no administrations or supply.",
      };
    }
    return calculateTotalUnitsSingle({
      ...options,
      dosage: {
        ...one,
        choice: undefined,
        choiceIssue: undefined,
      },
    });
  }
  return calculateTotalUnitsSingle(
    options as Omit<CanonicalSupplyOptions, "dosage"> & {
      dosage: CanonicalAdministration;
    }
  );
}
interface ClockEntry {
  time: string;
  dayShift: number;
}
/** Occurrence enumeration, historical caps and totals use exactly the same clock defaults. */
function resolveExplicitClockEntries(
  repeat: CanonicalRecurrence,
  config: NextDueDoseConfig,
  dayFiltered: boolean
): ClockEntry[] {
  const when = repeat.anchors ?? [],
    clocks = repeat.clocks ?? [];
  const entries = expandWhenCodes(when, config, repeat);
  // "BID with food" specifies TWO administrations chosen from the meal
  // context, not every breakfast/lunch/dinner. An exclusion weekday used
  // to force enumeration of three C/AC/PC meal clocks and thereby inflate
  // the prescribed BID dose count. Fall back to the exact frequency's
  // configured clocks when an unspecific meal window has more candidates
  // than the explicitly prescribed daily frequency.
  if (
    when.length === 1 &&
    clocks.length === 0 &&
    (when[0] === "C" || when[0] === "AC" || when[0] === "PC") &&
    repeat.period === 1 &&
    repeat.periodUnit === "d" &&
    repeat.frequency !== undefined &&
    entries.length !== repeat.frequency
  ) {
    return [];
  }
  for (const clock of clocks) entries.push({ time: normalizeClock(clock), dayShift: 0 });
  if (clocks.length) entries.sort((a, b) => a.dayShift - b.dayShift || a.time.localeCompare(b.time));
  if (
    !entries.length &&
    !clocks.length &&
    (dayFiltered || !repeat.frequency || !repeat.period || !repeat.periodUnit)
  )
    entries.push(...inferWhenFallbackEntries(when, repeat));
  return entries;
}
/** Whether a calendar-period frequency needs more days than its clock anchors.
 * @param repeat Typed frequency and calendar period.
 * @param entries Resolved clocks, including meal offsets across midnight.
 * @param dayFiltered Whether explicit weekdays already select eligible days.
 * @returns True when the existing per-period distributor supplies the cadence.
 */
function hasDistributedClockFrequency(
  repeat: CanonicalRecurrence,
  entries: readonly ClockEntry[],
  dayFiltered: boolean
): boolean {
  if (
    dayFiltered ||
    !entries.length ||
    !positiveInteger(repeat.frequency) ||
    repeat.frequency! <= entries.length ||
    !positiveNumber(repeat.period) ||
    arrayIncludes(repeat.anchors ?? [], TimingEvent.Immediate)
  )
    return false;
  return (
    repeat.periodUnit === DurationUnit.Week ||
    repeat.periodUnit === DurationUnit.Month ||
    repeat.periodUnit === DurationUnit.Year ||
    (repeat.periodUnit === DurationUnit.Day && repeat.period! > 1)
  );
}
/** Clock anchors restrict time within an eligible period; they do not erase its cadence. */
function clockCadenceEligible(
  day: Date,
  anchor: Date,
  repeat: CanonicalRecurrence,
  timeZone: string,
  dayFiltered: boolean
): boolean {
  if (!repeat.period || !repeat.periodUnit || (repeat.periodUnit === "d" && repeat.period <= 1)) return true;
  if (repeat.periodUnit === "wk" && !dayFiltered) {
    const delta = getLocalDayNumber(day, timeZone) - getLocalDayNumber(anchor, timeZone);
    return delta >= 0 && delta % (7 * repeat.period) === 0;
  }
  if ((repeat.periodUnit === "mo" || repeat.periodUnit === "a") && !dayFiltered) {
    const months = getLocalMonthIndex(day, timeZone) - getLocalMonthIndex(anchor, timeZone);
    const period = repeat.period * (repeat.periodUnit === "a" ? 12 : 1);
    if (months < 0 || months % period !== 0) return false;
    return (
      getTimeParts(day, timeZone).day ===
      getTimeParts(addCalendarMonths(anchor, months, timeZone), timeZone).day
    );
  }
  return isDateAlignedToPeriodCycle(day, anchor, repeat, timeZone);
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
  dosage: {
    schedule?: CanonicalAdministration["schedule"];
  },
  predecessorPoint: Date | undefined,
  fallback: Date,
  zone: string
): Date {
  const repeat = dosage.schedule?.recurrence;
  if (
    predecessorPoint &&
    repeat?.period &&
    repeat.periodUnit &&
    !repeat.anchors?.length &&
    !repeat.clocks?.length &&
    !repeat.dayOfWeek?.length &&
    !dosage.schedule?.code?.coding?.length
  ) {
    return (
      createIntervalStepper(
        {
          period: repeat.period / (repeat.frequency ?? 1),
          periodUnit: repeat.periodUnit,
        },
        zone
      )?.(predecessorPoint) ?? fallback
    );
  }
  return fallback;
}
/** Completion of a finite administration count, independent of query window. */
/** Finite explicit events end at their authored final opportunity. Local
 * caps cannot determine this horizon: another active cycle shares their
 * admission ledger, and no rejected fixed event can move to a new date. */
function explicitAdministrationCompletion(
  dosage: CanonicalAdministration, start: Date, eligibleFrom: Date,
  options: NextDueDoseOptions, zone: string
): { end: Date; point: boolean } | undefined {
  const repeat = dosage.schedule?.recurrence;
  const raw = withoutOccurrenceCap({
    ...dosage, phaseOrigin: undefined, phaseOriginIssue: undefined,
    limits: dosage.limits?.filter(limit => limit.scope !== "period"),
    schedule: { ...dosage.schedule, recurrence: repeat
      ? { ...repeat, count: undefined, countMax: undefined } : undefined },
  });
  const due = nextDueDoses(raw, { ...options, from: eligibleFrom, orderedAt: start,
    priorCount: undefined, priorDoseTimes: undefined, limit: 10000 });
  return due.length ? completionAfterAcceptedAdministration(dosage, new Date(due[due.length - 1]), zone) : undefined;
}
function finiteAdministrationCompletion(
  dosage: CanonicalAdministration,
  start: Date,
  options: NextDueDoseOptions,
  zone: string,
  eligibleFrom: Date = start
):
  | {
      end: Date;
      point: boolean;
    }
  | undefined {
  const repeat = dosage.schedule?.recurrence;
  if (!repeat) return undefined;
  const count = repeat.count ?? (arrayIncludes(repeat.anchors ?? [], TimingEvent.Immediate) ? 1 : undefined);
  if (
    count === undefined ||
    !Number.isInteger(count) ||
    count <= 0 ||
    (repeat.countMax !== undefined && repeat.countMax !== count)
  )
    return undefined;
  // The enclosing course has already supplied the predecessor/cycle context
  // and resolved this component's cadence origin. Count only this local
  // execution copy, rather than reopening it as an isolated persisted row.
  const local =
    dosage.phaseOrigin || dosage.phaseOriginIssue
      ? { ...dosage, phaseOrigin: undefined, phaseOriginIssue: undefined }
      : dosage;
  // Completion is a historical boundary, not the number of doses still due.
  // Only records inside this phase can complete it; older records still belong
  // to the rolling-cap history and can defer its first eligible opportunity.
  const queryFrom = coerceDate(options.from, "from");
  const actual: number[] = [];
  for (const stamp of options.priorDoseTimes ?? []) {
    const at = coerceDate(stamp, "priorDoseTimes").getTime();
    if (at >= eligibleFrom.getTime() && at < queryFrom.getTime()) actual.push(at);
  }
  if (actual.length > 1) actual.sort((a, b) => a - b);
  if (actual.length >= count)
    return completionAfterAcceptedAdministration(dosage, new Date(actual[count - 1]), zone);
  // A PRN phase cannot complete from unrecorded opportunities before this
  // query. Its supplied prior count reduces only the remaining allowance.
  const used = dosage.asNeeded ? options.priorCount ?? actual.length : actual.length;
  const remaining = count - used;
  if (remaining <= 0) return undefined;
  const future = !!actual.length || !!dosage.asNeeded;
  const probe = future ? {
    ...local, schedule: { ...local.schedule, recurrence: { ...repeat, count: undefined, countMax: undefined } },
  } : local;
  const due = nextDueDoses(probe, {
    ...options,
    from: future && queryFrom > eligibleFrom ? queryFrom : eligibleFrom,
    orderedAt: start,
    priorCount: undefined,
    limit: remaining,
    ...(eligibleFrom > start ? { countEligibilityStart: eligibleFrom } : {}),
  } as PhaseCountOptions);
  if (due.length !== remaining) return undefined;
  return completionAfterAcceptedAdministration(dosage, new Date(due[due.length - 1]), zone);
}

/** The occurrence's duration extends its final accepted point. Both local
 * finite phases and the chronological ledger use this same completion rule. */
function completionAfterAcceptedAdministration(
  dosage: CanonicalAdministration, last: Date, zone: string
): { end: Date; point: boolean } {
  const repeat = dosage.schedule?.recurrence;
  if (repeat?.occurrenceDuration && repeat.occurrenceDurationUnit) {
    const advance = createIntervalStepper(
      { period: repeat.occurrenceDuration, periodUnit: repeat.occurrenceDurationUnit },
      zone
    );
    const end = advance?.(last);
    if (end) return { end, point: false };
  }
  return { end: last, point: true };
}
