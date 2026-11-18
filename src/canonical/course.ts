/**
 * EZMED's clinical course normal form.
 *
 * Grammar owns CanonicalSigClause and CanonicalParallelRegimen; this module
 * completes that canonical model with course-wide meaning used by execution
 * and by BOTH interchange adapters. It does not extend a FHIR datatype and
 * contains no extension URLs or version-specific sequence/retention markers.
 *
 * Unknown external fields stay in provenance and are never executed. The
 * syntax clauses are read-only evidence, not a second editable dosage truth.
 * A caller editing clinical fields creates the next authoritative course;
 * adapters serialize those fields and preserve unrelated source metadata.
 */
import type {
  CanonicalSigClause,
  CanonicalActivityTimingExpr,
  CanonicalCycleDayConstraint,
  CanonicalOccurrenceCapExpr,
  CanonicalEventWindowExpr,
  MedicationCondition,
  NextDueDoseOptions,
  TotalUnitsOptions,
} from "../types";
export { FhirPeriodUnit as DurationUnit, EventTiming as TimingEvent } from "../types";
import type {
  FhirPeriodUnit as DurationUnit,
  EventTiming as TimingEvent,
  FhirDayOfWeek as Weekday,
} from "../types";

/** Shared clinical measurements are not a wire-format Quantity. Additional
 * coding metadata is preserved for exact export, but execution uses only the
 * explicitly known numeric value, unit and operator. */
export interface CanonicalMeasure {
  value?: number;
  unit?: string;
  system?: string;
  code?: string;
  comparator?: "<" | "<=" | ">=" | ">" | "~" | "ad";
  id?: string;
}
export interface CanonicalRange {
  low?: CanonicalMeasure;
  high?: CanonicalMeasure;
}
export interface CanonicalRatio {
  numerator?: CanonicalMeasure;
  denominator?: CanonicalMeasure;
}
export interface CanonicalExpression {
  name?: string;
  expression?: string;
  language?: string;
  description?: string;
  reference?: string;
}
export interface CanonicalConcept {
  text?: string;
  coding?: Array<{ system?: string; code?: string; display?: string; version?: string }>;
}
/** One clinical quantity limit retains its scope, independent value choice,
 * period and source identity. Unlike R5's three maximum fields, this list can
 * represent several differently qualified or expression-based limits without
 * demoting the extras into an active compatibility extension. */
export interface CanonicalDoseLimit {
  scope: "dosage" | "period" | "administration" | "lifetime";
  amount?: CanonicalMeasure;
  count?: number;
  expression?: CanonicalExpression;
  period?: CanonicalMeasure;
  text?: string;
  /** Typed original wire limit; clinical execution uses the fields above. */
  provenance?: import("../types").FhirR6DoseLimit;
}
/** Understood clinical safety policy, not a bag of arbitrary restrictions.
 * Unrecognized FHIR annotations remain ONLY in external source provenance.
 * Dose limits at step/course scope reuse the same typed limit shape. */
export interface CanonicalSafety {
  ifExceeded?: string;
  limits?: CanonicalDoseLimit[];
  maximaDeclared?: boolean;
  requiresReview?: boolean;
}
export interface CanonicalAmount {
  quantity?: CanonicalMeasure;
  range?: CanonicalRange;
  expression?: CanonicalExpression;
  rate?: CanonicalMeasure;
  rateRange?: CanonicalRange;
  rateRatio?: CanonicalRatio;
  rateExpression?: CanonicalExpression;
  role?: CanonicalConcept;
  provenance?: Record<string, unknown>;
}

/** Recurrence and course length are separate meanings. Optional fields retain
 * partial structured input rather than guessing a missing rate or count. */
