import { encodeCourseDetails, decodeCourseDetails, encodeConditionPredicate,
  decodeConditionPredicate, encodeCourseStepSource } from "./fhir-bridge";
/** FHIR R5/R6 bridging uses typed extension children exclusively. Source,
 * course, condition and edit metadata remain structured and independently editable. */
import { cloneStructuredValue, equalStructuredValues } from "./stable-structure";
import {
  FhirDayOfWeek, FhirDosage, FhirExtension, FhirQuantity, FhirR6Dosage, FhirR6DosageCondition,
  FhirR6DosageDetails, FhirR6DosageSafety, FhirR6DoseLimit, MedicationCondition,
  EzDosage, EzCourseMetadata
} from "./types";

/** Modifier extensions: ignoring either can change whether a dose may be given. */
export const DOSAGE_CONDITION_R5_URL =
  "https://github.com/swittk/ezmedicationinput/fhir/StructureDefinition/medication-conditional-dose";
/** Separate R6 DosageCondition-level extension: the R5 Dosage modifier has
 * a different context and nested child contract, so it cannot be reused. */
export const DOSAGE_CONDITION_R6_LOGIC_URL =
  "https://github.com/swittk/ezmedicationinput/fhir/StructureDefinition/medication-r6-condition-logic";
export const DOSAGE_EXCLUDED_DATES_R5_URL =
  "https://github.com/swittk/ezmedicationinput/fhir/StructureDefinition/medication-excluded-calendar-dates";
export const DOSAGE_DETAILS_R5_URL =
  "https://github.com/swittk/ezmedicationinput/fhir/StructureDefinition/medication-r6-course-details";
/** Non-modifier metadata: preserves the author's entire literal instruction
 * without forcing ordinary R5 consumers to implement R6 safety semantics. */
export const DOSAGE_RENDERED_INSTRUCTION_R5_URL =
  "https://github.com/swittk/ezmedicationinput/fhir/StructureDefinition/medication-rendered-instruction";
export const DOSAGE_EXCLUDED_WEEKDAYS_R5_URL =
  "https://github.com/swittk/ezmedicationinput/fhir/StructureDefinition/medication-excluded-weekdays";
/** Non-modifier provenance emitted when an editable R5 projection and its
 * retained R6 source cannot be merged one-to-one. */
export const DOSAGE_RECONCILIATION_WARNING_URL =
  "https://github.com/swittk/ezmedicationinput/fhir/StructureDefinition/medication-course-reconciliation-warning";
const DOSAGE_RECONCILIATION_SOURCE_URL =
  "https://github.com/swittk/ezmedicationinput/fhir/StructureDefinition/medication-course-reconciliation-source";
const DOSAGE_RETAINED_R5_SEQUENCE_URL =
  "https://github.com/swittk/ezmedicationinput/fhir/StructureDefinition/medication-retained-r5-sequence";
const DOSAGE_RETAINED_COURSE_STEP_URL =
  "https://github.com/swittk/ezmedicationinput/fhir/StructureDefinition/medication-retained-course-step";
/** Treatment-relative phase origin for an independent parallel component. */
export const PARALLEL_COMPONENT_PHASE_ORIGIN_URL =
  "https://solublelabs.com/fhir/StructureDefinition/medication-parallel-component-phase-origin";
const CONDITION_CODE_SYSTEM = "http://hl7.org/fhir/CodeSystem/dosage-condition-code";
const INTERNAL_CONDITION_CODE_SYSTEM = "https://github.com/swittk/ezmedicationinput/fhir/CodeSystem/medication-condition";

function replacementExtensions(
  dosage: FhirDosage, url: string, value: FhirExtension | undefined
): void {
  const existing = (dosage.modifierExtension ?? []).filter(extension => extension.url !== url);
  const result = value ? [...existing, value] : existing;
  dosage.modifierExtension = result.length ? result : undefined;
}

function hasOnlyKeys(candidate: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(candidate).every(key => allowed.indexOf(key) >= 0);
}

