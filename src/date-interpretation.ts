import { inferMedicationLocale } from "./locale-detection";
import {
  CanonicalCalendarEventExpr,
  MedicationDateOrder,
  MedicationDatePolicy,
  MedicationDateResolver,
  MedicationDateResolverContext,
  MedicationDateResolverResult,
  ParseOptions
} from "./types";

export interface MedicationDateListMatch {
  start: number;
  end: number;
  sourceText: string;
  events: CanonicalCalendarEventExpr[];
  unresolved: boolean;
}

const DATE_RESOLVERS = new Map<string, MedicationDateResolver>();
const FULL_NUMERIC_DATE_SOURCE = String.raw`\d{1,2}\/\d{1,2}\/\d{2,4}`;
const DATE_LIST_SEPARATOR_SOURCE = String.raw`\s*(?:,|และ|and)\s*`;
const DATE_LIST_PART_SOURCE = String.raw`(?:${FULL_NUMERIC_DATE_SOURCE}|\d{1,2})`;
const DATE_LIST_SOURCE = String.raw`${FULL_NUMERIC_DATE_SOURCE}(?:${DATE_LIST_SEPARATOR_SOURCE}${DATE_LIST_PART_SOURCE})*`;
const DATE_LEAD_SOURCE = String.raw`(?:\bon\b\s+|วันที่\s*)?`;
const FULL_NUMERIC_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/u;
const DATE_COMPONENT_RE = /\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}/gu;

/** Register or replace a calendar resolver used by medication date interpretation. */
export function registerMedicationDateResolver(resolver: MedicationDateResolver): void {
  const id = resolver.id.trim().toLowerCase();
  if (!id) return;
  DATE_RESOLVERS.set(id, { ...resolver, id });
}

/** Return the currently registered calendar resolver ids. */
export function listMedicationDateResolvers(): string[] {
  return [...DATE_RESOLVERS.keys()];
}

function referenceIsoDate(policy: MedicationDatePolicy | undefined): string {
  const value = policy?.referenceDate?.trim();
  if (value && /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value) {
      return value;
    }
  }
  return new Date().toISOString().slice(0, 10);
}

function referenceYear(context: MedicationDateResolverContext): number {
  return Number(context.referenceDate.slice(0, 4));
}

function nearestCenturyYear(twoDigitYear: number, reference: number): number {
  const century = Math.floor(reference / 100) * 100;
  const candidates = [
    century - 100 + twoDigitYear,
    century + twoDigitYear,
    century + 100 + twoDigitYear
  ];
  let best = candidates[0];
  let distance = Math.abs(best - reference);
  for (let index = 1; index < candidates.length; index += 1) {
    const candidateDistance = Math.abs(candidates[index] - reference);
    if (candidateDistance < distance) {
      best = candidates[index];
      distance = candidateDistance;
    }
  }
  return best;
}

registerMedicationDateResolver({
  id: "gregory",
  resolveYear(sourceYear, sourceYearDigits, context): MedicationDateResolverResult | undefined {
    if (sourceYearDigits <= 2) {
      const calendarYear = nearestCenturyYear(sourceYear, referenceYear(context));
      return { isoYear: calendarYear, calendarYear, inferredYear: true };
    }
    if (sourceYear < 1600 || sourceYear > 2399) return undefined;
    return { isoYear: sourceYear, calendarYear: sourceYear, inferredYear: false };
  }
});

registerMedicationDateResolver({
  id: "buddhist",
  resolveYear(sourceYear, sourceYearDigits, context): MedicationDateResolverResult | undefined {
    if (sourceYearDigits <= 2) {
      const referenceBuddhistYear = referenceYear(context) + 543;
      const calendarYear = nearestCenturyYear(sourceYear, referenceBuddhistYear);
      return { isoYear: calendarYear - 543, calendarYear, inferredYear: true };
    }
    if (sourceYear < 2400 || sourceYear > 2999) return undefined;
    return { isoYear: sourceYear - 543, calendarYear: sourceYear, inferredYear: false };
  }
});

function validGregorianDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function leftPad(value: number, width: number): string {
  let text = String(value);
  while (text.length < width) text = `0${text}`;
  return text;
}

function isoDate(year: number, month: number, day: number): string {
  return `${leftPad(year, 4)}-${leftPad(month, 2)}-${leftPad(day, 2)}`;
}

