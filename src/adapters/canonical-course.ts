import { courseFromR5 } from "./r5-import";
import { projectNativeR5Course } from "./r5-course";
/**
 * Interchange boundary for EZMED's canonical course.
 *
 * R6 input is read directly: never flatten to R5, attach persistence markers,
 * decode those markers, and reconstruct clinical meaning merely to execute.
 * R5 edit reconciliation remains the R5 adapter's responsibility. Both output
 * versions are projections of the same canonical clinical course. Unknown
 * source metadata is retained separately and never consulted by execution.
 */
import type {
  FhirDosage,
  EzDosage,
  FhirR6Dosage,
  FhirR6DosageInstruction,
  FhirR6DoseLimit,
  FhirR6DosageSafety,
  FhirR6DosageStep,
  CanonicalSigClause,
  FhirR6RelativeTime,
  FhirTiming,
  FhirR6Timing,
  FhirQuantity,
  FhirR6Quantity,
  FhirRange,
  ParseBatchResult,
  FhirCodeableConcept,
  FhirExtension,
  FormatOptions,
} from "../types";
import type {
  CanonicalMeasure,
  CanonicalAmount,
  CanonicalRange,
  CanonicalRatio,
  CanonicalAdministration,
  CanonicalSafety,
  CanonicalDoseLimit,
  CanonicalCourse,
  CanonicalStage,
  CanonicalTiming,
  CanonicalBoundary,
  CanonicalScheduleInput,
} from "../canonical/course";
import {
  DOSAGE_DETAILS_R5_URL,
  R5_RATE_MODIFIERS_R6_URL,
  DOSAGE_CONDITION_R5_URL,
  isExactConditionBridge,
  isRenderedInstructionMarker,
  getDosageCondition,
  getDosageCalendarDayCondition,
  getDosageExcludedDates,
  getDosageExcludedWeekdays,
  getDosageAlternativeChoice,
  DOSAGE_ALTERNATIVE_CHOICE_URL,
  DOSAGE_EXCLUDED_DATES_R5_URL,
  DOSAGE_EXCLUDED_WEEKDAYS_R5_URL,
  getCourseContextIssue,
  PARALLEL_COMPONENT_PHASE_ORIGIN_URL,
  conditionToR6,
  setDosageExcludedDates,
  setDosageExcludedWeekdays,
  setDosageCondition,
  setDosageAlternativeChoice,
} from "../dosage-course";
import {
  serializeCanonicalContext,
  serializeCanonicalSchedule,
  deserializeCanonicalContext,
  cycleDayConstraintExtension,
  infusionCarrierMaterialExtension,
  getAdministrationOffsetMinutes,
  getAnchoredCourseDuration,
  getTimingClockWindow,
  getTimingMonthDays,
  getTimingWeekdayOrdinal,
  getTimingEventWindow,
  getTimingOccurrenceCap,
  getCycleDayConstraint,
  getExactTimingOffsetMinutes,
  parseActivityTimingExtensions,
  TIMING_FREQUENCY_MIN_EXTENSION_URL,
  TIMING_OFFSET_EXACT_EXTENSION_URL,
  TIMING_OFFSET_MIN_EXTENSION_URL,
  TIMING_OFFSET_MAX_EXTENSION_URL,
  TIMING_DAY_OF_MONTH_EXTENSION_URL,
  TIMING_WEEKDAY_ORDINAL_EXTENSION_URL,
  TIMING_ACTIVITY_WINDOW_EXTENSION_URL,
  TIMING_CLOCK_WINDOW_EXTENSION_URL,
  TIMING_EVENT_WINDOW_EXTENSION_URL,
  TIMING_OCCURRENCE_CAP_EXTENSION_URL,
  ADMINISTRATION_OFFSET_EXTENSION_URL,
  ANCHORED_COURSE_DURATION_EXTENSION_URL,
  CYCLE_DAY_ELIGIBILITY_EXTENSION_URL,
} from "../fhir";
import {
  getQuantityComparator,
  simpleQuantityForR5,
  quantityForR5 as generalQuantityForR5,
  quantityFromR5,
} from "../fhir-quantity-operator";
import { equalStructuredValues } from "../stable-structure";
import { clauseForAdministration } from "../canonical/compile";
import { getStandardDoseUnitCoding } from "../maps";
import type { FhirProjectionOptions } from "../fhir";
import {
  getBodySiteAdministrationTargetCount,
  buildBodySiteAdministrationTargetCountExtension,
  BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL,
} from "../body-site-target";

const TREATMENT_START_SYSTEM = "http://hl7.org/fhir/evidence-variable-event";
const record = (value: object): Record<string, unknown> => value as Record<string, unknown>;

/** Ordinary numeric quantities are reused; only an EMA-qualified quantity
 * needs an execution copy with the decoded operator as a direct property. */
/** Decode a source R5 quantity into its clinical operator, removing only
 * the exact generated EMA carrier. Author-enriched/unknown extensions remain
 * source data. Do not keep two active encodings of the same qualifier. */
function measureFromR5(q: FhirQuantity | undefined): CanonicalMeasure | undefined {
  return quantityFromR5(q);
}
export function measureFromWire(q: FhirQuantity | FhirR6Quantity | undefined): CanonicalMeasure | undefined {
  if (!q) return undefined;
  const operator = getQuantityComparator(q);
  return operator && operator !== q.comparator ? { ...q, comparator: operator } : (q as CanonicalMeasure);
}
function rangeFromWire(r: FhirRange | undefined, r5 = false): CanonicalRange | undefined {
  if (!r) return undefined;
  const low = r5 ? measureFromR5(r.low) : measureFromWire(r.low);
  const high = r5 ? measureFromR5(r.high) : measureFromWire(r.high);
  return low === r.low && high === r.high
    ? r
    : { ...r, ...(r.low ? { low } : {}), ...(r.high ? { high } : {}) };
}
export function rangeFromFhir(r: FhirRange | undefined): CanonicalRange | undefined {
  return rangeFromWire(r);
}
function ratio(
  r: { numerator?: FhirQuantity | FhirR6Quantity; denominator?: FhirQuantity | FhirR6Quantity } | undefined,
  r5 = false
): CanonicalRatio | undefined {
  if (!r) return undefined;
  const numerator = r5 ? measureFromR5(r.numerator as FhirQuantity) : measureFromWire(r.numerator);
  const denominator = r5 ? measureFromR5(r.denominator as FhirQuantity) : measureFromWire(r.denominator);
  return numerator === r.numerator && denominator === r.denominator
    ? r
    : { ...r, ...(r.numerator ? { numerator } : {}), ...(r.denominator ? { denominator } : {}) };
}
function offsetValue(repeat: { extension?: FhirExtension[] } | undefined, url: string): number | undefined {
  const value = repeat?.extension?.find((e) => e.url === url);
  return value?.valueInteger ?? value?.valueDecimal;
}
/** Decode timing annotations in one classification walk. Each specialized
 * codec sees only its own marker(s), not the full extension list again. */
function timingAnnotations(
  r: { extension?: FhirExtension[]; offset?: number } | undefined
): Pick<
  NonNullable<CanonicalTiming["recurrence"]>,
  | "offset"
  | "offsetMin"
  | "offsetMax"
  | "monthDays"
  | "weekdayOrdinal"
  | "activityTiming"
  | "occurrenceCap"
  | "clockWindow"
  | "eventWindow"
  | "frequency"
