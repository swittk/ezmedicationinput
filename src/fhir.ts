import { clinicalQuantityTimeDenominator, rateFromClinicalQuantity } from "./canonical/compile";
import { resolveBodySiteRestrictionPredicate } from "./body-site-grammar";
import { resolveMedicationInstructionActionForMethod, selectMedicationInstructionMethodCoding } from "./instruction-action-terminology";
import {
  setDosageCondition, setDosageExcludedDates, setDosageExcludedWeekdays, attachQualifiedR5AmountDetails,
  getDosageCondition, getDosageCalendarDayCondition, getDosageExcludedDates, getDosageExcludedWeekdays,
  retainField, readRetainedField, DOSAGE_RECONCILIATION_SOURCE_URL, withTimingCountMinimum, withTimingDurationMinimum, withTimingPeriodMinimum
} from "./dosage-course";
import type { ParseOptions, FhirDayOfWeek } from "./types";
import type { HpsgClinicalQuantityFeature } from "./hpsg/signature";
import {
  buildAdditionalInstructionFramesFromCoding,
  additionalInstructionFallbackText,
  findAdditionalInstructionDefinitionByCoding
} from "./advice";
import { realizeInstructionAction, instructionGraphAdministrationTechnique, instructionGraphAdviceAssociation, sameTypedWarning, instructionHasCompleteFrameEvidence, buildInstructionCoverage } from "./instruction-graph";
import { getAdviceLocaleAdapter } from "./advice-locale-adapter";
import { localeKeys } from "./localization";
import {
  buildBodySiteAdministrationTargetCountExtension,
  getBodySiteAdministrationTargetCount, resolveBodySiteTargetText
} from "./body-site-target";
import {
  selectPreferredSiteCoding,
  buildBodySiteSpatialRelationExtensions,
  parseBodySiteSpatialRelationExtension
} from "./body-site-spatial";
import {
  buildBodySiteTopographicalModifierCoding,
  getBodySiteText
} from "./body-site-lookup";
import {
  buildTranslationPrimitiveElement,
  cloneExtensions,
  clonePrimitiveElement,
  getPrimitiveTranslations,
  mergeI18nRecords,
  mergeTranslationPrimitiveElement
} from "./fhir-translations";
import { formatCanonicalClause } from "./format";
import {
  getQuantityComparator, simpleQuantityForR5, quantityPrimitiveForR5, quantityForR5, quantityFromR5
} from "./fhir-quantity-operator";
import { buildActionExtension, buildInstructionCoverageExtension, buildInstructionGraphExtension, parseInstructionGraphExtension, MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL } from "./instruction-graph-fhir";
import { ParserState } from "./parser-state";
import { getQuantityDurationUnit } from "./unit-lexicon";
import { joinCanonicalPrnReasonTexts } from "./prn";
import { parseSnomedFindingSitePostcoordinationCode } from "./snomed-postcoordination";
import {
  routeCodeFromCodings,
  ROUTE_SNOMED,
  ROUTE_TEXT,
  findPrnReasonDefinitionByCoding,
  getStandardDoseUnitCoding,
  getDoseQuantityUnit
} from "./maps";
import {
  AdviceFrame,
  AdviceForce,
  AdvicePolarity,
  CanonicalAdditionalInstructionExpr,
  CanonicalInstructionCoverage,
  CanonicalInstructionGraph,
  CanonicalActivityTimingExpr,
  CanonicalCalendarEventExpr,
  CanonicalCycleDayConstraint,
  CanonicalDosePeriodMaximumExpr,
  CanonicalOccurrenceCapExpr,
  CanonicalDoseRange,
  CanonicalSigClause,
  CanonicalScheduleExpr,
  CanonicalPrnReasonExpr,
  BodySiteRestriction,
  BodySiteSpatialRelation,
  EventTiming,
  FhirCodeableConcept,
  FhirR6CodeableConcept,
  FhirCoding,
  FhirR6Coding,
  FhirDosage,
  FhirExtension,
  FhirR6Extension,
  FhirR6Dosage,
  FhirPeriodUnit,
  FhirPrimitiveElement,
  FhirQuantity,
  FhirSimpleQuantity,
  FhirR6SimpleQuantity,
  FhirR6Quantity,
  FhirRange,
  FhirR6Range,
  FhirTiming,
  FhirTimingRepeat,
  FhirR6TimingRepeat,
  RouteCode
} from "./types";
import { objectValues } from "./utils/object";
import { arrayIncludes } from "./utils/array";
import { equalStructuredValues } from "./stable-structure";
import { standardTimingCodingFromSig, preferredPreviewTimingCoding as preferredTimingCoding, isPreviewTimingCoding, timingCodeMeaning, codeLessTimingDisplay } from "./timing-summary";

/** Known modifier: an independent cadence is restricted by unresolved cycle days. */
export const CYCLE_DAY_ELIGIBILITY_EXTENSION_URL = "urn:ezmedicationinput:StructureDefinition:medication-cycle-day-eligibility";

/** Read the recognized cycle constraint without interpreting narrative text.
 * @param dosage Editable R5/R6-compatible dosage with a retained known modifier.
 */
export function getCycleDayConstraint(dosage: FhirDosage | FhirR6Dosage): CanonicalCycleDayConstraint | undefined {
  const extension = dosage.modifierExtension?.find(item => item.url === CYCLE_DAY_ELIGIBILITY_EXTENSION_URL);
  if (!extension) return undefined;
  const child = (url: string) => extension.extension?.find(item => item.url === url);
  const days = extension.extension?.filter(item => item.url === "day")
    .map(item => item.valueInteger).filter((day): day is number => typeof day === "number") ?? [];
  const periodDays = child("periodDays")?.valueInteger;
  const cycles = child("cycles")?.valueInteger;
  const anchor = child("anchor")?.valueString;
  return {
    days,
    ...(periodDays !== undefined ? { periodDays } : {}),
    ...(cycles !== undefined ? { cycles } : {}),
    ...(anchor !== undefined ? { anchor } : {}),
    reason: child("reason")?.valueCode ?? "unresolved-cycle-eligibility",
    sourceText: child("source")?.valueString ?? ""
  };
}

/** Preserve the source-decided cycle restriction as a genuine dosage modifier.
 * @param constraint Recognized cycle ordinals and the unresolved calendar dependency.
 */
export function cycleDayConstraintExtension(
  constraint: CanonicalCycleDayConstraint, previous?: FhirExtension
): FhirExtension {
  const generated: FhirExtension = {
    url: CYCLE_DAY_ELIGIBILITY_EXTENSION_URL,
    extension: [
      ...constraint.days.map(day => ({ url: "day", valueInteger: day })),
      ...(constraint.periodDays !== undefined ? [{ url: "periodDays", valueInteger: constraint.periodDays }] : []),
      ...(constraint.cycles !== undefined ? [{ url: "cycles", valueInteger: constraint.cycles }] : []),
      ...(constraint.anchor !== undefined ? [{ url: "anchor", valueString: constraint.anchor }] : []),
      { url: "reason", valueCode: constraint.reason },
      { url: "source", valueString: constraint.sourceText }
    ]
  };
  if (!previous) return generated;
  // Each declared child owns only its value. Keep wrapper/child annotations
  // and unfamiliar children while updating the existing typed cycle facts.
  const owned = new Map<string, FhirExtension[]>();
  for (const child of generated.extension!) {
    const entries = owned.get(child.url);
    if (entries) entries.push(child); else owned.set(child.url, [child]);
  }
  // Day metadata belongs to that ordinal, not its old array position.
  const dayOwners = new Map<number, { values: FhirExtension[]; cursor: number }>();
  for (const child of previous.extension ?? []) if (child.url === "day" && typeof child.valueInteger === "number") {
    const owners = dayOwners.get(child.valueInteger);
    if (owners) owners.values.push(child);
    else dayOwners.set(child.valueInteger, { values: [child], cursor: 0 });
  }
  const days = owned.get("day")?.map(child => {
    const owners = dayOwners.get(child.valueInteger!);
    return owners?.values[owners.cursor++] ?? child;
  });
  if (days) owned.set("day", days);
  const positions = new Map<string, number>();
  const children: FhirExtension[] = [];
  let changed = false;
  for (const child of previous.extension ?? []) {
    // An unvalued day is an independent annotation. An unvalued scalar
    // owns its slot when that scalar is newly supplied; otherwise keep it.
    const annotationOnly = (child.url === "periodDays" || child.url === "cycles") && child.valueInteger === undefined ||
      (child.url === "anchor" || child.url === "source") && child.valueString === undefined ||
      child.url === "reason" && child.valueCode === undefined;
    if (child.url === "day" && typeof child.valueInteger !== "number" ||
        annotationOnly && (child.url === "source" && !constraint.sourceText ||
          child.url === "reason" && constraint.reason === "unresolved-cycle-eligibility" ||
          !owned.get(child.url)?.[positions.get(child.url) ?? 0])) {
      children.push(child); continue;
    }
    if (child.url !== "day" && child.url !== "periodDays" && child.url !== "cycles" &&
        child.url !== "anchor" && child.url !== "reason" && child.url !== "source") {
      children.push(child); continue;
    }
    const position = positions.get(child.url) ?? 0;
    positions.set(child.url, position + 1);
    const next = owned.get(child.url)?.[position];
    if (!next) {
      // Removed days are archived by their ordinal owners below. Other known
      // scalar children retain their annotations here without staying active.
      if (child.url !== "day") children.push({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [child] });
      changed = true; continue;
    }
    if (child.url === "day") {
      children.push(next);
      if (next !== child) changed = true;
    } else if (annotationOnly && child.extension !== undefined) {
      // Filling a primitive must not combine value[x] with nested extensions.
      // Keep the complete former annotation-only child as inactive source.
      const { extension: _annotations, ...metadata } = child;
      children.push({ ...metadata, ...next },
        { url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [child] });
      changed = true;
    } else if (child.valueInteger === next.valueInteger && child.valueString === next.valueString &&
        child.valueCode === next.valueCode) children.push(child);
    else { children.push({ ...child, ...next }); changed = true; }
  }
  for (const [url, entries] of owned) {
    // Decoder defaults are not newly authored source fields.
    if (!positions.has(url) && (url === "reason" && constraint.reason === "unresolved-cycle-eligibility" ||
        url === "source" && !constraint.sourceText)) continue;
    for (let index = positions.get(url) ?? 0; index < entries.length; index++) {
      children.push(entries[index]); changed = true;
    }
  }
  for (const owners of dayOwners.values()) for (let index = owners.cursor; index < owners.values.length; index++) {
    children.push({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [owners.values[index]] });
    changed = true;
  }
  return changed ? { ...previous, extension: children } : previous;
}

export const TIMING_FREQUENCY_MIN_EXTENSION_URL = "urn:ezmedicationinput:StructureDefinition:medication-timing-frequency-min";
/** Qualified per-administration duration, independent of a scalar rate denominator. */
export const TIMING_ADMINISTRATION_DURATION_EXTENSION_URL =
  "urn:ezmedicationinput:StructureDefinition:timing-administration-duration";

/** Decode one classified marker without flattening independent endpoints. */
export function parseTimingAdministrationDuration(
  extension: FhirR6Extension | undefined,
  current?: Pick<FhirTimingRepeat, "duration" | "durationMax" | "durationUnit">
): (Partial<NonNullable<HpsgClinicalQuantityFeature["administrationDuration"]>> & {
  range?: import("./canonical/course").CanonicalRange;
}) | undefined {
  const range = extension?.valueRange;
  if (range) {
    let low = quantityFromR5(range.low);
    let high = quantityFromR5(range.high);
    if (current?.duration !== undefined && (current.duration !== low?.value ||
        current.durationUnit !== undefined && current.durationUnit !== getQuantityDurationUnit(low))) {
      // A changed core scalar has no comparator. Keep the complete displaced
      // qualified endpoint as inert source rather than lending its qualifier.
      low = { ...(getQuantityComparator(low) ? { extension: [{
        url: DOSAGE_RECONCILIATION_SOURCE_URL, valueQuantity: range.low,
      }] } : low), value: current.duration,
        ...(current.durationUnit ? { unit: current.durationUnit,
          code: current.durationUnit, system: "http://unitsofmeasure.org" } : {}) };
    }
    if (current?.durationMax !== undefined && (current.durationMax !== high?.value ||
        current.durationUnit !== undefined && current.durationUnit !== getQuantityDurationUnit(high))) {
      // A changed core upper endpoint owns its numeric value. Keep the other
      // authored endpoint and independent annotations; the displaced marker
      // remains source provenance when the adapter writes the updated range.
      high = { ...(getQuantityComparator(high) ? { extension: [{
        url: DOSAGE_RECONCILIATION_SOURCE_URL, valueQuantity: range.high,
      }] } : high), value: current.durationMax,
        ...(current.durationUnit ? { unit: current.durationUnit,
          code: current.durationUnit, system: "http://unitsofmeasure.org" } : {}) };
    }
    return { range: low === range.low && high === range.high ? range :
      { ...range, ...(low ? { low } : {}), ...(high ? { high } : {}) } };
  }
  if (current?.duration !== undefined) return undefined;
  const quantity = extension?.valueQuantity;
  const unit = getQuantityDurationUnit(quantity);
  if (quantity?.value === undefined) return undefined;
  if (current?.durationMax !== undefined) {
    const upperUnit = current.durationUnit ?? unit;
    return { range: { low: quantityFromR5(quantity), high: {
      value: current.durationMax,
      ...(upperUnit ? { unit: upperUnit, code: upperUnit, system: "http://unitsofmeasure.org" } : {}),
    } } };
  }
  const comparator = getQuantityComparator(quantity);
  return { value: quantity.value, unit, ...(comparator ? { comparator } : {}) };
}

/** Modifier: each retained base-schedule opportunity occurs this many minutes later. */
export const ADMINISTRATION_OFFSET_EXTENSION_URL = "urn:ezmedicationinput:StructureDefinition:medication-administration-offset";

export function getAdministrationOffsetMinutes(dosage: FhirDosage | FhirR6Dosage): number | undefined {
  const quantity = dosage.modifierExtension?.find(extension =>
    extension.url === ADMINISTRATION_OFFSET_EXTENSION_URL)?.valueQuantity;
  return quantity?.value !== undefined && Number.isFinite(quantity.value) &&
    (quantity.code ?? quantity.unit) === "min" && !quantity.comparator ? quantity.value : undefined;
}

/** Modifier retaining a course duration alongside its absolute calendar bounds. */
export const ANCHORED_COURSE_DURATION_EXTENSION_URL = "urn:ezmedicationinput:StructureDefinition:medication-anchored-course-duration";

/** Read the authored temporal quantity without reconstructing it from dates or text.
 * @param dosage R5/R6-compatible dosage containing the known duration modifier.
 * @returns The retained duration quantity or range, when supplied.
 */
export function getAnchoredCourseDuration(
  dosage: Pick<FhirR6Dosage, "modifierExtension"> & {
    timing?: { repeat?: { boundsRange?: FhirR6Range; boundsDuration?: FhirR6Quantity } }
  }
): Pick<FhirR6Extension, "valueQuantity" | "valueRange"> | undefined {
  const source = dosage.modifierExtension?.find(extension =>
    extension.url === ANCHORED_COURSE_DURATION_EXTENSION_URL);
  if (!source) return undefined;
  // A native recurrence length keeps its member origin when calendar bounds
  // occupy the core bounds[x] slot. The outer modifier retains that ownership.
  const marker = source.extension?.find(child => child.url === "courseLength") ?? source;
  const repeat = dosage.timing?.repeat;
  const projectedMarker = marker.extension?.find(child => child.url === "projectedRange");
  const low = marker.extension?.find(child => child.url === "low")?.valueQuantity;
  const high = marker.extension?.find(child => child.url === "high")?.valueQuantity;
  // Typed endpoint children own the current complete range, including when
  // core Range can expose only one of its independently authored units.
  // Scalar/legacy markers without those endpoints accompany absolute bounds.
  if (!projectedMarker && (!low || !high) && (repeat?.boundsRange || repeat?.boundsDuration)) return undefined;
  if (!marker.extension || !low || !high) return marker;
  if (projectedMarker) {
    const current = repeat?.boundsRange;
    if (!current) return undefined;
    const projected = projectedMarker.valueRange ?? readRetainedField(projectedMarker) as FhirRange | undefined;
    if (!projected) return undefined;
    // Each live endpoint owns its edit. An omitted projected endpoint still
    // retains its authored unit until the clinician actually supplies it.
    return { valueRange: { ...current,
      low: reconcileDurationEndpoint(low, projected.low, current.low),
      high: reconcileDurationEndpoint(high, projected.high, current.high),
    } };
  }
  const metadata = marker.extension.find(child => child.url === "rangeMetadata");
  return { valueRange: {
    ...(metadata ? readRetainedField(metadata) as FhirRange : undefined),
    low: low as FhirSimpleQuantity, high: high as FhirSimpleQuantity,
  } };
}