function effectiveLocale(input: string, options?: ParseOptions): string {
  return inferMedicationLocale(input, options?.locale ?? "en");
}

function defaultCalendars(locale: string): string[] {
  return locale.toLowerCase().startsWith("th")
    ? ["buddhist", "gregory"]
    : ["gregory"];
}

function defaultDateOrder(locale: string, options?: ParseOptions): MedicationDateOrder {
  if (options?.datePolicy?.dateOrder) return options.datePolicy.dateOrder;
  if (locale.toLowerCase().startsWith("th")) return "DMY";
  return options?.locale?.toLowerCase() === "en-us" ? "MDY" : "DMY";
}

function dateFields(
  first: number,
  second: number,
  order: MedicationDateOrder
): { day: number; month: number } | undefined {
  const day = order === "MDY" ? second : first;
  const month = order === "MDY" ? first : second;
  if (day < 1 || day > 31 || month < 1 || month > 12) return undefined;
  return { day, month };
}

function inferredYearPlausible(
  isoYear: number,
  context: MedicationDateResolverContext,
  policy: MedicationDatePolicy | undefined
): boolean {
  const year = referenceYear(context);
  const past = Math.max(0, policy?.plausibleWindow?.pastYears ?? 5);
  const future = Math.max(0, policy?.plausibleWindow?.futureYears ?? 10);
  return isoYear >= year - past && isoYear <= year + future;
}

interface NumericDatePart {
  sourceText: string;
  start: number;
  end: number;
  day?: number;
  month?: number;
  year?: number;
  yearDigits?: number;
}

function parseStructuralParts(listText: string): { parts: NumericDatePart[]; effectiveEnd: number } {
  const parts: NumericDatePart[] = [];
  DATE_COMPONENT_RE.lastIndex = 0;
  for (let match = DATE_COMPONENT_RE.exec(listText); match; match = DATE_COMPONENT_RE.exec(listText)) {
    const text = match[0];
    const full = text.match(FULL_NUMERIC_DATE_RE);
    parts.push({
      sourceText: text,
      start: match.index,
      end: match.index + text.length,
      ...(full
        ? {
            day: Number(full[1]),
            month: Number(full[2]),
            year: Number(full[3]),
            yearDigits: full[3].length
          }
        : { day: Number(text) })
    });
  }
  if (!parts.length) return { parts, effectiveEnd: 0 };

  // A bare day is only treated as compressed date syntax when a later full
  // date supplies its month/year. This avoids stealing `, 1 tablet` as a date.
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index].year !== undefined) continue;
    let followingFull = false;
    for (let cursor = index + 1; cursor < parts.length; cursor += 1) {
      if (parts[cursor].year !== undefined) {
        followingFull = true;
        break;
      }
    }
    if (!followingFull) {
      const keep = parts.slice(0, index);
      return {
        parts: keep,
        effectiveEnd: keep.length ? keep[keep.length - 1].end : 0
      };
    }
  }
  return { parts, effectiveEnd: parts[parts.length - 1].end };
}

function resolveDatePart(
  part: NumericDatePart,
  inherited: NumericDatePart | undefined,
  locale: string,
  options?: ParseOptions
): CanonicalCalendarEventExpr | undefined {
  const source = part.year !== undefined ? part : {
    ...part,
    month: inherited?.month,
    year: inherited?.year,
    yearDigits: inherited?.yearDigits
  };
  if (
    source.day === undefined || source.month === undefined ||
    source.year === undefined || source.yearDigits === undefined
  ) return undefined;

  const order = defaultDateOrder(locale, options);
  const fields = dateFields(source.day, source.month, order);
  if (!fields) return undefined;

  const context: MedicationDateResolverContext = {
    locale,
    referenceDate: referenceIsoDate(options?.datePolicy)
  };
  const configuredCalendars = options?.datePolicy?.calendars;
  const enabled = configuredCalendars !== undefined
    ? configuredCalendars.map((id) => id.toLowerCase())
    : defaultCalendars(locale);
  const candidates: CanonicalCalendarEventExpr[] = [];
  for (const id of enabled) {
    const resolver = DATE_RESOLVERS.get(id);
    if (!resolver) continue;
    const resolved = resolver.resolveYear(source.year, source.yearDigits, context);
    if (!resolved) continue;
    if (resolved.inferredYear && !inferredYearPlausible(resolved.isoYear, context, options?.datePolicy)) {
      continue;
    }
    if (!validGregorianDate(resolved.isoYear, fields.month, fields.day)) continue;
    candidates.push({
      isoDate: isoDate(resolved.isoYear, fields.month, fields.day),
      calendar: resolver.id,
      calendarYear: resolved.calendarYear,
      month: fields.month,
      day: fields.day,
      sourceText: part.sourceText,
      inferredYear: resolved.inferredYear || undefined
    });
  }

  if (!candidates.length) return undefined;
  if (candidates.length === 1) return candidates[0];
  const ambiguity = options?.datePolicy?.ambiguity ?? "prefer-first";
  if (ambiguity === "reject" || ambiguity === "preserve") return undefined;
  return candidates[0];
}

