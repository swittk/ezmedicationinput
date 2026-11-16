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
  toDosageDetails,
  toFhirR5Dosages,
  DOSAGE_DETAILS_R5_URL,
  getDosageCondition,
  getDosageCalendarDayCondition,
  getDosageExcludedDates,
  getDosageExcludedWeekdays,
  getDosageAlternativeChoice,
  DOSAGE_ALTERNATIVE_CHOICE_URL,
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
import { getQuantityComparator, simpleQuantityForR5 } from "../fhir-quantity-operator";
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
function measure(q: FhirQuantity | FhirR6Quantity | undefined): CanonicalMeasure | undefined {
  if (!q) return undefined;
  const operator = getQuantityComparator(q);
  return operator && operator !== q.comparator ? { ...q, comparator: operator } : (q as CanonicalMeasure);
}
export function rangeFromFhir(r: FhirRange | undefined): CanonicalRange | undefined {
  return r
    ? { ...r, ...(r.low ? { low: measure(r.low) } : {}), ...(r.high ? { high: measure(r.high) } : {}) }
    : undefined;
}
function ratio(
  r: { numerator?: FhirQuantity | FhirR6Quantity; denominator?: FhirQuantity | FhirR6Quantity } | undefined
): CanonicalRatio | undefined {
  return r
    ? {
        ...r,
        ...(r.numerator ? { numerator: measure(r.numerator) } : {}),
        ...(r.denominator ? { denominator: measure(r.denominator) } : {}),
      }
    : undefined;
}
function offsetValue(repeat: { extension?: FhirExtension[] } | undefined, url: string): number | undefined {
  const value = repeat?.extension?.find((e) => e.url === url);
  return value?.valueInteger ?? value?.valueDecimal;
}
function timing(t: FhirTiming | FhirR6Timing | undefined): CanonicalTiming | undefined {
  if (!t) return undefined;
  const r = t.repeat;
  // All legacy marker readers below access only shared extension/offset fields.
  const markers = r ? { extension: r.extension, offset: r.offset } : undefined;
  return {
    code: t.code,
    explicitEvents: t.event,
    provenance: record(t),
    ...(r
      ? {
          recurrence: {
            count: r.count,
            countMax: r.countMax,
            frequency:
              markers?.extension?.find((e) => e.url === TIMING_FREQUENCY_MIN_EXTENSION_URL)?.valueInteger ??
              r.frequency,
            frequencyMax: r.frequencyMax,
            period: r.period,
            periodMax: r.periodMax,
            periodUnit: r.periodUnit,
            occurrenceDuration: r.duration,
            occurrenceDurationMax: r.durationMax,
            occurrenceDurationUnit: r.durationUnit,
            courseLength: measure(r.boundsDuration),
            courseLengthRange: rangeFromFhir(r.boundsRange),
            calendarWindow: r.boundsPeriod,
            clocks: r.timeOfDay,
            anchors: r.when,
            dayOfWeek: r.dayOfWeek,
            offset: getExactTimingOffsetMinutes(markers),
            offsetMin: offsetValue(markers, TIMING_OFFSET_MIN_EXTENSION_URL),
            offsetMax: offsetValue(markers, TIMING_OFFSET_MAX_EXTENSION_URL),
            monthDays: getTimingMonthDays(markers),
            weekdayOrdinal: getTimingWeekdayOrdinal(markers),
            activityTiming: parseActivityTimingExtensions(markers),
            occurrenceCap: getTimingOccurrenceCap(markers),
            clockWindow: getTimingClockWindow(markers),
            eventWindow: getTimingEventWindow(markers),
            startOffset: measure((r as NonNullable<FhirR6Timing["repeat"]>).startOffset),
            endOffset: measure((r as NonNullable<FhirR6Timing["repeat"]>).endOffset),
            provenance: record(r),
          },
        }
      : {}),
  };
}
export function boundaryFromR6(b: FhirR6RelativeTime | undefined): CanonicalBoundary | undefined {
  if (!b) return undefined;
  const recognized =
    !b.contextReference && !b.contextDefinition && !b.contextPath &&
    b.contextCode?.coding?.some((c) => c.system === TREATMENT_START_SYSTEM && c.code === "treatment-start");
  const anchor = recognized ? "treatment-start" : b.contextReference
    ? "resource-reference" : b.contextDefinition ? "definition"
    : b.contextPath ? "path" : b.contextCode ? "coded-event" : "unresolved";
  return {
    anchor,
    ...(b.contextReference ? { contextReference: b.contextReference } : {}),
    ...(b.contextDefinition ? { contextDefinition: b.contextDefinition } : {}),
    ...(b.contextPath ? { contextPath: b.contextPath } : {}),
    ...(b.contextCode && !recognized ? { contextCode: b.contextCode } : {}),
    description: b.text,
    displacement: measure(b.offsetDuration),
    displacementRange: rangeFromFhir(b.offsetRange),
    provenance: record(b),
  };
}
/** Every understood safety rule is typed. Unknown element metadata stays
 * only on the retained external source object, never in an executable bag. */