> {
  const out: Pick<
    NonNullable<CanonicalTiming["recurrence"]>,
    | "offset"
    | "offsetMin"
    | "offsetMax"
    | "monthDays"
    | "weekdayOrdinal"
    | "activityTiming"
    | "occurrenceCap"
    | "clockWindow"
    | "eventWindow"
    | "frequency"
  > = { offset: r?.offset };
  let exact: FhirExtension | undefined,
    month: FhirExtension[] | undefined,
    activities: FhirExtension[] | undefined;
  let weekday: FhirExtension | undefined,
    cap: FhirExtension | undefined,
    clock: FhirExtension | undefined,
    event: FhirExtension | undefined;
  for (const e of r?.extension ?? [])
    switch (e.url) {
      case TIMING_FREQUENCY_MIN_EXTENSION_URL:
        if (out.frequency === undefined) out.frequency = e.valueInteger;
        break;
      case TIMING_OFFSET_EXACT_EXTENSION_URL:
        if (!exact) exact = e;
        break;
      case TIMING_OFFSET_MIN_EXTENSION_URL:
        if (out.offsetMin === undefined) out.offsetMin = e.valueInteger ?? e.valueDecimal;
        break;
      case TIMING_OFFSET_MAX_EXTENSION_URL:
        if (out.offsetMax === undefined) out.offsetMax = e.valueInteger ?? e.valueDecimal;
        break;
      case TIMING_DAY_OF_MONTH_EXTENSION_URL:
        (month ??= []).push(e);
        break;
      case TIMING_WEEKDAY_ORDINAL_EXTENSION_URL:
        if (!weekday) weekday = e;
        break;
      case TIMING_ACTIVITY_WINDOW_EXTENSION_URL:
        (activities ??= []).push(e);
        break;
      case TIMING_OCCURRENCE_CAP_EXTENSION_URL:
        if (!cap) cap = e;
        break;
      case TIMING_CLOCK_WINDOW_EXTENSION_URL:
        if (!clock) clock = e;
        break;
      case TIMING_EVENT_WINDOW_EXTENSION_URL:
        if (!event) event = e;
        break;
    }
  if (exact) out.offset = getExactTimingOffsetMinutes({ offset: r?.offset, extension: [exact] });
  if (month) out.monthDays = getTimingMonthDays({ extension: month });
  if (weekday) out.weekdayOrdinal = getTimingWeekdayOrdinal({ extension: [weekday] });
  if (activities) out.activityTiming = parseActivityTimingExtensions({ extension: activities });
  if (cap) out.occurrenceCap = getTimingOccurrenceCap({ extension: [cap] });
  if (clock) out.clockWindow = getTimingClockWindow({ extension: [clock] });
  if (event) out.eventWindow = getTimingEventWindow({ extension: [event] });
  return out;
}
function timing(t: FhirTiming | FhirR6Timing | undefined, r5 = false): CanonicalTiming | undefined {
  if (!t) return undefined;
  const out: CanonicalTiming = { code: t.code, explicitEvents: t.event, provenance: record(t) };
  const r = t.repeat;
  if (r) {
    const annotations = r.extension?.length ? timingAnnotations(r) : undefined;
    const native = r as NonNullable<FhirR6Timing["repeat"]>;
    out.recurrence = {
      count: r.count,
      countMax: r.countMax,
      frequency: annotations?.frequency ?? r.frequency,
      frequencyMax: r.frequencyMax,
      period: r.period,
      periodMax: r.periodMax,
      periodUnit: r.periodUnit,
      occurrenceDuration: r.duration,
      occurrenceDurationMax: r.durationMax,
      occurrenceDurationUnit: r.durationUnit,
      courseLength: r5 ? measureFromR5(r.boundsDuration as FhirQuantity) : measureFromWire(r.boundsDuration),
      courseLengthRange: rangeFromFhir(r.boundsRange),
      calendarWindow: r.boundsPeriod,
      clocks: r.timeOfDay,
      anchors: r.when,
      dayOfWeek: r.dayOfWeek,
      offset: annotations?.offset ?? r.offset,
      offsetMin: annotations?.offsetMin,
      offsetMax: annotations?.offsetMax,
      monthDays: annotations?.monthDays,
      weekdayOrdinal: annotations?.weekdayOrdinal,
      activityTiming: annotations?.activityTiming,
      occurrenceCap: annotations?.occurrenceCap,
      clockWindow: annotations?.clockWindow,
      eventWindow: annotations?.eventWindow,
      startOffset: measureFromWire(native.startOffset),
      endOffset: measureFromWire(native.endOffset),
      provenance: record(r),
    };
  }
  return out;
}
export function boundaryFromR6(b: FhirR6RelativeTime | undefined): CanonicalBoundary | undefined {
  if (!b) return undefined;
  const recognized =
    !b.contextReference &&
    !b.contextDefinition &&
    !b.contextPath &&
    b.contextCode?.coding?.some((c) => c.system === TREATMENT_START_SYSTEM && c.code === "treatment-start");
  const anchor = recognized
    ? "treatment-start"
    : b.contextReference
    ? "resource-reference"
    : b.contextDefinition
    ? "definition"
    : b.contextPath
    ? "path"
    : b.contextCode
    ? "coded-event"
    : "unresolved";
  return {
    anchor,
    ...(b.contextReference ? { contextReference: b.contextReference } : {}),
    ...(b.contextDefinition ? { contextDefinition: b.contextDefinition } : {}),
    ...(b.contextPath ? { contextPath: b.contextPath } : {}),
    ...(b.contextCode && !recognized ? { contextCode: b.contextCode } : {}),
    description: b.text,
    displacement: measureFromWire(b.offsetDuration),
    displacementRange: rangeFromFhir(b.offsetRange),
    provenance: record(b),
  };
}
/** Every understood safety rule is typed. Unknown element metadata stays
 * only on the retained external source object, never in an executable bag. */
export function safetyFromWire(
  safety: FhirR6DosageSafety | undefined,
  includeLimits = false
): CanonicalSafety | undefined {
  if (!safety) return undefined;
  return {
    ...(safety.ifExceeded !== undefined ? { ifExceeded: safety.ifExceeded } : {}),
    ...(includeLimits && safety.doseLimit
      ? {
          limits: safety.doseLimit.map((limit) => ({
            scope: limit.scope,
            amount: measureFromWire(limit.valueQuantity),
            count: limit.valueInteger,
            expression: limit.valueExpression,
            period: measureFromWire(limit.period),
            text: limit.text,
            provenance: limit,
          })),
        }
      : {}),
    ...(safety.ifExceeded ||
    safety.doseLimit?.some((limit) => limit.valueInteger !== undefined || limit.valueExpression !== undefined)
      ? { requiresReview: true }
      : {}),
  };
}

/** Wire safety output owns coding/retained external metadata; clinical facts
 * own the live ifExceeded and limits. No generic internal safety fields leak. */