function isMedicationCondition(value: unknown, depth = 0): value is MedicationCondition {
  if (depth > 64 || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  switch (candidate.kind) {
    case "measurement":
      return hasOnlyKeys(candidate, ["kind", "name", "operation", "value", "unit", "text"]) &&
        typeof candidate.name === "string" && candidate.name.length > 0 &&
        ["gt", "ge", "lt", "le", "eq", "ne"].indexOf(candidate.operation as string) >= 0 &&
        typeof candidate.value === "number" && Number.isFinite(candidate.value) &&
        (candidate.unit === undefined || typeof candidate.unit === "string") &&
        typeof candidate.text === "string" && candidate.text.length > 0;
    case "state":
      return hasOnlyKeys(candidate, ["kind", "name", "text", "expected"]) &&
        typeof candidate.name === "string" && candidate.name.length > 0 &&
        typeof candidate.text === "string" && candidate.text.length > 0 &&
        typeof candidate.expected === "boolean";
    case "text":
      return hasOnlyKeys(candidate, ["kind", "text"]) &&
        typeof candidate.text === "string" && candidate.text.length > 0;
    case "not":
      return hasOnlyKeys(candidate, ["kind", "condition"]) &&
        isMedicationCondition(candidate.condition, depth + 1);
    case "all": case "any":
      return hasOnlyKeys(candidate, ["kind", "conditions"]) &&
        Array.isArray(candidate.conditions) && candidate.conditions.length > 0 &&
        candidate.conditions.every(part => isMedicationCondition(part, depth + 1));
    default:
      return false;
  }
}

function valueKeys(extension: FhirExtension): string[] {
  return Object.keys(extension).filter(key => key.startsWith("value") &&
    (extension as unknown as Record<string, unknown>)[key] !== undefined);
}

function parseConditionModifier(extension: FhirExtension): MedicationCondition | undefined {
  // Read/edit paths are intentionally tolerant. The complete extension stays
  // on the dosage, while the first usable predicate supplies a suggestion.
  for (const predicate of extension.extension ?? []) {
    if (predicate.url !== "predicate") continue;
    const value = decodeConditionPredicate(predicate);
    if (isMedicationCondition(value)) return value;
  }
  return undefined;
}

function isExactConditionBridge(extension: FhirExtension): boolean {
  const predicate = parseConditionModifier(extension);
  return predicate !== undefined && valueKeys(extension).length === 0 &&
    equalStructuredValues(extension.extension, [encodeConditionPredicate(predicate)]);
}

export function assertUnderstoodDosageModifiers(_dosage: FhirDosage | EzDosage): void {
  // Compatibility API. Unknown modifier semantics remain attached for editing.
}

function parseDosageCondition(dosage: FhirDosage | EzDosage): MedicationCondition | undefined {
  const expanded = dosage as EzDosage;
  if (expanded.condition?.length === 1) return conditionFromR6(expanded.condition[0]);
  if (expanded.condition?.length) {
    return { kind: "any", conditions: expanded.condition.map(conditionFromR6) };
  }
  const extension = dosage.modifierExtension?.find(value => value.url === DOSAGE_CONDITION_R5_URL);
  return extension ? parseConditionModifier(extension) : undefined;
}

export function getDosageCondition(dosage: FhirDosage | EzDosage): MedicationCondition | undefined {
  return parseDosageCondition(dosage);
}

export function setDosageCondition(dosage: FhirDosage, condition: MedicationCondition | undefined): void {
  replacementExtensions(dosage, DOSAGE_CONDITION_R5_URL, condition ? {
    url: DOSAGE_CONDITION_R5_URL,
    extension: [encodeConditionPredicate(condition)]
  } : undefined);
}

export function getDosageExcludedDates(dosage: FhirDosage | EzDosage): string[] {
  if ((dosage as EzDosage).excludedDates) return [...(dosage as EzDosage).excludedDates!];
  const extension = dosage.modifierExtension?.find(value => value.url === DOSAGE_EXCLUDED_DATES_R5_URL);
  return [...new Set((extension?.extension ?? [])
    .filter(child => child.url === "date" && /^\d{4}-\d{2}-\d{2}$/.test(child.valueDate ?? ""))
    .map(child => child.valueDate!))].sort();
}

export function setDosageExcludedDates(dosage: FhirDosage, dates: string[]): void {
  const values = [...new Set(dates)].sort();
  replacementExtensions(dosage, DOSAGE_EXCLUDED_DATES_R5_URL, values.length ? {
    url: DOSAGE_EXCLUDED_DATES_R5_URL,
    extension: values.map(valueDate => ({ url: "date", valueDate }))
  } : undefined);
}

export function getDosageExcludedWeekdays(dosage: FhirDosage): FhirDayOfWeek[] {
  const extension = dosage.extension?.find(value => value.url === DOSAGE_EXCLUDED_WEEKDAYS_R5_URL);
  return (extension?.extension ?? [])
    .filter(child => child.url === "day" && typeof child.valueCode === "string")
    .map(child => child.valueCode as FhirDayOfWeek);
}

export function setDosageExcludedWeekdays(dosage: FhirDosage, days: FhirDayOfWeek[]): void {
  const remaining = (dosage.extension ?? []).filter(value => value.url !== DOSAGE_EXCLUDED_WEEKDAYS_R5_URL);
  dosage.extension = days.length
    ? [...remaining, { url: DOSAGE_EXCLUDED_WEEKDAYS_R5_URL,
      extension: days.map(valueCode => ({ url: "day", valueCode })) }]
    : remaining.length ? remaining : undefined;
}

function describe(condition: MedicationCondition): string {
  switch (condition.kind) {
    case "measurement":
      return `${condition.name} ${condition.operation} ${condition.value}${condition.unit ? " " + condition.unit : ""}`;
    case "state": return condition.expected ? condition.name : `not ${condition.name}`;
    case "text": return condition.text;
    case "not": return `not (${describe(condition.condition)})`;
    case "all": return condition.conditions.map(describe).join(" AND ");
    case "any": return condition.conditions.map(describe).join(" OR ");
  }
}

function conditionToR6(condition: MedicationCondition): FhirR6DosageCondition {
  if (condition.kind === "measurement") {
    return {
      code: { coding: [{ system: INTERNAL_CONDITION_CODE_SYSTEM, code: "measurement", display: condition.name }], text: condition.name },
      operation: condition.operation,
      valueQuantity: {
        value: condition.value,
        ...(condition.unit ? { unit: condition.unit } : {})
      },
      text: condition.text
    };
  }
  if (condition.kind === "state") {
    return {
      code: { coding: [{ system: CONDITION_CODE_SYSTEM, code: "problem-presents", display: "Problem Presents" }] },
      details: { text: condition.name },
      operation: "eq",
      valueBoolean: condition.expected,
      text: condition.text
    };
  }
  // FHIR R6 condition[] is OR. A whole Boolean expression must stay ONE
  // condition, with the logical tree retained in a declared extension.
  return {
    code: { coding: [{ system: INTERNAL_CONDITION_CODE_SYSTEM, code: "expression", display: "Medication conditional expression" }] },
    text: describe(condition),
    extension: [{ url: DOSAGE_CONDITION_R6_LOGIC_URL,
        extension: [encodeConditionPredicate(condition)] }]
  };
}

function conditionFromR6(value: FhirR6DosageCondition): MedicationCondition {
  const logic = value.extension?.find(extension =>
    extension.url === DOSAGE_CONDITION_R6_LOGIC_URL)?.extension
    ?.find(child => child.url === "predicate");
  if (logic) {
    const parsed = decodeConditionPredicate(logic);
    if (isMedicationCondition(parsed)) return parsed;
    // The original extension remains attached when its meaning is unfamiliar.
  }
  const name = value.details?.text ?? value.code?.text ?? value.code?.coding?.[0]?.display;
  if (value.code?.coding?.[0]?.code === "problem-presents" && name && value.valueBoolean !== undefined) {
    return { kind: "state", name, expected: value.valueBoolean, text: value.text ?? name };
  }
  if (value.valueQuantity?.value !== undefined && value.operation && name &&
    ["gt", "ge", "lt", "le", "eq", "ne"].indexOf(value.operation) >= 0) {
    return {
      kind: "measurement", name, operation: value.operation as "gt" | "ge" | "lt" | "le" | "eq" | "ne",
      value: value.valueQuantity.value, unit: value.valueQuantity.unit, text: value.text ?? name
    };
  }
  // Keep the actual condition in native fields/the retained course. A human
  // placeholder is not a replacement payload and never contains serialized data.
  return { kind: "text", text: value.text ?? name ?? "Unresolved condition" };
}

function toR6Safety(dosage: FhirDosage): FhirR6DosageSafety | undefined {
  const doseLimit: NonNullable<FhirR6DosageSafety["doseLimit"]> = [];
  for (const maximum of dosage.maxDosePerPeriod ?? []) {
    if (!maximum.numerator || !maximum.denominator) continue;
    doseLimit.push({
      scope: "period", valueQuantity: { ...maximum.numerator },
      period: { ...maximum.denominator }
    });
  }
  if (dosage.maxDosePerAdministration) {
    doseLimit.push({ scope: "administration", valueQuantity: { ...dosage.maxDosePerAdministration } });
  }
  if (dosage.maxDosePerLifetime) {
    doseLimit.push({ scope: "lifetime", valueQuantity: { ...dosage.maxDosePerLifetime } });
  }
  return doseLimit.length ? { doseLimit } : undefined;
}

function isR5RepresentableSafetyLimit(limit: FhirR6DoseLimit): boolean {
  const quantity = limit.valueQuantity;
  if (!quantity) return false;
  if (limit.scope === "period") {
    return Boolean(limit.period) && quantity.comparator !== "~" &&
      limit.period?.comparator === undefined;
  }
  return (limit.scope === "administration" || limit.scope === "lifetime") &&
    quantity.comparator === undefined;
}

/**
 * Apply edits made through R5 maximum-dose fields without discarding safety
 * semantics that R5 cannot carry. Existing backbone metadata stays attached
 * to the corresponding representable scope; expression/integer limits and
 * the safety-level exceeded action remain byte-for-byte authoritative.
 */
function reconcileR5SafetyEdits(
  retained: FhirR6DosageSafety,
  projected: FhirR6DosageSafety | undefined
): FhirR6DosageSafety | undefined {
  const replacements = [...(projected?.doseLimit ?? [])];
  const doseLimit: FhirR6DoseLimit[] = [];
  for (const original of retained.doseLimit ?? []) {
    if (!isR5RepresentableSafetyLimit(original)) {
      doseLimit.push(original);
      continue;
    }
    const replacementIndex = replacements.findIndex(candidate =>
      candidate.scope === original.scope);
    if (replacementIndex < 0) continue;
    const [replacement] = replacements.splice(replacementIndex, 1);
    const {
      scope: _scope, period: _period,
      valueQuantity: _quantity, valueInteger: _integer,
      valueExpression: _expression, ...metadata
    } = original;
    doseLimit.push({ ...metadata, ...replacement } as FhirR6DoseLimit);
  }
  doseLimit.push(...replacements);
  const { doseLimit: _retainedLimits, ...retainedSafety } = retained;
  if (doseLimit.length) return { ...retainedSafety, doseLimit };
  return Object.keys(retainedSafety).length ? retainedSafety : undefined;
}

/** Lift real R6 concepts once into the familiar flat R5 dosage shape. */
export function toEzDosages(dosages: readonly (FhirDosage | EzDosage)[]): EzDosage[] {
  return dosages.map(dosage => {
    const input = dosage as EzDosage;
    // Lift each missing field independently. A preexisting siteReference or
    // expression does not imply an unrelated R5 maximum/condition was lifted.
    const needsCondition = !input.condition?.length &&
      !!dosage.modifierExtension?.some(ext => ext.url === DOSAGE_CONDITION_R5_URL);
    const needsSafety = !input.safety &&
      (!!dosage.maxDosePerPeriod?.length ||
        !!dosage.maxDosePerAdministration || !!dosage.maxDosePerLifetime);
    const needsDates = input.excludedDates === undefined &&
      !!dosage.modifierExtension?.some(ext => ext.url === DOSAGE_EXCLUDED_DATES_R5_URL);
    if (!needsCondition && !needsSafety && !needsDates) return input;
    const predicate = needsCondition ? parseDosageCondition(dosage) : undefined;
    const safety = needsSafety ? toR6Safety(dosage) : undefined;
    const dates = needsDates ? getDosageExcludedDates(dosage) : undefined;
    return {
      ...input,
      ...(predicate ? { condition: [conditionToR6(predicate)] } : {}),
      ...(safety ? { safety } : {}),
      ...(dates?.length ? { excludedDates: dates } : {})
    };
  });
}

function isRenderedInstructionMarker(extension: FhirExtension): boolean {
  if (extension.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL) return false;
  const children = extension.extension ?? [];
  const rows = children.filter(value => value.url === "row");
  return children.some(value => value.url === "instruction" && typeof value.valueString === "string") &&
    rows.length > 0 && rows.every(row =>
      row.extension?.some(part => part.url === "projectionFingerprint" && typeof part.valueString === "string") &&
      row.extension?.some(part => part.url === "textFingerprint" && typeof part.valueString === "string"));
}

/** Metadata not understood by this reader stays as structured source instead
 * of disappearing when the editable baseline happens to be unchanged.
 * @param marker The source edit-provenance extension.
 */
function hasUnrecognizedEditMetadata(marker: FhirExtension): boolean {
  if (Object.keys(marker).some(key => key !== "url" && key !== "extension")) return true;
  return (marker.extension ?? []).some(child => {
    if (child.url === "instruction") return Object.keys(child).some(key => key !== "url" && key !== "valueString");
    if (child.url !== "row") return true;
    return Object.keys(child).some(key => key !== "url" && key !== "extension") ||
      child.extension?.some(part =>
        ["projectionFingerprint", "textFingerprint"].indexOf(part.url) < 0 ||
        Object.keys(part).some(key => key !== "url" && key !== "valueString")) === true;
  });
}

/** Project one EZMED dosage into a native R6 dosage component. */
function toR6Dosage(dosage: FhirDosage | EzDosage): FhirR6Dosage {
  const {
    sequence: _sequence, site, maxDosePerPeriod: _maxPeriod,
    maxDosePerAdministration: _maxAdministration, maxDosePerLifetime: _maxLifetime,
    condition: ownConditions, safety: ownSafety,
    siteReference, excludedDates,
    modifierExtension, extension, ...rest
  } = dosage as EzDosage;
  const predicate = ownConditions?.length ? undefined : parseDosageCondition(dosage);
  const safety = ownSafety ?? toR6Safety(dosage);
  // A caller may edit the public excludedDates field directly, without
  // updating the older R5 modifier. Rebuild that modifier from the live
  // field (including [] to remove exclusions) before projecting to R6.
  const encoded: FhirDosage = { modifierExtension };
  if (excludedDates !== undefined) setDosageExcludedDates(encoded, excludedDates);
  const nativeCondition = ownConditions?.length === 1
    ? conditionFromR6(ownConditions[0])
    : ownConditions?.length
      ? { kind: "any", conditions: ownConditions.map(conditionFromR6) } as MedicationCondition
      : undefined;
  const r6Modifiers = encoded.modifierExtension?.filter(value => {
    // A retained-course marker contains a complete DosageDetails snapshot.
    // Nesting it in a component would make every later R5/R6 round trip wrap
    // the previous course again. Reconciliation provenance is retained once
    // at course level instead.
    if (value.url === DOSAGE_DETAILS_R5_URL) return false;
    if (value.url !== DOSAGE_CONDITION_R5_URL) return true;
    const bridged = parseConditionModifier(value);
    // Remove only the exact bridge contract after it was projected. A usable
    // predicate with additional unfamiliar data remains raw and editable.
    if (!bridged) return true;
    if (!isExactConditionBridge(value)) return true;
    return nativeCondition !== undefined &&
      !equivalentProjection(bridged, nativeCondition);
  });
  const r6Extensions = (extension ?? []).filter(value =>
    !isRenderedInstructionMarker(value));
  if (_sequence !== undefined && (!Number.isInteger(_sequence) || _sequence < 1)) {
    r6Extensions.push({ url: DOSAGE_RETAINED_R5_SEQUENCE_URL,
      valueDecimal: _sequence });
  }
  return {
    ...rest,
    ...(r6Extensions.length ? { extension: r6Extensions } : {}),
    ...(r6Modifiers?.length ? { modifierExtension: r6Modifiers } : {}),
    ...(site || siteReference ? { site: {
      ...(site ? { concept: site } : {}),
      ...(siteReference ? { reference: siteReference } : {})
    } } : {}),
    ...(ownConditions?.length ? { condition: ownConditions } :
      predicate ? { condition: [conditionToR6(predicate)] } : {}),
    ...(safety ? { safety } : {})
  };
}

/** Project one R6 component without building course-storage metadata. Used by
 * both strict exports and read-only rendering; source objects are not mutated.
 * @param dosage Native R6 component.
 * @param sequence Ordered global course step for its R5 projection.
 */
export function fromR6Dosage(dosage: FhirR6Dosage, sequence: number): FhirDosage {
  const { site, condition, safety, doseAndRate, ...rest } = dosage;
  let restoredSequence = sequence;
  const retainedSequence = dosage.extension?.find(extension =>
    extension.url === DOSAGE_RETAINED_R5_SEQUENCE_URL)?.valueDecimal;
  if (retainedSequence !== undefined && Number.isFinite(retainedSequence)) {
    restoredSequence = retainedSequence;
  }
  const output: FhirDosage = {
    ...rest,
    sequence: restoredSequence,
    ...(site?.concept ? { site: site.concept } : {}),
    ...(doseAndRate ? { doseAndRate: doseAndRate.map(({ doseExpression: _doseExpr,
      rateExpression: _rateExpr, ...entry }) => entry) } : {})
  };
  for (const limit of safety?.doseLimit ?? []) {
    // R5 maximum-dose fields are not as expressive as R6 safety limits.
    // If an R6-only comparator cannot be expressed in the corresponding
    // R5 Quantity/SimpleQuantity, leave it in the retained R6 modifier.
    const quantity = limit.valueQuantity;
    if (!quantity) continue;
    const { comparator, ...simple } = quantity;
    if (limit.scope === "period" && limit.period && comparator !== "~") {
      const { comparator: periodComparator, ...period } = limit.period;
      if (!periodComparator) {
        output.maxDosePerPeriod = [...(output.maxDosePerPeriod ?? []), {
          numerator: { ...simple, ...(comparator ? { comparator } : {}) },
          denominator: period
        }];
      }
    }
    // A general R6 Quantity comparator cannot be represented in R5 maxima.
    if (comparator) continue;
    if (limit.scope === "administration") {
      output.maxDosePerAdministration = simple;
    }
    if (limit.scope === "lifetime") {
      output.maxDosePerLifetime = simple;
    }
  }
  if (condition?.length === 1) {
    setDosageCondition(output, conditionFromR6(condition[0]));
  } else if (condition?.length) {
    // R6 multiple conditions are alternatives (OR).
    setDosageCondition(output, {
      kind: "any",
      conditions: condition.map(conditionFromR6)
    });
  }
  return output;
}

function addWarning(warnings: string[], warning: string): void {
  if (warnings.indexOf(warning) < 0) warnings.push(warning);
}

function withReconciliationWarnings(
  details: FhirR6DosageDetails,
  warnings: readonly string[]
): FhirR6DosageDetails {
  if (!warnings.length) return details;
  const existing = new Set((details.extension ?? [])
    .filter(extension => extension.url === DOSAGE_RECONCILIATION_WARNING_URL)
    .map(extension => extension.valueString)
    .filter((value): value is string => typeof value === "string"));
  const additions = warnings.filter(warning => !existing.has(warning))
    .map(valueString => ({ url: DOSAGE_RECONCILIATION_WARNING_URL, valueString }));
  if (!additions.length) return details;
  return { ...details, extension: [...(details.extension ?? []), ...additions] };
}

function withPreservedSourceExtension(
  details: FhirR6DosageDetails,
  extension: FhirExtension | undefined
): FhirR6DosageDetails {
  if (!extension) return details;
  if (details.extension?.some(value => equalStructuredValues(value, extension))) return details;
  return { ...details, extension: [...(details.extension ?? []), extension] };
}

/** Keep unusable or superseded R5 course markers as inert provenance. Keeping
 * them at course level avoids recursively embedding a complete course inside
 * every component on subsequent exports. */
function withReconciliationSources(
  details: FhirR6DosageDetails,
  sources: readonly FhirExtension[]
): FhirR6DosageDetails {
  if (!sources.length) return details;
  const existing = (details.extension ?? []).filter(extension =>
    extension.url === DOSAGE_RECONCILIATION_SOURCE_URL);
  const additions: FhirExtension[] = [];
  for (const source of sources) {
    if ([...existing, ...additions].some(value =>
      value.extension?.length === 1 && equalStructuredValues(value.extension[0], source))) continue;
    additions.push({ url: DOSAGE_RECONCILIATION_SOURCE_URL,
      extension: [cloneStructuredValue(source)] });
  }
  return additions.length
    ? { ...details, extension: [...(details.extension ?? []), ...additions] }
    : details;
}

/** Preserve unmatched step metadata in its original typed extension structure.
 * @param step Source step that could not be matched to a live dosage.
 */
function retainedCourseStepSource(
  step: NonNullable<EzCourseMetadata["step"]>[number]
): FhirExtension {
  return { url: DOSAGE_RETAINED_COURSE_STEP_URL, extension: encodeCourseStepSource(step) };
}

/** Compare live projections without sorted copies or serialization. Validator
 * additions are tolerated only on Coding metadata, never on clinical fields.
 * @param original Original typed projection.
 * @param current Current editable projection.
 * @param context Metadata context for Coding-system/version additions.
 */

function equivalentProjection(
  original: unknown,
  current: unknown,
  context: "general" | "coding-list" | "coding-item" = "general"
): boolean {
  if (original === current) return true;
  if (Array.isArray(original) || Array.isArray(current)) {
    if (!Array.isArray(original) || !Array.isArray(current) ||
        original.length !== current.length) return false;
    const nextContext = context === "coding-list" ? "coding-item" : "general";
    for (let index = 0; index < original.length; index++) {
      if (!equivalentProjection(original[index], current[index], nextContext)) return false;
    }
    return true;
  }
  if (original === null || current === null ||
      typeof original !== "object" || typeof current !== "object") return false;
  const before = original as Record<string, unknown>;
  const after = current as Record<string, unknown>;
  for (const key of Object.keys(before)) {
    if (isAbsentProjectionField(before[key])) continue;
    if (!Object.prototype.hasOwnProperty.call(after, key) ||
        !equivalentProjection(before[key], after[key],
          key === "coding" ? "coding-list" : "general")) return false;
  }
  for (const key of Object.keys(after)) {
    if (isAbsentProjectionField(after[key])) continue;
    if (Object.prototype.hasOwnProperty.call(before, key) &&
        !isAbsentProjectionField(before[key])) continue;
    if (context === "coding-item" && (key === "system" || key === "version")) continue;
    return false;
  }
  return true;
}

/** Optional empty arrays and undefined object fields carry no projection data.
 * @param value The optional field currently being compared.
 */
function isAbsentProjectionField(value: unknown): boolean {
  return value === undefined || Array.isArray(value) && value.length === 0;
}

/**
 * Inspect the live R5 projection independently of the embedded R6 snapshot.
 * Modifier metadata is deliberately excluded from the comparison: it can
 * describe a course but must never replace subsequently edited dosage values.
 */
function liveDosageProjection(
  dosage: FhirDosage | EzDosage,
  includeText = true
): object {
  const {
    condition: _condition, safety: _safety, siteReference: _siteReference,
    excludedDates: _excludedDates, doseAndRate, extension, modifierExtension,
    text,
    ...r5
  } = dosage as EzDosage;
  return {
    ...r5,
    ...(includeText && text !== undefined ? { text } : {}),
    ...(doseAndRate ? { doseAndRate: doseAndRate.map(entry => {
      const { doseExpression: _dose, rateExpression: _rate, ...r5Entry } = entry;
      return r5Entry;
    }) } : {}),
    ...(extension?.some(item => item.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL)
      ? { extension: extension.filter(item =>
        item.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL) } : {}),
    ...(modifierExtension?.some(item => item.url !== DOSAGE_DETAILS_R5_URL)
      ? { modifierExtension: modifierExtension.filter(item =>
        item.url !== DOSAGE_DETAILS_R5_URL) } : {})
  };
}

/** A compact, deterministic identity for one JSON-safe projection. Keeping the
 * identity rather than a second dosage snapshot makes the primary editable
 * array cheap to persist while still detecting stale display text. */
interface ProjectionFingerprintState {
  first: number;
  second: number;
}

function updateProjectionFingerprint(
  state: ProjectionFingerprintState,
  value: string
): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    state.first = Math.imul(state.first ^ code, 0x01000193);
    state.second = Math.imul(state.second ^ code, 0x85ebca6b);
    state.second ^= state.second >>> 13;
  }
}