function safetyFromR6(
  safety: FhirR6DosageSafety | undefined, includeLimits = false
): CanonicalSafety | undefined {
  if (!safety) return undefined;
  return {
    ...(safety.ifExceeded !== undefined ? { ifExceeded: safety.ifExceeded } : {}),
    ...(includeLimits && safety.doseLimit ? { limits: safety.doseLimit.map(limit => ({
      scope: limit.scope,
      amount: measure(limit.valueQuantity),
      count: limit.valueInteger,
      expression: limit.valueExpression,
      period: measure(limit.period),
      text: limit.text,
      provenance: record(limit)
    })) } : {}),
    ...(safety.ifExceeded || safety.doseLimit?.some(limit =>
      limit.valueInteger !== undefined || limit.valueExpression !== undefined)
      ? { requiresReview: true } : {})
  };
}

/** Wire safety output owns coding/retained external metadata; clinical facts
 * own the live ifExceeded and limits. No generic internal safety fields leak. */
function safetyToR6(
  policy: CanonicalSafety | undefined,
  source: FhirR6DosageSafety | undefined,
  limits?: CanonicalDoseLimit[]
): FhirR6DosageSafety | undefined {
  if (!policy && limits === undefined) return undefined;
  const output: FhirR6DosageSafety = { ...source };
  if (policy) {
    if (policy.ifExceeded === undefined) delete output.ifExceeded;
    else output.ifExceeded = policy.ifExceeded;
  }
  const known = limits ?? policy?.limits;
  if (known !== undefined) {
    output.doseLimit = known.map(limit => {
      const saved = limit.provenance as FhirR6DoseLimit | undefined;
      // R6 value[x] is an exclusive choice: never resurrect a stale source
      // valueQuantity when an integer/expression was explicitly edited.
      const { valueQuantity: _oldQuantity, valueInteger: _oldCount,
        valueExpression: _oldExpression, ...metadata } = saved ?? {};
      const period = limit.period ? simpleQuantityForR5({
        ...limit.period,
        ...(!limit.period.system && !limit.period.code && isCalendarUnit(limit.period.unit)
          ? { system: "http://unitsofmeasure.org", code: limit.period.unit } : {})
      }) : undefined;
      const common = { ...metadata, scope: limit.scope, ...(period ? { period } : {}),
        ...(limit.text !== undefined ? { text: limit.text } : {}) };
      const amount = limit.amount;
      if (amount) return {
        ...common, valueQuantity: {
          ...amount, ...getStandardDoseUnitCoding(amount.unit),
          ...(amount.system ? { system: amount.system } : {}),
          ...(amount.code ? { code: amount.code } : {})
        }
      } satisfies FhirR6DoseLimit;
      if (limit.count !== undefined)
        return { ...common, valueInteger: limit.count } satisfies FhirR6DoseLimit;
      if (limit.expression)
        return { ...common, valueExpression: limit.expression } satisfies FhirR6DoseLimit;
      throw new TypeError("An authored safety limit must contain a numeric, count, or expression value");
    });
  }
  return output;
}
function amount(a: NonNullable<FhirR6Dosage["doseAndRate"]>[number]): CanonicalAmount {
  return {
    quantity: measure(a.doseQuantity),
    range: rangeFromFhir(a.doseRange),
    expression: a.doseExpression,
    rate: measure(a.rateQuantity),
    rateRange: rangeFromFhir(a.rateRange),
    rateRatio: ratio(a.rateRatio),
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
  // Extension readers are deliberately confined to this adapter. R6 condition
  // arrays already use the public native-condition branch of these readers.
  const input = raw as EzDosage;
  const target = format === "r6" ? (raw as FhirR6Dosage).site?.concept : input.site;
  let phaseOrigin: CanonicalMeasure | undefined,
    phaseOriginIssue = false,
    seenOrigin = false;
  for (const e of raw.modifierExtension ?? []) {
    if (e.url !== PARALLEL_COMPONENT_PHASE_ORIGIN_URL) continue;
    if (seenOrigin || !e.valueQuantity) phaseOriginIssue = true;
    seenOrigin = true;
    phaseOrigin = measure(e.valueQuantity);
  }
  const anchored = getAnchoredCourseDuration(raw);
  const choice = getDosageAlternativeChoice(raw);
  const maximums = format === "r5" ? input : undefined;
  return {
    kind: "administration",
    schedule: timing(raw.timing),
    ...(sourceContext
      ? {
          syntax: deserializeCanonicalContext({
            text: raw.text,
            extension: raw.extension,
            route: raw.route,
            site: target,
            method: raw.method,
            asNeeded: raw.asNeeded,
            asNeededFor: raw.asNeededFor,
            additionalInstruction: raw.additionalInstruction,
            patientInstruction: raw.patientInstruction,
          }),
        }
      : {}),
    amounts: raw.doseAndRate?.map((a) => amount(a as NonNullable<FhirR6Dosage["doseAndRate"]>[number])),
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
    predicate: getDosageCondition(input),
    calendarPredicate: getDosageCalendarDayCondition(input),
    excludedDates: getDosageExcludedDates(input),
    excludedWeekdays: getDosageExcludedWeekdays(input),
    ...(maximums &&
    (maximums.maxDosePerPeriod?.length || maximums.maxDosePerAdministration || maximums.maxDosePerLifetime)
      ? {
          limits: [
            ...(maximums.maxDosePerPeriod ?? []).map((limit) => ({
              scope: "period" as const,
              amount: measure(limit.numerator),
              period: measure(limit.denominator),
            })),
            ...(maximums.maxDosePerAdministration
              ? [{ scope: "administration" as const, amount: measure(maximums.maxDosePerAdministration) }]
              : []),
            ...(maximums.maxDosePerLifetime
              ? [{ scope: "lifetime" as const, amount: measure(maximums.maxDosePerLifetime) }]
              : []),
          ],
        }
      : {}),
    safety: safetyFromR6(input.safety),
    choice,
    choiceIssue: !choice && raw.modifierExtension?.some((e) => e.url === DOSAGE_ALTERNATIVE_CHOICE_URL),
    phaseOrigin,
    phaseOriginIssue,
    delayMinutes: getAdministrationOffsetMinutes(input),
    anchoredLength: anchored
      ? { quantity: measure(anchored.valueQuantity), range: rangeFromFhir(anchored.valueRange) }
      : undefined,
    cycleDays: getCycleDayConstraint(input),
    provenance: { format, data: record(raw) },
  };
}

/** Import one native R6 administration WITHOUT any R5 projection. */
export function administrationFromR6(raw: FhirR6Dosage, sourceContext = false): CanonicalAdministration {
  const result = baseAdministration(raw, "r6", sourceContext);
  if (raw.safety) {
    result.safety = safetyFromR6(raw.safety);
    result.limits = raw.safety.doseLimit?.map((limit) => ({
      scope: limit.scope,
      amount: measure(limit.valueQuantity),
      count: limit.valueInteger,
      expression: limit.valueExpression,
      period: measure(limit.period),
      text: limit.text,
      provenance: record(limit),
    }));
  }
  return result;
}
export function administrationFromR5(
  raw: FhirDosage | EzDosage,
  sourceContext = false
): CanonicalAdministration {
  return baseAdministration(raw, "r5", sourceContext);
}
export function courseFromR6(
  raw: FhirR6DosageInstruction,
  sourceContext = false
): CanonicalCourse {
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
      safety: safetyFromR6(step.safety, true),
      provenance: record(step),
    });
  }
  const course: CanonicalCourse = {
    kind: "course",
    stages,
    instruction: raw.renderedInstruction,
    cycleInterval: measure(raw.repeatCycle),
    safety: safetyFromR6(raw.safety, true),
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
      return courseFromR6(toDosageDetails(rows));
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
  if (raw.modifierExtension?.some((e) => e.url === DOSAGE_DETAILS_R5_URL))
    return courseFromR6(toDosageDetails([raw]));
  return administrationFromR5(raw);
}