export function safetyToWire(
  policy: CanonicalSafety | undefined,
  source: FhirR6DosageSafety | undefined,
  limits?: CanonicalDoseLimit[],
  inferCoding = false
): FhirR6DosageSafety | undefined {
  if (!policy && limits === undefined) return undefined;
  const output: FhirR6DosageSafety = { ...source };
  if (policy) {
    if (policy.ifExceeded === undefined) delete output.ifExceeded;
    else output.ifExceeded = policy.ifExceeded;
  }
  const known = limits ?? policy?.limits;
  if (known !== undefined) {
    output.doseLimit = known.map((limit) => {
      const saved = limit.provenance as FhirR6DoseLimit | undefined;
      // R6 value[x] is an exclusive choice: never resurrect a stale source
      // valueQuantity when an integer/expression was explicitly edited.
      const {
        valueQuantity: _oldQuantity,
        valueInteger: _oldCount,
        valueExpression: _oldExpression,
        ...metadata
      } = saved ?? {};
      const period =
        limit.period && inferCoding
          ? {
              ...limit.period,
              ...(!limit.period.system && !limit.period.code && isCalendarUnit(limit.period.unit)
                ? { system: "http://unitsofmeasure.org", code: limit.period.unit }
                : {}),
            }
          : limit.period;
      const common = {
        ...metadata,
        scope: limit.scope,
        ...(period ? { period } : {}),
        ...(limit.text !== undefined ? { text: limit.text } : {}),
      };
      const amount = limit.amount;
      if (amount)
        return {
          ...common,
          valueQuantity: {
            ...amount,
            ...(inferCoding ? getStandardDoseUnitCoding(amount.unit) : undefined),
            ...(amount.system ? { system: amount.system } : {}),
            ...(amount.code ? { code: amount.code } : {}),
          },
        } satisfies FhirR6DoseLimit;
      if (limit.count !== undefined)
        return { ...common, valueInteger: limit.count } satisfies FhirR6DoseLimit;
      if (limit.expression) return { ...common, valueExpression: limit.expression } satisfies FhirR6DoseLimit;
      throw new TypeError("An authored safety limit must contain a numeric, count, or expression value");
    });
  }
  return output;
}
export function amountFromWire(
  a: NonNullable<FhirR6Dosage["doseAndRate"]>[number],
  r5 = false
): CanonicalAmount {
  return {
    quantity: r5 ? measureFromR5(a.doseQuantity as FhirQuantity) : measureFromWire(a.doseQuantity),
    range: rangeFromWire(a.doseRange, r5),
    expression: a.doseExpression,
    rate: r5 ? measureFromR5(a.rateQuantity as FhirQuantity) : measureFromWire(a.rateQuantity),
    rateRange: rangeFromWire(a.rateRange, r5),
    rateRatio: ratio(a.rateRatio, r5),
    rateExpression: a.rateExpression,
    role: a.type,
    provenance: record(a),
  };
}
function baseAdministration(
  raw: FhirDosage | FhirR6Dosage | EzDosage,
  format: "r5" | "r6",
  sourceContext = false
): CanonicalAdministration {
  const input = raw as EzDosage;
  const target = format === "r6" ? (raw as FhirR6Dosage).site?.concept : input.site;
  let phaseOrigin: CanonicalMeasure | undefined,
    phaseOriginIssue = false,
    seenOrigin = false;
  let anchored: FhirExtension | undefined,
    choiceMarker: FhirExtension | undefined,
    predicateMarker: FhirExtension | undefined,
    datesMarker: FhirExtension | undefined,
    cycleMarker: FhirExtension | undefined,
    delayMarker: FhirExtension | undefined;
  // Classify modifiers once. Specialized codecs see only their own retained
  // field rather than repeatedly traversing the whole imported marker list.
  for (const e of raw.modifierExtension ?? [])
    switch (e.url) {
      case PARALLEL_COMPONENT_PHASE_ORIGIN_URL:
        if (seenOrigin || !e.valueQuantity) phaseOriginIssue = true;
        seenOrigin = true;
        phaseOrigin = measureFromWire(e.valueQuantity);
        break;
      case ANCHORED_COURSE_DURATION_EXTENSION_URL:
        if (!anchored) anchored = e;
        break;
      case DOSAGE_ALTERNATIVE_CHOICE_URL:
        if (!choiceMarker) choiceMarker = e;
        break;
      case DOSAGE_CONDITION_R5_URL:
        if (!predicateMarker) predicateMarker = e;
        break;
      case DOSAGE_EXCLUDED_DATES_R5_URL:
        if (!datesMarker) datesMarker = e;
        break;
      case CYCLE_DAY_ELIGIBILITY_EXTENSION_URL:
        if (!cycleMarker) cycleMarker = e;
        break;
      case ADMINISTRATION_OFFSET_EXTENSION_URL:
        if (!delayMarker) delayMarker = e;
        break;
    }
  const conditionInput = predicateMarker
    ? { modifierExtension: [predicateMarker], condition: input.condition }
    : input.condition?.length
    ? { condition: input.condition }
    : undefined;
  const choice = choiceMarker ? getDosageAlternativeChoice({ modifierExtension: [choiceMarker] }) : undefined;
  let weekdaysMarker: FhirExtension | undefined;
  for (const e of raw.extension ?? [])
    if (e.url === DOSAGE_EXCLUDED_WEEKDAYS_R5_URL) {
      weekdaysMarker = e;
      break;
    }
  const amounts: CanonicalAmount[] | undefined = raw.doseAndRate ? [] : undefined;
  for (const value of raw.doseAndRate ?? [])
    amounts!.push(amountFromWire(value as NonNullable<FhirR6Dosage["doseAndRate"]>[number], format === "r5"));
  const output: CanonicalAdministration = {
    kind: "administration",
    schedule: timing(raw.timing, format === "r5"),
    amounts,
    stageOrdinal: format === "r5" ? input.sequence : undefined,
    asNeeded: raw.asNeeded,
    target,
    targetCount: getBodySiteAdministrationTargetCount(target),
    siteReference: format === "r6" ? (raw as FhirR6Dosage).site?.reference : input.siteReference,
    route: raw.route,
    method: raw.method,
    text: raw.text,
    patientInstruction: raw.patientInstruction,
    additionalInstructions: raw.additionalInstruction,
    predicate: conditionInput ? getDosageCondition(conditionInput) : undefined,
    calendarPredicate: predicateMarker ? getDosageCalendarDayCondition(conditionInput!) : undefined,
    excludedDates:
      input.excludedDates ??
      (datesMarker ? getDosageExcludedDates({ modifierExtension: [datesMarker] }) : undefined),
    excludedWeekdays: weekdaysMarker ? getDosageExcludedWeekdays({ extension: [weekdaysMarker] }) : undefined,
    safety: safetyFromWire(input.safety),
    choice,
    choiceIssue: !choice && Boolean(choiceMarker),
    phaseOrigin,
    phaseOriginIssue,
    delayMinutes: delayMarker
      ? getAdministrationOffsetMinutes({ modifierExtension: [delayMarker] })
      : undefined,
    anchoredLength: anchored
      ? { quantity: measureFromWire(anchored.valueQuantity), range: rangeFromFhir(anchored.valueRange) }
      : undefined,
    cycleDays: cycleMarker ? getCycleDayConstraint({ modifierExtension: [cycleMarker] }) : undefined,
    provenance: { format, data: record(raw) },
  };
  if (format === "r5") {
    let limits: CanonicalDoseLimit[] | undefined;
    for (const maximum of input.maxDosePerPeriod ?? [])
      (limits ??= []).push({
        scope: "period",
        amount: measureFromR5(maximum.numerator),
        period: measureFromR5(maximum.denominator),
      });
    if (input.maxDosePerAdministration)
      (limits ??= []).push({
        scope: "administration",
        amount: measureFromR5(input.maxDosePerAdministration),
      });
    if (input.maxDosePerLifetime)
      (limits ??= []).push({ scope: "lifetime", amount: measureFromR5(input.maxDosePerLifetime) });
    if (limits) output.limits = limits;
  }
  if (sourceContext)
    output.syntax = deserializeCanonicalContext({
      text: raw.text,
      extension: raw.extension,
      route: raw.route,
      site: target,
      method: raw.method,
      asNeeded: raw.asNeeded,
      asNeededFor: raw.asNeededFor,
      additionalInstruction: raw.additionalInstruction,
      patientInstruction: raw.patientInstruction,
    });
  return output;
}

