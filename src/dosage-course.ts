/** FHIR R5/R6 bridging uses typed extension children exclusively. Source,
 * course, condition and edit metadata remain structured and independently editable. */
import { cloneStructuredValue, equalStructuredValues } from "./stable-structure";
import {
  FhirDayOfWeek, FhirDosage, FhirExtension, FhirQuantity, FhirR6Dosage, FhirR6DosageCondition,
  FhirR6DosageDetails, FhirR6DosageSafety, FhirR6DoseLimit, FhirR6Quantity,
  MedicationCondition, EzDosage, EzCourseMetadata, EzCourseStep
} from "./types";

/** Modifier extensions: ignoring either can change whether a dose may be given. */
export const DOSAGE_CONDITION_R5_URL =
  "urn:ezmedicationinput:StructureDefinition:medication-conditional-dose";
/** Separate R6 DosageCondition-level extension: the R5 Dosage modifier has
 * a different context and nested child contract, so it cannot be reused. */
export const DOSAGE_CONDITION_R6_LOGIC_URL =
  "urn:ezmedicationinput:StructureDefinition:medication-r6-condition-logic";
export const DOSAGE_EXCLUDED_DATES_R5_URL =
  "urn:ezmedicationinput:StructureDefinition:medication-excluded-calendar-dates";
export const DOSAGE_DETAILS_R5_URL =
  "urn:ezmedicationinput:StructureDefinition:medication-r6-course-details";
/** Non-modifier metadata: preserves the author's entire literal instruction
 * without forcing ordinary R5 consumers to implement R6 safety semantics. */
export const DOSAGE_RENDERED_INSTRUCTION_R5_URL =
  "urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction";
export const DOSAGE_EXCLUDED_WEEKDAYS_R5_URL =
  "urn:ezmedicationinput:StructureDefinition:medication-excluded-weekdays";
/** Non-modifier provenance emitted when an editable R5 projection and its
 * retained R6 source cannot be merged one-to-one. */
export const DOSAGE_RECONCILIATION_WARNING_URL =
  "urn:ezmedicationinput:StructureDefinition:medication-course-reconciliation-warning";
const DOSAGE_RECONCILIATION_SOURCE_URL =
  "urn:ezmedicationinput:StructureDefinition:medication-course-reconciliation-source";
const DOSAGE_RETAINED_R5_SEQUENCE_URL =
  "urn:ezmedicationinput:StructureDefinition:medication-retained-r5-sequence";
const DOSAGE_RETAINED_COURSE_STEP_URL =
  "urn:ezmedicationinput:StructureDefinition:medication-retained-course-step";
/** Treatment-relative phase origin for an independent parallel component. */
export const PARALLEL_COMPONENT_PHASE_ORIGIN_URL =
  "urn:ezmedicationinput:StructureDefinition:medication-parallel-component-phase-origin";
/** Local must-understand profile for exclusive administration choices.
 * Equal R5 sequences and R6 step components alone represent concurrency,
 * so grammar-proven alternatives need explicit membership in both formats.
 */
export const DOSAGE_ALTERNATIVE_CHOICE_URL =
  "urn:ezmedicationinput:StructureDefinition:medication-alternative-choice";

/** Group identity is course-local; a branch may contain multiple dosages. */
export interface DosageAlternativeChoice {
  groupId: string;
  branchId: string;
  selectionBehavior: "exactly-one";
}

/** Read typed membership without interpreting clinical text or changing source.
 * @param dosage An R5 or R6 dosage carrying the same modifier-extension shape.
 * @returns Recognized membership, or undefined while unfamiliar data stays attached.
 */
export function getDosageAlternativeChoice(
  dosage: Pick<FhirDosage, "modifierExtension">
): DosageAlternativeChoice | undefined {
  const marker = dosage.modifierExtension?.find(extension =>
    extension.url === DOSAGE_ALTERNATIVE_CHOICE_URL);
  const fields = marker?.extension;
  if (!fields) return undefined;
  const groupId = fields.find(field => field.url === "groupId")?.valueString;
  const branchId = fields.find(field => field.url === "branchId")?.valueString;
  const selectionBehavior = fields.find(field => field.url === "selectionBehavior")?.valueCode;
  return groupId && branchId && selectionBehavior === "exactly-one"
    ? { groupId, branchId, selectionBehavior } : undefined;
}

/** Assign membership already established by the typed regimen graph.
 * This does not choose a branch, deduce a group from wording, or add conditions.
 * @param dosage The editable R5 or R6 component to update.
 * @param choice Proven membership; undefined explicitly clears this modifier.
 */
export function setDosageAlternativeChoice(
  dosage: Pick<FhirDosage, "modifierExtension">,
  choice: DosageAlternativeChoice | undefined
): void {
  replacementExtensions(dosage, DOSAGE_ALTERNATIVE_CHOICE_URL, choice ? {
    url: DOSAGE_ALTERNATIVE_CHOICE_URL,
    extension: [
      { url: "groupId", valueString: choice.groupId },
      { url: "branchId", valueString: choice.branchId },
      { url: "selectionBehavior", valueCode: choice.selectionBehavior }
    ]
  } : undefined);
}

/** Machine-readable declaration of the local alternative-choice modifier.
 * It is generated beside its only codec, avoiding a second copied schema or
 * an undocumented native FHIR field. Callers can publish/validate the returned
 * StructureDefinition independently of the parser's permissive read path.
 */
export function buildDosageAlternativeChoiceStructureDefinition() {
  const slice = (name: string, code: "string" | "code", fixedCode?: string) => [
    { id: "Extension.extension:" + name, path: "Extension.extension",
      sliceName: name, min: 1, max: "1", type: [{ code: "Extension" }] },
    { id: "Extension.extension:" + name + ".extension",
      path: "Extension.extension.extension", max: "0" },
    { id: "Extension.extension:" + name + ".url",
      path: "Extension.extension.url", fixedUri: name },
    { id: "Extension.extension:" + name + ".value[x]",
      path: "Extension.extension.value[x]", min: 1, max: "1",
      type: [{ code }], ...(fixedCode ? { fixedCode } : {}) }
  ];
  return {
    resourceType: "StructureDefinition" as const,
    id: "medication-alternative-choice",
    url: DOSAGE_ALTERNATIVE_CHOICE_URL,
    name: "MedicationAlternativeChoice",
    title: "Medication alternative choice membership",
    status: "draft" as const,
    description: "Identifies a dosage as one branch in a course-local exactly-one choice. All dosages sharing a branch belong to the same option; ignoring the modifier would incorrectly administer mutually exclusive options concurrently.",
    kind: "complex-type" as const,
    abstract: false,
    type: "Extension",
    baseDefinition: "http://hl7.org/fhir/StructureDefinition/Extension",
    derivation: "constraint" as const,
    context: [{ type: "element" as const, expression: "Dosage" }],
    differential: { element: [
      { id: "Extension", path: "Extension", isModifier: true,
        isModifierReason: "Changes concurrent dosage components into exclusive selectable branches." },
      { id: "Extension.extension", path: "Extension.extension",
        slicing: { discriminator: [{ type: "value", path: "url" }],
          ordered: false, rules: "closed" } },
      ...slice("groupId", "string"),
      ...slice("branchId", "string"),
      ...slice("selectionBehavior", "code", "exactly-one"),
      { id: "Extension.url", path: "Extension.url", fixedUri: DOSAGE_ALTERNATIVE_CHOICE_URL },
      { id: "Extension.value[x]", path: "Extension.value[x]", max: "0" }
    ] }
  };
}

