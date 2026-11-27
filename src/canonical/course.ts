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
import { convertQuantityValue } from "../utils/units";
import { AdviceArgumentRole, AdvicePolarity } from "../types";
import { buildAdditionalInstructionFramesFromCoding } from "../advice";
import type {
  CanonicalSigClause,
  CanonicalScheduleExpr,
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
/** An amount role needs clinical wording or coding; wire annotations alone
 * do not turn an ordinary scalar dose into a role-bearing amount. */
export function hasAmountRole(role: CanonicalConcept | undefined): boolean {
  if (!role) return false;
  if (role.text?.trim()) return true;
  if (role.coding) for (const coding of role.coding) if (coding.code || coding.display?.trim()) return true;
  return false;
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
  provenance?: import("../types").FhirR6DoseLimit | import("../types").FhirRatio;
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
  sharedCount?: CanonicalScheduleExpr["sharedCount"];
  frequency?: number;
  frequencyMax?: number;
  period?: number;
  periodMax?: number;
  periodUnit?: DurationUnit;
  occurrenceDuration?: number;
  occurrenceDurationMax?: number;
  occurrenceDurationUnit?: DurationUnit;
  occurrenceDurationComparator?: CanonicalMeasure["comparator"];
  /** Explicit endpoint quantities retain their independent units/qualifiers. */
  occurrenceDurationRange?: CanonicalRange;
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
  /** The previous-phase-next-day anchor denotes local midnight following
   * the predecessor's final occupied day, derived from its exclusive end.
   * treatment-day-start denotes midnight of the order's local calendar day,
   * before applying its day displacement. treatment-start retains the clock.
   * Other non-treatment anchors need an external resolver; never reinterpret
   * them as treatment-relative dates. */
  anchor: "treatment-start" | "treatment-day-start" | "previous-phase-next-day" | "coded-event" | "resource-reference" |
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
  /** Same-track phase dependencies by sourceMember identity. Presence marks
   * participating nodes; an empty list retains a referenced root identity. */
  phasePredecessors?: number[];
  onsetDays?: number;
  onsetReference?: "previous-phase-next-day" | "treatment-day-start";
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
  /** A member phase whose event origin is not a concrete treatment offset. */
  phaseStart?: CanonicalBoundary;
  /** Exclusive same-track transition, independent of this member's duration. */
  phaseEnd?: CanonicalBoundary;
  phaseOriginIssue?: boolean;
  delayMinutes?: number;
  anchoredLength?: { quantity?: CanonicalMeasure; range?: CanonicalRange };
  cycleDays?: CanonicalCycleDayConstraint;
  contextIssue?: "conflicting-course-phase" | "missing-course-context";
  syntax?: CanonicalSigClause;
  provenance?: { format: "r5" | "r6" | "syntax"; data: Record<string, unknown>;
    /** False when preserved wording has no agreement proof for current clinical facts. */
    sourceTextVerified?: boolean;
    /** This exact component text had established source agreement; current clinical replay is separate. */
    sourceTextAgreed?: boolean;
    /** Original primary schedule clock ownership; independent graph clocks remain source facts. */
    sourceHasStructuredClocks?: boolean;
    /** Original primary schedule anchor ownership; independent graph events remain source facts. */
    sourceHasStructuredEvents?: boolean;
    /** Original structured primary site ownership; graph-only sites remain independent facts. */
    sourceHasStructuredSite?: boolean;
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
  /** Authored stage repetition with a primitive companion but no known scalar. */
  countUnresolved?: true;
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
  /** An authored finite count has primitive metadata but no known scalar. */
  cycleCountUnresolved?: true;
  safety?: CanonicalSafety;
  contextIssue?: "conflicting-course-phase" | "missing-course-context";
  provenance?: { format: "r5" | "r6" | "syntax"; data: Record<string, unknown>;
    /** Source preservation is independent of authority to replay that wording. */
    sourceTextVerified?: boolean;
    /** The producer established coverage of this exact header, independently of clinical replay. */
    sourceTextAgreed?: boolean };
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
/** Absolute-event ownership stays nominal; both execution fences follow
 * the event's elapsed displacement. Relative recurrence keeps its own origin. */
export function absoluteEventCycleDisplacement(administration: CanonicalAdministration): number | undefined {
  return administration.schedule?.explicitEvents?.length
    ? (administration.delayMinutes ?? 0) * 60000 : undefined;
}

/** An unconditional dated phase owns its calendar opening. An explicit
 * clock refines a calendar bound or date list; event-relative timing and
 * conditions cannot prove an opening. */
export function administrationHasDatedStart(a: CanonicalAdministration): boolean {
  const repeat = a.schedule?.recurrence, dates = a.schedule?.explicitEvents;
  const dated = repeat?.calendarWindow?.start?.length === 10 ||
    repeat?.clocks?.length && dates?.length && dates.every(date => date.length === 10);
  return Boolean(dated &&
    (repeat.clocks?.length || !a.schedule?.explicitEvents?.length) &&
    !repeat.anchors?.length && !a.asNeeded && !a.predicate && !a.calendarPredicate &&
    !a.choice && !a.choiceIssue);
}

/** A clocked replacement defers its projected calendar cut to execution. */
export function administrationHasDatedClockStart(a: CanonicalAdministration): boolean {
  return Boolean(a.schedule?.recurrence?.clocks?.length && administrationHasDatedStart(a));
}

/** The earliest successor date owns any calendar-only cutoff. A clock on that
 * opening leaves its exact cut to execution; a later date-only member cannot
 * erase it. A date-only member on the same day opens first, at midnight. */
export function earliestCalendarOpening(administrations: readonly CanonicalAdministration[]):
  { start: string; clocked: boolean } | undefined {
  let opening: { start: string; clocked: boolean } | undefined;
  for (const administration of administrations) {
    const timing = administration.schedule;
    let start = timing?.recurrence?.calendarWindow?.start;
    if (!start) for (const event of timing?.explicitEvents ?? []) {
      if (start === undefined || event < start) start = event;
    }
    if (!start) continue;
    const clocked = administrationHasDatedClockStart(administration);
    if (!opening || start < opening.start) opening = { start, clocked };
    else if (start === opening.start && !clocked) opening.clocked = false;
  }
  return opening;
}

/** Intersect usable scoped maxima in the administration's quantity unit.
 * Incomplete or incomparable retained constraints do not erase another
 * known maximum. `multiple` records constraints still requiring evaluation. */
export function numericAdministrationLimits(
  a: CanonicalAdministration,
  strength?: Parameters<typeof convertQuantityValue>[3]
): {
  administration?: CanonicalMeasure;
  lifetime?: CanonicalMeasure;
  multiple: boolean;
} {
  let administration: CanonicalMeasure | undefined;
  let lifetime: CanonicalMeasure | undefined;
  let administrationValue = Infinity, lifetimeValue = Infinity;
  let administrationUnit: CanonicalMeasure | undefined, lifetimeUnit: CanonicalMeasure | undefined;
  let multiple = false;
  let dose: CanonicalMeasure | undefined;
  let doseResolved = false;
  for (const limit of a.limits ?? []) {
    if (limit.scope !== "administration" && limit.scope !== "lifetime") continue;
    const bound = limit.amount;
    // An open ceiling can bound a range endpoint, but cannot replace a known scalar dose.
    const strictRangeMaximum = limit.scope === "administration" && bound?.comparator === "<" &&
      a.amounts?.length === 1 && Boolean(a.amounts[0].range);
    if (limit.period || limit.expression || bound?.value === undefined ||
        !Number.isFinite(bound.value) || bound.value < 0 ||
        (bound.comparator && bound.comparator !== "~" && bound.comparator !== "<=" && !strictRangeMaximum)) {
      multiple = true;
      continue;
    }
    if (!doseResolved) {
      const amount = a.amounts?.[0];
      const high = amount?.range?.high;
      // Metadata alone does not make the upper endpoint measurable. Match
      // supply's numeric endpoint while retaining both authored quantities.
      dose = amount?.quantity ??
        (high?.value !== undefined && Number.isFinite(high.value) && high.value > 0
          ? high : amount?.range?.low);
      doseResolved = true;
    }
    // A supplied dose, including a unitless count, owns the comparison basis.
    // Without a dose quantity, the first bound with a unit identity owns the
    // scope. Keep returning the original winning quantity and its metadata.
    const target = (dose?.value !== undefined || dose?.code || dose?.unit ? dose : undefined) ??
      (limit.scope === "administration" ? administrationUnit : lifetimeUnit) ??
      (bound.code || bound.unit ? bound : undefined);
    const value = target ? convertQuantityValue(bound.value, bound, target, strength) : null;
    if (value === null || !Number.isFinite(value)) {
      multiple = true;
      continue;
    }
    if (limit.scope === "administration") {
      administrationUnit ??= target;
      if (value < administrationValue || value === administrationValue && strictRangeMaximum && administration?.comparator !== "<") {
        administration = bound; administrationValue = value;
      }
    } else {
      lifetimeUnit ??= target;
      if (value < lifetimeValue) { lifetime = bound; lifetimeValue = value; }
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

/** Nonnegative treatment-relative positions keep calendar months distinct
 * from civil days. Cross-unit order is known only when conservative calendar
 * bounds do not overlap; these bounds never become an executable duration. */
export interface RegimenPosition { unit: 'd' | 'mo'; value: number }
export function compareRegimenPositions(
  left: RegimenPosition,
  right: RegimenPosition
): -1 | 0 | 1 | undefined {
  if (left.value === 0 && right.value === 0) return 0;
  if (left.value === 0) return -1;
  if (right.value === 0) return 1;
  if (left.unit === right.unit) {
    return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
  }
  const leftMin = left.unit === 'mo' ? left.value * 28 : left.value;
  const leftMax = left.unit === 'mo' ? left.value * 31 : left.value;
  const rightMin = right.unit === 'mo' ? right.value * 28 : right.value;
  const rightMax = right.unit === 'mo' ? right.value * 31 : right.value;
  return leftMax < rightMin ? -1 : rightMax < leftMin ? 1 : undefined;
}

function expressionHasContent(expression: CanonicalExpression | undefined): boolean {
  return Boolean(expression && (expression.expression || expression.reference ||
    expression.description || expression.name));
}

/** Text and foreign Element metadata alone do not establish clinical facts
 * that can replace an authored instruction with a generated preview. */
export function administrationHasAmountFacts(
  a: Pick<CanonicalAdministration, "amounts" | "additionalInstructions">,
  includeRates = true
): boolean {
  for (const amount of a.amounts ?? [])
    if (amount.quantity?.value !== undefined || amount.range?.low?.value !== undefined ||
        amount.range?.high?.value !== undefined || expressionHasContent(amount.expression) || includeRates && (
          amount.rate?.value !== undefined || amount.rateRange?.low?.value !== undefined ||
          amount.rateRange?.high?.value !== undefined || amount.rateRatio?.numerator?.value !== undefined ||
          expressionHasContent(amount.rateExpression))) return true;
  // Coded qualitative amounts use the same typed administration templates
  // as clause realization. Unrelated advice cannot replace source-only dose
  // wording, and opaque text never supplies an amount here.
  for (const instruction of a.additionalInstructions ?? []) for (const coding of instruction.coding ?? []) {
    if (!coding.code) continue;
    const frames = buildAdditionalInstructionFramesFromCoding(coding.system ?? "http://snomed.info/sct", coding.code);
    for (const frame of frames ?? []) {
      if (frame.predicate.semanticClass !== "administration" || frame.polarity === AdvicePolarity.Negate) continue;
      for (const argument of frame.args) if (argument.role === AdviceArgumentRole.Amount) return true;
    }
  }
  return false;
}