/** Import one native R6 administration WITHOUT any R5 projection. */
export function administrationFromR6(raw: FhirR6Dosage, sourceContext = false): CanonicalAdministration {
  const result = baseAdministration(raw, "r6", sourceContext);
  if (raw.safety) {
    result.safety = safetyFromWire(raw.safety);
    result.limits = raw.safety.doseLimit?.map((limit) => ({
      scope: limit.scope,
      amount: measureFromWire(limit.valueQuantity),
      count: limit.valueInteger,
      expression: limit.valueExpression,
      period: measureFromWire(limit.period),
      text: limit.text,
      provenance: limit,
    }));
  }
  return result;
}
export function administrationFromR5(
  raw: FhirDosage | EzDosage,
  sourceContext = false
): CanonicalAdministration {
  const result = baseAdministration(raw, "r5", sourceContext);
  // R5 slots are decoded in the initial amount/limit traversal. Never
  // build them with the R6 reader only to walk and replace every field again.
  const safety = (raw as EzDosage).safety;
  if (safety?.doseLimit)
    result.limits = safety.doseLimit.map((limit) => ({
      scope: limit.scope,
      amount: measureFromWire(limit.valueQuantity),
      count: limit.valueInteger,
      expression: limit.valueExpression,
      period: measureFromWire(limit.period),
      text: limit.text,
      provenance: limit,
    }));
  return result;
}
export function courseFromR6(raw: FhirR6DosageInstruction, sourceContext = false): CanonicalCourse {
  const stages: CanonicalStage[] = [];
  for (const step of raw.step) {
    const administrations: CanonicalAdministration[] = [];
    for (const component of step.component)
      administrations.push(administrationFromR6(component, sourceContext));
    stages.push({
      administrations,
      start: boundaryFromR6(step.start),
      end: boundaryFromR6(step.end),
      count: step.count,
      safety: safetyFromWire(step.safety, true),
      provenance: record(step),
    });
  }
  const course: CanonicalCourse = {
    kind: "course",
    stages,
    instruction: raw.renderedInstruction,
    cycleInterval: measureFromWire(raw.repeatCycle),
    safety: safetyFromWire(raw.safety, true),
    contextIssue: getCourseContextIssue(raw),
    provenance: { format: "r6", data: record(raw) },
  };
  // No defensive copy. Re-reading an externally changed FHIR input should
  // still observe its current fields, while ordinary callers leave it alone.
  return course;
}
/** Reconciliation is solely an R5 import concern, never part of native
 * course execution. A simple scalar needs no course reconstruction. */
export function inputToCanonical(
  input:
    | FhirDosage
    | readonly FhirDosage[]
    | FhirR6DosageInstruction
    | ParseBatchResult
    | CanonicalScheduleInput
): CanonicalScheduleInput {
  if (input && !Array.isArray(input)) {
    if ("kind" in input && (input.kind === "course" || input.kind === "administration"))
      return input as CanonicalCourse | CanonicalAdministration;
    if ("items" in input) return input.meta.canonical.course ?? courseFromR6(input.fhirNext);
    if ("step" in input) return courseFromR6(input as FhirR6DosageInstruction);
  }
  if (Array.isArray(input)) {
    if (input.length && "kind" in input[0]) return input as CanonicalAdministration[];
    const rows = input as readonly FhirDosage[];
    if (
      rows.some((row) =>
        row.modifierExtension?.some(
          (e) => e.url === DOSAGE_DETAILS_R5_URL || e.url === PARALLEL_COMPONENT_PHASE_ORIGIN_URL
        )
      )
    )
      return courseFromR5(rows);
    return rows.map((row) => {
      const a = administrationFromR5(row);
      // Whole-course accounting conservatively reports persisted dosage
      // maxima as constraints; a standalone scalar retains its historical
      // exact single-row accounting contract.
      if (!a.safety && a.limits?.length) a.safety = { maximaDeclared: true };
      return a;
    });
  }
  const raw = input as FhirDosage;
  if (raw.modifierExtension?.some((e) => e.url === DOSAGE_DETAILS_R5_URL)) return courseFromR5([raw]);
  return administrationFromR5(raw);
}

/** Projection helpers always overwrite modeled clinical fields, including
 * deliberate clearing, while preserving unrelated external source fields. */
function assign(target: Record<string, unknown>, name: string, value: unknown): void {
  if (value === undefined) delete target[name];
  else target[name] = value;
}
export function boundaryToWire(b: CanonicalBoundary | undefined): FhirR6RelativeTime | undefined {
  if (!b) return undefined;
  const output = { ...b.provenance };
  const original = b.provenance ? boundaryFromR6(b.provenance as FhirR6RelativeTime)?.anchor : undefined;
  if (b.anchor !== original) {
    delete output.contextReference;
    delete output.contextDefinition;
    delete output.contextPath;
    delete output.contextCode;
    if (b.anchor === "treatment-start")
      output.contextCode = {
        coding: [{ system: TREATMENT_START_SYSTEM, code: "treatment-start", display: "Start of Treatment" }],
      };
  }
  // Understood external anchor types stay typed, including in native edits.
  // These are preserved but not considered executable without an event/source resolver.
  if (b.anchor !== "treatment-start") {
    assign(output, "contextReference", b.anchor === "resource-reference" ? b.contextReference : undefined);
    assign(output, "contextDefinition", b.anchor === "definition" ? b.contextDefinition : undefined);
    assign(output, "contextPath", b.anchor === "path" ? b.contextPath : undefined);
    assign(output, "contextCode", b.anchor === "coded-event" ? b.contextCode : undefined);
  }
  assign(output, "text", b.description);
  assign(output, "offsetDuration", b.displacement);
  assign(output, "offsetRange", b.displacementRange);
  return output as FhirR6RelativeTime;
}
/** Reuse an unchanged Timing fragment by value/reference comparison on the
 * current input. This is not a persistent memo cache: a later edited input is
 * normalized again and any changed live clinical field gets a fresh fragment. */