const CONDITION_CODE_SYSTEM = "http://hl7.org/fhir/CodeSystem/dosage-condition-code";
const INTERNAL_CONDITION_CODE_SYSTEM = "urn:ezmedicationinput:CodeSystem:medication-condition";
/** Exact US LOINC observation concepts for named measurements. Generic "BP"
 * and "glucose" deliberately remain text-only: their component/specimen is
 * unspecified, and asserting SBP or blood glucose would fabricate meaning.
 */
const CONDITION_MEASUREMENT_CODES: Record<string, { code: string; display: string }> = {
  sbp: { code: "8480-6", display: "Systolic blood pressure" },
  dbp: { code: "8462-4", display: "Diastolic blood pressure" },
  hr: { code: "8867-4", display: "Heart rate" },
  "heart rate": { code: "8867-4", display: "Heart rate" },
  temperature: { code: "8310-5", display: "Body temperature" },
  weight: { code: "29463-7", display: "Body weight" },
  spo2: { code: "59408-5", display: "Oxygen saturation in Arterial blood by Pulse oximetry" }
};

function replacementExtensions(
  dosage: Pick<FhirDosage, "modifierExtension">, url: string, value: FhirExtension | undefined
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
  // A clinician-cleared native condition also owns direct reads: do not
  // resurrect the older R5 modifier before an export/reload reconciles it.
  if (expanded.condition?.length === 0) return undefined;
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

/** Read the source-certified whole-day predicate from the existing condition bridge.
 * @param dosage Editable dosage containing a structured condition extension.
 */
function retainedCalendarDayPredicate(dosage: FhirDosage | EzDosage): MedicationCondition | undefined {
  const extension = dosage.modifierExtension?.find(value => value.url === DOSAGE_CONDITION_R5_URL);
  const child = extension?.extension?.find(value => value.url === "calendarDayPredicate");
  const value = child ? decodeConditionPredicate(child) : undefined;
  return isMedicationCondition(value) ? value : undefined;
}

/** A whole-day evaluation is licensed only for the same live predicate that
 * the source grammar identified as calendar membership. An edited native
 * condition or a mixed measurement/day predicate cannot inherit that claim.
 * @param dosage Native or R5 dosage with optional source-owned day-domain metadata.
 */
export function getDosageCalendarDayCondition(dosage: FhirDosage | EzDosage): MedicationCondition | undefined {
  const calendar = retainedCalendarDayPredicate(dosage);
  if (!calendar) return undefined;
  const condition = parseDosageCondition(dosage);
  return condition && equalStructuredValues(condition, calendar) ? calendar : undefined;
}

/** Recognize only the exact generated bridge; unfamiliar metadata remains raw.
 * @param extension The retained known condition bridge.
 */
function isExactCalendarConditionBridge(extension: FhirExtension): boolean {
  if (Object.keys(extension).some(key => key !== "url" && key !== "extension")) return false;
  const predicate = parseConditionModifier(extension);
  const calendar = retainedCalendarDayPredicate({ modifierExtension: [extension] });
  return Boolean(predicate && calendar && equalStructuredValues(predicate, calendar) &&
    equalStructuredValues(extension.extension, [encodeConditionPredicate(predicate),
      { ...encodeConditionPredicate(calendar), url: "calendarDayPredicate" }]));
}

/** Encode the clinical predicate and its independently supplied day-domain type.
 * @param dosage Editable target dosage; other modifiers remain untouched.
 * @param condition Live clinical predicate, or undefined to clear it.
 * @param calendarDayCondition Source-certified whole-day predicate, never inferred from prose.
 */
export function setDosageCondition(
  dosage: FhirDosage,
  condition: MedicationCondition | undefined,
  calendarDayCondition?: MedicationCondition
): void {
  const calendar = calendarDayCondition ?? retainedCalendarDayPredicate(dosage);
  const children = condition ? [encodeConditionPredicate(condition)] : [];
  if (condition && calendar && equalStructuredValues(condition, calendar)) {
    children.push({ ...encodeConditionPredicate(calendar), url: "calendarDayPredicate" });
  }
  replacementExtensions(dosage, DOSAGE_CONDITION_R5_URL, condition ? {
    url: DOSAGE_CONDITION_R5_URL, extension: children
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
      // Keep the existing explicit condition-kind code AND add any exact
      // observation code. FHIR already retains the typed comparator/value.
      code: {
        coding: [
          { system: INTERNAL_CONDITION_CODE_SYSTEM, code: "measurement", display: condition.name },
          ...(CONDITION_MEASUREMENT_CODES[condition.name.toLowerCase()] ? [{
            system: "http://loinc.org",
            ...CONDITION_MEASUREMENT_CODES[condition.name.toLowerCase()]
          }] : [])
        ],
        text: condition.name
      },
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
    code: { coding: [{ system: INTERNAL_CONDITION_CODE_SYSTEM, code: "expression",
      display: "Medication conditional expression" }] },
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
    // An empty native list is an intentional edit clearing a condition, not
    // a missing field asking the R5 bridge to restore its previous meaning.
    const needsCondition = input.condition === undefined &&
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
  // Presence is semantically different from absence: [] explicitly clears
  // an R6-native condition. It must not fall back to a stale R5 modifier.
  const predicate = ownConditions === undefined ? parseDosageCondition(dosage) : undefined;
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
    // Storage metadata belongs beside the live row. Nesting its shared
    // owner in an R6 component would wrap it again on every round trip.
    // Reconciliation provenance is retained once at course level.
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
  } else if (condition !== undefined) {
    // A clinician-cleared native condition must not be resurrected by the
    // exact day-domain bridge retained solely to preserve its source type.
    // Unfamiliar modifiers and additional metadata are left untouched.
    const retained = output.modifierExtension?.filter(extension =>
      extension.url !== DOSAGE_CONDITION_R5_URL || !isExactCalendarConditionBridge(extension));
    output.modifierExtension = retained?.length ? retained : undefined;
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
    ...(modifierExtension?.some(item => item.url !== DOSAGE_DETAILS_R5_URL ||
      item.extension?.some(child => child.url === "rowIndex"))
      ? { modifierExtension: modifierExtension.filter(item => item.url !== DOSAGE_DETAILS_R5_URL ||
        item.extension?.some(child => child.url === "rowIndex")).map(item =>
          item.url === DOSAGE_DETAILS_R5_URL ? { ...item, extension: item.extension?.filter(child =>
            ["sequence", "stepCount", "step", "component", "context", "contextRequired", "course", "emptyStep", "missingContext"].indexOf(child.url) >= 0) } : item) } : {})
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
 * Reconcile an R6-only expression against the same R5 dose/rate slot.
 * A clinician editing the numeric amount/rate supersedes its prior expression:
 * the complete original R6 course stays as inert reconciliation provenance,
 * never a second active dose/rate entry. Edits to unrelated fields retain the
 * expression, including R6 components carrying other original dose metadata.
 * @param original The original R6 choices.
 * @param projected Editable live dose/rate fields projected back from R5.
 * @param baseline The original R5-compatible projection, before any edits.
 * @param warnings Course-level notices for clinically meaningful changes.
 */
function retainDoseExpressions(
  original: FhirR6Dosage["doseAndRate"],
  projected: FhirR6Dosage["doseAndRate"],
  baseline: FhirDosage["doseAndRate"],
  warnings: string[]
): FhirR6Dosage["doseAndRate"] {
  if (!original?.some(item => item.doseExpression || item.rateExpression)) return projected;
  const result = projected?.map(item => ({ ...item })) ?? [];
  let retained = false;
  let superseded = false;
  for (let index = 0; index < original.length; index++) {
    const old = original[index];
    if (!old.doseExpression && !old.rateExpression) continue;
    const current = result[index];
    if (!current) {
      // Removal of an editable dosage slot must not resurrect an old
      // expression as an executable administration.
      superseded = true;
      continue;
    }
    const previous = baseline?.[index];
    const doseUnchanged = equivalentProjection(
      { doseQuantity: previous?.doseQuantity, doseRange: previous?.doseRange },
      { doseQuantity: current.doseQuantity, doseRange: current.doseRange }
    );
    const rateUnchanged = equivalentProjection(
      { rateQuantity: previous?.rateQuantity, rateRange: previous?.rateRange,
        rateRatio: previous?.rateRatio },
      { rateQuantity: current.rateQuantity, rateRange: current.rateRange,
        rateRatio: current.rateRatio }
    );
    if (old.doseExpression) {
      if (!doseUnchanged || current.doseExpression &&
          !equivalentProjection(current.doseExpression, old.doseExpression)) {
        superseded = true;
      } else {
        if (!current.doseExpression) current.doseExpression = old.doseExpression;
        retained = true;
      }
    }
    if (old.rateExpression) {
      if (!rateUnchanged || current.rateExpression &&
          !equivalentProjection(current.rateExpression, old.rateExpression)) {
        superseded = true;
      } else {
        if (!current.rateExpression) current.rateExpression = old.rateExpression;
        retained = true;
      }
    }
  }
  if (superseded) {
    addWarning(warnings,
      "Retained R6 dose/rate expressions superseded by edited R5 dose fields were preserved only as inert source provenance.");
  }
  if (retained) {
    addWarning(warnings,
      "R6-only dose/rate expressions were preserved because their R5 dose/rate fields were unchanged.");
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
      if (component.id)
        originalIdCounts.set(component.id, (originalIdCounts.get(component.id) ?? 0) + 1);
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
      if (!id || liveIdCounts.get(id) !== 1 || originalIdCounts.get(id) !== 1) continue;
      const match = step.component.findIndex(component => component.id === id);
      if (match >= 0) {
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
        if (liveChoiceCounts.get(key) === 1 && match !== undefined && match >= 0 &&
            !usedOriginalIndices.has(match)) {
          assigned[j] = match;
          usedOriginalIndices.add(match);
        }
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
      // An explicitly present but undefined native field is a clinician edit
      // clearing a previously retained R6-only BodyStructure reference.
      // An absent field means an ordinary strict R5 row, which cannot express
      // that reference and must continue to inherit it from retained source.
      const siteReferenceSpecified = Object.prototype.hasOwnProperty.call(
        expanded, "siteReference");
      const referenceEqual = !siteReferenceSpecified || old !== undefined &&
        equivalentProjection(old.site?.reference, expanded.siteReference);
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
          fresh.doseAndRate = retainDoseExpressions(old.doseAndRate, fresh.doseAndRate,
            baseline.doseAndRate, warnings);
        if (old.site?.reference && !siteReferenceSpecified &&
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
 * @param dosages Authoritative live R5 rows, including retained course metadata.
 * @param renderedInstruction Explicit replacement whole-course display.
 * @param course Explicit editable course and step metadata, when supplied.
 * @param options Confirm corrected phase sequences after editing saved rows.
 * Only their persisted conflict flags are cleared; live disagreements still
 * block numeric execution and the prior conflict remains source provenance.
 * @returns The editable R6 course with any unresolved context retained.
 */
export function toDosageDetails(
  dosages: readonly (FhirDosage | EzDosage)[],
  renderedInstruction?: string,
  course?: EzCourseMetadata,
  options?: { resolvedPhaseSequences?: readonly number[] }
): FhirR6DosageDetails {
  if (dosages.some(compactCourseMarker))
    return reconcileCompactCourse(dosages, renderedInstruction, course, options?.resolvedPhaseSequences);
  // Import historical complete-course markers without emitting them again.
  // Earlier persisted R5 rows can carry an entire source course. Select the
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
  attachCourseDetailsExtensions(dosages, details);
  const editable = details.renderedInstruction === undefined ? dosages
    : withDosageEditProvenance(dosages, details.renderedInstruction);
  return {
    dosages: editable,
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
  attachCourseDetailsExtensions(result, details);
  // Source text has one non-modifier owner and a compact edit baseline.
  return details.renderedInstruction === undefined ? result
    : withDosageEditProvenance(result, details.renderedInstruction);
}

/** R5-only fields whose original R6 spelling or metadata needs a local delta. */
interface ComponentDeltaBaseline {
  condition?: string;
  safety?: string;
  site?: string;
  doseAndRate?: Array<{ dose?: string; rate?: string }>;
}

/** Each marker belongs to its live row, never to another component's snapshot. */
interface CompactCourseRow {
  rowIndex: number;
  sequence: number;
  stepCount: number;
  step?: Omit<FhirR6DosageDetails["step"][number], "component">;
  component?: Partial<FhirR6Dosage>;
  baseline?: ComponentDeltaBaseline;
  context?: string;
  contextRequired?: boolean;
  course?: Omit<FhirR6DosageDetails, "step" | "renderedInstruction">;
  emptyStep?: EzCourseStep[];
  missingContext?: string[];
}

/** Native dose choice, excluding a separately retained R6 expression.
 * @param entry The live editable dose/rate slot.
 */
function doseChoice(entry: NonNullable<FhirDosage["doseAndRate"]>[number] | undefined) {
  return { doseQuantity: entry?.doseQuantity, doseRange: entry?.doseRange };
}

/** Native rate choice, independent of an expression in the dose slot.
 * @param entry The live editable dose/rate slot.
 */
function rateChoice(entry: NonNullable<FhirDosage["doseAndRate"]>[number] | undefined) {
  return { rateQuantity: entry?.rateQuantity, rateRange: entry?.rateRange, rateRatio: entry?.rateRatio };
}

/** Build only the fields that cannot be reconstructed from this live row.
 * Extended R5 dosages already own native condition/safety/expression fields;
 * strict R5 needs typed deltas for those fields, but never another timing/dose copy.
 * @param original Source component.
 * @param row Its independently editable R5 or extended-R5 projection.
 */
function componentDelta(original: FhirR6Dosage, row: FhirDosage | EzDosage): {
  component?: Partial<FhirR6Dosage>; baseline?: ComponentDeltaBaseline
} {
  const projected = toR6Dosage(row);
  const component: Partial<FhirR6Dosage> = {};
  const baseline: ComponentDeltaBaseline = {};
  if (!equalStructuredValues(original.condition, projected.condition)) {
    component.condition = original.condition;
    baseline.condition = compactProjectionFingerprint(parseDosageCondition(row));
  }
  if (!equalStructuredValues(original.safety, projected.safety)) {
    component.safety = original.safety;
    baseline.safety = compactProjectionFingerprint(toR6Safety(row));
  }
  if (original.site?.reference && !equalStructuredValues(original.site.reference, projected.site?.reference)) {
    component.site = { reference: original.site.reference };
    baseline.site = compactProjectionFingerprint(row.site);
  }
  if (original.doseAndRate?.some((entry, index) =>
    !equalStructuredValues(entry.doseExpression, projected.doseAndRate?.[index]?.doseExpression) ||
    !equalStructuredValues(entry.rateExpression, projected.doseAndRate?.[index]?.rateExpression))) {
    component.doseAndRate = original.doseAndRate.map(entry => ({
      ...(entry.doseExpression ? { doseExpression: entry.doseExpression } : {}),
      ...(entry.rateExpression ? { rateExpression: entry.rateExpression } : {})
    }));
    baseline.doseAndRate = original.doseAndRate.map((entry, index) => ({
      ...(entry.doseExpression ? { dose: compactProjectionFingerprint(doseChoice(row.doseAndRate?.[index])) } : {}),
      ...(entry.rateExpression ? { rate: compactProjectionFingerprint(rateChoice(row.doseAndRate?.[index])) } : {})
    }));
  }
  return Object.keys(component).length ? { component, baseline } : {};
}

/** Encode local phase metadata and unrepresentable component fields.
 * Course-wide metadata has one owner, referenced by all participating rows.
 * All rows are newly created by the caller; no source course is mutated.
 * @param dosages Fresh flattened output rows in step/component order.
 * @param details Typed source course, used only to calculate missing metadata.
 */
export function attachCourseDetailsExtensions(
  dosages: (FhirDosage | EzDosage)[], details: FhirR6DosageDetails
): void {
  if (!dosages.length) return;
  // Ordinary R5 prescriptions do not pay for a second projection.
  const needed = details.id !== undefined || details.repeatCycle || details.safety ||
    details.extension?.length || details.modifierExtension?.length ||
    details.step.some(step => step.id !== undefined || step.start || step.end ||
      step.count !== undefined || step.safety || step.extension?.length ||
      step.modifierExtension?.length || !step.component.length ||
      step.component.some(component => component.condition !== undefined || component.safety ||
        component.site?.reference ||
        component.modifierExtension?.some(extension => extension.url === DOSAGE_DETAILS_R5_URL) ||
        component.doseAndRate?.some(rate => rate.doseExpression || rate.rateExpression)));
  if (!needed) return;
  const { step: steps, renderedInstruction: _instruction, ...course } = details;
  const emptyStep: EzCourseStep[] = [];
  steps.forEach(({ component, ...step }, index) => {
    if (!component.length) emptyStep.push({ sequence: index + 1, ...step });
  });
  const header = {
    ...(Object.keys(course).some(key => course[key as keyof typeof course] !== undefined) ? { course } : {}),
    ...(emptyStep.length ? { emptyStep } : {})
  };
  const context = Object.keys(header).length ? compactProjectionFingerprint(header) : undefined;
  const contextRequired = Boolean(details.repeatCycle || details.safety || details.modifierExtension?.length || emptyStep.length);
  let rowIndex = 0;
  for (let index = 0; index < steps.length; index++) {
    const { component: components, ...step } = steps[index];
    const hasStep = Object.keys(step).some(key => step[key as keyof typeof step] !== undefined);
    for (const component of components) {
      const row = dosages[rowIndex];
      const delta = componentDelta(component, row);
      const missingContext: string[] = [];
      for (const extension of component.modifierExtension ?? []) {
        if (extension.url !== DOSAGE_DETAILS_R5_URL) continue;
        for (const child of extension.extension ?? []) {
          if (child.url === "missingContext" && child.valueString !== undefined)
            missingContext.push(child.valueString);
        }
      }
      if (hasStep || delta.component || context || steps.length > 1 || missingContext?.length) {
        const local: CompactCourseRow = {
          rowIndex, sequence: index + 1, stepCount: steps.length,
          ...(hasStep ? { step } : {}), ...delta,
          ...(context ? { context, ...(contextRequired ? { contextRequired } : {}), ...(rowIndex === 0 ? header : {}) } : {}),
          ...(missingContext?.length ? { missingContext } : {})
        };
        replacementExtensions(row, DOSAGE_DETAILS_R5_URL, {
          url: DOSAGE_DETAILS_R5_URL, extension: encodeFields(local, COMPACT_ROW)
        });
      }
      rowIndex++;
    }
  }
}

/** Detect the row-local contract without decoding ordinary R5 inputs.
 * @param dosage Live row carrying optional course metadata.
 */
function compactCourseMarker(dosage: FhirDosage | EzDosage): FhirExtension | undefined {
  return dosage.modifierExtension?.find(value => value.url === DOSAGE_DETAILS_R5_URL &&
    value.extension?.some(child => child.url === "rowIndex"));
}

/** Preserve a superseded local delta without nesting its course owner again.
 * @param marker The row's original structured extension.
 */
function localReconciliationSource(marker: FhirExtension): FhirExtension {
  return { ...marker, extension: marker.extension?.filter(child =>
    child.url !== "course" && child.url !== "emptyStep") };
}

/** Restore R6-only choices while respecting edits to each native R5 slot.
 * @param dosage The authoritative live row.
 * @param local Missing fields and compact native-slot baselines.
 * @param warnings Notices about a superseded executable expression.
 */
function restoreComponentDelta(
  dosage: FhirDosage | EzDosage, local: CompactCourseRow, warnings: string[]
): FhirR6Dosage {
  const fresh = toR6Dosage(dosage);
  const delta = local.component;
  if (!delta) return fresh;
  const expanded = dosage as EzDosage;
  if (delta.condition !== undefined && expanded.condition === undefined &&
      local.baseline?.condition === compactProjectionFingerprint(parseDosageCondition(dosage))) {
    fresh.condition = delta.condition;
  }
  if (delta.safety && expanded.safety === undefined) {
    fresh.safety = local.baseline?.safety === compactProjectionFingerprint(toR6Safety(dosage))
      ? delta.safety : reconcileR5SafetyEdits(delta.safety, fresh.safety);
  }
  if (delta.site?.reference && !Object.prototype.hasOwnProperty.call(expanded, "siteReference") &&
      local.baseline?.site === compactProjectionFingerprint(dosage.site)) {
    fresh.site = { ...fresh.site, reference: delta.site.reference };
  }
  if (delta.doseAndRate) {
    const entries = fresh.doseAndRate?.map(entry => ({ ...entry }));
    let superseded = false;
    delta.doseAndRate.forEach((old, index) => {
      const entry = entries?.[index];
      const baseline = local.baseline?.doseAndRate?.[index];
      if (old.doseExpression) {
        if (entry && baseline?.dose === compactProjectionFingerprint(doseChoice(entry)) &&
            !Object.prototype.hasOwnProperty.call(entry, "doseExpression")) entry.doseExpression = old.doseExpression;
        else if (!entry || !equalStructuredValues(entry.doseExpression, old.doseExpression)) superseded = true;
      }
      if (old.rateExpression) {
        if (entry && baseline?.rate === compactProjectionFingerprint(rateChoice(entry)) &&
            !Object.prototype.hasOwnProperty.call(entry, "rateExpression")) entry.rateExpression = old.rateExpression;
        else if (!entry || !equalStructuredValues(entry.rateExpression, old.rateExpression)) superseded = true;
      }
    });
    if (entries) fresh.doseAndRate = entries;
    if (superseded) addWarning(warnings,
      "Retained R6 dose/rate expressions superseded by edited R5 dose fields were preserved only as inert source provenance.");
  }
  return fresh;
}

/** Missing shared context remains a typed, editable modifier on the component.
 * @param component Surviving live component.
 * @param contexts Unavailable course or predecessor identities.
 */
function withMissingCourseContext(component: FhirR6Dosage, contexts: readonly string[]): FhirR6Dosage {
  return contexts.length ? { ...component, modifierExtension: [
    ...(component.modifierExtension ?? []),
    { url: DOSAGE_DETAILS_R5_URL, extension: contexts.map(valueString => ({ url: "missingContext", valueString })) }
  ] } : component;
}

const CONFLICTING_PHASE_CONTEXT = "conflicting-phase";

/** Phase fields whose disagreement can change administration or supply.
 * IDs and non-modifier annotations remain editable without blocking execution.
 * @param step Local phase metadata without dosage components.
 */
function executablePhaseMetadata(step: NonNullable<CompactCourseRow["step"]>) {
  const { start, end, count, safety, modifierExtension } = step;
  return { start, end, count, safety, modifierExtension };
}

/** Identify unavailable or contradictory context before numeric execution.
 * Parsing, formatting and editing continue to preserve all surviving data.
 * @param course Reconstructed course with typed context markers on its components.
 */
export function getCourseContextIssue(
  course: FhirR6DosageDetails
): "missing-course-context" | "conflicting-course-phase" | undefined {
  let missing = false;
  for (const step of course.step) for (const component of step.component) {
    for (const extension of component.modifierExtension ?? []) {
      if (extension.url !== DOSAGE_DETAILS_R5_URL) continue;
      for (const child of extension.extension ?? []) {
        if (child.url !== "missingContext") continue;
        if (child.valueString === CONFLICTING_PHASE_CONTEXT) return "conflicting-course-phase";
        if (child.valueString !== undefined) missing = true;
      }
    }
  }
  return missing ? "missing-course-context" : undefined;
}

/** Reconstruct a course from current R5 fields and each row's local metadata.
 * No component matching, historical dose snapshot or narrative parse is required.
 * @param dosages Authoritative live rows; order within a sequence is retained.
 * @param renderedInstruction Explicit replacement whole-course display.
 * @param editedCourse Explicit editable course/step metadata, when supplied.
 * @param resolvedPhaseSequences Explicit confirmation of corrected saved phases.
 */
function reconcileCompactCourse(
  dosages: readonly (FhirDosage | EzDosage)[], renderedInstruction?: string,
  editedCourse?: EzCourseMetadata, resolvedPhaseSequences?: readonly number[]
): FhirR6DosageDetails {
  const warnings: string[] = [];
  const sources: FhirExtension[] = [];
  const headers = new Map<string, CompactCourseRow>();
  const conflictingContexts = new Set<string>();
  const conflictingPhases = new Set<number>();
  let metadataEdited = false;
  const metadata = new Map<number, { step: NonNullable<CompactCourseRow["step"]>; rowIndex: number; marker?: FhirExtension }>();
  const localRows = dosages.map(dosage => {
    const marker = compactCourseMarker(dosage);
    for (const extension of dosage.modifierExtension ?? []) {
      if (extension.url === DOSAGE_DETAILS_R5_URL && extension !== marker) sources.push(extension);
    }
    if (!marker) return undefined;
    const decoded = decodeFields(marker.extension ?? [], COMPACT_ROW);
    if (typeof decoded.rowIndex !== "number" || !Number.isInteger(decoded.rowIndex) || decoded.rowIndex < 0 ||
        typeof decoded.sequence !== "number" || !Number.isInteger(decoded.sequence) || decoded.sequence < 1 ||
        typeof decoded.stepCount !== "number" || !Number.isInteger(decoded.stepCount) || decoded.stepCount < 1) {
      sources.push(marker);
      addWarning(warnings, "Malformed retained R6 course metadata was preserved; live R5 fields remain available for correction.");
      return undefined;
    }
    const value = { ...decoded, rowIndex: decoded.rowIndex,
      sequence: decoded.sequence, stepCount: decoded.stepCount } as CompactCourseRow;
    if (!equalStructuredValues(marker, { url: DOSAGE_DETAILS_R5_URL, extension: encodeFields(value, COMPACT_ROW) }))
      sources.push(localReconciliationSource(marker));
    if (value.context && (value.course || value.emptyStep)) {
      const previous = headers.get(value.context);
      if (previous && (!equalStructuredValues(previous.course, value.course) ||
          !equalStructuredValues(previous.emptyStep, value.emptyStep))) {
        if (value.contextRequired || previous.contextRequired) conflictingContexts.add(value.context);
        sources.push({ url: DOSAGE_DETAILS_R5_URL, extension: encodeFields({
          course: previous.course, emptyStep: previous.emptyStep
        }, COMPACT_ROW) });
        sources.push({ url: DOSAGE_DETAILS_R5_URL, extension: marker.extension?.filter(child =>
          child.url === "course" || child.url === "emptyStep") });
        addWarning(warnings, "Conflicting shared course metadata was preserved; resolve the shared owner before numeric execution.");
      } else if (!previous) headers.set(value.context, value);
    } else if (value.course || value.emptyStep) {
      sources.push(marker);
      addWarning(warnings, "Shared course metadata without its context identity was retained as source provenance.");
    }
    if (value.missingContext && value.missingContext.indexOf(CONFLICTING_PHASE_CONTEXT) >= 0) {
      if ((resolvedPhaseSequences?.indexOf(value.sequence) ?? -1) >= 0)
        sources.push(localReconciliationSource(marker));
      else conflictingPhases.add(value.sequence);
    }
    const previous = metadata.get(value.sequence);
    const step = value.step ?? {};
    if (previous && !equalStructuredValues(previous.step, step)) {
      if (previous.marker) sources.push(localReconciliationSource(previous.marker));
      sources.push(localReconciliationSource(marker));
      if (!equalStructuredValues(executablePhaseMetadata(previous.step), executablePhaseMetadata(step))) {
        conflictingPhases.add(value.sequence);
        addWarning(warnings, "Local course phase metadata differs; conflicting executable fields must be resolved before numeric execution.");
      } else addWarning(warnings, "Local course phase metadata differs; the first source row's annotations were retained and conflicting metadata was preserved.");
    }
    if (!previous || value.rowIndex < previous.rowIndex) metadata.set(value.sequence, { step, rowIndex: value.rowIndex, marker });
    return { value, marker };
  });
  // A separately persisted .course object can restore the same shared owner.
  // Match the declared context; an unrelated partial object cannot erase a cycle.
  if (editedCourse) {
    const { step, renderedInstruction: _instruction, ...course } = editedCourse;
    const base = Object.keys(course).length ? { course } : {};
    const candidates: Array<Pick<CompactCourseRow, "course" | "emptyStep">> = [base];
    const liveSequences = new Set(dosages.map(dosage => dosage.sequence ?? 1));
    const emptyStep = step?.filter(value => !liveSequences.has(value.sequence));
    if (emptyStep?.length) candidates.push({ ...base, emptyStep });
    for (const candidate of candidates) {
      const key = compactProjectionFingerprint(candidate);
      if (!headers.has(key)) headers.set(key, {
        rowIndex: 0, sequence: 1, stepCount: 1, context: key, ...candidate
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
      else if (owner && header && (!equalStructuredValues(header.course, owner.course) || !equalStructuredValues(header.emptyStep, owner.emptyStep))) {
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
      addWarning(warnings, "Invalid course step metadata was retained on the course but could not be assigned to an R6 stage.");
      continue;
    }
    if (editedSequences.has(sequence)) {
      sources.push(retainedCourseStepSource(step));
      addWarning(warnings, "Duplicate course step metadata was retained as source provenance; the first editable stage metadata was used.");
      continue;
    }
    editedSequences.add(sequence);
    const merged = { ...metadata.get(sequence)?.step, ...fields };
    if (!equivalentProjection(metadata.get(sequence)?.step ?? {}, merged)) metadataEdited = true;
    metadata.set(sequence, { step: merged, rowIndex: -1 });
  }
  const instructionMarker = dosages.map(dosage => dosage.extension?.find(isRenderedInstructionMarker)).find(Boolean);
  const savedInstruction = instructionMarker?.extension?.find(value => value.url === "instruction")?.valueString;
  const baselineRows = instructionMarker?.extension?.filter(value => value.url === "row") ?? [];
  const used = new Set<number>();
  let instructionMatches = !metadataEdited && !conflictingPhases.size &&
    baselineRows.length === dosages.length && baselineRows.length > 0;
  const live = dosages.map((dosage, index) => {
    const local = localRows[index];
    const sourceIndex = local?.value.rowIndex ?? index;
    const baseline = baselineRows[sourceIndex]?.extension;
    const expectedProjection = baseline?.find(value => value.url === "projectionFingerprint")?.valueString;
    const expectedText = baseline?.find(value => value.url === "textFingerprint")?.valueString;
    const expanded = dosage as EzDosage;
    const delta = local?.value.component;
    const nativeCleared = Boolean(delta && (
      delta.site?.reference && Object.prototype.hasOwnProperty.call(expanded, "siteReference") &&
        !equalStructuredValues(delta.site.reference, expanded.siteReference) ||
      delta.condition !== undefined && expanded.condition !== undefined &&
        !equalStructuredValues(delta.condition, expanded.condition)));
    const projectionMatches = !nativeCleared &&
      (expectedProjection === undefined || expectedProjection === dosageProjectionFingerprint(dosage));
    const textMatches = expectedText === undefined || expectedText === dosageTextFingerprint(dosage);
    if (!projectionMatches || !textMatches || used.has(sourceIndex) || !baseline) instructionMatches = false;
    used.add(sourceIndex);
    if (local && (!projectionMatches || !textMatches)) sources.push(localReconciliationSource(local.marker));
    return !projectionMatches && textMatches ? { ...dosage, text: undefined } : dosage;
  });
  const { step: _editedSteps, renderedInstruction: explicitInstruction, ...courseEdits } = editedCourse ?? {};
  if (editedCourse && !equivalentProjection(header?.course ?? {}, { ...header?.course, ...courseEdits }))
    instructionMatches = false;
  const groups = new Map<number, FhirR6Dosage[]>();
  live.forEach((dosage, index) => {
    const requested = dosage.sequence ?? 1;
    const sequence = Number.isInteger(requested) && requested >= 1 ? requested : 1;
    if (sequence !== requested) addWarning(warnings, "Invalid Dosage.sequence was preserved in the component and projected into the first stage for correction.");
    const local = localRows[index];
    const restored = local ? restoreComponentDelta(dosage, local.value, warnings) : toR6Dosage(dosage);
    const component = local && conflictingPhases.has(local.value.sequence)
      ? withMissingCourseContext(restored, [CONFLICTING_PHASE_CONTEXT]) : restored;
    if (warnings.some(value => value.includes("superseded by edited R5 dose fields")) && local)
      sources.push(localReconciliationSource(local.marker));
    const entries = groups.get(sequence) ?? [];
    entries.push(component); groups.set(sequence, entries);
  });
  const stageCount = Math.max(0, ...localRows.map(local => local?.value.stepCount ?? 0));
  const sequences = new Set([...groups.keys(), ...metadata.keys()]);
  for (let sequence = 1; sequence <= stageCount; sequence++) sequences.add(sequence);
  const steps = [...sequences].sort((a, b) => a - b).map(sequence => ({
    ...metadata.get(sequence)?.step, component: groups.get(sequence) ?? []
  }));
  // A removed predecessor is harmless when the surviving phase has its own
  // treatment-relative start. Otherwise its original elapsed time is unknown.
  let missingPredecessor = false;
  for (const step of steps) {
    if (!step.component.length && !step.start && !step.end) { missingPredecessor = true; continue; }
    if (missingPredecessor && !step.start && step.component.length) missing.add("predecessor");
    if (step.start || step.end || step.component.length) missingPredecessor = false;
  }
  if (missing.size) {
    addWarning(warnings, "Required course context is missing; surviving dosage fields remain editable.");
    for (const step of steps) step.component = step.component.map(component => withMissingCourseContext(component, [...missing]));
    instructionMatches = false;
  }
  const result: FhirR6DosageDetails = {
    ...header?.course, ...courseEdits,
    ...(explicitInstruction !== undefined ? { renderedInstruction: explicitInstruction }
      : renderedInstruction !== undefined ? { renderedInstruction }
      : instructionMatches && savedInstruction !== undefined ? { renderedInstruction: savedInstruction } : {}),
    step: steps
  };
  if (savedInstruction !== undefined && !instructionMatches) addWarning(warnings,
    "Structured dosage fields changed; the original rendered instruction was retained as source provenance instead of displayed as the current instruction.");
  return withPreservedSourceExtension(withReconciliationSources(withReconciliationWarnings(result, warnings), sources),
    instructionMarker && (!instructionMatches || hasUnrecognizedEditMetadata(instructionMarker)) ? instructionMarker : undefined);
}


/**
 * Shared typed extension codec for local missing fields and course metadata.
 * Grammar/clinical meaning stays upstream; no JSON-string payload or second
 * copy of an ordinary dosage is emitted.
 */
/** A declared primitive/datatype value, nested backbone, or retained extension. */
type ValueField = Extract<keyof FhirExtension, `value${string}`>;
interface BridgeField {
  value?: ValueField;
  fields?: BridgeShape;
  repeated?: boolean;
  extension?: boolean;
  quantity?: boolean;
}
type BridgeShape = Readonly<Record<string, BridgeField>>;

const ELEMENT: BridgeShape = {
  id: { value: "valueString" },
  extension: { extension: true, repeated: true },
  modifierExtension: { extension: true, repeated: true }
};
const QUANTITY: BridgeField = { quantity: true };
const RELATIVE_TIME: BridgeShape = {
  ...ELEMENT,
  contextReference: { value: "valueReference" },
  contextDefinition: { value: "valueCanonical" },
  contextPath: { value: "valueString" },
  contextCode: { value: "valueCodeableConcept" },
  offsetDuration: { value: "valueQuantity" },
  offsetRange: { value: "valueRange" },
  text: { value: "valueString" }
};
const CONDITION: BridgeShape = {
  ...ELEMENT,
  code: { value: "valueCodeableConcept" },
  details: { value: "valueCodeableConcept" },
  operation: { value: "valueCode" },
  valueBoolean: { value: "valueBoolean" },
  valueQuantity: QUANTITY,
  valueString: { value: "valueString" },
  text: { value: "valueString" }
};
const SAFETY: BridgeShape = {
  ...ELEMENT,
  ifExceeded: { value: "valueCode" },
  doseLimit: { repeated: true, fields: {
    ...ELEMENT,
    scope: { value: "valueCode" },
    period: { value: "valueQuantity" },
    valueQuantity: QUANTITY,
    valueInteger: { value: "valueInteger" },
    valueExpression: { value: "valueExpression" },
    text: { value: "valueString" }
  } }
};
const COMPONENT: BridgeShape = {
  ...ELEMENT,
  text: { value: "valueString" },
  patientInstruction: { value: "valueString" },
  timing: { value: "valueTiming" },
  route: { value: "valueCodeableConcept" },
  site: { value: "valueCodeableReference" },
  method: { value: "valueCodeableConcept" },
  additionalInstruction: { value: "valueCodeableConcept", repeated: true },
  asNeeded: { value: "valueBoolean" },
  asNeededFor: { value: "valueCodeableConcept", repeated: true },
  condition: { fields: CONDITION, repeated: true },
  safety: { fields: SAFETY },
  doseAndRate: { repeated: true, fields: {
    ...ELEMENT,
    type: { value: "valueCodeableConcept" },
    doseRange: { value: "valueRange" },
    doseQuantity: { value: "valueQuantity" },
    doseExpression: { value: "valueExpression" },
    rateRatio: { value: "valueRatio" },
    rateRange: { value: "valueRange" },
    rateQuantity: { value: "valueQuantity" },
    rateExpression: { value: "valueExpression" }
  } }
};
const STEP: BridgeShape = {
  ...ELEMENT,
  start: { fields: RELATIVE_TIME },
  end: { fields: RELATIVE_TIME },
  count: { value: "valueInteger" },
  component: { fields: COMPONENT, repeated: true },
  safety: { fields: SAFETY }
};
const COURSE: BridgeShape = {
  ...ELEMENT,
  renderedInstruction: { value: "valueString" },
  repeatCycle: { value: "valueQuantity" },
  step: { fields: STEP, repeated: true },
  safety: { fields: SAFETY }
};
const COURSE_STEP: BridgeShape = { ...STEP, sequence: { value: "valueInteger" } };
const COMPACT_ROW: BridgeShape = {
  rowIndex: { value: "valueInteger" },
  sequence: { value: "valueInteger" },
  stepCount: { value: "valueInteger" },
  step: { fields: STEP },
  component: { fields: COMPONENT },
  baseline: { fields: {
    condition: { value: "valueString" }, safety: { value: "valueString" },
    site: { value: "valueString" },
    doseAndRate: { repeated: true, fields: {
      dose: { value: "valueString" }, rate: { value: "valueString" }
    } }
  } },
  context: { value: "valueString" },
  contextRequired: { value: "valueBoolean" },
  course: { fields: COURSE },
  emptyStep: { fields: COURSE_STEP, repeated: true },
  missingContext: { value: "valueString", repeated: true }
};
const PREDICATE: Record<string, BridgeField> = {
  kind: { value: "valueCode" }, name: { value: "valueString" },
  operation: { value: "valueCode" }, value: { value: "valueDecimal" },
  unit: { value: "valueString" }, text: { value: "valueString" },
  expected: { value: "valueBoolean" }
};
PREDICATE.condition = { fields: PREDICATE };
PREDICATE.conditions = { fields: PREDICATE, repeated: true };

/** Preserve an unfamiliar field as explicit typed extension content, never an
 * opaque JSON string. Known FHIR fields use the named datatype schemas above;
 * this escape hatch only retains future/unrecognized native fields verbatim.
 * @param url The enclosing field name.
 * @param value The actual source value; no clinical interpretation is inferred.
 */
function retainField(url: string, value: unknown): FhirExtension {
  if (typeof value === "string") return { url, valueString: value };
  if (typeof value === "boolean") return { url, valueBoolean: value };
  if (typeof value === "number") return { url, valueDecimal: value };
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : "object";
  const children: FhirExtension[] = [{ url: "kind", valueCode: kind }];
  if (Array.isArray(value)) {
    for (const item of value) children.push(retainField("item", item));
  } else if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      const part = (value as Record<string, unknown>)[key];
      if (part !== undefined) children.push({ url: "field", extension: [
        { url: "name", valueString: key }, retainField("value", part)
      ] });
    }
  }
  return { url, extension: children };
}

/** Read retained fields without evaluating them or reparsing serialized text.
 * @param node One preserved field extension.
 */
function readRetainedField(node: FhirExtension): unknown {
  if (node.valueString !== undefined) return node.valueString;
  if (node.valueBoolean !== undefined) return node.valueBoolean;
  if (node.valueDecimal !== undefined) return node.valueDecimal;
  const children = node.extension ?? [];
  const kind = children.find(child => child.url === "kind")?.valueCode;
  if (kind === "null") return null;
  if (kind === "array") return children.filter(child => child.url === "item").map(readRetainedField);
  const result: Record<string, unknown> = {};
  for (const child of children) {
    if (child.url !== "field") continue;
    const name = child.extension?.find(part => part.url === "name")?.valueString;
    const value = child.extension?.find(part => part.url === "value");
    if (name !== undefined && value) Object.defineProperty(result, name, {
      value: readRetainedField(value), enumerable: true, writable: true, configurable: true
    });
  }
  return result;
}

/** Map a typed object into named FHIR children. Unfamiliar Extension objects are
 * copied intact under their source slot, including their original URLs/types.
 * @param value Source object.
 * @param shape Declared semantic fields for this backbone.
 */
function encodeFields(value: object, shape: BridgeShape): FhirExtension[] {
  const children: FhirExtension[] = [];
  for (const key of Object.keys(value)) {
    const part = (value as Record<string, unknown>)[key];
    if (part === undefined) continue;
    const field = Object.prototype.hasOwnProperty.call(shape, key) ? shape[key] : undefined;
    if (!field) {
      children.push({ url: "retainedField", extension: [
        { url: "name", valueString: key }, retainField("value", part)
      ] });
      continue;
    }
    if (field.repeated && Array.isArray(part) && part.length === 0) {
      children.push({ url: "emptyArray", valueCode: key });
      continue;
    }
    const values = field.repeated && Array.isArray(part) ? part : [part];
    for (const item of values) {
      if (field.extension) {
        children.push({ url: key, extension: [cloneStructuredValue(item as FhirExtension)] });
      } else if (field.fields) {
        children.push({ url: key, extension: encodeFields(item as object, field.fields) });
      } else if (field.quantity) {
        const quantity = item as FhirR6Quantity;
        if (quantity.comparator === "~") {
          const { comparator, ...ordinary } = quantity;
          children.push({ url: key, extension: [
            { url: "quantity", valueQuantity: cloneStructuredValue(ordinary) },
            { url: "comparator", valueCode: comparator }
          ] });
        } else children.push({ url: key, valueQuantity: cloneStructuredValue(quantity) as FhirExtension["valueQuantity"] });
      } else if (field.value) {
        children.push({ url: key, [field.value]: cloneStructuredValue(item) });
      }
    }
  }
  // Empty-but-present metadata remains representable without violating ext-1.
  return children.length ? children : [{ url: "empty", valueBoolean: true }];
}

/** Inverse of the declared extension mapping. No formatter, condition evaluator
 * or grammar is involved; clinical authority stays in the typed source fields.
 * @param children Named extension children.
 * @param shape Declared semantic fields for this backbone.
 */
function decodeFields(children: readonly FhirExtension[], shape: BridgeShape): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const child of children) {
    if (child.url === "empty") continue;
    if (child.url === "emptyArray" && child.valueCode && shape[child.valueCode]?.repeated) {
      result[child.valueCode] = []; continue;
    }
    if (child.url === "retainedField") {
      const name = child.extension?.find(part => part.url === "name")?.valueString;
      const value = child.extension?.find(part => part.url === "value");
      if (name !== undefined && value) Object.defineProperty(result, name, {
        value: readRetainedField(value), enumerable: true, writable: true, configurable: true
      });
      continue;
    }
    const field = Object.prototype.hasOwnProperty.call(shape, child.url) ? shape[child.url] : undefined;
    if (!field) {
      // Unknown bridge children retain their original context as provenance.
      const extensions = (result.extension ??= []) as FhirExtension[];
      extensions.push({ url: "urn:ezmedicationinput:StructureDefinition:medication-unrecognized-bridge-field",
        extension: [cloneStructuredValue(child)] });
      continue;
    }
    let value: unknown;
    if (field.extension) value = child.extension?.[0] && cloneStructuredValue(child.extension[0]);
    else if (field.fields) value = child.extension && decodeFields(child.extension, field.fields);
    else if (field.quantity) {
      value = child.valueQuantity && cloneStructuredValue(child.valueQuantity);
      if (!value && child.extension) {
        const quantity = child.extension.find(part => part.url === "quantity")?.valueQuantity;
        const comparator = child.extension.find(part => part.url === "comparator")?.valueCode;
        if (quantity) value = { ...cloneStructuredValue(quantity), ...(comparator ? { comparator } : {}) };
      }
    } else if (field.value) value = cloneStructuredValue(child[field.value]);
    if (value === undefined) continue;
    if (field.repeated) ((result[child.url] ??= []) as unknown[]).push(value);
    else result[child.url] = value;
  }
  return result;
}

/** Recover a course from a structured extension, leaving malformed originals
 * with the caller for preservation. No string payload is interpreted here.
 * @param node The dosageDetails extension child.
 */
function decodeCourseDetails(node: FhirExtension): FhirR6DosageDetails | undefined {
  if (!node.extension || node.valueString !== undefined) return undefined;
  const value = decodeFields(node.extension, COURSE);
  if (!Array.isArray(value.step) || !value.step.every(step =>
    step && typeof step === "object" && Array.isArray(step.component))) return undefined;
  return { ...value, step: value.step } as FhirR6DosageDetails;
}

/** Encode a Boolean predicate with explicit all/any/not child relationships.
 * @param condition Typed predicate supplied by the HPSG or external API.
 */
function encodeConditionPredicate(condition: MedicationCondition): FhirExtension {
  return { url: "predicate", extension: encodeFields(condition, PREDICATE) };
}

/** Decode structural predicate fields; the caller checks the small predicate
 * union before using them as meaning and preserves unfamiliar input unchanged.
 * @param node The predicate child extension.
 */
function decodeConditionPredicate(node: FhirExtension): unknown {
  return node.extension && node.valueString === undefined ? decodeFields(node.extension, PREDICATE) : undefined;
}

/** Preserve unmatched step metadata as structured source, not JSON text.
 * @param step Original editable course-step metadata.
 */
function encodeCourseStepSource(step: EzCourseStep): FhirExtension[] {
  return encodeFields(step, COURSE_STEP);
}