export interface CanonicalRecurrence {
  count?: number;
  countMax?: number;
  frequency?: number;
  frequencyMax?: number;
  period?: number;
  periodMax?: number;
  periodUnit?: DurationUnit;
  occurrenceDuration?: number;
  occurrenceDurationMax?: number;
  occurrenceDurationUnit?: DurationUnit;
  courseLength?: CanonicalMeasure;
  courseLengthRange?: CanonicalRange;
  calendarWindow?: { start?: string; end?: string };
  dayOfWeek?: Weekday[];
  clocks?: string[];
  anchors?: TimingEvent[];
  offset?: number;
  offsetMin?: number;
  offsetMax?: number;
  monthDays?: number[];
  weekdayOrdinal?: number;
  activityTiming?: CanonicalActivityTimingExpr[];
  occurrenceCap?: CanonicalOccurrenceCapExpr;
  clockWindow?: { start: string; end: string; endInclusive: boolean };
  eventWindow?: CanonicalEventWindowExpr;
  startOffset?: CanonicalMeasure;
  endOffset?: CanonicalMeasure;
  provenance?: Record<string, unknown>;
}
export interface CanonicalTiming {
  recurrence?: CanonicalRecurrence;
  explicitEvents?: string[];
  code?: CanonicalConcept;
  provenance?: Record<string, unknown>;
}

/** A boundary's anchor is interpreted once at import. A foreign/unknown event
 * remains available for editing, never guessed to be treatment start. */
export interface CanonicalBoundary {
  /** Non-treatment anchors are valid clinical references, but MUST NOT be
   * executed as treatment-relative dates without a supplied resolver. */
  anchor: "treatment-start" | "coded-event" | "resource-reference" |
    "definition" | "path" | "unresolved";
  contextCode?: CanonicalConcept;
  contextReference?: CanonicalReference;
  contextDefinition?: string;
  contextPath?: string;
  description?: string;
  displacement?: CanonicalMeasure;
  displacementRange?: CanonicalRange;
  /** Uninterpreted external metadata, not an executable anchor. */
  provenance?: Record<string, unknown>;
}
export interface CanonicalChoice {
  groupId: string;
  branchId: string;
}
/** Known external resource identity semantics. Extra foreign Reference
 * annotations are opaque source metadata, not additional clinical fields. */
export interface CanonicalReference {
  reference?: string;
  type?: string;
  identifier?: {
    system?: string;
    value?: string;
    use?: string;
    type?: CanonicalConcept;
    period?: { start?: string; end?: string };
  };
  display?: string;
  id?: string;
}
export interface CanonicalAdministration {
  kind: "administration";
  schedule?: CanonicalTiming;
  amounts?: CanonicalAmount[];
  stageOrdinal?: number;
  /** Typed parser member identity, independent of external dose sequence. */
  sourceMember?: number;
  onsetDays?: number;
  asNeeded?: boolean;
  targetCount?: number;
  target?: CanonicalConcept;
  siteReference?: CanonicalReference;
  route?: CanonicalConcept;
  method?: CanonicalConcept;
  text?: string;
  patientInstruction?: string;
  additionalInstructions?: CanonicalConcept[];
  predicate?: MedicationCondition;
  calendarPredicate?: MedicationCondition;
  excludedDates?: string[];
  excludedWeekdays?: Weekday[];
  limits?: CanonicalDoseLimit[];
  /** Understood safety policy; opaque source metadata lives in provenance. */
  safety?: CanonicalSafety;
  choice?: CanonicalChoice;
  choiceIssue?: boolean;
  phaseOrigin?: CanonicalMeasure;
  phaseOriginIssue?: boolean;
  delayMinutes?: number;
  anchoredLength?: { quantity?: CanonicalMeasure; range?: CanonicalRange };
  cycleDays?: CanonicalCycleDayConstraint;
  contextIssue?: "conflicting-course-phase" | "missing-course-context";
  syntax?: CanonicalSigClause;
  provenance?: { format: "r5" | "r6" | "syntax"; data: Record<string, unknown>;
    /** Original foreign fields retained inside an imported R5 row. Only
     * adapters inspect this source; execution reads the typed fields above. */
    retained?: Partial<import("../types").FhirR6Dosage> };
  missingContexts?: string[];
}
export interface CanonicalStage {
  administrations: CanonicalAdministration[];
  start?: CanonicalBoundary;
  end?: CanonicalBoundary;
  count?: number;
  safety?: CanonicalSafety;
  provenance?: Record<string, unknown>;
}
export interface CanonicalCourse {
  kind: "course";
  stages: CanonicalStage[];
  instruction?: string;
  cycleInterval?: CanonicalMeasure;
  /** Total complete-course cycles, including the first; independent of each stage's local count. */
  cycleCount?: number;
  safety?: CanonicalSafety;
  contextIssue?: "conflicting-course-phase" | "missing-course-context";
  provenance?: { format: "r5" | "r6" | "syntax"; data: Record<string, unknown> };
}
export type CanonicalScheduleInput =
  | CanonicalCourse
  | CanonicalAdministration
  | readonly CanonicalAdministration[];
