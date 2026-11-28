/** Civil-clock primitives shared by clinical occurrence and supply execution.
 * Calendar stepping preserves the prescribed wall clock across DST and month
 * boundaries. No medication, FHIR, parser, or persistence type lives here. */

export const SECONDS_PER_MINUTE = 60;

/** Caches expensive Intl.DateTimeFormat objects per time zone. */
export const dateTimeFormatCache = new Map<string, Intl.DateTimeFormat>();

/** Separate cache for weekday formatting to avoid rebuilding formatters. */
export const weekdayFormatCache = new Map<string, Intl.DateTimeFormat>();

/** An instant and time zone determine the same civil clock for the lifetime
 * of a process's ICU time-zone database. Cache that expensive Intl expansion
 * once; neither external FHIR objects nor scheduling calls are mutated.
 *
 * Bounded FIFO (not an unbounded memo table): after 8192 distinct instants,
 * evict the oldest. An immutable-by-contract TimeParts value is reused
 * directly, with no defensive clone or JSON serialization. */
const TIME_PARTS_CACHE_LIMIT = 8192;
const timePartsCache = new Map<string, TimeParts>();

export interface TimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface DateTimeFormatPart {
  type: string;
  value: string;
}

export interface IntlDateTimeFormatOptionsExtended extends Intl.DateTimeFormatOptions {
  calendar?: string;
  numberingSystem?: string;
}

export interface DateTimeFormatWithParts {
  formatToParts?: (date?: number | Date) => DateTimeFormatPart[];
}

/** Simple zero-padding helper for numeric components. */
export function pad(value: number, length = 2): string {
  const absolute = Math.abs(value);
  let output = absolute.toString();
  while (output.length < length) {
    output = `0${output}`;
  }
  return value < 0 ? `-${output}` : output;
}

export function formatToParts(formatter: Intl.DateTimeFormat, date: Date): DateTimeFormatPart[] {
  const withParts = formatter as DateTimeFormatWithParts;
  if (typeof withParts.formatToParts === "function") {
    return withParts.formatToParts(date);
  }
  throw new Error("Timezone-aware execution requires Intl.DateTimeFormat.prototype.formatToParts");
}

/**
 * Normalizes HH:mm or HH:mm:ss clocks into a consistent HH:mm:ss string.
 */
export function normalizeClock(clock: string): string {
  const parts = clock.split(":");
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`Invalid clock value: ${clock}`);
  }
  const [hourPart, minutePart, secondPart] = [parts[0], parts[1], parts[2] ?? "00"];
  const hour = Number(hourPart);
  const minute = Number(minutePart);
  const second = Number(secondPart);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    Number.isNaN(second) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second >= 60
  ) {
    throw new Error(`Invalid clock value: ${clock}`);
  }
  const point = secondPart.indexOf(".");
  const fraction = point >= 0 ? secondPart.slice(point).replace(/\.?0+$/u, "") : "";
  return `${pad(hour)}:${pad(minute)}:${pad(Math.floor(second))}${fraction}`;
}

/** Retrieves (and caches) an Intl formatter for calendar components. */
export function getDateTimeFormat(timeZone: string): Intl.DateTimeFormat {
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
      second: "2-digit",
    };
    formatter = new Intl.DateTimeFormat("en-CA", options);
    dateTimeFormatCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Retrieves (and caches) a formatter for weekday lookups. */
export function getWeekdayFormat(timeZone: string): Intl.DateTimeFormat {
  let formatter = weekdayFormatCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      weekday: "short",
    });
    weekdayFormatCache.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * Extracts calendar components for a Date interpreted within the supplied time
 * zone.
 */
export function getTimeParts(date: Date, timeZone: string): TimeParts {
  const instant = date.getTime();
  const key = Number.isFinite(instant) ? timeZone + ":" + instant : undefined;
  if (key !== undefined) {
    const cached = timePartsCache.get(key);
    if (cached !== undefined) return cached;
  }
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
  const result = parts as TimeParts;
  if (key !== undefined) {
    if (timePartsCache.size >= TIME_PARTS_CACHE_LIMIT)
      timePartsCache.delete(timePartsCache.keys().next().value!);
    timePartsCache.set(key, result);
  }
  return result;
}

function offsetFromTimeParts(date: Date, parts: TimeParts): number {
  const { year, month, day, hour, minute, second } = parts;
  const zonedTime = Date.UTC(year, month - 1, day, hour, minute, second);
  // Intl parts are whole-second precision. Match that precision on the
  // source instant (including pre-epoch times) before calculating minutes.
  return (zonedTime - (date.getTime() - date.getUTCMilliseconds())) / (SECONDS_PER_MINUTE * 1000);
}

/** Calculates the time-zone offset in minutes for a given instant. */
export function getOffset(date: Date, timeZone: string): number {
  return offsetFromTimeParts(date, getTimeParts(date, timeZone));
}