/** A projected number/unit edit owns a new endpoint. Other edits keep the
 * original elapsed/calendar quantity while applying current annotations and
 * qualifier; changing > alone must not turn 48 elapsed hours into two days. */
function reconcileDurationEndpoint(
  source: FhirR6Quantity, projected: FhirR6SimpleQuantity | undefined, current: FhirR6SimpleQuantity | undefined
): FhirR6SimpleQuantity | undefined {
  if (equalStructuredValues(projected, current)) return source as FhirR6SimpleQuantity;
  if (!projected || !current || projected.value !== current.value || projected.unit !== current.unit ||
      projected.system !== current.system || projected.code !== current.code) return current;
  const result = { ...source, ...current, value: source.value, unit: source.unit, code: source.code, system: source.system,
    comparator: current.comparator, _comparator: current._comparator, extension: current.extension } as FhirR6SimpleQuantity;
  // An annotation exposed in the projection belongs to the live endpoint,
  // including deliberate removal. Unprojected authored-unit metadata stays.
  for (const key of Object.keys(projected)) {
    if (key !== "value" && key !== "unit" && key !== "code" && key !== "system" && !(key in current))
      delete (result as Record<string, unknown>)[key];
  }
  let retainProjectedAnnotations = false;
  for (const field of ["unit", "code", "system"] as const) {
    if (source[field] === current[field]) continue;
    const annotation = ("_" + field) as "_unit" | "_code" | "_system";
    if (current[annotation] !== undefined) retainProjectedAnnotations = true;
    if (source[annotation] === undefined) delete result[annotation];
    else result[annotation] = quantityPrimitiveForR5(source[annotation]);
  }
  if (retainProjectedAnnotations)
    result.extension = [...(result.extension ?? []), { url: DOSAGE_RECONCILIATION_SOURCE_URL,
      extension: [{ url: "projectedDurationEndpoint", valueQuantity: current }] }];
  return result;
}

/** Core Range endpoints share one unit identity. The known duration modifier
 * keeps both authored endpoints as active quantities when the wire range needs
 * a common label or cannot express mixed elapsed/calendar units. */
export function projectCourseDurationRange(range: FhirRange): { range: FhirRange; source?: FhirExtension };
export function projectCourseDurationRange(range: FhirR6Range): { range: FhirR6Range; source?: FhirR6Extension };
export function projectCourseDurationRange(range: FhirR6Range): { range: FhirR6Range; source?: FhirR6Extension } {
  const { low, high } = range;
  if (!low || !high || low.unit === high.unit && low.code === high.code && low.system === high.system)
    return { range };
  const { low: _low, high: _high, ...metadata } = range;
  const projected = low.code !== undefined && low.code === high.code && low.system === high.system
    ? { ...range, high: { ...high, unit: low.unit } }
    : { ...metadata, low };
  return {
    range: projected,
    source: { url: ANCHORED_COURSE_DURATION_EXTENSION_URL, extension: [
      { url: "low", valueQuantity: low },
      { url: "high", valueQuantity: high },
      ...(Object.keys(metadata).length ? [retainField("rangeMetadata", metadata)] : []),
    ] },
  };
}

export const TIMING_OFFSET_MIN_EXTENSION_URL = "urn:ezmedicationinput:StructureDefinition:medication-timing-offset-min";
export const TIMING_OFFSET_MAX_EXTENSION_URL = "urn:ezmedicationinput:StructureDefinition:medication-timing-offset-max";
export const TIMING_OFFSET_EXACT_EXTENSION_URL = "urn:ezmedicationinput:StructureDefinition:medication-timing-offset-exact";
export const TIMING_ACTIVITY_WINDOW_EXTENSION_URL = "urn:ezmedicationinput:StructureDefinition:medication-timing-activity-window";
/** Recurring administration opportunity window; distinct from a punctual
 * FHIR Timing.repeat.when WAKE or HS administration. */
export const TIMING_EVENT_WINDOW_EXTENSION_URL =
  "urn:ezmedicationinput:StructureDefinition:medication-timing-event-window";

/** Independent clocks combined with event anchors share one recurrence/count.
 * R5 and the current R6 pin forbid both core fields in that recurrence (tim-10). */
export const TIMING_ADDITIONAL_CLOCK_EXTENSION_URL =
  "urn:ezmedicationinput:StructureDefinition:medication-timing-additional-clock";

/** Wire primitive arrays contain metadata-only null positions. The clinical
 * event list keeps values only, while the owning Timing retains wire positions. */
export function getTimingEvents(timing: Pick<FhirTiming, "event"> | undefined): string[] | undefined {
  const source = timing?.event;
  if (!source) return undefined;
  let events: string[] | undefined;
  for (let index = 0; index < source.length; index++) {
    const event = source[index];
    if (event === null) events ??= source.slice(0, index) as string[];
    else if (events) events.push(event);
  }
  return events ?? source as string[];
}

/** Core clock values take priority over the bridge. Null primitive positions
 * carry metadata only; an explicitly empty clock array remains an empty field. */
export function getTimingClocks(
  repeat: Pick<FhirR6TimingRepeat, "timeOfDay" | "extension"> | undefined
): string[] | undefined {
  if (!repeat) return undefined;
  let clocks: string[] | undefined;
  if (repeat.timeOfDay !== undefined) {
    const source = repeat.timeOfDay;
    for (let index = 0; index < source.length; index++) {
      const clock = source[index];
      if (clock === null) clocks ??= source.slice(0, index) as string[];
      else if (clocks) clocks.push(clock);
    }
    const values = clocks ?? source as string[];
    if (values.length || !source.length) return values;
  }
  if (!repeat.extension?.length) return clocks;
  for (const item of repeat.extension) {
    if (item.url !== TIMING_ADDITIONAL_CLOCK_EXTENSION_URL) continue;
    if (typeof item.valueTime === "string") (clocks ??= []).push(item.valueTime);
    else if (item._valueTime) clocks ??= [];
  }
  return clocks;
}

/** Independent event and clock opportunities share one wire recurrence.
 * The original wire repeat distinguishes a bridge read from a current core edit;
 * no administration/count/cap is split, and retired carriers cannot revive. */
export function projectTimingClocks<T extends Pick<FhirR6TimingRepeat, "timeOfDay" | "_timeOfDay" | "when" | "_when" | "extension">>(
  repeat: T, wireSource?: Pick<FhirTimingRepeat, "timeOfDay">, target: "r5" | "r6" = "r5"
): T {
  let clocks = repeat.timeOfDay;
  // Native clocks contain only values. Restore a source's primitive positions
  // only when those same values still occupy its non-null slots.
  const sourceClocks = wireSource?.timeOfDay;
  let restorePositions = false;
  if (sourceClocks && clocks && sourceClocks.length > clocks.length) {
    let valueIndex = 0, unchanged = true;
    for (const clock of sourceClocks) {
      if (clock !== null && clock !== clocks[valueIndex++]) { unchanged = false; break; }
    }
    if (unchanged && valueIndex === clocks.length) {
      clocks = sourceClocks;
      restorePositions = true;
    }
  }
  // Extension-only primitive elements also participate in FHIR tim-10.
  // Keep their annotations in place and use the established clock carrier.
  const eventAnchored = Boolean(repeat.when?.length || repeat._when?.some(Boolean));
  const mixed = eventAnchored && Boolean(clocks?.length || repeat._timeOfDay?.some(Boolean));
  if (!mixed && !repeat.extension?.length)
    return restorePositions ? { ...repeat, timeOfDay: clocks } : repeat;
  let markers: FhirR6Extension[] | undefined;
  const kept: FhirR6Extension[] = [];
  let bridgeIndex = 0;
  let bridgeMetadata: FhirR6TimingRepeat["_timeOfDay"];
  let bridgeClocks: FhirTimingRepeat["timeOfDay"];
  let bridgeMatches = wireSource !== undefined &&
    (sourceClocks === undefined || sourceClocks.length > 0 && !sourceClocks.some(clock => clock !== null));
  for (const marker of repeat.extension ?? []) {
    if (marker.url !== TIMING_ADDITIONAL_CLOCK_EXTENSION_URL) { kept.push(marker); continue; }
    (markers ??= []).push(marker);
    if (marker.valueTime !== undefined || marker._valueTime) {
      const position = bridgeClocks?.length ?? 0;
      (bridgeClocks ??= []).push(marker.valueTime ?? null);
      if (marker._valueTime && !bridgeMetadata) bridgeMetadata = Array(position).fill(null);
      bridgeMetadata?.push(marker._valueTime ?? null);
      if (marker.valueTime !== undefined && marker.valueTime !== clocks?.[bridgeIndex++]) bridgeMatches = false;
    }
  }
  if (!mixed && !markers) return restorePositions ? { ...repeat, timeOfDay: clocks } : repeat;
  const unchangedBridge = bridgeMatches && bridgeIndex === (clocks?.length ?? 0);
  if (markers && unchangedBridge &&
      (mixed || (target === "r5" || eventAnchored) && bridgeClocks && bridgeClocks.length > bridgeIndex)) {
    // Keep metadata-only positions in the authored bridge for R5 or when
    // event anchors exclude core clocks. Other R6 bridges can use core arrays.
    // The native writer supplied timeOfDay temporarily for projection.
    const output = { ...repeat };
    delete output.timeOfDay;
    // With no authored core clock array, _timeOfDay is independent source
    // metadata; the unchanged bridge owns only its own _valueTime annotations.
    if (eventAnchored && repeat._timeOfDay !== undefined) {
      output.extension = [...(repeat.extension ?? []), {
        url: DOSAGE_RECONCILIATION_SOURCE_URL,
        extension: [retainField("_timeOfDay", repeat._timeOfDay)],
      }];
      delete output._timeOfDay;
    }
    return output;
  }
  if (markers) kept.push({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: markers });
  if (mixed) {
    const primitiveCount = Math.max(clocks?.length ?? 0, repeat._timeOfDay?.length ?? 0);
    for (let index = 0; index < primitiveCount; index++) {
      const metadata = repeat._timeOfDay?.[index];
      if (index >= (clocks?.length ?? 0) && !metadata) continue;
      const marker: FhirR6Extension = { url: TIMING_ADDITIONAL_CLOCK_EXTENSION_URL };
      if (clocks?.[index] != null) marker.valueTime = clocks[index]!;
      if (metadata) marker._valueTime = metadata;
      kept.push(marker);
    }
  }
  const output = { ...repeat };
  if (!mixed && restorePositions) output.timeOfDay = clocks;
  if (!mixed && unchangedBridge && bridgeClocks) {
    output.timeOfDay = bridgeClocks;
    // A core companion without an authored core clock is independent source.
    // Promotion attaches only the bridge's own primitive annotation.
    if (repeat._timeOfDay !== undefined) kept.push({
      url: DOSAGE_RECONCILIATION_SOURCE_URL,
      extension: [retainField("_timeOfDay", repeat._timeOfDay)],
    });
    if (bridgeMetadata) output._timeOfDay = bridgeMetadata;
    else delete output._timeOfDay;
  }
  if (kept.length) output.extension = kept;
  else delete output.extension;
  if (mixed) {
    delete output.timeOfDay;
    delete output._timeOfDay;
  }
  return output;
}

export const TIMING_CLOCK_WINDOW_EXTENSION_URL =
  "urn:ezmedicationinput:StructureDefinition:medication-timing-clock-window";

/** Read a local-clock recurrence window from structural timing metadata.
 * @param repeat FHIR Timing.repeat containing a typed window extension.
 * @returns Source clock endpoints and explicit endpoint inclusivity.
 */
export function getTimingClockWindow(
  repeat: FhirR6TimingRepeat | undefined
): { start: string; end: string; endInclusive: boolean } | undefined {
  const parts = repeat?.extension?.find(part => part.url === TIMING_CLOCK_WINDOW_EXTENSION_URL)?.extension;
  if (!parts) return undefined;
  const start = parts.find(part => part.url === "start")?.valueTime;
  const end = parts.find(part => part.url === "end")?.valueTime;
  const clock = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/u;
  return start && end && clock.test(start) && clock.test(end) ? {
    start, end, endInclusive: parts.find(part => part.url === "endInclusive")?.valueBoolean ?? true
  } : undefined;
}

/** Standard HL7 extension for day-of-month timing (repeatable positive integer). */
export const TIMING_DAY_OF_MONTH_EXTENSION_URL =
  "http://hl7.org/fhir/StructureDefinition/timing-dayOfMonth";

/** Retrieve bounded executable month-day selection without interpreting prose.
 * Unknown and malformed extensions remain in the original FHIR object.
 * @param repeat Original FHIR R5/R6 Timing.repeat with optional standard extensions.
 * @returns Sorted unique calendar days, or undefined when none are recognized.
 */
export function getTimingMonthDays(repeat: FhirR6TimingRepeat | undefined): number[] | undefined {
  const extensions = repeat?.extension;
  if (!extensions?.length) return undefined;
  const days: number[] = [];
  for (const extension of extensions) {
    if (extension.url !== TIMING_DAY_OF_MONTH_EXTENSION_URL) continue;
    const value = extension.valuePositiveInt;
    if (value !== undefined && Number.isInteger(value) && value >= 1 && value <= 31 &&
        days.indexOf(value) < 0) days.push(value);
  }
  return days.length ? days.sort((left, right) => left - right) : undefined;
}

export const TIMING_WEEKDAY_ORDINAL_EXTENSION_URL =
  "urn:ezmedicationinput:StructureDefinition:medication-timing-weekday-ordinal";

/** Read the explicitly encoded ordinal, independent of prose and scheduling anchors.
 * @param repeat Typed FHIR timing repeat containing an optional ordinal extension.
 * @returns The source weekday occurrence, including -1 for last, when valid.
 */
export function getTimingWeekdayOrdinal(
  repeat: FhirR6TimingRepeat | undefined
): -1 | 1 | 2 | 3 | 4 | 5 | undefined {
  const value = repeat?.extension?.find(part => part.url === TIMING_WEEKDAY_ORDINAL_EXTENSION_URL)?.valueInteger;
  return value === -1 || value === 1 || value === 2 || value === 3 || value === 4 || value === 5
    ? value : undefined;
}

/** Read an explicitly encoded daily event window without examining SIG text. */
export function getTimingEventWindow(
  repeat: FhirR6TimingRepeat | undefined
): { start: EventTiming; end: EventTiming } | undefined {
  const extension = repeat?.extension?.find(part => part.url === TIMING_EVENT_WINDOW_EXTENSION_URL);
  if (!extension) return undefined;
  const start = extension.extension?.find(part => part.url === "start")?.valueCode;
  const end = extension.extension?.find(part => part.url === "end")?.valueCode;
  const allowed = objectValues(EventTiming);
  if (!start || !end || allowed.indexOf(start as EventTiming) < 0 ||
      allowed.indexOf(end as EventTiming) < 0) return undefined;
  return { start: start as EventTiming, end: end as EventTiming };
}

export const TIMING_OCCURRENCE_CAP_EXTENSION_URL = "urn:ezmedicationinput:StructureDefinition:medication-timing-occurrence-cap";
/** Internal current recurrence fact; deliberately absent from public index exports. */
export const TIMING_SHARED_COUNT_EXTENSION_URL = "urn:ezmedicationinput:StructureDefinition:medication-timing-shared-count";
export const TIMING_EVENT_CALENDAR_SOURCE_EXTENSION_URL = "urn:ezmedicationinput:StructureDefinition:medication-timing-event-calendar-source";
export const PRN_TRIGGER_PHASE_EXTENSION_URL = "urn:ezmedicationinput:StructureDefinition:medication-prn-trigger-phase";
export const BODY_SITE_RESTRICTION_EXTENSION_URL = "urn:ezmedicationinput:StructureDefinition:medication-body-site-restriction";

