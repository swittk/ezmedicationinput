import type { FhirR6Quantity } from "./types";
import lexicalVocabulary from "./hpsg/lexical-classes.json";

export type I18nRecord = Record<string, string>;

export function cloneLocaleAliases(
  aliases: Record<string, string[]> | undefined
): Record<string, string[]> | undefined {
  if (!aliases) return undefined;
  const cloned: Record<string, string[]> = {};
  for (const locale of Object.keys(aliases)) {
    const values = aliases[locale];
    if (values?.length) cloned[locale] = [...values];
  }
  return Object.keys(cloned).length ? cloned : undefined;
}

export function flattenLocaleAliases(aliases: Record<string, string[]> | undefined): string[] {
  const values: string[] = [];
  for (const locale of Object.keys(aliases ?? {})) values.push(...(aliases?.[locale] ?? []));
  return values;
}

export function normalizeLocaleTag(locale: string | undefined): string | undefined {
  const normalized = locale?.trim().toLowerCase().replace(/_/gu, "-");
  return normalized || undefined;
}

export function baseLanguageTag(locale: string | undefined): string | undefined {
  const normalized = normalizeLocaleTag(locale);
  if (normalized === undefined) return undefined;
  const separator = normalized.indexOf("-");
  return separator < 0 ? normalized : normalized.slice(0, separator);
}

export function localeFallbackChain(locale: string | undefined): string[] {
  const exact = normalizeLocaleTag(locale);
  if (!exact) return [];
  const base = baseLanguageTag(exact);
  return base && base !== exact ? [exact, base] : [exact];
}

function normalizedRecordExact<T>(
  record: Record<string, T> | undefined,
  locale: string
): T | undefined {
  if (!record) return undefined;
  for (const key of Object.keys(record)) {
    if (normalizeLocaleTag(key) === locale) return record[key];
  }
  return undefined;
}

function normalizedRecordCompatible<T>(
  record: Record<string, T> | undefined,
  locale: string
): T | undefined {
  if (!record) return undefined;
  for (const key of Object.keys(record)) {
    const normalizedKey = normalizeLocaleTag(key);
    if (!normalizedKey || normalizedKey === locale) continue;
    if (locale.startsWith(`${normalizedKey}-`) || normalizedKey.startsWith(`${locale}-`)) {
      return record[key];
    }
  }
  return undefined;
}

function localizedRecordEntry<T>(
  record: Record<string, T> | undefined,
  locale: string | undefined
): T | undefined {
  const chain = localeFallbackChain(locale);
  for (const candidate of chain) {
    const exact = normalizedRecordExact(record, candidate);
    if (exact !== undefined) return exact;
  }
  const target = normalizeLocaleTag(locale);
  return target ? normalizedRecordCompatible(record, target) : undefined;
}

export function localizedValue(
  i18n: Record<string, string | undefined> | undefined,
  locale: string | undefined
): string | undefined {
  if (!i18n) return undefined;
  for (const candidate of localeFallbackChain(locale)) {
    for (const key of Object.keys(i18n)) {
      if (normalizeLocaleTag(key) !== candidate) continue;
      const value = i18n[key]?.trim();
      if (value) return value;
    }
  }
  const target = normalizeLocaleTag(locale);
  if (!target) return undefined;
  for (const key of Object.keys(i18n)) {
    const normalizedKey = normalizeLocaleTag(key);
    if (!normalizedKey || normalizedKey === target) continue;
    if (target.startsWith(`${normalizedKey}-`) || normalizedKey.startsWith(`${target}-`)) {
      const value = i18n[key]?.trim();
      if (value) return value;
    }
  }
  return undefined;
}

export function localizedConfig<T>(
  configs: Record<string, T> | undefined,
  locale: string | undefined,
  fallbackLocale?: string
): T | undefined {
  if (!configs) return undefined;
  const primary = localizedRecordEntry(configs, locale);
  if (primary !== undefined) return primary;
  return localizedRecordEntry(configs, fallbackLocale);
}

export function localeKeys(
  ...records: Array<Record<string, unknown> | undefined>
): string[] {
  const keys = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record ?? {})) {
      const normalized = normalizeLocaleTag(key);
      if (normalized) keys.add(normalized);
    }
  }
  return Array.from(keys).sort();
}