function timingToWire(t: CanonicalTiming | undefined, target: "r5" | "r6"): FhirR6Timing | undefined {
  if (!t) return undefined;
  const original = t.provenance as FhirR6Timing | undefined;
  const r = t.recurrence,
    prior = original?.repeat;
  let repeat: FhirR6Timing["repeat"];
  if (r) {
    const duration = target === "r5" ? generalQuantityForR5(r.courseLength) : r.courseLength;
    const start = target === "r6" ? simpleQuantityForR5(r.startOffset) : undefined;
    const end = target === "r6" ? simpleQuantityForR5(r.endOffset) : undefined;
    if (
      prior &&
      prior.count === r.count &&
      prior.countMax === r.countMax &&
      prior.frequency === r.frequency &&
      prior.frequencyMax === r.frequencyMax &&
      prior.period === r.period &&
      prior.periodMax === r.periodMax &&
      prior.periodUnit === r.periodUnit &&
      prior.dayOfWeek === r.dayOfWeek &&
      prior.offset === r.offset &&
      prior.duration === r.occurrenceDuration &&
      prior.durationMax === r.occurrenceDurationMax &&
      prior.durationUnit === r.occurrenceDurationUnit &&
      prior.boundsDuration === duration &&
      prior.boundsRange === r.courseLengthRange &&
      prior.boundsPeriod === r.calendarWindow &&
      prior.when === r.anchors &&
      prior.timeOfDay === r.clocks &&
      prior.startOffset === start &&
      prior.endOffset === end
    )
      repeat = prior;
    else {
      const value: Record<string, unknown> = Object.assign({}, r.provenance);
      assign(value, "count", r.count);
      assign(value, "countMax", r.countMax);
      assign(value, "frequency", r.frequency);
      assign(value, "frequencyMax", r.frequencyMax);
      assign(value, "period", r.period);
      assign(value, "periodMax", r.periodMax);
      assign(value, "periodUnit", r.periodUnit);
      assign(value, "dayOfWeek", r.dayOfWeek);
      assign(value, "offset", r.offset);
      assign(value, "duration", r.occurrenceDuration);
      assign(value, "durationMax", r.occurrenceDurationMax);
      assign(value, "durationUnit", r.occurrenceDurationUnit);
      assign(value, "boundsDuration", duration);
      assign(value, "boundsRange", r.courseLengthRange);
      assign(value, "boundsPeriod", r.calendarWindow);
      assign(value, "when", r.anchors);
      assign(value, "timeOfDay", r.clocks);
      assign(value, "startOffset", start);
      assign(value, "endOffset", end);
      repeat = value;
    }
  }
  if (
    original &&
    original.event === t.explicitEvents &&
    original.code === t.code &&
    original.repeat === repeat
  )
    return original;
  const output: Record<string, unknown> = Object.assign({}, t.provenance);
  assign(output, "event", t.explicitEvents);
  assign(output, "code", t.code);
  assign(output, "repeat", repeat);
  return output;
}
/** Only changed known semantics replace their owned wire annotations.
 * Unknown siblings and unedited richer source markers are preserved exactly.
 * The execution core never sees these annotations. */
function replaceOwnedAnnotations(
  before: readonly FhirExtension[] | undefined,
  generated: readonly FhirExtension[] | undefined,
  changed: ReadonlySet<string>
): FhirExtension[] | undefined {
  if (!changed.size) return before as FhirExtension[] | undefined;
  const next: FhirExtension[] = [];
  for (const item of before ?? []) if (!changed.has(item.url)) next.push(item);
  for (const item of generated ?? []) if (changed.has(item.url)) next.push(item);
  return next.length ? next : undefined;
}
function updateNativeTimingAnnotations(
  a: CanonicalAdministration,
  output: Record<string, unknown>,
  target: FhirR6Timing | undefined
): FhirR6Timing | undefined {
  if (!a.provenance || a.provenance.format !== "r6") return target;
  const raw = a.provenance.data as FhirR6Dosage;
  const live = a.schedule?.recurrence;
  const original = raw.timing?.repeat;
  if (
    !original?.extension?.length &&
    !raw.modifierExtension?.length &&
    !live?.monthDays &&
    !live?.weekdayOrdinal &&
    !live?.activityTiming &&
    !live?.occurrenceCap &&
    !live?.clockWindow &&
    !live?.eventWindow &&
    live?.offset === original?.offset &&
    live?.offsetMin === undefined &&
    live?.offsetMax === undefined &&
    live?.frequency !== 0 &&
    a.delayMinutes === undefined &&
    !a.anchoredLength
  )
    return target;
  const oldMarkers = original ? { extension: original.extension, offset: original.offset } : undefined;
  const changes = new Set<string>();
  const changed = (url: string, before: unknown, after: unknown) => {
    if (!same(before, after)) changes.add(url);
  };
  changed(TIMING_DAY_OF_MONTH_EXTENSION_URL, getTimingMonthDays(oldMarkers), live?.monthDays);
  changed(TIMING_WEEKDAY_ORDINAL_EXTENSION_URL, getTimingWeekdayOrdinal(oldMarkers), live?.weekdayOrdinal);
  changed(TIMING_CLOCK_WINDOW_EXTENSION_URL, getTimingClockWindow(oldMarkers), live?.clockWindow);
  changed(TIMING_EVENT_WINDOW_EXTENSION_URL, getTimingEventWindow(oldMarkers), live?.eventWindow);
  changed(
    TIMING_ACTIVITY_WINDOW_EXTENSION_URL,
    parseActivityTimingExtensions(oldMarkers),
    live?.activityTiming
  );
  changed(TIMING_OCCURRENCE_CAP_EXTENSION_URL, getTimingOccurrenceCap(oldMarkers), live?.occurrenceCap);
  changed(TIMING_OFFSET_EXACT_EXTENSION_URL, getExactTimingOffsetMinutes(oldMarkers), live?.offset);
  changed(
    TIMING_OFFSET_MIN_EXTENSION_URL,
    offsetValue(oldMarkers, TIMING_OFFSET_MIN_EXTENSION_URL),
    live?.offsetMin
  );
  changed(
    TIMING_OFFSET_MAX_EXTENSION_URL,
    offsetValue(oldMarkers, TIMING_OFFSET_MAX_EXTENSION_URL),
    live?.offsetMax
  );
  changed(
    TIMING_FREQUENCY_MIN_EXTENSION_URL,
    oldMarkers?.extension?.find((e) => e.url === TIMING_FREQUENCY_MIN_EXTENSION_URL)?.valueInteger === 0,
    live?.frequency === 0
  );
  const administrationChanges = new Set<string>();
  if (!same(getAdministrationOffsetMinutes(raw as FhirDosage), a.delayMinutes))
    administrationChanges.add(ADMINISTRATION_OFFSET_EXTENSION_URL);
  const oldLength = getAnchoredCourseDuration(raw);
  if (
    !same(
      oldLength
        ? { quantity: measureFromWire(oldLength.valueQuantity), range: rangeFromFhir(oldLength.valueRange) }
        : undefined,
      a.anchoredLength
    )
  )
    administrationChanges.add(ANCHORED_COURSE_DURATION_EXTENSION_URL);
  if (!changes.size && !administrationChanges.size) return target;
  const generated = serializeCanonicalSchedule(clauseForAdministration(a).schedule);
  if (target?.repeat && changes.size) {
    target = Object.assign({}, target, { repeat: Object.assign({}, target.repeat) });
    const repeat = target.repeat!;
    assign(
      repeat as Record<string, unknown>,
      "extension",
      replaceOwnedAnnotations(original?.extension, generated.timing?.repeat?.extension, changes)
    );
    if (changes.has(TIMING_OFFSET_EXACT_EXTENSION_URL))
      assign(repeat as Record<string, unknown>, "offset", generated.timing?.repeat?.offset);
    if (changes.has(TIMING_FREQUENCY_MIN_EXTENSION_URL))
      assign(repeat as Record<string, unknown>, "frequency", generated.timing?.repeat?.frequency);
  }
  assign(
    output,
    "modifierExtension",
    replaceOwnedAnnotations(
      output.modifierExtension as FhirExtension[] | undefined,
      generated.modifierExtension,
      administrationChanges
    )
  );
  return target;
}
/** Emit native R6 directly from modeled clinical facts. Shared serializers
 * encode vocabulary and grammar-source annotations only, never an R5 course. */
/** Write the requested external shape directly from clinical facts. The
 * common vocabulary/source work is shared; no output version is the input to
 * another version's serializer. Target-specific choices are made as written. */