export const INFUSION_CARRIER_MATERIAL_EXTENSION_URL =
  "urn:ezmedicationinput:StructureDefinition:medication-infusion-carrier-material";

/** Draft FHIR R5 extension definition, produced from the same typed child
 * contract as the live encoder. Carrier material is a descriptive vehicle
 * role, not a verified drug code or a modified administration choice.
 * External HL7 conformance validation remains a separate release check.
 */
export function buildInfusionCarrierMaterialStructureDefinition() {
  const slice = (name: string, code: "string" | "integer", min: number) => [
    { id: "Extension.extension:" + name, path: "Extension.extension",
      sliceName: name, min, max: "1", type: [{ code: "Extension" }] },
    { id: "Extension.extension:" + name + ".extension",
      path: "Extension.extension.extension", max: "0" },
    { id: "Extension.extension:" + name + ".url",
      path: "Extension.extension.url", fixedUri: name },
    { id: "Extension.extension:" + name + ".value[x]",
      path: "Extension.extension.value[x]", min: 1, max: "1",
      type: [{ code }] }
  ];
  return {
    resourceType: "StructureDefinition" as const,
    id: "medication-infusion-carrier-material",
    url: INFUSION_CARRIER_MATERIAL_EXTENSION_URL,
    name: "MedicationInfusionCarrierMaterial",
    title: "Source-backed infusion carrier material",
    status: "draft" as const,
    description: "Uncoded original vehicle-noun phrase tied to a separately typed carrier volume and infusion duration; does not identify the administered active substance.",
    kind: "complex-type" as const,
    abstract: false,
    type: "Extension",
    baseDefinition: "http://hl7.org/fhir/StructureDefinition/Extension",
    derivation: "constraint" as const,
    context: [{ type: "element" as const, expression: "Dosage" }],
    differential: { element: [
      { id: "Extension", path: "Extension", isModifier: false },
      { id: "Extension.extension", path: "Extension.extension",
        slicing: { discriminator: [{ type: "value", path: "url" }],
          ordered: false, rules: "closed" } },
      ...slice("material", "string", 1),
      ...slice("start", "integer", 0),
      ...slice("end", "integer", 0),
      { id: "Extension.url", path: "Extension.url",
        fixedUri: INFUSION_CARRIER_MATERIAL_EXTENSION_URL },
      { id: "Extension.value[x]", path: "Extension.value[x]", max: "0" }
    ] }
  };
}

/** Preserve a clinically named vehicle without claiming it has a verified
 * terminology identity. This describes the volume-owned material and never
 * changes dose/rate scheduling or converts a vehicle into the active drug.
 */
export function infusionCarrierMaterialExtension(
  material: NonNullable<HpsgClinicalQuantityFeature["carrierMaterial"]>
): FhirExtension {
  return {
    url: INFUSION_CARRIER_MATERIAL_EXTENSION_URL,
    extension: [
      { url: "material", valueString: material.text },
      ...(material.range ? [
        { url: "start", valueInteger: material.range.start },
        { url: "end", valueInteger: material.range.end }
      ] : [])
    ]
  };
}

/** Typed FHIR extraction: retain only supplied extension children, never
 * guess a vehicle from original SIG text or volume/mass alone.
 */
function infusionCarrierMaterialFromFhir(
  dosage: FhirDosage
): HpsgClinicalQuantityFeature["carrierMaterial"] {
  const extension = dosage.extension?.find(part =>
    part.url === INFUSION_CARRIER_MATERIAL_EXTENSION_URL);
  const child = (url: string) => extension?.extension?.find(part => part.url === url);
  const text = child("material")?.valueString;
  if (!text?.trim()) return undefined;
  const start = child("start")?.valueInteger;
  const end = child("end")?.valueInteger;
  return {
    text,
    ...(start !== undefined && end !== undefined &&
        Number.isInteger(start) && Number.isInteger(end) &&
        start >= 0 && end >= start ? { range: { start, end } } : {})
  };
}

/** Retain a source FHIR quantity code if its authored label cannot reproduce
 * that same coding on output; familiar aliases need no duplicated state.
 */
function nonRegenerableUnitCoding(quantity: FhirQuantity | undefined):
  { system?: string; code: string } | undefined {
  if (!quantity?.code) return undefined;
  const inferred = getStandardDoseUnitCoding(quantity.unit ?? quantity.code);
  if (inferred?.system === quantity.system && inferred?.code === quantity.code) return undefined;
  return { ...(quantity.system ? { system: quantity.system } : {}), code: quantity.code };
}

/** Reconstitute dimensional R5 meaning only where the role and amount were
 * explicitly supplied. Other external rateRatio dosages remain untouched.
 */
export function clinicalCarrierQuantityFromFhir(
  dosage: FhirDosage
): HpsgClinicalQuantityFeature | undefined {
  const material = infusionCarrierMaterialFromFhir(dosage);
  const measure = dosage.doseAndRate?.[0];
  const active = measure?.doseQuantity;
  const carrier = measure?.rateRatio?.numerator;
  const duration = measure?.rateRatio?.denominator;
  const doseUnit = active?.code ?? active?.unit;
  const volumeUnit = carrier?.code ?? carrier?.unit;
  const doseLabel = active?.unit ?? active?.code;
  const volumeLabel = carrier?.unit ?? carrier?.code;
  const durationUnit = getQuantityDurationUnit(duration);
  const matchingAmount = doseUnit === volumeUnit && active?.value === carrier?.value;
  const selfCarrier = !material && matchingAmount &&
    !(active?.system && carrier?.system && active.system !== carrier.system);
  // The current range remains in doseRange; its explicitly named carrier
  // needs no scalar medication amount to retain that separate material.
  if (active && (typeof active.value !== "number" || !Number.isFinite(active.value) ||
      active.value <= 0 || !doseUnit)) return undefined;
  if (!active && !measure?.doseRange) return undefined;
  if ((!material && !matchingAmount) ||
      typeof carrier?.value !== "number" || !Number.isFinite(carrier.value) ||
      typeof duration?.value !== "number" || !Number.isFinite(duration.value) ||
      carrier.value <= 0 || duration.value <= 0 || !volumeUnit ||
      !/^(?:mL|L)$/u.test(volumeUnit) ||
      (durationUnit !== "h" && durationUnit !== "min")) return undefined;
  const periodUnit = durationUnit === "h" ? FhirPeriodUnit.Hour : FhirPeriodUnit.Minute;
  const carrierComparator = getQuantityComparator(carrier);
  const activeComparator = getQuantityComparator(active);
  const durationComparator = getQuantityComparator(duration);
  return {
    representation: "dose-with-rate-ratio",
    status: "resolved",
    numerator: {
      value: carrier.value, unit: volumeLabel ?? volumeUnit, dimension: "volume",
      ...nonRegenerableUnitCoding(carrier),
      ...(carrierComparator ? { comparator: carrierComparator } : {})
    },
    denominators: [{ value: duration.value, unit: periodUnit, dimension: "time",
      ...(durationComparator ? { comparator: durationComparator } : {}) }],
    ...(active ? { projectedDose: {
      value: active.value!, unit: doseLabel ?? doseUnit!, ...nonRegenerableUnitCoding(active),
      ...(activeComparator ? { comparator: activeComparator } : {})
    } } : {}),
    ...(material || doseLabel !== volumeLabel || activeComparator !== carrierComparator ||
        active?.system !== carrier.system || active?.code !== carrier.code
      ? { rateNumerator: {
          value: carrier.value, unit: volumeLabel ?? volumeUnit, ...nonRegenerableUnitCoding(carrier),
          ...(carrierComparator ? { comparator: carrierComparator } : {})
        } }
      : {}),
    ...(material || selfCarrier ? { administrationDuration: { value: duration.value, unit: periodUnit,
      ...(durationComparator ? { comparator: durationComparator } : {}) } } : {}),
    ...(material ? { carrierMaterial: material } : {})
  };
}

/** Make an implicit multi-clock cadence explicit without overriding a stated frequency.
 * @param repeat Editable FHIR timing currently being lowered.
 */
function normalizeClockFrequency(repeat: FhirTimingRepeat): void {
  if (repeat.frequency !== undefined ||
      repeat.extension?.find(item => item.url === TIMING_FREQUENCY_MIN_EXTENSION_URL)?.valueInteger !== undefined ||
      !repeat.period || !repeat.periodUnit ||
      (repeat.timeOfDay?.length ?? 0) < 2 || repeat.when?.length) return;
  const clocks = new Set(repeat.timeOfDay).size;
  if (repeat.periodUnit === 'd') {
    repeat.frequency = clocks;
    return;
  }
  const weekdays = new Set(repeat.dayOfWeek ?? []).size;
  if (repeat.periodUnit === 'wk' && repeat.period === 1 && weekdays > 0) {
    repeat.frequency = clocks * weekdays;
  }
}

const SNOMED_SYSTEM = "http://snomed.info/sct";
const UCUM_SYSTEM = "http://unitsofmeasure.org";

function prnTriggerPhaseExtension(phase: "onset" | undefined) {
  return phase ? { url: PRN_TRIGGER_PHASE_EXTENSION_URL, valueCode: phase } : undefined;
}

export function parsePrnTriggerPhase(concept: FhirR6CodeableConcept | undefined): "onset" | undefined {
  const value = concept?.extension?.find(
    (candidate) => candidate.url === PRN_TRIGGER_PHASE_EXTENSION_URL
  )?.valueCode;
  return value === "onset" ? "onset" : undefined;
}

function restrictionRangeExtension(
  prefix: string,
  range: { start: number; end: number } | undefined
): FhirExtension[] {
  return range
    ? [
        { url: `${prefix}Start`, valueInteger: range.start },
        { url: `${prefix}End`, valueInteger: range.end }
      ]
    : [];
}

function buildBodySiteRestrictionExtensions(
  restrictions: BodySiteRestriction[] | undefined
): FhirExtension[] {
  if (!restrictions?.length) return [];
  return restrictions.map((restriction) => ({
    url: BODY_SITE_RESTRICTION_EXTENSION_URL,
    extension: [
      { url: "relation", valueCode: restriction.relation },
      { url: "sourceText", valueString: restriction.sourceText },
      { url: "predicateText", valueString: restriction.predicate.text },
      { url: "predicateForm", valueCode: restriction.predicate.form },
      ...(restriction.predicate.lemma
        ? [{ url: "predicateLemma", valueString: restriction.predicate.lemma }]
        : []),
      ...(restriction.predicate.focusText
        ? [{ url: "predicateFocusText", valueString: restriction.predicate.focusText }]
        : []),
      ...restrictionRangeExtension("source", restriction.range),
      ...restrictionRangeExtension("marker", restriction.markerRange),
      ...restrictionRangeExtension("predicate", restriction.predicate.range)
    ]
  }));
}

function restrictionExtensionChild(
  extension: FhirR6Extension,
  url: string
): FhirR6Extension | undefined {
  return extension.extension?.find((candidate) => candidate.url === url);
}

function restrictionRangeFromExtension(
  extension: FhirR6Extension,
  prefix: string
): { start: number; end: number } | undefined {
  const start = restrictionExtensionChild(extension, `${prefix}Start`)?.valueInteger;
  const end = restrictionExtensionChild(extension, `${prefix}End`)?.valueInteger;
  return Number.isInteger(start) && Number.isInteger(end) && (end as number) >= (start as number)
    ? { start: start as number, end: end as number }
    : undefined;
}

function parseBodySiteRestrictionExtensions(
  concept: FhirR6CodeableConcept | undefined
): BodySiteRestriction[] | undefined {
  if (!concept?.extension?.length) return undefined;
  const result: BodySiteRestriction[] = [];
  for (const extension of concept.extension) {
    if (extension.url !== BODY_SITE_RESTRICTION_EXTENSION_URL) continue;
    const relation = restrictionExtensionChild(extension, "relation")?.valueCode;
    const predicateText = restrictionExtensionChild(extension, "predicateText")?.valueString?.trim();
    if (relation !== "where" || !predicateText) continue;
    const storedLemma = restrictionExtensionChild(extension, "predicateLemma")?.valueString?.trim() || undefined;
    // A fresh wire submission can replace the live predicate text while
    // retaining a formerly inferred lexical identity. Reconcile once at the
    // import boundary; the complete source extension remains unchanged.
    const changedPredicate = storedLemma !== undefined &&
      resolveBodySiteRestrictionPredicate(predicateText).lemma !== storedLemma;
    const rawForm = changedPredicate ? "raw" : restrictionExtensionChild(extension, "predicateForm")?.valueCode;
    const form = rawForm === "state" || rawForm === "existential" || rawForm === "raw"
      ? rawForm
      : "raw";
    result.push({
      relation,
      sourceText: restrictionExtensionChild(extension, "sourceText")?.valueString?.trim() ??
        `where ${predicateText}`,
      range: restrictionRangeFromExtension(extension, "source"),
      markerRange: restrictionRangeFromExtension(extension, "marker"),
      predicate: {
        text: predicateText,
        lemma: changedPredicate ? undefined : storedLemma,
        form,
        focusText: changedPredicate ? undefined :
          restrictionExtensionChild(extension, "predicateFocusText")?.valueString?.trim() || undefined,
        range: restrictionRangeFromExtension(extension, "predicate")
      }
    });
  }
  return result.length ? result : undefined;
}

