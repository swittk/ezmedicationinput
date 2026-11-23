import { projectR6ModifierWrapper, reconcileLiftedR5Safety, R5_EXPRESSION_SLOT_SOURCE_URL, getDosageSourceTextAgreement, sourceOwnership, isCompactSourceAgreementMarker } from "../dosage-course";
import { courseFromR5 } from "./r5-import";
import { getCourseCycleCount, setCourseCycleCount } from "../fhir-course-cycle-count";
import { projectNativeR5Course } from "./r5-course";
import { editableCourseSteps, retainedSingleStepSafety, liftSingleStepSafety, retainDraftSteps, retainConflictingAmountChoices, R6_DRAFT_STEPS_SOURCE_URL, R6_SINGLE_STEP_SAFETY_SOURCE_URL } from "./r6-editable-metadata";
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
  FhirR6DosageInstructionInput,
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
  FhirRatio,
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
  DOSAGE_RETAINED_R5_SEQUENCE_URL,
  R5_RATE_MODIFIERS_R6_URL,
  DOSAGE_CONDITION_R5_URL,
  exactConditionBridgePredicate,
  isRenderedInstructionMarker,
  hasUnrecognizedEditMetadata,
  retainField,
  readRetainedField,
  encodeR6SourceMetadata,
  decodeR6SourceMetadata,
  dosageMatchesSavedProjection,
  getFreshDoseSource,
  getDosageSourceTextFingerprint,
  dosageTextFingerprint,
  DOSAGE_RECONCILIATION_SOURCE_URL,
  DOSAGE_RENDERED_INSTRUCTION_R5_URL,
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
  getTimingClocks,
  getTimingEvents, TIMING_ADDITIONAL_CLOCK_EXTENSION_URL,
  projectTimingClocks,
  deserializeCanonicalContext,
  cycleDayConstraintExtension,
  infusionCarrierMaterialExtension,
  INFUSION_CARRIER_MATERIAL_EXTENSION_URL,
  clinicalCarrierQuantityFromFhir,
  getAdministrationOffsetMinutes,
  getAnchoredCourseDuration,
  projectCourseDurationRange,
  getTimingClockWindow,
  getTimingMonthDays,
  getTimingWeekdayOrdinal,
  getTimingEventWindow,
  getTimingOccurrenceCap,
  getCycleDayConstraint,
  getExactTimingOffsetMinutes,
  parseActivityTimingExtensions,
  TIMING_EVENT_CALENDAR_SOURCE_EXTENSION_URL,
  TIMING_FREQUENCY_MIN_EXTENSION_URL,
  TIMING_ADMINISTRATION_DURATION_EXTENSION_URL,
  parseTimingAdministrationDuration,
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
  quantityFromWire,
  quantityForR6,
} from "../fhir-quantity-operator";
import { equalStructuredValues } from "../stable-structure";
import { clauseForAdministration } from "../canonical/compile";
import { getStandardDoseUnitCoding } from "../maps";
import { getMedicationInstructionAction } from "../instruction-action-terminology";
import { AdviceArgumentRole, AdvicePolarity, type AdviceFrame } from "../types";
import type { FhirProjectionOptions } from "../fhir";
import {
  getBodySiteAdministrationTargetCount,
  buildBodySiteAdministrationTargetCountExtension,
  BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL,
} from "../body-site-target";

/** An incomplete authored R5 maximum is retained source, not an invented R6 limit. */
export const R5_SOURCE_ONLY_MAXIMUM_URL =
  "urn:ezmedicationinput:StructureDefinition:r5-source-only-maximum";
/** Source-only maxima are never executable limits. Their typed source can
 * return to an R5 Ratio only when both endpoints (or neither) satisfy rat-1. */
function sourceMaximumToR5(maximum: FhirRatio): boolean {
  return maximum.numerator !== undefined && maximum.denominator !== undefined ||
    maximum.numerator === undefined && maximum.denominator === undefined && !!maximum.extension?.length;
}
function projectSourceMaxima(output: Record<string, unknown>, target: "r5" | "r6"): FhirRatio[] | undefined {
  const original = output.extension as FhirExtension[] | undefined;
  let extensions: FhirExtension[] | undefined, maxima: FhirRatio[] | undefined;
  for (let index = 0; index < (original?.length ?? 0); index++) {
    const marker = original![index];
    if (marker.url !== R5_SOURCE_ONLY_MAXIMUM_URL || !marker.valueRatio &&
        !marker.extension?.some(child => child.url === "kind" && child.valueCode === "object")) {
      if (extensions) extensions.push(marker);
      continue;
    }
    const maximum = marker.valueRatio ?? readRetainedField(marker) as FhirRatio;
    if (target === "r5" && sourceMaximumToR5(maximum)) {
      (maxima ??= []).push(maximum);
      extensions ??= original!.slice(0, index);
      if (Object.keys(marker).some(key => key !== "url" && key !== "extension" && key !== "valueRatio"))
        extensions.push({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [marker] });
    } else if (marker.valueRatio) {
      // Accept older source markers, but never re-emit a one-ended valueRatio.
      extensions ??= original!.slice(0, index);
      const { valueRatio: _ratio, ...metadata } = marker;
      extensions.push({ ...metadata, ...retainField(R5_SOURCE_ONLY_MAXIMUM_URL, maximum) });
    } else if (extensions) extensions.push(marker);
  }
  if (extensions) assign(output, "extension", extensions.length ? extensions : undefined);
  return maxima;
}

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
  return quantityFromWire(q);
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
  r: Pick<NonNullable<FhirR6Timing["repeat"]>, "extension" | "offset" | "timeOfDay" | "duration" | "durationMax" | "durationUnit"> | undefined
): Pick<
  NonNullable<CanonicalTiming["recurrence"]>,
  | "clocks"
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
  | "occurrenceDuration"
  | "occurrenceDurationMax"
  | "occurrenceDurationUnit"
  | "occurrenceDurationComparator"
  | "occurrenceDurationRange"
