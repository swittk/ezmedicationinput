import {
  EventTiming,
  EventClockMap,
  FhirDosage,
  FhirTiming,
  FhirTimingRepeat,
  FrequencyFallbackTimes,
  MealOffsetMap,
  NextDueDoseConfig,
  NextDueDoseOptions
} from "./types";
import { arrayIncludes } from "./utils/array";

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
  const [hour, minute, second] = clock.split(":").map((value) => Number(value));
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
  const zoned = makeZonedDate(timeZone, year, month, day + days, 0, 0, 0);
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

/** Parses arbitrary string/Date inputs into a valid Date instance. */
function coerceDate(value: Date | string, label: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${label} supplied to nextDueDoses`);
  }
  return date;
}

/**
 * Applies a minute offset to a normalized HH:mm:ss clock, tracking any day
 * rollover that might occur.
 */
function applyOffset(clock: string, offsetMinutes: number): ExpandedTime {
  const [hour, minute, second] = clock.split(":").map((part) => Number(part));
  let totalMinutes = hour * SECONDS_PER_MINUTE + minute + offsetMinutes;
  let dayShift = 0;
  while (totalMinutes < 0) {
    totalMinutes += MINUTES_PER_DAY;
    dayShift -= 1;
  }
  while (totalMinutes >= MINUTES_PER_DAY) {
    totalMinutes -= MINUTES_PER_DAY;
    dayShift += 1;
  }
  const adjustedHour = Math.floor(totalMinutes / SECONDS_PER_MINUTE);
  const adjustedMinute = totalMinutes % SECONDS_PER_MINUTE;
  return {
    time: `${pad(adjustedHour)}:${pad(adjustedMinute)}:${pad(second)}`,
    dayShift
  };
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
      normalized.push(applyOffset(normalizeClock(base), mealOffsets[code] ?? 0));
    }
  } else if (code === EventTiming["After Meal"]) {
    for (const meal of getDefaultMealPairs(config)) {
      const base = eventClock[meal];
      if (!base) {
        continue;
      }
      normalized.push(applyOffset(normalizeClock(base), mealOffsets[code] ?? 0));
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
      const offset =
        mealOffsets[code] ?? mealOffsets[EventTiming["Before Meal"]] ?? 0;
      normalized.push(offset ? applyOffset(baseClock, offset) : { time: baseClock, dayShift: 0 });
    }
  } else if (code in SPECIFIC_AFTER_MEALS) {
    const mealCode = SPECIFIC_AFTER_MEALS[code];
    const base = eventClock[mealCode];
    if (base) {
      const baseClock = normalizeClock(base);
      const offset =
        mealOffsets[code] ?? mealOffsets[EventTiming["After Meal"]] ?? 0;
      normalized.push(offset ? applyOffset(baseClock, offset) : { time: baseClock, dayShift: 0 });
    }
  }

  if (repeat.offset && normalized.length) {
    return normalized.map((entry) => {
      const adjusted = applyOffset(entry.time, repeat.offset ?? 0);
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
  }
  return Array.from(collected).sort();
}

/**
 * Produces the next dose timestamps in ascending order according to the
 * provided configuration and dosage metadata.
 */
export function nextDueDoses(
  dosage: FhirDosage,
  options: NextDueDoseOptions
): string[] {
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

  const from = coerceDate(options.from, "from");
  const orderedAt =
    options.orderedAt === undefined ? null : coerceDate(options.orderedAt, "orderedAt");
  const priorCountInput = options.priorCount;
  if (priorCountInput !== undefined) {
    if (!Number.isFinite(priorCountInput) || priorCountInput < 0) {
      throw new Error("Invalid priorCount supplied to nextDueDoses");
    }
  }
  let priorCount: number;
  if (priorCountInput !== undefined) {
    priorCount = Math.floor(priorCountInput);
  }
  else {
    if (!orderedAt) {
      // nothing to compare time range between.
      priorCount = 0;
    }
    else {
      // TODO: Compute prior count by traversing all past doses between orderedAt and from.
    }
  }
  const baseTime = orderedAt ?? from;

  const providedConfig = options.config;
  const timeZone = options.timeZone ?? providedConfig?.timeZone;
  if (!timeZone) {
    throw new Error("Configuration with a valid timeZone is required");
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

  if (!timing || !repeat) {
    return [];
  }

  const rawCount = repeat.count;
  const normalizedCount =
    rawCount === undefined ? undefined : Math.max(0, Math.floor(rawCount));
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

  const results: string[] = [];
  const seen = new Set<string>();
  const dayFilter = new Set((repeat.dayOfWeek ?? []).map((day) => day.toLowerCase()));
  const enforceDayFilter = dayFilter.size > 0;

  const whenCodes = repeat.when ?? [];
  const timeOfDayEntries = repeat.timeOfDay ?? [];
  if (whenCodes.length > 0 || timeOfDayEntries.length > 0) {
    const expanded = expandWhenCodes(whenCodes, config, repeat);
    if (timeOfDayEntries.length > 0) {
      for (const clock of timeOfDayEntries) {
        expanded.push({ time: normalizeClock(clock), dayShift: 0 });
      }
      expanded.sort((a, b) => {
        if (a.dayShift !== b.dayShift) {
          return a.dayShift - b.dayShift;
        }
        return a.time.localeCompare(b.time);
      });
    }
    const includesImmediate = arrayIncludes(whenCodes, EventTiming.Immediate);
    if (includesImmediate) {
      const immediateSource = orderedAt ?? from;
      if (!orderedAt || orderedAt >= from) {
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
    if (expanded.length === 0) {
      return results.slice(0, effectiveLimit);
    }
    let currentDay = startOfLocalDay(from, timeZone);
    let iterations = 0;
    const maxIterations = effectiveLimit * 31;
    while (results.length < effectiveLimit && iterations < maxIterations) {
      const weekday = getLocalWeekday(currentDay, timeZone);
      if (!enforceDayFilter || dayFilter.has(weekday)) {
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

  const treatAsInterval =
    !!repeat.period &&
    !!repeat.periodUnit &&
    (!repeat.frequency ||
      repeat.periodUnit !== "d" ||
      (repeat.frequency === 1 && repeat.period > 1));

  if (treatAsInterval) {
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
      orderedAt
    );
    return candidates;
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
    while (results.length < effectiveLimit && iterations < maxIterations) {
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
  orderedAt: Date | null
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
  while (results.length < effectiveLimit && guard < maxIterations) {
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

/** Adds calendar months while respecting varying month lengths and DST. */
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
  const lastDay = new Date(candidate.getTime());
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1);
  lastDay.setUTCDate(0);
  const maxDay = getTimeParts(lastDay, timeZone).day;
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
