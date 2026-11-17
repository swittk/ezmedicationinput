import {courseFromR5} from "./adapters/r5-import";
import {courseFromR6,courseToR6,administrationFromR6,administrationToR5} from "./adapters/canonical-course";
import {projectNativeR5Course} from "./adapters/r5-course";
/** FHIR R5/R6 bridging uses typed extension children exclusively. Source,
 * course, condition and edit metadata remain structured and independently editable. */
import { cloneStructuredValue, equalStructuredValues } from "./stable-structure";
import {
  getEmaQuantityComparator, quantityFromR5, quantityForR5 as generalQuantityForR5,
  simpleQuantityForR5
} from "./fhir-quantity-operator";
import {
  FhirDayOfWeek, FhirDosage, FhirDoseAndRate, FhirTimingRepeat, FhirExtension, FhirQuantity, FhirSimpleQuantity, FhirRatio, FhirR6Dosage, FhirR6DosageCondition,
  FhirR6DosageInstruction,
  FhirR6DosageStep, FhirR6DosageInstructionInput, FhirR6DosageSafety,
  FhirR6DoseLimit, FhirR6Quantity, FhirR6TimingRepeat,
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
export const DOSAGE_RECONCILIATION_SOURCE_URL =
  "urn:ezmedicationinput:StructureDefinition:medication-course-reconciliation-source";
export const DOSAGE_RETAINED_R5_SEQUENCE_URL =
  "urn:ezmedicationinput:StructureDefinition:medication-retained-r5-sequence";
const DOSAGE_RETAINED_COURSE_STEP_URL =
  "urn:ezmedicationinput:StructureDefinition:medication-retained-course-step";
/** An R5-only per-step modifier is not legal on the R6 Element-valued
 * DosageInstruction.step. Carry it through an ordinary R6 extension instead. */
const R5_STEP_MODIFIERS_R6_URL =
  "urn:ezmedicationinput:StructureDefinition:r5-step-modifier-extensions";
/** R6 doseAndRate is Element. Preserve any older R5-local metadata in the
 * Element.extension slot without emitting illegal modifierExtension keys. */
export const R5_RATE_MODIFIERS_R6_URL =
  "urn:ezmedicationinput:StructureDefinition:r5-dose-and-rate-modifier-extensions";

export function r6StepMetadata(step: Partial<EzCourseStep>): Omit<FhirR6DosageInstruction["step"][number], "component"> {
  const { sequence: _sequence, modifierExtension, extension, ...fields } = step;
  // R5's current modifier value supersedes any older embedded R6 wrapper.
  // A single wrapper can own this field; unrelated extensions stay intact.
  const existing = extension?.find(item => item.url === R5_STEP_MODIFIERS_R6_URL);
  const modifiers = modifierExtension ?? existing?.extension;
  const native = extension?.filter(item => item.url !== R5_STEP_MODIFIERS_R6_URL) ?? [];
  const extensions = modifiers?.length
    ? [...native, { url: R5_STEP_MODIFIERS_R6_URL, extension: modifiers }] : native;
  // Empty arrays are explicit edits, not missing metadata. Omitting them
  // here lets the retained step bring a cleared extension back to life.
  return { ...fields, ...(extensions.length || extension !== undefined ||
    modifierExtension !== undefined ? { extension: extensions } : {}) };
}

export function r5StepMetadata(step: Omit<FhirR6DosageInstruction["step"][number], "component">):
  Omit<EzCourseStep, "sequence"> {
  const { extension, ...fields } = step;
  let retained: FhirExtension | undefined;
  let extensions: FhirExtension[] | undefined;
  for (const item of extension ?? []) {
    if (item.url === R5_STEP_MODIFIERS_R6_URL) {
      if (!retained) retained = item;
    } else (extensions ??= []).push(item);
  }
  return {
    ...fields,
    ...(extensions?.length ? { extension: extensions } : {}),
    ...(retained?.extension?.length ? { modifierExtension: retained.extension } : {})
  };
}

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
  let fields:FhirExtension[]|undefined;
  for(const marker of dosage.modifierExtension??[])if(marker.url===DOSAGE_ALTERNATIVE_CHOICE_URL){fields=marker.extension;break;}
  if(!fields)return undefined;
  let groupId:string|undefined,branchId:string|undefined,behavior:string|undefined,seen=0;
  for(const field of fields)switch(field.url){
    case "groupId":if(!(seen&1)){seen|=1;groupId=field.valueString;}break;
    case "branchId":if(!(seen&2)){seen|=2;branchId=field.valueString;}break;
    case "selectionBehavior":if(!(seen&4)){seen|=4;behavior=field.valueCode;}break;
  }
  return groupId&&branchId&&behavior==="exactly-one"
    ?{groupId,branchId,selectionBehavior:behavior}:undefined;
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
  const prior=dosage.modifierExtension;
  if(!prior?.length){dosage.modifierExtension=value?[value]:undefined;return;}
  const result:FhirExtension[]=[];
  for(const extension of prior)if(extension.url!==url)result.push(extension);
  if(value)result.push(value);
  dosage.modifierExtension=result.length?result:undefined;
}

const CONDITION_FIELDS={
  measurement:new Set(["kind","name","operation","value","unit","text"]),
  state:new Set(["kind","name","text","expected"]),
  text:new Set(["kind","text"]),
  not:new Set(["kind","condition"]),
  multiple:new Set(["kind","conditions"])
};
function hasOnlyKeys(candidate:Record<string,unknown>,allowed:ReadonlySet<string>):boolean {
  for(const key in candidate)if(!allowed.has(key)&&Object.prototype.hasOwnProperty.call(candidate,key))return false;
  return true;
}

