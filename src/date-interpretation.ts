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

export type MedicationDateRelation =
  | "event"
  | "start-inclusive"
  | "start-exclusive"
  | "end-inclusive"
  | "end-exclusive";

export interface MedicationDateListMatch {
  start: number;
  end: number;
  sourceText: string;
  relation: MedicationDateRelation;
  events: CanonicalCalendarEventExpr[];
  unresolved: boolean;
}

const DATE_RESOLVERS = new Map<string, MedicationDateResolver>();
const YEARFUL_SLASH_DATE_SOURCE = String.raw`\d{1,2}\/\d{1,2}\/\d{2,4}`;
const NUMERIC_DATE_SOURCE = String.raw`(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{1,2}-\d{1,2}(?:-\d{2,4})?)`;
const DATE_LIST_SEPARATOR_SOURCE = String.raw`\s*(?:,|และ|and)\s*`;
const DATE_LIST_PART_SOURCE = String.raw`(?:${NUMERIC_DATE_SOURCE}|\d{1,2})`;
const DATE_LIST_SOURCE = String.raw`${NUMERIC_DATE_SOURCE}(?:${DATE_LIST_SEPARATOR_SOURCE}${DATE_LIST_PART_SOURCE})*`;
const UNANCHORED_YEARFUL_DATE_LIST_SOURCE = String.raw`${YEARFUL_SLASH_DATE_SOURCE}(?:${DATE_LIST_SEPARATOR_SOURCE}${DATE_LIST_PART_SOURCE})*`;
const DATE_EVENT_LEAD_SOURCE = String.raw`(?:\bon\b\s+|วันที่\s*)`;
const DATE_START_INCLUSIVE_LEAD_SOURCE = String.raw`(?:\bfrom\b\s+|\bstarting(?:\s+(?:on|from))?\b\s+|ตั้งแต่(?:วันที่)?\s*)`;
const DATE_START_EXCLUSIVE_LEAD_SOURCE = String.raw`(?:\bafter\b\s+|หลัง(?:วันที่)?\s*)`;
const DATE_END_INCLUSIVE_LEAD_SOURCE = String.raw`(?:\buntil\b\s+|\bthrough\b\s+|\btill\b\s+|(?:จน)?ถึง(?:วันที่)?\s*)`;
const DATE_END_EXCLUSIVE_LEAD_SOURCE = String.raw`(?:\bbefore\b\s+|ก่อน(?:วันที่)?\s*)`;
const DATE_LEAD_REQUIRED_SOURCE = String.raw`(?:${DATE_START_INCLUSIVE_LEAD_SOURCE}|${DATE_START_EXCLUSIVE_LEAD_SOURCE}|${DATE_END_INCLUSIVE_LEAD_SOURCE}|${DATE_END_EXCLUSIVE_LEAD_SOURCE}|${DATE_EVENT_LEAD_SOURCE})`;
const NUMERIC_DATE_RE = /^(\d{1,2})([/-])(\d{1,2})(?:\2(\d{2,4}))?$/u;
const DATE_COMPONENT_RE = /\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{1,2}-\d{1,2}(?:-\d{2,4})?|\d{1,2}/gu;

function matchedDateRelationLead(
  text: string
): { length: number; relation: MedicationDateRelation } {
  const candidates: Array<{ pattern: RegExp; relation: MedicationDateRelation }> = [
    { pattern: new RegExp(`^${DATE_START_INCLUSIVE_LEAD_SOURCE}`, "iu"), relation: "start-inclusive" },
    { pattern: new RegExp(`^${DATE_START_EXCLUSIVE_LEAD_SOURCE}`, "iu"), relation: "start-exclusive" },
    { pattern: new RegExp(`^${DATE_END_INCLUSIVE_LEAD_SOURCE}`, "iu"), relation: "end-inclusive" },
    { pattern: new RegExp(`^${DATE_END_EXCLUSIVE_LEAD_SOURCE}`, "iu"), relation: "end-exclusive" },
    { pattern: new RegExp(`^${DATE_EVENT_LEAD_SOURCE}`, "iu"), relation: "event" }
  ];
  for (const candidate of candidates) {
    const match = text.match(candidate.pattern);
    if (match?.[0]) return { length: match[0].length, relation: candidate.relation };
  }
  return { length: 0, relation: "event" };
}

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
  calendarYearFromIsoYear(isoYearValue) {
    return isoYearValue;
  },
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
  calendarYearFromIsoYear(isoYearValue) {
    return isoYearValue + 543;
  },
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