function administrationToWire(
  a: CanonicalAdministration,
  target: "r5" | "r6",
  options?: FhirProjectionOptions,
  currentSyntax?: CanonicalSigClause
): FhirDosage | FhirR6Dosage {
  // The fresh parser construction passes its current, already-scoped clause
  // explicitly for coding/source annotations. Edited/imported public courses
  // reconstruct that view from their authoritative native facts instead.
  // Numeric doses, recurrence and limits below ALWAYS use native fields.
  // A shared delay may have moved from this member to the owning stage.
  // The source annotation view is no longer current in that case: deriving
  // it from live native facts prevents applying the same delay twice.
  const currentView =
    currentSyntax?.schedule?.administrationOffsetMinutes === a.delayMinutes ? currentSyntax : undefined;
  const clause =
    currentView ??
    (a.syntax && (!a.provenance || a.provenance.format === "syntax")
      ? clauseForAdministration(a)
      : undefined);
  const context = clause ? serializeCanonicalContext(clause, options) : undefined;
  const scheduleMetadata = clause ? serializeCanonicalSchedule(clause.schedule, options) : undefined;
  const output: Record<string, unknown> = clause
    ? Object.assign({}, context)
    : Object.assign({}, a.provenance?.data, a.provenance?.retained);
  delete output.sequence;
  let wireTiming = timingToWire(a.schedule, target);
  if (clause && wireTiming) {
    const annotations = scheduleMetadata?.timing;
    const r = wireTiming.repeat;
    if (r) {
      const source = a.schedule?.recurrence;
      const annotationsRepeat = annotations?.repeat;
      wireTiming.repeat = {
        ...r,
        ...(annotationsRepeat?.extension ? { extension: annotationsRepeat.extension } : {}),
        ...(source?.courseLength
          ? {
              boundsDuration:
                target === "r5"
                  ? generalQuantityForR5(serializeDuration(source.courseLength))
                  : serializeDuration(source.courseLength),
            }
          : {}),
        ...(source?.courseLengthRange ? { boundsRange: serializeRange(source.courseLengthRange, true) } : {}),
      };
    }
    if (annotations?._event) wireTiming._event = annotations._event;
    if (annotations?.code) wireTiming.code = annotations.code;
    // Shared marker serialization includes explicit signed offsets and
    // absolute+duration constraints, never clinical interpretation.
    if (scheduleMetadata?.modifierExtension) output.modifierExtension = scheduleMetadata.modifierExtension;
  }
  if (clause && wireTiming?.repeat && scheduleMetadata?.timing?.repeat) {
    // Wire positive/unsigned integer slots do not express clinical zero or
    // signed fractional offsets; their common serializer owns those encodings.
    assign(
      wireTiming.repeat as Record<string, unknown>,
      "frequency",
      scheduleMetadata.timing.repeat.frequency
    );
    assign(wireTiming.repeat as Record<string, unknown>, "offset", scheduleMetadata.timing.repeat.offset);
  }
  wireTiming = updateNativeTimingAnnotations(a, output, wireTiming);
  assign(output, "timing", wireTiming);
  assign(output, "text", a.text);
  assign(output, "patientInstruction", a.patientInstruction);
  if (!clause) {
    assign(output, "route", a.route);
    assign(output, "method", a.method);
    assign(output, "additionalInstruction", a.additionalInstructions);
  }
  assign(output, "asNeeded", a.asNeeded);
  assign(
    output,
    "doseAndRate",
    a.amounts?.map((value) => {
      const original = value.provenance as NonNullable<FhirR6Dosage["doseAndRate"]>[number] | undefined;
      if (
        !clause &&
        original &&
        original.doseQuantity === value.quantity &&
        original.doseRange === value.range &&
        original.rateQuantity === value.rate &&
        original.rateRange === value.rateRange &&
        original.rateRatio === value.rateRatio &&
        original.type === value.role &&
        original.doseExpression === value.expression &&
        original.rateExpression === value.rateExpression &&
        (target === "r6"
          ? !Object.prototype.hasOwnProperty.call(original, "modifierExtension")
          : !value.expression &&
            !value.rateExpression &&
            !value.quantity?.comparator &&
            !value.rate?.comparator &&
            !value.range?.low?.comparator &&
            !value.range?.high?.comparator &&
            !value.rateRange?.low?.comparator &&
            !value.rateRange?.high?.comparator &&
            !value.rateRatio?.denominator?.comparator &&
            value.rateRatio?.numerator?.comparator !== "~" &&
            !(value.rateRatio?.numerator?.comparator && original.rateRatio?.numerator?.extension?.length) &&
            !original.extension?.some((e) => e.url === R5_RATE_MODIFIERS_R6_URL))
      )
        return original;
      const rate = Object.assign({}, value.provenance);
      if (target === "r6") {
        const modifiers = rate.modifierExtension as FhirExtension[] | undefined;
        delete rate.modifierExtension;
        if (modifiers?.length) {
          const extensions: FhirExtension[] = [];
          for (const e of (rate.extension as FhirExtension[]) ?? [])
            if (e.url !== R5_RATE_MODIFIERS_R6_URL) extensions.push(e);
          extensions.push({ url: R5_RATE_MODIFIERS_R6_URL, extension: modifiers });
          rate.extension = extensions;
        }
      } else {
        const extensions = rate.extension as FhirExtension[] | undefined;
        let keep: FhirExtension[] | undefined, first: FhirExtension | undefined;
        for (let i = 0; i < (extensions?.length ?? 0); i++) {
          const e = extensions![i];
          if (e.url === R5_RATE_MODIFIERS_R6_URL) {
            if (!first) first = e;
            if (!keep) keep = extensions!.slice(0, i);
          } else if (keep) keep.push(e);
        }
        if (first) {
          assign(rate, "extension", keep?.length ? keep : undefined);
          assign(rate, "modifierExtension", first.extension?.length ? first.extension : undefined);
        }
      }
      const code = (q: CanonicalMeasure | undefined) =>
        q && clause
          ? {
              ...q,
              ...getStandardDoseUnitCoding(q.unit),
              ...(q.system ? { system: q.system } : {}),
              ...(q.code ? { code: q.code } : {}),
            }
          : q;
      assign(
        rate,
        "doseQuantity",
        target === "r5" ? simpleQuantityForR5(code(value.quantity)) : code(value.quantity)
      );
      assign(
        rate,
        "doseRange",
        value.range &&
          (target === "r6" && !clause ? value.range : serializeRange(value.range, false, Boolean(clause)))
      );
      assign(rate, "doseExpression", target === "r6" ? value.expression : undefined);
      assign(
        rate,
        "rateQuantity",
        target === "r5" ? simpleQuantityForR5(code(value.rate)) : code(value.rate)
      );
      assign(
        rate,
        "rateRange",
        value.rateRange && (target === "r6" ? value.rateRange : serializeRange(value.rateRange))
      );
      assign(
        rate,
        "rateRatio",
        value.rateRatio && {
          ...value.rateRatio,
          ...(value.rateRatio.numerator
            ? {
                numerator:
                  target === "r5"
                    ? generalQuantityForR5(code(value.rateRatio.numerator))
                    : code(value.rateRatio.numerator),
              }
            : {}),
          ...(value.rateRatio.denominator
            ? {
                denominator:
                  target === "r5"
                    ? simpleQuantityForR5(code(value.rateRatio.denominator))
                    : code(value.rateRatio.denominator),
              }
            : {}),
        }
      );
      assign(rate, "rateExpression", target === "r6" ? value.rateExpression : undefined);
      assign(rate, "type", value.role);
      return rate;
    })
  );
  const oldSite = a.provenance?.format === "r6" ? (output.site as object) : a.provenance?.retained?.site;
  let concept: FhirCodeableConcept | undefined = clause ? context?.site : a.target;
  const oldTarget =
    a.provenance?.format === "r6"
      ? (a.provenance.data as FhirR6Dosage).site?.concept
      : a.provenance?.retained?.site?.concept;
  if (!clause && a.targetCount !== getBodySiteAdministrationTargetCount(oldTarget)) {
    const marker = buildBodySiteAdministrationTargetCountExtension(a.targetCount);
    const extensions = (concept?.extension ?? []).filter(
      (e) => e.url !== BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL
    );
    if (marker) extensions.push(marker);
    if (concept || marker) concept = { ...concept, ...(extensions.length ? { extension: extensions } : {}) };
    if (concept && !extensions.length) delete concept.extension;
  }
  if (target === "r5") {
    assign(output, "site", concept);
    delete output.siteReference;
  } else if (
    concept ||
    a.siteReference ||
    (oldSite && Object.keys(oldSite).some((key) => key !== "concept" && key !== "reference"))
  ) {
    const site: Record<string, unknown> = { ...oldSite };
    assign(site, "concept", concept);
    assign(site, "reference", a.siteReference);
    output.site = site;
  } else delete output.site;
  const source =
    a.provenance?.format === "r6"
      ? (a.provenance.data as FhirR6Dosage)
      : a.provenance?.retained ?? (a.provenance?.data as EzDosage | undefined);
  const sourceCondition = source ? getDosageCondition(source as EzDosage) : undefined;
  if (target === "r5") {
    delete output.condition;
    if (a.predicate || source?.condition !== undefined)
      setDosageCondition(output as FhirDosage, a.predicate, a.calendarPredicate);
  } else {
    // An R5 source may carry only a modifier predicate. Equal clinical
    // predicates do not imply that a native condition array already exists.
    // Preserve real native source arrays, otherwise write the known predicate.
    assign(
      output,
      "condition",
      source?.condition?.length && same(sourceCondition, a.predicate)
        ? source.condition
        : a.predicate
        ? [conditionToR6(a.predicate)]
        : undefined
    );
  }
  if (a.calendarPredicate) setDosageCondition(output as FhirDosage, a.predicate, a.calendarPredicate);
  if (
    a.excludedDates?.length ||
    (source && !same(getDosageExcludedDates(source as EzDosage), a.excludedDates ?? []))
  )
    setDosageExcludedDates(output as FhirDosage, a.excludedDates ?? []);
  if (
    a.excludedWeekdays?.length ||
    (source && !same(getDosageExcludedWeekdays(source as FhirDosage), a.excludedWeekdays ?? []))
  )
    setDosageExcludedWeekdays(output as FhirDosage, a.excludedWeekdays ?? []);
  if (a.choice || (source && !a.choiceIssue && getDosageAlternativeChoice(source)))
    setDosageAlternativeChoice(
      output as FhirDosage,
      a.choice ? { ...a.choice, selectionBehavior: "exactly-one" } : undefined
    );
  if (clause?.clinicalQuantity?.carrierMaterial?.text) {
    output.extension = [
      ...((output.extension as FhirDosage["extension"]) ?? []),
      infusionCarrierMaterialExtension(clause.clinicalQuantity.carrierMaterial),
    ];
  }
  if (a.cycleDays || (source && getCycleDayConstraint(source as FhirDosage)))
    output.modifierExtension = [
      ...((output.modifierExtension as FhirDosage["modifierExtension"]) ?? []).filter(
        (e) => e.url !== CYCLE_DAY_ELIGIBILITY_EXTENSION_URL
      ),
      ...(a.cycleDays ? [cycleDayConstraintExtension(a.cycleDays)] : []),
    ];
  if (
    a.phaseOrigin ||
    (source &&
      !a.phaseOriginIssue &&
      source.modifierExtension?.some((e) => e.url === PARALLEL_COMPONENT_PHASE_ORIGIN_URL))
  ) {
    const existing = (output.modifierExtension as FhirDosage["modifierExtension"]) ?? [];
    output.modifierExtension = [
      ...existing.filter((e) => e.url !== PARALLEL_COMPONENT_PHASE_ORIGIN_URL),
      ...(a.phaseOrigin ? [{ url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL, valueQuantity: a.phaseOrigin }] : []),
    ];
  }
  // Whole-course display baselines belong to the FINAL output, never to
  // a projected component copied from an earlier edited source. Remove only
  // recognized old baselines; native course provenance retains their history.
  const priorExtensions = output.extension as FhirExtension[] | undefined;
  if (priorExtensions) {
    let kept: FhirExtension[] | undefined;
    for (let i = 0; i < priorExtensions.length; i++) {
      const e = priorExtensions[i];
      if (isRenderedInstructionMarker(e)) {
        if (!kept) kept = priorExtensions.slice(0, i);
      } else if (kept) kept.push(e);
    }
    if (kept) assign(output, "extension", kept.length ? kept : undefined);
  }
  // No understood safety concept is serialized through a generic bag.
  // Unknown external annotations survive via the original wire provenance.
  if (target === "r6") {
    // Saved row-profile markers do not belong inside an emitted native R6
    // component. The importer already restored them into native facts.
    const oldModifiers = output.modifierExtension as FhirExtension[] | undefined;
    if (oldModifiers) {
      const kept: FhirExtension[] = [];
      for (const extension of oldModifiers) {
        if (extension.url === DOSAGE_DETAILS_R5_URL) continue;
        if (extension.url === DOSAGE_CONDITION_R5_URL && isExactConditionBridge(extension)) continue;
        kept.push(extension);
      }
      assign(output, "modifierExtension", kept.length ? kept : undefined);
    }

    if (a.missingContexts?.length)
      output.modifierExtension = [
        ...((output.modifierExtension as FhirExtension[]) ?? []),
        {
          url: DOSAGE_DETAILS_R5_URL,
          extension: a.missingContexts.map((valueString) => ({ url: "missingContext", valueString })),
        },
      ];
    delete output.siteReference;
    delete output.excludedDates;
    delete output.maxDosePerPeriod;
    delete output.maxDosePerAdministration;
    delete output.maxDosePerLifetime;
    assign(output, "safety", safetyToWire(a.safety, source?.safety, a.limits, Boolean(clause)));
  } else {
    delete output.safety;
    delete output.maxDosePerPeriod;
    delete output.maxDosePerAdministration;
    delete output.maxDosePerLifetime;
    let periodLimits: NonNullable<FhirDosage["maxDosePerPeriod"]> | undefined;
    for (const limit of a.limits ?? []) {
      if (!limit.amount) continue;
      const amount = {
        ...limit.amount,
        ...(clause ? getStandardDoseUnitCoding(limit.amount.unit) : undefined),
        ...(limit.amount.system ? { system: limit.amount.system } : {}),
        ...(limit.amount.code ? { code: limit.amount.code } : {}),
      };
      if (limit.scope === "period" && limit.period) {
        const period = {
          ...limit.period,
          ...(clause && !limit.period.system && !limit.period.code && isCalendarUnit(limit.period.unit)
            ? { system: "http://unitsofmeasure.org", code: limit.period.unit }
            : {}),
        };
        (periodLimits ??= []).push({
          numerator: generalQuantityForR5(amount),
          denominator: simpleQuantityForR5(period),
        });
      } else if (limit.scope === "administration")
        output.maxDosePerAdministration = simpleQuantityForR5(amount);
      else if (limit.scope === "lifetime") output.maxDosePerLifetime = simpleQuantityForR5(amount);
    }
    if (periodLimits) output.maxDosePerPeriod = periodLimits;
  }
  return output as FhirDosage | FhirR6Dosage;
}
/** Direct native-to-R6 component writer. */
export function administrationToR6(
  a: CanonicalAdministration,
  options?: FhirProjectionOptions,
  currentSyntax?: CanonicalSigClause
): FhirR6Dosage {
  return administrationToWire(a, "r6", options, currentSyntax) as FhirR6Dosage;
}
/** Direct native-to-R5 component writer. No R6 component is constructed. */
export function administrationToR5(
  a: CanonicalAdministration,
  sequence: number,
  options?: FhirProjectionOptions,
  currentSyntax?: CanonicalSigClause
): FhirDosage {
  const row = administrationToWire(a, "r5", options, currentSyntax) as FhirDosage;
  row.sequence = sequence;
  return row;
}
const same = equalStructuredValues;
function isCalendarUnit(unit: string | undefined): unit is "s" | "min" | "h" | "d" | "wk" | "mo" | "a" {
  return (
    unit === "s" ||
    unit === "min" ||
    unit === "h" ||
    unit === "d" ||
    unit === "wk" ||
    unit === "mo" ||
    unit === "a"
  );
}
/** Standard wire display labels, not natural-language SIG realization.
 * The clinical unit code remains authoritative in both output versions. */
