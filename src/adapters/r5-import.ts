/**
 * R5 live rows and retained R5 profile -> native clinical course.
 *
 * Rows are imported directly. Retained external source fragments are decoded
 * only where a corresponding live slot still owns them. No synthetic R6
 * instruction/dosage is built to get back to the internal clinical model.
 */
import type {
  FhirDosage,
  EzDosage,
  EzCourseMetadata,
  FhirExtension,
  FhirR6Dosage,
  FhirR6DosageInstruction,
  FhirR6DosageStep,
} from "../types";
import type { CanonicalCourse, CanonicalStage, CanonicalAdministration } from "../canonical/course";
import {
  administrationFromR5,
  administrationFromR6,
  boundaryFromR6,
  safetyFromWire,
  measureFromWire,
  administrationToR5,
} from "./canonical-course";
import { equalStructuredValues, hashStructuredValue } from "../stable-structure";
import { quantityFromR5, simpleQuantityForR5, quantityForR5 } from "../fhir-quantity-operator";
import {
  DOSAGE_DETAILS_R5_URL,
  DOSAGE_RECONCILIATION_SOURCE_URL,
  DOSAGE_RECONCILIATION_WARNING_URL,
  compactCourseMarker,
  decodeR5RetainedFields,
  encodeR5RetainedFields,
  type CompactCourseRow,
  compactProjectionFingerprint,
  matchingProjectionFingerprint,
  offsetCadenceFingerprint,
  dosageProjectionFingerprint,
  dosageTextFingerprint,
  isRenderedInstructionMarker,
  hasUnrecognizedEditMetadata,
  localReconciliationSource,
  retainedCourseStepSource,
  executablePhaseMetadata,
  equivalentProjection,
  r6StepMetadata,
  r5StepMetadata,
  r5ConditionBaseline,
  r5SafetyBaseline,
  reconcileR5SafetyEdits,
  retainedDoseRateMatches,
  getDosageCondition,
  conditionToR6,
  decodeCourseDetails,
  sourceWithoutNestedHistory,
  liveDosageProjection,
  getDosageAlternativeChoice,
  getDosageExcludedDates,
  type DosageAlternativeChoice,
} from "../dosage-course";

/** Each local warning list has one membership index. Repeated source rows
 * cannot turn warning de-duplication into an O(rows × warnings) scan. */
const warningMembership = new WeakMap<string[], Set<string>>();
function addWarning(warnings: string[], warning: string): void {
  let known = warningMembership.get(warnings);
  if (!known) warningMembership.set(warnings, (known = new Set(warnings)));
  if (!known.has(warning)) {
    known.add(warning);
    warnings.push(warning);
  }
}
/** Native typed facts come from metadata fragments, not from a whole other
 * external course. Foreign annotations are kept on the source envelope. */
function stageFromFields(
  fields: Omit<FhirR6DosageStep, "component">,
  members: CanonicalAdministration[]
): CanonicalStage {
  return {
    administrations: members,
    start: boundaryFromR6(fields.start),
    end: boundaryFromR6(fields.end),
    count: fields.count,
    safety: safetyFromWire(fields.safety, true),
    provenance: fields,
  };
}
function courseFromFields(
  fields: Omit<FhirR6DosageInstruction, "step">,
  stages: CanonicalStage[]
): CanonicalCourse {
  let contextIssue: CanonicalCourse["contextIssue"];
  for (const stage of stages)
    for (const a of stage.administrations) {
      if (a.contextIssue === "conflicting-course-phase") contextIssue = a.contextIssue;
      else if (a.contextIssue && !contextIssue) contextIssue = a.contextIssue;
    }
  const course:CanonicalCourse={
    kind:"course",stages,instruction:fields.renderedInstruction,
    cycleInterval:measureFromWire(fields.repeatCycle),
    safety:safetyFromWire(fields.safety,true),provenance:{format:"r5",data:fields}
  };
  // Set an optional typed scalar directly instead of creating spread
  // fragments/descriptors on every imported course in the ES6 build.
  if(contextIssue)course.contextIssue=contextIssue;
  return course;
}
function extensionFields(course: CanonicalCourse): FhirExtension[] {
  return (course.provenance?.data.extension as FhirExtension[] | undefined) ?? [];
}
function withExtensions(course: CanonicalCourse, extension: FhirExtension[]): CanonicalCourse {
  return {
    ...course,
    provenance: {
      format: course.provenance?.format ?? "r5",
      data: { ...course.provenance?.data, extension },
    },
  };
}
function withReconciliationWarnings(course: CanonicalCourse, warnings: readonly string[]): CanonicalCourse {
  if (!warnings.length) return course;
  const original = extensionFields(course),
    known = new Set<string>();
  for (const e of original)
    if (e.url === DOSAGE_RECONCILIATION_WARNING_URL && e.valueString) known.add(e.valueString);
  let next: FhirExtension[] | undefined;
  for (const text of warnings)
    if (!known.has(text)) {
      known.add(text);
      (next ??= original.slice()).push({ url: DOSAGE_RECONCILIATION_WARNING_URL, valueString: text });
    }
  return next ? withExtensions(course, next) : course;
}
function withPreservedSourceExtension(
  course: CanonicalCourse,
  source: FhirExtension | undefined
): CanonicalCourse {
  if (!source) return course;
  const original = extensionFields(course);
  for (const e of original) if (equalStructuredValues(e, source)) return course;
  return withExtensions(course, [...original, source]);
}
/** Index retained source identities once, then confirm exact equality only
 * within a hash bucket. A source list must not rescan every previous source
 * for each row; hash collisions never authorize discarding distinct data. */
function withReconciliationSources(
  course: CanonicalCourse,
  sources: readonly FhirExtension[]
): CanonicalCourse {
  if (!sources.length) return course;
  const existing = extensionFields(course);
  const buckets = new Map<number, FhirExtension[]>();
  for (const marker of existing) {
    if (marker.url !== DOSAGE_RECONCILIATION_SOURCE_URL || marker.extension?.length !== 1) continue;
    const source = marker.extension[0],
      key = hashStructuredValue(source);
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, (bucket = []));
    bucket.push(source);
  }
  let next: FhirExtension[] | undefined;
  for (const source of sources) {
    const key = hashStructuredValue(source);
    let bucket = buckets.get(key),
      found = false;
    for (const before of bucket ?? [])
      if (equalStructuredValues(before, source)) {
        found = true;
        break;
      }
    if (found) continue;
    if (!bucket) buckets.set(key, (bucket = []));
    bucket.push(source);
    (next ??= existing.slice()).push({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [source] });
  }
  return next ? withExtensions(course, next) : course;
}
function withMissingCourseContext(
  a: CanonicalAdministration,
  contexts: readonly string[]
): CanonicalAdministration {
  if (!contexts.length) return a;
  let conflict = false;
  for (const context of contexts)
    if (context === "conflicting-phase") {
      conflict = true;
      break;
    }
  return {
    ...a,
    missingContexts: [...contexts],
    contextIssue: conflict ? "conflicting-course-phase" : "missing-course-context",
  };
}
const CONFLICTING_PHASE_CONTEXT = "conflicting-phase";

/** Field-local restoration: a dose edit cannot erase a separate rate, nor
 * can a stale retained expression resurrect a dosage the clinician removed. */