function timingOffsetExtensionValue(
  repeat: FhirR6TimingRepeat | undefined,
  url: string
): number | undefined {
  const extension = repeat?.extension?.find((candidate) => candidate.url === url);
  const value = extension?.valueInteger ?? extension?.valueDecimal;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function timingOffsetExtension(url: string, minutes: number) {
  return Number.isInteger(minutes)
    ? { url, valueInteger: minutes }
    : { url, valueDecimal: minutes };
}

export function getExactTimingOffsetMinutes(
  repeat: FhirR6TimingRepeat | undefined
): number | undefined {
  if (repeat?.offset !== undefined) return repeat.offset;
  return timingOffsetExtensionValue(repeat, TIMING_OFFSET_EXACT_EXTENSION_URL);
}

function activityTimingOffsetChild(url: string, value: number | undefined) {
  if (value === undefined) return undefined;
  return {
    url,
    valueQuantity: {
      value,
      unit: "minutes",
      system: UCUM_SYSTEM,
      code: "min"
    }
  };
}

function buildActivityTimingExtension(
  item: CanonicalActivityTimingExpr,
  options?: FhirProjectionOptions
) {
  const translation = options?.includeTranslationExtensions
    ? buildTranslationPrimitiveElement(item.activity.i18n) : undefined;
  const children = [
    { url: "relation", valueCode: item.relation },
    {
      url: "activity",
      valueCodeableConcept: {
        ...(item.activity.text !== undefined ? { text: item.activity.text } : {}),
        ...(item.activity.coding?.code ? { coding: [{ ...item.activity.coding }] } : {}),
        ...(translation ? { _text: translation } : {})
      }
    },
    activityTimingOffsetChild("offset", item.offset),
    activityTimingOffsetChild("offsetMin", item.offsetMin),
    activityTimingOffsetChild("offsetMax", item.offsetMax)
  ].filter((child): child is NonNullable<typeof child> => Boolean(child));
  return { url: TIMING_ACTIVITY_WINDOW_EXTENSION_URL, extension: children };
}

function activityTimingQuantityMinutes(extension: NonNullable<FhirR6TimingRepeat["extension"]>[number] | undefined): number | undefined {
  const value = extension?.valueQuantity?.value;
  const unit = extension?.valueQuantity?.code ?? extension?.valueQuantity?.unit;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  if (!unit || unit === "min" || /^minutes?$/i.test(unit)) return value;
  if (unit === "h" || /^hours?$/i.test(unit)) return value * 60;
  if (unit === "d" || /^days?$/i.test(unit)) return value * 1440;
  return undefined;
}

function buildSharedCountExtension(shared: NonNullable<CanonicalScheduleExpr["sharedCount"]>): FhirExtension {
  const extension: FhirExtension[] = [{ url: "groupId", valueString: shared.groupId }];
  if (shared.count !== undefined) extension.push({ url: "count", valueInteger: shared.count });
  if (shared.countMax !== undefined) extension.push({ url: "countMax", valueInteger: shared.countMax });
  return { url: TIMING_SHARED_COUNT_EXTENSION_URL, extension };
}

/** Read the explicit shared allowance, never derive membership from source or phase IDs. */
export function getTimingSharedCount(
  repeat: FhirR6TimingRepeat | undefined
): CanonicalScheduleExpr["sharedCount"] {
  const marker = repeat?.extension?.find(item => item.url === TIMING_SHARED_COUNT_EXTENSION_URL);
  const child = (url: string) => marker?.extension?.find(item => item.url === url);
  const groupId = child("groupId")?.valueString;
  const count = child("count")?.valueInteger, countMax = child("countMax")?.valueInteger;
  if (!groupId) return undefined;
  return { groupId, ...(count !== undefined ? { count } : undefined),
    ...(countMax !== undefined ? { countMax } : undefined) };
}

function buildOccurrenceCapExtension(cap: CanonicalOccurrenceCapExpr) {
  return {
    url: TIMING_OCCURRENCE_CAP_EXTENSION_URL,
    extension: [
      { url: "max", valueInteger: cap.max },
      {
        url: "period",
        valueQuantity: {
          value: cap.period,
          unit: cap.periodUnit,
          system: UCUM_SYSTEM,
          code: cap.periodUnit
        }
      }
    ]
  };
}

export function getTimingOccurrenceCap(
  repeat: FhirR6TimingRepeat | undefined
): CanonicalOccurrenceCapExpr | undefined {
  const extension = repeat?.extension?.find(
    (candidate) => candidate.url === TIMING_OCCURRENCE_CAP_EXTENSION_URL
  );
  const child = (url: string) => extension?.extension?.find((candidate) => candidate.url === url);
  const max = child("max")?.valueInteger;
  const periodQuantity = child("period")?.valueQuantity;
  const period = periodQuantity?.value;
  const periodUnit = periodQuantity?.code ?? periodQuantity?.unit;
  if (
    typeof max !== "number" || !Number.isInteger(max) || max < 1 ||
    typeof period !== "number" || !Number.isFinite(period) || period <= 0 ||
    !periodUnit
  ) return undefined;
  const mappedUnit = periodUnit as FhirPeriodUnit;
  if (["s", "min", "h", "d", "wk", "mo", "a"].indexOf(mappedUnit) < 0) return undefined;
  return { max, period, periodUnit: mappedUnit };
}

function canonicalDosePeriodMaximums(
  dosage: FhirDosage
): CanonicalDosePeriodMaximumExpr[] | undefined {
  const result: CanonicalDosePeriodMaximumExpr[] = [];
  for (const ratio of dosage.maxDosePerPeriod ?? []) {
    const amount = ratio.numerator?.value;
    const unit = ratio.numerator?.unit ?? ratio.numerator?.code;
    const period = ratio.denominator?.value;
    const rawPeriodUnit = ratio.denominator?.code ?? ratio.denominator?.unit;
    if (amount === undefined || !Number.isFinite(amount) || amount <= 0 || !unit ||
        period === undefined || !Number.isFinite(period) || period <= 0 ||
        !rawPeriodUnit ||
        ["s", "min", "h", "d", "wk", "mo", "a"].indexOf(rawPeriodUnit) < 0) continue;
    const amountComparator = getQuantityComparator(ratio.numerator);
    const periodComparator = getQuantityComparator(ratio.denominator);
    result.push({
      amount, unit, period, periodUnit: rawPeriodUnit as FhirPeriodUnit,
      ...(amountComparator ? { amountComparator } : {}),
      ...(periodComparator ? { periodComparator } : {})
    });
  }
  return result.length ? result : undefined;
}

/** Read typed activity-event relations from Timing extensions without parsing
 * narrative instructions or inferring an activity's calendar instant.
 */
export function parseActivityTimingExtensions(repeat: FhirR6TimingRepeat | undefined): CanonicalActivityTimingExpr[] | undefined {
  const result: CanonicalActivityTimingExpr[] = [];
  for (const extension of repeat?.extension ?? []) {
    if (extension.url !== TIMING_ACTIVITY_WINDOW_EXTENSION_URL) continue;
    const child = (url: string) => extension.extension?.find((candidate) => candidate.url === url);
    const relation = child("relation")?.valueCode;
    const activityConcept = child("activity")?.valueCodeableConcept;
    const text = activityConcept?.text ?? activityConcept?.coding?.[0]?.display;
    if ((relation !== "before" && relation !== "after") || !text) continue;
    const coding = activityConcept?.coding?.find((candidate) => Boolean(candidate.code));
    const i18n = getPrimitiveTranslations(activityConcept?._text) ?? {};
    result.push({
      relation,
      activity: {
        text,
        i18n: Object.keys(i18n).length ? i18n : undefined,
        coding: coding ? { ...coding } as FhirCoding : undefined
      },
      offset: activityTimingQuantityMinutes(child("offset")),
      offsetMin: activityTimingQuantityMinutes(child("offsetMin")),
      offsetMax: activityTimingQuantityMinutes(child("offsetMax"))
    });
  }
  return result.length ? result : undefined;
}
type CodeableConceptCoding = NonNullable<FhirCodeableConcept["coding"]>[number];

export interface FhirProjectionOptions {
  /** Typed regimen-graph sequence; serialized without inferring phase meaning. */
  sequence?: number;
  /**
   * Defaults to true. When true, structured spatial body-site phrases such as
   * "top of head" can emit a SNOMED topographical modifier expression in
   * Dosage.site.coding while preserving the spatial-relation extension.
   */
  bodySitePostcoordination?: boolean;
  /**
   * Emits FHIR primitive translation extensions on coded concepts when
   * translation metadata is available.
   */
  includeTranslationExtensions?: boolean;
}

export function createEmptyCanonicalClause(rawText: string): CanonicalSigClause {
  return {
    kind: "administration",
    rawText,
    raw: {
      start: 0,
      end: rawText.length,
      text: rawText
    },
    leftovers: [],
    evidence: [],
    confidence: 1
  };
}

function selectFirstCodingWithCode<TCoding extends FhirR6Coding>(
  concept: { coding?: TCoding[] } | undefined
): TCoding | undefined {
  if (!concept?.coding?.length) {
    return undefined;
  }
  for (const coding of concept.coding) {
    if (coding.code) {
      return coding;
    }
  }
  return undefined;
}

type CanonicalSite = NonNullable<CanonicalSigClause["site"]>;

function selectCanonicalSiteCoding(
  site: CanonicalSite | undefined,
  options?: FhirProjectionOptions
): CanonicalSite["coding"] | undefined {
  if (options?.bodySitePostcoordination === false) {
    return site?.coding;
  }
  const postcoordinated = buildBodySiteTopographicalModifierCoding(
    site?.spatialRelation,
    site?.text,
    { postcoordination: true }
  );
  return options?.bodySitePostcoordination === true
    ? postcoordinated ?? site?.coding
    : site?.coding ?? postcoordinated;
}

function buildSiteCodingArray(
  siteCoding: CanonicalSite["coding"] | undefined,
  options?: FhirProjectionOptions
): CodeableConceptCoding[] | undefined {
  if (!siteCoding?.code) {
    return undefined;
  }
  const displayElement = options?.includeTranslationExtensions
    ? buildTranslationPrimitiveElement(siteCoding.i18n)
    : undefined;
  return [
    {
      system: siteCoding.system ?? SNOMED_SYSTEM,
      code: siteCoding.code,
      display: siteCoding.display,
      ...(displayElement ? { _display: displayElement } : {})
    }
  ];
}

function getFallbackSiteText(site: FhirR6CodeableConcept | undefined): string | undefined {
  return resolveBodySiteTargetText(site);
}

function codeableConceptTranslationI18n(
  concept: FhirR6CodeableConcept | undefined,
  coding: FhirR6Coding | undefined,
  fallback?: Record<string, string>
): {
  text?: Record<string, string>;
  display?: Record<string, string>;
} {
  return {
    text: mergeI18nRecords(
      fallback,
      getPrimitiveTranslations(concept?._text)
    ),
    display: mergeI18nRecords(
      coding?.i18n,
      getPrimitiveTranslations(coding?._display)
    )
  };
}

function lowerFirst(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.charAt(0).toLowerCase() + trimmed.slice(1) : undefined;
}

function getSpatialPrnReasonSiteText(
  spatialRelation: BodySiteSpatialRelation | undefined
): string | undefined {
  const sourceText = lowerFirst(spatialRelation?.sourceText);
  if (sourceText) {
    return sourceText;
  }
  const targetText =
    lowerFirst(spatialRelation?.targetText) ??
    (spatialRelation?.targetCoding ? getBodySiteText(spatialRelation.targetCoding) : undefined);
  if (!targetText) {
    return undefined;
  }
  const relationText = lowerFirst(spatialRelation?.relationText);
  if (!relationText) {
    return `at ${targetText}`;
  }
  switch (relationText) {
    case "at":
    case "in":
    case "inside":
    case "into":
    case "on":
    case "to":
    case "above":
    case "below":
    case "beneath":
    case "under":
    case "behind":
    case "around":
    case "near":
    case "between":
    case "outside":
      return `${relationText} ${targetText}`;
    case "top":
    case "back":
    case "front":
    case "left side":
    case "right side":
    case "both sides":
      return `${relationText} of ${targetText}`;
    default:
      return relationText.endsWith(" of")
        ? `${relationText} ${targetText}`
        : `${relationText} of ${targetText}`;
  }
}

function getFallbackPrnReasonText(
  concept: FhirR6CodeableConcept, coding: FhirR6Coding | undefined,
  spatialRelation: BodySiteSpatialRelation | undefined
): string | undefined {
  if (concept.text) {
    return concept.text;
  }
  const spatialSiteText = getSpatialPrnReasonSiteText(spatialRelation);
  const display = lowerFirst(coding?.display);
  if (display && !spatialSiteText) {
    return display;
  }
  const parsed = parseSnomedFindingSitePostcoordinationCode(coding?.code);
  const focus =
    parsed && (coding?.system ?? SNOMED_SYSTEM) === SNOMED_SYSTEM
      ? findPrnReasonDefinitionByCoding(SNOMED_SYSTEM, parsed.focusCode)
      : undefined;
  const focusText = lowerFirst(focus?.text ?? focus?.coding?.display) ?? display;
  if (focusText && spatialSiteText) {
    return spatialSiteText.toLowerCase().startsWith(`${focusText.toLowerCase()} `)
      ? spatialSiteText
      : `${focusText} ${spatialSiteText}`;
  }
  if (display) {
    return display;
  }
  if (!parsed || (coding?.system ?? SNOMED_SYSTEM) !== SNOMED_SYSTEM) {
    return undefined;
  }
  const siteText = getBodySiteText({
    system: SNOMED_SYSTEM,
    code: parsed.siteCode
  });
  return focusText && siteText ? `${focusText} at ${siteText}` : focusText;
}

/** Convert one coded reason without deciding whether its caller enables PRN. */
function canonicalPrnReasonFromConcept(concept: FhirR6CodeableConcept): CanonicalPrnReasonExpr {
  const coding = selectFirstCodingWithCode(concept);
  const defaultDef = coding?.code
    ? findPrnReasonDefinitionByCoding(coding.system ?? SNOMED_SYSTEM, coding.code)
    : undefined;
  const i18n = codeableConceptTranslationI18n(concept, coding, defaultDef?.i18n);
  const spatialRelation = parseBodySiteSpatialRelationExtension(concept);
  return {
    text: getFallbackPrnReasonText(concept, coding, spatialRelation),
    i18n: i18n.text,
    spatialRelation,
    triggerPhase: parsePrnTriggerPhase(concept),
    coding: coding?.code
      ? {
        code: coding.code,
        display: coding.display,
        system: coding.system,
        extension: cloneExtensions(coding.extension),
        _display: clonePrimitiveElement(coding._display),
        i18n: i18n.display
      }
      : undefined
  };
}

/** Build a quantity using exact standard terminology when available.
 * @param value Authored quantity; coding never changes its magnitude.
 * @param unit Authored/canonical unit label, retained even for local units.
 */
function buildFhirDoseQuantity(
  value: number, unit: string | undefined,
  comparator?: NonNullable<CanonicalSigClause["dose"]>["comparator"]
): FhirSimpleQuantity {
  const quantity = { value, unit, ...getStandardDoseUnitCoding(unit) };
  return comparator ? simpleQuantityForR5({ ...quantity, comparator })! : quantity;
}

function buildFhirDoseRange(range: CanonicalDoseRange, unit: string | undefined): FhirRange | undefined {
  const fhirRange: FhirRange = {};

  if (range.low !== undefined) {
    fhirRange.low = buildFhirDoseQuantity(range.low, unit);
  }
  if (range.high !== undefined) {
    fhirRange.high = buildFhirDoseQuantity(range.high, unit);
  }

  if (!fhirRange.low && !fhirRange.high) {
    return undefined;
  }

  return fhirRange;
}

function describeDurationUnit(unit: FhirPeriodUnit, value: number | undefined): string {
  const plural = value !== 1;
  switch (unit) {
    case FhirPeriodUnit.Second:
      return plural ? "seconds" : "second";
    case FhirPeriodUnit.Minute:
      return plural ? "minutes" : "minute";
    case FhirPeriodUnit.Hour:
      return plural ? "hours" : "hour";
    case FhirPeriodUnit.Day:
      return plural ? "days" : "day";
    case FhirPeriodUnit.Week:
      return plural ? "weeks" : "week";
    case FhirPeriodUnit.Month:
      return plural ? "months" : "month";
    case FhirPeriodUnit.Year:
      return plural ? "years" : "year";
    default:
      return unit;
  }
}

function extensionChild(
  extension: { extension?: Array<{ url: string; valueCode?: string; valueString?: string; valueBoolean?: boolean; valueInteger?: number }> },
  url: string
) {
  return extension.extension?.find((candidate) => candidate.url === url);
}

function calendarEventPrimitive(event: CanonicalCalendarEventExpr): FhirPrimitiveElement {
  return {
    extension: [{
      url: TIMING_EVENT_CALENDAR_SOURCE_EXTENSION_URL,
      extension: [
        { url: "calendar", valueCode: event.calendar },
        { url: "calendarYear", valueInteger: event.calendarYear },
        { url: "month", valueInteger: event.month },
        { url: "day", valueInteger: event.day },
        { url: "sourceText", valueString: event.sourceText },
        ...(event.inferredYear ? [{ url: "inferredYear", valueBoolean: true }] : [])
      ]
    }]
  };
}

function calendarEventFromFhir(
  value: string | null,
  primitive?: FhirPrimitiveElement | null
): CanonicalCalendarEventExpr | undefined {
  if (value === null) return undefined;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/u);
  if (!match) return undefined;
  const isoYear = Number(match[1]);
  const isoMonth = Number(match[2]);
  const isoDay = Number(match[3]);
  if (!Number.isFinite(isoYear) || !Number.isFinite(isoMonth) || !Number.isFinite(isoDay)) return undefined;
  const date = new Date(Date.UTC(isoYear, isoMonth - 1, isoDay));
  if (
    date.getUTCFullYear() !== isoYear ||
    date.getUTCMonth() !== isoMonth - 1 ||
    date.getUTCDate() !== isoDay
  ) return undefined;

  const metadata = primitive?.extension?.find(
    (candidate) => candidate.url === TIMING_EVENT_CALENDAR_SOURCE_EXTENSION_URL
  );
  const calendar = extensionChild(metadata ?? {}, "calendar")?.valueCode;
  const calendarYear = extensionChild(metadata ?? {}, "calendarYear")?.valueInteger;
  const month = extensionChild(metadata ?? {}, "month")?.valueInteger;
  const day = extensionChild(metadata ?? {}, "day")?.valueInteger;
  const sourceText = extensionChild(metadata ?? {}, "sourceText")?.valueString;
  const inferredYear = extensionChild(metadata ?? {}, "inferredYear")?.valueBoolean;

  const isoDate = `${match[1]}-${match[2]}-${match[3]}`;
  return {
    isoDate,
    ...(value === isoDate ? {} : { fhirDateTime: value }),
    calendar: calendar || "gregory",
    calendarYear: calendarYear ?? isoYear,
    month: month ?? isoMonth,
    day: day ?? isoDay,
    sourceText: sourceText ?? value,
    inferredYear: inferredYear || undefined
  };
}