const WIRE_DURATION_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  s: ["second", "seconds"],
  min: ["minute", "minutes"],
  h: ["hour", "hours"],
  d: ["day", "days"],
  wk: ["week", "weeks"],
  mo: ["month", "months"],
  a: ["year", "years"],
};
function serializeDuration(q: CanonicalMeasure): FhirR6Quantity {
  const unit = q.code ?? q.unit ?? "";
  return {
    ...q,
    unit: WIRE_DURATION_LABELS[unit]?.[q.value === 1 ? 0 : 1] ?? q.unit,
    system: q.system ?? "http://unitsofmeasure.org",
    code: unit,
  };
}
function serializeRange(value: CanonicalRange, duration = false, doseCoding = false): FhirRange {
  const q = (item: CanonicalMeasure) =>
    simpleQuantityForR5(
      duration
        ? serializeDuration(item)
        : doseCoding
        ? { ...item, ...getStandardDoseUnitCoding(item.unit) }
        : item
    )!;
  return {
    ...value,
    ...(value.low ? { low: q(value.low) } : {}),
    ...(value.high ? { high: q(value.high) } : {}),
  } as FhirRange;
}
/** Header/step metadata is shared fragment serialization, NOT a course in
 * another external format. The R5 writer encodes it directly in R5 extensions. */