function projectionFingerprintValue(
  state: ProjectionFingerprintState,
  value: unknown,
  context: "general" | "coding-list" | "coding-item" = "general"
): void {
  if (value === null) {
    updateProjectionFingerprint(state, "null;");
    return;
  }
  if (Array.isArray(value)) {
    updateProjectionFingerprint(state, "[");
    const childContext = context === "coding-list" ? "coding-item" : "general";
    for (const part of value) projectionFingerprintValue(state, part, childContext);
    updateProjectionFingerprint(state, "]");
    return;
  }
  if (typeof value === "object") {
    updateProjectionFingerprint(state, "{");
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      const part = record[key];
      if (part === undefined || Array.isArray(part) && part.length === 0) continue;
      // Validator-added coding versions do not alter an instruction. This is
      // the same tolerated metadata class as the legacy exact comparator.
      if (context === "coding-item" && key === "version") continue;
      updateProjectionFingerprint(state, key.length + ":" + key);
      projectionFingerprintValue(state, part,
        key === "coding" ? "coding-list" : "general");
    }
    updateProjectionFingerprint(state, "}");
    return;
  }
  const primitive = String(value);
  updateProjectionFingerprint(state, typeof value + primitive.length + ":" + primitive + ";");
}

function finishProjectionFingerprint(state: ProjectionFingerprintState): string {
  const hex = (part: number): string =>
    ("00000000" + (part >>> 0).toString(16)).slice(-8);
  return hex(state.first) + hex(state.second);
}

