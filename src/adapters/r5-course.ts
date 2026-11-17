/**
 * Direct CanonicalCourse -> R5 writer.
 *
 * Native clinical fields write the R5 dosage once. Only facts R5 cannot hold
 * go into the existing typed R5 retention extension. The extension spelling
 * stays compatible with saved client data; it is NOT an intermediate R6
 * dosage/course used to obtain the R5 result.
 */
import type {
  FhirDosage,
  EzDosage,
  EzCourseMetadata,
  FhirR6Dosage,
  FhirR6DosageStep,
  FhirR6DoseAndRate,
  FhirR6Ratio,
} from "../types";
import type { CanonicalCourse, CanonicalAdministration, CanonicalMeasure } from "../canonical/course";
import type { FhirProjectionOptions } from "../fhir";
import {
  administrationToR5,
  stageMetadataToWire,
  courseMetadataToWire,
  safetyToWire,
} from "./canonical-course";
import { equalStructuredValues } from "../stable-structure";
import { getStandardDoseUnitCoding } from "../maps";
import { simpleQuantityForR5 } from "../fhir-quantity-operator";
import {
  DOSAGE_DETAILS_R5_URL,
  DOSAGE_RETAINED_R5_SEQUENCE_URL,
  conditionToR6,
  getDosageCondition,
  r5ConditionBaseline,
  r5SafetyBaseline,
  compactProjectionFingerprint,
  offsetCadenceFingerprint,
  attachR5RetainedRow,
  createR5EmptyCourseCarrier,
  withDosageEditProvenance,
  r5StepMetadata,
  type CompactCourseRow,
  type ComponentDeltaBaseline,
} from "../dosage-course";

/** A compiler already supplies unit names; only projection adds standard
 * vocabulary coding. Existing source codes remain authoritative. */
function coded(q: CanonicalMeasure | undefined, compiled: boolean): CanonicalMeasure | undefined {
  if (!q || !compiled) return q;
  const coding = getStandardDoseUnitCoding(q.unit);
  return coding
    ? { ...q, ...coding, ...(q.system ? { system: q.system } : {}), ...(q.code ? { code: q.code } : {}) }
    : q;
}
/** Retain only missing fields. Ordinary rows never allocate a second complete
 * external administration or reverse-project a row merely to compare it. */
