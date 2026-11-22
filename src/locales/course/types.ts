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
  repeatCount(count: number): string;
  repeatCycle(interval: string, exact: boolean, count?: number): string;
}
