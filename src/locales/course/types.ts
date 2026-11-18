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
  readonly rateLabel: string;
  readonly rateRangeLabel: string;
  readonly unspecified: string;
  readonly treatmentStart: string;
  readonly incompleteInterpretation: string;
  readonly retainedStructure: string;
  readonly maxAdministrationLabel: string;
  readonly maxLifetimeLabel: string;
  readonly maxPeriodLabel: string;
  readonly maxDosageLabel: string;
  readonly courseLimitsLabel: string;
  readonly stageLimitsLabel: string;
  weekdayName(day: string): string;
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
  calendarWindow(start?: string, end?: string): string;
  calendarEvents(events: readonly string[]): string;
  reviewTiming(source?: string): string;
  dayRange(first: number, last: number): string;
  fromDay(first: number): string;
  throughDay(last: number): string;
  noDoseDays(first: number, last: number): string;
  repeatCount(count: number): string;
  repeatCycle(interval: string, exact: boolean, count?: number): string;
}