> {
  const out: Pick<
    NonNullable<CanonicalTiming["recurrence"]>,
    | "clocks"
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
    | "occurrenceDuration"
    | "occurrenceDurationMax"
    | "occurrenceDurationUnit"
    | "occurrenceDurationComparator"
    | "occurrenceDurationRange"
  > = { offset: r?.offset };
  let administrationDurationSeen = false;
  let exact: FhirExtension | undefined,
    month: FhirExtension[] | undefined,
    activities: FhirExtension[] | undefined;
  let weekday: FhirExtension | undefined,
    cap: FhirExtension | undefined,
    clock: FhirExtension | undefined,
    event: FhirExtension | undefined;
  for (const e of r?.extension ?? [])
    switch (e.url) {
      case TIMING_ADDITIONAL_CLOCK_EXTENSION_URL:
        if (r?.timeOfDay === undefined) {
          if (e.valueTime !== undefined) (out.clocks ??= []).push(e.valueTime);
          else if (e._valueTime) out.clocks ??= [];
        }
        break;
      case TIMING_ADMINISTRATION_DURATION_EXTENSION_URL:
        if (!administrationDurationSeen) {
          administrationDurationSeen = true;
          const duration = parseTimingAdministrationDuration(e, r);
          if (duration) {
            out.occurrenceDuration = duration.value;
            if (duration.range) out.occurrenceDurationRange = duration.range;
            out.occurrenceDurationUnit = duration.unit;
            out.occurrenceDurationComparator = duration.comparator;
          } else if (r?.duration === undefined && e.valueQuantity?.value !== undefined) {
            // Preserve numeric duration presence without interpreting a local
            // unit. Its original quantity remains in the timing provenance.
            out.occurrenceDuration = e.valueQuantity.value;
            out.occurrenceDurationComparator = getQuantityComparator(e.valueQuantity);
          }
        }
        break;
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
/** Metadata-only primitive positions stay on the wire, not in recurrence facts. */
function timingPrimitiveValues<T>(source: T[] | undefined): T[] | undefined {
  if (!source) return undefined;
  let values: T[] | undefined;
  for (let index = 0; index < source.length; index++) {
    const value = source[index];
    if (value === null) values ??= source.slice(0, index);
    else if (values) values.push(value);
  }
  return values ?? source;
}
function timing(t: FhirTiming | FhirR6Timing | undefined, r5 = false): CanonicalTiming | undefined {
  if (!t) return undefined;
  const out: CanonicalTiming = { code: t.code, explicitEvents: getTimingEvents(t), provenance: record(t) };
  const r = t.repeat;
  if (r) {
    const annotations = r.extension?.length ? timingAnnotations(r) : undefined;
    const native = r as NonNullable<FhirR6Timing["repeat"]>;
    out.recurrence = {
      count: r.count,
      countMax: r.countMax,
      frequency: r.frequency ?? annotations?.frequency,
      frequencyMax: r.frequencyMax,
      period: r.period,
      periodMax: r.periodMax,
      periodUnit: r.periodUnit,
      occurrenceDuration: annotations?.occurrenceDurationRange ? undefined : r.duration ?? annotations?.occurrenceDuration,
      occurrenceDurationMax: annotations?.occurrenceDurationRange ? undefined : r.durationMax,
      occurrenceDurationRange: annotations?.occurrenceDurationRange,
      occurrenceDurationUnit: annotations?.occurrenceDurationRange ? undefined :
        r.duration === undefined && annotations?.occurrenceDuration !== undefined
          ? annotations.occurrenceDurationUnit : r.durationUnit,
      occurrenceDurationComparator: r.duration === undefined ? annotations?.occurrenceDurationComparator : undefined,
      courseLength: r5 ? measureFromR5(r.boundsDuration as FhirQuantity) : measureFromWire(r.boundsDuration),
      courseLengthRange: rangeFromFhir(r.boundsRange),
      calendarWindow: r.boundsPeriod,
      clocks: r.timeOfDay !== undefined ? getTimingClocks(r) : annotations?.clocks,
      anchors: timingPrimitiveValues(r.when),
      dayOfWeek: timingPrimitiveValues(r.dayOfWeek),
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
/** Stable external event identity; the native boundary shape remains internal.
 * This event is already the next local day after the prior phase completes,
 * so the adapter must not synthesize an additional one-day displacement. */
const COURSE_PHASE_EVENT_SYSTEM = "urn:ezmedicationinput:CodeSystem:course-phase-event";
const PREVIOUS_PHASE_NEXT_DAY_CODE = "previous-phase-next-day";

export function boundaryFromR6(b: FhirR6RelativeTime | undefined): CanonicalBoundary | undefined {
  if (!b) return undefined;
  let recognized: "treatment-start" | "treatment-day-start" | "previous-phase-next-day" | undefined;
  if (!b.contextReference && !b.contextDefinition && !b.contextPath) {
    for (const coding of b.contextCode?.coding ?? []) {
      const event = coding.system === TREATMENT_START_SYSTEM && coding.code === "treatment-start"
        ? "treatment-start" : coding.system === COURSE_PHASE_EVENT_SYSTEM && coding.code === PREVIOUS_PHASE_NEXT_DAY_CODE
        ? "previous-phase-next-day" : coding.system === COURSE_PHASE_EVENT_SYSTEM && coding.code === "treatment-day-start"
        ? "treatment-day-start" : undefined;
      if (!event) continue;
      // Conflicting understood anchors are retained as a coded event. Unknown
      // foreign equivalents do not supply a different executable meaning.
      if (recognized && recognized !== event) { recognized = undefined; break; }
      recognized = event;
    }
  }
  const anchor = recognized
    ? recognized
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
  if (policy?.ifExceeded === undefined) delete output.ifExceeded;
  else output.ifExceeded = policy.ifExceeded;
  const known = limits ?? policy?.limits;
  if (known?.length) {
    output.doseLimit = known.map((limit) => {
      const saved = limit.provenance as FhirR6DoseLimit | undefined;
      // R6 value[x] is an exclusive choice: never resurrect a stale source
      // valueQuantity when an integer/expression was explicitly edited.
      const {
        valueQuantity: _oldQuantity,
        valueInteger: _oldCount,
        _valueInteger: countMetadata,
        valueExpression: _oldExpression,
        period: _oldPeriod,
        text: _oldText,
        numerator: _ratioNumerator,
        denominator: _ratioDenominator,
        ...metadata
      } = (saved ?? {}) as FhirR6DoseLimit & { numerator?: unknown; denominator?: unknown };
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
        ...(period ? { period: quantityForR6(period) } : {}),
        ...(limit.text !== undefined ? { text: limit.text } : {}),
      };
      const amount = limit.amount;
      if (amount)
        return {
          ...common,
          valueQuantity: quantityForR6({
            ...amount,
            ...(inferCoding ? getStandardDoseUnitCoding(amount.unit) : undefined),
            ...(amount.system ? { system: amount.system } : {}),
            ...(amount.code ? { code: amount.code } : {}),
          })!,
        } satisfies FhirR6DoseLimit;
      if (limit.count !== undefined)
        return { ...common, valueInteger: limit.count,
          ...(countMetadata ? { _valueInteger: countMetadata } : {}) } satisfies FhirR6DoseLimit;
      if (limit.expression) return { ...common, valueExpression: limit.expression } satisfies FhirR6DoseLimit;
      // FHIR permits an extension-only primitive. It is source evidence,
      // not a numeric ceiling, and must not prevent importing the dosage.
      if (countMetadata && saved?.valueInteger === undefined)
        return { ...common, _valueInteger: countMetadata } satisfies FhirR6DoseLimit;
      throw new TypeError("An authored safety limit must contain a numeric, count, or expression value");
    });
  } else delete output.doseLimit;
  if (!output.doseLimit && !output.ifExceeded &&
      !Object.keys(output).some(key => {
        const value = (output as Record<string, unknown>)[key];
        return key !== "id" && value !== undefined && (!Array.isArray(value) || value.length > 0);
      })) return undefined;
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
/** Older saved R5 parser rows predate explicit dose-owner spans. A single
 * restored declared amount must reproduce their existing projection exactly
 * before display can treat its absence as a clear. No source graph is edited. */
function savedR5DoseOwner(
  raw: FhirDosage, graph: NonNullable<CanonicalSigClause["instructionGraph"]>
): AdviceFrame | undefined {
  if (raw.doseAndRate?.length || graph.primaryAdministrationSpan || getFreshDoseSource(raw) ||
      getDosageSourceTextAgreement(raw, false) === false) return undefined;
  let owner: AdviceFrame | undefined;
  for (const action of graph.actions) {
    if (action.polarity === AdvicePolarity.Negate ||
        !getMedicationInstructionAction(action.predicate.lemma)?.definesDose ||
        !action.args.some(arg => arg.role === AdviceArgumentRole.Amount && arg.quantity)) continue;
    if (owner) return undefined;
    owner = action;
  }
  if (!owner) return undefined;
  const amount = owner.args.find(arg => arg.role === AdviceArgumentRole.Amount && arg.quantity)!.quantity!;
  const coded = (value: number) => simpleQuantityForR5({
    value, unit: amount.unit, ...getStandardDoseUnitCoding(amount.unit), comparator: amount.comparator
  })!;
  const dose = amount.range ? { doseRange: {
    ...(amount.range.low !== undefined ? { low: coded(amount.range.low) } : {}),
    ...(amount.range.high !== undefined ? { high: coded(amount.range.high) } : {})
  } } : amount.value !== undefined ? { doseQuantity: coded(amount.value) } : undefined;
  if (!dose) return undefined;
  const restored = { ...raw, doseAndRate: [dose] };
  const matches = dosageMatchesSavedProjection(restored);
  return matches === true ? owner : undefined;
}
function baseAdministration(
  raw: FhirDosage | FhirR6Dosage | EzDosage,
  format: "r5" | "r6",
  sourceContext = false
): CanonicalAdministration {
  const input = raw as EzDosage;
  const target = format === "r6" ? (raw as FhirR6Dosage).site?.concept : input.site;
  let phaseOrigin: CanonicalMeasure | undefined,
    phaseStart: CanonicalBoundary | undefined,
    phaseEnd: CanonicalBoundary | undefined,
    phaseOriginIssue = false,
    seenOrigin = false;
  let sourceMember: number | undefined, phasePredecessors: number[] | undefined;
  let missingContexts: string[] | undefined,
    contextIssue: CanonicalAdministration["contextIssue"];
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
      case DOSAGE_DETAILS_R5_URL:
        // R6 carries unresolved row context as an active modifier. Normalize
        // it here so both exporters read the same typed administration facts.
        // R5 membership/resolution remains owned by the R5 course importer.
        if (format === "r6") for (const child of e.extension ?? []) {
          const context = child.valueString;
          if (child.url !== "missingContext" || context === undefined) continue;
          if (!missingContexts) missingContexts = [context];
          else if (missingContexts.indexOf(context) < 0) missingContexts.push(context);
          if (context === "conflicting-phase") contextIssue = "conflicting-course-phase";
          else contextIssue ??= "missing-course-context";
        }
        break;
      case PARALLEL_COMPONENT_PHASE_ORIGIN_URL:
        if (seenOrigin) phaseOriginIssue = true;
        seenOrigin = true;
        // Identity is sparse: only members of a real dependency carry it.
        // Original source member IDs must survive wire reorder and deletion.
        for (const child of e.extension ?? []) {
          if (child.url === "sourceMember" && child.valueInteger !== undefined)
            sourceMember = child.valueInteger;
        }
        if (sourceMember !== undefined) {
          phasePredecessors = [];
          for (const child of e.extension ?? [])
            if (child.url === "predecessor" && child.valueInteger !== undefined)
              phasePredecessors.push(child.valueInteger);
        }
        if (e.valueQuantity) phaseOrigin = measureFromWire(e.valueQuantity);
        else {
          const fields = decodeR6SourceMetadata(e, "step");
          phaseStart = boundaryFromR6(fields?.start as FhirR6RelativeTime | undefined);
          phaseEnd = boundaryFromR6(fields?.end as FhirR6RelativeTime | undefined);
          if (!phaseStart && !phaseEnd && sourceMember === undefined) phaseOriginIssue = true;
        }
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
  let sourceFields: ReturnType<typeof sourceOwnership>;
  let hasCarrierMaterial = false;
  for (const e of raw.extension ?? []) {
    if (e.url === DOSAGE_EXCLUDED_WEEKDAYS_R5_URL && !weekdaysMarker) weekdaysMarker = e;
    else if (e.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL && sourceFields === undefined)
      sourceFields = sourceOwnership(e);
    else if (e.url === INFUSION_CARRIER_MATERIAL_EXTENSION_URL) hasCarrierMaterial = true;
  }
  const amounts: CanonicalAmount[] | undefined = raw.doseAndRate ? [] : undefined;
  for (const value of raw.doseAndRate ?? [])
    amounts!.push(amountFromWire(value as NonNullable<FhirR6Dosage["doseAndRate"]>[number], format === "r5"));
  let sourceTextVerified = format === "r6" ? false : getDosageSourceTextAgreement(raw);
  const carrier = raw.doseAndRate?.[0]?.rateRatio && (sourceContext || format === "r5" && hasCarrierMaterial)
    ? clinicalCarrierQuantityFromFhir(raw as FhirDosage) : undefined;
  if (format === "r5" && (sourceContext || carrier?.carrierMaterial) &&
      sourceTextVerified !== false && raw.extension?.length) {
    const matches = dosageMatchesSavedProjection(input);
    if (matches === false) {
      const originalText = getDosageSourceTextFingerprint(raw);
      // A cached clinical mismatch invalidates old graph wording, while an
      // explicitly replaced external text still owns its current display.
      if (raw.text === undefined || originalText === undefined || originalText === dosageTextFingerprint(input))
        sourceTextVerified = false;
    } else if (matches === undefined && sourceTextVerified === undefined &&
        carrier?.carrierMaterial && !getFreshDoseSource(input)) {
      // A cold standalone carrier has no source agreement to certify on save.
      // Preserve its text, while its current typed material owns the preview.
      sourceTextVerified = false;
    }
  }
  const duration = anchored ? getAnchoredCourseDuration(raw) : undefined;
  let schedule = timing(raw.timing, format === "r5");
  const denominator = raw.doseAndRate?.[0]?.rateRatio?.denominator;
  if (denominator && schedule?.recurrence?.occurrenceDuration === undefined &&
      raw.timing?.repeat?.duration === undefined && getQuantityComparator(denominator) &&
      !raw.timing?.repeat?.extension?.some(e => e.url === TIMING_ADMINISTRATION_DURATION_EXTENSION_URL)) {
    // Only an explicitly recognized carrier/self-carrier infusion supplies an
    // administration duration. An arbitrary rate denominator is not a dose time.
    const administrationDuration = (carrier ?? clinicalCarrierQuantityFromFhir(raw as FhirDosage))?.administrationDuration;
    if (administrationDuration?.comparator) {
      schedule ??= {};
      const recurrence = schedule.recurrence ??= {};
      recurrence.occurrenceDuration = administrationDuration.value;
      recurrence.occurrenceDurationUnit = administrationDuration.unit;
      recurrence.occurrenceDurationComparator = administrationDuration.comparator;
    }
  }
  if (duration?.valueRange && raw.timing?.repeat?.boundsRange && schedule?.recurrence)
    schedule.recurrence.courseLengthRange = rangeFromFhir(duration.valueRange);
  const asNeeded = raw.asNeeded ?? (format === "r5"
    ? (raw as FhirDosage & { asNeededBoolean?: boolean }).asNeededBoolean : undefined);
  const output: CanonicalAdministration = {
    kind: "administration",
    schedule,
    amounts,
    stageOrdinal: format === "r5" ? input.sequence : undefined,
    asNeeded: asNeeded ?? (raw.asNeededFor?.length ? true : undefined),
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
    phaseStart,
    phaseEnd,
    phaseOriginIssue,
    delayMinutes: delayMarker
      ? getAdministrationOffsetMinutes({ modifierExtension: [delayMarker] })
      : undefined,
    anchoredLength: duration && !raw.timing?.repeat?.boundsRange
      ? { quantity: measureFromWire(duration.valueQuantity), range: rangeFromFhir(duration.valueRange) }
      : undefined,
    cycleDays: cycleMarker ? getCycleDayConstraint({ modifierExtension: [cycleMarker] }) : undefined,
    provenance: { format, data: record(raw) },
  };
  // Keep sparse dependency identities off the ordinary import allocation
  // path; an object spread here emits ES6 descriptor-copy helpers per dose.
  if (sourceFields?.clocks !== undefined) output.provenance!.sourceHasStructuredClocks = sourceFields.clocks;
  if (sourceFields?.events !== undefined) output.provenance!.sourceHasStructuredEvents = sourceFields.events;
  if (sourceFields?.site !== undefined) output.provenance!.sourceHasStructuredSite = sourceFields.site;
  if (phasePredecessors !== undefined) {
    output.sourceMember = sourceMember;
    output.phasePredecessors = phasePredecessors;
  }
  if (missingContexts) {
    output.missingContexts = missingContexts;
    output.contextIssue = contextIssue;
  }
  if (sourceTextVerified !== undefined) output.provenance!.sourceTextVerified = sourceTextVerified;
  if (format === "r5") {
    let limits: CanonicalDoseLimit[] | undefined, sourceMaxima: FhirExtension[] | undefined;
    for (const maximum of input.maxDosePerPeriod ?? []) {
      if (maximum.numerator?.value === undefined || maximum.denominator?.value === undefined) {
        (sourceMaxima ??= []).push(retainField(R5_SOURCE_ONLY_MAXIMUM_URL, maximum));
        continue;
      }
      (limits ??= []).push({
        scope: "period",
        amount: measureFromR5(maximum.numerator),
        period: measureFromR5(maximum.denominator),
        provenance: maximum,
      });
    }
    if (sourceMaxima) output.provenance!.data = {
      ...raw, extension: [...(raw.extension ?? []), ...sourceMaxima],
    };
    if (input.maxDosePerAdministration)
      (limits ??= []).push({
        scope: "administration",
        amount: measureFromR5(input.maxDosePerAdministration),
      });
    if (input.maxDosePerLifetime)
      (limits ??= []).push({ scope: "lifetime", amount: measureFromR5(input.maxDosePerLifetime) });
    if (limits) output.limits = limits;
  }
  if (sourceContext) {
    output.syntax = deserializeCanonicalContext({
      text: raw.text,
      extension: raw.extension,
      route: raw.route,
      site: target,
      method: raw.method,
      asNeeded,
      asNeededFor: raw.asNeededFor,
      additionalInstruction: raw.additionalInstruction,
      patientInstruction: raw.patientInstruction,
    });
    // The existing typed carrier feature supplies only its current material
    // label to presentation; native amounts still own every dose/rate value.
    if (carrier?.carrierMaterial) output.syntax.clinicalQuantity = carrier;
  }
  const graph = output.syntax?.instructionGraph;
  if (format === "r5" && sourceTextVerified === false && !amounts?.length && graph && !graph.primaryAdministrationSpan) {
    const owner = savedR5DoseOwner(input, graph);
    if (owner) output.syntax!.instructionGraph = {
      ...graph, primaryAdministrationSpan: { start: owner.span.start, end: owner.span.end }
    };
  }
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
  // Most rows have only R5 maxima and need no mirror reconciliation.
  // Lifted safety has a persisted baseline so either current view can own an edit.
  if ((raw as EzDosage).safety) {
    const safety = reconcileLiftedR5Safety(raw as EzDosage);
    result.safety = safetyFromWire(safety);
    result.limits = safety?.doseLimit?.map((limit) => ({
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
export function courseFromR6(raw: FhirR6DosageInstructionInput, sourceContext = false): CanonicalCourse {
  const stages: CanonicalStage[] = [];
  const retainedSafety = retainedSingleStepSafety(raw);
  const steps = editableCourseSteps(raw);
  let sourceStepIndex = 0;
  for (const step of steps) {
    let safetyOwner = false;
    if (retainedSafety) {
      // Draft restoration can insert inactive stages or remove a synthesized
      // start using a shallow step copy. Match its active source in this same
      // traversal so the retained policy follows exactly one original owner.
      const source = raw.step?.[sourceStepIndex];
      if (step === source || step.component === source?.component) {
        safetyOwner = source === retainedSafety.owner;
        sourceStepIndex++;
      }
    }
    const stepSafety = step.safety ?? (safetyOwner ? retainedSafety!.step : undefined);
    const administrations: CanonicalAdministration[] = [];
    for (const component of step.component)
      administrations.push(administrationFromR6(component, sourceContext));
    stages.push({
      administrations,
      start: boundaryFromR6(step.start),
      end: boundaryFromR6(step.end),
      count: step.count,
      safety: safetyFromWire(stepSafety, true),
      provenance: record(safetyOwner && !step.safety ? { ...step, safety: stepSafety } : step),
    });
  }
  const course: CanonicalCourse = {
    kind: "course",
    stages,
    instruction: raw.renderedInstruction,
    cycleInterval: measureFromWire(raw.repeatCycle),
    cycleCount: getCourseCycleCount(raw),
    safety: safetyFromWire(retainedSafety ? retainedSafety.course : raw.safety, true),
    contextIssue: raw.step ? getCourseContextIssue(raw as FhirR6DosageInstruction) : undefined,
    provenance: { format: "r6", data: record(retainedSafety
      ? { ...raw, safety: retainedSafety.course } : raw) },
  };
  if (stages.length) course.provenance!.sourceTextVerified = false;
  // No defensive copy. Re-reading an externally changed FHIR input should
  // still observe its current fields, while ordinary callers leave it alone.
  return course;
}
/** Reconciliation is solely an R5 import concern, never part of native
 * course execution. A simple scalar needs no course reconstruction. */
export function isR6DosageInstruction(input: object): input is FhirR6DosageInstructionInput {
  if ("step" in input || "renderedInstruction" in input || "_renderedInstruction" in input || "repeatCycle" in input) return true;
  // Header-only R6 instructions may carry just safety or known R6 source.
  // An extended R5 dosage still owns its explicit dosage fields.
  if ("text" in input || "sequence" in input || "doseAndRate" in input || "timing" in input ||
      "route" in input || "site" in input || "method" in input || "condition" in input ||
      "asNeeded" in input || "asNeededFor" in input || "additionalInstruction" in input ||
      "patientInstruction" in input || "maxDosePerPeriod" in input ||
      "maxDosePerAdministration" in input || "maxDosePerLifetime" in input) return false;
  if ("safety" in input || getCourseCycleCount(input as FhirR6DosageInstruction) !== undefined) return true;
  for (const marker of (input as FhirR6DosageInstruction).extension ?? []) {
    if (marker.url === R6_DRAFT_STEPS_SOURCE_URL || marker.url === R6_SINGLE_STEP_SAFETY_SOURCE_URL) return true;
    if (marker.url === DOSAGE_RECONCILIATION_SOURCE_URL && marker.extension?.some(child =>
        child.url === R6_DRAFT_STEPS_SOURCE_URL || child.url === R6_SINGLE_STEP_SAFETY_SOURCE_URL)) return true;
  }
  return false;
}
export function inputToCanonical(
  input:
    | FhirDosage
    | readonly FhirDosage[]
    | FhirR6DosageInstructionInput
    | ParseBatchResult
    | CanonicalScheduleInput
): CanonicalScheduleInput {
  if (input && !Array.isArray(input)) {
    if ("kind" in input && (input.kind === "course" || input.kind === "administration"))
      return input as CanonicalCourse | CanonicalAdministration;
    if ("items" in input) return input.meta.canonical.course ?? courseFromR6(input.fhirNext);
    if (isR6DosageInstruction(input)) return courseFromR6(input);
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
    else if (b.anchor === "previous-phase-next-day" || b.anchor === "treatment-day-start")
      output.contextCode = {
        coding: [{ system: COURSE_PHASE_EVENT_SYSTEM, code: b.anchor }],
      };
  }
  // Understood external anchor types stay typed, including in native edits.
  // These are preserved but not considered executable without an event/source resolver.
  if (b.anchor !== "treatment-start" && b.anchor !== "treatment-day-start" && b.anchor !== "previous-phase-next-day") {
    assign(output, "contextReference", b.anchor === "resource-reference" ? b.contextReference : undefined);
    assign(output, "contextDefinition", b.anchor === "definition" ? b.contextDefinition : undefined);
    assign(output, "contextPath",
      b.anchor === "path" || b.anchor === "resource-reference" || b.anchor === "definition"
        ? b.contextPath : undefined);
    assign(output, "contextCode", b.contextCode);
  }
  assign(output, "text", b.description);
  assign(output, "offsetDuration", quantityForR6(b.displacement));
  assign(output, "offsetRange", b.displacementRange ? serializeRange(b.displacementRange) : undefined);
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
    const duration = target === "r5" ? generalQuantityForR5(r.courseLength) : quantityForR6(r.courseLength);
    const lengthRange = r.courseLengthRange ? serializeRange(r.courseLengthRange) : undefined;
    const start = target === "r6" ? simpleQuantityForR5(r.startOffset) : undefined;
    const end = target === "r6" ? simpleQuantityForR5(r.endOffset) : undefined;
    // Clinical zero frequency and signed/fractional offsets are carried by
    // their typed extensions. Reuse and reconstruction must compare the same
    // positiveInt/unsignedInt-compatible wire values.
    const frequency = r.frequency === 0 ? undefined : r.frequency;
    // A qualified duration stays in its typed timing marker or carrier rate
    // denominator; Timing.duration must not assert false exactness.
    const markerDuration = r.occurrenceDurationComparator || r.occurrenceDurationRange;
    // Numeric presence from an unresolved marker must not create a unitless
    // core duration. Keep its authored marker and any independent core fields.
    const unresolvedMarkerDuration = r.occurrenceDuration !== undefined &&
      r.occurrenceDurationUnit === undefined && prior?.duration === undefined;
    const occurrenceDuration = markerDuration ? undefined :
      unresolvedMarkerDuration ? prior?.duration : r.occurrenceDuration;
    const occurrenceDurationMax = markerDuration ? undefined :
      unresolvedMarkerDuration ? prior?.durationMax : r.occurrenceDurationMax;
    const occurrenceDurationUnit = markerDuration ? undefined :
      unresolvedMarkerDuration ? prior?.durationUnit : r.occurrenceDurationUnit;
    const offset = r.offset !== undefined && r.offset >= 0 && Number.isInteger(r.offset)
      ? r.offset : undefined;
    // Imported native facts are immutable; retain the original primitive slots
    // and their annotations just as the event projection does below.
    const dayOfWeek = prior?.dayOfWeek ?? r.dayOfWeek;
    const when = prior?.when ?? r.anchors;
    if (
      prior &&
      prior.count === r.count &&
      prior.countMax === r.countMax &&
      prior.frequency === frequency &&
      prior.frequencyMax === r.frequencyMax &&
      prior.period === r.period &&
      prior.periodMax === r.periodMax &&
      prior.periodUnit === r.periodUnit &&
      prior.dayOfWeek === dayOfWeek &&
      prior.offset === offset &&
      prior.duration === occurrenceDuration &&
      prior.durationMax === occurrenceDurationMax &&
      prior.durationUnit === occurrenceDurationUnit &&
      prior.boundsDuration === duration &&
      prior.boundsRange === lengthRange &&
      prior.boundsPeriod === r.calendarWindow &&
      prior.when === when &&
      prior.timeOfDay === r.clocks &&
      prior.startOffset === start &&
      prior.endOffset === end
    )
      repeat = prior;
    else {
      const value: Record<string, unknown> = Object.assign({}, r.provenance);
      assign(value, "count", r.count);
      assign(value, "countMax", r.countMax);
      assign(value, "frequency", frequency);
      assign(value, "frequencyMax", r.frequencyMax);
      assign(value, "period", r.period);
      assign(value, "periodMax", r.periodMax);
      assign(value, "periodUnit", r.periodUnit);
      assign(value, "dayOfWeek", dayOfWeek);
      assign(value, "offset", offset);
      assign(value, "duration", occurrenceDuration);
      assign(value, "durationMax", occurrenceDurationMax);
      assign(value, "durationUnit", occurrenceDurationUnit);
      assign(value, "boundsDuration", duration);
      assign(value, "boundsRange", lengthRange);
      assign(value, "boundsPeriod", r.calendarWindow);
      assign(value, "when", when);
      assign(value, "timeOfDay", r.clocks);
      assign(value, "startOffset", start);
      assign(value, "endOffset", end);
      repeat = value;
    }
  }
  // Import has already separated executable values from metadata-only wire
  // positions. The immutable native timing keeps its imported event projection.
  const events = original?.event ?? t.explicitEvents;
  if (
    original &&
    original.event === events &&
    original.code === t.code &&
    original.repeat === repeat
  )
    return original;
  const output: Record<string, unknown> = Object.assign({}, t.provenance);
  assign(output, "event", events);
  // Primitive annotations retain their external FHIR positions. Native facts
  // are internal immutable values, not an editing API that infers event identity.
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
  if (!a.provenance || a.provenance.format === "syntax") return target;
  const fromR6 = a.provenance.format === "r6";
  const raw = a.provenance.data as FhirR6Dosage;
  const live = a.schedule?.recurrence;
  const original = raw.timing?.repeat;
  // The R5 boundary normally owns its annotations. Surviving duration
  // markers and superseded exact offsets still need shared reconciliation.
  if (!fromR6 && !original?.extension?.length) return target;
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
  const durationMarker = original?.extension?.find(item => item.url === TIMING_ADMINISTRATION_DURATION_EXTENSION_URL);
  const duration = parseTimingAdministrationDuration(durationMarker);
  const durationChanged = duration && (duration.value !== live?.occurrenceDuration ||
    duration.unit !== live?.occurrenceDurationUnit || duration.comparator !== live?.occurrenceDurationComparator ||
    !same(duration.range, live?.occurrenceDurationRange));
  const exactOffset = original?.offset !== undefined
    ? original.extension?.find(item => item.url === TIMING_OFFSET_EXACT_EXTENSION_URL) : undefined;
  const supersededOffset = exactOffset &&
    getExactTimingOffsetMinutes({ extension: [exactOffset] }) !== original?.offset;
  const frequencyMinimum = original?.extension?.find(item => item.url === TIMING_FREQUENCY_MIN_EXTENSION_URL);
  const supersededMinimum = frequencyMinimum?.valueInteger === 0 && live?.frequency !== 0;
  if (!fromR6 && !durationChanged && !supersededOffset && !supersededMinimum) return target;
  const oldMarkers = original ? { extension: original.extension, offset: original.offset } : undefined;
  const changes = new Set<string>();
  if (supersededOffset) {
    changes.add(TIMING_OFFSET_EXACT_EXTENSION_URL);
    output.extension = [...((output.extension as FhirExtension[] | undefined) ?? []),
      { url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [exactOffset] }];
  }
  if (supersededMinimum) {
    changes.add(TIMING_FREQUENCY_MIN_EXTENSION_URL);
    output.extension = [...((output.extension as FhirExtension[] | undefined) ?? []),
      { url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [frequencyMinimum!] }];
  }
  const changed = (url: string, before: unknown, after: unknown) => {
    if (!same(before, after)) changes.add(url);
  };
  if (durationChanged) {
    changes.add(TIMING_ADMINISTRATION_DURATION_EXTENSION_URL);
    output.extension = [...((output.extension as FhirExtension[] | undefined) ?? []),
      { url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [durationMarker!] }];
  }
  const administrationChanges = new Set<string>();
  if (fromR6) {
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
      frequencyMinimum?.valueInteger === 0,
      live?.frequency === 0
    );
    if (!same(getAdministrationOffsetMinutes(raw as FhirDosage), a.delayMinutes))
      administrationChanges.add(ADMINISTRATION_OFFSET_EXTENSION_URL);
    const oldLength = getAnchoredCourseDuration(raw);
    if (
      // Active bounds own duration projection reconciliation below. In particular,
      // do not discard an old projected-range wrapper before retaining its ID and
      // annotations alongside the recovered authored endpoints.
      !target?.repeat?.boundsRange && !target?.repeat?.boundsDuration &&
      !same(
        oldLength
          ? { quantity: measureFromWire(oldLength.valueQuantity), range: rangeFromFhir(oldLength.valueRange) }
          : undefined,
        a.anchoredLength
      )
    )
      administrationChanges.add(ANCHORED_COURSE_DURATION_EXTENSION_URL);
  }
  if (!changes.size && !administrationChanges.size) return target;
  const generated = serializeCanonicalSchedule(clauseForAdministration(a).schedule);
  if (durationMarker && changes.has(TIMING_ADMINISTRATION_DURATION_EXTENSION_URL)) {
    const marker = generated.timing?.repeat?.extension?.find(item =>
      item.url === TIMING_ADMINISTRATION_DURATION_EXTENSION_URL);
    if (marker) {
      // The current endpoint changes its value, not the identity or unrelated
      // annotations of the timing marker that contains it.
      const { valueQuantity: _quantity, valueRange: _range, ...metadata } = durationMarker;
      Object.assign(marker, metadata);
    }
  }
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
interface SelectedR5Maximum { quantity: CanonicalMeasure; exact: boolean; index?: number }
export interface R5MaximumSelection extends SelectedR5Maximum {
  groups?: Map<string, SelectedR5Maximum>;
}
function sameMaximumUnit(left: CanonicalMeasure, right: CanonicalMeasure): boolean {
  return left.system && left.code && right.system && right.code
    ? left.system === right.system && left.code === right.code
    : left.unit !== undefined && left.unit === right.unit &&
      left.system === right.system && left.code === right.code;
}
function unitKeyPart(value: string | undefined): string {
  return value === undefined ? "-" : value.length + ":" + value;
}
function maximumUnitKey(quantity: CanonicalMeasure, exact: boolean): string | undefined {
  const unit = quantity.system && quantity.code
    ? "c" + unitKeyPart(quantity.system) + unitKeyPart(quantity.code)
    : quantity.unit !== undefined
      ? "u" + unitKeyPart(quantity.system) + unitKeyPart(quantity.code) + unitKeyPart(quantity.unit)
      : undefined;
  return unit === undefined ? undefined : (exact ? "e" : "q") + unit;
}
/** One selection pass for writing R5 maxima and identifying their editable
 * source positions. Equal values retain the last annotated owner. Interleaved
 * exact units allocate a map; same-unit ceilings and qualified-only lists keep
 * scalar state. Operators are observed once, never compared or normalized. */
export function selectR5Maximum(
  current: R5MaximumSelection | undefined, quantity: CanonicalMeasure, index?: number
): R5MaximumSelection {
  const exact = quantity.value !== undefined && !getQuantityComparator(quantity);
  // A qualified sibling remains in the complete safety bridge. It cannot
  // replace an available exact ceiling in R5's singular maximum field.
  if (!current || exact && !current.exact) return { quantity, exact, index };
  if (!exact) {
    if (!current.exact) { current.quantity = quantity; current.index = index; }
    return current;
  }
  if (!current.groups && current.exact === exact && sameMaximumUnit(current.quantity, quantity)) {
    if (!exact || current.quantity.value! >= quantity.value!) {
      current.quantity = quantity;
      current.index = index;
    }
    return current;
  }
  if (!current.groups) {
    current.groups = new Map();
    const previousKey = maximumUnitKey(current.quantity, current.exact);
    if (previousKey !== undefined)
      current.groups.set(previousKey, { quantity: current.quantity, exact: current.exact, index: current.index });
  }
  const key = maximumUnitKey(quantity, exact);
  const previous = key === undefined ? undefined : current.groups.get(key);
  if (previous && exact && previous.quantity.value! < quantity.value!) {
    current.quantity = previous.quantity;
    current.exact = previous.exact;
    current.index = previous.index;
  } else {
    current.quantity = quantity;
    current.exact = exact;
    current.index = index;
    if (previous) { previous.quantity = quantity; previous.index = index; }
    else if (key !== undefined) current.groups.set(key, { quantity, exact, index });
  }
  return current;
}

/** Shared wire serializer for current maxima and retained R5 edit baselines. */
export function periodMaximumToR5(amount: CanonicalMeasure, period: CanonicalMeasure, source?: object): FhirRatio {
  const { scope: _scope, valueQuantity: _amount, valueInteger: _count, _valueInteger: _countMetadata,
    valueExpression: _expression, period: _period, text: _text,
    numerator: _numerator, denominator: _denominator, ...metadata
  } = (source ?? {}) as Record<string, unknown>;
  return { ...metadata, numerator: generalQuantityForR5(amount), denominator: simpleQuantityForR5(period) };
}

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
  const scheduleMetadata = clause ? serializeCanonicalSchedule(clause.schedule, options, clause.clinicalQuantity) : undefined;
  const output: Record<string, unknown> = clause
    ? Object.assign({}, context)
    : Object.assign({}, a.provenance?.data, a.provenance?.retained);
  const source =
    a.provenance?.format === "r6"
      ? (a.provenance.data as FhirR6Dosage)
      : a.provenance?.retained ?? (a.provenance?.data as EzDosage | undefined);
  // Keep the authored R5 sequence when grouping uses a one-based ordinal.
  // A live row edit supersedes its prior sequence carrier.
  if (a.provenance?.format === "r5") {
    const sequence = (a.provenance.data as FhirDosage).sequence;
    const normalized = sequence !== undefined && (!Number.isInteger(sequence) || sequence < 1);
    const extensions = output.extension as FhirExtension[] | undefined;
    const retained = extensions?.find(item => item.url === DOSAGE_RETAINED_R5_SEQUENCE_URL);
    if (normalized ? retained?.valueDecimal !== sequence : retained !== undefined) {
      const next = extensions?.filter(item => item !== retained) ?? [];
      if (retained) next.push({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [retained] });
      if (normalized) next.push({ ...retained, url: DOSAGE_RETAINED_R5_SEQUENCE_URL, valueDecimal: sequence });
      assign(output, "extension", next.length ? next : undefined);
    }
  }
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
  if (wireTiming?.repeat && a.schedule?.recurrence?.clocks !== undefined) {
    const sourceRepeat = (a.provenance?.data as FhirDosage | FhirR6Dosage | undefined)?.timing?.repeat;
    const repeat = projectTimingClocks(wireTiming.repeat, sourceRepeat, target);
    if (repeat !== wireTiming.repeat) wireTiming = { ...wireTiming, repeat };
  }
  const currentRange = wireTiming?.repeat?.boundsRange ??
    (a.anchoredLength?.range ? serializeRange(a.anchoredLength.range, Boolean(clause)) : undefined);
  const modifiers = output.modifierExtension as FhirExtension[] | undefined;
  const oldDuration = modifiers?.find(item => item.url === ANCHORED_COURSE_DURATION_EXTENSION_URL);
  const projection = currentRange ? projectCourseDurationRange(currentRange) : undefined;
  if (projection?.source || oldDuration && (wireTiming?.repeat?.boundsRange || wireTiming?.repeat?.boundsDuration) ||
      oldDuration?.extension?.some(child => child.url === "projectedRange") ||
      (a.anchoredLength?.range || a.anchoredLength?.quantity) && !oldDuration) {
    const replacement: FhirExtension | undefined = projection?.source
      ? { ...projection.source, extension: wireTiming?.repeat?.boundsRange ? projection.source.extension :
          projection.source.extension!.filter(child => child.url !== "projectedRange") }
      : a.anchoredLength?.range && projection
        ? { url: ANCHORED_COURSE_DURATION_EXTENSION_URL, valueRange: projection.range }
        : a.anchoredLength?.quantity
          ? { url: ANCHORED_COURSE_DURATION_EXTENSION_URL,
              valueQuantity: generalQuantityForR5(clause ? serializeDuration(a.anchoredLength.quantity) : a.anchoredLength.quantity) }
          : undefined;
    const next = modifiers?.filter(item => item !== oldDuration) ?? [];
    if (replacement) {
      const { valueRange: _oldRange, valueQuantity: _oldQuantity, extension: priorChildren, ...metadata } = oldDuration ?? {};
      const unknown = priorChildren?.filter(child => child.url !== "low" && child.url !== "high" &&
        child.url !== "projectedRange" && child.url !== "rangeMetadata");
      next.push({ ...metadata, ...replacement,
        ...(replacement.extension && unknown?.length
          ? { extension: [...replacement.extension, ...unknown] } : {}) });
    } else if (oldDuration) output.extension = [...((output.extension as FhirExtension[] | undefined) ?? []),
      { url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [oldDuration] }];
    assign(output, "modifierExtension", next.length ? next : undefined);
  }
  if (projection && wireTiming?.repeat?.boundsRange && projection.range !== currentRange)
    wireTiming = { ...wireTiming, repeat: { ...wireTiming.repeat, boundsRange: projection.range } };
  assign(output, "timing", wireTiming);
  assign(output, "text", a.text);
  assign(output, "patientInstruction", a.patientInstruction);
  if (!clause) {
    assign(output, "route", a.route);
    assign(output, "method", a.method);
  }
  // Native instruction edits control the list even when the original grammar
  // remains available as evidence. Reuse only generated element annotations,
  // never source-only instructions that a clinician removed or replaced.
  let additionalInstructions = a.additionalInstructions;
  if (clause && context?.additionalInstruction && additionalInstructions) {
    let generatedIndex = 0;
    additionalInstructions = additionalInstructions.map((instruction) => {
      const metadata = instruction.text?.trim() ? context.additionalInstruction?.[generatedIndex++] : undefined;
      const projected: Record<string, unknown> = { ...metadata, ...instruction };
      assign(projected, "text", instruction.text);
      assign(projected, "coding", instruction.coding);
      return projected;
    });
  }
  assign(output, "additionalInstruction", additionalInstructions);
  // A supplied indication already expresses PRN meaning. Keep an absent
  // external boolean absent while execution consumes the typed native fact.
  assign(output, "asNeeded", a.asNeeded === true && source?.asNeeded === undefined &&
    source?.asNeededFor?.length ? undefined : a.asNeeded);
  assign(
    output,
    "doseAndRate",
    a.amounts?.map((value) => {
      const original = value.provenance as NonNullable<FhirR6Dosage["doseAndRate"]>[number] | undefined;
      const externalR5 = target === "r6" && a.provenance?.format === "r5";
      const doseConflict = externalR5 && (value.quantity !== undefined
        ? value.range !== undefined || value.expression !== undefined
        : value.range !== undefined && value.expression !== undefined);
      const rateConflict = externalR5 && (value.rate !== undefined
        ? value.rateRange !== undefined || value.rateRatio !== undefined || value.rateExpression !== undefined
        : value.rateRange !== undefined
          ? value.rateRatio !== undefined || value.rateExpression !== undefined
          : value.rateRatio !== undefined && value.rateExpression !== undefined);
      if (
        !doseConflict && !rateConflict && !clause &&
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
          ? !Object.prototype.hasOwnProperty.call(original, "modifierExtension") &&
            !(value.rateRatio?.numerator?.comparator && original.rateRatio?.numerator?.extension?.length)
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
            !Object.prototype.hasOwnProperty.call(original, "modifierExtension"))
      )
        return original;
      const rate = Object.assign({}, value.provenance);
      // Both strict doseAndRate slots are Element. Keep editable modifier
      // children in their existing extension wrapper in either wire version.
      projectR6ModifierWrapper(rate, R5_RATE_MODIFIERS_R6_URL);
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
        simpleQuantityForR5(code(value.quantity))
      );
      assign(
        rate,
        "doseRange",
        value.range && serializeRange(value.range, false, Boolean(clause))
      );
      assign(rate, "doseExpression", target === "r6" ? value.expression : undefined);
      assign(
        rate,
        "rateQuantity",
        simpleQuantityForR5(code(value.rate))
      );
      assign(
        rate,
        "rateRange",
        value.rateRange && serializeRange(value.rateRange)
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
                    : quantityForR6(code(value.rateRatio.numerator)),
              }
            : {}),
          ...(value.rateRatio.denominator
            ? {
                denominator:
                  simpleQuantityForR5(code(value.rateRatio.denominator)),
              }
            : {}),
        }
      );
      assign(rate, "rateExpression", target === "r6" ? value.rateExpression : undefined);
      assign(rate, "type", value.role);
      if (doseConflict || rateConflict) retainConflictingAmountChoices(rate, doseConflict, rateConflict);
      if (target === "r5" && (value.expression || value.rateExpression) &&
          Object.keys(rate).every(key => key === "id" || rate[key] === undefined ||
            (Array.isArray(rate[key]) && !(rate[key] as unknown[]).length)))
        rate.extension = [{ url: R5_EXPRESSION_SLOT_SOURCE_URL, extension: [
          ...(value.expression ? [{ url: "doseExpression", valueExpression: value.expression }] : []),
          ...(value.rateExpression ? [{ url: "rateExpression", valueExpression: value.rateExpression }] : [])
        ] }];
      return rate;
    })
  );
  const oldSite = a.provenance?.format === "r6" ? (output.site as object) : a.provenance?.retained?.site;
  let concept: FhirCodeableConcept | undefined = clause ? context?.site : a.target;
  if (!clause && a.targetCount !== getBodySiteAdministrationTargetCount(concept)) {
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
  // A retained R6 delta is sparse; unrelated live lifted R5 fields remain
  // authoritative. In particular, a safety-only delta must not hide the
  // original authored condition coding/text on the R5 row.
  const sourceRow = a.provenance?.format === "r5" ? a.provenance.data as EzDosage : undefined;
  const conditionSource = sourceRow?.condition !== undefined ? sourceRow : source;
  const sourceCondition = conditionSource ? getDosageCondition(conditionSource as EzDosage) : undefined;
  if (conditionSource?.condition?.length === 0 && output.modifierExtension) {
    const kept: FhirExtension[] = [], retired: FhirExtension[] = [];
    for (const marker of output.modifierExtension as FhirExtension[])
      (marker.url === DOSAGE_CONDITION_R5_URL ? retired : kept).push(marker);
    if (retired.length) {
      assign(output, "modifierExtension", kept.length ? kept : undefined);
      output.extension = [...((output.extension as FhirExtension[] | undefined) ?? []),
        { url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: retired }];
    }
  }
  if (target === "r5") {
    delete output.condition;
    if (a.predicate || sourceCondition || conditionSource?.condition !== undefined ||
        sourceRow?.modifierExtension?.some(item => item.url === DOSAGE_CONDITION_R5_URL))
      setDosageCondition(output as FhirDosage, a.predicate, a.calendarPredicate);
  } else {
    // An R5 source may carry only a modifier predicate. Equal clinical
    // predicates do not imply that a native condition array already exists.
    // Preserve real native source arrays, otherwise write the known predicate.
    assign(
      output,
      "condition",
      conditionSource?.condition?.length && same(sourceCondition, a.predicate)
        ? conditionSource.condition.map(condition => {
            const valueQuantity = quantityForR6(condition.valueQuantity);
            return valueQuantity === condition.valueQuantity ? condition : { ...condition, valueQuantity };
          })
        : a.predicate
        ? [conditionToR6(a.predicate)]
        : undefined
    );
  }
  // A producer may leave unequal member delays after lifting the common
  // stage start. Emit that current native fact even without a syntax view.
  const previousDelay = getAdministrationOffsetMinutes(output as FhirDosage);
  if (previousDelay !== a.delayMinutes) {
    const previous = (output.modifierExtension as FhirExtension[] | undefined) ?? [];
    const marker = previous.find(item => item.url === ADMINISTRATION_OFFSET_EXTENSION_URL);
    const modifiers = previous.filter(item => item !== marker);
    if (a.delayMinutes !== undefined) modifiers.push({
      ...marker, url: ADMINISTRATION_OFFSET_EXTENSION_URL,
      valueQuantity: { ...marker?.valueQuantity, value: a.delayMinutes,
        unit: "minutes", system: "http://unitsofmeasure.org", code: "min" },
    });
    else if (marker) output.extension = [...((output.extension as FhirExtension[] | undefined) ?? []),
      { url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [marker] }];
    assign(output, "modifierExtension", modifiers.length ? modifiers : undefined);
  }
  if (a.calendarPredicate) setDosageCondition(output as FhirDosage, a.predicate, a.calendarPredicate);
  if (
    a.excludedDates?.length ||
    (output.modifierExtension && !same(getDosageExcludedDates({
      modifierExtension: output.modifierExtension as FhirExtension[],
    }), a.excludedDates ?? []))
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
  if (a.cycleDays || (source && getCycleDayConstraint(source as FhirDosage))) {
    const previous = output.modifierExtension as FhirDosage["modifierExtension"];
    let found = false;
    const modifiers: FhirExtension[] = [];
    for (const marker of previous ?? []) {
      if (marker.url !== CYCLE_DAY_ELIGIBILITY_EXTENSION_URL) modifiers.push(marker);
      else if (!found) {
        found = true;
        if (a.cycleDays) modifiers.push(cycleDayConstraintExtension(a.cycleDays, marker));
      }
    }
    if (!found && a.cycleDays) modifiers.push(cycleDayConstraintExtension(a.cycleDays));
    output.modifierExtension = modifiers.length ? modifiers : undefined;
  }
  const phaseParticipant = a.phasePredecessors !== undefined && a.sourceMember !== undefined;
  if (
    a.phaseOrigin || a.phaseStart || a.phaseEnd || phaseParticipant ||
    (source &&
      !a.phaseOriginIssue &&
      source.modifierExtension?.some((e) => e.url === PARALLEL_COMPONENT_PHASE_ORIGIN_URL))
  ) {
    const existing = (output.modifierExtension as FhirDosage["modifierExtension"]) ?? [];
    const withPhaseIdentity = (marker: FhirExtension): FhirExtension => {
      if (!phaseParticipant) return marker;
      const children = marker.extension ?? [];
      const identity = children.find(child => child.url === "sourceMember");
      const predecessors = children.filter(child => child.url === "predecessor");
      if (identity?.valueInteger === a.sourceMember && predecessors.length === a.phasePredecessors!.length &&
          predecessors.every((child, index) => child.valueInteger === a.phasePredecessors![index])) return marker;
      const retained = children.filter(child => child.url !== "sourceMember" && child.url !== "predecessor");
      retained.push({ ...identity, url: "sourceMember", valueInteger: a.sourceMember });
      for (let index = 0; index < a.phasePredecessors!.length; index++)
        retained.push({ ...predecessors[index], url: "predecessor", valueInteger: a.phasePredecessors![index] });
      return { ...marker, extension: retained };
    };
    const phaseOrigin = simpleQuantityForR5(a.phaseOrigin);
    // A member interval uses the existing relative step fields. Convert its
    // scalar origin to the equivalent start when an end or a newly generated
    // dependency identity needs children. Preserve imported legacy scalar markers.
    const phaseStart = a.phaseStart ? boundaryToWire(a.phaseStart)
      : (a.phaseEnd || phaseParticipant && !source) && a.phaseOrigin
        ? boundaryToWire({ anchor: "treatment-start", displacement: a.phaseOrigin }) : undefined;
    const phaseEnd = a.phaseEnd ? boundaryToWire(a.phaseEnd) : undefined;
    let generatedInterval: FhirExtension | undefined;
    let found = false;
    let changed: FhirExtension[] | undefined;
    for (let index = 0; index < existing.length; index++) {
      const marker = existing[index];
      if (marker.url !== PARALLEL_COMPONENT_PHASE_ORIGIN_URL) {
        if (changed) changed.push(marker);
        continue;
      }
      found = true;
      let replacement: FhirExtension | undefined;
      if (phaseStart || phaseEnd) {
        const previous = marker.valueQuantity ? undefined : decodeR6SourceMetadata(marker, "step");
        if (equalStructuredValues(previous?.start, phaseStart) && equalStructuredValues(previous?.end, phaseEnd))
          replacement = marker;
        else {
          generatedInterval ??= encodeR6SourceMetadata(PARALLEL_COMPONENT_PHASE_ORIGIN_URL,
            { ...(phaseStart ? { start: phaseStart } : {}), ...(phaseEnd ? { end: phaseEnd } : {}) }, "step");
          const { valueQuantity: _oldOrigin, extension: children, ...metadata } = marker;
          let previousStart: FhirExtension | undefined, previousEnd: FhirExtension | undefined;
          const retained: FhirExtension[] = [];
          for (const child of children ?? []) {
            if (child.url === "start") previousStart ??= child;
            else if (child.url === "end") previousEnd ??= child;
            else retained.push(child);
          }
          const current: FhirExtension[] = [];
          for (const child of generatedInterval.extension ?? [])
            current.push({ ...(child.url === "start" ? previousStart : previousEnd), ...child });
          replacement = { ...metadata, extension: [...current, ...retained] };
        }
      } else if (phaseOrigin) {
        if (marker.valueQuantity === phaseOrigin) replacement = marker;
        else {
          const { extension: children, ...metadata } = marker;
          replacement = { ...metadata, valueQuantity: phaseOrigin };
          if (children?.length) output.extension = [...((output.extension as FhirExtension[] | undefined) ?? []),
            { url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [marker] }];
        }
      } else if (phaseParticipant) {
        const { valueQuantity: _oldOrigin, ...metadata } = marker;
        replacement = { ...metadata, extension: marker.extension?.filter(child => child.url !== "start" && child.url !== "end") };
      }
      if (replacement) replacement = withPhaseIdentity(replacement);
      if (replacement !== marker && !changed) changed = existing.slice(0, index);
      if (changed && replacement) changed.push(replacement);
    }
    if (!found && (phaseOrigin || phaseStart || phaseEnd || phaseParticipant))
      (changed ??= existing.slice()).push(withPhaseIdentity(phaseStart || phaseEnd
        ? generatedInterval ?? encodeR6SourceMetadata(PARALLEL_COMPONENT_PHASE_ORIGIN_URL,
          { ...(phaseStart ? { start: phaseStart } : {}), ...(phaseEnd ? { end: phaseEnd } : {}) }, "step")
        : phaseOrigin ? { url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL, valueQuantity: phaseOrigin }
        : { url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL }));
    if (changed) assign(output, "modifierExtension", changed.length ? changed : undefined);
  }
  // Whole-course display baselines belong to the FINAL output, never to
  // a projected component copied from an earlier edited source. Remove only
  // recognized old baselines; native course provenance retains their history.
  const priorExtensions = output.extension as FhirExtension[] | undefined;
  if (priorExtensions) {
    let kept: FhirExtension[] | undefined;
    for (let i = 0; i < priorExtensions.length; i++) {
      const e = priorExtensions[i];
      if (isRenderedInstructionMarker(e) || isCompactSourceAgreementMarker(e)) {
        if (!kept) kept = priorExtensions.slice(0, i);
        if (hasUnrecognizedEditMetadata(e))
          kept.push({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [e] });
      } else if (kept) kept.push(e);
    }
    if (kept) assign(output, "extension", kept.length ? kept : undefined);
  }
  if (target === "r6") {
    const clocks = a.provenance?.sourceHasStructuredClocks ??
      (clause?.instructionGraph ? Boolean(a.schedule?.recurrence?.clocks?.length) : undefined);
    const events = a.provenance?.sourceHasStructuredEvents ??
      (clause?.instructionGraph ? Boolean(a.schedule?.recurrence?.anchors?.length) : undefined);
    const site = a.provenance?.sourceHasStructuredSite ??
      (clause?.instructionGraph ? Boolean(a.target || a.siteReference) : undefined);
    if (clocks !== undefined || events !== undefined || site !== undefined) {
      // Whole-text agreement is never inferred for an R6 import. Keep only
      // the primary-field evidence needed to distinguish a deletion from
      // an independent graph clock, event, or site after another external save.
      const fields: FhirExtension[] = [{ url: "sourceAgreement", valueBoolean: false }];
      if (clocks !== undefined) fields.push({ url: "sourceHasStructuredClocks", valueBoolean: clocks });
      if (events !== undefined) fields.push({ url: "sourceHasStructuredEvents", valueBoolean: events });
      if (site !== undefined) fields.push({ url: "sourceHasStructuredSite", valueBoolean: site });
      output.extension = [...((output.extension as FhirExtension[] | undefined) ?? []),
        { url: DOSAGE_RENDERED_INSTRUCTION_R5_URL, extension: fields }];
    }
  }
  const sourceMaxima = projectSourceMaxima(output, target);
  // No understood safety concept is serialized through a generic bag.
  // Unknown external annotations survive via the original wire provenance.
  if (target === "r6") {
    // Saved row-profile markers do not belong inside an emitted native R6
    // component. The importer already restored them into native facts.
    const oldModifiers = output.modifierExtension as FhirExtension[] | undefined;
    let contextMarker: FhirExtension | undefined, contextSources: FhirExtension[] | undefined;
    if (oldModifiers) {
      const kept: FhirExtension[] = [];
      for (const extension of oldModifiers) {
        if (extension.url === DOSAGE_DETAILS_R5_URL) {
          // R6's missing-context modifier can carry authored Element/child
          // annotations. R5 row codec markers retain their separate owner.
          if (a.provenance?.format === "r6" || a.provenance?.retained?.modifierExtension !== undefined) {
            if (!contextMarker) contextMarker = extension;
            else (contextSources ??= []).push(extension);
          }
          continue;
        }
        if (extension.url === DOSAGE_CONDITION_R5_URL) {
          const generatedPredicate = exactConditionBridgePredicate(extension);
          if (generatedPredicate && same(generatedPredicate, a.predicate)) continue;
          const nativeCondition = Boolean((output.condition as FhirR6Dosage["condition"])?.length);
          const ownsCondition = nativeCondition || conditionSource?.condition !== undefined;
          let predicate = false, calendar = false;
          for (const child of extension.extension ?? []) {
            if (child.url === "predicate") predicate = true;
            else if (child.url === "calendarDayPredicate") calendar = true;
          }
          // Once condition[] owns the predicate, an annotated R5 copy is
          // source, not a second active owner that can revive a later deletion.
          if (ownsCondition && predicate || !a.predicate && calendar && !predicate) {
            output.extension = [...((output.extension as FhirExtension[] | undefined) ?? []),
              { url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [extension] }];
            if (nativeCondition) {
              const children = extension.extension?.filter(child => child.url !== "predicate");
              if (children?.length) kept.push({ ...extension, extension: children });
            }
            continue;
          }
        }
        kept.push(extension);
      }
      assign(output, "modifierExtension", kept.length ? kept : undefined);
    }

    if (a.missingContexts?.length) {
      const reasons = new Map<string, boolean>();
      for (const reason of a.missingContexts) reasons.set(reason, false);
      const children: FhirExtension[] = [];
      for (const child of contextMarker?.extension ?? []) {
        if (child.url !== "missingContext") children.push(child);
        else if (child.valueString !== undefined && reasons.has(child.valueString)) {
          children.push(child);
          reasons.set(child.valueString, true);
        }
      }
      for (const [valueString, retained] of reasons)
        if (!retained) children.push({ url: "missingContext", valueString });
      output.modifierExtension = [
        ...((output.modifierExtension as FhirExtension[]) ?? []),
        { ...contextMarker, url: DOSAGE_DETAILS_R5_URL, extension: children },
      ];
    } else if (contextMarker) (contextSources ??= []).push(contextMarker);
    if (contextSources)
      output.extension = [...((output.extension as FhirExtension[] | undefined) ?? []),
        { url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: contextSources }];
    // The supported R5 alias has already supplied current asNeeded above.
    // It is not an active current-R6 field.
    delete output.asNeededBoolean;
    delete output.siteReference;
    delete output.excludedDates;
    delete output.maxDosePerPeriod;
    delete output.maxDosePerAdministration;
    delete output.maxDosePerLifetime;
    // An explicit native removal must not resurrect an imported clinical
    // doseLimit. But an ordinary dosage with no authored safety must not
    // grow a synthetic empty R6 safety policy merely because limits=undefined.
    // A sparse retained field (for example a reference-only site) does not
    // own a policy subsequently authored on the live editable R5 dosage.
    const safetySource = source?.safety ??
      (a.provenance?.format === "r5" ? (a.provenance.data as EzDosage).safety : undefined);
    const limits = a.limits ?? (safetySource?.doseLimit !== undefined ? [] : undefined);
    assign(output, "safety", safetyToWire(a.safety, safetySource, limits, Boolean(clause)));
  } else {
    delete output.excludedDates;
    delete output.safety;
    delete output.maxDosePerPeriod;
    delete output.maxDosePerAdministration;
    delete output.maxDosePerLifetime;
    let periodLimits = sourceMaxima;
    let administrationMaximum: R5MaximumSelection | undefined, lifetimeMaximum: R5MaximumSelection | undefined;
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
        (periodLimits ??= []).push(periodMaximumToR5(amount, period, limit.provenance));
      } else if (limit.scope === "administration")
        administrationMaximum = selectR5Maximum(administrationMaximum, amount);
      else if (limit.scope === "lifetime")
        lifetimeMaximum = selectR5Maximum(lifetimeMaximum, amount);
    }
    if (administrationMaximum) output.maxDosePerAdministration = simpleQuantityForR5(administrationMaximum.quantity);
    if (lifetimeMaximum) output.maxDosePerLifetime = simpleQuantityForR5(lifetimeMaximum.quantity);
    if (periodLimits) output.maxDosePerPeriod = periodLimits;
  }
  return output as FhirDosage | FhirR6Dosage;
}
/** Direct native-to-R6 component writer. */
/** Emit native R6 directly from modeled clinical facts. Shared serializers
 * encode vocabulary and grammar-source annotations only, never an R5 course. */
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
  const low = value.low ? q(value.low) : undefined;
  const high = value.high ? q(value.high) : undefined;
  if (duration && low && high && low.code === high.code && low.system === high.system)
    low.unit = high.unit;
  if (low === value.low && high === value.high) return value as FhirRange;
  return {
    ...value,
    ...(low ? { low } : {}),
    ...(high ? { high } : {}),
  } as FhirRange;
}
/** Header/step metadata is shared fragment serialization, NOT a course in
 * another external format. The R5 writer encodes it directly in R5 extensions. */
export function courseMetadataToWire(
  course: CanonicalCourse
): Omit<FhirR6DosageInstruction, "step" | "renderedInstruction"> {
  const out: Record<string, unknown> & { modifierExtension?: FhirExtension[] } =
    Object.assign({}, course.provenance?.data);
  delete out.step;
  delete out.renderedInstruction;
  assign(out, "repeatCycle", quantityForR6(course.cycleInterval));
  const displaced = setCourseCycleCount(out, course.cycleCount);
  if (displaced) out.extension = [...((out.extension as FhirExtension[] | undefined) ?? []),
    { url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: displaced }];
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
  let drafts: Array<{ index: number; step: Omit<FhirR6DosageStep, "component"> }> | undefined;
  let precedingDraftEnd: CanonicalBoundary | undefined;
  let synthesizedStarts: number[] | undefined;
  for (let index = 0; index < course.stages.length; index++) {
    const stage = course.stages[index];
    if (!stage.administrations.length) {
      (drafts ??= []).push({ index, step: stageMetadataToWire(stage) });
      precedingDraftEnd = stage.end ?? precedingDraftEnd;
      continue;
    }
    const component: FhirR6Dosage[] = [];
    for (const a of stage.administrations)
      component.push(administrationToR6(a, options, freshlyCompiled ? a.syntax : undefined));
    const metadata = stageMetadataToWire(stage);
    // An empty edited stage is retained as source, not an invalid active
    // component. Its authored end still anchors an implicit successor.
    if (!stage.start && precedingDraftEnd) {
      metadata.start = boundaryToWire(precedingDraftEnd);
      (synthesizedStarts ??= []).push(steps.length);
    }
    precedingDraftEnd = undefined;
    steps.push(Object.assign(metadata, { component }));
  }
  const result: FhirR6DosageInstruction = courseMetadataToWire(course);
  if (steps.length) result.step = steps;
  liftSingleStepSafety(result);
  if (drafts || result.extension?.length) retainDraftSteps(result, drafts, synthesizedStarts);
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

/** Source-only R6 instructions have no structured administration to preview.
 * A nonempty header on a structured import is original text, not evidence
 * that its dose/timing still agrees with the independently editable fields. */
export function unchangedR6SourceDisplay(
  raw: FhirR6DosageInstructionInput,
  options?: FormatOptions
): string | undefined {
  return raw.renderedInstruction && !raw.step?.length && !raw.repeatCycle &&
    !raw.safety?.doseLimit?.length && !raw.safety?.ifExceeded &&
    getCourseCycleCount(raw) === undefined &&
    !raw.extension?.some(item => item.url === R6_DRAFT_STEPS_SOURCE_URL) &&
    options?.realizationMode !== "normalized"
    ? raw.renderedInstruction : undefined;
}

/** Explicit editable import for applications that already hold R5 rows.
 * Import normalization and persistence reconciliation happen once here, not
 * inside any native edit, formatter, or execution operation. Metadata-only
 * R6 headers share R5's Element shape; use fromFhir for that known-R6 input. */
export function importCanonicalCourse(
  input: FhirDosage | readonly FhirDosage[] | FhirR6DosageInstructionInput | ParseBatchResult | CanonicalCourse
): CanonicalCourse {
  if (!Array.isArray(input)) {
    if ("kind" in input && input.kind === "course") return input;
    if ("items" in input && input.meta.canonical.course) return input.meta.canonical.course;
    if (isR6DosageInstruction(input)) return courseFromR6(input, true);
    if ("items" in input) return courseFromR6(input.fhirNext, true);
  }
  const rows = Array.isArray(input) ? (input as readonly FhirDosage[]) : [input as FhirDosage];
  return courseFromR5(rows, undefined, undefined, undefined, true);
}