function compactProjectionFingerprint(value: unknown): string {
  const state = { first: 0x811c9dc5, second: 0x9e3779b9 };
  projectionFingerprintValue(state, value);
  return finishProjectionFingerprint(state);
}

function dosageProjectionFingerprint(dosage: FhirDosage | EzDosage): string {
  // The public editable shape includes R6-native fields. Unlike the legacy
  // R5-vs-R6 comparator, its identity must retain condition/safety/expression
  // edits; only display text and historical provenance are not live meaning.
  const { text: _text, extension, modifierExtension, ...live } = dosage;
  return compactProjectionFingerprint({
    ...live,
    ...(extension?.some(item => item.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL)
      ? { extension: extension.filter(item => item.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL) } : {}),
    ...(modifierExtension?.some(item => item.url !== DOSAGE_DETAILS_R5_URL)
      ? { modifierExtension: modifierExtension.filter(item => item.url !== DOSAGE_DETAILS_R5_URL) } : {})
  });
}

function dosageTextFingerprint(dosage: FhirDosage | EzDosage): string {
  return compactProjectionFingerprint(dosage.text ?? null);
}

/**
 * Attach source/display provenance using repeated, structured row extensions.
 * Both primary parser output and strict R5 export use this same representation.
 * @param dosages Independently editable rows being returned to the caller.
 * @param instruction The author's unmodified instruction.
 */