export function composeLocalizedRecords(
  records: Array<I18nRecord | undefined>,
  compose: (values: string[], locale: string) => string | undefined
): I18nRecord | undefined {
  const output: I18nRecord = {};
  for (const locale of localeKeys(...records)) {
    const values = records.map((record) => localizedValue(record, locale));
    if (values.some((value) => value === undefined)) continue;
    const composed = compose(values as string[], locale)?.trim();
    if (composed) output[locale] = composed;
  }
  return Object.keys(output).length ? output : undefined;
}

/** Spoken quantity operator shared by medication and action-graph renderers.
 * No qualifier means no prefix; amounts must not become exact when the
 * instruction graph supplies a richer sentence than the ordinary dose body. */
export function quantityComparatorText(
  comparator: FhirR6Quantity["comparator"], locale: string
): string {
  if (!comparator) return "";
  const prefixes: Readonly<Record<string, Readonly<Record<NonNullable<FhirR6Quantity["comparator"]>, string>>>> =
    lexicalVocabulary.quantityComparatorPrefixes;
  return (prefixes[baseLanguageTag(locale) ?? "en"] ?? prefixes.en)[comparator];
}

/** Locale-owned realization of already-resolved course semantics.
 * The canonical formatter chooses clinical facts and scope; this contract
 * supplies wording only. A language pack can provide it through the existing
 * SigLocalization registry alongside its clause grammar. No second parser,
 * external serialization, or locale checks belong in the canonical course.
 */
export interface CourseLanguage {
  readonly notPrefix: string;
  readonly allSeparator: string;
  readonly anySeparator: string;
  readonly onlyIf: string;
  readonly unless: string;
  readonly exceptDates: string;
  readonly exceptWeekdays: string;
  readonly choicePrefix: string;
  readonly stageSeparator: string;
  readonly doseLabel: string;
  amountRoleLabel(kind: "dose" | "rate" | "rateRange", role: "ordered" | "calculated" | undefined, sourceRole: string): string;
  applicationSites(count: number): string;
  readonly rateLabel: string;
  readonly rateRangeLabel: string;
  readonly unspecified: string;
  withAuthoredDirections(current: string, source: string): string;
  readonly treatmentStart: string;
  readonly cycleStart: string;
  readonly treatmentDayStart: string;
  readonly afterPreviousPhase: string;
  readonly nextDayAfterPreviousPhase: string;
  readonly incompleteInterpretation: string;
  readonly retainedStructure: string;
  readonly maxAdministrationLabel: string;
  readonly maxLifetimeLabel: string;
  readonly maxPeriodLabel: string;
  readonly maxDosageLabel: string;
  readonly courseLimitsLabel: string;
  readonly stageLimitsLabel: string;
  ifLimitExceeded(action: string): string;
  eventWindow(start: string, end: string): string;
  unresolvedCycleTiming(days: string, periodDays?: number, cycles?: number, anchor?: string): string;
  weekdayName(day: string): string;
  measurementName(name: string): string;
  joinList(items: readonly string[]): string;
  timeUnit(unit: string, value: number | undefined): string | undefined;
  expression(kind: "dose" | "rate", detail: string | undefined): string;
  upTo(value: string): string;
  administrations(frequency: string, period?: string): string;
  dosingPeriod(period: string): string;
  periodContext(period: string): string;
  startsWithinPeriod(offset: string, context: string): string;
  endsWithinPeriod(offset: string, context: string): string;
  afterTreatmentStart(offset: string): string;
  relativeEvent(offset: string, event: string | undefined, before: boolean): string;
  calendarWindow(start?: string, end?: string): string;
  calendarEvents(events: readonly string[]): string;
  reviewTiming(source?: string, boundary?: "end"): string;
  dayRange(first: number, last: number): string;
  fromDay(first: number): string;
  throughDay(last: number): string;
  noDoseDays(first: number, last: number): string;
  noDoseWindow(start: string, end: string): string;
  phaseCount(count: number): string;
  unresolvedPhaseCount: string;
  repeatCount(count: number): string;
  repeatCycle(interval: string, exact: boolean, count?: number): string;
}