function parseMatchedDateList(
  input: string,
  start: number,
  matchedText: string,
  options?: ParseOptions
): MedicationDateListMatch | undefined {
  const lead = matchedText.match(/^(?:on\b\s+|วันที่\s*)/iu)?.[0] ?? "";
  const listText = matchedText.slice(lead.length);
  const structural = parseStructuralParts(listText);
  if (!structural.parts.length || structural.effectiveEnd <= 0) return undefined;

  const effectiveListText = listText.slice(0, structural.effectiveEnd);
  const locale = effectiveLocale(input, options);
  const events: CanonicalCalendarEventExpr[] = [];
  for (let index = 0; index < structural.parts.length; index += 1) {
    const part = structural.parts[index];
    let inherited: NumericDatePart | undefined;
    if (part.year === undefined) {
      for (let cursor = index + 1; cursor < structural.parts.length; cursor += 1) {
        if (structural.parts[cursor].year !== undefined) {
          inherited = structural.parts[cursor];
          break;
        }
      }
    }
    const event = resolveDatePart(part, inherited, locale, options);
    if (!event) {
      return {
        start,
        end: start + lead.length + structural.effectiveEnd,
        sourceText: input.slice(start, start + lead.length + structural.effectiveEnd),
        events: [],
        unresolved: true
      };
    }
    events.push(event);
  }

  return {
    start,
    end: start + lead.length + structural.effectiveEnd,
    sourceText: input.slice(start, start + lead.length + structural.effectiveEnd),
    events,
    unresolved: false
  };
}

/** Scan structurally date-shaped numeric date lists, whether resolved or ambiguous. */
export function findMedicationDateListSpans(
  input: string,
  options?: ParseOptions
): MedicationDateListMatch[] {
  if (input.indexOf("/") < 0) return [];
  const pattern = new RegExp(`${DATE_LEAD_SOURCE}(${DATE_LIST_SOURCE})`, "giu");
  const output: MedicationDateListMatch[] = [];
  for (let match = pattern.exec(input); match; match = pattern.exec(input)) {
    const parsed = parseMatchedDateList(input, match.index, match[0], options);
    if (parsed) output.push(parsed);
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return output;
}

/** Resolve a date list beginning exactly at the supplied source offset. */
export function parseMedicationDateListAt(
  input: string,
  start: number,
  options?: ParseOptions
): MedicationDateListMatch | undefined {
  if (start < 0 || start >= input.length || input.indexOf("/", start) < 0) return undefined;
  const source = input.slice(start);
  const pattern = new RegExp(`^${DATE_LEAD_SOURCE}(${DATE_LIST_SOURCE})`, "iu");
  const match = source.match(pattern);
  if (!match) return undefined;
  return parseMatchedDateList(input, start, match[0], options);
}

/** True when a source range overlaps a recognized date-shaped list span. */
export function sourceRangeOverlapsMedicationDate(
  input: string,
  start: number,
  end: number,
  options?: ParseOptions
): boolean {
  if (input.indexOf("/") < 0) return false;
  return findMedicationDateListSpans(input, options).some((span) =>
    start < span.end && span.start < end
  );
}

/** Cheap structural check used to stop date-like tokens becoming body sites. */
export function isMedicationDateSurface(value: string): boolean {
  return /\d{1,2}\/\d{1,2}\/\d{2,4}/u.test(value);
}