function nearestReferenceIsoYear(month: number, day: number, referenceDate: string): number | undefined {
  const reference = new Date(`${referenceDate}T00:00:00Z`);
  if (Number.isNaN(reference.getTime())) return undefined;
  const referenceYearValue = reference.getUTCFullYear();
  let bestYear: number | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestFuture = false;
  for (const year of [referenceYearValue - 1, referenceYearValue, referenceYearValue + 1]) {
    if (!validGregorianDate(year, month, day)) continue;
    const candidate = new Date(Date.UTC(year, month - 1, day));
    const delta = candidate.getTime() - reference.getTime();
    const distance = Math.abs(delta);
    const future = delta >= 0;
    if (
      distance < bestDistance ||
      (distance === bestDistance && future && !bestFuture)
    ) {
      bestYear = year;
      bestDistance = distance;
      bestFuture = future;
    }
  }
  return bestYear;
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
  yearWasExplicit?: boolean;
}

function parseStructuralParts(listText: string): { parts: NumericDatePart[]; effectiveEnd: number } {
  const parts: NumericDatePart[] = [];
  DATE_COMPONENT_RE.lastIndex = 0;
  for (let match = DATE_COMPONENT_RE.exec(listText); match; match = DATE_COMPONENT_RE.exec(listText)) {
    const text = match[0];
    const full = text.match(NUMERIC_DATE_RE);
    parts.push({
      sourceText: text,
      start: match.index,
      end: match.index + text.length,
      ...(full
        ? {
            day: Number(full[1]),
            month: Number(full[3]),
            year: full[4] !== undefined ? Number(full[4]) : undefined,
            yearDigits: full[4]?.length,
            yearWasExplicit: full[4] !== undefined
          }
        : { day: Number(text), yearWasExplicit: false })
    });
  }
  if (!parts.length) return { parts, effectiveEnd: 0 };

  // A bare day is only compressed date syntax when a later date supplies
  // its month. This avoids stealing `, 1 tablet` as a date.
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index].month !== undefined) continue;
    let followingDate = false;
    for (let cursor = index + 1; cursor < parts.length; cursor += 1) {
      if (parts[cursor].month !== undefined) {
        followingDate = true;
        break;
      }
    }
    if (!followingDate) {
      const keep = parts.slice(0, index);
      return {
        parts: keep,
        effectiveEnd: keep.length ? keep[keep.length - 1].end : 0
      };
    }
  }

  // Explicit years within a date list are shared by yearless d/m members.
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index].year !== undefined) continue;
    let inheritedYear: NumericDatePart | undefined;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (parts[cursor].year !== undefined) {
        inheritedYear = parts[cursor];
        break;
      }
    }
    if (!inheritedYear) {
      for (let cursor = index + 1; cursor < parts.length; cursor += 1) {
        if (parts[cursor].year !== undefined) {
          inheritedYear = parts[cursor];
          break;
        }
      }
    }
    if (inheritedYear) {
      parts[index].year = inheritedYear.year;
      parts[index].yearDigits = inheritedYear.yearDigits;
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
  const source: NumericDatePart = {
    ...part,
    month: part.month ?? inherited?.month,
    year: part.year ?? inherited?.year,
    yearDigits: part.yearDigits ?? inherited?.yearDigits
  };
  if (source.day === undefined || source.month === undefined) return undefined;

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
  if (!enabled.length) return undefined;

  const candidates: CanonicalCalendarEventExpr[] = [];
  if (source.year === undefined || source.yearDigits === undefined) {
    const inferredIsoYear = nearestReferenceIsoYear(fields.month, fields.day, context.referenceDate);
    if (inferredIsoYear === undefined || !inferredYearPlausible(inferredIsoYear, context, options?.datePolicy)) {
      return undefined;
    }
    let preferredResolver: MedicationDateResolver | undefined;
    for (const id of enabled) {
      const resolver = DATE_RESOLVERS.get(id);
      if (resolver?.calendarYearFromIsoYear) {
        preferredResolver = resolver;
        break;
      }
    }
    const calendarYear = preferredResolver?.calendarYearFromIsoYear?.(inferredIsoYear);
    if (!preferredResolver || calendarYear === undefined) return undefined;
    candidates.push({
      isoDate: isoDate(inferredIsoYear, fields.month, fields.day),
      calendar: preferredResolver.id,
      calendarYear,
      month: fields.month,
      day: fields.day,
      sourceText: part.sourceText,
      inferredYear: true
    });
  } else {
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
        inferredYear: resolved.inferredYear || !part.yearWasExplicit || undefined
      });
    }
  }

  if (!candidates.length) return undefined;
  if (candidates.length === 1) return candidates[0];
  const ambiguity = options?.datePolicy?.ambiguity ?? "prefer-first";
  if (ambiguity === "reject") return undefined;
  return candidates[0];
}