/** Locate the offset transition within one civil day. Calendar arithmetic
 * can then split at the real discontinuity instead of assuming local wall
 * clocks are monotone across a DST fold. Ordinary days need two lookups. */
export function calendarOffsetTransition(start: Date, end: Date, timeZone: string): number | undefined {
  const before = getOffset(start, timeZone);
  if (getOffset(new Date(end.getTime() - 1), timeZone) === before) return undefined;
  let low = start.getTime(), high = end.getTime() - 1;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (getOffset(new Date(middle), timeZone) === before) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Renders an ISO-8601 string that reflects the provided time zone instead of
 * defaulting to UTC.
 */
export function formatZonedIso(date: Date, timeZone: string): string {
  const parts = getTimeParts(date, timeZone);
  const { year, month, day, hour, minute, second } = parts;
  const offsetMinutes = offsetFromTimeParts(date, parts);
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffset / SECONDS_PER_MINUTE);
  const offsetRemainder = absoluteOffset % SECONDS_PER_MINUTE;
  // Civil Intl parts are whole seconds, but the accepted execution instant
  // may be fractional. Preserve it without changing whole-second output.
  const milliseconds = date.getUTCMilliseconds();
  const fraction = milliseconds ? `.${pad(milliseconds, 3)}` : "";
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(
    second
  )}${fraction}${offsetSign}${pad(offsetHours)}:${pad(offsetRemainder)}`;
}

/**
 * Builds a Date representing a local wall-clock time in the target time zone.
 */
export function makeZonedDate(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): Date | null {
  const initialUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  // Authored clocks and date boundaries own the first occurrence in a fold.
  // Seed from the preceding civil day without adding another offset lookup.
  const candidate = new Date(initialUtc - 86400000);
  const offset = getOffset(candidate, timeZone);
  candidate.setTime(initialUtc - offset * SECONDS_PER_MINUTE * 1000);
  let parts = getTimeParts(candidate, timeZone);
  const recalculatedOffset = offsetFromTimeParts(candidate, parts);
  if (recalculatedOffset !== offset) {
    candidate.setTime(initialUtc - recalculatedOffset * SECONDS_PER_MINUTE * 1000);
    parts = getTimeParts(candidate, timeZone);
  }
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

/** Calendar boundaries use the iCalendar DATE-TIME convention for a
 * nonexistent wall clock: apply the pre-gap offset and advance through the
 * gap. Do not use this for prescribed dose events; a missing explicit
 * timeOfDay still has no exact administration instant. */
export function calendarBoundaryDate(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): Date | null {
  const exact = makeZonedDate(timeZone, year, month, day, hour, minute, second);
  if (exact) return exact;
  const wallUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const wall = new Date(wallUtc);
  // Date.UTC normalizes invalid dates and clocks; only a real civil clock
  // can be missing because of an offset transition.
  if (wall.getUTCFullYear() !== year || wall.getUTCMonth() + 1 !== month ||
      wall.getUTCDate() !== day || wall.getUTCHours() !== hour ||
      wall.getUTCMinutes() !== minute || wall.getUTCSeconds() !== second) return null;
  const beforeOffset = getOffset(new Date(wallUtc - 86400000), timeZone);
  const shifted = new Date(wallUtc - beforeOffset * 60000);
  const afterOffset = getOffset(shifted, timeZone);
  // The pre-gap and post-gap interpretations must straddle a forward jump.
  // That jump may cross midnight; its civil date is not an invalid input.
  return afterOffset > beforeOffset &&
    getOffset(new Date(wallUtc - afterOffset * 60000), timeZone) === beforeOffset
    ? shifted : null;
}

export interface ClockParts {
  hour: number;
  minute: number;
  second: number;
  milliseconds: number;
}

/** Decode a clock once for reuse by the existing civil-date constructor. */
export function parseClockParts(clock: string): ClockParts {
  const parts = clock.split(":");
  const secondText = parts[2] ?? "0";
  const point = secondText.indexOf(".");
  // Read digits directly: floating subtraction can turn .123 into .122999.
  // Truncation keeps .9996 within its authored second and calendar date.
  return {
    hour: Number(parts[0] ?? 0),
    minute: Number(parts[1] ?? 0),
    second: Number(point < 0 ? secondText : secondText.slice(0, point)),
    milliseconds: point < 0 ? 0 : Number((secondText.slice(point + 1, point + 4) + "00").slice(0, 3)),
  };
}

/** Convenience wrapper around makeZonedDate for day-level math. */
export function makeZonedDateFromDay(base: Date, timeZone: string, clock: string | ClockParts): Date | null {
  const { year, month, day } = getTimeParts(base, timeZone);
  const { hour, minute, second, milliseconds } = typeof clock === "string" ? parseClockParts(clock) : clock;
  const exact = makeZonedDate(timeZone, year, month, day, hour, minute, second);
  if (exact && milliseconds) exact.setTime(exact.getTime() + milliseconds);
  return exact;
}

/** Returns a Date pinned to the start of the local day. */
export function startOfLocalDay(date: Date, timeZone: string): Date {
  const { year, month, day } = getTimeParts(date, timeZone);
  const zoned = calendarBoundaryDate(timeZone, year, month, day, 0, 0, 0);
  if (!zoned) throw new Error("Unable to resolve start of day for provided date");
  return zoned;
}

/** Adds a number of calendar days while remaining aligned to the time zone. */
export function addLocalDays(date: Date, days: number, timeZone: string): Date {
  const { year, month, day } = getTimeParts(date, timeZone);
  const rollover = new Date(Date.UTC(year, month - 1, day + days));
  const zoned = calendarBoundaryDate(
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

/** Advance a *calendar* dose cycle by local days while keeping its
 * prescribed wall clock. Unlike an elapsed q24h interval, a course cycle
 * cannot lose an hour at daylight-saving transitions. */
export function addCalendarDaysAtClock(
  instant: Date,
  days: number,
  timeZone: string,
  clock: Pick<TimeParts, "hour" | "minute" | "second">
): Date | null {
  const { year, month, day } = getTimeParts(instant, timeZone);
  const rollover = new Date(Date.UTC(year, month - 1, day + days));
  const target = [rollover.getUTCFullYear(), rollover.getUTCMonth() + 1, rollover.getUTCDate()] as const;
  const { hour, minute, second } = clock;
  const result = calendarBoundaryDate(timeZone, target[0], target[1], target[2], hour, minute, second);
  if (result) result.setUTCMilliseconds(instant.getUTCMilliseconds());
  return result;
}

/** A calendar cycle keeps its original wall clock even after one boundary
 * falls into a DST gap. The next boundary resumes the prescribed hour. */
export function calendarDayStepper(
  anchor: Date,
  days: number,
  timeZone: string,
  originalClock?: Pick<TimeParts, "hour" | "minute" | "second">
): (instant: Date) => Date | null {
  // A gap-shifted instant is NOT a new prescribed wall clock. Retain the
  // logical clock from the original calendar course whenever it exists.
  const clock = originalClock ?? getTimeParts(anchor, timeZone);
  return (instant) => addCalendarDaysAtClock(instant, days, timeZone, clock);
}

/** Computes the local weekday token (mon..sun). */
export function getLocalWeekday(date: Date, timeZone: string): string {
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

export function getLocalDayNumber(date: Date, timeZone: string): number {
  const { year, month, day } = getTimeParts(date, timeZone);
  return Math.floor(Date.UTC(year, month - 1, day) / (24 * 60 * 60 * 1000));
}

export function getLocalMonthIndex(date: Date, timeZone: string): number {
  const { year, month } = getTimeParts(date, timeZone);
  return year * 12 + (month - 1);
}

/** Parses arbitrary string/Date inputs into a valid Date instance. */
export function coerceDate(value: Date | string, label: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${label} supplied to nextDueDoses`);
  }
  return date;
}