export function withDosageEditProvenance<T extends FhirDosage | EzDosage>(
  dosages: readonly T[],
  instruction: string
): T[] {
  if (!dosages.length) return [];
  const marker: FhirExtension = {
    url: DOSAGE_RENDERED_INSTRUCTION_R5_URL,
    extension: [
      { url: "instruction", valueString: instruction },
      ...dosages.map(dosage => ({ url: "row", extension: [
        { url: "projectionFingerprint", valueString: dosageProjectionFingerprint(dosage) },
        { url: "textFingerprint", valueString: dosageTextFingerprint(dosage) }
      ] }))
    ]
  };
  return dosages.map((dosage, index) => index === 0
    ? { ...dosage, extension: [
      ...(dosage.extension ?? []).filter(value => !isRenderedInstructionMarker(value)), marker
    ] } as T
    : dosage);
}

/**
 * A retained R6 course is authoritative only for fields R5 cannot express:
 * relative step windows, non-R5 expressions and full-course safety rules.
 * Never let the cached component values override edited live R5 dosages.
 */
function retainDoseExpressions(
  original: FhirR6Dosage["doseAndRate"],
  projected: FhirR6Dosage["doseAndRate"],
  warnings: string[]
): FhirR6Dosage["doseAndRate"] {
  if (!original?.some(item => item.doseExpression || item.rateExpression)) return projected;
  const result = projected?.map(item => ({ ...item })) ?? [];
  let preserved = false;
  for (let index = 0; index < original.length; index++) {
    const old = original[index];
    if (!old.doseExpression && !old.rateExpression) continue;
    const current = result[index];
    if (!current) {
      // Expressions are R6 choice values. Retain only those choices here;
      // any R5-representable values have already been projected separately.
      result.push({
        ...(old.type ? { type: old.type } : {}),
        ...(old.doseExpression ? { doseExpression: old.doseExpression } : {}),
        ...(old.rateExpression ? { rateExpression: old.rateExpression } : {})
      });
      preserved = true;
      continue;
    }
    const detached: NonNullable<FhirR6Dosage["doseAndRate"]>[number] = {};
    if (old.doseExpression) {
      const conflictsWithLiveDose = current.doseQuantity !== undefined ||
        current.doseRange !== undefined || current.doseExpression !== undefined &&
        !equivalentProjection(current.doseExpression,
          old.doseExpression);
      if (conflictsWithLiveDose) detached.doseExpression = old.doseExpression;
      else if (!current.doseExpression) current.doseExpression = old.doseExpression;
    }
    if (old.rateExpression) {
      const conflictsWithLiveRate = current.rateQuantity !== undefined ||
        current.rateRange !== undefined || current.rateRatio !== undefined ||
        current.rateExpression !== undefined &&
        !equivalentProjection(current.rateExpression,
          old.rateExpression);
      if (conflictsWithLiveRate) detached.rateExpression = old.rateExpression;
      else if (!current.rateExpression) current.rateExpression = old.rateExpression;
    }
    if (detached.doseExpression || detached.rateExpression) {
      result.push(detached);
    }
    preserved = true;
  }
  if (preserved) {
    addWarning(warnings,
      "Retained R6 dose/rate expressions were kept alongside edited R5 dose fields; review their relationship.");
  }
  return result;
}