/** Projection helpers always overwrite modeled clinical fields, including
 * deliberate clearing, while preserving unrelated external source fields. */
function assign(target: Record<string, unknown>, name: string, value: unknown): void {
  if (value === undefined) delete target[name];
  else target[name] = value;
}
function boundaryToR6(b: CanonicalBoundary | undefined): FhirR6RelativeTime | undefined {
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
        coding: [{ system: TREATMENT_START_SYSTEM, code: "treatment-start", display: "Start of Treatment" }]
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
function timingToR6(t: CanonicalTiming | undefined): FhirR6Timing | undefined {
  if (!t) return undefined;
  const output = { ...t.provenance };
  assign(output, "event", t.explicitEvents);
  assign(output, "code", t.code);
  if (!t.recurrence) delete output.repeat;
  else {
    const r = t.recurrence,
      repeat = { ...r.provenance };
    for (const name of [
      "count",
      "countMax",
      "frequency",
      "frequencyMax",
      "period",
      "periodMax",
      "periodUnit",
      "dayOfWeek",
      "offset",
      "startOffset",
      "endOffset",
    ] as const)
      assign(repeat, name, r[name]);
    assign(repeat, "duration", r.occurrenceDuration);
    assign(repeat, "durationMax", r.occurrenceDurationMax);
    assign(repeat, "durationUnit", r.occurrenceDurationUnit);
    assign(repeat, "boundsDuration", r.courseLength);
    assign(repeat, "boundsRange", r.courseLengthRange);
    assign(repeat, "boundsPeriod", r.calendarWindow);
    assign(repeat, "when", r.anchors);
    assign(repeat, "timeOfDay", r.clocks);
    // Current R6 offsets remain SimpleQuantity, not native Quantity.
    assign(repeat, "startOffset", simpleQuantityForR5(r.startOffset));
    assign(repeat, "endOffset", simpleQuantityForR5(r.endOffset));
    output.repeat = repeat;
  }
  return output as FhirR6Timing;
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
): void {
  if (!a.provenance || a.provenance.format !== "r6") return;
  const raw = a.provenance.data as FhirR6Dosage;
  const live = a.schedule?.recurrence;
  const original = raw.timing?.repeat;
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
        ? { quantity: measure(oldLength.valueQuantity), range: rangeFromFhir(oldLength.valueRange) }
        : undefined,
      a.anchoredLength
    )
  )
    administrationChanges.add(ANCHORED_COURSE_DURATION_EXTENSION_URL);
  if (!changes.size && !administrationChanges.size) return;
  const generated = serializeCanonicalSchedule(clauseForAdministration(a).schedule);
  if (target?.repeat) {
    const repeat = target.repeat;
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
}
/** Emit native R6 directly from modeled clinical facts. Shared serializers
 * encode vocabulary and grammar-source annotations only, never an R5 course. */