function buildFhirDurationQuantity(
  value: number,
  unit: FhirPeriodUnit,
  comparator?: FhirR6Quantity["comparator"],
  unitLabel?: string
): FhirQuantity {
  const quantity = {
    value,
    unit: unitLabel ?? describeDurationUnit(unit, value),
    system: UCUM_SYSTEM,
    code: unit
  };
  return comparator ? quantityForR5({ ...quantity, comparator })! : quantity;
}

function buildFhirBoundsRange(
  low: number | undefined, high: number | undefined, unit: FhirPeriodUnit,
  lowComparator?: FhirR6Quantity["comparator"],
  highComparator?: FhirR6Quantity["comparator"],
  highUnit: FhirPeriodUnit = unit,
  lowUnitLabel?: string,
  highUnitLabel?: string
): FhirRange {
  const displayUnit = describeDurationUnit(unit, high ?? low ?? 2);
  return {
    ...(low !== undefined ? { low: simpleQuantityForR5({ ...buildFhirDurationQuantity(low, unit),
      ...(lowUnitLabel !== undefined ? { unit: lowUnitLabel } : highUnit === unit ? { unit: displayUnit } : {}),
      ...(lowComparator ? { comparator: lowComparator } : {}) })! } : {}),
    ...(high !== undefined ? { high: simpleQuantityForR5({ ...buildFhirDurationQuantity(high, highUnit),
      ...(highUnitLabel !== undefined ? { unit: highUnitLabel } : highUnit === unit ? { unit: displayUnit } : {}),
      ...(highComparator ? { comparator: highComparator } : {}) })! } : {})
  };
}

function extractCanonicalTimingBounds(
  dosage: FhirDosage
): { duration?: number; durationMax?: number; durationIsRange?: true; durationUnit?: FhirPeriodUnit; durationMaxUnit?: FhirPeriodUnit;
  durationUnitLabel?: string; durationMaxUnitLabel?: string;
  durationComparator?: FhirR6Quantity["comparator"];
  durationMaxComparator?: FhirR6Quantity["comparator"]; warning?: string } {
  const repeat = dosage.timing?.repeat;
  const retained = getAnchoredCourseDuration(dosage);
  const boundsDuration = repeat?.boundsDuration ?? retained?.valueQuantity;
  const boundsRange = retained?.valueRange ?? repeat?.boundsRange;
  if (boundsDuration?.value !== undefined) {
    const durationUnit = getQuantityDurationUnit(boundsDuration);
    if (!durationUnit) {
      return {};
    }
    const comparator = getQuantityComparator(boundsDuration);
    return {
      duration: boundsDuration.value,
      durationUnit,
      durationUnitLabel: boundsDuration.unit,
      ...(comparator ? { durationComparator: comparator } : {})
    };
  }

  if (!boundsRange) {
    return {};
  }

  const low = boundsRange.low;
  const high = boundsRange.high;
  const lowUnit = getQuantityDurationUnit(low);
  const highUnit = getQuantityDurationUnit(high);
  const durationUnit = lowUnit ?? highUnit;
  if (!durationUnit) {
    return {};
  }

  const lowComparator = getQuantityComparator(low);
  const highComparator = getQuantityComparator(high);
  return {
    duration: low?.value,
    durationMax: high?.value,
    durationIsRange: true,
    durationUnit,
    durationMaxUnit: highUnit,
    durationUnitLabel: low?.unit,
    durationMaxUnitLabel: high?.unit,
    ...(lowComparator ? { durationComparator: lowComparator } : {}),
    ...(highComparator ? { durationMaxComparator: highComparator } : {})
  };
}

export function extractCanonicalDoseRange(
  range: FhirRange
): { range?: CanonicalDoseRange; unit?: string; warning?: string } {
  const canonicalRange: CanonicalDoseRange = {};
  const lowUnit = range.low?.unit ?? (range.low ? getDoseQuantityUnit(range.low) || undefined : undefined);
  const highUnit = range.high?.unit ?? (range.high ? getDoseQuantityUnit(range.high) || undefined : undefined);

  if (range.low?.value !== undefined) {
    canonicalRange.low = range.low.value;
  }
  if (range.high?.value !== undefined) {
    canonicalRange.high = range.high.value;
  }

  if (canonicalRange.low === undefined && canonicalRange.high === undefined) {
    return {};
  }

  // A unit-only endpoint is retained data, not the unit of the valued bound.
  const unit = canonicalRange.low === undefined ? highUnit
    : canonicalRange.high === undefined ? lowUnit : lowUnit ?? highUnit;
  let warning: string | undefined;
  if (lowUnit && highUnit && lowUnit !== highUnit) {
    warning = `FHIR doseRange low/high units differ (${lowUnit} vs ${highUnit}); preserved numeric bounds using ${unit}.`;
  }

  return {
    range: canonicalRange,
    unit,
    warning
  };
}

function appendWarning(warnings: string[] | undefined, warning: string | undefined): string[] | undefined {
  if (!warning) {
    return warnings;
  }
  if (!warnings) {
    return [warning];
  }
  warnings.push(warning);
  return warnings;
}

/** Shared FHIR terminology/source serializer for BOTH output versions.
 * This serializes coded context only; no course, dose or scheduling semantics
 * are read back from this interchange object. R5/R6 adapters own their own
 * quantity and timing choices around the same exact clinical code payload. */
export function serializeCanonicalContext(
  clause: CanonicalSigClause, options?: FhirProjectionOptions
): Pick<FhirDosage, "extension" | "route" | "site" | "method" |
  "additionalInstruction" | "asNeeded" | "asNeededFor" | "patientInstruction"> {
  const dosage: FhirDosage = {};
  const instructionGraphExtension = buildInstructionGraphExtension(clause.instructionGraph);
  if (instructionGraphExtension) {
    dosage.extension = [instructionGraphExtension];
  }
  const technique = instructionGraphAdministrationTechnique(clause);
  if (clause.route?.code || clause.route?.text) {
    const routeCode = clause.route?.code;
    const coding = routeCode ? ROUTE_SNOMED[routeCode] : undefined;
    const text = clause.route?.text ?? (routeCode ? ROUTE_TEXT[routeCode] : undefined);

    if (coding) {
      dosage.route = {
        text,
        coding: [
          {
            system: SNOMED_SYSTEM,
            code: coding.code,
            display: coding.display
          }
        ]
      };
    } else if (text) {
      dosage.route = { text };
    }
  }

  if (technique?.route) {
    dosage.route = {
      ...dosage.route,
      text: dosage.route?.text ?? technique.route.text,
      coding: [...(dosage.route?.coding ?? []), ...(technique.route.coding ?? [])]
    };
  }

  if (clause.site?.text || clause.site?.coding?.code || clause.site?.spatialRelation ||
      clause.site?.restrictions?.length) {
    const siteCoding = selectCanonicalSiteCoding(clause.site, options);
    // A typed site coordination carries its own bilingual constituent meaning.
    // Keep that meaning in the standard FHIR primitive translation extension
    // even when the caller did not request additional translation metadata:
    // FHIR has only one Dosage.site and cannot encode disjunction via codings.
    const siteTextElement = options?.includeTranslationExtensions ||
      (clause.administrationTargetGroup && clause.site?.i18n)
      ? buildTranslationPrimitiveElement(clause.site.i18n ?? siteCoding?.i18n)
      : undefined;
    const siteTargetCount =
      clause.site?.administrationTargetCount ??
      getBodySiteAdministrationTargetCount(clause.site);
    const inferredSiteTargetCount = getBodySiteAdministrationTargetCount({
      text: clause.site?.text,
      coding: siteCoding
        ? {
          code: siteCoding.code,
          display: siteCoding.display,
          system: siteCoding.system,
          i18n: siteCoding.i18n
        }
        : undefined
    });
    const siteTargetCountExtension =
      siteTargetCount !== undefined && siteTargetCount !== inferredSiteTargetCount
        ? buildBodySiteAdministrationTargetCountExtension(siteTargetCount)
        : undefined;
    const siteExtensions = [
      ...(buildBodySiteSpatialRelationExtensions(clause.site?.spatialRelation) ?? []),
      ...buildBodySiteRestrictionExtensions(clause.site?.restrictions),
      ...(siteTargetCountExtension ? [siteTargetCountExtension] : [])
    ];
    dosage.site = {
      text: clause.site?.text,
      ...(siteTextElement ? { _text: siteTextElement } : {}),
      coding: buildSiteCodingArray(siteCoding, options),
      extension: siteExtensions.length ? siteExtensions : undefined
    };
  }

  if (clause.method?.text || clause.method?._text || clause.method?.coding?.code) {
    dosage.method = {
      text: clause.method?.text,
      _text: clonePrimitiveElement(clause.method?._text),
      coding: clause.method?.coding?.code
        ? [
          {
            system: clause.method.coding.system ?? SNOMED_SYSTEM,
            code: clause.method.coding.code,
            display: clause.method.coding.display,
            _display: clonePrimitiveElement(clause.method.coding._display) ??
              buildTranslationPrimitiveElement(clause.method.coding.i18n)
          }
        ]
        : undefined
    };
  }

  if (technique?.method) {
    dosage.method = {
      ...dosage.method,
      coding: [...(dosage.method?.coding ?? []), ...(technique.method.coding ?? [])]
    };
  }

  const additionalInstructions: Array<{
    text: string;
    i18n?: Record<string, string>;
    coding?: { system?: string; code?: string; display?: string };
    hasTypedEvidence?: boolean;
    frames?: AdviceFrame[];
    coverage?: CanonicalInstructionCoverage;
  }> = [];
  for (const instruction of clause.additionalInstructions ?? []) {
    const text = instruction.text?.trim();
    if (!text) continue;
    let i18n = instruction.i18n;
    if (options?.includeTranslationExtensions && !i18n && !instruction.coding?.code && instruction.frames?.length === 1) {
      const labels: Array<Record<string, string> | undefined> = [];
      for (const frame of instruction.frames) {
        labels.push(frame.predicate.i18n);
        for (const arg of frame.args) labels.push(arg.i18n);
      }
      for (const locale of localeKeys(...labels)) {
        const translated = realizeInstructionAction(instruction.frames[0], locale, clause.instructionGraph);
        if (translated) (i18n ??= {})[locale] = translated;
      }
    }
    // The selected row occurrence is independent of complete source coverage.
    // In particular, uncoded negative advice must retain its exact action frame.
    let frames: AdviceFrame[] | undefined = !instruction.coding?.code && instruction.frames?.length
      ? instruction.frames : undefined;
    if (!frames && instruction.frames?.some(frame => frame.modality !== undefined ||
        frame.force === AdviceForce.Warning && frame.polarity !== AdvicePolarity.Negate)) {
      const recovered = instruction.coding?.code
        ? buildAdditionalInstructionFramesFromCoding(instruction.coding.system ?? SNOMED_SYSTEM,
          instruction.coding.code)
        : undefined;
      if (!recovered || instruction.frames.some(selected =>
          !recovered.some(template => sameTypedWarning(selected, template)))) frames = instruction.frames;
    }
    let coverage: CanonicalInstructionCoverage | undefined;
    if (!instruction.coding?.code && instruction.frames?.length &&
        instructionHasCompleteFrameEvidence(instruction)) {
      frames = instruction.frames;
      coverage = buildInstructionCoverage(frames, [], []);
    }
    const selected: typeof additionalInstructions[number] = {
      text,
      i18n,
      coding: instruction.coding,
      hasTypedEvidence: Boolean(instruction.evidence?.length),
      frames
    };
    if (coverage) selected.coverage = coverage;
    additionalInstructions.push(selected);
  }
  if (additionalInstructions.length) {
    dosage.additionalInstruction = [];
    for (const instruction of additionalInstructions) {
      // A typed, source-evidenced/coded adjunct carries authoritative localized
      // meaning even without a locale request. Preserve its standard FHIR
      // translation on default export. Loose untyped advice can contain an
      // incomplete machine-composed label; keep that original text-only unless
      // the caller explicitly requests translation extensions.
      const textElement = (options?.includeTranslationExtensions ||
        instruction.coding?.code || instruction.hasTypedEvidence) && instruction.i18n
        ? buildTranslationPrimitiveElement(instruction.i18n)
        : undefined;
      const projected: FhirCodeableConcept = { text: instruction.text };
      if (textElement) projected._text = textElement;
      projected.coding = instruction.coding?.code
        ? [{ system: instruction.coding.system ?? SNOMED_SYSTEM,
          code: instruction.coding.code, display: instruction.coding.display }]
        : undefined;
      // Retain selected warning facts that the coding template cannot recover.
      // The dosage graph owns the clause source; this row carries only its
      // own selected frames, including their exact modality and arguments.
      if (instruction.frames?.length) {
        const fields = instruction.frames.map(buildActionExtension);
        if (instruction.coverage) fields.push(buildInstructionCoverageExtension(instruction.coverage));
        projected.extension = [{ url: MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL, extension: fields }];
      }
      dosage.additionalInstruction.push(projected);
    }
  }

  if (clause.prn?.enabled) {
    dosage.asNeeded = true;
    const reasons = clause.prn.reasons?.length ? clause.prn.reasons : clause.prn.reason ? [clause.prn.reason] : [];
    if (reasons.length) {
      dosage.asNeededFor = [];
      for (const reason of reasons) {
        const concept: FhirCodeableConcept = {};
        if (reason.text) {
          concept.text = reason.text;
        }
        const reasonTextElement = options?.includeTranslationExtensions
          ? buildTranslationPrimitiveElement(reason.i18n ?? reason.coding?.i18n)
          : undefined;
        if (reasonTextElement) {
          concept._text = reasonTextElement;
        }
        if (reason.coding?.code) {
          const displayElement =
            options?.includeTranslationExtensions
              ? mergeTranslationPrimitiveElement(
                reason.coding._display,
                reason.coding.i18n
              )
              : clonePrimitiveElement(reason.coding._display);
          concept.coding = [
            {
              system: reason.coding.system ?? SNOMED_SYSTEM,
              code: reason.coding.code,
              display: reason.coding.display,
              ...(displayElement ? { _display: displayElement } : {}),
              extension: cloneExtensions(reason.coding.extension)
            }
          ];
        }
        const triggerExtension = prnTriggerPhaseExtension(reason.triggerPhase);
        const reasonExtensions = [
          ...(buildBodySiteSpatialRelationExtensions(reason.spatialRelation) ?? []),
          ...(triggerExtension ? [triggerExtension] : [])
        ];
        concept.extension = reasonExtensions.length ? reasonExtensions : undefined;
        dosage.asNeededFor.push(concept);
      }
    }
  }

  if (clause.patientInstruction) dosage.patientInstruction = clause.patientInstruction;
  return dosage;
}

/** Core Timing offsets require a nonnegative integer and a qualified event anchor. */
export function canUseCoreTimingOffset(when: readonly (string | null)[] | undefined, offset: number | undefined): boolean {
  if (offset === undefined || offset < 0 || !Number.isInteger(offset) || !when?.length) return false;
  let hasEvent = false;
  for (const event of when) {
    if (event === null) continue;
    if (event === EventTiming.Meal || event === EventTiming.Breakfast ||
        event === EventTiming.Lunch || event === EventTiming.Dinner) return false;
    hasEvent = true;
  }
  return hasEvent;
}

/** Shared wire Timing/source metadata serializer. This projects the already
 * scoped canonical schedule; it never parses or interprets external dosage.
 * R5 and current-R6 adapters independently choose their Quantity encodings. */
