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
  FhirExtension,
  EzDosage,
  EzCourseMetadata,
  FhirR6Dosage,
  FhirR6DosageStep,
  FhirR6DoseAndRate,
} from "../types";
import type { CanonicalCourse, CanonicalAdministration, CanonicalMeasure } from "../canonical/course";
import { administrationHasAmountFacts } from "../canonical/course";
import type { FhirProjectionOptions } from "../fhir";
import {
  administrationToR5,
  stageMetadataToWire,
  courseMetadataToWire,
  safetyToWire,
} from "./canonical-course";
import { cloneStructuredValue, equalStructuredValues } from "../stable-structure";
import { getStandardDoseUnitCoding } from "../maps";
import { simpleQuantityForR5 } from "../fhir-quantity-operator";
import {
  DOSAGE_DETAILS_R5_URL,
  R5_EXPRESSION_SLOT_SOURCE_URL,
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
  getDosageSourceTextAgreement,
  retainedSourceProjectionFingerprint, dosageHasAgreedSourceText, isCompactSourceAgreementMarker,
  getDosageSourceTextFingerprint,
  type DosageSourceTextBaseline,
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
  }
  const predicate = r5ConditionBaseline(row);
  const regeneratedCondition = row.condition ?? (predicate ? [conditionToR6(predicate)] : undefined);
  if (!equalStructuredValues(condition, regeneratedCondition)) {
    component.condition = condition;
    baseline.condition = compactProjectionFingerprint(predicate);
    changed = true;
  }
  const regeneratedSafety = row.safety ?? r5SafetyBaseline(row);
  // Editable R5 exposes both maxima and lifted safety. Strict period
  // maxima can also carry limit Element metadata on the Ratio itself. Keep
  // an edit baseline for that authored metadata even when fully projected:
  // deleting the live Ratio must retire its source, not erase its history.
  if ((editable && safety) || !equalStructuredValues(safety, regeneratedSafety) ||
      safety?.doseLimit?.some(limit => limit.id !== undefined || Boolean(limit.extension?.length))) {
    // The editable external safety and its saved edit baseline have separate
    // owners. A live Quantity edit must not rewrite the retained comparison.
    component.safety = editable ? cloneStructuredValue(safety) : safety;
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
    const hasDose = !!(value.expression || value.quantity?.comparator ||
      value.range?.low?.comparator || value.range?.high?.comparator);
    const hasRate = !!(
      value.rateExpression ||
      value.rate?.comparator || value.rateRange?.low?.comparator || value.rateRange?.high?.comparator ||
      value.rateRatio?.denominator?.comparator || value.rateRatio?.numerator?.comparator === "~"
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
        const prior = row.doseAndRate?.[previous];
        fingerprints.push({
          ...(prior?.doseQuantity || prior?.doseRange ? { dose: compactProjectionFingerprint({
            doseQuantity: prior.doseQuantity, doseRange: prior.doseRange,
          }) } : {}),
          ...(prior?.rateQuantity || prior?.rateRange || prior?.rateRatio ? { rate: compactProjectionFingerprint({
            rateQuantity: prior.rateQuantity, rateRange: prior.rateRange, rateRatio: prior.rateRatio,
          }) } : {}),
        });
      }
    }
    if (!retained) continue;
    retained.push({
      ...(value.provenance?.id ? { id: String(value.provenance.id) } : {}),
      ...(value.role ? { type: value.role } : {}),
      ...(value.expression ? { doseExpression: value.expression } : {}),
      ...(value.quantity?.comparator ? { doseQuantity: simpleQuantityForR5(coded(value.quantity, compiled)) } : {}),
      ...(value.range?.low?.comparator || value.range?.high?.comparator
        ? { doseRange: projected?.doseRange } : {}),
      ...(value.rateExpression ? { rateExpression: value.rateExpression } : {}),
      ...(value.rate?.comparator ? { rateQuantity: simpleQuantityForR5(coded(value.rate, compiled)) } : {}),
      ...(value.rateRange?.low?.comparator || value.rateRange?.high?.comparator
        ? { rateRange: projected?.rateRange } : {}),
      ...(value.rateRatio?.denominator?.comparator || value.rateRatio?.numerator?.comparator === "~"
        ? {
            rateRatio: {
              ...value.rateRatio,
              numerator: coded(value.rateRatio.numerator, compiled),
              // Ratio.denominator is SimpleQuantity in both wire versions.
              // Keep the current native qualifier through its extension codec;
              // permissive source spelling must not make strict output invalid.
              denominator: simpleQuantityForR5(coded(value.rateRatio.denominator, compiled)),
            },
          }
        : {}),
    });
    fingerprints!.push({
      ...(projected?.extension?.some(item => item.url === R5_EXPRESSION_SLOT_SOURCE_URL)
        ? { expressionSlot: true } : {}),
      ...(editable && value.expression ? { doseExpression: compactProjectionFingerprint(value.expression) } : {}),
      ...(editable && value.rateExpression ? { rateExpression: compactProjectionFingerprint(value.rateExpression) } : {}),
      ...(hasDose || projected?.doseQuantity || projected?.doseRange
        ? {
            dose: compactProjectionFingerprint({
              doseQuantity: projected?.doseQuantity,
              doseRange: projected?.doseRange,
            }),
          }
        : {}),
      ...(hasRate || projected?.rateQuantity || projected?.rateRange || projected?.rateRatio
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
  suppliedRows?: readonly (FhirDosage | EzDosage)[],
  deferSourceProvenance = false
): { dosages: EzDosage[]; course: EzCourseMetadata; strictDosages?: FhirDosage[];
  sourceBaselines?: readonly (DosageSourceTextBaseline | undefined)[] } {
  const header = courseMetadataToWire(course);
  const headerCovered = course.instruction !== undefined && course.provenance?.sourceTextAgreed === true;
  if (headerCovered && header.extension?.length && course.stages.some(stage => stage.administrations.length)) {
    // The existing instruction baseline owns header coverage in R5. Do not
    // duplicate its compact native proof in retained shared-course metadata.
    const kept = header.extension.filter(marker => !isCompactSourceAgreementMarker(marker) ||
      marker.extension?.length !== 3 ||
      !marker.extension.some(field => field.url === "sourceAgreement" && field.valueBoolean === false) ||
      !marker.extension.some(field => field.url === "sourceTextAgreed" && field.valueBoolean === true) ||
      !dosageHasAgreedSourceText({ text: course.instruction, extension: [marker] }));
    if (kept.length) header.extension = kept;
    else delete header.extension;
  }
  const sourceAgreement = course.provenance?.format !== "r6" && course.provenance?.sourceTextVerified !== false;
  let rowSources: Array<DosageSourceTextBaseline | undefined> | undefined;
  const hasHeader = Object.keys(header).length > 0;
  let hasAdministrations = false, hasSourceText = false;
  const steps: Omit<FhirR6DosageStep, "component">[] = [];
  const emptySteps: NonNullable<EzCourseMetadata["step"]> = [];
  const metadata: NonNullable<EzCourseMetadata["step"]> = [];
  let needsBridge = hasHeader,
    contextRequired = !!(course.cycleInterval || course.safety || header.modifierExtension?.length);
  for (let i = 0; i < course.stages.length; i++) {
    const stage = course.stages[i],
      fields = stageMetadataToWire(stage);
    steps.push(fields);
    // An implicit successor still depends on its original predecessor.
    // Sequence alone cannot retain that membership after a row is removed.
    if (i > 0 && !stage.start) needsBridge = true;
    if (Object.keys(fields).length || !stage.administrations.length) {
      // The editable list owns explicitly retained empty stages, including
      // fieldless ones. Keep their identity so absence can mean deletion.
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
      const site = a.provenance?.format === "r6"
        ? (a.provenance.data as FhirR6Dosage).site : a.provenance?.retained?.site;
      if (site) for (const field in site) {
        if (field !== "concept") { needsBridge = true; break; }
      }
      if (needsBridge) break;
      for (const value of a.amounts ?? [])
        if (
          value.expression ||
          value.rateExpression ||
          value.quantity?.comparator || value.range?.low?.comparator || value.range?.high?.comparator ||
          value.rate?.comparator || value.rateRange?.low?.comparator || value.rateRange?.high?.comparator ||
          value.rateRatio?.denominator?.comparator || value.rateRatio?.numerator?.comparator === "~"
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
      const originalRow = a.provenance?.format === "r5" ? a.provenance.data as EzDosage : undefined;
      const sourceClocks = a.provenance?.sourceHasStructuredClocks,
        sourceEvents = a.provenance?.sourceHasStructuredEvents,
        sourceSite = a.provenance?.sourceHasStructuredSite,
        sourceCovered = a.provenance?.sourceTextAgreed === true,
        sourceAgreed = sourceCovered && !administrationHasAmountFacts(a);
      const originalAgreement = sourceAgreed ? true :
        (originalRow?.text !== undefined && !dosageHasAgreedSourceText(originalRow) ||
          a.text !== undefined && a.syntax?.instructionGraph?.actions.length) &&
          !administrationHasAmountFacts(a) ? false :
        !deferSourceProvenance && originalRow && a.provenance?.sourceTextVerified !== undefined
          ? getDosageSourceTextAgreement(originalRow, false) : undefined;
      if (sourceClocks !== undefined || sourceEvents !== undefined || sourceSite !== undefined || sourceCovered ||
          !deferSourceProvenance && (originalAgreement === false || sourceAgreement && a.provenance?.format === "r6")) {
        rowSources ??= [];
        rowSources[rowIndex] = { sourceAgreement: sourceAgreed || (originalAgreement !== false &&
          !(sourceAgreement && a.provenance?.format === "r6") && sourceAgreement),
          ...(sourceCovered ? { sourceTextAgreed: true,
            textFingerprint: getDosageSourceTextFingerprint(a.provenance!.data),
            projectionFingerprint: !administrationHasAmountFacts(a)
              ? retainedSourceProjectionFingerprint(a.provenance!.data) : undefined } : {}),
          ...(sourceClocks !== undefined ? { sourceHasStructuredClocks: sourceClocks } : {}),
          ...(sourceEvents !== undefined ? { sourceHasStructuredEvents: sourceEvents } : {}),
          ...(sourceSite !== undefined ? { sourceHasStructuredSite: sourceSite } : {}),
          ...(originalRow ? { textFingerprint: getDosageSourceTextFingerprint(originalRow) } : {}) };
      }
      const strict: EzDosage =
        suppliedRows?.[rowIndex] ??
        administrationToR5(a, stageIndex + 1, options, freshlyCompiled ? a.syntax : undefined);
      const retainedSequence = strict.extension?.find(
        (e) => e.url === DOSAGE_RETAINED_R5_SEQUENCE_URL
      );
      const retainedPhaseMatches = retainedSequence && (retainedSequence.valueDecimal === undefined
        ? stageIndex === 0
        : Number.isFinite(retainedSequence.valueDecimal) &&
          (Number.isInteger(retainedSequence.valueDecimal) && retainedSequence.valueDecimal >= 1
            ? retainedSequence.valueDecimal : 1) === stageIndex + 1);
      if (retainedPhaseMatches && retainedSequence.valueDecimal !== undefined)
        strict.sequence = retainedSequence.valueDecimal;
      if (retainedPhaseMatches && retainedSequence._valueDecimal !== undefined && strict._sequence === undefined)
        strict._sequence = retainedSequence._valueDecimal;
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
      // Date exclusions are an editable row field even without retained
      // course metadata. Only the editable copy receives the lifted value.
      if (editable && a.excludedDates?.length) row.excludedDates = a.excludedDates;
      const missingContext = a.missingContexts;
      let contextAnnotations: FhirExtension[] | undefined;
      if (strict.modifierExtension?.length) {
        let remaining: FhirExtension[] | undefined;
        for (let index = 0; index < strict.modifierExtension.length; index++) {
          const e = strict.modifierExtension[index];
          if (e.url !== DOSAGE_DETAILS_R5_URL) { remaining?.push(e); continue; }
          if (a.provenance?.format === "r6" || a.provenance?.retained?.modifierExtension !== undefined)
            (contextAnnotations ??= []).push(e);
          remaining ??= strict.modifierExtension.slice(0, index);
        }
        // This output's bridge is rebuilt from live facts. In particular,
        // clearing its last retained field must retire the previous marker.
        if (remaining) {
          strict.modifierExtension = remaining.length ? remaining : undefined;
          if (row !== strict) row.modifierExtension = strict.modifierExtension;
        }
      }
      if (needsBridge || missingContext?.length || contextAnnotations) {
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
          ...(missingContext?.length ? { missingContext } : {}),
        };
        const write = (target: EzDosage, extended: boolean) => {
          const delta = retentionForAdministration(a, target, extended, freshlyCompiled);
          // The compact missingContext values own current reasons. Retain the
          // original native modifier only for its Element/child annotations;
          // reimport does not derive executable reasons from this snapshot.
          if (contextAnnotations)
            (delta.component ??= {}).modifierExtension = contextAnnotations;
          if (
            hasStep ||
            delta.component ||
            delta.timingOffsets ||
            context ||
            course.stages.length > 1 ||
            missingContext?.length
          )
            attachR5RetainedRow(target, { ...common, ...delta });
        };
        if (distinct) write(strict, false);
        write(row, editable);
      }
      if (row.text !== undefined) hasSourceText = true;
      rows.push(row);
      strictRows?.push(strict);
    }
  }
  if (!rows.length && (course.stages.length || course.instruction !== undefined || hasHeader))
    rows.push(createR5EmptyCourseCarrier(header, steps, course.instruction));
  const instruction = attachInstruction ? course.instruction : undefined;
  // A caller that owns final semantic normalization writes these markers once
  // after that normalization. Standalone projections retain local authority.
  const writeProvenance = !deferSourceProvenance && hasAdministrations &&
    (instruction !== undefined || !sourceAgreement && hasSourceText || rowSources !== undefined);
  const dosages = writeProvenance
    ? withDosageEditProvenance(rows, instruction, sourceAgreement, rowSources, headerCovered) : rows;
  const strictDosages = strictRows
    ? writeProvenance ? withDosageEditProvenance(strictRows, instruction, sourceAgreement, rowSources, headerCovered) : strictRows
    : dosages;
  return {
    dosages,
    ...(strictPreview ? { strictDosages } : {}),
    ...(deferSourceProvenance && rowSources ? { sourceBaselines: rowSources } : {}),
    course: {
      ...header,
      ...(course.instruction !== undefined ? { renderedInstruction: course.instruction } : {}),
      ...(metadata.length ? { step: metadata } : {}),
    },
  };
}