function reconcileRetainedCourse(
  retained: FhirR6DosageDetails,
  dosages: readonly (FhirDosage | EzDosage)[],
  editedInstruction?: string,
  course?: EzCourseMetadata,
  preserveRetainedMarkers = false,
  initialWarnings: readonly string[] = [],
  retainedSource?: FhirExtension,
  additionalSources: readonly FhirExtension[] = []
): FhirR6DosageDetails {
  const warnings = [...initialWarnings];
  const sourceFragments = [...additionalSources];
  const groups = new Map<number, (FhirDosage | EzDosage)[]>();
  for (const dosage of dosages) {
    const requestedSequence = dosage.sequence ?? 1;
    const sequence = Number.isInteger(requestedSequence) && requestedSequence >= 1
      ? requestedSequence : 1;
    if (sequence !== requestedSequence) {
      preserveRetainedMarkers = true;
      addWarning(warnings,
        "An invalid edited Dosage.sequence was retained in the raw R5 course marker and projected into the first stage for correction.");
    }
    if (!groups.has(sequence)) groups.set(sequence, []);
    groups.get(sequence)!.push(dosage);
  }
  const metadata = new Map<number, NonNullable<EzCourseMetadata["step"]>[number]>();
  for (const step of course?.step ?? []) {
    if (!Number.isInteger(step.sequence) || step.sequence < 1) {
      sourceFragments.push(retainedCourseStepSource(step));
      addWarning(warnings, "Invalid course step metadata was retained on the course but could not be assigned to an R6 stage.");
      continue;
    }
    if (metadata.has(step.sequence)) {
      sourceFragments.push(retainedCourseStepSource(step));
      addWarning(warnings,
        "Duplicate course step metadata was retained as source provenance; the first editable stage metadata was used.");
      continue;
    }
    metadata.set(step.sequence, step);
  }
  const sequenceSet = new Set<number>([
    ...retained.step.map((_, index) => index + 1),
    ...groups.keys(),
    ...metadata.keys()
  ]);
  const sequences = [...sequenceSet].sort((a, b) => a - b);
  const liveSequences = [...groups.keys()].sort((a, b) => a - b);
  if (liveSequences.length !== retained.step.length ||
      liveSequences.some((sequence, index) => sequence !== index + 1)) {
    preserveRetainedMarkers = true;
    addWarning(warnings,
      "Edited R5 stages differ from the retained R6 course; live stages were merged deterministically and the raw course marker was retained.");
  }
  const projectionChanged = retained.step.some((step, index) => {
    const live = groups.get(index + 1) ?? [];
    if (live.length !== step.component.length) return true;
    const originals = step.component.map(component =>
      liveDosageProjection(fromR6Dosage(component, index + 1)));
    const used = new Set<number>();
    return live.some(dosage => {
      const current = liveDosageProjection(dosage);
      const match = originals.findIndex((original, candidate) =>
        !used.has(candidate) && equivalentProjection(original, current));
      if (match < 0) return true;
      used.add(match);
      return false;
    });
  });
  if (projectionChanged) {
    preserveRetainedMarkers = true;
    addWarning(warnings,
      "Edited R5 component fields were merged with retained R6 data; the raw source snapshot was also preserved for review.");
  }
  const anyComponentCountChanged = retained.step.some((step, index) =>
    (groups.get(index + 1)?.length ?? 0) !== step.component.length);
  if (anyComponentCountChanged) {
    preserveRetainedMarkers = true;
    addWarning(warnings,
      "An R6 stage gained or lost components; unchanged rows were matched first, remaining rows were paired by stable order, and the source snapshot was retained.");
  }
  let structuredChanged = Boolean(
    course?.id !== undefined && course.id !== retained.id ||
    course?.extension !== undefined && !equivalentProjection(
      { extension: retained.extension },
      { extension: course.extension }) ||
    course?.modifierExtension !== undefined && !equivalentProjection(
      { modifierExtension: retained.modifierExtension },
      { modifierExtension: course.modifierExtension }) ||
    course?.repeatCycle !== undefined && !equivalentProjection(
      retained.repeatCycle, course.repeatCycle) ||
    course?.safety !== undefined && !equivalentProjection(
      retained.safety, course.safety)
  );
  const steps: FhirR6DosageDetails["step"] = [];
  for (const sequence of sequences) {
    const step = retained.step[sequence - 1];
    const live = groups.get(sequence) ?? [];
    const editedStep = metadata.get(sequence);
    const { sequence: _metadataSequence, ...editedStepFields } = editedStep ?? { sequence };
    if (!step) {
      structuredChanged = true;
      addWarning(warnings,
        "A live R5 stage has no retained R6 counterpart; its current fields were preserved as a new stage.");
      steps.push({ ...editedStepFields,
        component: live.map(dosage => toR6Dosage(dosage)) });
      continue;
    }
    const { component: _retainedComponents, ...retainedStepFields } = step;
    if (editedStep && !equivalentProjection(
      retainedStepFields, editedStepFields)) {
      structuredChanged = true;
    }
    const componentCountChanged = live.length !== step.component.length;
    if (componentCountChanged) {
      structuredChanged = true;
    }
    const components: FhirR6Dosage[] = [];
    // Match every unchanged R5 component BEFORE assigning an original
    // position to a changed row. A swapped-and-edited dosage must not claim
    // the original slot of an unedited dosage that appears later.
    const originalProjections = step.component.map(component =>
      liveDosageProjection(fromR6Dosage(component, sequence)));
    const assigned: number[] = live.map(() => -1);
    const usedOriginalIndices = new Set<number>();
    const originalIdCounts = new Map<string, number>();
    const liveIdCounts = new Map<string, number>();
    for (const component of step.component) {
      if (component.id)
        originalIdCounts.set(component.id, (originalIdCounts.get(component.id) ?? 0) + 1);
    }
    for (const dosage of live) {
      if (dosage.id) liveIdCounts.set(dosage.id, (liveIdCounts.get(dosage.id) ?? 0) + 1);
    }
    for (let j = 0; j < live.length; j++) {
      const id = live[j].id;
      if (!id || liveIdCounts.get(id) !== 1 || originalIdCounts.get(id) !== 1) continue;
      const match = step.component.findIndex(component => component.id === id);
      if (match >= 0) {
        assigned[j] = match;
        usedOriginalIndices.add(match);
      }
    }
    for (let j = 0; j < live.length; j++) {
      if (assigned[j] >= 0) continue;
      const current = liveDosageProjection(live[j]);
      const exact = originalProjections.findIndex((projection, candidate) =>
        !usedOriginalIndices.has(candidate) &&
        equivalentProjection(projection, current));
      if (exact >= 0) {
        assigned[j] = exact;
        usedOriginalIndices.add(exact);
      }
    }
    for (let j = 0; j < live.length; j++) {
      if (assigned[j] >= 0 || !live[j].site) continue;
      const currentSite = live[j].site;
      const matches = step.component.map((component, index) => ({ component, index }))
        .filter(({ component, index }) => !usedOriginalIndices.has(index) &&
          component.site?.concept &&
          equivalentProjection(currentSite, component.site.concept));
      if (matches.length === 1) {
        assigned[j] = matches[0].index;
        usedOriginalIndices.add(matches[0].index);
      }
    }
    // Exact identifiers and unchanged projections have already claimed their
    // source. Pair the remaining rows by stable order, even when counts differ.
    const unclaimed = step.component.map((_, index) => index)
      .filter(index => !usedOriginalIndices.has(index));
    for (let j = 0; j < live.length; j++) {
      if (assigned[j] >= 0) continue;
      const next = unclaimed.shift();
      if (next !== undefined) {
        assigned[j] = next;
        usedOriginalIndices.add(next);
      }
    }
    for (let j = 0; j < live.length; j++) {
      const dosage = live[j];
      const oldIndex = assigned[j];
      const old = oldIndex >= 0 ? step.component[oldIndex] : undefined;
      const baseline = old ? fromR6Dosage(old, sequence) : undefined;
      const rawEqual = old !== undefined && baseline !== undefined &&
        equivalentProjection(liveDosageProjection(baseline),
          liveDosageProjection(dosage));
      const expanded = dosage as EzDosage;
      const datesEqual = old !== undefined &&
        equalStructuredValues(getDosageExcludedDates(dosage),
          getDosageExcludedDates(baseline!));
      const conditionsEqual = expanded.condition === undefined || old !== undefined &&
        equivalentProjection(old.condition,
          expanded.condition);
      const safetyEqual = expanded.safety === undefined || old !== undefined &&
        equivalentProjection(old.safety,
          expanded.safety);
      const referenceEqual = expanded.siteReference === undefined || old !== undefined &&
        equivalentProjection(old.site?.reference,
          expanded.siteReference);
      if (!rawEqual || !datesEqual || !conditionsEqual || !safetyEqual || !referenceEqual)
        structuredChanged = true;
      if (old && rawEqual && datesEqual &&
          conditionsEqual && safetyEqual && referenceEqual) {
        components.push(old);
        continue;
      }
      const fresh = toR6Dosage(dosage);
      if (old && baseline) {
        // Dose expressions, site references and some safety expressions
        // cannot be represented in strict R5. Preserve them across a change
        // to a DIFFERENT R5 field, provided their own R5 slots are unchanged.
        if (old.doseAndRate?.some(entry => entry.doseExpression || entry.rateExpression))
          fresh.doseAndRate = retainDoseExpressions(old.doseAndRate, fresh.doseAndRate, warnings);
        if (old.site?.reference && !expanded.siteReference &&
            equivalentProjection(liveDosageProjection({ site: baseline.site }),
              liveDosageProjection({ site: dosage.site }))) {
          fresh.site = { ...(fresh.site ?? {}), reference: old.site.reference };
        }
        const maximaUnchanged = equivalentProjection(
          liveDosageProjection({
            maxDosePerPeriod: baseline.maxDosePerPeriod,
            maxDosePerAdministration: baseline.maxDosePerAdministration,
            maxDosePerLifetime: baseline.maxDosePerLifetime
          }),
          liveDosageProjection({
            maxDosePerPeriod: dosage.maxDosePerPeriod,
            maxDosePerAdministration: dosage.maxDosePerAdministration,
            maxDosePerLifetime: dosage.maxDosePerLifetime
          }));
        if (old.safety && expanded.safety === undefined) {
          fresh.safety = maximaUnchanged
            ? old.safety
            : reconcileR5SafetyEdits(old.safety, fresh.safety);
        }
        if (old.condition?.length && expanded.condition === undefined) {
          const liveCondition = parseDosageCondition(dosage);
          const hasLiveBridge = dosage.modifierExtension?.some(extension =>
            extension.url === DOSAGE_CONDITION_R5_URL);
          if (hasLiveBridge && (liveCondition === undefined || equivalentProjection(
            liveCondition, parseDosageCondition(baseline)))) {
            fresh.condition = old.condition;
          }
        }
      }
      components.push(fresh);
    }
    steps.push({ ...step, ...editedStepFields, component: components });
  }
  const { renderedInstruction: retainedInstruction, ...retainedFields } = retained;
  const result: FhirR6DosageDetails = {
    ...retainedFields,
    ...(course?.id !== undefined ? { id: course.id } : {}),
    ...(course?.extension !== undefined ? { extension: course.extension } : {}),
    ...(course?.modifierExtension !== undefined
      ? { modifierExtension: course.modifierExtension } : {}),
    ...(course?.repeatCycle !== undefined ? { repeatCycle: course.repeatCycle } : {}),
    ...(course?.safety !== undefined ? { safety: course.safety } : {}),
    ...(editedInstruction !== undefined
      ? { renderedInstruction: editedInstruction }
      : !structuredChanged && retainedInstruction !== undefined
        ? { renderedInstruction: retainedInstruction }
        : {}),
    step: steps
  };
  if (structuredChanged && editedInstruction === undefined && retainedInstruction !== undefined) {
    addWarning(warnings,
      "Structured dosage fields changed; the original rendered instruction was retained as source provenance instead of displayed as the current instruction.");
  }
  if ((structuredChanged || preserveRetainedMarkers) && retainedSource &&
      !retained.extension?.some(extension =>
        extension.url === DOSAGE_RECONCILIATION_SOURCE_URL)) {
    sourceFragments.unshift(retainedSource);
  }
  return withReconciliationSources(
    withReconciliationWarnings(result, warnings),
    sourceFragments
  );
}