export function courseMetadataToWire(
  course: CanonicalCourse
): Omit<FhirR6DosageInstruction, "step" | "renderedInstruction"> {
  const out: Record<string, unknown> = Object.assign({}, course.provenance?.data);
  delete out.step;
  delete out.renderedInstruction;
  assign(out, "repeatCycle", course.cycleInterval);
  const raw = course.provenance?.data as Partial<FhirR6DosageInstruction> | undefined;
  assign(out, "safety", safetyToWire(course.safety, raw?.safety));
  return out;
}
export function stageMetadataToWire(stage: CanonicalStage): Omit<FhirR6DosageStep, "component"> {
  const out: Record<string, unknown> = Object.assign({}, stage.provenance);
  delete out.component;
  assign(out, "start", boundaryToWire(stage.start));
  assign(out, "end", boundaryToWire(stage.end));
  assign(out, "count", stage.count);
  assign(
    out,
    "safety",
    safetyToWire(stage.safety, (stage.provenance as FhirR6DosageStep | undefined)?.safety)
  );
  return out;
}
function projectCourseToR6(
  course: CanonicalCourse,
  options: FhirProjectionOptions | undefined,
  freshlyCompiled: boolean
): FhirR6DosageInstruction {
  const steps: FhirR6DosageStep[] = [];
  for (const stage of course.stages) {
    const component: FhirR6Dosage[] = [];
    for (const a of stage.administrations)
      component.push(administrationToR6(a, options, freshlyCompiled ? a.syntax : undefined));
    steps.push(Object.assign(stageMetadataToWire(stage), { component }));
  }
  const result: FhirR6DosageInstruction = Object.assign(courseMetadataToWire(course), { step: steps });
  if (course.instruction !== undefined) result.renderedInstruction = course.instruction;
  return result;
}
/** Ordinary native export must derive source-annotation views from current
 * native fields because callers may have edited them. */
export function courseToR6(
  course: CanonicalCourse,
  options?: FhirProjectionOptions
): FhirR6DosageInstruction {
  return projectCourseToR6(course, options, false);
}
/** Parser construction-only export: the caller has JUST compiled these exact
 * clauses and has not exposed them for edits. Reusing their annotation views
 * avoids rebuilding every canonical clause merely to write its first output.
 * This is not a persistent cache and is never used for public edited exports. */
export function projectFreshlyCompiledCourseToR6(
  course: CanonicalCourse,
  options?: FhirProjectionOptions
): FhirR6DosageInstruction {
  return projectCourseToR6(course, options, true);
}
export function courseToR5(course: CanonicalCourse): FhirDosage[] {
  return projectNativeR5Course(course).dosages;
}

/** Boundary-only authored-source fast path. Returning a string unchanged does
 * not need native normalization or an editable ownership copy. These checks
 * inspect only source authority/presence, never dose interpretation or event
 * calculations; computed previews always enter the canonical formatter. */
export function unchangedR6SourceDisplay(
  raw: FhirR6DosageInstruction,
  options?: FormatOptions
): string | undefined {
  if (!raw.renderedInstruction) return undefined;
  if (
    !options ||
    options.realizationMode === "roundtrip" ||
    !raw.step.length ||
    raw.repeatCycle ||
    raw.safety
  )
    return raw.renderedInstruction;
  for (const step of raw.step) {
    if (step.start || step.end || step.count !== undefined || step.safety) return raw.renderedInstruction;
    for (const a of step.component) {
      if (a.condition?.length || a.safety || a.site?.reference) return raw.renderedInstruction;
      for (const amount of a.doseAndRate ?? [])
        if (amount.doseExpression || amount.rateExpression) return raw.renderedInstruction;
    }
  }
  return undefined;
}

/** Explicit editable import for applications that already hold R5 rows.
 * Import normalization and persistence reconciliation happen once here, not
 * inside any native edit, formatter, or execution operation. */
export function importCanonicalCourse(
  input: FhirDosage | readonly FhirDosage[] | FhirR6DosageInstruction | ParseBatchResult | CanonicalCourse
): CanonicalCourse {
  if (!Array.isArray(input)) {
    if ("kind" in input && input.kind === "course") return input;
    if ("items" in input && input.meta.canonical.course) return input.meta.canonical.course;
    if ("step" in input) return courseFromR6(input, true);
    if ("items" in input) return courseFromR6(input.fhirNext, true);
  }
  const rows = Array.isArray(input) ? (input as readonly FhirDosage[]) : [input as FhirDosage];
  return courseFromR5(rows, undefined, undefined, undefined, true);
}