export function serializeCanonicalSchedule(
  schedule: CanonicalSigClause["schedule"], options?: FhirProjectionOptions,
  clinicalQuantity?: HpsgClinicalQuantityFeature, asNeeded = false
): Pick<FhirDosage, "timing" | "modifierExtension"> {
  const dosage: FhirDosage = {};
  const repeat: FhirTimingRepeat = {};
  let hasRepeat = false;
  if (schedule?.administrationOffsetMinutes !== undefined) {
    dosage.modifierExtension = [{
      url: ADMINISTRATION_OFFSET_EXTENSION_URL,
      valueQuantity: { value: schedule.administrationOffsetMinutes, unit: "min", code: "min", system: "http://unitsofmeasure.org" }
    }];
  }

  if (schedule?.calendarEvents?.length) {
    dosage.timing = {
      ...(dosage.timing ?? {}),
      event: schedule.calendarEvents.map((event) => event.fhirDateTime ?? event.isoDate),
      _event: schedule.calendarEvents.map(calendarEventPrimitive)
    };
  }
  if (schedule?.boundsStart || schedule?.boundsEnd) {
    repeat.boundsPeriod = {
      ...(schedule.boundsStart ? { start: schedule.boundsStart } : {}),
      ...(schedule.boundsEnd ? { end: schedule.boundsEnd } : {})
    };
    hasRepeat = true;
  }

  if (schedule?.frequency !== undefined && schedule.frequency > 0) {
    repeat.frequency = schedule.frequency;
    hasRepeat = true;
  } else if (schedule?.frequency === 0) {
    repeat.extension = [
      ...(repeat.extension ?? []),
      { url: TIMING_FREQUENCY_MIN_EXTENSION_URL, valueInteger: 0 }
    ];
    hasRepeat = true;
  }
  if (schedule?.count !== undefined) {
    repeat.count = schedule.count;
    hasRepeat = true;
  }
  if (schedule?.countMax !== undefined) {
    repeat.countMax = schedule.countMax;
    hasRepeat = true;
  }
  if (schedule?.administrationDurationRange) {
    const { low, high, ...metadata } = schedule.administrationDurationRange;
    repeat.extension = [...(repeat.extension ?? []), {
      url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL,
      valueRange: { ...metadata, ...(low ? { low: simpleQuantityForR5(low) } : {}),
        ...(high ? { high: simpleQuantityForR5(high) } : {}) }
    }];
    hasRepeat = true;
  } else if (schedule && (schedule.administrationDuration !== undefined || schedule.administrationDurationMax !== undefined) &&
      schedule.administrationDurationUnit && !schedule.administrationDurationComparator) {
    if (schedule.administrationDuration !== undefined) repeat.duration = schedule.administrationDuration;
    repeat.durationUnit = schedule.administrationDurationUnit;
    if (schedule.administrationDurationMax !== undefined) {
      repeat.durationMax = schedule.administrationDurationMax;
    }
    hasRepeat = true;
  } else if (schedule?.administrationDuration !== undefined && schedule.administrationDurationUnit &&
      schedule.administrationDurationComparator &&
      !(clinicalQuantity?.representation === "dose-with-rate-ratio" &&
        clinicalQuantity.administrationDuration?.value === schedule.administrationDuration &&
        clinicalQuantity.administrationDuration.unit === schedule.administrationDurationUnit &&
        clinicalQuantity.administrationDuration.comparator === schedule.administrationDurationComparator &&
        schedule.administrationDurationMax === undefined)) {
    // Share the carrier denominator only when it carries this exact duration.
    // A distinct authored occurrence duration remains independently editable.
    repeat.extension = [...(repeat.extension ?? []), {
      url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL,
      ...(schedule.administrationDurationMax !== undefined ? {
        valueRange: buildFhirBoundsRange(schedule.administrationDuration, schedule.administrationDurationMax,
          schedule.administrationDurationUnit, schedule.administrationDurationComparator)
      } : {
        valueQuantity: buildFhirDurationQuantity(schedule.administrationDuration,
          schedule.administrationDurationUnit, schedule.administrationDurationComparator)
      })
    }];
    hasRepeat = true;
  }
  // Timing permits one bounds[x]. Keep absolute bounds in boundsPeriod and
  // retain the authored duration/range as a typed modifier for exact execution
  // and editing, including partial days that have no date-only endpoint.
  if (schedule?.durationUnit && (schedule.duration !== undefined || schedule.durationMax !== undefined)) {
    const ranged = schedule.durationIsRange || schedule.durationMax !== undefined &&
      (schedule.durationMax !== schedule.duration ||
        schedule.durationMaxUnit !== undefined && schedule.durationMaxUnit !== schedule.durationUnit ||
        schedule.durationComparator !== undefined ||
        schedule.durationMaxComparator !== undefined);
    const duration = ranged ? undefined : buildFhirDurationQuantity(
      schedule.duration!, schedule.durationUnit, schedule.durationComparator, schedule.durationUnitLabel);
    const range = ranged ? buildFhirBoundsRange(
      schedule.duration, schedule.durationMax, schedule.durationUnit,
      schedule.durationComparator, schedule.durationMaxComparator, schedule.durationMaxUnit,
      schedule.durationUnitLabel, schedule.durationMaxUnitLabel) : undefined;
    const projection = range && projectCourseDurationRange(range);
    if (repeat.boundsPeriod || projection?.source) {
      const source = projection?.source;
      dosage.modifierExtension = [...(dosage.modifierExtension ?? []), source ? {
        ...source, extension: repeat.boundsPeriod
          ? source.extension!.filter(child => child.url !== "projectedRange") : source.extension,
      } : {
        url: ANCHORED_COURSE_DURATION_EXTENSION_URL,
        ...(range ? { valueRange: range } : { valueQuantity: duration! }),
      }];
    }
    if (!repeat.boundsPeriod) {
      if (projection) repeat.boundsRange = projection.range;
      else repeat.boundsDuration = duration;
    }
    hasRepeat = true;
  }
  if (schedule?.frequencyMax !== undefined) {
    repeat.frequencyMax = schedule.frequencyMax;
    hasRepeat = true;
  }
  if (schedule?.periodUnit && (schedule.period !== undefined || schedule.periodMax !== undefined)) {
    if (schedule.period !== undefined) repeat.period = schedule.period;
    repeat.periodUnit = schedule.periodUnit;
    hasRepeat = true;
  }
  if (schedule?.periodMax !== undefined) {
    repeat.periodMax = schedule.periodMax;
    hasRepeat = true;
  }
  if (schedule?.offset !== undefined) {
    if (canUseCoreTimingOffset(schedule.when, schedule.offset)) {
      repeat.offset = schedule.offset;
    } else {
      repeat.extension = [
        ...(repeat.extension ?? []),
        timingOffsetExtension(TIMING_OFFSET_EXACT_EXTENSION_URL, schedule.offset)
      ];
    }
    hasRepeat = true;
  }
  if (schedule?.offsetMin !== undefined) {
    repeat.extension = [
      ...(repeat.extension ?? []),
      timingOffsetExtension(TIMING_OFFSET_MIN_EXTENSION_URL, schedule.offsetMin)
    ];
    hasRepeat = true;
  }
  if (schedule?.offsetMax !== undefined) {
    repeat.extension = [
      ...(repeat.extension ?? []),
      timingOffsetExtension(TIMING_OFFSET_MAX_EXTENSION_URL, schedule.offsetMax)
    ];
    hasRepeat = true;
  }
  if (schedule?.dayOfWeek?.length) {
    repeat.dayOfWeek = [...schedule.dayOfWeek];
    hasRepeat = true;
  }
  if (schedule?.dayOfMonth?.length) {
    repeat.extension = [
      ...(repeat.extension ?? []),
      ...schedule.dayOfMonth.map(day => ({
        url: TIMING_DAY_OF_MONTH_EXTENSION_URL, valuePositiveInt: day
      }))
    ];
    hasRepeat = true;
  }

  if (schedule?.when?.length) {
    repeat.when = [...schedule.when];
    hasRepeat = true;
  }
  if (schedule?.timeOfDay?.length) {
    repeat.timeOfDay = [...schedule.timeOfDay];
    hasRepeat = true;
  }
  if (schedule?.clockWindow) {
    repeat.extension = [...(repeat.extension ?? []), {
      url: TIMING_CLOCK_WINDOW_EXTENSION_URL, extension: [
        { url: "start", valueTime: schedule.clockWindow.start },
        { url: "end", valueTime: schedule.clockWindow.end },
        { url: "endInclusive", valueBoolean: schedule.clockWindow.endInclusive }
      ]
    }];
    hasRepeat = true;
  }
  if (schedule?.weekdayOrdinal !== undefined) {
    repeat.extension = [...(repeat.extension ?? []), {
      url: TIMING_WEEKDAY_ORDINAL_EXTENSION_URL, valueInteger: schedule.weekdayOrdinal
    }];
    hasRepeat = true;
  }
  if (schedule?.eventWindow) {
    repeat.extension = [
      ...(repeat.extension ?? []),
      { url: TIMING_EVENT_WINDOW_EXTENSION_URL, extension: [
        { url: "start", valueCode: schedule.eventWindow.start },
        { url: "end", valueCode: schedule.eventWindow.end }
      ] }
    ];
    hasRepeat = true;
  }
  if (schedule?.activityTiming?.length) {
    repeat.extension = [
      ...(repeat.extension ?? []),
      ...schedule.activityTiming.map((item) => buildActivityTimingExtension(item, options))
    ];
    hasRepeat = true;
  }
  if (schedule?.sharedCount) {
    repeat.extension = [...(repeat.extension ?? []), buildSharedCountExtension(schedule.sharedCount)];
    hasRepeat = true;
  }
  if (schedule?.occurrenceCap) {
    repeat.extension = [
      ...(repeat.extension ?? []),
      buildOccurrenceCapExtension(schedule.occurrenceCap)
    ];
    hasRepeat = true;
  }

  if (!asNeeded) normalizeClockFrequency(repeat);
  if (hasRepeat) {
    dosage.timing = {
      ...(dosage.timing ?? {}),
      repeat
    };
  }

  if (schedule?.timingCode || schedule?.timingText) {
    dosage.timing = dosage.timing ?? {};
    const timingCoding = standardTimingCodingFromSig(schedule.timingCode);
    // A CodeableConcept.text preserves supported local wording without
    // falsely attaching an HL7 standard identity to non-standard codes.
    dosage.timing.code = timingCoding
      ? { coding: [timingCoding],
          text: schedule.timingText ?? schedule.timingCode }
      : { text: schedule.timingText ?? schedule.timingCode };
  }

  return dosage;
}


/** Project only independent typed warnings; related actions keep their graph scope.
 * Existing standard entries are never rewritten or removed. Generated wording
 * comes from the selected action/arguments, not the graph's authored source.
 */
export function independentGraphWarningAdvice(
  graph: CanonicalInstructionGraph | undefined,
  typed: readonly CanonicalAdditionalInstructionExpr[] | undefined
): FhirCodeableConcept[] | undefined {
  if (!graph?.actions.length) return undefined;
  let referenced: Set<number> | undefined;
  let represented: Set<number> | undefined;
  let projected: FhirCodeableConcept[] | undefined;
  for (let index = 0; index < graph.actions.length; index += 1) {
    const action = graph.actions[index];
    if (action.polarity !== AdvicePolarity.Negate && action.force !== AdviceForce.Warning) continue;
    if (graph.relations?.length) {
      if (!referenced) {
        referenced = new Set();
        for (const relation of graph.relations) {
          referenced.add(relation.toActionIndex);
          if (relation.fromActionIndex !== undefined) referenced.add(relation.fromActionIndex);
        }
      }
      if (referenced.has(index)) continue;
    }
    if (!represented) {
      represented = new Set();
      for (const instruction of typed ?? []) {
        for (const actionIndex of instructionGraphAdviceAssociation(graph, instruction, true).representedActionIndices)
          represented.add(actionIndex);
      }
    }
    if (represented.has(index)) continue;
    const locale = graph.sourceLocale ?? "en";
    const text = getAdviceLocaleAdapter(locale).finalize(
      realizeInstructionAction({ ...action, sourceText: "" }, locale));
    if (text) (projected ??= []).push({
      text,
      extension: [{ url: MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL,
        extension: [buildActionExtension(action)] }]
    });
  }
  return projected;
}

export function canonicalToFhir(
  clause: CanonicalSigClause,
  textOverride?: string,
  options?: FhirProjectionOptions
): FhirDosage {
  const dosage: FhirDosage = { ...serializeCanonicalContext(clause, options),
    ...(options?.sequence !== undefined ? { sequence: options.sequence } : {})
  };
  const warnings = independentGraphWarningAdvice(clause.instructionGraph, clause.additionalInstructions);
  if (warnings) dosage.additionalInstruction = [...(dosage.additionalInstruction ?? []), ...warnings];
  const schedule = clause.schedule;
  Object.assign(dosage, serializeCanonicalSchedule(schedule, options, clause.clinicalQuantity, clause.prn?.enabled));
  if (schedule?.countMax !== undefined && dosage.timing?.repeat)
    dosage.timing.repeat = withTimingCountMinimum(dosage.timing.repeat);
  if (schedule?.administrationDurationMax !== undefined && dosage.timing?.repeat)
    dosage.timing.repeat = withTimingDurationMinimum(dosage.timing.repeat);
  if (schedule?.periodMax !== undefined && dosage.timing?.repeat)
    dosage.timing.repeat = withTimingPeriodMinimum(dosage.timing.repeat);
  if (schedule?.maxDosePerPeriod?.length) {
    dosage.maxDosePerPeriod = schedule.maxDosePerPeriod.map((maximum) => {
      const numerator = buildFhirDoseQuantity(maximum.amount, maximum.unit);
      const denominator = {
        value: maximum.period,
        unit: maximum.periodUnit,
        system: UCUM_SYSTEM,
        code: maximum.periodUnit
      };
      return {
        numerator: maximum.amountComparator
          ? quantityForR5({ ...numerator, comparator: maximum.amountComparator })!
          : numerator,
        denominator: maximum.periodComparator
          ? simpleQuantityForR5({ ...denominator, comparator: maximum.periodComparator })!
          : denominator
      };
    });
  }

  if (clause.dose?.range) {
    const doseRange = buildFhirDoseRange(clause.dose.range, clause.dose.unit);
    if (doseRange) {
      dosage.doseAndRate = [
        {
          doseRange
        }
      ];
    }
  } else if (clause.dose?.value !== undefined) {
    dosage.doseAndRate = [
      {
        doseQuantity: buildFhirDoseQuantity(clause.dose.value, clause.dose.unit, clause.dose.comparator)
      }
    ];
  }

  // HPSG produces the dimensional meaning; FHIR simply lowers that typed
  // value. Safety checks must never reparse and overwrite clinical dosage.
  if (clause.clinicalQuantity)
    projectHpsgClinicalQuantityToFhir(dosage, clause.clinicalQuantity);
  if (clause.dose?.comparator || clause.clinicalQuantity?.numerator.comparator ||
      clause.clinicalQuantity?.projectedDose?.comparator || clause.clinicalQuantity?.rateNumerator?.comparator ||
      clause.clinicalQuantity?.administrationDuration?.comparator)
    attachQualifiedR5AmountDetails(dosage);

  // The HPSG clinical scope is already resolved in CanonicalSigClause.
  // FHIR projects it exactly once; it must never decide which daughter
  // receives an administration condition or calendar exclusion.
  if (clause.schedule?.cycleDayConstraint) {
    dosage.modifierExtension = [...(dosage.modifierExtension ?? []),
      cycleDayConstraintExtension(clause.schedule.cycleDayConstraint)];
  }
  const adjunct = clause.clinicalAdjuncts;
  if (adjunct?.condition) setDosageCondition(dosage, adjunct.condition, adjunct.calendarDayCondition);
  if (adjunct?.excludedDates?.length) {
    setDosageExcludedDates(dosage, adjunct.excludedDates);
  }
  if (adjunct?.excludedWeekdays?.length) {
    setDosageExcludedWeekdays(dosage, adjunct.excludedWeekdays);
  }

  const longText = textOverride ?? formatCanonicalClause(clause, "long");
  if (longText) {
    dosage.text = longText;
  }
  if (clause.patientInstruction) {
    dosage.patientInstruction = clause.patientInstruction;
  }
  const repeat = dosage.timing?.repeat;
  if (repeat?.when?.length && repeat.timeOfDay?.length)
    dosage.timing!.repeat = projectTimingClocks(repeat);

  return dosage;
}

export function toFhir(state: ParserState): FhirDosage {
  const clauses = state.clauses;
  const clause = clauses[0] ?? createEmptyCanonicalClause(state.input);
  return canonicalToFhir(clause);
}

/** Recover local FHIR Timing.code.text only when it is a recognizable
 * abbreviation, not arbitrary prose. Coding identities always take priority.
 */
const TIMING_ABBREVIATION_TEXT = /^(?:C|BID|TID|QID|QD|QOD|AM|PM|QAM|QPM|QHS|BLD|BED|WK|MO|Q\d+(?:MIN|H|HR|D|WK|W|MO|Y))$/iu;
function timingCodeFromFhir(dosage: FhirDosage, coding: FhirCoding | undefined): string | undefined {
  if (coding) return isPreviewTimingCoding(coding) ? timingCodeMeaning(coding) : undefined;
  const raw = dosage.timing?.code?.text?.trim();
  return raw && TIMING_ABBREVIATION_TEXT.test(raw) ? raw.toUpperCase() : undefined;
}