function restoreComponentDelta(
  row: EzDosage,
  local: CompactCourseRow,
  warnings: string[],
  sourceContext: boolean
): {
  dosage: CanonicalAdministration;
  superseded: boolean;
} {
  const fresh = administrationFromR5(row, sourceContext),
    delta = local.component;
  let superseded = false;
  if (!delta && !local.timingOffsets) return { dosage: fresh, superseded };
  const retained: Partial<FhirR6Dosage> = {};
  if (delta?.condition !== undefined) {
    if (
      row.condition === undefined &&
      local.baseline?.condition === compactProjectionFingerprint(r5ConditionBaseline(row))
    ) {
      fresh.predicate = getDosageCondition({ condition: delta.condition });
      retained.condition = delta.condition;
    } else if (
      !equalStructuredValues(
        row.condition ?? (fresh.predicate ? [conditionToR6(fresh.predicate)] : undefined),
        delta.condition
      )
    ) {
      superseded = true;
      addWarning(
        warnings,
        "Retained R6 condition was superseded by an edited R5 predicate; original condition preserved as source provenance."
      );
    }
  }
  if (local.timingOffsets) {
    if (local.baseline?.timing === offsetCadenceFingerprint(row.timing))
      fresh.schedule = {
        ...fresh.schedule,
        recurrence: {
          ...fresh.schedule?.recurrence,
          startOffset: quantityFromR5(local.timingOffsets.startOffset),
          endOffset: quantityFromR5(local.timingOffsets.endOffset),
        },
      };
    else {
      superseded = true;
      addWarning(
        warnings,
        "Retained R6 period offsets were superseded by an edited R5 timing; original R6 values remain available as source provenance."
      );
    }
  }
  if (delta?.safety) {
    const safety =
      row.safety ??
      (local.baseline?.safety === compactProjectionFingerprint(r5SafetyBaseline(row))
        ? delta.safety
        : reconcileR5SafetyEdits(delta.safety, r5SafetyBaseline(row)));
    if (safety) {
      fresh.safety = safetyFromWire(safety);
      retained.safety = safety;
      fresh.limits = safety.doseLimit?.map((limit) => ({
        scope: limit.scope,
        amount: measureFromWire(limit.valueQuantity),
        count: limit.valueInteger,
        expression: limit.valueExpression,
        period: measureFromWire(limit.period),
        text: limit.text,
        provenance: limit,
      }));
    }
    if (!equalStructuredValues(safety, delta.safety)) {
      superseded = true;
      addWarning(
        warnings,
        "Retained R6 safety was superseded by edited R5 limits or safety fields; original safety retained as source provenance."
      );
    }
  }
  if (delta?.site) {
    const referenceCleared =
      delta.site.reference &&
      Object.prototype.hasOwnProperty.call(row, "siteReference") &&
      row.siteReference === undefined;
    const unchanged =
      local.baseline?.site ===
      compactProjectionFingerprint({ concept: row.site, reference: row.siteReference });
    if (!referenceCleared && unchanged) {
      fresh.target = fresh.target ? { ...delta.site.concept, ...fresh.target } : delta.site.concept;
      fresh.siteReference = fresh.siteReference
        ? { ...delta.site.reference, ...fresh.siteReference }
        : delta.site.reference;
      retained.site = {
        ...delta.site,
        ...(fresh.target ? { concept: fresh.target } : {}),
        ...(fresh.siteReference ? { reference: fresh.siteReference } : {}),
      };
    } else if (
      !equalStructuredValues(
        {
          ...(fresh.target ? { concept: fresh.target } : {}),
          ...(fresh.siteReference ? { reference: fresh.siteReference } : {}),
        },
        delta.site
      )
    ) {
      superseded = true;
      addWarning(
        warnings,
        "Retained R6 site metadata was superseded by an edited R5 site and preserved only as source provenance."
      );
    }
  }
  if (delta?.doseAndRate) {
    const matched = retainedDoseRateMatches(delta.doseAndRate, row.doseAndRate ?? []);
    const used = new Set<number>();
    let supersededExpression = false,
      supersededQuantity = false;
    for (let i = 0; i < (fresh.amounts?.length ?? 0); i++) {
      const entry = fresh.amounts![i],
        sourceIndex = matched.get(i);
      if (sourceIndex === undefined) continue;
      used.add(sourceIndex);
      const old = delta.doseAndRate[sourceIndex];
      if (!old) continue;
      const baseline = local.baseline?.doseAndRate?.[sourceIndex];
      const live = row.doseAndRate?.[i];
      const unchangedDose = !!(
        baseline?.dose !== undefined &&
        (old.doseExpression || old.doseQuantity?.comparator) &&
        baseline.dose ===
          compactProjectionFingerprint({
            doseQuantity: simpleQuantityForR5(live?.doseQuantity),
            doseRange: live?.doseRange,
          })
      );
      const unchangedRate = !!(
        baseline?.rate !== undefined &&
        (old.rateExpression ||
          old.rateQuantity?.comparator ||
          old.rateRatio?.numerator?.comparator === "~") &&
        baseline.rate ===
          compactProjectionFingerprint({
            rateQuantity: simpleQuantityForR5(live?.rateQuantity),
            rateRange: live?.rateRange,
            rateRatio: live?.rateRatio,
          })
      );
      if (
        !unchangedDose &&
        old.doseExpression &&
        equalStructuredValues(entry.expression, old.doseExpression) &&
        (entry.quantity || entry.range)
      ) {
        delete entry.expression;
        supersededExpression = true;
      }
      if (
        !unchangedRate &&
        old.rateExpression &&
        equalStructuredValues(entry.rateExpression, old.rateExpression) &&
        (entry.rate || entry.rateRange || entry.rateRatio)
      ) {
        delete entry.rateExpression;
        supersededExpression = true;
      }
      if (old.doseExpression) {
        if (unchangedDose && !entry.expression) entry.expression = old.doseExpression;
        else if (!equalStructuredValues(entry.expression, old.doseExpression)) supersededExpression = true;
      }
      if (old.doseQuantity?.comparator) {
        if (
          unchangedDose &&
          !entry.expression &&
          (!entry.quantity ||
            equalStructuredValues(simpleQuantityForR5(entry.quantity), simpleQuantityForR5(old.doseQuantity)))
        )
          entry.quantity = old.doseQuantity;
        else {
          if (
            entry.expression &&
            equalStructuredValues(simpleQuantityForR5(entry.quantity), simpleQuantityForR5(old.doseQuantity))
          )
            delete entry.quantity;
          if (!equalStructuredValues(entry.quantity, old.doseQuantity)) supersededQuantity = true;
        }
      }
      if (old.rateExpression) {
        if (unchangedRate && !entry.rateExpression) entry.rateExpression = old.rateExpression;
        else if (!equalStructuredValues(entry.rateExpression, old.rateExpression))
          supersededExpression = true;
      }
      if (old.rateQuantity?.comparator) {
        if (
          unchangedRate &&
          !entry.rateExpression &&
          (!entry.rate ||
            equalStructuredValues(simpleQuantityForR5(entry.rate), simpleQuantityForR5(old.rateQuantity)))
        )
          entry.rate = old.rateQuantity;
        else {
          if (
            entry.rateExpression &&
            equalStructuredValues(simpleQuantityForR5(entry.rate), simpleQuantityForR5(old.rateQuantity))
          )
            delete entry.rate;
          if (!equalStructuredValues(entry.rate, old.rateQuantity)) supersededQuantity = true;
        }
      }
      if (old.rateRatio?.numerator?.comparator === "~") {
        if (unchangedRate && !entry.rateExpression) entry.rateRatio = old.rateRatio;
        else {
          const oldR5 = { ...old.rateRatio, numerator: quantityForR5(old.rateRatio.numerator) };
          if (
            equalStructuredValues(live?.rateRatio, oldR5) &&
            (entry.rateExpression || entry.rate || entry.rateRange)
          )
            delete entry.rateRatio;
          if (!equalStructuredValues(entry.rateRatio, old.rateRatio)) supersededQuantity = true;
        }
      }
    }
    for (let i = 0; i < delta.doseAndRate.length; i++)
      if (!used.has(i)) {
        const old = delta.doseAndRate[i];
        if (old.doseExpression || old.rateExpression) supersededExpression = true;
        if (
          old.doseQuantity?.comparator ||
          old.rateQuantity?.comparator ||
          old.rateRatio?.numerator?.comparator === "~"
        )
          supersededQuantity = true;
      }
    if (supersededExpression) {
      superseded = true;
      addWarning(
        warnings,
        "Retained R6 dose/rate expressions superseded by edited R5 dose fields were preserved only as inert source provenance."
      );
    }
    if (supersededQuantity) {
      superseded = true;
      addWarning(
        warnings,
        "Retained R6 dose/rate Quantity comparators superseded by edited R5 fields were preserved only as inert source provenance."
      );
    }
  }
  if (Object.keys(retained).length)
    fresh.provenance = { format: "r5", data: row as Record<string, unknown>, retained };
  return { dosage: fresh, superseded };
}