export type CanonicalSupplyOptions = Omit<TotalUnitsOptions, "dosage"> & { dosage: CanonicalScheduleInput };
export type CanonicalExecutionOptions = NextDueDoseOptions;
export interface CanonicalRegimenDueTimes {
  dosageIndex: number;
  stageOrdinal: number;
  phaseStart: string;
  timestamps: string[];
}

/** These direct semantic accessors intentionally know nothing about FHIR
 * extensions. Wire readers normalize at the boundary, once per input. */
export const measureOperator = (q: CanonicalMeasure | undefined) => q?.comparator;
export const administrationCondition = (a: CanonicalAdministration) => a.predicate;
export const administrationCalendarCondition = (a: CanonicalAdministration) => a.calendarPredicate;
export const administrationExcludedDates = (a: CanonicalAdministration) => a.excludedDates ?? [];
export const administrationExcludedWeekdays = (a: CanonicalAdministration) => a.excludedWeekdays ?? [];
export const administrationChoice = (a: CanonicalAdministration) => a.choice;
export const courseContextIssue = (c: CanonicalCourse) => c.contextIssue;
export const recurrenceOffset = (r: CanonicalRecurrence | undefined) => r?.offset;
export const recurrenceActivities = (r: CanonicalRecurrence | undefined) => r?.activityTiming;
export const administrationDelay = (a: CanonicalAdministration) => a.delayMinutes;
export const anchoredDuration = (a: Pick<CanonicalAdministration, "anchoredLength">) => a.anchoredLength;
export const recurrenceMonthDays = (r: CanonicalRecurrence | undefined) => r?.monthDays;
export const recurrenceCap = (r: CanonicalRecurrence | undefined) => r?.occurrenceCap;
export const administrationCycleDays = (a: CanonicalAdministration) => a.cycleDays;
export const recurrenceClockWindow = (r: CanonicalRecurrence | undefined) => r?.clockWindow;
export const recurrenceEventWindow = (r: CanonicalRecurrence | undefined) => r?.eventWindow;

/** Scan the native scoped bounds ONCE. This summary is consumed by
 * quantity calculation; the single-limit debug accessor below remains a
 * lightweight convenience, not a safety or validation API. */
export function numericAdministrationLimits(a: CanonicalAdministration): {
  administration?: CanonicalMeasure;
  lifetime?: CanonicalMeasure;
  multiple: boolean;
} {
  let administration: CanonicalMeasure | undefined;
  let lifetime: CanonicalMeasure | undefined;
  let multiple = false, seenAdministration = false, seenLifetime = false;
  for (const limit of a.limits ?? []) {
    if (!limit.amount || limit.period || limit.expression) continue;
    if (limit.scope === "administration") {
      if (seenAdministration) {
        multiple = true;
        administration = undefined;
      } else administration = limit.amount;
      seenAdministration = true;
    } else if (limit.scope === "lifetime") {
      if (seenLifetime) {
        multiple = true;
        lifetime = undefined;
      } else lifetime = limit.amount;
      seenLifetime = true;
    }
  }
  return { administration, lifetime, multiple };
}

/** Choose the last fully numeric source constraint where the clinical API
 * expects a single bound; other choices remain retained and explicitly
 * unevaluated. Period constraints are consumed independently by the engine. */
export function singleNumericLimit(
  a: CanonicalAdministration,
  scope: "administration" | "lifetime"
): CanonicalMeasure | undefined {
  let value: CanonicalMeasure | undefined;
  for (const limit of a.limits ?? []) {
    if (limit.scope === scope && limit.amount && !limit.period && !limit.expression) value = limit.amount;
  }
  return value;
}
export function hasPeriodLimits(a: CanonicalAdministration): boolean {
  return a.limits?.some((limit) => limit.scope === "period") ?? false;
}