function timingTextFromFhir(dosage: FhirDosage, coding: FhirCoding | undefined): string | undefined {
  return dosage.timing?.code?.text ?? (coding
    ? !isPreviewTimingCoding(coding) ? coding.display ?? coding.code : undefined
    : codeLessTimingDisplay(dosage.timing));
}

/** Restore explicitly supplied clinical guards without reparsing dosage text.
 * @param dosage Editable FHIR dosage; native values take precedence in the shared getters.
 */
function clinicalAdjunctsFromFhir(dosage: FhirDosage): CanonicalSigClause["clinicalAdjuncts"] {
  const condition = getDosageCondition(dosage);
  const calendarDayCondition = getDosageCalendarDayCondition(dosage);
  const excludedDates = getDosageExcludedDates(dosage);
  const excludedWeekdays = getDosageExcludedWeekdays(dosage);
  if (!condition && !excludedDates.length && !excludedWeekdays.length) return undefined;
  return {
    ...(condition ? { condition } : {}),
    ...(calendarDayCondition ? { calendarDayCondition } : {}),
    ...(excludedDates.length ? { excludedDates } : {}),
    ...(excludedWeekdays.length ? { excludedWeekdays } : {})
  };
}

/** Decode common coded source annotations for either FHIR version.
 * No dose, rate, Timing, course, or compatibility marker is interpreted here.
 * Native-course import supplies an R6 CodeableReference's concept explicitly. */
export function deserializeCanonicalContext(
  dosage: Pick<FhirR6Dosage, "text" | "route" | "method" | "asNeeded" |
    "asNeededFor" | "additionalInstruction" | "patientInstruction" | "extension"> & { site?: FhirR6CodeableConcept },
  options?: ParseOptions
): CanonicalSigClause {
  const rawText = dosage.text ?? "";
  const clause = createEmptyCanonicalClause(rawText);
  clause.instructionGraph = parseInstructionGraphExtension(dosage.extension);
  const routeCode = routeCodeFromCodings(dosage.route?.coding);
  const routeText = dosage.route?.text ?? (!routeCode
    ? dosage.route?.coding?.find(coding => coding.display)?.display : undefined);
  if (routeCode || routeText) {
    clause.route = {
      code: routeCode,
      text: routeText ?? (routeCode ? ROUTE_TEXT[routeCode] : undefined)
    };
  }

  const siteCoding = selectPreferredSiteCoding(dosage.site);
  const siteSpatialRelation = parseBodySiteSpatialRelationExtension(dosage.site);
  const siteRestrictions = parseBodySiteRestrictionExtensions(dosage.site);
  const siteText = getFallbackSiteText(dosage.site);
  const siteI18n = codeableConceptTranslationI18n(dosage.site, siteCoding);
  const siteAdministrationTargetCount = getBodySiteAdministrationTargetCount(dosage.site);
  if (
    siteText ||
    siteCoding?.code ||
    siteSpatialRelation ||
    siteRestrictions?.length ||
    siteAdministrationTargetCount !== undefined
  ) {
    clause.site = {
      text: siteText,
      i18n: siteI18n.text,
      spatialRelation: siteSpatialRelation,
      restrictions: siteRestrictions,
      administrationTargetCount: siteAdministrationTargetCount,
      coding: siteCoding?.code
        ? {
          code: siteCoding.code,
          display: siteCoding.display,
          system: siteCoding.system,
          i18n: siteI18n.display
        }
        : undefined,
      source: "text"
    };
  }

  const methodCoding = selectMedicationInstructionMethodCoding(dosage.method?.coding, options);
  if (dosage.method?.text || dosage.method?._text || methodCoding?.code || methodCoding?.display) {
    const action = resolveMedicationInstructionActionForMethod({
      text: dosage.method?.text, coding: methodCoding
    }, options);
    const authoredText = dosage.method?.text;
    const compatibleText = authoredText && (!action || action.display === authoredText ||
      resolveMedicationInstructionActionForMethod({ text: authoredText }, options)?.code === action.code);
    const methodText = compatibleText ? authoredText : action?.display ?? authoredText ?? methodCoding?.display;
    clause.method = {
      text: methodText,
      // Wire primitive metadata is immutable and can be retained intact.
      _text: methodText === dosage.method?.text ? dosage.method?._text : undefined,
      coding: methodCoding?.code
        ? {
          code: methodCoding.code,
          display: methodCoding.display,
          system: methodCoding.system,
          _display: clonePrimitiveElement(methodCoding._display),
          i18n: getPrimitiveTranslations(methodCoding._display)
        }
        : undefined
    };
  }

  let hasPrnReason = false;
  const prnReasons = dosage.asNeededFor?.length
    ? dosage.asNeededFor.map((concept) => {
      const reason = canonicalPrnReasonFromConcept(concept);
      if (reason.text || reason.coding?.code || reason.i18n) hasPrnReason = true;
      return reason;
    })
    : undefined;
  const primaryReason = prnReasons?.[0];
  const asNeeded = dosage.asNeeded ??
    (dosage as FhirDosage & { asNeededBoolean?: boolean }).asNeededBoolean;
  if (asNeeded || hasPrnReason) {
    clause.prn = {
      enabled: Boolean(asNeeded || hasPrnReason),
      reason:
        prnReasons?.length === 1
          ? primaryReason
          : prnReasons?.length
            ? { text: joinCanonicalPrnReasonTexts(prnReasons) }
            : undefined,
      reasons: prnReasons?.length ? prnReasons : undefined
    };
  }

  if (dosage.additionalInstruction?.length) {
    clause.additionalInstructions = [];
    for (const instruction of dosage.additionalInstruction) {
      const coding = instruction.coding?.find((code) => Boolean(code.code));
      const text = additionalInstructionFallbackText(instruction, coding);
      const ownedGraph = instruction.extension
        ? parseInstructionGraphExtension(instruction.extension) : undefined;
      const ownedFrames = ownedGraph?.actions;
      const selected: CanonicalAdditionalInstructionExpr = {
        text,
        i18n: codeableConceptTranslationI18n(instruction, coding).text,
        coding: coding?.code
          ? {
            code: coding.code,
            display: coding.display,
            system: coding.system,
            version: coding.version
          }
          : undefined,
        frames: ownedFrames?.length ? ownedFrames : coding?.code
          ? buildAdditionalInstructionFramesFromCoding(
            coding.system ?? SNOMED_SYSTEM,
            coding.code,
            text ?? coding.display ?? "",
            clause.raw
          )
          : undefined
      };
      const evidence = rowInstructionEvidence(ownedGraph);
      if (evidence) selected.evidence = evidence;
      clause.additionalInstructions.push(selected);
    }
  }

  if (dosage.patientInstruction) {
    clause.patientInstruction = dosage.patientInstruction;
  }

  return clause;
}

/** The row codec carries current selected frames and their complete coverage. */
function rowInstructionEvidence(graph: CanonicalInstructionGraph | undefined): CanonicalAdditionalInstructionExpr["evidence"] {
  if (!graph?.coverage?.complete || !graph.actions.length) return undefined;
  return [{
    rule: "fhir.additional-instruction-graph",
    lexicalCategory: "instruction",
    spans: graph.actions.map(frame => ({ ...frame.span, text: frame.sourceText }))
  }];
}

export function canonicalFromFhir(dosage: FhirDosage, options?: ParseOptions): CanonicalSigClause {
  const clause = deserializeCanonicalContext(dosage, options);
  clause.clinicalAdjuncts = clinicalAdjunctsFromFhir(dosage);
  const repeat = dosage.timing?.repeat;
  const timingCoding = dosage.timing && preferredTimingCoding(dosage.timing);
  const timingCode = timingCodeFromFhir(dosage, timingCoding);
  const timingText = timingTextFromFhir(dosage, timingCoding);
  const timingTextIsLiteral = (timingCoding ? !isPreviewTimingCoding(timingCoding) :
    dosage.timing?.code?.text === undefined && timingText !== undefined) ? true : undefined;
  const administrationDurationMarker = repeat?.extension?.find(
    extension => extension.url === TIMING_ADMINISTRATION_DURATION_EXTENSION_URL);
  const administrationDuration = parseTimingAdministrationDuration(administrationDurationMarker, repeat);
  const frequencyMinExtension = repeat?.extension?.find(
    (extension) => extension.url === TIMING_FREQUENCY_MIN_EXTENSION_URL
  )?.valueInteger;
  const offsetExactExtension = timingOffsetExtensionValue(
    repeat,
    TIMING_OFFSET_EXACT_EXTENSION_URL
  );
  const offsetMinExtension = timingOffsetExtensionValue(repeat, TIMING_OFFSET_MIN_EXTENSION_URL);
  const offsetMaxExtension = timingOffsetExtensionValue(repeat, TIMING_OFFSET_MAX_EXTENSION_URL);
  const timingBounds = extractCanonicalTimingBounds(dosage);
  const activityTiming = parseActivityTimingExtensions(repeat);
  const clocks = getTimingClocks(repeat);
  const clockWindow = getTimingClockWindow(repeat);
  const weekdayOrdinal = getTimingWeekdayOrdinal(repeat);
  const dayOfMonth = getTimingMonthDays(repeat);
  const eventWindow = getTimingEventWindow(repeat);
  const occurrenceCap = getTimingOccurrenceCap(repeat);
  const sharedCount = getTimingSharedCount(repeat);
  const cycleDayConstraint = getCycleDayConstraint(dosage);
  const maxDosePerPeriod = canonicalDosePeriodMaximums(dosage);
  const administrationOffsetMinutes = getAdministrationOffsetMinutes(dosage);
  if (
    administrationOffsetMinutes !== undefined ||
    timingBounds.duration !== undefined || timingBounds.durationMax !== undefined ||
    timingCode || timingText ||
    repeat?.count !== undefined ||
    repeat?.countMax !== undefined ||
    activityTiming?.length ||
    clockWindow !== undefined ||
    weekdayOrdinal !== undefined ||
    dayOfMonth !== undefined ||
    eventWindow !== undefined ||
    cycleDayConstraint !== undefined ||
    occurrenceCap !== undefined || sharedCount !== undefined ||
    maxDosePerPeriod?.length ||
    repeat?.boundsDuration ||
    repeat?.boundsPeriod?.start ||
    repeat?.boundsPeriod?.end ||
    repeat?.boundsRange ||
    repeat?.duration !== undefined ||
    administrationDuration !== undefined ||
    repeat?.durationMax !== undefined ||
    repeat?.durationUnit !== undefined ||
    repeat?.frequency !== undefined ||
    frequencyMinExtension !== undefined ||
    repeat?.frequencyMax !== undefined ||
    repeat?.period !== undefined ||
    repeat?.periodMax !== undefined ||
    repeat?.periodUnit ||
    repeat?.offset !== undefined ||
    offsetExactExtension !== undefined ||
    offsetMinExtension !== undefined ||
    offsetMaxExtension !== undefined ||
    repeat?.dayOfWeek?.length ||
    repeat?.when?.length ||
    clocks?.length ||
    dosage.timing?.event?.length
  ) {
    clause.schedule = {
      cycleDayConstraint,
      administrationOffsetMinutes,
      timingCode,
      timingText,
      timingTextIsLiteral,
      count: repeat?.count,
      countMax: repeat?.countMax,
      duration: timingBounds.duration,
      durationMax: timingBounds.durationMax,
      durationIsRange: timingBounds.durationIsRange,
      durationUnit: timingBounds.durationUnit,
      durationMaxUnit: timingBounds.durationMaxUnit,
      durationUnitLabel: timingBounds.durationUnitLabel,
      durationMaxUnitLabel: timingBounds.durationMaxUnitLabel,
      durationComparator: timingBounds.durationComparator,
      durationMaxComparator: timingBounds.durationMaxComparator,
      boundsStart: repeat?.boundsPeriod?.start,
      boundsEnd: repeat?.boundsPeriod?.end,
      administrationDuration: administrationDuration?.range ? undefined : repeat?.duration ?? administrationDuration?.value,
      administrationDurationMax: administrationDuration?.range ? undefined : repeat?.durationMax,
      administrationDurationRange: administrationDuration?.range,
      administrationDurationUnit: administrationDuration?.unit ?? repeat?.durationUnit,
      administrationDurationComparator: administrationDuration?.comparator,
      frequency: repeat?.frequency ?? frequencyMinExtension,
      frequencyMax: repeat?.frequencyMax,
      period: repeat?.period,
      periodMax: repeat?.periodMax,
      periodUnit: repeat?.periodUnit,
      offset: repeat?.offset ?? offsetExactExtension,
      offsetMin: offsetMinExtension,
      offsetMax: offsetMaxExtension,
      activityTiming,
      clockWindow,
      weekdayOrdinal,
      eventWindow,
      occurrenceCap,
      maxDosePerPeriod,
      dayOfWeek: repeat?.dayOfWeek?.filter((day): day is FhirDayOfWeek => day !== null),
      dayOfMonth,
      when: repeat?.when?.filter((event): event is EventTiming => event !== null),
      timeOfDay: clocks ? [...clocks] : undefined,
      calendarEvents: dosage.timing?.event
        ?.map((value, index) => calendarEventFromFhir(value, dosage.timing?._event?.[index]))
        .filter((event): event is CanonicalCalendarEventExpr => Boolean(event))
    };
    if (sharedCount) clause.schedule.sharedCount = sharedCount;
    clause.warnings = appendWarning(clause.warnings, timingBounds.warning);
  }

  const doseAndRate = dosage.doseAndRate?.[0];
  if (doseAndRate?.doseRange) {
    const extracted = extractCanonicalDoseRange(doseAndRate.doseRange);
    if (extracted.range) {
      clause.dose = {
        range: extracted.range,
        unit: extracted.unit
      };
      clause.warnings = appendWarning(clause.warnings, extracted.warning);
    }
  } else if (doseAndRate?.doseQuantity?.value !== undefined) {
    const comparator = getQuantityComparator(doseAndRate.doseQuantity);
    const unitIdentity = clause.site || doseAndRate.doseQuantity.unit == null
      ? getDoseQuantityUnit(doseAndRate.doseQuantity) || undefined : undefined;
    clause.dose = {
      value: doseAndRate.doseQuantity.value,
      unit: doseAndRate.doseQuantity.unit ?? unitIdentity,
      unitIdentity,
      ...(comparator ? { comparator } : {})
    };
  }

  const carrierQuantity = clinicalCarrierQuantityFromFhir(dosage);
  if (carrierQuantity) {
    clause.clinicalQuantity = carrierQuantity;
    const duration = carrierQuantity.administrationDuration;
    if (!administrationDurationMarker && duration?.comparator && clause.schedule?.administrationDuration === undefined &&
        clause.schedule?.administrationDurationMax === undefined) {
      const schedule = clause.schedule ??= {};
      schedule.administrationDuration = duration.value;
      schedule.administrationDurationUnit = duration.unit;
      schedule.administrationDurationComparator = duration.comparator;
    }
  }


  return clause;
}