/**
 * Adds calendar months while respecting varying month lengths and DST.
 *
 * @param date Starting instant.
 * @param months Number of calendar months to add.
 * @param timeZone IANA timezone used for wall-clock preservation.
 * @returns Shifted date preserving local clock and clamped day-of-month.
 */
export function addCalendarMonths(
  date: Date,
  months: number,
  timeZone: string,
  originalClock?: Pick<TimeParts, "hour" | "minute" | "second">
): Date {
  const { year, month, day, hour, minute, second } = getTimeParts(date, timeZone);
  const clock = originalClock ?? { hour, minute, second };
  const targetMonthIndex = month - 1 + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const maxDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const resolvedDay = Math.min(day, maxDay);
  const result = calendarBoundaryDate(
    timeZone,
    targetYear,
    targetMonth + 1,
    resolvedDay,
    clock.hour,
    clock.minute,
    clock.second
  );
  if (!result) throw new Error("Unable to resolve monthly advancement – invalid calendar date");
  result.setUTCMilliseconds(date.getUTCMilliseconds());
  return result;
}

/**
 * Formats a date into a local `HH:MM:SS` clock for the supplied timezone.
 *
 * @param date Source instant.
 * @param timeZone IANA timezone to interpret the instant.
 * @returns Local wall-clock time in `HH:MM:SS` format.
 */
export function toLocalClock(date: Date, timeZone: string): string {
  const parts = getTimeParts(date, timeZone);
  const twoDigits = (value: number): string => (value < 10 ? `0${value}` : `${value}`);
  const h = twoDigits(parts.hour);
  const m = twoDigits(parts.minute);
  const s = twoDigits(parts.second);
  return `${h}:${m}:${s}`;
}