function isMedicationCondition(value: unknown, depth = 0): value is MedicationCondition {
  if (depth > 64 || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  switch (candidate.kind) {
    case "measurement":
      return hasOnlyKeys(candidate, CONDITION_FIELDS.measurement) &&
        typeof candidate.name === "string" && candidate.name.length > 0 &&
        (candidate.operation==="gt"||candidate.operation==="ge"||candidate.operation==="lt"||
          candidate.operation==="le"||candidate.operation==="eq"||candidate.operation==="ne") &&
        typeof candidate.value === "number" && Number.isFinite(candidate.value) &&
        (candidate.unit === undefined || typeof candidate.unit === "string") &&
        typeof candidate.text === "string" && candidate.text.length > 0;
    case "state":
      return hasOnlyKeys(candidate, CONDITION_FIELDS.state) &&
        typeof candidate.name === "string" && candidate.name.length > 0 &&
        typeof candidate.text === "string" && candidate.text.length > 0 &&
        typeof candidate.expected === "boolean";
    case "text":
      return hasOnlyKeys(candidate, CONDITION_FIELDS.text) &&
        typeof candidate.text === "string" && candidate.text.length > 0;
    case "not":
      return hasOnlyKeys(candidate, CONDITION_FIELDS.not) &&
        isMedicationCondition(candidate.condition, depth + 1);
    case "all": case "any":
      return hasOnlyKeys(candidate, CONDITION_FIELDS.multiple) &&
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

/** Fast decoder for the ordinary typed leaf predicates emitted by this
 * codec. It reads each named field once, preserving last-defined-value
 * semantics. Composite or foreign field shapes use the existing complete
 * codec below; no input text is interpreted here and no information is lost. */
function ordinaryConditionLeaf(node:FhirExtension):MedicationCondition|undefined {
  if(!node.extension||node.valueString!==undefined)return undefined;
  let kind:string|undefined,name:string|undefined,operation:string|undefined,
    value:number|undefined,unit:string|undefined,text:string|undefined,expected:boolean|undefined;
  let supplied=0;
  for(const field of node.extension)switch(field.url){
    case "kind":if(field.valueCode!==undefined)kind=field.valueCode;break;
    case "name":if(field.valueString!==undefined){name=field.valueString;supplied|=1;}break;
    case "operation":if(field.valueCode!==undefined){operation=field.valueCode;supplied|=2;}break;
    case "value":if(field.valueDecimal!==undefined){value=field.valueDecimal;supplied|=4;}break;
    case "unit":if(field.valueString!==undefined){unit=field.valueString;supplied|=8;}break;
    case "text":if(field.valueString!==undefined)text=field.valueString;break;
    case "expected":if(field.valueBoolean!==undefined){expected=field.valueBoolean;supplied|=16;}break;
    case "empty":break;
    default:return undefined;
  }
  if(typeof text!=="string"||!text.length)return undefined;
  if(kind==="text"&&!supplied)return {kind,text};
  if(typeof name!=="string"||!name.length)return undefined;
  if(kind==="state"&&!(supplied&14)&&typeof expected==="boolean")return {kind,name,text,expected};
  if(kind==="measurement"&&!(supplied&16)&&typeof value==="number"&&Number.isFinite(value)&&
    (unit===undefined||typeof unit==="string")&&
    (operation==="gt"||operation==="ge"||operation==="lt"||operation==="le"||operation==="eq"||operation==="ne")){
    const result:Extract<MedicationCondition,{kind:"measurement"}>={kind,name,operation,value,text};
    // Avoid ES6 spread-descriptor helpers for one optional scalar field.
    if(unit!==undefined)result.unit=unit;
    return result;
  }
  return undefined;
}

function parseConditionModifier(extension: FhirExtension): MedicationCondition | undefined {
  // Read/edit paths are intentionally tolerant. The complete extension stays
  // on the dosage, while the first usable predicate supplies a suggestion.
  for (const predicate of extension.extension ?? []) {
    if (predicate.url !== "predicate") continue;
    const leaf=ordinaryConditionLeaf(predicate);
    if(leaf)return leaf;
    const value = decodeConditionPredicate(predicate);
    if (isMedicationCondition(value)) return value;
  }
  return undefined;
}

export function isExactConditionBridge(extension: FhirExtension): boolean {
  const predicate = parseConditionModifier(extension);
  return predicate !== undefined && valueKeys(extension).length === 0 &&
    equalStructuredValues(extension.extension, [encodeConditionPredicate(predicate)]);
}

export function assertUnderstoodDosageModifiers(_dosage: FhirDosage | EzDosage): void {
  // Compatibility API. Unknown modifier semantics remain attached for editing.
}

function parseDosageCondition(dosage: Pick<FhirDosage,"modifierExtension"> & {condition?:FhirR6DosageCondition[]}): MedicationCondition | undefined {
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

export function getDosageCondition(dosage: Pick<FhirDosage,"modifierExtension"> & {condition?:FhirR6DosageCondition[]}): MedicationCondition | undefined {
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

export function conditionToR6(condition: MedicationCondition): FhirR6DosageCondition {
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
      scope: "period", valueQuantity: quantityFromR5(maximum.numerator)!,
      period: quantityFromR5(maximum.denominator)
    });
  }
  if (dosage.maxDosePerAdministration) {
    doseLimit.push({ scope: "administration",
      valueQuantity: quantityFromR5(dosage.maxDosePerAdministration)! });
  }
  if (dosage.maxDosePerLifetime) {
    doseLimit.push({ scope: "lifetime",
      valueQuantity: quantityFromR5(dosage.maxDosePerLifetime)! });
  }
  return doseLimit.length ? { doseLimit } : undefined;
}

function isR5RepresentableSafetyLimit(limit: FhirR6DoseLimit): boolean {
  const quantity = limit.valueQuantity;
  if (!quantity) return false;
  if (limit.scope === "period") return Boolean(limit.period);
  return limit.scope === "administration" || limit.scope === "lifetime";
}

/** Exactly the original limit positions emitted by fromR6Dosage's R5
 * fields. Period maxima are an array; administration/lifetime maxima are
 * singular, so only the LAST eligible member of those scopes is editable
 * through the R5 projection. All others remain active R6-only siblings. */
function r5ProjectedSafetyLimitIndices(limits: readonly FhirR6DoseLimit[]): Set<number> {
  const indices = new Set<number>();
  let administration: number | undefined;
  let lifetime: number | undefined;
  for (let index = 0; index < limits.length; index++) {
    const limit = limits[index];
    if (!isR5RepresentableSafetyLimit(limit)) continue;
    if (limit.scope === "period") indices.add(index);
    else if (limit.scope === "administration") administration = index;
    else if (limit.scope === "lifetime") lifetime = index;
  }
  if (administration !== undefined) indices.add(administration);
  if (lifetime !== undefined) indices.add(lifetime);
  return indices;
}

/**
 * Apply edits made through R5 maximum-dose fields without discarding safety
 * semantics that R5 cannot carry. Existing backbone metadata stays attached
 * to the corresponding representable scope; expression/integer limits and
 * the safety-level exceeded action remain byte-for-byte authoritative.
 */
export function reconcileR5SafetyEdits(
  retained: FhirR6DosageSafety,
  projected: FhirR6DosageSafety | undefined
): FhirR6DosageSafety | undefined {
  const oldLimits = retained.doseLimit ?? [];
  const live = projected?.doseLimit ?? [];
  // A scope is NOT an identity: several per-period limits can coexist.
  // Match a uniquely surviving amount + period first; then one remaining
  // member of the same scope (an ordinary numeric edit). Deletions and
  // ambiguous equal-valued rows never inherit arbitrary unknown metadata.
  const projectedIndices = r5ProjectedSafetyLimitIndices(oldLimits);
  const representable = oldLimits.map((_, index) => projectedIndices.has(index));
  const signature = (limit: FhirR6DoseLimit) =>
    compactProjectionFingerprint({
      scope: limit.scope, valueQuantity: limit.valueQuantity, period: limit.period
    });
  const oldKeys = new Map<string, number>();
  const liveKeys = new Map<string, number>();
  const indexKeys = (items: readonly FhirR6DoseLimit[], keys: Map<string, number>,
    allowed?: readonly boolean[]) => {
    items.forEach((limit, index) => {
      if (allowed && !allowed[index]) return;
      const key = signature(limit);
      keys.set(key, keys.has(key) ? -1 : index);
    });
  };
  indexKeys(oldLimits, oldKeys, representable);
  indexKeys(live, liveKeys);
  const matched = new Map<number, number>();
  const usedOld = new Set<number>();
  for (const [key, oldIndex] of oldKeys) {
    const liveIndex = liveKeys.get(key);
    if (oldIndex < 0 || liveIndex === undefined || liveIndex < 0) continue;
    matched.set(liveIndex, oldIndex);
    usedOld.add(oldIndex);
  }
  const oldByScope = new Map<string, number[]>();
  const liveByScope = new Map<string, number[]>();
  oldLimits.forEach((limit, index) => {
    if (!representable[index] || usedOld.has(index)) return;
    const values = oldByScope.get(limit.scope) ?? [];
    values.push(index); oldByScope.set(limit.scope, values);
  });
  live.forEach((limit, index) => {
    if (matched.has(index)) return;
    const values = liveByScope.get(limit.scope) ?? [];
    values.push(index); liveByScope.set(limit.scope, values);
  });
  const sameUnit = (
    original: FhirR6Quantity | undefined,
    replacement: FhirR6Quantity | undefined
  ) => !!original && !!replacement &&
    original.unit === replacement.unit &&
    original.code === replacement.code &&
    original.system === replacement.system;
  for (const [scope, oldIndices] of oldByScope) {
    const liveIndices = liveByScope.get(scope);
    if (oldIndices.length !== 1 || liveIndices?.length !== 1) continue;
    const original = oldLimits[oldIndices[0]];
    const candidate = live[liveIndices[0]];
    // Unmatched cardinality alone is not identity: deleting 5 mg/day and
    // adding 5 mL/30 days must NOT transfer the old ID or extension.
    // A numeric edit retains the same units and period window.
    if (!sameUnit(original.valueQuantity, candidate.valueQuantity) ||
        (original.period || candidate.period) &&
        (!sameUnit(original.period, candidate.period) ||
          original.period?.value !== candidate.period?.value)) continue;
    matched.set(liveIndices[0], oldIndices[0]);
    usedOld.add(oldIndices[0]);
  }
  const liveLimits: FhirR6DoseLimit[] = live.map((replacement, index) => {
    const oldIndex = matched.get(index);
    if (oldIndex === undefined) return replacement;
    const original = oldLimits[oldIndex];
    const {
      scope: _scope, period: _period,
      valueQuantity: _quantity, valueInteger: _integer,
      valueExpression: _expression, ...metadata
    } = original;
    return { ...metadata, ...replacement } as FhirR6DoseLimit;
  });
  // R5 singular maxima own the LAST representable item of their scope.
  // Hidden R6 siblings must be placed BEFORE the current R5-owned maximum,
  // or an immediate re-export would expose a different limit and invert
  // ownership again. Array-valued period limits retain the live R5 order.
  const hiddenByScope = new Map<string, FhirR6DoseLimit[]>();
  const remainingHidden: FhirR6DoseLimit[] = [];
  oldLimits.forEach((limit, index) => {
    if (representable[index]) return;
    if (limit.scope === "administration" || limit.scope === "lifetime") {
      const hidden = hiddenByScope.get(limit.scope) ?? [];
      hidden.push(limit); hiddenByScope.set(limit.scope, hidden);
    } else remainingHidden.push(limit);
  });
  const lastLive = new Map<string, number>();
  liveLimits.forEach((limit, index) => {
    if ((limit.scope === "administration" || limit.scope === "lifetime") &&
        limit.valueQuantity) lastLive.set(limit.scope, index);
  });
  const doseLimit: FhirR6DoseLimit[] = [];
  liveLimits.forEach((limit, index) => {
    if (lastLive.get(limit.scope) === index) {
      doseLimit.push(...(hiddenByScope.get(limit.scope) ?? []));
      hiddenByScope.delete(limit.scope);
    }
    doseLimit.push(limit);
  });
  for (const hidden of hiddenByScope.values()) doseLimit.push(...hidden);
  doseLimit.push(...remainingHidden);
  const { doseLimit: _retainedLimits, ...retainedSafety } = retained;
  if (doseLimit.length) return { ...retainedSafety, doseLimit };
  return Object.keys(retainedSafety).length ? retainedSafety : undefined;
}

/** Lift real R6 concepts once into the familiar flat R5 dosage shape. */
export function toEzDosages(dosages:readonly(FhirDosage|EzDosage)[]):EzDosage[] {
  let result:EzDosage[]|undefined;
  for(let index=0;index<dosages.length;index++){
    const input=dosages[index] as EzDosage;
    let conditionMarker=false,dateMarker=false;
    if(input.condition===undefined||input.excludedDates===undefined)
      for(const e of input.modifierExtension??[]){
        if(e.url===DOSAGE_CONDITION_R5_URL)conditionMarker=true;
        else if(e.url===DOSAGE_EXCLUDED_DATES_R5_URL)dateMarker=true;
      }
    const needsCondition=input.condition===undefined&&conditionMarker;
    const needsDates=input.excludedDates===undefined&&dateMarker;
    const needsSafety=!input.safety&&Boolean(input.maxDosePerPeriod?.length||input.maxDosePerAdministration||input.maxDosePerLifetime);
    if(!needsCondition&&!needsDates&&!needsSafety){if(result)result.push(input);continue;}
    const predicate=needsCondition?parseDosageCondition(input):undefined;
    const safety=needsSafety?toR6Safety(input):undefined;
    const dates=needsDates?getDosageExcludedDates(input):undefined;
    if(!result)result=dosages.slice(0,index);
    const row:EzDosage=Object.assign({},input);
    if(predicate)row.condition=[conditionToR6(predicate)];
    if(safety)row.safety=safety;if(dates?.length)row.excludedDates=dates;
    result.push(row);
  }
  return result??dosages as EzDosage[];
}

export function isRenderedInstructionMarker(extension:FhirExtension):boolean {
  if(extension.url!==DOSAGE_RENDERED_INSTRUCTION_R5_URL)return false;
  let instruction=false,rows=0;
  for(const child of extension.extension??[]){
    if(child.url==="instruction"&&typeof child.valueString==="string")instruction=true;
    else if(child.url==="row"){
      rows++;let projection=false,text=false;
      for(const part of child.extension??[]){
        if(part.url==="projectionFingerprint"&&typeof part.valueString==="string")projection=true;
        else if(part.url==="textFingerprint"&&typeof part.valueString==="string")text=true;
      }
      if(!projection||!text)return false;
    }
  }
  return instruction&&rows>0;
}

/** Metadata not understood by this reader stays as structured source instead
 * of disappearing when the editable baseline happens to be unchanged.
 * @param marker The source edit-provenance extension.
 */
function hasOtherOwnField(value:FhirExtension,second:"extension"|"valueString"):boolean {
  for(const key in value)if(key!=="url"&&key!==second&&Object.prototype.hasOwnProperty.call(value,key))return true;
  return false;
}
export function hasUnrecognizedEditMetadata(marker:FhirExtension):boolean {
  if(hasOtherOwnField(marker,"extension"))return true;
  for(const field of marker.extension??[]){
    if(field.url==="instruction"){if(hasOtherOwnField(field,"valueString"))return true;continue;}
    if(field.url!=="row"||hasOtherOwnField(field,"extension"))return true;
    for(const part of field.extension??[])
      if((part.url!=="projectionFingerprint"&&part.url!=="textFingerprint")||hasOtherOwnField(part,"valueString"))return true;
  }
  return false;
}

/** R6 Ratio numerators are regular Quantity: preserve the numeric rate,
 * translate "~" into EMA Coding, and reconcile enriched EMA on native edits. */
function ratioForR5(
  ratio: NonNullable<FhirR6Dosage["doseAndRate"]>[number]["rateRatio"]
): FhirRatio | undefined {
  if (!ratio?.numerator) return ratio as FhirRatio | undefined;
  const projected = generalQuantityForR5(ratio.numerator);
  return projected === ratio.numerator ? ratio as FhirRatio :
    { ...ratio, numerator: projected };
}

/** Project one R6 component without building course-storage metadata. Used by
 * both strict exports and read-only rendering; source objects are not mutated.
 * @param dosage Native R6 component.
 * @param sequence Ordered global course step for its R5 projection.
 */
export function fromR6Dosage(dosage:FhirR6Dosage,sequence:number):FhirDosage {
  return administrationToR5(administrationFromR6(dosage),sequence);
}

/** A text-only course's latest full marker may already embed previous
 * reconciliation sources. Keep those sources in their existing flat list,
 * and preserve only the immediate preceding course snapshot as a new item.
 * This strips solely the nested source-history wrapper at the known course
 * top level; it retains unknown fields, safety, warnings and other extensions. */
export function sourceWithoutNestedHistory(marker: FhirExtension): FhirExtension {
  let changed = false;
  const extensions = marker.extension?.map(item => {
    if (item.url !== "dosageDetails" || !item.extension) return item;
    const fields = item.extension.filter(field => {
      const nestedSource = field.url === "extension" && field.extension?.length === 1 &&
        field.extension[0].url === DOSAGE_RECONCILIATION_SOURCE_URL;
      if (nestedSource) changed = true;
      return !nestedSource;
    });
    return fields.length === item.extension.length ? item : { ...item, extension: fields };
  });
  return changed ? { ...marker, extension: extensions } : marker;
}

/** Preserve unmatched step metadata in its original typed extension structure.
 * @param step Source step that could not be matched to a live dosage.
 */
export function retainedCourseStepSource(
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

export function equivalentProjection(
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
export function liveDosageProjection(
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
  let first=state.first,second=state.second;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
    second ^= second >>> 13;
  }
  state.first=first;state.second=second;
}

function projectionFingerprintValue(
  state: ProjectionFingerprintState,
  value: unknown,
  context: "general" | "coding-list" | "coding-item" = "general",
  mode: "baseline" | "match" | "exact" = "baseline"
): void {
  if (value === null) {
    updateProjectionFingerprint(state, "null;");
    return;
  }
  if (Array.isArray(value)) {
    updateProjectionFingerprint(state, "[");
    const childContext = context === "coding-list" ? "coding-item" : "general";
    for (const part of value) projectionFingerprintValue(state, part, childContext,mode);
    updateProjectionFingerprint(state, "]");
    return;
  }
  if (typeof value === "object") {
    updateProjectionFingerprint(state, "{");
    const record = value as Record<string, unknown>;
    const keys=Object.keys(record);
    // Most typed FHIR extension/quantity nodes have one to three fields.
    // Preserve identical lexical hash order without invoking a generic sort
    // for every tiny child of a retained course.
    if(keys.length===2){if(keys[0]>keys[1]){const first=keys[0];keys[0]=keys[1];keys[1]=first;}}
    else if(keys.length===3){
      if(keys[0]>keys[1]){const first=keys[0];keys[0]=keys[1];keys[1]=first;}
      if(keys[1]>keys[2]){const second=keys[1];keys[1]=keys[2];keys[2]=second;}
      if(keys[0]>keys[1]){const first=keys[0];keys[0]=keys[1];keys[1]=first;}
    }else if(keys.length>3)keys.sort();
    for (const key of keys) {
      const part = record[key];
      if (part === undefined || Array.isArray(part) && part.length === 0) continue;
      // Validator-added coding versions do not alter an instruction. This is
      // the same tolerated metadata class as the legacy exact comparator.
      if (context === "coding-item" && mode!=="exact" && (key === "version" || mode==="match"&&key==="system")) continue;
      updateProjectionFingerprint(state, key.length + ":" + key);
      projectionFingerprintValue(state, part,
        key === "coding" ? "coding-list" : "general",mode);
    }
    updateProjectionFingerprint(state, "}");
    return;
  }
  const primitive = String(value);
  updateProjectionFingerprint(state, typeof value + primitive.length + ":" + primitive + ";");
}

// Exact persisted hashes use eight bytes. Reuse their hexadecimal digits
// rather than allocate/pad/slice two numeric strings for every row fingerprint.
const FINGERPRINT_HEX:string[]=[];
for(let value=0;value<256;value++){
  const hex=value.toString(16);FINGERPRINT_HEX.push(value<16?"0"+hex:hex);
}
function finishProjectionFingerprint(state:ProjectionFingerprintState):string {
  const a=state.first,b=state.second;
  return FINGERPRINT_HEX[a>>>24]+FINGERPRINT_HEX[(a>>>16)&255]+
    FINGERPRINT_HEX[(a>>>8)&255]+FINGERPRINT_HEX[a&255]+
    FINGERPRINT_HEX[b>>>24]+FINGERPRINT_HEX[(b>>>16)&255]+
    FINGERPRINT_HEX[(b>>>8)&255]+FINGERPRINT_HEX[b&255];
}

export function compactProjectionFingerprint(value: unknown): string {
  const state = { first: 0x811c9dc5, second: 0x9e3779b9 };
  projectionFingerprintValue(state, value);
  return finishProjectionFingerprint(state);
}

/** Matching keys narrow candidates; exact equivalence is checked before
 * claiming identity. Added Coding.system/version annotations do not force
 * every edited row to rescan every original row. Existing baseline hashes
 * remain byte-for-byte unchanged. */
export function matchingProjectionFingerprint(value:unknown):string {
  const state={first:0x811c9dc5,second:0x9e3779b9};
  projectionFingerprintValue(state,value,"general","match");return finishProjectionFingerprint(state);
}
function exactProjectionFingerprint(value:unknown):string {
  const state={first:0x811c9dc5,second:0x9e3779b9};
  projectionFingerprintValue(state,value,"general","exact");return finishProjectionFingerprint(state);
}

const LIVE_COURSE_ROW_KEYS=new Set(["sequence","stepCount","step","component","context","contextRequired","course","emptyStep","missingContext"]);
/** Hash the current editable clinical view without allocating a stripped
 * dosage tree on every call. Retained edit baselines themselves are excluded;
 * active local row fields and all unrelated source annotations remain hashed.
 * The exact token order is identical to compactProjectionFingerprint so
 * existing persisted edit identities require no migration. */
export function dosageProjectionFingerprint(dosage:FhirDosage|EzDosage):string {
  const state:ProjectionFingerprintState={first:0x811c9dc5,second:0x9e3779b9};
  const record=dosage as Record<string,unknown>;
  const keys=Object.keys(dosage).sort();
  updateProjectionFingerprint(state,"{");
  for(const key of keys){
    if(key==="text")continue;
    const part=record[key];
    if(part===undefined||Array.isArray(part)&&!part.length)continue;
    if(key==="extension"){
      let opened=false;
      for(const item of dosage.extension??[]){
        if(item.url===DOSAGE_RENDERED_INSTRUCTION_R5_URL)continue;
        if(!opened){updateProjectionFingerprint(state,key.length+":"+key);updateProjectionFingerprint(state,"[");opened=true;}
        projectionFingerprintValue(state,item);
      }
      if(opened)updateProjectionFingerprint(state,"]");
      continue;
    }
    if(key==="modifierExtension"){
      let opened=false;
      for(const item of dosage.modifierExtension??[]){
        if(item.url!==DOSAGE_DETAILS_R5_URL){
          if(!opened){updateProjectionFingerprint(state,key.length+":"+key);updateProjectionFingerprint(state,"[");opened=true;}
          projectionFingerprintValue(state,item);continue;
        }
        let local=false,fieldCount=0;
        for(const child of item.extension??[]){
          if(child.url==="rowIndex")local=true;
          if(LIVE_COURSE_ROW_KEYS.has(child.url))fieldCount++;
        }
        if(!local)continue;
        if(!opened){updateProjectionFingerprint(state,key.length+":"+key);updateProjectionFingerprint(state,"[");opened=true;}
        updateProjectionFingerprint(state,"{");
        for(const name of Object.keys(item).sort()){
          const value=item[name as keyof FhirExtension];
          if(name==="extension"){
            if(!fieldCount)continue;
            updateProjectionFingerprint(state,name.length+":"+name);updateProjectionFingerprint(state,"[");
            for(const child of item.extension??[])if(LIVE_COURSE_ROW_KEYS.has(child.url))projectionFingerprintValue(state,child);
            updateProjectionFingerprint(state,"]");
          }else if(value!==undefined&&!(Array.isArray(value)&&value.length===0)){
            updateProjectionFingerprint(state,name.length+":"+name);
            projectionFingerprintValue(state,value,name==="coding"?"coding-list":"general");
          }
        }
        updateProjectionFingerprint(state,"}");
      }
      if(opened)updateProjectionFingerprint(state,"]");
      continue;
    }
    updateProjectionFingerprint(state,key.length+":"+key);
    projectionFingerprintValue(state,part,key==="coding"?"coding-list":"general");
  }
  updateProjectionFingerprint(state,"}");
  return finishProjectionFingerprint(state);
}

/** A verified *source-replay proof*, not a cached clinical interpretation.
 *
 * The first encounter checks the existing persisted, full-row edit fingerprint.
 * Later calls over the SAME object need not recursively hash the large,
 * unchanged provenance graph. Shallow FHIR ownership changes and live dosage
 * amount values still invalidate the proof; in particular a clinician editing
 * doseQuantity.value on a previously formatted R5 row cannot replay an old
 * HPSG-owned instruction.
 *
 * The externally supplied object/provenance graph is immutable by caller
 * contract. Mutating an internal nested graph extension in place is a caller
 * footgun; adding deep defensive rescans to every format invocation would
 * violate the project's throughput contract.
 */
interface SourceDoseObservation {
  original: FhirDoseAndRate;
  dose?: FhirSimpleQuantity;
  doseValue?: number;
  doseUnit?: string;
  doseCode?: string;
  rate?: FhirSimpleQuantity;
  rateValue?: number;
  rateUnit?: string;
  rateCode?: string;
  range?: FhirDoseAndRate["doseRange"];
  rangeLow?: number;
  rangeHigh?: number;
  ratio?: FhirRatio;
  ratioNumerator?: number;
  ratioDenominator?: number;
}
interface SourceReplayProof {
  matches: boolean;
  top: Array<[string, unknown]>;
  amounts: SourceDoseObservation[];
  repeat?: FhirTimingRepeat;
  frequency?: number;
  period?: number;
  count?: number;
  timeOfDayCount?: number;
  firstClock?: string;
}
const SOURCE_REPLAY_PROOFS = new WeakMap<FhirDosage | EzDosage, SourceReplayProof>();

function capturedReplayProof(dosage: FhirDosage | EzDosage, matches: boolean): SourceReplayProof {
  const raw = dosage as Record<string, unknown>;
  const top: SourceReplayProof["top"] = [];
  for (const key of Object.keys(dosage)) top.push([key, raw[key]]);
  const amounts: SourceDoseObservation[] = [];
  for (const original of dosage.doseAndRate ?? []) {
    const dose = original.doseQuantity,
      rate = original.rateQuantity;
    amounts.push({
      original,
      dose,
      doseValue: dose?.value,
      doseUnit: dose?.unit,
      doseCode: dose?.code,
      rate,
      rateValue: rate?.value,
      rateUnit: rate?.unit,
      rateCode: rate?.code,
      range: original.doseRange,
      rangeLow: original.doseRange?.low?.value,
      rangeHigh: original.doseRange?.high?.value,
      ratio: original.rateRatio,
      ratioNumerator: original.rateRatio?.numerator?.value,
      ratioDenominator: original.rateRatio?.denominator?.value,
    });
  }
  const repeat = dosage.timing?.repeat;
  return {
    matches,
    top,
    amounts,
    repeat,
    frequency: repeat?.frequency,
    period: repeat?.period,
    count: repeat?.count,
    timeOfDayCount: repeat?.timeOfDay?.length,
    firstClock: repeat?.timeOfDay?.[0],
  };
}
function unchangedReplayProof(dosage: FhirDosage | EzDosage, proof: SourceReplayProof): boolean {
  const raw = dosage as Record<string, unknown>;
  let ownCount = 0;
  for (const key in raw) if (Object.prototype.hasOwnProperty.call(raw, key)) ownCount++;
  if (ownCount !== proof.top.length) return false;
  for (const [key, value] of proof.top) if (raw[key] !== value) return false;
  const rows = dosage.doseAndRate;
  if ((rows?.length ?? 0) !== proof.amounts.length) return false;
  for (let index = 0; index < proof.amounts.length; index++) {
    const prior = proof.amounts[index],
      row = rows![index];
    if (
      row !== prior.original ||
      row.doseQuantity !== prior.dose ||
      row.doseQuantity?.value !== prior.doseValue ||
      row.doseQuantity?.unit !== prior.doseUnit ||
      row.doseQuantity?.code !== prior.doseCode ||
      row.rateQuantity !== prior.rate ||
      row.rateQuantity?.value !== prior.rateValue ||
      row.rateQuantity?.unit !== prior.rateUnit ||
      row.rateQuantity?.code !== prior.rateCode ||
      row.doseRange !== prior.range ||
      row.doseRange?.low?.value !== prior.rangeLow ||
      row.doseRange?.high?.value !== prior.rangeHigh ||
      row.rateRatio !== prior.ratio ||
      row.rateRatio?.numerator?.value !== prior.ratioNumerator ||
      row.rateRatio?.denominator?.value !== prior.ratioDenominator
    )
      return false;
  }
  const repeat = dosage.timing?.repeat;
  return (
    repeat === proof.repeat &&
    repeat?.frequency === proof.frequency &&
    repeat?.period === proof.period &&
    repeat?.count === proof.count &&
    repeat?.timeOfDay?.length === proof.timeOfDayCount &&
    repeat?.timeOfDay?.[0] === proof.firstClock
  );
}

/** Verify a saved editable R5 row's source clinical authority at most once
 * for an unchanged object. No always-on full graph hash or normalized render. */
export function dosageMatchesSavedProjection(dosage: FhirDosage | EzDosage): boolean {
  const cached = SOURCE_REPLAY_PROOFS.get(dosage);
  if (cached && unchangedReplayProof(dosage, cached)) return cached.matches;
  for (const marker of dosage.extension ?? []) {
    if (marker.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL) continue;
    for (const row of marker.extension ?? []) {
      if (row.url !== "row") continue;
      for (const field of row.extension ?? [])
        if (field.url === "projectionFingerprint") {
          const matches = field.valueString === dosageProjectionFingerprint(dosage);
          SOURCE_REPLAY_PROOFS.set(dosage, capturedReplayProof(dosage, matches));
          return matches;
        }
      return false;
    }
  }
  return false;
}

export function dosageTextFingerprint(dosage: FhirDosage | EzDosage): string {
  return compactProjectionFingerprint(dosage.text ?? null);
}

/**
 * Attach source/display provenance using repeated, structured row extensions.
 * Both primary parser output and strict R5 export use this same representation.
 * @param dosages Independently editable rows being returned to the caller.
 * @param instruction The author's unmodified instruction.
 */
export function withDosageEditProvenance<T extends FhirDosage|EzDosage>(dosages:readonly T[],instruction:string):T[] {
  if(!dosages.length)return [];
  const children:FhirExtension[]=[{url:"instruction",valueString:instruction}];
  const result:T[]=new Array(dosages.length);
  for(let i=0;i<dosages.length;i++){
    const row=dosages[i];result[i]=row;
    children.push({url:"row",extension:[
      {url:"projectionFingerprint",valueString:dosageProjectionFingerprint(row)},
      {url:"textFingerprint",valueString:dosageTextFingerprint(row)}]});
  }
  const extension:FhirExtension[]=[];
  for(const e of dosages[0].extension??[])if(!isRenderedInstructionMarker(e))extension.push(e);
  extension.push({url:DOSAGE_RENDERED_INSTRUCTION_R5_URL,extension:children});
  result[0]=Object.assign({},dosages[0],{extension});
  return result;
}

/** R6 imports follow the *current* DosageInstruction contract, not historical
 * drafts. This runs only at the R6 import boundary, never on ordinary SIG
 * parsing or R5 editing hot paths. Typed extensions and unknown value[x]
 * payloads remain intact instead of being interpreted as clinical language. */
/** Compatibility name for the requested R6 export: R5 -> native -> R6.
 * The native importer owns all row/phase reconciliation. */
export function toDosageDetails(rows:readonly (FhirDosage|EzDosage)[],instruction?:string,
  metadata?:EzCourseMetadata,options?:{resolvedPhaseSequences?:readonly number[]}):FhirR6DosageInstruction {
  return courseToR6(courseFromR5(rows,instruction,metadata,options));
}

export function assertCurrentR6DosageInstruction(value: FhirR6DosageInstructionInput): string[] {
  const warnings: string[] = [];
  const fail = (detail: string): never => {
    throw new TypeError(`FHIR R6 DosageInstruction (6.0.0-snapshot1) expected: ${detail}`);
  };
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.step !== undefined && !Array.isArray(value.step) ||
      "resourceType" in value || "dosage" in value)
    fail("expected a current DosageInstruction datatype; legacy R6 shapes are unsupported");
  const steps = value.step ?? [];
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (!step || !Array.isArray(step.component) || !step.component.length)
      fail(`step[${index}] must have at least one component`);
    if ("modifierExtension" in step)
      fail(`step[${index}] is Element, not BackboneElement`);
    if (steps.length === 1 && step.safety !== undefined)
      fail("single-step dosage must not carry step.safety (dosdet-2)");
    for (let member = 0; member < step.component.length; member++) {
      const dosage = step.component[member];
      if (!dosage || typeof dosage !== "object" ||
          "sequence" in dosage || "asNeededBoolean" in dosage ||
          "maxDosePerPeriod" in dosage || "maxDosePerAdministration" in dosage ||
          "maxDosePerLifetime" in dosage)
        fail(`step[${index}].component[${member}] contains R5/obsolete R6 dosage fields`);
      if (dosage.site && ("coding" in dosage.site || "text" in dosage.site))
        fail(`step[${index}].component[${member}].site must be CodeableReference`);
      for (const entry of dosage.doseAndRate ?? []) {
        if ("modifierExtension" in entry)
          fail(`step[${index}].component[${member}].doseAndRate is Element`);
        if (Number(entry.doseQuantity !== undefined) + Number(entry.doseRange !== undefined) +
            Number(entry.doseExpression !== undefined) > 1 ||
            Number(entry.rateQuantity !== undefined) + Number(entry.rateRange !== undefined) +
            Number(entry.rateRatio !== undefined) + Number(entry.rateExpression !== undefined) > 1)
          fail(`step[${index}].component[${member}].doseAndRate has multiple dose[x]/rate[x] choices`);
      }
      const repeat = dosage.timing?.repeat;
      if (repeat?.startOffset || repeat?.endOffset) {
        if (repeat.frequency === undefined || repeat.frequency <= 1 || repeat.period === undefined)
          warnings.push(`R6 step[${index}].component[${member}]: Timing.repeat offsets require frequency > 1 and period (tim-11/tim-12); original values retained for editing, but numeric execution may be unsupported.`);
        if (repeat.startOffset?.comparator !== undefined || repeat.endOffset?.comparator !== undefined)
          fail(`step[${index}].component[${member}] offsets require SimpleQuantity`);
      }
    }
  }
  return warnings;
}

/** A supplied R6 instruction is an input source, not an intermediate.
 * Normalize it once and serialize requested R5 views directly. */
export function projectEditableR5Course(details:FhirR6DosageInstruction,strictPreview=false):{
  dosages:EzDosage[];course:EzCourseMetadata;strictDosages?:FhirDosage[]
} {
  const native=courseFromR6(details);
  const projected=projectNativeR5Course(native,undefined,true,false,false,strictPreview);
  let hasAdministrations=false;
  for(const stage of native.stages)if(stage.administrations.length){hasAdministrations=true;break;}
  const dosages=hasAdministrations?projected.dosages:[];
  return {...projected,dosages};
}

/** Import the complete native R6 course into the established editable R5
 * interchange contract. New internal course paths do not use this function. */
export function fromDosageDetails(details: FhirR6DosageInstruction): {
  dosages: EzDosage[]; course: EzCourseMetadata;
} {
  const projected = projectEditableR5Course(details);
  return details.renderedInstruction === undefined ? projected : {
    ...projected,
    dosages: withDosageEditProvenance(projected.dosages, details.renderedInstruction)
  };
}

/** Requested R5 export: either input version is imported into native
 * clinical facts, then written directly to R5. Neither external format is an
 * intermediate representation for the other. */
export function toFhirR5Dosages(input:FhirR6DosageInstruction|readonly(FhirDosage|EzDosage)[],
  metadata?:EzCourseMetadata):FhirDosage[] {
  const native=Array.isArray(input)?courseFromR5(input,metadata?.renderedInstruction,metadata)
    :courseFromR6(input as FhirR6DosageInstruction);
  return projectNativeR5Course(native).dosages;
}

/** R5-only fields whose original R6 spelling or metadata needs a local delta. */
export interface ComponentDeltaBaseline {
  condition?: string;
  safety?: string;
  site?: string;
  doseAndRate?: Array<{ dose?: string; rate?: string }>;
  timing?: string;
}

/** Each marker belongs to its live row, never to another component's snapshot. */
export interface CompactCourseRow {
  rowIndex: number;
  sequence: number;
  stepCount: number;
  step?: Omit<FhirR6DosageInstruction["step"][number], "component">;
  component?: Partial<FhirR6Dosage>;
  /** R6 offsets are typed extension children, never R5 Extension.valueTiming. */
  timingOffsets?: Pick<FhirR6TimingRepeat, "startOffset" | "endOffset">;
  baseline?: ComponentDeltaBaseline;
  context?: string;
  contextRequired?: boolean;
  course?: Omit<FhirR6DosageInstruction, "step" | "renderedInstruction">;
  emptyStep?: EzCourseStep[];
  missingContext?: string[];
}

/** Only the cadence period and frequency govern R6 period-offset
 * interpretation. Independent clock, weekday, and display edits must not
 * delete the original active/rest window. Used only for retained R6 offsets. */
export function offsetCadenceFingerprint(
  timing: FhirDosage["timing"] | FhirR6Dosage["timing"]
): string {
  const repeat = timing?.repeat;
  return compactProjectionFingerprint({
    frequency: repeat?.frequency,
    frequencyMax: repeat?.frequencyMax,
    period: repeat?.period,
    periodMax: repeat?.periodMax,
    periodUnit: repeat?.periodUnit
  });
}

/** Encode local phase metadata and unrepresentable component fields.
 * Course-wide metadata has one owner, referenced by all participating rows.
 * All rows are newly created by the caller; no source course is mutated.
 * @param dosages Fresh flattened output rows in step/component order.
 * @param details Typed source course, used only to calculate missing metadata.
 */
export function attachCourseDetailsExtensions(dosages:(FhirDosage|EzDosage)[],details:FhirR6DosageInstruction):void {
  if(dosages.length)projectNativeR5Course(courseFromR6(details),undefined,false,false,false,false,dosages);
}

/** These are R5 extension codecs, not version converters. A native writer
 * supplies only final retained fields which cannot live in an R5 Dosage row.
 * The old extension names remain stable so existing persisted edits reopen. */
export function attachR5RetainedRow(row: FhirDosage | EzDosage, retained: CompactCourseRow): void {
  replacementExtensions(row, DOSAGE_DETAILS_R5_URL, {
    url: DOSAGE_DETAILS_R5_URL, extension: encodeFields(retained, COMPACT_ROW)
  });
}
/** A course with no administration has a source carrier, not a fabricated
 * dosage. Encode the header and empty-stage metadata directly into its R5
 * extension; do not allocate an intermediate external course. */
export function createR5EmptyCourseCarrier(
  fields: Omit<FhirR6DosageInstruction, "step" | "renderedInstruction">,
  steps: Omit<FhirR6DosageStep, "component">[], instruction?: string
): FhirDosage {
  const children = encodeFields(fields, COURSE);
  if (instruction !== undefined) children.push({url:"renderedInstruction",valueString:instruction});
  for (const step of steps) children.push({url:"step",extension:encodeFields({...step,component:[]},STEP)});
  if (!steps.length) children.push({url:"emptyArray",valueCode:"step"});
  return { ...(instruction !== undefined ? {text:instruction}:{}),
    modifierExtension:[{url:DOSAGE_DETAILS_R5_URL,extension:[{url:"dosageDetails",extension:children}]}] };
}
/** Comparison views used only by the retained-row codec. These project small
 * individual fields, never a whole R6 dosage/course to serve as R5 input. */
export const r5ConditionBaseline = parseDosageCondition;
export const r5SafetyBaseline = toR6Safety;

/** Decode only retained R5 profile fields, not a synthetic external course. */
export function decodeR5RetainedFields(marker:FhirExtension):Partial<CompactCourseRow> {
  return decodeFields(marker.extension??[],COMPACT_ROW);
}
export function encodeR5RetainedFields(value:Partial<CompactCourseRow>):FhirExtension[] {
  return encodeFields(value,COMPACT_ROW);
}
/** Detect the row-local contract without decoding ordinary R5 inputs.
 * @param dosage Live row carrying optional course metadata.
 */
export function compactCourseMarker(dosage: FhirDosage | EzDosage): FhirExtension | undefined {
  return dosage.modifierExtension?.find(value => value.url === DOSAGE_DETAILS_R5_URL &&
    value.extension?.some(child => child.url === "rowIndex"));
}

/** Preserve a superseded local delta without nesting its course owner again.
 * @param marker The row's original structured extension.
 */
export function localReconciliationSource(marker: FhirExtension): FhirExtension {
  return { ...marker, extension: marker.extension?.filter(child =>
    child.url !== "course" && child.url !== "emptyStep") };
}

/** Align R6-only dose/rate choices with surviving R5 entries by their
 * native Element.id or unique clinical type. Position is meaningful only if
 * the list cardinality is unchanged; without identity, deleting one of two
 * indistinguishable projected entries cannot prove which was removed.
 *
 * Only called for a course row that actually carries R6-only choices.
 * @returns Live index -> retained source index; unmatched sources stay inert.
 */
export function retainedDoseRateMatches(
  source: readonly NonNullable<FhirR6Dosage["doseAndRate"]>[number][],
  live: readonly NonNullable<FhirR6Dosage["doseAndRate"]>[number][]
): Map<number, number> {
  const identity = (entry: typeof source[number]): string | undefined =>
    entry.id ? "id:" + entry.id :
    entry.type ? "type:" + compactProjectionFingerprint(entry.type) : undefined;
  const unique = (entries: typeof source): Map<string, number> => {
    const keys = new Map<string, number>();
    for (let i = 0; i < entries.length; i++) {
      const key = identity(entries[i]);
      if (!key) continue;
      keys.set(key, keys.has(key) ? -1 : i);
    }
    return keys;
  };
  const oldKeys = unique(source), liveKeys = unique(live);
  const matches = new Map<number, number>();
  const used = new Set<number>();
  for (const [key, oldIndex] of oldKeys) {
    const liveIndex = liveKeys.get(key);
    if (oldIndex < 0 || liveIndex === undefined || liveIndex < 0) continue;
    matches.set(liveIndex, oldIndex);
    used.add(oldIndex);
  }
  // A clinician may give a formerly type-only slot its first Element.id.
  // Existing source IDs MUST still match by ID, not by type; only one
  // unmatched original type-only slot and one unmatched live typed slot
  // can establish this new identity. Baseline dose/rate fingerprints below
  // deliberately exclude Element.id, so an ID-only edit cannot erase R6
  // expressions or comparators.
  const typeOf = (entry: typeof source[number]): string | undefined =>
    entry.type ? compactProjectionFingerprint(entry.type) : undefined;
  const oldTypes = new Map<string, number>();
  const liveTypes = new Map<string, number>();
  for (let index = 0; index < source.length; index++) {
    if (used.has(index)) continue;
    const type = typeOf(source[index]);
    if (type) oldTypes.set(type, oldTypes.has(type) ? -1 : index);
  }
  for (let index = 0; index < live.length; index++) {
    if (matches.has(index)) continue;
    const type = typeOf(live[index]);
    if (type) liveTypes.set(type, liveTypes.has(type) ? -1 : index);
  }
  for (const [type, oldIndex] of oldTypes) {
    const liveIndex = liveTypes.get(type);
    if (oldIndex < 0 || liveIndex === undefined || liveIndex < 0 ||
        source[oldIndex].id || !live[liveIndex].id) continue;
    matches.set(liveIndex, oldIndex);
    used.add(oldIndex);
  }
  // R5 SimpleQuantity retains the exact numeric value and unit even when
  // the R6 source had "~". That representable data identifies a surviving
  // anonymous entry after deletion/reordering; do not discard it and guess
  // from array position. Only uniquely matching evidence is authoritative.
  const sameNumeric = (old: typeof source[number], current: typeof live[number]): boolean => {
    if (old.id && old.id !== current.id ||
        current.id && old.id !== current.id ||
        !equalStructuredValues(old.type, current.type)) return false;
    let evidence = false;
    if (old.doseQuantity?.comparator) {
      if (!equalStructuredValues(simpleQuantityForR5(old.doseQuantity),
          simpleQuantityForR5(current.doseQuantity)))
        return false;
      evidence = true;
    }
    if (old.rateQuantity?.comparator) {
      if (!equalStructuredValues(simpleQuantityForR5(old.rateQuantity),
          simpleQuantityForR5(current.rateQuantity)))
        return false;
      evidence = true;
    }
    if (old.rateRatio?.numerator?.comparator === "~") {
      if (!equalStructuredValues(ratioForR5(old.rateRatio), ratioForR5(current.rateRatio)))
        return false;
      evidence = true;
    }
    return evidence;
  };
  // A source entry can own any subset of three qualified numeric slots.
  // There are at most seven masks, so index each required mask once rather
  // than walk all live/source rows again for every old entry.
  const masks=new Set<number>(),sourceMasks:number[]=new Array(source.length).fill(0);
  const key=(entry:typeof source[number],mask:number):string=>exactProjectionFingerprint({id:entry.id,type:entry.type,
    dose:mask&1?simpleQuantityForR5(entry.doseQuantity):undefined,
    rate:mask&2?simpleQuantityForR5(entry.rateQuantity):undefined,
    ratio:mask&4?ratioForR5(entry.rateRatio):undefined});
  for(let i=0;i<source.length;i++)if(!used.has(i)){
    const e=source[i],mask=(e.doseQuantity?.comparator?1:0)|(e.rateQuantity?.comparator?2:0)|(e.rateRatio?.numerator?.comparator==="~"?4:0);
    sourceMasks[i]=mask;if(mask)masks.add(mask);
  }
  type NumericGroup={sources:Set<number>;live:Set<number>};
  const byMask=new Map<number,Map<string,NumericGroup>>(),oldGroups=new Map<number,NumericGroup>();
  const liveGroups:Array<NumericGroup[]|undefined>=new Array(live.length),reverseCounts:number[]=new Array(live.length).fill(0);
  for(const mask of masks){
    const groups=new Map<string,NumericGroup>();byMask.set(mask,groups);
    for(let i=0;i<source.length;i++)if(sourceMasks[i]===mask){
      const id=key(source[i],mask);let group=groups.get(id);if(!group)groups.set(id,group={sources:new Set(),live:new Set()});
      group.sources.add(i);oldGroups.set(i,group);
    }
    for(let i=0;i<live.length;i++)if(!matches.has(i)){
      const group=groups.get(key(live[i],mask));if(!group)continue;
      group.live.add(i);(liveGroups[i]??=[]).push(group);reverseCounts[i]+=group.sources.size;
    }
  }
  for(let oldIndex=0;oldIndex<source.length;oldIndex++){
    const group=oldGroups.get(oldIndex);if(!group||group.live.size!==1)continue;
    const liveIndex=group.live.values().next().value!;
    if(reverseCounts[liveIndex]!==1||!sameNumeric(source[oldIndex],live[liveIndex]))continue;
    matches.set(liveIndex,oldIndex);used.add(oldIndex);
    group.sources.delete(oldIndex);reverseCounts[liveIndex]--;
    for(const other of liveGroups[liveIndex]??[])other.live.delete(liveIndex);
  }
  // Identical cardinality retains the conventional slot ordering for
  // anonymous or duplicate-type entries; explicit identities never fall
  // back to a different slot when deleted or changed.
  if (source.length === live.length) {
    for (let i = 0; i < live.length; i++) {
      if (matches.has(i) || used.has(i) ||
          source[i]?.id || live[i]?.id ||
          !equalStructuredValues(source[i]?.type, live[i]?.type)) continue;
      matches.set(i, i);
      used.add(i);
    }
  } else {
    // A solitary anonymous survivor can be identified by elimination after
    // matching typed entries. Two anonymous survivors cannot.
    let oldRemaining=-1,liveRemaining=-1;
    for(let i=0;i<source.length;i++)if(!used.has(i)&&!identity(source[i])){if(oldRemaining>=0){oldRemaining=-2;break;}oldRemaining=i;}
    for(let i=0;i<live.length;i++)if(!matches.has(i)&&!identity(live[i])){if(liveRemaining>=0){liveRemaining=-2;break;}liveRemaining=i;}
    if(oldRemaining>=0&&liveRemaining>=0)matches.set(liveRemaining,oldRemaining);
  }
  return matches;
}

const CONFLICTING_PHASE_CONTEXT = "conflicting-phase";

/** Phase fields whose disagreement can change administration or supply.
 * IDs and non-modifier annotations remain editable without blocking execution.
 * @param step Local phase metadata without dosage components.
 */
export function executablePhaseMetadata(step: NonNullable<CompactCourseRow["step"]>) {
  const { start, end, count, safety } = step;
  return { start, end, count, safety };
}

/** Identify unavailable or contradictory context before numeric execution.
 * Parsing, formatting and editing continue to preserve all surviving data.
 * @param course Reconstructed course with typed context markers on its components.
 */
export function getCourseContextIssue(
  course: FhirR6DosageInstruction
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
  offsetDuration: QUANTITY,
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
    period: QUANTITY,
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
    doseQuantity: QUANTITY,
    doseExpression: { value: "valueExpression" },
    // A nested R6 numerator may carry "~", which is not legal inside
    // R5 Extension.valueRatio; reuse the typed Quantity codec.
    rateRatio: { fields: {
      ...ELEMENT, numerator: QUANTITY, denominator: { value: "valueQuantity" }
    } },
    rateRange: { value: "valueRange" },
    rateQuantity: QUANTITY,
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
  repeatCycle: QUANTITY,
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
  // R6 Timing offsets are SimpleQuantity, not Quantity: their EMA
  // extension is legal but must never be promoted to a native comparator.
  // The existing valueQuantity codec copies that typed value unchanged.
  timingOffsets: { fields: {
    startOffset: { value: "valueQuantity" },
    endOffset: { value: "valueQuantity" }
  } },
  baseline: { fields: {
    condition: { value: "valueString" }, safety: { value: "valueString" },
    site: { value: "valueString" }, timing: { value: "valueString" },
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
        children.push({ url: key, extension: [item as FhirExtension] });
      } else if (field.fields) {
        children.push({ url: key, extension: encodeFields(item as object, field.fields) });
      } else if (field.quantity) {
        // FHIR R5 Quantity supports <, <=, >, >=, ad natively. R6-only
        // approximation uses EMA's already-published operator extension,
        // never a new ad hoc comparator-code field.
        children.push({
          url: key,
          valueQuantity: generalQuantityForR5(item as FhirR6Quantity)
        });
      } else if (field.value) {
        children.push({ url: key, [field.value]: item });
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
    else if (field.fields) {
      // Older saved rateRatio bridges used FHIR Extension.valueRatio.
      // New nested field shapes take precedence when both are present.
      value = child.extension
        ? decodeFields(child.extension, field.fields)
        : child.url === "rateRatio" && child.valueRatio
          ? child.valueRatio : undefined;
    }
    else if (field.quantity) {
      value = child.valueQuantity && quantityFromR5(cloneStructuredValue(child.valueQuantity));
      if (!value && child.extension) {
        // Read previous versions of our bridge without emitting that old
        // private comparator-child representation on any new export.
        const quantity = child.extension.find(part => part.url === "quantity")?.valueQuantity;
        const comparator = child.extension.find(part => part.url === "comparator")?.valueCode;
        if (quantity) value = { ...cloneStructuredValue(quantity),
          ...(comparator ? { comparator } : {}) };
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
export function decodeCourseDetails(node: FhirExtension): FhirR6DosageInstruction | undefined {
  if (!node.extension || node.valueString !== undefined) return undefined;
  const value = decodeFields(node.extension, COURSE);
  if (!Array.isArray(value.step) || !value.step.every(step =>
    step && typeof step === "object" && Array.isArray(step.component))) return undefined;
  return { ...value, step: value.step } as FhirR6DosageInstruction;
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