function parseMatchedDateList(
  input: string,
  start: number,
  matchedText: string,
  options?: ParseOptions
): MedicationDateListMatch | undefined {
  const lead = matchedDateRelationLead(matchedText);
  const listText = matchedText.slice(lead.length);
  const structural = parseStructuralParts(listText);
  if (!structural.parts.length || structural.effectiveEnd <= 0) return undefined;

  const effectiveListText = listText.slice(0, structural.effectiveEnd);
  const locale = effectiveLocale(input, options);
  const events: CanonicalCalendarEventExpr[] = [];
  for (let index = 0; index < structural.parts.length; index += 1) {
    const part = structural.parts[index];
    let inherited: NumericDatePart | undefined;
    if (part.month === undefined) {
      for (let cursor = index + 1; cursor < structural.parts.length; cursor += 1) {
        if (structural.parts[cursor].month !== undefined) {
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
        relation: lead.relation,
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
    relation: lead.relation,
    events: lead.relation === "event" || events.length === 1 ? events : [],
    unresolved: lead.relation !== "event" && events.length !== 1
  };
}

/** Scan structurally date-shaped numeric date lists, whether resolved or ambiguous. */
export function findMedicationDateListSpans(
  input: string,
  options?: ParseOptions
): MedicationDateListMatch[] {
  if (input.indexOf("/") < 0 && input.indexOf("-") < 0) return [];
  const output: MedicationDateListMatch[] = [];
  const seen = new Set<string>();
  const patterns = [
    new RegExp(`${DATE_LEAD_REQUIRED_SOURCE}(${DATE_LIST_SOURCE})`, "giu"),
    new RegExp(`(${UNANCHORED_YEARFUL_DATE_LIST_SOURCE})`, "giu")
  ];
  for (const pattern of patterns) {
    for (let match = pattern.exec(input); match; match = pattern.exec(input)) {
      const parsed = parseMatchedDateList(input, match.index, match[0], options);
      if (parsed) {
        const key = `${parsed.start}:${parsed.end}`;
        if (!seen.has(key)) {
          seen.add(key);
          output.push(parsed);
        }
      }
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
  output.sort((left, right) => left.start - right.start || right.end - left.end);
  return output.filter((span, index) =>
    !output.some((other, otherIndex) =>
      otherIndex !== index &&
      other.start <= span.start &&
      other.end >= span.end &&
      (other.start < span.start || other.end > span.end)
    )
  );
}

/** Resolve a date list beginning exactly at the supplied source offset. */
export function parseMedicationDateListAt(
  input: string,
  start: number,
  options?: ParseOptions
): MedicationDateListMatch | undefined {
  if (start < 0 || start >= input.length || (input.indexOf("/", start) < 0 && input.indexOf("-", start) < 0)) return undefined;
  const source = input.slice(start);
  const hasExplicitLead = new RegExp(`^${DATE_LEAD_REQUIRED_SOURCE}`, "iu").test(source);
  const pattern = hasExplicitLead
    ? new RegExp(`^${DATE_LEAD_REQUIRED_SOURCE}(${DATE_LIST_SOURCE})`, "iu")
    : new RegExp(`^(${UNANCHORED_YEARFUL_DATE_LIST_SOURCE})`, "iu");
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
  if (input.indexOf("/") < 0 && input.indexOf("-") < 0) return false;
  return findMedicationDateListSpans(input, options).some((span) =>
    start < span.end && span.start < end
  );
}