export function administrationToR6(
  a: CanonicalAdministration,
  options?: FhirProjectionOptions,
  currentSyntax?: CanonicalSigClause
): FhirR6Dosage {
  // The fresh parser construction passes its current, already-scoped clause
  // explicitly for coding/source annotations. Edited/imported public courses
  // reconstruct that view from their authoritative native facts instead.
  // Numeric doses, recurrence and limits below ALWAYS use native fields.
  // A shared delay may have moved from this member to the owning stage.
  // The source annotation view is no longer current in that case: deriving
  // it from live native facts prevents applying the same delay twice.
  const currentView = currentSyntax?.schedule?.administrationOffsetMinutes === a.delayMinutes
    ? currentSyntax : undefined;
  const clause = currentView ??
    (a.syntax && (!a.provenance || a.provenance.format === "syntax")
      ? clauseForAdministration(a)
      : undefined);
  const context = clause ? serializeCanonicalContext(clause, options) : undefined;
  const scheduleMetadata = clause ? serializeCanonicalSchedule(clause.schedule, options) : undefined;
  const output: Record<string, unknown> = clause ? { ...context } : { ...a.provenance?.data };
  delete output.sequence;
  const wireTiming = timingToR6(a.schedule);
  if (clause && wireTiming) {
    const annotations = scheduleMetadata?.timing;
    const r = wireTiming.repeat;
    if (r) {
      const source = a.schedule?.recurrence;
      const annotationsRepeat = annotations?.repeat;
      wireTiming.repeat = {
        ...r,
        ...(annotationsRepeat?.extension ? { extension: annotationsRepeat.extension } : {}),
        ...(source?.courseLength ? { boundsDuration: serializeDuration(source.courseLength) } : {}),
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
  updateNativeTimingAnnotations(a, output, wireTiming);
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
      const rate = { ...value.provenance };
      delete rate.modifierExtension;
      const code = (q: CanonicalMeasure | undefined) =>
        q && clause
          ? {
              ...q,
              ...getStandardDoseUnitCoding(q.unit),
              ...(q.system ? { system: q.system } : {}),
              ...(q.code ? { code: q.code } : {}),
            }
          : q;
      assign(rate, "doseQuantity", code(value.quantity));
      assign(rate, "doseRange", value.range && serializeRange(value.range, false, Boolean(clause)));
      assign(rate, "doseExpression", value.expression);
      assign(rate, "rateQuantity", code(value.rate));
      assign(rate, "rateRange", value.rateRange && serializeRange(value.rateRange));
      assign(
        rate,
        "rateRatio",
        value.rateRatio && {
          ...value.rateRatio,
          ...(value.rateRatio.numerator ? { numerator: code(value.rateRatio.numerator) } : {}),
          ...(value.rateRatio.denominator
            ? { denominator: simpleQuantityForR5(code(value.rateRatio.denominator)) }
            : {}),
        }
      );
      assign(rate, "rateExpression", value.rateExpression);
      assign(rate, "type", value.role);
      return rate;
    })
  );
  const oldSite = a.provenance?.format === "r6" ? (output.site as object) : undefined;
  let concept: FhirCodeableConcept | undefined = clause ? context?.site : a.target;
  const oldTarget =
    a.provenance?.format === "r6" ? (a.provenance.data as FhirR6Dosage).site?.concept : undefined;
  if (!clause && a.targetCount !== getBodySiteAdministrationTargetCount(oldTarget)) {
    const marker = buildBodySiteAdministrationTargetCountExtension(a.targetCount);
    const extensions = (concept?.extension ?? []).filter(
      (e) => e.url !== BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL
    );
    if (marker) extensions.push(marker);
    if (concept || marker) concept = { ...concept, ...(extensions.length ? { extension: extensions } : {}) };
    if (concept && !extensions.length) delete concept.extension;
  }
  if (
    concept ||
    a.siteReference ||
    (oldSite && Object.keys(oldSite).some((key) => key !== "concept" && key !== "reference"))
  ) {
    const site: Record<string, unknown> = { ...oldSite };
    assign(site, "concept", concept);
    assign(site, "reference", a.siteReference);
    output.site = site;
  } else delete output.site;
  const source = a.provenance?.format === "r6" ? (a.provenance.data as FhirR6Dosage) : undefined;
  const sourceCondition = source ? getDosageCondition(source as EzDosage) : undefined;
  if (!source || !same(sourceCondition, a.predicate)) {
    assign(output, "condition", a.predicate ? [conditionToR6(a.predicate)] : undefined);
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
  // No understood safety concept is serialized through a generic bag.
  // Unknown external annotations survive via the original wire provenance.
  assign(output, "safety", safetyToR6(a.safety, source?.safety, a.limits));
  return output as FhirR6Dosage;
}
const same = equalStructuredValues;
function isCalendarUnit(unit: string | undefined): unit is "s" | "min" | "h" | "d" | "wk" | "mo" | "a" {
  return unit === "s" || unit === "min" || unit === "h" || unit === "d" ||
    unit === "wk" || unit === "mo" || unit === "a";
}
function serializeDuration(q: CanonicalMeasure): FhirR6Quantity {
  const units: Record<string, [string, string]> = {
    s: ["second", "seconds"],
    min: ["minute", "minutes"],
    h: ["hour", "hours"],
    d: ["day", "days"],
    wk: ["week", "weeks"],
    mo: ["month", "months"],
    a: ["year", "years"],
  };
  const unit = q.code ?? q.unit ?? "";
  return {
    ...q,
    unit: units[unit]?.[q.value === 1 ? 0 : 1] ?? q.unit,
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
function projectCourseToR6(
  course: CanonicalCourse,
  options: FhirProjectionOptions | undefined,
  freshlyCompiled: boolean
): FhirR6DosageInstruction {
  const out = { ...course.provenance?.data };
  assign(out, "renderedInstruction", course.instruction);
  assign(out, "repeatCycle", course.cycleInterval);
  const rawData = course.provenance?.data;
  const rawCourse = course.provenance?.format === "r6" && Array.isArray(rawData?.step)
    ? rawData as Record<string, unknown> & FhirR6DosageInstruction : undefined;
  assign(out, "safety", safetyToR6(course.safety, rawCourse?.safety));
  out.step = course.stages.map((stage) => {
    const value = { ...stage.provenance };
    assign(value, "start", boundaryToR6(stage.start));
    assign(value, "end", boundaryToR6(stage.end));
    assign(value, "count", stage.count);
    assign(value, "safety", safetyToR6(stage.safety,
      (stage.provenance as FhirR6DosageStep | undefined)?.safety));
    value.component = stage.administrations.map((a) =>
      administrationToR6(a, options, freshlyCompiled ? a.syntax : undefined)
    );
    return value;
  });
  return { ...out, step: out.step as FhirR6DosageStep[] };
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
  return toFhirR5Dosages(courseToR6(course));
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
    if ("items" in input && input.meta.canonical.course)
      return input.meta.canonical.course;
    if ("step" in input) return courseFromR6(input, true);
    if ("items" in input) return courseFromR6(input.fhirNext, true);
  }
  const rows = Array.isArray(input) ? (input as readonly FhirDosage[]) : [input as FhirDosage];
  return courseFromR6(toDosageDetails(rows), true);
}