function retentionForAdministration(
  a: CanonicalAdministration,
  row: EzDosage,
  editable: boolean,
  fresh: boolean
): Pick<CompactCourseRow, "component" | "baseline" | "timingOffsets"> {
  const raw = a.provenance?.format === "r6" ? (a.provenance.data as FhirR6Dosage) : a.provenance?.retained;
  const expandedSource = a.provenance?.format === "r5" ? (a.provenance.data as EzDosage) : undefined;
  const originalCondition = raw?.condition ?? expandedSource?.condition;
  const condition =
    originalCondition !== undefined &&
    equalStructuredValues(getDosageCondition({ condition: originalCondition }), a.predicate)
      ? originalCondition
      : a.predicate
      ? [conditionToR6(a.predicate)]
      : undefined;
  const safety = safetyToWire(
    a.safety,
    raw?.safety ?? expandedSource?.safety,
    a.limits,
    !!a.syntax && (!a.provenance || a.provenance.format === "syntax")
  );
  const rawSite = raw?.site;
  // A source CodeableReference may carry independent IDs/extensions, but its
  // known concept/reference are controlled by the current native facts. Do
  // not restore known fields merely because the original object had them.
  const site = rawSite || row.site || a.siteReference
    ? { ...rawSite, ...(row.site ? { concept: row.site } : {}),
        ...(a.siteReference ? { reference: a.siteReference } : {}) }
    : undefined;
  if (site) {
    if (!row.site) delete site.concept;
    if (!a.siteReference) delete site.reference;
  }
  const recurrence = a.schedule?.recurrence;
  const component: Partial<FhirR6Dosage> = {};
  const baseline: ComponentDeltaBaseline = {};
  let changed = false;
  if (editable) {
    if (condition?.length) row.condition = condition;
    if (safety) row.safety = safety;
    if (a.siteReference) row.siteReference = a.siteReference;
    if (a.excludedDates?.length) row.excludedDates = a.excludedDates;
  }
  const predicate = r5ConditionBaseline(row);
  const regeneratedCondition = row.condition ?? (predicate ? [conditionToR6(predicate)] : undefined);
  if (!equalStructuredValues(condition, regeneratedCondition)) {
    component.condition = condition;
    baseline.condition = compactProjectionFingerprint(predicate);
    changed = true;
  }
  const regeneratedSafety = row.safety ?? r5SafetyBaseline(row);
  if (!equalStructuredValues(safety, regeneratedSafety)) {
    component.safety = safety;
    baseline.safety = compactProjectionFingerprint(r5SafetyBaseline(row));
    changed = true;
  }
  const regeneratedSite =
    row.site || row.siteReference
      ? {
          ...(row.site ? { concept: row.site } : {}),
          ...(row.siteReference ? { reference: row.siteReference } : {}),
        }
      : undefined;
  if (site && !equalStructuredValues(site, regeneratedSite)) {
    component.site = site;
    baseline.site = compactProjectionFingerprint({ concept: row.site, reference: row.siteReference });
    changed = true;
  }
  const timingOffsets =
    recurrence && (recurrence.startOffset !== undefined || recurrence.endOffset !== undefined)
      ? {
          ...(recurrence.startOffset !== undefined
            ? { startOffset: simpleQuantityForR5(recurrence.startOffset) }
            : {}),
          ...(recurrence.endOffset !== undefined
            ? { endOffset: simpleQuantityForR5(recurrence.endOffset) }
            : {}),
        }
      : undefined;
  if (timingOffsets) baseline.timing = offsetCadenceFingerprint(row.timing);
  let retained: FhirR6DoseAndRate[] | undefined;
  let fingerprints: NonNullable<ComponentDeltaBaseline["doseAndRate"]> | undefined;
  const compiled = !!a.syntax && (!a.provenance || a.provenance.format === "syntax");
  for (let index = 0; index < (a.amounts?.length ?? 0); index++) {
    const value = a.amounts![index];
    const projected = row.doseAndRate?.[index];
    if (editable && projected && (value.expression || value.rateExpression)) {
      if (value.expression) projected.doseExpression = value.expression;
      if (value.rateExpression) projected.rateExpression = value.rateExpression;
    }
    const hasDose = !!(value.expression || value.quantity?.comparator);
    const hasRate = !!(
      value.rateExpression ||
      value.rate?.comparator ||
      value.rateRatio?.numerator?.comparator === "~"
    );
    if ((hasDose || hasRate) && !retained) {
      retained = [];
      fingerprints = [];
      for (let previous = 0; previous < index; previous++) {
        const earlier = a.amounts![previous];
        retained.push({
          ...(earlier.provenance?.id ? { id: String(earlier.provenance.id) } : {}),
          ...(earlier.role ? { type: earlier.role } : {}),
        });
        fingerprints.push({});
      }
    }
    if (!retained) continue;
    retained.push({
      ...(value.provenance?.id ? { id: String(value.provenance.id) } : {}),
      ...(value.role ? { type: value.role } : {}),
      ...(value.expression ? { doseExpression: value.expression } : {}),
      ...(value.quantity?.comparator ? { doseQuantity: coded(value.quantity, compiled) } : {}),
      ...(value.rateExpression ? { rateExpression: value.rateExpression } : {}),
      ...(value.rate?.comparator ? { rateQuantity: coded(value.rate, compiled) } : {}),
      ...(value.rateRatio?.numerator?.comparator === "~"
        ? {
            rateRatio: {
              ...value.rateRatio,
              numerator: coded(value.rateRatio.numerator, compiled),
              denominator:
                (value.provenance?.rateRatio as FhirR6Ratio | undefined)?.denominator ??
                simpleQuantityForR5(coded(value.rateRatio.denominator, compiled)),
            },
          }
        : {}),
    });
    fingerprints!.push({
      ...(hasDose
        ? {
            dose: compactProjectionFingerprint({
              doseQuantity: projected?.doseQuantity,
              doseRange: projected?.doseRange,
            }),
          }
        : {}),
      ...(hasRate
        ? {
            rate: compactProjectionFingerprint({
              rateQuantity: projected?.rateQuantity,
              rateRange: projected?.rateRange,
              rateRatio: projected?.rateRatio,
            }),
          }
        : {}),
    });
  }
  if (retained) {
    component.doseAndRate = retained;
    baseline.doseAndRate = fingerprints;
    changed = true;
  }
  return changed || timingOffsets
    ? { ...(changed ? { component } : {}), ...(timingOffsets ? { timingOffsets } : {}), baseline }
    : {};
}
/** Native course metadata is serialized once into its FINAL R5 extension
 * header. Step/member loops write direct rows and their local retained fields.
 * No R6 object is built, flattened, imported, or used as an adapter input. */