/** Decode the edit baseline once. Each child is visited exactly once;
 * first-occurrence semantics match the persisted marker contract, including
 * malformed/undefined fields. This is source metadata, not new parsing. */
function instructionBaseline(marker: FhirExtension | undefined): {
  instruction: string | undefined;
  rows: Array<{ projection?: string; text?: string }>;
  complete: boolean;
} {
  let instruction: string | undefined,
    instructionSeen = false,
    complete = true;
  const rows: Array<{ projection?: string; text?: string }> = [];
  for (const item of marker?.extension ?? []) {
    if (item.url === "instruction" && !instructionSeen) {
      instructionSeen = true;
      instruction = item.valueString;
    }
    if (item.url !== "row") continue;
    const row: { projection?: string; text?: string } = {};
    let seen = 0;
    for (const field of item.extension ?? []) {
      if (field.url === "projectionFingerprint" && !(seen & 1)) {
        seen |= 1;
        row.projection = field.valueString;
      } else if (field.url === "textFingerprint" && !(seen & 2)) {
        seen |= 2;
        row.text = field.valueString;
      }
    }
    if (!row.projection || !row.text) complete = false;
    rows.push(row);
  }
  return { instruction, rows, complete: complete && rows.length > 0 };
}

function reconcileNativeCompactCourse(
  dosages: readonly (FhirDosage | EzDosage)[],
  renderedInstruction?: string,
  editedCourse?: EzCourseMetadata,
  resolvedPhaseSequences?: readonly number[],
  sourceContext = false
): CanonicalCourse {
  const warnings: string[] = [];
  const resolvedSequences = new Set(resolvedPhaseSequences ?? []);
  const sources: FhirExtension[] = [];
  const headers = new Map<string, CompactCourseRow>();
  const conflictingContexts = new Set<string>();
  const conflictingPhases = new Set<number>();
  let metadataEdited = false;
  const metadata = new Map<
    number,
    { step: NonNullable<CompactCourseRow["step"]>; rowIndex: number; marker?: FhirExtension }
  >();
  const localRows = dosages.map((dosage) => {
    const marker = compactCourseMarker(dosage);
    for (const extension of dosage.modifierExtension ?? []) {
      if (extension.url === DOSAGE_DETAILS_R5_URL && extension !== marker) sources.push(extension);
    }
    if (!marker) return undefined;
    const decoded = decodeR5RetainedFields(marker);
    if (
      typeof decoded.rowIndex !== "number" ||
      !Number.isInteger(decoded.rowIndex) ||
      decoded.rowIndex < 0 ||
      typeof decoded.sequence !== "number" ||
      !Number.isInteger(decoded.sequence) ||
      decoded.sequence < 1 ||
      typeof decoded.stepCount !== "number" ||
      !Number.isInteger(decoded.stepCount) ||
      decoded.stepCount < 1
    ) {
      sources.push(marker);
      addWarning(
        warnings,
        "Malformed retained R6 course metadata was preserved; live R5 fields remain available for correction."
      );
      return undefined;
    }
    const value = {
      ...decoded,
      rowIndex: decoded.rowIndex,
      sequence: decoded.sequence,
      stepCount: decoded.stepCount,
    } as CompactCourseRow;
    if (
      !equalStructuredValues(marker, { url: DOSAGE_DETAILS_R5_URL, extension: encodeR5RetainedFields(value) })
    )
      sources.push(localReconciliationSource(marker));
    if (value.context && (value.course || value.emptyStep)) {
      const previous = headers.get(value.context);
      if (
        previous &&
        (!equalStructuredValues(previous.course, value.course) ||
          !equalStructuredValues(previous.emptyStep, value.emptyStep))
      ) {
        if (value.contextRequired || previous.contextRequired) conflictingContexts.add(value.context);
        sources.push({
          url: DOSAGE_DETAILS_R5_URL,
          extension: encodeR5RetainedFields({
            course: previous.course,
            emptyStep: previous.emptyStep,
          }),
        });
        sources.push({
          url: DOSAGE_DETAILS_R5_URL,
          extension: marker.extension?.filter((child) => child.url === "course" || child.url === "emptyStep"),
        });
        addWarning(
          warnings,
          "Conflicting shared course metadata was preserved; resolve the shared owner before numeric execution."
        );
      } else if (!previous) headers.set(value.context, value);
    } else if (value.course || value.emptyStep) {
      sources.push(marker);
      addWarning(
        warnings,
        "Shared course metadata without its context identity was retained as source provenance."
      );
    }
    let hasConflict = false;
    for (const context of value.missingContext ?? [])
      if (context === CONFLICTING_PHASE_CONTEXT) {
        hasConflict = true;
        break;
      }
    if (hasConflict) {
      if (resolvedSequences.has(value.sequence)) sources.push(localReconciliationSource(marker));
      else conflictingPhases.add(value.sequence);
    }
    const previous = metadata.get(value.sequence);
    const step = value.step ?? {};
    if (previous && !equalStructuredValues(previous.step, step)) {
      if (previous.marker) sources.push(localReconciliationSource(previous.marker));
      sources.push(localReconciliationSource(marker));
      if (!equalStructuredValues(executablePhaseMetadata(previous.step), executablePhaseMetadata(step))) {
        conflictingPhases.add(value.sequence);
        addWarning(
          warnings,
          "Local course phase metadata differs; conflicting executable fields must be resolved before numeric execution."
        );
      } else
        addWarning(
          warnings,
          "Local course phase metadata differs; the first source row's annotations were retained and conflicting metadata was preserved."
        );
    }
    if (!previous || value.rowIndex < previous.rowIndex)
      metadata.set(value.sequence, { step, rowIndex: value.rowIndex, marker });
    return { value, marker };
  });
  // A separately persisted .course object can restore the same shared owner.
  // Match the declared context; an unrelated partial object cannot erase a cycle.
  if (editedCourse) {
    const { step, renderedInstruction: _instruction, ...course } = editedCourse;
    const base = Object.keys(course).length ? { course } : {};
    const candidates: Array<Pick<CompactCourseRow, "course" | "emptyStep">> = [base];
    const liveSequences = new Set(dosages.map((dosage) => dosage.sequence ?? 1));
    const emptyStep = step?.filter((value) => !liveSequences.has(value.sequence));
    if (emptyStep?.length) candidates.push({ ...base, emptyStep });
    for (const candidate of candidates) {
      const key = compactProjectionFingerprint(candidate);
      if (!headers.has(key))
        headers.set(key, {
          rowIndex: 0,
          sequence: 1,
          stepCount: 1,
          context: key,
          ...candidate,
        });
    }
  }
  const missing = new Set<string>(conflictingContexts);
  let header: CompactCourseRow | undefined;
  for (const local of localRows) {
    if (!local) continue;
    if (local.value.context) {
      const owner = headers.get(local.value.context);
      if (!owner && local.value.contextRequired) missing.add(local.value.context);
      else if (owner && !header) header = owner;
      else if (
        owner &&
        header &&
        (!equalStructuredValues(header.course, owner.course) ||
          !equalStructuredValues(header.emptyStep, owner.emptyStep))
      ) {
        missing.add(local.value.context);
        sources.push(localReconciliationSource(local.marker));
      }
    }
    for (const context of local.value.missingContext ?? []) {
      if (context !== CONFLICTING_PHASE_CONTEXT) missing.add(context);
    }
  }
  for (const step of header?.emptyStep ?? []) {
    const { sequence, ...fields } = step;
    metadata.set(sequence, { step: fields, rowIndex: -1 });
  }
  const editedSequences = new Set<number>();
  for (const step of editedCourse?.step ?? []) {
    const { sequence, ...fields } = step;
    if (!Number.isInteger(sequence) || sequence < 1) {
      sources.push(retainedCourseStepSource(step));
      addWarning(
        warnings,
        "Invalid course step metadata was retained on the course but could not be assigned to an R6 stage."
      );
      continue;
    }
    if (editedSequences.has(sequence)) {
      sources.push(retainedCourseStepSource(step));
      addWarning(
        warnings,
        "Duplicate course step metadata was retained as source provenance; the first editable stage metadata was used."
      );
      continue;
    }
    editedSequences.add(sequence);
    const previous = metadata.get(sequence);
    // Compact rows keep R6 wrappers; edit fields are R5. Split their owners
    // before merging so clearing native extensions does not clear modifiers.
    const merged = r6StepMetadata({ ...r5StepMetadata(previous?.step ?? {}), ...fields });
    if (!equivalentProjection(previous?.step ?? {}, merged)) {
      metadataEdited = true;
      if (previous?.marker) sources.push(localReconciliationSource(previous.marker));
    }
    metadata.set(sequence, { step: merged, rowIndex: -1 });
  }
  let instructionMarker: FhirExtension | undefined;
  for (const dosage of dosages) {
    instructionMarker = dosage.extension?.find(isRenderedInstructionMarker);
    if (instructionMarker) break;
  }
  const parsedBaseline = instructionBaseline(instructionMarker);
  const savedInstruction = parsedBaseline.instruction,
    baselineRows = parsedBaseline.rows;
  const used = new Set<number>();
  let instructionMatches =
    !metadataEdited &&
    !conflictingPhases.size &&
    baselineRows.length === dosages.length &&
    baselineRows.length > 0;
  const live = dosages.map((dosage, index) => {
    const local = localRows[index];
    const sourceIndex = local?.value.rowIndex ?? index;
    const baseline = baselineRows[sourceIndex];
    const expectedProjection = baseline?.projection,
      expectedText = baseline?.text;
    const expanded = dosage as EzDosage;
    const delta = local?.value.component;
    const nativeCleared = Boolean(
      delta &&
        ((delta.site?.reference &&
          Object.prototype.hasOwnProperty.call(expanded, "siteReference") &&
          !equalStructuredValues(delta.site.reference, expanded.siteReference)) ||
          (delta.condition !== undefined &&
            expanded.condition !== undefined &&
            !equalStructuredValues(delta.condition, expanded.condition)))
    );
    const projectionMatches =
      !nativeCleared &&
      (expectedProjection === undefined || expectedProjection === dosageProjectionFingerprint(dosage));
    const textMatches = expectedText === undefined || expectedText === dosageTextFingerprint(dosage);
    if (!projectionMatches || !textMatches || used.has(sourceIndex) || !baseline) instructionMatches = false;
    used.add(sourceIndex);
    if (local && (!projectionMatches || !textMatches)) sources.push(localReconciliationSource(local.marker));
    return !projectionMatches && textMatches ? { ...dosage, text: undefined } : dosage;
  });
  const { step: _editedSteps, renderedInstruction: explicitInstruction, ...courseEdits } = editedCourse ?? {};
  if (editedCourse && !equivalentProjection(header?.course ?? {}, { ...header?.course, ...courseEdits })) {
    instructionMatches = false;
    if (header?.course) {
      // The shared R6 course header is a separate editable owner from each
      // R5 row. A course.safety replacement must retain its original unknown
      // metadata, even when no renderedInstruction baseline was ever stored.
      // Never recursively embed already-flat reconciliation history.
      const priorExtensions = header.course.extension;
      const original = {
        ...header.course,
        ...(priorExtensions
          ? { extension: priorExtensions.filter((item) => item.url !== DOSAGE_RECONCILIATION_SOURCE_URL) }
          : {}),
      };
      sources.push({ url: DOSAGE_DETAILS_R5_URL, extension: encodeR5RetainedFields({ course: original }) });
      if (courseEdits.extension !== undefined)
        for (const item of priorExtensions ?? []) {
          if (item.url === DOSAGE_RECONCILIATION_SOURCE_URL) sources.push(...(item.extension ?? []));
        }
      addWarning(
        warnings,
        "Edited course metadata superseded the retained course header; its original fields remain source provenance."
      );
    }
  }
  const groups = new Map<number, CanonicalAdministration[]>();
  live.forEach((dosage, index) => {
    const requested = dosage.sequence ?? 1;
    const sequence = Number.isInteger(requested) && requested >= 1 ? requested : 1;
    if (sequence !== requested)
      addWarning(
        warnings,
        "Invalid Dosage.sequence was preserved in the component and projected into the first stage for correction."
      );
    const local = localRows[index];
    const restored = local ? restoreComponentDelta(dosage, local.value, warnings, sourceContext) : undefined;
    const liveComponent = restored?.dosage ?? administrationFromR5(dosage, sourceContext);
    const component =
      local && conflictingPhases.has(local.value.sequence)
        ? withMissingCourseContext(liveComponent, [CONFLICTING_PHASE_CONTEXT])
        : liveComponent;
    // This marker belongs to this row, not any row that happened to precede
    // a shared warning. Preserve superseded original R6 values once.
    if (restored?.superseded && local) sources.push(localReconciliationSource(local.marker));
    const entries = groups.get(sequence) ?? [];
    entries.push(component);
    groups.set(sequence, entries);
  });
  // A missing predecessor is a real, editable empty stage: surviving
  // sequence-2 rows must NOT silently become sequence 1. But an arbitrary
  // persisted stepCount is not permission to allocate billions of stages.
  // Fill only the observed stage range (including retained explicit empty
  // steps), bounded to 10,000 stages. Preserve the original marker as inert
  // provenance when a malformed index exceeds that representable limit.
  const sequences = new Set([...groups.keys(), ...metadata.keys()]);
  const stageCount = Math.max(0, ...localRows.map((local) => local?.value.stepCount ?? 0));
  const observedLast = Math.max(0, ...sequences);
  const fillCount = Math.min(stageCount, observedLast, 10_000);
  for (let sequence = 1; sequence <= fillCount; sequence++) sequences.add(sequence);
  if (stageCount > 10_000 || observedLast > 10_000) {
    for (const local of localRows) {
      if (local && (local.value.stepCount > 10_000 || local.value.sequence > 10_000))
        sources.push(localReconciliationSource(local.marker));
    }
    addWarning(
      warnings,
      "An excessive retained course stage index was kept as source provenance rather than allocating empty stages."
    );
  }
  const steps: CanonicalStage[] = [];
  for (const sequence of [...sequences].sort((a, b) => a - b))
    steps.push(
      stageFromFields(r6StepMetadata(metadata.get(sequence)?.step ?? {}), groups.get(sequence) ?? [])
    );
  // A removed predecessor is harmless when the surviving phase has its own
  // treatment-relative start. Otherwise its original elapsed time is unknown.
  let missingPredecessor = false;
  for (const step of steps) {
    if (!step.administrations.length && !step.start && !step.end) {
      missingPredecessor = true;
      continue;
    }
    if (missingPredecessor && !step.start && step.administrations.length) missing.add("predecessor");
    if (step.start || step.end || step.administrations.length) missingPredecessor = false;
  }
  if (missing.size) {
    addWarning(warnings, "Required course context is missing; surviving dosage fields remain editable.");
    for (const step of steps)
      step.administrations = step.administrations.map((component) =>
        withMissingCourseContext(component, [...missing])
      );
    instructionMatches = false;
  }
  const result = courseFromFields(
    {
      ...header?.course,
      ...courseEdits,
      ...(explicitInstruction !== undefined
        ? { renderedInstruction: explicitInstruction }
        : renderedInstruction !== undefined
        ? { renderedInstruction }
        : instructionMatches && savedInstruction !== undefined
        ? { renderedInstruction: savedInstruction }
        : {}),
    },
    steps
  );
  if (savedInstruction !== undefined && !instructionMatches)
    addWarning(
      warnings,
      "Structured dosage fields changed; the original rendered instruction was retained as source provenance instead of displayed as the current instruction."
    );
  return withPreservedSourceExtension(
    withReconciliationSources(withReconciliationWarnings(result, warnings), sources),
    instructionMarker && (!instructionMatches || hasUnrecognizedEditMetadata(instructionMarker))
      ? instructionMarker
      : undefined
  );
}