/**
 * Export the R5-style extended dose array as strict R6 DosageDetails.
 * The optional course.step rows use the official R6 step fields, grouped
 * by the existing global R5 sequence number.
 */
export function toDosageDetails(
  dosages: readonly (FhirDosage | EzDosage)[],
  renderedInstruction?: string,
  course?: EzCourseMetadata
): FhirR6DosageDetails {
  // Store the original course with every relative-stage dosage, not only
  // the first. Removing the first row must not erase the remaining phases'
  // essential start/end metadata from a persisted R5 dosage array.
  // Every R5 course component can carry the original R6 data. Select the
  // first structurally usable snapshot deterministically; keep malformed or
  // disagreeing copies once as inert course-level source provenance.
  let original: FhirExtension | undefined;
  let retained: FhirR6DosageDetails | undefined;
  let retainedSource: FhirExtension | undefined;
  const reconciliationSources: FhirExtension[] = [];
  let preserveRetainedMarkers = false;
  const warnings: string[] = [];
  for (const dosage of dosages) {
    for (const extension of dosage.modifierExtension ?? []) {
      if (extension.url !== DOSAGE_DETAILS_R5_URL) continue;
      if (Object.keys(extension).some(key => key !== "url" && key !== "extension") ||
          extension.extension?.some(child => child.url !== "dosageDetails")) {
        reconciliationSources.push(extension);
        preserveRetainedMarkers = true;
      }
      const markers = extension.extension?.filter(value =>
        value.url === "dosageDetails") ?? [];
      if (!markers.length) {
        reconciliationSources.push(extension);
        preserveRetainedMarkers = true;
        addWarning(warnings,
          "Malformed retained R6 course metadata was preserved; live R5 fields remain available for correction.");
        continue;
      }
      for (const child of markers) {
        if (original && equalStructuredValues(child, original)) continue;
        const parsed = decodeCourseDetails(child);
        if (!parsed) {
          reconciliationSources.push(extension);
          preserveRetainedMarkers = true;
          addWarning(warnings,
            "Malformed retained R6 course metadata was preserved; live R5 fields remain available for correction.");
          continue;
        }
        if (retained) {
          reconciliationSources.push(extension);
          preserveRetainedMarkers = true;
          addWarning(warnings,
            "Retained R6 course snapshots differ; the first valid snapshot was merged and all raw snapshots were preserved.");
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
  const savedInstruction = instructionMarker?.extension?.find(value =>
    value.url === "instruction")?.valueString;
  const rows = instructionMarker?.extension?.filter(value => value.url === "row");
  const savedProjectionFingerprints = rows?.map(row => row.extension?.find(value =>
    value.url === "projectionFingerprint")?.valueString);
  const savedTextFingerprints = rows?.map(row => row.extension?.find(value =>
    value.url === "textFingerprint")?.valueString);
  // Untagged external imports need no edit-comparison pass.
  const hasInstructionBaseline = Boolean(rows?.length && savedProjectionFingerprints?.every(Boolean) &&
    savedTextFingerprints?.every(Boolean));
  const currentProjectionFingerprints = hasInstructionBaseline
    ? dosages.map(dosageProjectionFingerprint) : undefined;
  const currentTextFingerprints = hasInstructionBaseline
    ? dosages.map(dosageTextFingerprint) : undefined;
  const instructionStillMatches = hasInstructionBaseline &&
    equalStructuredValues(savedProjectionFingerprints, currentProjectionFingerprints) &&
    equalStructuredValues(savedTextFingerprints, currentTextFingerprints);
  const textWasEdited = hasInstructionBaseline && dosages.some((_, index) =>
    savedTextFingerprints![index] !== currentTextFingerprints![index]);
  const clinicianEditedText = hasInstructionBaseline && !instructionStillMatches &&
    dosages.every(dosage => typeof dosage.text === "string" && dosage.text.length > 0) && textWasEdited
    ? dosages.map(dosage => dosage.text).join("; ") : undefined;
  const preservedInstruction = instructionStillMatches ? savedInstruction : clinicianEditedText;
  const instructionSource = instructionMarker &&
    (!instructionStillMatches || hasUnrecognizedEditMetadata(instructionMarker)) ? instructionMarker : undefined;
  if (savedInstruction !== undefined && hasInstructionBaseline && !instructionStillMatches) {
    addWarning(warnings,
      "Structured dosage fields changed; the previous rendered instruction was retained only as source provenance.");
  }
  const effectiveDosages = hasInstructionBaseline && !instructionStillMatches
    ? dosages.map((dosage, index) =>
      savedTextFingerprints![index] === currentTextFingerprints![index] &&
      savedProjectionFingerprints![index] !== currentProjectionFingerprints![index]
        ? { ...dosage, text: undefined } : dosage)
    : dosages;
  if (retained) {
    // An edited component instruction is not a new whole-course instruction.
    // Keep that component text, but let structured phases drive the summary
    // unless the caller explicitly supplied a complete replacement course SIG.
    const result = reconcileRetainedCourse(retained, effectiveDosages,
      course?.renderedInstruction ?? renderedInstruction,
      course, preserveRetainedMarkers, warnings, retainedSource,
      reconciliationSources);
    return withPreservedSourceExtension(result,
      instructionSource);
  }
  // The common one-dose prescription needs neither a grouping Map nor
  // sequence sorting. Preserve identical R6 output with much less overhead.
  if (effectiveDosages.length === 1 && !course?.step?.length) {
    const dosage = effectiveDosages[0];
    const sequence = dosage.sequence ?? 1;
    if (!Number.isInteger(sequence) || sequence < 1) {
      preserveRetainedMarkers = true;
      addWarning(warnings,
        "Invalid Dosage.sequence was preserved in the component and projected into the first stage for correction.");
    }
    const result = withReconciliationWarnings({
      ...(course?.renderedInstruction !== undefined
        ? { renderedInstruction: course.renderedInstruction }
        : renderedInstruction !== undefined
          ? { renderedInstruction }
          : preservedInstruction !== undefined
          ? { renderedInstruction: preservedInstruction }
          : dosage.text ? { renderedInstruction: dosage.text } : {}),
      ...(course?.id ? { id: course.id } : {}),
      ...(course?.extension?.length ? { extension: course.extension } : {}),
      ...(course?.modifierExtension?.length ? { modifierExtension: course.modifierExtension } : {}),
      ...(course?.repeatCycle ? { repeatCycle: course.repeatCycle } : {}),
      ...(course?.safety ? { safety: course.safety } : {}),
      step: [{ component: [toR6Dosage(dosage)] }]
    }, warnings);
    return withPreservedSourceExtension(
      withReconciliationSources(result, reconciliationSources),
      instructionSource
    );
  }
  const groups = new Map<number, (FhirDosage | EzDosage)[]>();
  for (const dosage of effectiveDosages) {
    const requestedSequence = dosage.sequence ?? 1;
    const sequence = Number.isInteger(requestedSequence) && requestedSequence >= 1
      ? requestedSequence : 1;
    if (sequence !== requestedSequence) {
      preserveRetainedMarkers = true;
      addWarning(warnings,
        "Invalid Dosage.sequence was preserved in the component and projected into the first stage for correction.");
    }
    if (!groups.has(sequence)) groups.set(sequence, []);
    groups.get(sequence)!.push(dosage);
  }
  const stepMetadata = new Map<number, NonNullable<EzCourseMetadata["step"]>[number]>();
  for (const step of course?.step ?? []) {
    if (!Number.isInteger(step.sequence) || step.sequence < 1 ||
        stepMetadata.has(step.sequence)) {
      reconciliationSources.push(retainedCourseStepSource(step));
      addWarning(warnings,
        "Course step metadata with an invalid or duplicate sequence was retained as source provenance.");
      continue;
    }
    stepMetadata.set(step.sequence, step);
  }
  const sequenceSet = new Set([...groups.keys(), ...stepMetadata.keys()]);
  if ([...stepMetadata.keys()].some(sequence => !groups.has(sequence))) {
    addWarning(warnings,
      "Course step metadata without a live dosage was retained as an empty stage for clinician correction.");
  }
  const result: FhirR6DosageDetails = {
    ...(course?.renderedInstruction !== undefined
      ? { renderedInstruction: course.renderedInstruction }
      : renderedInstruction !== undefined
        ? { renderedInstruction }
        : preservedInstruction !== undefined
          ? { renderedInstruction: preservedInstruction }
          : effectiveDosages.length === 1 && effectiveDosages[0].text
            ? { renderedInstruction: effectiveDosages[0].text } : {}),
    ...(course?.id ? { id: course.id } : {}),
    ...(course?.extension?.length ? { extension: course.extension } : {}),
    ...(course?.modifierExtension?.length ? { modifierExtension: course.modifierExtension } : {}),
    ...(course?.repeatCycle ? { repeatCycle: course.repeatCycle } : {}),
    ...(course?.safety ? { safety: course.safety } : {}),
    step: [...sequenceSet].sort((a, b) => a - b).map(sequence => {
      const step = stepMetadata.get(sequence);
      return {
        ...(step?.id ? { id: step.id } : {}),
        ...(step?.extension?.length ? { extension: step.extension } : {}),
        ...(step?.modifierExtension?.length ? { modifierExtension: step.modifierExtension } : {}),
        ...(step?.start ? { start: step.start } : {}),
        ...(step?.end ? { end: step.end } : {}),
        ...(step?.count !== undefined ? { count: step.count } : {}),
        ...(step?.safety ? { safety: step.safety } : {}),
        component: (groups.get(sequence) ?? []).map(dosage =>
          toR6Dosage(dosage))
      };
    })
  };
  return withPreservedSourceExtension(
    withReconciliationSources(
      withReconciliationWarnings(result, warnings),
      reconciliationSources
    ),
    instructionSource
  );
}

/** Import a complete R6 course without replacing EZMED's flat dosage layout. */
export function fromDosageDetails(details: FhirR6DosageDetails): {
  dosages: EzDosage[];
  course: EzCourseMetadata;
} {
  const dosages: EzDosage[] = [];
  const metadata: NonNullable<EzCourseMetadata["step"]> = [];
  for (let index = 0; index < details.step.length; index++) {
    const step = details.step[index];
    const sequence = index + 1;
    if (step.id || step.extension?.length || step.modifierExtension?.length ||
        step.start || step.end || step.count !== undefined || step.safety) {
      metadata.push({
        sequence,
        ...(step.id ? { id: step.id } : {}),
        ...(step.extension?.length ? { extension: step.extension } : {}),
        ...(step.modifierExtension?.length ? { modifierExtension: step.modifierExtension } : {}),
        ...(step.start ? { start: step.start } : {}),
        ...(step.end ? { end: step.end } : {}),
        ...(step.count !== undefined ? { count: step.count } : {}),
        ...(step.safety ? { safety: step.safety } : {})
      });
    }
    for (const component of step.component) {
      const r5 = fromR6Dosage(component, sequence);
      const dates = getDosageExcludedDates(r5);
      dosages.push(cloneStructuredValue({
        ...r5,
        ...(component.doseAndRate ? { doseAndRate: component.doseAndRate } : {}),
        ...(component.condition?.length ? { condition: component.condition } : {}),
        ...(component.safety ? { safety: component.safety } : {}),
        ...(component.site?.reference ? { siteReference: component.site.reference } : {}),
        ...(dates.length ? { excludedDates: dates } : {})
      }));
    }
  }
  // A consumer may persist just the flat .fhir array and not its optional
  // course metadata. Preserve the complete R6 step relationships on the
  // first item as a modifier extension whenever R5 fields alone are
  // insufficient. Strict R5 exporters already understand this same marker.
  const retainedCourse = createCourseDetailsExtension(details);
  if (retainedCourse) {
    for (let index = 0; index < dosages.length; index++) {
      const dosage = dosages[index];
      const existing = dosage.modifierExtension ?? [];
      // The new marker is already detached. Its first owner needs no second
      // copy; subsequent rows still receive independent editable trees.
      dosage.modifierExtension = existing.some(extension => equalStructuredValues(extension, retainedCourse))
        ? existing
        : [...existing, index === 0 ? retainedCourse : cloneStructuredValue(retainedCourse)];
    }
  }
  return {
    dosages,
    course: {
      ...(details.id ? { id: details.id } : {}),
      ...(details.extension?.length ? { extension: details.extension } : {}),
      ...(details.modifierExtension?.length ? { modifierExtension: details.modifierExtension } : {}),
      ...(details.renderedInstruction !== undefined
        ? { renderedInstruction: details.renderedInstruction } : {}),
      ...(details.repeatCycle ? { repeatCycle: details.repeatCycle } : {}),
      ...(details.safety ? { safety: details.safety } : {}),
      ...(metadata.length ? { step: metadata } : {})
    }
  };
}

/** Flatten R6 steps to R5 Dosage.sequence with explicit modifier extensions. */
export function toFhirR5Dosages(
  input: FhirR6DosageDetails | readonly (FhirDosage | EzDosage)[],
  course?: EzCourseMetadata
): FhirDosage[] {
  const details = Array.isArray(input)
    ? toDosageDetails(input, course?.renderedInstruction, course)
    : input as FhirR6DosageDetails;
  const result: FhirDosage[] = [];
  for (let index = 0; index < details.step.length; index++) {
    for (const component of details.step[index].component) {
      // Public rows must be independently editable even when a caller's R6
      // course reuses the same nested object across several stages.
      result.push(cloneStructuredValue(fromR6Dosage(component, index + 1)));
    }
  }
  // The rendered whole-course instruction is display information, not
  // modifier semantics. Store it using a non-modifier extension; the core
  // R5 dosage text can remain a faithful per-dose realization.
  if (result.length && details.renderedInstruction !== undefined) {
    result[0] = withDosageEditProvenance(result, details.renderedInstruction)[0];
  }
  const retainedCourse = createCourseDetailsExtension(details);
  if (retainedCourse) {
    for (let index = 0; index < result.length; index++) {
      const dosage = result[index];
      const existing = dosage.modifierExtension ?? [];
      dosage.modifierExtension = existing.some(extension => equalStructuredValues(extension, retainedCourse))
        ? existing : [...existing, index === 0 ? retainedCourse : cloneStructuredValue(retainedCourse)];
    }
  }
  return result;
}

/** Create the structured course marker only when native R5 fields cannot carry
 * the complete relationships. Import/projection callers reuse it directly.
 * @param details Complete R6 course to retain alongside independently persisted rows.
 */
export function createCourseDetailsExtension(details: FhirR6DosageDetails): FhirExtension | undefined {
  // R5 cannot express complete conditional trees, relative step timing,
  // safety expressions or site references in core fields.
  // Preserve the original R6 representation when lowering would lose
  // any such information. Unfamiliar fields remain structured and editable.
  const hasR6OnlyFields = Boolean(
    details.repeatCycle || details.safety ||
    // Human-readable renderedInstruction does not change administration
    // semantics and must not force an isModifier extension on plain R5 doses.
    details.extension?.length || details.modifierExtension?.length ||
    details.step.some(step =>
      step.start || step.end || step.count !== undefined || step.safety ||
      step.extension?.length || step.modifierExtension?.length ||
      step.component.some(component =>
        component.condition?.length || component.safety ||
        component.site?.reference ||
        component.doseAndRate?.some(rate => rate.doseExpression || rate.rateExpression)))
  );
  return hasR6OnlyFields ? {
    url: DOSAGE_DETAILS_R5_URL,
    extension: [encodeCourseDetails(details)]
  } : undefined;
}