export function projectNativeR5Course(
  course: CanonicalCourse,
  options?: FhirProjectionOptions,
  editable = false,
  freshlyCompiled = false,
  attachInstruction = true,
  strictPreview = false,
  suppliedRows?: readonly (FhirDosage | EzDosage)[]
): { dosages: EzDosage[]; course: EzCourseMetadata; strictDosages?: FhirDosage[] } {
  const header = courseMetadataToWire(course);
  const hasHeader = Object.keys(header).length > 0;
  let hasAdministrations = false;
  const steps: Omit<FhirR6DosageStep, "component">[] = [];
  const emptySteps: NonNullable<EzCourseMetadata["step"]> = [];
  const metadata: NonNullable<EzCourseMetadata["step"]> = [];
  let needsBridge = hasHeader,
    contextRequired = !!(course.cycleInterval || course.safety || header.modifierExtension?.length);
  for (let i = 0; i < course.stages.length; i++) {
    const stage = course.stages[i],
      fields = stageMetadataToWire(stage);
    steps.push(fields);
    if (Object.keys(fields).length) {
      metadata.push({ sequence: i + 1, ...r5StepMetadata(fields) });
      needsBridge = true;
    }
    if (stage.administrations.length) hasAdministrations = true;
    else {
      emptySteps.push({ sequence: i + 1, ...fields });
      needsBridge = true;
      contextRequired = true;
    }
    // Once a retained profile is required, do not keep inspecting every
    // subsequent administration merely to rediscover the same Boolean fact.
    if (needsBridge) continue;
    for (const a of stage.administrations) {
      if (
        a.predicate ||
        a.limits ||
        a.safety ||
        a.siteReference ||
        a.phaseOriginIssue ||
        a.schedule?.recurrence?.startOffset ||
        a.schedule?.recurrence?.endOffset
      )
        needsBridge = true;
      const site = a.provenance?.format === "r6" ? (a.provenance.data as FhirR6Dosage).site : undefined;
      if (site?.id || site?.extension?.length) needsBridge = true;
      if (needsBridge) break;
      for (const value of a.amounts ?? [])
        if (
          value.expression ||
          value.rateExpression ||
          value.quantity?.comparator ||
          value.rate?.comparator ||
          value.rateRatio?.numerator?.comparator === "~"
        ) {
          needsBridge = true;
          break;
        }
      if (needsBridge) break;
    }
  }
  const retainedHeader = {
    ...(hasHeader ? { course: header } : {}),
    ...(emptySteps.length ? { emptyStep: emptySteps } : {}),
  };
  const context = hasHeader || emptySteps.length ? compactProjectionFingerprint(retainedHeader) : undefined;
  const rows: EzDosage[] = [];
  let strictRows: FhirDosage[] | undefined;
  for (let stageIndex = 0; stageIndex < course.stages.length; stageIndex++) {
    const stage = course.stages[stageIndex],
      step = steps[stageIndex];
    const hasStep = Object.keys(step).length > 0;
    for (const a of stage.administrations) {
      const rowIndex = rows.length;
      const strict: EzDosage =
        suppliedRows?.[rowIndex] ??
        administrationToR5(a, stageIndex + 1, options, freshlyCompiled ? a.syntax : undefined);
      const retainedSequence = strict.extension?.find(
        (e) => e.url === DOSAGE_RETAINED_R5_SEQUENCE_URL
      )?.valueDecimal;
      if (retainedSequence !== undefined && Number.isFinite(retainedSequence))
        strict.sequence = retainedSequence;
      let hasExpressions = false;
      // Only dual strict/editable previews need this classification. A
      // requested single R5 output must not scan amounts for an unused flag.
      if (strictPreview && editable)
        for (const value of a.amounts ?? [])
          if (value.expression || value.rateExpression) {
            hasExpressions = true;
            break;
          }
      const distinct =
        strictPreview &&
        editable &&
        Boolean(
          hasExpressions || a.predicate || a.safety || a.limits || a.siteReference || a.excludedDates?.length
        );
      let row: EzDosage = strict;
      if (distinct) {
        if (!strictRows) strictRows = rows.slice();
        row = Object.assign({}, strict);
        if (hasExpressions) row.doseAndRate = strict.doseAndRate?.map((entry) => Object.assign({}, entry));
      }
      if (needsBridge) {
        const missingContext: string[] = [];
        for (const e of strict.modifierExtension ?? [])
          if (e.url === DOSAGE_DETAILS_R5_URL)
            for (const child of e.extension ?? [])
              if (child.url === "missingContext" && child.valueString !== undefined)
                missingContext.push(child.valueString);
        const common = {
          rowIndex,
          sequence: stageIndex + 1,
          stepCount: course.stages.length,
          ...(hasStep ? { step } : {}),
          ...(context
            ? {
                context,
                ...(contextRequired ? { contextRequired } : {}),
                ...(rowIndex === 0 ? retainedHeader : {}),
              }
            : {}),
          ...(missingContext.length ? { missingContext } : {}),
        };
        const write = (target: EzDosage, extended: boolean) => {
          const delta = retentionForAdministration(a, target, extended, freshlyCompiled);
          if (
            hasStep ||
            delta.component ||
            delta.timingOffsets ||
            context ||
            course.stages.length > 1 ||
            missingContext.length
          )
            attachR5RetainedRow(target, { ...common, ...delta });
        };
        if (distinct) write(strict, false);
        write(row, editable);
      }
      rows.push(row);
      strictRows?.push(strict);
    }
  }
  if (!rows.length && (course.stages.length || course.instruction !== undefined || hasHeader))
    rows.push(createR5EmptyCourseCarrier(header, steps, course.instruction));
  const dosages =
    attachInstruction && course.instruction !== undefined && rows.length && hasAdministrations
      ? withDosageEditProvenance(rows, course.instruction)
      : rows;
  const strictDosages = strictRows
    ? attachInstruction && course.instruction !== undefined
      ? withDosageEditProvenance(strictRows, course.instruction)
      : strictRows
    : dosages;
  return {
    dosages,
    ...(strictPreview ? { strictDosages } : {}),
    course: {
      ...header,
      ...(course.instruction !== undefined ? { renderedInstruction: course.instruction } : {}),
      ...(metadata.length ? { step: metadata } : {}),
    },
  };
}