/** Bucketed exact projection matching. Signatures narrow candidates, then
 * the established metadata-aware equivalence is checked before claiming one.
 * Equal duplicates advance a cursor instead of rescanning used prefixes. */
function indexedProjectionMatcher(
  originals: readonly object[],
  used: Set<number>
): (current: object) => number {
  const buckets = new Map<string, { indices: number[]; cursor: number }>();
  for (let i = 0; i < originals.length; i++) {
    const key = matchingProjectionFingerprint(originals[i]);
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, (bucket = { indices: [], cursor: 0 }));
    bucket.indices.push(i);
  }
  return (current) => {
    const bucket = buckets.get(matchingProjectionFingerprint(current));
    if (!bucket) return -1;
    while (bucket.cursor < bucket.indices.length && used.has(bucket.indices[bucket.cursor])) bucket.cursor++;
    for (let position = bucket.cursor; position < bucket.indices.length; position++) {
      const index = bucket.indices[position];
      if (used.has(index) || !equivalentProjection(originals[index], current)) continue;
      if (position === bucket.cursor) bucket.cursor++;
      return index;
    }
    return -1;
  };
}

function reconcileNativeRetainedCourse(
  retained: FhirR6DosageInstruction,
  dosages: readonly (FhirDosage | EzDosage)[],
  editedInstruction?: string,
  course?: EzCourseMetadata,
  preserveRetainedMarkers = false,
  initialWarnings: readonly string[] = [],
  retainedSource?: FhirExtension,
  additionalSources: readonly FhirExtension[] = [],
  sourceContext = false
): CanonicalCourse {
  const sourceRows = new Map<
    FhirR6Dosage,
    Map<number, { native: CanonicalAdministration; row: FhirDosage }>
  >();
  const sourceMember = (component: FhirR6Dosage, sequence: number) => {
    let phases = sourceRows.get(component);
    if (!phases) sourceRows.set(component, (phases = new Map()));
    let existing = phases.get(sequence);
    if (existing) return existing;
    const native = administrationFromR6(component, sourceContext);
    existing = { native, row: administrationToR5(native, sequence) };
    phases.set(sequence, existing);
    return existing;
  };
  const warnings = [...initialWarnings];
  const sourceFragments = [...additionalSources];
  const groups = new Map<number, (FhirDosage | EzDosage)[]>();
  for (const dosage of dosages) {
    const requestedSequence = dosage.sequence ?? 1;
    const sequence = Number.isInteger(requestedSequence) && requestedSequence >= 1 ? requestedSequence : 1;
    if (sequence !== requestedSequence) {
      preserveRetainedMarkers = true;
      addWarning(
        warnings,
        "An invalid edited Dosage.sequence was retained in the raw R5 course marker and projected into the first stage for correction."
      );
    }
    if (!groups.has(sequence)) groups.set(sequence, []);
    groups.get(sequence)!.push(dosage);
  }
  const metadata = new Map<number, NonNullable<EzCourseMetadata["step"]>[number]>();
  for (const step of course?.step ?? []) {
    if (!Number.isInteger(step.sequence) || step.sequence < 1) {
      sourceFragments.push(retainedCourseStepSource(step));
      addWarning(
        warnings,
        "Invalid course step metadata was retained on the course but could not be assigned to an R6 stage."
      );
      continue;
    }
    if (metadata.has(step.sequence)) {
      sourceFragments.push(retainedCourseStepSource(step));
      addWarning(
        warnings,
        "Duplicate course step metadata was retained as source provenance; the first editable stage metadata was used."
      );
      continue;
    }
    metadata.set(step.sequence, step);
  }
  const sequenceSet = new Set<number>([
    ...retained.step.map((_, index) => index + 1),
    ...groups.keys(),
    ...metadata.keys(),
  ]);
  const sequences = [...sequenceSet].sort((a, b) => a - b);
  const liveSequences = [...groups.keys()].sort((a, b) => a - b);
  if (
    liveSequences.length !== retained.step.length ||
    liveSequences.some((sequence, index) => sequence !== index + 1)
  ) {
    preserveRetainedMarkers = true;
    addWarning(
      warnings,
      "Edited R5 stages differ from the retained R6 course; live stages were merged deterministically and the raw course marker was retained."
    );
  }
  let projectionChanged = false;
  const projectedSources = new Map<number, object[]>();
  const projectedLive = new Map<FhirDosage | EzDosage, object>();
  const liveProjection = (row: FhirDosage | EzDosage): object => {
    let value = projectedLive.get(row);
    if (value === undefined) {
      value = liveDosageProjection(row);
      projectedLive.set(row, value);
    }
    return value;
  };
  for (let index = 0; index < retained.step.length; index++) {
    const step = retained.step[index],
      live = groups.get(index + 1) ?? [];
    if (live.length !== step.component.length) {
      projectionChanged = true;
      break;
    }
    const originals: object[] = [];
    for (const component of step.component)
      originals.push(liveDosageProjection(sourceMember(component, index + 1).row));
    projectedSources.set(index + 1, originals);
    const used = new Set<number>(),
      matchProjection = indexedProjectionMatcher(originals, used);
    for (const dosage of live) {
      const match = matchProjection(liveProjection(dosage));
      if (match < 0) {
        projectionChanged = true;
        break;
      }
      used.add(match);
    }
    if (projectionChanged) break;
  }
  if (projectionChanged) {
    preserveRetainedMarkers = true;
    addWarning(
      warnings,
      "Edited R5 component fields were merged with retained R6 data; the raw source snapshot was also preserved for review."
    );
  }
  const anyComponentCountChanged = retained.step.some(
    (step, index) => (groups.get(index + 1)?.length ?? 0) !== step.component.length
  );
  if (anyComponentCountChanged) {
    preserveRetainedMarkers = true;
    addWarning(
      warnings,
      "An R6 stage gained or lost components; unchanged rows were matched first, remaining rows were paired by stable order, and the source snapshot was retained."
    );
  }
  let structuredChanged = Boolean(
    (course?.id !== undefined && course.id !== retained.id) ||
      (course?.extension !== undefined &&
        !equivalentProjection({ extension: retained.extension }, { extension: course.extension })) ||
      (course?.modifierExtension !== undefined &&
        !equivalentProjection(
          { modifierExtension: retained.modifierExtension },
          { modifierExtension: course.modifierExtension }
        )) ||
      (course?.repeatCycle !== undefined &&
        !equivalentProjection(retained.repeatCycle, course.repeatCycle)) ||
      (course?.safety !== undefined && !equivalentProjection(retained.safety, course.safety))
  );
  const steps: CanonicalStage[] = [];
  for (const sequence of sequences) {
    const step = retained.step[sequence - 1];
    const live = groups.get(sequence) ?? [];
    const editedStep = metadata.get(sequence);
    const { component: _retainedComponents, ...retainedStepFields } = step ?? { component: [] };
    // A course edit is partial: merge it with the retained R5 fields before
    // moving modifiers back into their R6 wrapper. Native extensions and
    // modifiers have independent owners; clearing one must not erase the other.
    const editedR6Step = editedStep
      ? r6StepMetadata({ ...r5StepMetadata(retainedStepFields), ...editedStep })
      : retainedStepFields;
    if (!step) {
      structuredChanged = true;
      addWarning(
        warnings,
        "A live R5 stage has no retained R6 counterpart; its current fields were preserved as a new stage."
      );
      steps.push(
        stageFromFields(
          editedR6Step,
          live.map((dosage) => administrationFromR5(dosage, sourceContext))
        )
      );
      continue;
    }
    if (editedStep && !equivalentProjection(retainedStepFields, editedR6Step)) {
      structuredChanged = true;
    }
    const componentCountChanged = live.length !== step.component.length;
    if (componentCountChanged) {
      structuredChanged = true;
    }
    const components: CanonicalAdministration[] = [];
    // Match every unchanged R5 component BEFORE assigning an original
    // position to a changed row. A swapped-and-edited dosage must not claim
    // the original slot of an unedited dosage that appears later.
    let originalProjections = projectedSources.get(sequence);
    if (!originalProjections) {
      originalProjections = [];
      for (const component of step.component)
        originalProjections.push(liveDosageProjection(sourceMember(component, sequence).row));
    }
    const usedOriginalIndices = new Set<number>();
    const matchProjection = indexedProjectionMatcher(originalProjections, usedOriginalIndices);
    const assigned: number[] = new Array(live.length).fill(-1);
    const originalIds = new Map<string, number>();
    const liveIdCounts = new Map<string, number>();
    // A unique alternative branch also supplies source identity when a
    // strict R5 editor changes and reorders rows without element IDs.
    // Repeated membership is not an identity: one branch may contain several
    // concurrent dosages, so such rows use the existing ID/projection rules.
    let originalChoiceIndices: Map<string, number> | undefined;
    let liveChoiceCounts: Map<string, number> | undefined;
    const choiceKey = (choice: DosageAlternativeChoice): string =>
      choice.groupId.length + ":" + choice.groupId + choice.branchId;
    for (let index = 0; index < step.component.length; index++) {
      const component = step.component[index];
      if (component.id) originalIds.set(component.id, originalIds.has(component.id) ? -1 : index);
      const choice = getDosageAlternativeChoice(component);
      if (choice) {
        const indices = originalChoiceIndices ?? (originalChoiceIndices = new Map());
        const key = choiceKey(choice);
        indices.set(key, indices.has(key) ? -1 : index);
      }
    }
    for (const dosage of live) {
      if (dosage.id) liveIdCounts.set(dosage.id, (liveIdCounts.get(dosage.id) ?? 0) + 1);
      const choice = getDosageAlternativeChoice(dosage);
      if (choice) {
        const counts = liveChoiceCounts ?? (liveChoiceCounts = new Map());
        const key = choiceKey(choice);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    for (let j = 0; j < live.length; j++) {
      const id = live[j].id;
      if (!id || liveIdCounts.get(id) !== 1) continue;
      const match = originalIds.get(id);
      if (match !== undefined && match >= 0) {
        assigned[j] = match;
        usedOriginalIndices.add(match);
      }
    }
    if (originalChoiceIndices && liveChoiceCounts) {
      for (let j = 0; j < live.length; j++) {
        if (assigned[j] >= 0) continue;
        const choice = getDosageAlternativeChoice(live[j]);
        if (!choice) continue;
        const key = choiceKey(choice);
        const match = originalChoiceIndices.get(key);
        if (
          liveChoiceCounts.get(key) === 1 &&
          match !== undefined &&
          match >= 0 &&
          !usedOriginalIndices.has(match)
        ) {
          assigned[j] = match;
          usedOriginalIndices.add(match);
        }
      }
    }
    for (let j = 0; j < live.length; j++) {
      if (assigned[j] >= 0) continue;
      const current = liveProjection(live[j]);
      const exact = matchProjection(current);
      if (exact >= 0) {
        assigned[j] = exact;
        usedOriginalIndices.add(exact);
      }
    }
    const siteGroups = new Map<string, Set<number>>();
    for (let i = 0; i < step.component.length; i++)
      if (!usedOriginalIndices.has(i)) {
        const site = step.component[i].site?.concept;
        if (!site) continue;
        const key = matchingProjectionFingerprint(site);
        let group = siteGroups.get(key);
        if (!group) siteGroups.set(key, (group = new Set()));
        group.add(i);
      }
    for (let j = 0; j < live.length; j++) {
      if (assigned[j] >= 0 || !live[j].site) continue;
      const site = live[j].site,
        group = siteGroups.get(matchingProjectionFingerprint(site));
      if (!group) continue;
      let match = -1;
      for (const index of group) {
        if (!equivalentProjection(site, step.component[index].site?.concept)) continue;
        if (match >= 0) {
          match = -2;
          break;
        }
        match = index;
      }
      if (match >= 0) {
        assigned[j] = match;
        usedOriginalIndices.add(match);
        group.delete(match);
      }
    }
    // When a whole component was deleted, arbitrarily shifting unmatched
    // source rows would attach the wrong retained expression/site to a
    // survivor. Preserve unmatched original course data as provenance.
    const unclaimed: number[] = [],
      remainingLive: number[] = [];
    for (let i = 0; i < step.component.length; i++) if (!usedOriginalIndices.has(i)) unclaimed.push(i);
    for (let i = 0; i < live.length; i++) if (assigned[i] < 0) remainingLive.push(i);
    if (!componentCountChanged || (unclaimed.length === 1 && remainingLive.length === 1)) {
      let unclaimedCursor = 0;
      for (const j of remainingLive) {
        const next = unclaimed[unclaimedCursor++];
        if (next !== undefined) {
          assigned[j] = next;
          usedOriginalIndices.add(next);
        }
      }
    }
    for (let j = 0; j < live.length; j++) {
      const dosage = live[j];
      const oldIndex = assigned[j];
      const old = oldIndex >= 0 ? step.component[oldIndex] : undefined;
      const baseline = old ? sourceMember(old, sequence).row : undefined;
      const rawEqual =
        old !== undefined &&
        baseline !== undefined &&
        equivalentProjection(liveDosageProjection(baseline), liveDosageProjection(dosage));
      const expanded = dosage as EzDosage;
      const datesEqual =
        old !== undefined &&
        equalStructuredValues(getDosageExcludedDates(dosage), getDosageExcludedDates(baseline!));
      const conditionsEqual =
        expanded.condition === undefined ||
        (old !== undefined && equivalentProjection(old.condition, expanded.condition));
      const safetyEqual =
        expanded.safety === undefined ||
        (old !== undefined && equivalentProjection(old.safety, expanded.safety));
      // An explicitly present but undefined native field is a clinician edit
      // clearing a previously retained R6-only BodyStructure reference.
      // An absent field means an ordinary strict R5 row, which cannot express
      // that reference and must continue to inherit it from retained source.
      const siteReferenceSpecified = Object.prototype.hasOwnProperty.call(expanded, "siteReference");
      const referenceEqual =
        !siteReferenceSpecified ||
        (old !== undefined && equivalentProjection(old.site?.reference, expanded.siteReference));
      if (!rawEqual || !datesEqual || !conditionsEqual || !safetyEqual || !referenceEqual)
        structuredChanged = true;
      if (old && rawEqual && datesEqual && conditionsEqual && safetyEqual && referenceEqual) {
        components.push(sourceMember(old, sequence).native);
        continue;
      }
      // Read this edited R5 row into the clinical model, then restore only
      // source-owned fields whose own live slot still matches its baseline.
      // This is the same native restoration rule as compact row imports.
      const local: CompactCourseRow = { rowIndex: j, sequence, stepCount: retained.step.length };
      if (old && baseline) {
        local.component = old;
        local.baseline = {
          condition: compactProjectionFingerprint(r5ConditionBaseline(baseline)),
          safety: compactProjectionFingerprint(r5SafetyBaseline(baseline)),
          site: compactProjectionFingerprint({
            concept: baseline.site,
            reference: (baseline as EzDosage).siteReference,
          }),
          doseAndRate: old.doseAndRate?.map((entry, index) => ({
            ...(entry.doseExpression || entry.doseQuantity?.comparator
              ? {
                  dose: compactProjectionFingerprint({
                    doseQuantity: baseline.doseAndRate?.[index]?.doseQuantity,
                    doseRange: baseline.doseAndRate?.[index]?.doseRange,
                  }),
                }
              : {}),
            ...(entry.rateExpression ||
            entry.rateQuantity?.comparator ||
            entry.rateRatio?.numerator?.comparator === "~"
              ? {
                  rate: compactProjectionFingerprint({
                    rateQuantity: baseline.doseAndRate?.[index]?.rateQuantity,
                    rateRange: baseline.doseAndRate?.[index]?.rateRange,
                    rateRatio: baseline.doseAndRate?.[index]?.rateRatio,
                  }),
                }
              : {}),
          })),
        };
        if (old.timing?.repeat && (old.timing.repeat.startOffset || old.timing.repeat.endOffset)) {
          local.timingOffsets = {
            startOffset: old.timing.repeat.startOffset,
            endOffset: old.timing.repeat.endOffset,
          };
          local.baseline.timing = offsetCadenceFingerprint(baseline.timing);
        }
      }
      const fresh = old
        ? restoreComponentDelta(dosage, local, warnings, sourceContext).dosage
        : administrationFromR5(dosage, sourceContext);
      components.push(fresh);
    }
    steps.push(stageFromFields(editedR6Step, components));
  }
  const { renderedInstruction: retainedInstruction, step: _retainedSteps, ...retainedFields } = retained;
  const result = courseFromFields(
    {
      ...retainedFields,
      ...(course?.id !== undefined ? { id: course.id } : {}),
      ...(course?.extension !== undefined ? { extension: course.extension } : {}),
      ...(course?.modifierExtension !== undefined ? { modifierExtension: course.modifierExtension } : {}),
      ...(course?.repeatCycle !== undefined ? { repeatCycle: course.repeatCycle } : {}),
      ...(course?.safety !== undefined ? { safety: course.safety } : {}),
      ...(editedInstruction !== undefined
        ? { renderedInstruction: editedInstruction }
        : !structuredChanged && retainedInstruction !== undefined
        ? { renderedInstruction: retainedInstruction }
        : {}),
    },
    steps
  );
  if (structuredChanged && editedInstruction === undefined && retainedInstruction !== undefined) {
    addWarning(
      warnings,
      "Structured dosage fields changed; the original rendered instruction was retained as source provenance instead of displayed as the current instruction."
    );
  }
  if (
    (structuredChanged || preserveRetainedMarkers) &&
    retainedSource &&
    !retained.extension?.some((extension) => extension.url === DOSAGE_RECONCILIATION_SOURCE_URL)
  ) {
    sourceFragments.unshift(retainedSource);
  }
  return withReconciliationSources(withReconciliationWarnings(result, warnings), sourceFragments);
}

export function courseFromR5(
  dosages: readonly (FhirDosage | EzDosage)[],
  renderedInstruction?: string,
  course?: EzCourseMetadata,
  options?: { resolvedPhaseSequences?: readonly number[] },
  sourceContext = false
): CanonicalCourse {
  if (dosages.some(compactCourseMarker))
    return reconcileNativeCompactCourse(
      dosages,
      renderedInstruction,
      course,
      options?.resolvedPhaseSequences,
      sourceContext
    );
  // Import historical complete-course markers without emitting them again.
  // Earlier persisted R5 rows can carry an entire source course. Select the
  // first structurally usable snapshot deterministically; keep malformed or
  // disagreeing copies once as inert course-level source provenance.
  let original: FhirExtension | undefined;
  let retained: FhirR6DosageInstruction | undefined;
  let retainedSource: FhirExtension | undefined;
  const reconciliationSources: FhirExtension[] = [];
  let preserveRetainedMarkers = false;
  const warnings: string[] = [];
  for (const dosage of dosages) {
    for (const extension of dosage.modifierExtension ?? []) {
      if (extension.url !== DOSAGE_DETAILS_R5_URL) continue;
      if (
        Object.keys(extension).some((key) => key !== "url" && key !== "extension") ||
        extension.extension?.some((child) => child.url !== "dosageDetails")
      ) {
        reconciliationSources.push(extension);
        preserveRetainedMarkers = true;
      }
      const markers = extension.extension?.filter((value) => value.url === "dosageDetails") ?? [];
      if (!markers.length) {
        reconciliationSources.push(extension);
        preserveRetainedMarkers = true;
        addWarning(
          warnings,
          "Malformed retained R6 course metadata was preserved; live R5 fields remain available for correction."
        );
        continue;
      }
      for (const child of markers) {
        if (original && equalStructuredValues(child, original)) continue;
        const parsed = decodeCourseDetails(child);
        if (!parsed) {
          reconciliationSources.push(extension);
          preserveRetainedMarkers = true;
          addWarning(
            warnings,
            "Malformed retained R6 course metadata was preserved; live R5 fields remain available for correction."
          );
          continue;
        }
        if (retained) {
          reconciliationSources.push(extension);
          preserveRetainedMarkers = true;
          addWarning(
            warnings,
            "Retained R6 course snapshots differ; the first valid snapshot was merged and all raw snapshots were preserved."
          );
          continue;
        }
        retained = parsed;
        original = child;
        retainedSource = extension;
      }
    }
  }
  let instructionMarker: FhirExtension | undefined;
  for (const dosage of dosages) {
    instructionMarker = dosage.extension?.find(isRenderedInstructionMarker);
    if (instructionMarker) break;
  }
  const snapshot = instructionBaseline(instructionMarker);
  const savedInstruction = snapshot.instruction,
    hasInstructionBaseline = snapshot.complete;
  let instructionStillMatches = hasInstructionBaseline && snapshot.rows.length === dosages.length;
  let textWasEdited = false,
    allTexts = true;
  let effectiveDosages: readonly (FhirDosage | EzDosage)[] = dosages;
  if (hasInstructionBaseline)
    for (let index = 0; index < dosages.length; index++) {
      const dosage = dosages[index],
        before = snapshot.rows[index];
      const projectionMatches = before?.projection === dosageProjectionFingerprint(dosage);
      const textMatches = before?.text === dosageTextFingerprint(dosage);
      if (!projectionMatches || !textMatches) instructionStillMatches = false;
      if (!textMatches) textWasEdited = true;
      if (typeof dosage.text !== "string" || !dosage.text.length) allTexts = false;
      if (!projectionMatches && textMatches) {
        if (effectiveDosages === dosages) effectiveDosages = dosages.slice();
        (effectiveDosages as (FhirDosage | EzDosage)[])[index] = { ...dosage, text: undefined };
      }
    }
  let clinicianEditedText: string | undefined;
  if (hasInstructionBaseline && !instructionStillMatches && allTexts && textWasEdited) {
    clinicianEditedText = "";
    for (let i = 0; i < dosages.length; i++) clinicianEditedText += (i ? "; " : "") + dosages[i].text;
  }
  const preservedInstruction = instructionStillMatches ? savedInstruction : clinicianEditedText;
  const instructionSource =
    instructionMarker && (!instructionStillMatches || hasUnrecognizedEditMetadata(instructionMarker))
      ? instructionMarker
      : undefined;
  if (savedInstruction !== undefined && hasInstructionBaseline && !instructionStillMatches)
    addWarning(
      warnings,
      "Structured dosage fields changed; the previous rendered instruction was retained only as source provenance."
    );
  if (retained) {
    // A valid R6 course can have no steps. Its R5 representation is a
    // non-administration Dosage.text row carrying the complete typed source,
    // not an invented active dose. Restore it without manufacturing a step.
    const carrier = effectiveDosages[0];
    if (
      retained.step.every((step) => !step.component.length) &&
      effectiveDosages.length === 1 &&
      carrier &&
      Object.keys(carrier).every((key) => {
        if (key === "text" || key === "modifierExtension") return true;
        if (key === "sequence") return carrier.sequence === undefined || carrier.sequence === 1;
        const value = (carrier as Record<string, unknown>)[key];
        // R5 mappers may materialize all optional keys as undefined and
        // normalize absent repeated fields into []. Neither is a dose or
        // an instruction. Any actual new field is a live R5 edit.
        return value === undefined || (Array.isArray(value) && value.length === 0);
      }) &&
      carrier.modifierExtension?.length === 1 &&
      carrier.modifierExtension[0].url === DOSAGE_DETAILS_R5_URL
    ) {
      const instruction = course?.renderedInstruction ?? renderedInstruction ?? carrier.text;
      // Even an incomplete clinician-authored stage is live editable data.
      // This carrier has no administration: merge its explicit stage edits
      // without treating the carrier's Dosage.text as an active component.
      const emptySteps = retained.step.map((step) => stageFromFields(step, []));
      let edited = false;
      const editedSequences = new Set<number>();
      for (const item of course?.step ?? []) {
        const { sequence, ...fields } = item;
        // Empty-stage metadata is an address into the existing ordered
        // course, not a request to synthesize missing clinical stages. The
        // only legal addition is one adjacent slot; all other indices remain
        // recoverable as inert edit provenance, never a huge allocation.
        if (
          !Number.isSafeInteger(sequence) ||
          sequence < 1 ||
          sequence > emptySteps.length + 1 ||
          editedSequences.has(sequence)
        ) {
          reconciliationSources.push(retainedCourseStepSource(item));
          addWarning(
            warnings,
            "Invalid or duplicate empty-stage metadata remained recoverable as source provenance."
          );
          continue;
        }
        editedSequences.add(sequence);
        if (sequence === emptySteps.length + 1) emptySteps.push({ administrations: [] });
        const prior = (emptySteps[sequence - 1].provenance as Omit<FhirR6DosageStep, "component">) ?? {};
        const merged = r6StepMetadata({ ...r5StepMetadata(prior), ...fields });
        if (!equalStructuredValues(prior, merged)) edited = true;
        emptySteps[sequence - 1] = stageFromFields(merged, []);
      }
      const { step: _originalSteps, renderedInstruction: _originalInstruction, ...originalHeader } = retained;
      const {
        step: _editedSteps,
        renderedInstruction: _replacementInstruction,
        ...replacementHeader
      } = course ?? {};
      const header = { ...originalHeader, ...replacementHeader };
      if (instruction !== retained.renderedInstruction || !equalStructuredValues(originalHeader, header))
        edited = true;
      const updated = courseFromFields(
        { ...header, ...(instruction !== undefined ? { renderedInstruction: instruction } : {}) },
        emptySteps
      );
      if (edited)
        addWarning(
          warnings,
          "Edited R5 text or course metadata superseded the original zero-step R6 source; source preserved."
        );
      // A caller may replace course.extension with a fresh annotation.
      // Historical reconciliation sources are not active annotations:
      // preserve their existing flat children exactly once BEFORE replacing
      // the active extension array and flattening the latest source marker.
      const oldSources: FhirExtension[] = [];
      if (course?.extension !== undefined)
        for (const extension of retained.extension ?? []) {
          if (extension.url === DOSAGE_RECONCILIATION_SOURCE_URL)
            oldSources.push(...(extension.extension ?? []));
        }
      return withPreservedSourceExtension(
        withReconciliationSources(withReconciliationWarnings(updated, warnings), [
          ...reconciliationSources,
          ...oldSources,
          ...(edited && retainedSource ? [sourceWithoutNestedHistory(retainedSource)] : []),
        ]),
        instructionSource
      );
    }
    // An edited component instruction is not a new whole-course instruction.
    // Keep that component text, but let structured phases drive the summary
    // unless the caller explicitly supplied a complete replacement course SIG.
    const result = reconcileNativeRetainedCourse(
      retained,
      effectiveDosages,
      course?.renderedInstruction ?? renderedInstruction,
      course,
      preserveRetainedMarkers,
      warnings,
      retainedSource,
      reconciliationSources,
      sourceContext
    );
    return withPreservedSourceExtension(result, instructionSource);
  }
  const header:Omit<FhirR6DosageInstruction,"step"> & {step?:EzCourseMetadata["step"]}=Object.assign({},course);
  delete header.step;
  if (course?.renderedInstruction === undefined) {
    if (renderedInstruction !== undefined) header.renderedInstruction = renderedInstruction;
    else if (preservedInstruction !== undefined) header.renderedInstruction = preservedInstruction;
    else if (effectiveDosages.length === 1 && effectiveDosages[0].text)
      header.renderedInstruction = effectiveDosages[0].text;
  }
  if (effectiveDosages.length === 1 && !course?.step?.length) {
    const row = effectiveDosages[0],
      sequence = row.sequence ?? 1;
    if (!Number.isInteger(sequence) || sequence < 1)
      addWarning(
        warnings,
        "Invalid Dosage.sequence was preserved in the component and projected into the first stage for correction."
      );
    const result = courseFromFields(header, [
      { administrations: [administrationFromR5(row, sourceContext)] },
    ]);
    return withPreservedSourceExtension(
      withReconciliationSources(withReconciliationWarnings(result, warnings), reconciliationSources),
      instructionSource
    );
  }
  const groups = new Map<number, CanonicalAdministration[]>();
  for (const row of effectiveDosages) {
    const requested = row.sequence ?? 1,
      sequence = Number.isInteger(requested) && requested >= 1 ? requested : 1;
    if (sequence !== requested)
      addWarning(
        warnings,
        "Invalid Dosage.sequence was preserved in the component and projected into the first stage for correction."
      );
    let members = groups.get(sequence);
    if (!members) groups.set(sequence, (members = []));
    members.push(administrationFromR5(row, sourceContext));
  }
  const metadata = new Map<number, NonNullable<EzCourseMetadata["step"]>[number]>();
  for (const step of course?.step ?? []) {
    if (!Number.isInteger(step.sequence) || step.sequence < 1 || metadata.has(step.sequence)) {
      reconciliationSources.push(retainedCourseStepSource(step));
      addWarning(
        warnings,
        "Course step metadata with an invalid or duplicate sequence was retained as source provenance."
      );
      continue;
    }
    metadata.set(step.sequence, step);
  }
  const sequences = new Set([...groups.keys(), ...metadata.keys()]);
  for (const sequence of metadata.keys())
    if (!groups.has(sequence)) {
      addWarning(
        warnings,
        "Course step metadata without a live dosage was retained as an empty stage for clinician correction."
      );
      break;
    }
  const stages: CanonicalStage[] = [];
  for (const sequence of [...sequences].sort((a, b) => a - b))
    stages.push(stageFromFields(r6StepMetadata(metadata.get(sequence) ?? {}), groups.get(sequence) ?? []));
  const result = courseFromFields(header, stages);
  return withPreservedSourceExtension(
    withReconciliationSources(withReconciliationWarnings(result, warnings), reconciliationSources),
    instructionSource
  );
}