export function parserStateFromFhir(dosage: FhirDosage, options?: ParseOptions): ParserState {
  const state = new ParserState(dosage.text ?? "", []);
  state.primaryClause.clinicalAdjuncts = clinicalAdjunctsFromFhir(dosage);
  const timingBounds = extractCanonicalTimingBounds(dosage);
  const clocks = getTimingClocks(dosage.timing?.repeat);
  state.timeOfDay = clocks ? [...clocks] : [];
  if (dosage.timing?.event?.length) {
    state.primaryClause.schedule = {
      ...(state.primaryClause.schedule ?? {}),
      calendarEvents: dosage.timing.event
        .map((value, index) => calendarEventFromFhir(value, dosage.timing?._event?.[index]))
        .filter((event): event is CanonicalCalendarEventExpr => Boolean(event))
    };
  }
  const timingCoding = dosage.timing && preferredTimingCoding(dosage.timing);
  state.timingCode = timingCodeFromFhir(dosage, timingCoding);
  const timingText = timingTextFromFhir(dosage, timingCoding);
  if (timingText !== undefined) {
    const schedule = state.primaryClause.schedule ??= {};
    schedule.timingText = timingText;
    schedule.timingTextIsLiteral = (timingCoding ? !isPreviewTimingCoding(timingCoding) :
    dosage.timing?.code?.text === undefined && timingText !== undefined) ? true : undefined;
  }
  state.count = dosage.timing?.repeat?.count;
  state.countMax = dosage.timing?.repeat?.countMax;
  state.duration = timingBounds.duration;
  state.durationMax = timingBounds.durationMax;
  state.durationUnit = timingBounds.durationUnit;
  if (timingBounds.durationIsRange || timingBounds.durationMaxUnit || timingBounds.durationComparator ||
      timingBounds.durationMaxComparator || timingBounds.durationUnitLabel !== undefined) {
    state.primaryClause.schedule = {
      ...state.primaryClause.schedule,
      durationMaxUnit: timingBounds.durationMaxUnit,
      durationUnitLabel: timingBounds.durationUnitLabel,
      durationMaxUnitLabel: timingBounds.durationMaxUnitLabel,
      ...(timingBounds.durationIsRange ? { durationIsRange: true } : {}),
      ...(timingBounds.durationComparator
        ? { durationComparator: timingBounds.durationComparator } : {}),
      ...(timingBounds.durationMaxComparator
        ? { durationMaxComparator: timingBounds.durationMaxComparator } : {})
    };
  }
  if (dosage.timing?.repeat?.boundsPeriod?.start || dosage.timing?.repeat?.boundsPeriod?.end) {
    state.primaryClause.schedule = {
      ...(state.primaryClause.schedule ?? {}),
      boundsStart: dosage.timing.repeat.boundsPeriod.start,
      boundsEnd: dosage.timing.repeat.boundsPeriod.end
    };
  }
  const repeat = dosage.timing?.repeat;
  const administrationDurationMarker = repeat?.extension?.find(
    extension => extension.url === TIMING_ADMINISTRATION_DURATION_EXTENSION_URL);
  const administrationDuration = parseTimingAdministrationDuration(administrationDurationMarker, repeat);
  if (repeat?.duration !== undefined && repeat.durationUnit || administrationDuration) {
    state.primaryClause.schedule = {
      ...(state.primaryClause.schedule ?? {}),
      administrationDuration: administrationDuration?.range ? undefined : repeat?.duration ?? administrationDuration?.value,
      administrationDurationMax: administrationDuration?.range ? undefined : repeat?.durationMax,
      administrationDurationRange: administrationDuration?.range,
      administrationDurationUnit: administrationDuration?.unit ?? repeat?.durationUnit,
      administrationDurationComparator: administrationDuration?.comparator
    };
  }
  state.frequency = repeat?.frequency ?? repeat?.extension?.find(
    extension => extension.url === TIMING_FREQUENCY_MIN_EXTENSION_URL)?.valueInteger;
  state.frequencyMax = dosage.timing?.repeat?.frequencyMax;
  state.period = dosage.timing?.repeat?.period;
  state.periodMax = dosage.timing?.repeat?.periodMax;
  state.periodUnit = dosage.timing?.repeat?.periodUnit;
  state.offset = getExactTimingOffsetMinutes(dosage.timing?.repeat);
  state.offsetMin = timingOffsetExtensionValue(dosage.timing?.repeat, TIMING_OFFSET_MIN_EXTENSION_URL);
  state.offsetMax = timingOffsetExtensionValue(dosage.timing?.repeat, TIMING_OFFSET_MAX_EXTENSION_URL);
  state.activityTiming = parseActivityTimingExtensions(dosage.timing?.repeat);
  const clockWindow = getTimingClockWindow(dosage.timing?.repeat);
  if (clockWindow) state.primaryClause.schedule = { ...(state.primaryClause.schedule ?? {}), clockWindow };
  const dayOfMonth = getTimingMonthDays(dosage.timing?.repeat);
  if (dayOfMonth) {
    state.primaryClause.schedule = { ...(state.primaryClause.schedule ?? {}), dayOfMonth };
  }
  const weekdayOrdinal = getTimingWeekdayOrdinal(dosage.timing?.repeat);
  if (weekdayOrdinal !== undefined) {
    state.primaryClause.schedule = { ...(state.primaryClause.schedule ?? {}), weekdayOrdinal };
  }
  const eventWindow = getTimingEventWindow(dosage.timing?.repeat);
  if (eventWindow) {
    state.primaryClause.schedule = {
      ...(state.primaryClause.schedule ?? {}), eventWindow
    };
  }
  state.occurrenceCap = getTimingOccurrenceCap(dosage.timing?.repeat);
  const sharedCount = getTimingSharedCount(dosage.timing?.repeat);
  if (sharedCount) (state.primaryClause.schedule ??= {}).sharedCount = sharedCount;
  const administrationOffsetMinutes = getAdministrationOffsetMinutes(dosage);
  if (administrationOffsetMinutes !== undefined) {
    const schedule = state.primaryClause.schedule ?? (state.primaryClause.schedule = {});
    schedule.administrationOffsetMinutes = administrationOffsetMinutes;
  }
  const cycleConstraint = getCycleDayConstraint(dosage);
  if (cycleConstraint) {
    const schedule = state.primaryClause.schedule ?? (state.primaryClause.schedule = {});
    schedule.cycleDayConstraint = cycleConstraint;
  }
  state.maxDosePerPeriod = canonicalDosePeriodMaximums(dosage);
  state.routeText = dosage.route?.text;
  const siteCoding = selectPreferredSiteCoding(dosage.site);
  state.siteText = getFallbackSiteText(dosage.site);
  state.siteSpatialRelation = parseBodySiteSpatialRelationExtension(dosage.site);
  state.siteAdministrationTargetCount = getBodySiteAdministrationTargetCount(dosage.site);
  const siteRestrictions = parseBodySiteRestrictionExtensions(dosage.site);
  if (siteRestrictions?.length) {
    state.primaryClause.site = { ...state.primaryClause.site, restrictions: siteRestrictions };
  }
  state.methodText = dosage.method?.text;
  state.methodTextElement = clonePrimitiveElement(dosage.method?._text);
  state.patientInstruction = dosage.patientInstruction;
  state.asNeeded = dosage.asNeeded ??
    (dosage as FhirDosage & { asNeededBoolean?: boolean }).asNeededBoolean;
  if (dosage.asNeededFor?.length) {
    const prnReasons = dosage.asNeededFor.map(canonicalPrnReasonFromConcept);
    state.asNeededReasons = prnReasons;
    state.asNeededReason = joinCanonicalPrnReasonTexts(prnReasons);
    state.asNeededReasonTriggerPhase = prnReasons[0]?.triggerPhase;
  }

  if (dosage.timing?.repeat?.dayOfWeek) {
    state.dayOfWeek.push(...dosage.timing.repeat.dayOfWeek.filter((day): day is FhirDayOfWeek => day !== null));
  }
  if (dosage.timing?.repeat?.when) {
    const whenValues = dosage.timing.repeat.when.filter((value): value is EventTiming =>
      arrayIncludes(
        objectValues(EventTiming) as EventTiming[],
        value as EventTiming
      )
    );
    state.when.push(...whenValues);
  }

  const routeCode = routeCodeFromCodings(dosage.route?.coding);
  if (routeCode) {
    state.routeCode = routeCode;
    state.routeText = ROUTE_TEXT[routeCode];
  }

  if (siteCoding?.code) {
    const siteI18n = codeableConceptTranslationI18n(dosage.site, siteCoding);
    state.siteCoding = {
      code: siteCoding.code,
      display: siteCoding.display,
      system: siteCoding.system,
      i18n: siteI18n.display
    };
    if (siteI18n.text) {
      state.primaryClause.site = {
        ...state.primaryClause.site,
        i18n: siteI18n.text
      };
    }
    state.siteSource = "text";
  } else if (dosage.site?.text) {
    state.siteSource = "text";
  }

  const methodCoding = selectMedicationInstructionMethodCoding(dosage.method?.coding, options);
  if (methodCoding?.code) {
    state.methodCoding = {
      code: methodCoding.code,
      display: methodCoding.display,
      system: methodCoding.system,
      _display: clonePrimitiveElement(methodCoding._display),
      i18n: getPrimitiveTranslations(methodCoding._display)
    };
  }

  if (dosage.asNeededFor?.length === 1) {
    const reason = state.asNeededReasons?.[0];
    if (reason?.coding?.code) {
      state.asNeededReasonCoding = reason.coding;
      if (reason.i18n && state.primaryClause.prn?.reason) {
        state.primaryClause.prn.reason = {
          ...state.primaryClause.prn.reason,
          i18n: reason.i18n
        };
      }
    }
  }

  if (dosage.additionalInstruction?.length) {
    state.additionalInstructions = dosage.additionalInstruction.map((concept) => {
      const coding = selectFirstCodingWithCode(concept);
      const text = additionalInstructionFallbackText(concept, coding);
      const sourceText = text ?? coding?.display ?? "";
      const ownedGraph = concept.extension
        ? parseInstructionGraphExtension(concept.extension) : undefined;
      const ownedFrames = ownedGraph?.actions;
      const defaultDef = coding?.code
        ? findAdditionalInstructionDefinitionByCoding(
          coding.system ?? SNOMED_SYSTEM,
          coding.code
        )
        : undefined;

      const selected: CanonicalAdditionalInstructionExpr = {
        text,
        coding: coding?.code
          ? {
            code: coding.code,
            display: coding.display,
            system: coding.system,
            i18n: defaultDef?.i18n
          }
          : undefined,
        frames: ownedFrames?.length ? ownedFrames : coding?.code
          ? buildAdditionalInstructionFramesFromCoding(
            coding.system ?? SNOMED_SYSTEM,
            coding.code,
            sourceText,
            { start: 0, end: sourceText.length }
          )
          : undefined
      };
      const evidence = rowInstructionEvidence(ownedGraph);
      if (evidence) selected.evidence = evidence;
      return selected;
    });
  }

  if (timingBounds.warning) {
    const nextWarnings = appendWarning(state.warnings, timingBounds.warning);
    if (nextWarnings) {
      state.warnings = nextWarnings;
    }
  }


  const doseAndRate = dosage.doseAndRate?.[0];
  if (doseAndRate?.doseRange) {
    const extracted = extractCanonicalDoseRange(doseAndRate.doseRange);
    if (extracted.range) {
      state.primaryClause.dose = {
        range: extracted.range,
        unit: extracted.unit
      };
      state.warnings = appendWarning(state.warnings, extracted.warning) ?? state.warnings;
    }
  } else if (doseAndRate?.doseQuantity) {
    const dose = doseAndRate.doseQuantity;
    if (dose.value !== undefined) {
      state.dose = dose.value;
    }
    if (dose.unit) {
      state.unit = dose.unit;
    }
    const comparator = getQuantityComparator(dose);
    if (comparator) (state.primaryClause.dose ??= {}).comparator = comparator;
  }

  const carrierQuantity = clinicalCarrierQuantityFromFhir(dosage);
  if (carrierQuantity) {
    state.primaryClause.clinicalQuantity = carrierQuantity;
    const duration = carrierQuantity.administrationDuration;
    if (!administrationDurationMarker && duration?.comparator && state.primaryClause.schedule?.administrationDuration === undefined &&
        state.primaryClause.schedule?.administrationDurationMax === undefined) {
      const schedule = state.primaryClause.schedule ??= {};
      schedule.administrationDuration = duration.value;
      schedule.administrationDurationUnit = duration.unit;
      schedule.administrationDurationComparator = duration.comparator;
    }
  }

  return state;
}

/**
 * Lower a resolved, typed HPSG quantity without consulting source text. This
 * remains part of the ordinary canonical-to-FHIR lowering, not a second parser.
 * @param dosage FHIR output currently being assembled.
 * @param quantity Resolved typed clinical quantity.
 */
function projectHpsgClinicalQuantityToFhir(
  dosage: FhirDosage,
  quantity: HpsgClinicalQuantityFeature
): void {
  if (quantity.status !== "resolved") {
    // Preserve a recognized daily total even when no per-administration split
    // was stated. It is a rate, not an invented dose, and remains editable.
    if (quantity.dailyTotal && quantity.denominators.some(term => term.dimension === "time")) {
      if ("range" in quantity.numerator) {
        const range = rateFromClinicalQuantity(quantity).rateRange!;
        dosage.doseAndRate = [{ rateRange: buildFhirDoseRange({
          low: range.low?.value, high: range.high?.value
        }, range.low?.unit ?? range.high?.unit) }];
        return;
      }
      const unit = [quantity.numerator.unit, ...quantity.denominators.map(term => term.unit)].join("/");
      dosage.doseAndRate = [{
        rateQuantity: buildFhirDoseQuantity(quantity.numerator.value, unit, quantity.numerator.comparator)
      }];
    }
    return;
  }
  if (quantity.representation === "dose") {
    const dose = dosage.doseAndRate?.[0]?.doseQuantity;
    if (dose && quantity.projectedDose) {
      Object.assign(dose, getStandardDoseUnitCoding(quantity.projectedDose.unit));
    }
    return;
  }
  // A canonical dose may be independently qualified (e.g. EMA ~500 mL).
  // Clinical-quantity lowering adds rate/infusion structure; it must not
  // overwrite an unchanged, already-qualified active dose with an exact one.
  const originalAmount = dosage.doseAndRate?.[0];
  const originalDose = originalAmount?.doseQuantity;
  const resolvedDose = (dose: NonNullable<HpsgClinicalQuantityFeature["projectedDose"]>) =>
    originalDose?.value === dose.value &&
    (originalDose.unit ?? originalDose.code) === dose.unit
      ? originalDose
      : buildFhirDoseQuantity(dose.value, dose.unit, dose.comparator);
  if (quantity.representation === "rate-quantity") {
    const rate = rateFromClinicalQuantity(quantity);
    const amount: NonNullable<FhirDosage["doseAndRate"]>[number] = {
      ...(quantity.projectedDose ? {
        doseQuantity: resolvedDose(quantity.projectedDose)
      } : originalAmount?.doseRange ? { doseRange: originalAmount.doseRange } : {})
    };
    if (rate.rateRatio) {
      amount.rateRatio = {
        numerator: buildFhirDoseQuantity(rate.rateRatio.numerator.value, rate.rateRatio.numerator.unit,
          rate.rateRatio.numerator.comparator),
        denominator: buildFhirDoseQuantity(rate.rateRatio.denominator.value, rate.rateRatio.denominator.unit)
      };
    } else if (rate.rateRange) {
      amount.rateRange = buildFhirDoseRange({
        low: rate.rateRange.low?.value, high: rate.rateRange.high?.value
      }, rate.rateRange.low?.unit ?? rate.rateRange.high?.unit);
    } else {
      amount.rateQuantity = buildFhirDoseQuantity(rate.rate.value, rate.rate.unit, rate.rate.comparator);
    }
    dosage.doseAndRate = [amount];
    return;
  }
  // An explicit ratio period survives even when independent coded quantities
  // do not establish a carrier administration duration.
  const period = quantity.administrationDuration ?? clinicalQuantityTimeDenominator(quantity);
  const dose = quantity.projectedDose;
  const rate = quantity.rateNumerator ?? dose;
  if (!period || !rate || (!dose && !originalAmount?.doseRange)) return;
  const doseQuantity = dose ? { ...resolvedDose(dose),
    ...(dose.system ? { system: dose.system } : {}),
    ...(dose.code ? { code: dose.code } : {}) } : undefined;
  const rateNumerator = { ...buildFhirDoseQuantity(rate.value, rate.unit),
    ...(rate.system ? { system: rate.system } : {}),
    ...(rate.code ? { code: rate.code } : {}) };
  dosage.doseAndRate = [{
    ...(doseQuantity ? { doseQuantity } : { doseRange: originalAmount!.doseRange }),
    rateRatio: {
      numerator: rate.comparator ? quantityForR5({ ...rateNumerator, comparator: rate.comparator })! : rateNumerator,
      denominator: buildFhirDoseQuantity(period.value, period.unit, period.comparator)
    }
  }];
  if (quantity.carrierMaterial?.text) {
    dosage.extension = [
      ...(dosage.extension ?? []).filter(part =>
        part.url !== INFUSION_CARRIER_MATERIAL_EXTENSION_URL),
      infusionCarrierMaterialExtension(quantity.carrierMaterial)
    ];
  }
}
