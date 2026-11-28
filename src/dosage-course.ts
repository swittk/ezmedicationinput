import { MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL } from "./instruction-graph-fhir";
import {courseFromR5} from "./adapters/r5-course";
import { getTimingClocks, TIMING_ADDITIONAL_CLOCK_EXTENSION_URL } from "./fhir";
import {courseFromR6,courseToR6,administrationFromR6,administrationToR5,selectR5Maximum,r5MaximumDoseBasis,periodMaximumToR5,type R5MaximumSelection} from "./adapters/canonical-course";
import {projectNativeR5Course} from "./adapters/r5-course";
/** FHIR R5/R6 bridging uses typed extension children exclusively. Source,
 * course, condition and edit metadata remain structured and independently editable. */
import { cloneStructuredValue, equalStructuredValues } from "./stable-structure";
import { findSymptomDefinitionByCoding } from "./symptom-terminology";
import { getDoseQuantityUnit } from "./maps";
import { DOSAGE_RECONCILIATION_SOURCE_URL, getEmaQuantityComparator, quantityFromR5, quantityForR6, quantityForR5 as generalQuantityForR5, simpleQuantityForR5, quantityAnnotationExtensions } from "./fhir-quantity-operator";
import { FhirDayOfWeek, FhirDosage, FhirExtension, FhirR6Extension, FhirQuantity, FhirRatio, FhirR6Dosage, FhirR6DosageCondition, FhirR6DosageInstruction, FhirR6DosageStep, FhirR6DosageInstructionInput, FhirR6DosageSafety, FhirR6DoseLimit, FhirR6Quantity, FhirR6TimingRepeat, FhirTimingRepeat, MedicationCondition, EzDosage, EzCourseMetadata, EzCourseStep } from "./types";

/** R5 and R6 tim-8 requires the lower-count Element beside countMax, not a numeric
 * minimum. Preserve authored companions; an absent minimum remains unknown. */
export function withTimingCountMinimum<T extends Pick<FhirR6TimingRepeat, "count" | "countMax" | "_count">>(repeat: T): T {
  if (repeat.countMax === undefined || repeat.count !== undefined || repeat._count !== undefined) return repeat;
  return { ...repeat, _count: { extension: [{
    url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown",
  }] } };
}

/** R5 and R6 tim-7 requires a lower-duration Element, without inventing a numeric bound. */
export function withTimingDurationMinimum<T extends Pick<FhirR6TimingRepeat, "duration" | "durationMax" | "_duration">>(repeat: T): T {
  if (repeat.durationMax === undefined || repeat.duration !== undefined || repeat._duration !== undefined) return repeat;
  return { ...repeat, _duration: { extension: [{
    url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown",
  }] } };
}

/** R5 and R6 tim-6 requires a lower-period Element, without inventing a numeric cadence. */
export function withTimingPeriodMinimum<T extends Pick<FhirR6TimingRepeat, "period" | "periodMax" | "_period">>(repeat: T): T {
  if (repeat.periodMax === undefined || repeat.period !== undefined || repeat._period !== undefined) return repeat;
  return { ...repeat, _period: { extension: [{
    url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown",
  }] } };
}

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
/** Keeps an expression-only R5 backbone element valid without inventing a dose. */
export const R5_EXPRESSION_SLOT_SOURCE_URL =
  "urn:ezmedicationinput:StructureDefinition:r5-expression-slot-source";
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
export { DOSAGE_RECONCILIATION_SOURCE_URL } from "./fhir-quantity-operator";
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

/** The finite repetition count belongs to the complete treatment course.
 * R6 step.count repeats one step; neither R5 nor R6 has a core course-count
 * slot, so both boundary adapters share this narrow modifier extension. */

export const COURSE_CYCLE_COUNT_EXTENSION_URL =
  "urn:ezmedicationinput:StructureDefinition:medication-course-cycle-count";

type CourseCountField = Pick<FhirExtension, "url" | "valueInteger"> & { _valueInteger?: unknown };
type CourseCountOwner = { modifierExtension?: readonly CourseCountField[] };
function countValue(item: CourseCountField): number | undefined {
  return item.url === COURSE_CYCLE_COUNT_EXTENSION_URL &&
    Number.isInteger(item.valueInteger) && item.valueInteger! > 0
    ? item.valueInteger : undefined;
}

/** Null retains an authored primitive whose finite count is not known. */
export function getCourseCycleCount(owner: CourseCountOwner): number | null | undefined {
  let unknown = false;
  for (const item of owner.modifierExtension ?? []) {
    const count = countValue(item);
    if (count !== undefined) return count;
    if (item.url === COURSE_CYCLE_COUNT_EXTENSION_URL && item.valueInteger === undefined &&
        item._valueInteger !== undefined) unknown = true;
  }
  return unknown ? null : undefined;
}

/** Write the current typed count while preserving unrelated modifiers and
 * metadata on an existing recognized count annotation. Output owns writes. */
export function setCourseCycleCount(owner: { modifierExtension?: FhirExtension[] }, count: number | undefined): FhirExtension[] | undefined;
export function setCourseCycleCount(owner: { modifierExtension?: FhirR6Extension[] }, count: number | undefined): FhirR6Extension[] | undefined;
export function setCourseCycleCount(owner: { modifierExtension?: FhirR6Extension[] }, count: number | undefined): FhirR6Extension[] | undefined {
  const original = owner.modifierExtension;
  let found = false, changed: FhirR6Extension[] | undefined, displaced: FhirR6Extension[] | undefined;
  for (let index = 0; index < (original?.length ?? 0); index++) {
    const item = original![index];
    if (countValue(item) === undefined) {
      changed?.push(item);
      continue;
    }
    if (found) {
      changed ??= original!.slice(0, index);
      (displaced ??= []).push(item);
      continue;
    }
    found = true;
    if (count === item.valueInteger) changed?.push(item);
    else {
      changed ??= original!.slice(0, index);
      if (count !== undefined) changed.push({ ...item, valueInteger: count });
      else (displaced ??= []).push(item);
    }
  }
  if (!found && count !== undefined) {
    changed ??= original?.slice() ?? [];
    changed.push({ url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: count });
  }
  if (changed) {
    if (changed.length) owner.modifierExtension = changed;
    else delete owner.modifierExtension;
  }
  return displaced;
}

type ModifierWrapperOwner = { extension?: FhirR6Extension[]; modifierExtension?: FhirR6Extension[] };
/** Project the editable modifier owner on an already-owned output fragment.
 * Step and doseAndRate share this Element boundary, including wrapper metadata. */
export function projectR6ModifierWrapper(output: ModifierWrapperOwner, url: string): void {
  const { modifierExtension, extension } = output;
  delete output.modifierExtension;
  if (modifierExtension === undefined && !extension?.length) return;
  let existing: FhirR6Extension | undefined, extensions: FhirR6Extension[] | undefined, existingIndex = -1;
  for (let index = 0; index < (extension?.length ?? 0); index++) {
    const item = extension![index];
    if (item.url !== url) extensions?.push(item);
    else {
      extensions ??= extension!.slice(0, index);
      if (!existing) { existing = item; existingIndex = index; }
      else extensions.push({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [item] });
    }
  }
  const modifiers = modifierExtension ?? existing?.extension;
  if (modifiers?.length) {
    const unchanged = existing && (modifierExtension === undefined ||
      equalStructuredValues(modifierExtension, existing.extension));
    if (unchanged) extensions!.splice(existingIndex, 0, existing!);
    else {
      if (existing)
        (extensions ??= []).push({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [existing] });
      (extensions ??= extension?.slice() ?? []).push({ ...existing, url, extension: modifiers });
    }
  } else if (existing && (existing.extension?.length || hasOtherOwnField(existing, "extension")))
    (extensions ??= []).push({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [existing] });
  // Empty lists retain explicit clear ownership; unchanged foreign-only
  // lists keep their reference and require no allocation.
  if (extensions) output.extension = extensions;
  else if (modifierExtension !== undefined && extension === undefined) output.extension = [];
}
export function projectR5ModifierWrapper(output: ModifierWrapperOwner, url: string): void {
  const { extension } = output;
  if (!extension?.length) return;
  let retained: FhirR6Extension | undefined, extensions: FhirR6Extension[] | undefined;
  for (let index = 0; index < extension.length; index++) {
    const item = extension[index];
    if (item.url !== url) extensions?.push(item);
    else if (retained) {
      (extensions ??= extension.slice(0, index)).push({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [item] });
    } else {
      retained = item;
      // The editable modifier list owns the children; keep the authored
      // wrapper so its annotations survive a subsequent live replacement.
      if (hasOtherOwnField(item, "extension")) extensions?.push(item);
      else extensions ??= extension.slice(0, index);
    }
  }
  if (extensions) {
    if (extensions.length) output.extension = extensions;
    else delete output.extension;
  }
  if (output.modifierExtension === undefined && retained?.extension?.length)
    output.modifierExtension = retained.extension;
}
export function r6StepMetadata(step: Partial<EzCourseStep>): Omit<FhirR6DosageStep, "component"> {
  const { sequence: _sequence, ...output } = step;
  projectR6ModifierWrapper(output, R5_STEP_MODIFIERS_R6_URL);
  return output;
}
export function r5StepMetadata(step: Omit<FhirR6DosageStep, "component">): Omit<EzCourseStep, "sequence"> {
  const output: Omit<EzCourseStep, "sequence"> = { ...step };
  projectR5ModifierWrapper(output, R5_STEP_MODIFIERS_R6_URL);
  return output;
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
  dosage: Pick<FhirR6Dosage, "modifierExtension">
): DosageAlternativeChoice | undefined {
  let fields:FhirR6Extension[]|undefined;
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
  dosage: Pick<FhirR6Dosage, "modifierExtension" | "extension">,
  choice: DosageAlternativeChoice | undefined
): void {
  const original = dosage.modifierExtension;
  let found = false, updated: FhirR6Extension[] | undefined, retired: FhirR6Extension[] | undefined;
  for (let index = 0; index < (original?.length ?? 0); index++) {
    const marker = original![index];
    if (marker.url !== DOSAGE_ALTERNATIVE_CHOICE_URL) { updated?.push(marker); continue; }
    if (!choice || found) {
      updated ??= original!.slice(0, index);
      (retired ??= []).push(marker);
      continue;
    }
    found = true;
    let fields: FhirR6Extension[] | undefined, seen = 0, retireNested = false;
    const children = marker.extension ?? [];
    for (let childIndex = 0; childIndex < children.length; childIndex++) {
      const child = children[childIndex];
      const bit = child.url === "groupId" ? 1 : child.url === "branchId" ? 2 :
        child.url === "selectionBehavior" ? 4 : 0;
      let next = child;
      if (bit && !(seen & bit)) {
        seen |= bit;
        const value = bit === 1 ? choice.groupId : bit === 2 ? choice.branchId : choice.selectionBehavior;
        const previous = bit === 4 ? child.valueCode : child.valueString;
        if (previous !== value) {
          next = bit === 4 ? { ...child, valueCode: value } : { ...child, valueString: value };
          if (previous === undefined && child.extension?.length) {
            delete next.extension;
            retireNested = true;
          }
        }
      }
      if (next !== child) fields ??= children.slice(0, childIndex);
      fields?.push(next);
    }
    if (seen !== 7) {
      fields ??= children.slice();
      if (!(seen & 1)) fields.push({ url: "groupId", valueString: choice.groupId });
      if (!(seen & 2)) fields.push({ url: "branchId", valueString: choice.branchId });
      if (!(seen & 4)) fields.push({ url: "selectionBehavior", valueCode: choice.selectionBehavior });
    }
    if (retireNested) (retired ??= []).push(marker);
    if (fields) {
      updated ??= original!.slice(0, index);
      updated.push({ ...marker, extension: fields });
    } else updated?.push(marker);
  }
  if (choice && !found) {
    updated ??= original?.slice() ?? [];
    updated.push({ url: DOSAGE_ALTERNATIVE_CHOICE_URL, extension: [
      { url: "groupId", valueString: choice.groupId },
      { url: "branchId", valueString: choice.branchId },
      { url: "selectionBehavior", valueCode: choice.selectionBehavior },
    ] });
  }
  if (updated) dosage.modifierExtension = updated.length ? updated : undefined;
  if (retired) dosage.extension = [...(dosage.extension ?? []), {
    url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: retired
  }];
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
const CONDITION_MEASUREMENT_NAMES = new Map<string, string>();
for (const name of Object.keys(CONDITION_MEASUREMENT_CODES)) {
  const code = CONDITION_MEASUREMENT_CODES[name].code;
  if (!CONDITION_MEASUREMENT_NAMES.has(code)) CONDITION_MEASUREMENT_NAMES.set(code, name);
}

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
function ordinaryConditionLeaf(node:FhirR6Extension):MedicationCondition|undefined {
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

function parseConditionModifier(extension: FhirR6Extension): MedicationCondition | undefined {
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

/** Generated copies may be consumed only when their typed predicate agrees. */
export function exactConditionBridgePredicate(extension: FhirExtension): MedicationCondition | undefined {
  if (extension.url !== DOSAGE_CONDITION_R5_URL || Object.keys(extension).length !== 2) return undefined;
  const predicate = parseConditionModifier(extension);
  return predicate !== undefined && equalStructuredValues(extension.extension, [encodeConditionPredicate(predicate)])
    ? predicate : undefined;
}
export function isExactConditionBridge(extension: FhirExtension): boolean {
  return exactConditionBridgePredicate(extension) !== undefined;
}

export function assertUnderstoodDosageModifiers(_dosage: FhirDosage | EzDosage): void {
  // Compatibility API. Unknown modifier semantics remain attached for editing.
}

function parseDosageCondition(dosage: Pick<FhirR6Dosage,"modifierExtension"> & {condition?:FhirR6DosageCondition[]}): MedicationCondition | undefined {
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

export function getDosageCondition(dosage: Pick<FhirR6Dosage,"modifierExtension"> & {condition?:FhirR6DosageCondition[]}): MedicationCondition | undefined {
  return parseDosageCondition(dosage);
}

/** Read the source-certified whole-day predicate from the existing condition bridge.
 * @param dosage Editable dosage containing a structured condition extension.
 */
function calendarDayPredicateFromMarker(extension: FhirR6Extension | undefined): MedicationCondition | undefined {
  const child = extension?.extension?.find(value => value.url === "calendarDayPredicate");
  const value = child ? decodeConditionPredicate(child) : undefined;
  return isMedicationCondition(value) ? value : undefined;
}
function retainedCalendarDayPredicate(dosage: Pick<FhirR6Dosage, "modifierExtension">): MedicationCondition | undefined {
  return calendarDayPredicateFromMarker(dosage.modifierExtension?.find(value => value.url === DOSAGE_CONDITION_R5_URL));
}

/** A whole-day evaluation is licensed only for the same live predicate that
 * the source grammar identified as calendar membership. An edited native
 * condition or a mixed measurement/day predicate cannot inherit that claim.
 * @param dosage Native or R5 dosage with optional source-owned day-domain metadata.
 */
export function getDosageCalendarDayCondition(dosage: FhirDosage | EzDosage | FhirR6Dosage): MedicationCondition | undefined {
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
  const expanded = dosage as EzDosage;
  // Lifted R5 rows expose a native condition mirror. Keep that existing owner
  // synchronized before testing whether the R5 modifier itself is unchanged.
  if (expanded.condition !== undefined && !equalStructuredValues(parseDosageCondition(expanded), condition)) {
    if (expanded.condition.length) dosage.extension = [...(dosage.extension ?? []), {
      url: DOSAGE_RECONCILIATION_SOURCE_URL,
      extension: encodeR5RetainedFields({ component: { condition: expanded.condition } }),
    }];
    expanded.condition = condition ? [conditionToR6(condition)] : [];
  }
  let previous: FhirExtension | undefined, additional: FhirExtension[] | undefined;
  for (const value of dosage.modifierExtension ?? []) if (value.url === DOSAGE_CONDITION_R5_URL) {
    if (!previous) previous = value;
    else (additional ??= []).push(value);
  }
  const priorCalendar = calendarDayPredicateFromMarker(previous);
  const calendar = calendarDayCondition ?? priorCalendar;
  // Existing external wrappers own IDs and unfamiliar children. The same
  // typed facts do not require replacement merely to export another version.
  if (condition && previous && !additional && equalStructuredValues(parseConditionModifier(previous), condition) &&
      equalStructuredValues(priorCalendar, calendar)) return;
  let displaced: FhirExtension[] | undefined;
  if (previous && !isExactConditionBridge(previous)) displaced = [previous];
  for (const value of additional ?? []) if (!isExactConditionBridge(value)) (displaced ??= []).push(value);
  if (displaced) dosage.extension = [...(dosage.extension ?? []), {
    url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: displaced,
  }];
  const children = condition ? [encodeConditionPredicate(condition)] : [];
  if (condition && calendar && equalStructuredValues(condition, calendar)) {
    children.push({ ...encodeConditionPredicate(calendar), url: "calendarDayPredicate" });
  }
  replacementExtensions(dosage, DOSAGE_CONDITION_R5_URL, condition ? {
    url: DOSAGE_CONDITION_R5_URL, extension: children
  } : undefined);
}

export function getDosageExcludedDates(dosage: FhirDosage | EzDosage | FhirR6Dosage): string[] {
  if ((dosage as EzDosage).excludedDates) return [...(dosage as EzDosage).excludedDates!];
  const extension = dosage.modifierExtension?.find(value => value.url === DOSAGE_EXCLUDED_DATES_R5_URL);
  return [...new Set((extension?.extension ?? [])
    .filter(child => child.url === "date" && /^\d{4}-\d{2}-\d{2}$/.test(child.valueDate ?? ""))
    .map(child => child.valueDate!))].sort();
}

/** Calendar values own only their typed children. Unchanged external wrappers
 * retain their exact annotations; removed values remain inactive source. */
function setCalendarRestriction(
  dosage: FhirDosage, url: string, kind: "date" | "day", values: readonly string[]
): void {
  const field = kind === "date" ? "modifierExtension" : "extension";
  const extensions = dosage[field];
  const index = extensions?.findIndex(item => item.url === url) ?? -1;
  const previous = index >= 0 ? extensions![index] : undefined;
  // New markers have no source annotations to reconcile.
  if (!previous) {
    if (!values.length) return;
    if (kind === "date") {
      const marker = { url, extension: values.map(valueDate => ({ url: "date", valueDate })) };
      dosage.modifierExtension = extensions?.length ? [...extensions, marker] : [marker];
    } else {
      const marker = { url, extension: values.map(valueCode => ({ url: "day", valueCode })) };
      dosage.extension = extensions?.length ? [...extensions, marker] : [marker];
    }
    return;
  }
  const valueKey = kind === "date" ? "valueDate" : "valueCode";
  const read = (child: FhirExtension) => child.url === kind && typeof child[valueKey] === "string" &&
    (kind !== "date" || /^\d{4}-\d{2}-\d{2}$/.test(child[valueKey]!)) ? child[valueKey] : undefined;
  const current = new Set<string>();
  for (const child of previous?.extension ?? []) {
    const value = read(child);
    if (value !== undefined) current.add(value);
  }
  const unchanged = current.size === values.length && values.every(value => current.has(value));
  let duplicates: FhirExtension[] | undefined, keptTail: FhirExtension[] | undefined;
  for (let at = index + 1; at < extensions!.length; at++) {
    const item = extensions![at];
    if (item.url === url) {
      (duplicates ??= []).push(item);
      keptTail ??= extensions!.slice(index + 1, at);
    } else keptTail?.push(item);
  }
  if (unchanged && !duplicates) return;
  const wanted = new Set(values);
  const children: FhirExtension[] = [];
  let removed = false;
  for (const child of previous.extension ?? []) {
    const value = read(child);
    if (value === undefined || wanted.has(value)) children.push(child);
    else removed = true;
  }
  for (const value of values)
    if (!current.has(value)) children.push({ url: kind, [valueKey]: value });
  const next = extensions!.slice(0, index);
  const marker = values.length ? unchanged ? previous : { ...previous, url, extension: children } : undefined;
  if (marker) next.push(marker);
  next.push(...(keptTail ?? extensions!.slice(index + 1)));
  dosage[field] = next.length ? next : undefined;
  const retired = removed || !values.length ? [previous, ...(duplicates ?? [])] : duplicates;
  if (retired?.length) dosage.extension = [...(dosage.extension ?? []),
    { url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: retired }];
}

export function setDosageExcludedDates(dosage: FhirDosage, dates: string[]): void {
  const current = dates.length < 2 ? dates : [...new Set(dates)].sort();
  setCalendarRestriction(dosage, DOSAGE_EXCLUDED_DATES_R5_URL, "date", current);
  // Only an already-lifted public edit view has this second representation.
  // Even a no-op wire write must bring a stale lifted value back in agreement.
  if ("excludedDates" in dosage) {
    if (current.length) (dosage as EzDosage).excludedDates = current.slice();
    else delete (dosage as EzDosage).excludedDates;
  }
}

export function getDosageExcludedWeekdays(dosage: FhirDosage | FhirR6Dosage): FhirDayOfWeek[] {
  const extension = dosage.extension?.find(value => value.url === DOSAGE_EXCLUDED_WEEKDAYS_R5_URL);
  return (extension?.extension ?? [])
    .filter(child => child.url === "day" && typeof child.valueCode === "string")
    .map(child => child.valueCode as FhirDayOfWeek);
}

export function setDosageExcludedWeekdays(dosage: FhirDosage, days: FhirDayOfWeek[]): void {
  setCalendarRestriction(dosage, DOSAGE_EXCLUDED_WEEKDAYS_R5_URL, "day",
    days.length < 2 ? days : [...new Set(days)]);
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
  let problem = value.details?.text ?? value.details?.coding?.find(coding => coding.display)?.display;
  if (problem === undefined) for (const coding of value.details?.coding ?? []) {
    if (!coding.system || !coding.code) continue;
    const definition = findSymptomDefinitionByCoding(coding.system, coding.code);
    problem = definition?.text ?? definition?.coding?.display;
    if (problem !== undefined) break;
  }
  problem ??= value.code?.text;
  const label = problem ?? value.code?.coding?.[0]?.display;
  let name = problem;
  if (name === undefined) for (const coding of value.code?.coding ?? []) {
    if (coding.system !== "http://loinc.org" || !coding.code) continue;
    name = CONDITION_MEASUREMENT_NAMES.get(coding.code);
    if (name !== undefined) break;
  }
  name ??= label;
  if (problem && value.valueBoolean !== undefined &&
      (!value.operation || value.operation === "eq" || value.operation === "ne")) {
    for (const coding of value.code?.coding ?? []) {
      if (coding.code !== "problem-presents" || coding.system && coding.system !== CONDITION_CODE_SYSTEM) continue;
      return { kind: "state", name: problem, expected: value.operation === "ne" ? !value.valueBoolean : value.valueBoolean,
        text: value.text ?? problem };
    }
  }
  if (value.valueQuantity?.value !== undefined && value.operation && name &&
    ["gt", "ge", "lt", "le", "eq", "ne"].indexOf(value.operation) >= 0) {
    return {
      kind: "measurement", name, operation: value.operation as "gt" | "ge" | "lt" | "le" | "eq" | "ne",
      value: value.valueQuantity.value,
      unit: value.valueQuantity.unit ?? (getDoseQuantityUnit(value.valueQuantity, false) || undefined),
      text: value.text ?? label ?? name
    };
  }
  // Keep the actual condition in native fields/the retained course. A human
  // placeholder is not a replacement payload and never contains serialized data.
  return { kind: "text", text: value.text ?? name ?? "Unresolved condition" };
}

function toR6Safety(dosage: FhirDosage, includePartialPeriods = false): FhirR6DosageSafety | undefined {
  const doseLimit: NonNullable<FhirR6DosageSafety["doseLimit"]> = [];
  for (const maximum of dosage.maxDosePerPeriod ?? []) {
    if (!maximum.numerator || !maximum.denominator || !includePartialPeriods &&
        (maximum.numerator.value === undefined || maximum.denominator.value === undefined)) continue;
    const { numerator, denominator, ...metadata } = maximum;
    doseLimit.push({
      ...metadata, scope: "period", valueQuantity: quantityFromR5(numerator)!,
      period: quantityFromR5(denominator)
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
  // Both Quantity objects are exposed in an R5 Ratio even when an authored
  // endpoint has no numeric value. Presence and deletion still belong to that
  // editable Ratio; incomplete values never create a numeric ceiling.
  if (limit.scope === "period") return limit.period !== undefined;
  return limit.scope === "administration" || limit.scope === "lifetime";
}

/** Singular R5 maxima expose the tightest comparable exact amount; all
 * other limits remain active siblings. The saved projection hash also
 * identifies rows written when singular fields exposed the last limit. */
function r5ProjectedSafetyLimitIndices(limits: readonly FhirR6DoseLimit[], baseline?: string, dose?: FhirQuantity): Set<number> {
  const indices = new Set<number>();
  let administrationSelection: R5MaximumSelection | undefined, lifetimeSelection: R5MaximumSelection | undefined;
  let lastAdministration: number | undefined, lastLifetime: number | undefined;
  for (let index = 0; index < limits.length; index++) {
    const limit = limits[index];
    if (!isR5RepresentableSafetyLimit(limit)) continue;
    if (limit.scope === "period") indices.add(index);
    else if (limit.scope === "administration") {
      lastAdministration = index;
      administrationSelection = selectR5Maximum(administrationSelection, limit.valueQuantity!, index, dose);
    } else if (limit.scope === "lifetime") {
      lastLifetime = index;
      lifetimeSelection = selectR5Maximum(lifetimeSelection, limit.valueQuantity!, index, dose);
    }
  }
  let administration = administrationSelection?.index, lifetime = lifetimeSelection?.index;
  if (baseline && (administration !== lastAdministration || lifetime !== lastLifetime)) {
    // Only differing multi-limit projections need this historical proof.
    // Reuse the real wire serializers and already classified period indices.
    const previous: FhirDosage = {};
    for (const index of indices) {
      const limit = limits[index];
      (previous.maxDosePerPeriod ??= []).push(periodMaximumToR5(limit.valueQuantity!, limit.period!, limit));
    }
    if (lastAdministration !== undefined)
      previous.maxDosePerAdministration = simpleQuantityForR5(limits[lastAdministration].valueQuantity);
    if (lastLifetime !== undefined)
      previous.maxDosePerLifetime = simpleQuantityForR5(limits[lastLifetime].valueQuantity);
    if (baseline === compactProjectionFingerprint(toR6Safety(previous))) {
      administration = lastAdministration;
      lifetime = lastLifetime;
    }
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
  projected: FhirR6DosageSafety | undefined,
  baseline?: string,
  dose?: FhirQuantity
): FhirR6DosageSafety | undefined {
  const oldLimits = retained.doseLimit ?? [];
  const live = projected?.doseLimit ?? [];
  // A scope is NOT an identity: several per-period limits can coexist.
  // An explicit Element.id owns its limit even after amount or order edits.
  // ID-less limits use independently retained annotations and unit/window
  // identity. Ambiguous rows never inherit arbitrary metadata.
  const projectedIndices = r5ProjectedSafetyLimitIndices(oldLimits, baseline, dose);
  const representable = oldLimits.map((_, index) => projectedIndices.has(index));
  // Amount is editable, not identity. A unique retained Ratio annotation or
  // clinical unit/window can own an anonymous limit; duplicate anonymous
  // windows must leave old text inactive instead of exchanging it.
  const windowKey = (limit: FhirR6DoseLimit): string => {
    const quantity = limit.valueQuantity, period = limit.period;
    return compactProjectionFingerprint({
      quantity: quantity && { system: quantity.system, code: quantity.code,
        unit: quantity.system && quantity.code ? undefined : quantity.unit },
      period: period && { value: period.value, system: period.system, code: period.code,
        unit: period.system && period.code ? undefined : period.unit,
        comparator: period.comparator ?? getEmaQuantityComparator(period) },
    });
  };
  const signature = (limit: FhirR6DoseLimit) => limit.scope === "period" && limit.id !== undefined
    ? "id:" + limit.id : limit.extension?.length
      ? limit.scope + ":metadata:" + compactProjectionFingerprint(limit.extension)
      : limit.scope + ":" + windowKey(limit);
  const oldKeys = new Map<string, number>();
  const liveKeys = new Map<string, number>();
  let repeatedPeriodIdentity = false;
  const indexKeys = (items: readonly FhirR6DoseLimit[], keys: Map<string, number>,
    allowed?: readonly boolean[]) => {
    items.forEach((limit, index) => {
      // Completing a projected partial Ratio keeps its unique Element.id
      // owner even though its previous numeric limit was incomplete.
      if (allowed && !allowed[index] && !(limit.scope === "period" &&
          limit.id !== undefined && limit.valueQuantity && limit.period)) return;
      const key = signature(limit);
      if (limit.scope === "period" && keys.has(key)) repeatedPeriodIdentity = true;
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
  if (repeatedPeriodIdentity) {
    // Equal windows are not equal limits. Reserve a uniquely unchanged R5
    // projection at its existing position before matching an edited neighbor.
    // A moved amount alone cannot distinguish a reorder from two amount edits.
    const exactKey = (limit: FhirR6DoseLimit) =>
      compactProjectionFingerprint(periodMaximumToR5(limit.valueQuantity!, limit.period!, limit));
    const oldExact = new Map<string, number>(), liveExact = new Map<string, number>();
    const oldPeriodPositions: number[] = [], livePeriodPositions: number[] = [];
    let oldPosition = 0, livePosition = 0;
    oldLimits.forEach((limit, index) => {
      if (!representable[index] || limit.scope !== "period") return;
      oldPeriodPositions[index] = oldPosition++;
      if (usedOld.has(index)) return;
      const key = exactKey(limit);
      oldExact.set(key, oldExact.has(key) ? -1 : index);
    });
    live.forEach((limit, index) => {
      if (limit.scope !== "period") return;
      livePeriodPositions[index] = livePosition++;
      if (matched.has(index)) return;
      const key = exactKey(limit);
      liveExact.set(key, liveExact.has(key) ? -1 : index);
    });
    for (const [key, oldIndex] of oldExact) {
      const liveIndex = liveExact.get(key);
      // R5 owns the period Ratio list separately from singular maxima.
      if (oldIndex < 0 || liveIndex === undefined || liveIndex < 0 ||
          oldPeriodPositions[oldIndex] !== livePeriodPositions[liveIndex]) continue;
      matched.set(liveIndex, oldIndex); usedOld.add(oldIndex);
    }
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
    (original.system && original.code && replacement.system && replacement.code
      ? original.system === replacement.system && original.code === replacement.code
      : original.unit === replacement.unit && original.code === replacement.code &&
        original.system === replacement.system);
  const sameNumericOwner = (scope: string, original: FhirR6DoseLimit, candidate: FhirR6DoseLimit): boolean => {
    // Unmatched cardinality alone is not identity: units and the period window
    // belong to the clinical limit, while an explicit replacement ID wins.
    const firstId = original.id === undefined &&
      original.valueQuantity?.value === candidate.valueQuantity?.value &&
      (original.valueQuantity?.comparator ?? getEmaQuantityComparator(original.valueQuantity)) ===
        (candidate.valueQuantity?.comparator ?? getEmaQuantityComparator(candidate.valueQuantity));
    return !(scope === "period" && original.id !== candidate.id && !firstId) &&
      sameUnit(original.valueQuantity, candidate.valueQuantity) &&
      (!(original.period || candidate.period) ||
        sameUnit(original.period, candidate.period) && original.period?.value === candidate.period?.value &&
        (original.period?.comparator ?? getEmaQuantityComparator(original.period)) ===
          (candidate.period?.comparator ?? getEmaQuantityComparator(candidate.period)));
  };
  for (const [scope, oldIndices] of oldByScope) {
    const liveIndices = liveByScope.get(scope);
    if (!liveIndices?.length) continue;
    if (oldIndices.length === 1 && liveIndices.length === 1) {
      if (!sameNumericOwner(scope, oldLimits[oldIndices[0]], live[liveIndices[0]])) continue;
      matched.set(liveIndices[0], oldIndices[0]); usedOld.add(oldIndices[0]);
      continue;
    }
    // Several amount edits in one scope are still identifiable by distinct
    // unit/window pairs. Duplicate windows remain inactive, never guessed.
    const oldWindows = new Map<string, number>(), liveWindows = new Map<string, number>();
    for (const index of oldIndices) {
      const key = windowKey(oldLimits[index]);
      oldWindows.set(key, oldWindows.has(key) ? -1 : index);
    }
    for (const index of liveIndices) {
      const key = windowKey(live[index]);
      liveWindows.set(key, liveWindows.has(key) ? -1 : index);
    }
    for (const [key, oldIndex] of oldWindows) {
      const liveIndex = liveWindows.get(key);
      if (oldIndex < 0 || liveIndex === undefined || liveIndex < 0 ||
          !sameNumericOwner(scope, oldLimits[oldIndex], live[liveIndex])) continue;
      matched.set(liveIndex, oldIndex); usedOld.add(oldIndex);
    }
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
    // A Ratio's live annotation array owns an explicit clear. R6-only
    // fields such as text still belong to the identified retained limit.
    if (replacement.scope === "period") delete metadata.extension;
    return { ...metadata, ...replacement } as FhirR6DoseLimit;
  });
  // Keep singular hidden siblings before the edited field. Comparable
  // exact caps still project the tighter value; equal or uncomparable caps
  // keep the edited field as the final tie owner. Period limits retain live order.
  const hiddenByScope = new Map<string, FhirR6DoseLimit[]>();
  const remainingHidden: FhirR6DoseLimit[] = [];
  oldLimits.forEach((limit, index) => {
    if (representable[index] || usedOld.has(index)) return;
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
  // Superseded limits remain in the boundary's existing inactive source
  // snapshot. They must not create a source-only active safety object.
  if (doseLimit.length) return { ...retainedSafety, doseLimit };
  return Object.keys(retainedSafety).length ? retainedSafety : undefined;
}

/**
 * Reconcile the two editable views of safety against the row's saved source.
 * Explicit safety edits win. An unchanged lifted safety copy must not hide a
 * changed/deleted R5 maximum; field-local merging retains R6-only limits and
 * authored safety metadata. This runs only for rows with retained safety.
 */
export function reconcileR5SafetySnapshot(
  row: EzDosage,
  retained: FhirR6DosageSafety,
  baseline: string | undefined
): FhirR6DosageSafety | undefined {
  if (row.safety !== undefined && !equalStructuredValues(row.safety, retained)) return row.safety;
  const partialPeriods = retained.doseLimit?.some(limit => limit.scope === "period" &&
    limit.valueQuantity && limit.period &&
    (limit.valueQuantity.value === undefined || limit.period.value === undefined)) ||
    row.maxDosePerPeriod?.some(ratio => ratio.numerator && ratio.denominator &&
      (ratio.numerator.value === undefined || ratio.denominator.value === undefined));
  const projected = partialPeriods ? toR6Safety(row, true) : r5SafetyBaseline(row);
  const dose = (retained.doseLimit?.length ?? 0) > 1 ? r5MaximumDoseBasis(row.doseAndRate) : undefined;
  // Historical fingerprints omitted partial Ratios and Coding.version.
  // Compare the complete saved wire projection before restoring metadata:
  // unchanged duplicate Ratios retain their distinct authored R6 texts.
  if (partialPeriods || baseline === compactProjectionFingerprint(projected)) {
    const saved: FhirDosage = {}, limits = retained.doseLimit ?? [];
    for (const index of r5ProjectedSafetyLimitIndices(limits, baseline, dose)) {
      const limit = limits[index];
      if (limit.scope === "period")
        (saved.maxDosePerPeriod ??= []).push(periodMaximumToR5(limit.valueQuantity!, limit.period!, limit));
      else if (limit.scope === "administration")
        saved.maxDosePerAdministration = simpleQuantityForR5(limit.valueQuantity);
      else if (limit.scope === "lifetime")
        saved.maxDosePerLifetime = simpleQuantityForR5(limit.valueQuantity);
    }
    if (equalStructuredValues(projected, toR6Safety(saved, true))) return row.safety ?? retained;
  }
  return reconcileR5SafetyEdits(retained, projected, baseline, dose);
}

/** A lifted safety mirror and its R5 maxima are two views of one value.
 * A persisted baseline makes subsequent edits to either view unambiguous. */
const R5_LIFTED_SAFETY_SOURCE_URL =
  "urn:ezmedicationinput:StructureDefinition:r5-lifted-safety-source";
export function reconcileLiftedR5Safety(row: EzDosage): FhirR6DosageSafety | undefined {
  const marker = row.extension?.find(item => item.url === R5_LIFTED_SAFETY_SOURCE_URL);
  if (marker) {
    const saved = decodeR5RetainedFields(marker);
    if (saved.component?.safety)
      return reconcileR5SafetySnapshot(row, saved.component.safety, saved.baseline?.safety);
  }
  // Historical lifted rows did not carry a baseline. Their existing R5
  // maxima retain ownership; a safety-only input is independently authored.
  const projected = toR6Safety(row, true);
  if (!projected || !row.safety) return row.safety;
  const dose = (row.safety.doseLimit?.length ?? 0) > 1 ? r5MaximumDoseBasis(row.doseAndRate) : undefined;
  return reconcileR5SafetyEdits(row.safety, projected, undefined, dose);
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
    const safety=needsSafety?toR6Safety(input,true):undefined;
    const dates=needsDates?getDosageExcludedDates(input):undefined;
    if(!result)result=dosages.slice(0,index);
    const row:EzDosage=Object.assign({},input);
    if(predicate)row.condition=[conditionToR6(predicate)];
    if(safety){
      // These two external editing owners and their saved baseline must not
      // share mutable quantities or Ratio annotations. Copy only lifted external
      // safety fields; ordinary rows and internal native paths do no work.
      const retainedLimits: FhirR6DoseLimit[] = [];
      for (const limit of safety.doseLimit ?? []) {
        const retained = { ...limit };
        if (limit.extension) {
          retained.extension = cloneStructuredValue(limit.extension);
          limit.extension = cloneStructuredValue(limit.extension);
        }
        if (limit.valueQuantity) {
          const quantity = quantityForR6(limit.valueQuantity)!;
          retained.valueQuantity = cloneStructuredValue(quantity);
          limit.valueQuantity = cloneStructuredValue(quantity);
        }
        if (limit.period) {
          const period = quantityForR6(limit.period)!;
          retained.period = cloneStructuredValue(period);
          limit.period = cloneStructuredValue(period);
        }
        retainedLimits.push(retained);
      }
      row.safety=safety;
      row.extension=[...(input.extension??[]).filter(item=>item.url!==R5_LIFTED_SAFETY_SOURCE_URL),{
        url:R5_LIFTED_SAFETY_SOURCE_URL,
        extension:encodeR5RetainedFields({component:{safety:{...safety,doseLimit:retainedLimits}},baseline:{
          safety:compactProjectionFingerprint(safety)
        }})
      }];
    }
    if(dates?.length)row.excludedDates=dates;
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
function hasOtherOwnField(value:FhirR6Extension,second:"extension"|"valueString"):boolean {
  for(const key in value)if(key!=="url"&&key!==second&&Object.prototype.hasOwnProperty.call(value,key))return true;
  return false;
}
export function hasUnrecognizedEditMetadata(marker:FhirExtension):boolean {
  if(hasOtherOwnField(marker,"extension"))return true;
  for(const field of marker.extension??[]){
    if(field.url==="sourceAgreement"||field.url==="sourceTextAgreed"||field.url==="sourceHasStructuredClocks"||field.url==="sourceHasStructuredEvents"||field.url==="sourceHasStructuredSite"){
      if(typeof field.valueBoolean!=="boolean"||Object.keys(field).some(key=>key!=="url"&&key!=="valueBoolean"))return true;
      continue;
    }
    if(field.url==="instruction"||field.url==="textFingerprint"||field.url==="projectionFingerprint"){if(hasOtherOwnField(field,"valueString"))return true;continue;}
    if(field.url!=="row"||hasOtherOwnField(field,"extension"))return true;
    for(const part of field.extension??[]) {
      if(part.url==="sourceAgreement"||part.url==="sourceTextAgreed"||part.url==="sourceHasStructuredClocks"||part.url==="sourceHasStructuredEvents"||part.url==="sourceHasStructuredSite") {
        if(typeof part.valueBoolean!=="boolean"||Object.keys(part).some(key=>key!=="url"&&key!=="valueBoolean"))return true;
      } else if((part.url!=="projectionFingerprint"&&part.url!=="textFingerprint")||hasOtherOwnField(part,"valueString"))return true;
    }
  }
  return false;
}

/** Project Ratio quantities and their annotations through the existing operator
 * boundary; unrelated opaque extension choices retain their supplied fields. */
function ratioForR5(
  ratio: NonNullable<FhirR6Dosage["doseAndRate"]>[number]["rateRatio"]
): FhirRatio | undefined {
  if (!ratio) return undefined;
  const numerator = generalQuantityForR5(ratio.numerator);
  const denominator = simpleQuantityForR5(ratio.denominator);
  const extension = ratio.extension?.length ? quantityAnnotationExtensions(ratio.extension, "r5") : ratio.extension;
  if (numerator === ratio.numerator && denominator === ratio.denominator && extension === ratio.extension)
    return ratio as FhirRatio;
  const projected = { ...ratio };
  if (numerator !== ratio.numerator) projected.numerator = numerator;
  if (denominator !== ratio.denominator) projected.denominator = denominator;
  if (extension !== ratio.extension) projected.extension = extension;
  // Known Quantity choices are converted above; other opaque choices are unchanged.
  return projected as FhirRatio;
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
    let fields: FhirExtension[] | undefined;
    for (let index = 0; index < item.extension.length; index++) {
      const field = item.extension[index];
      const history = field.url === "extension" && field.extension?.length === 1 &&
        field.extension[0].url === DOSAGE_RECONCILIATION_SOURCE_URL ? field.extension[0] : undefined;
      if (!history?.extension) {
        fields?.push(field);
        continue;
      }
      changed = true;
      fields ??= item.extension.slice(0, index);
      // The children have already moved into flat live history. Retain only
      // authored envelope fields here, so an Element ID is not lost or its
      // complete history copied a second time.
      if (hasOtherOwnField(history, "extension") || hasOtherOwnField(field, "extension")) {
        const { extension: _history, ...envelope } = history;
        fields.push({ ...field, extension: [envelope] });
      }
    }
    return fields ? { ...item, extension: fields } : item;
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
export function dosageProjectionFingerprint(dosage:FhirDosage|EzDosage|FhirR6Dosage):string {
  return dosageProjectionHash(dosage, false);
}

/** New agreement excludes narrative annotations; legacy untagged hashes keep
 * their exact saved algorithm. An old hash alone cannot recover prior metadata. */
export function dosageClinicalProjectionFingerprint(dosage: FhirDosage | EzDosage | FhirR6Dosage): string {
  return "clinical-v2:" + dosageProjectionHash(dosage, true);
}

export function matchesDosageProjectionFingerprint(dosage: FhirDosage | EzDosage | FhirR6Dosage, expected: string | undefined): boolean {
  return expected === (expected?.startsWith("clinical-v2:")
    ? dosageClinicalProjectionFingerprint(dosage) : dosageProjectionFingerprint(dosage));
}

function dosageProjectionHash(dosage: FhirDosage | EzDosage | FhirR6Dosage, clinical: boolean): string {
  const state:ProjectionFingerprintState={first:0x811c9dc5,second:0x9e3779b9};
  const record=dosage as Record<string,unknown>;
  const keys=Object.keys(dosage).sort();
  updateProjectionFingerprint(state,"{");
  for(const key of keys){
    if(key==="text"||clinical&&key==="_text")continue;
    const part=record[key];
    if(part===undefined)continue;
    if(Array.isArray(part)&&!part.length){
      const conditionMarker=key==="condition"?dosage.modifierExtension?.find(item=>
        item.url===DOSAGE_CONDITION_R5_URL):undefined;
      const clearsDates=key==="excludedDates"&&
        getDosageExcludedDates({modifierExtension:dosage.modifierExtension}).length>0;
      if(!clearsDates&&(!conditionMarker||parseConditionModifier(conditionMarker)===undefined))continue;
    }
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

/** Source text can be retained without claiming it agrees with current
 * external clinical fields. The compact annotation is local to every row. */
export function getDosageSourceTextFingerprint(dosage: Pick<FhirR6Dosage, "extension">): string | undefined {
  for (const marker of dosage.extension ?? []) {
    if (marker.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL) continue;
    const text = marker.extension?.find(field => field.url === "textFingerprint")?.valueString ??
      marker.extension?.find(field => field.url === "row")?.extension?.find(field => field.url === "textFingerprint")?.valueString;
    if (text !== undefined) return text;
  }
  return undefined;
}
/** The original clinical baseline stays bound to its original narrative across saves. */
export function getDosageSourceProjectionFingerprint(dosage: Pick<FhirR6Dosage, "extension">): string | undefined {
  for (const marker of dosage.extension ?? []) {
    if (marker.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL) continue;
    for (const field of marker.extension ?? []) {
      if (field.url === "projectionFingerprint") return field.valueString;
      if (field.url === "row")
        return field.extension?.find(part => part.url === "projectionFingerprint")?.valueString;
    }
  }
  return undefined;
}
/** An unchanged source may receive its equivalent target-version baseline.
 * Changed clinical fields retain the old hash so saving cannot certify stale text. */
export function retainedSourceProjectionFingerprint(dosage: FhirDosage | EzDosage | FhirR6Dosage): string | undefined {
  const projection = getDosageSourceProjectionFingerprint(dosage);
  return projection !== undefined && dosageMatchesSavedProjection(dosage) === false ? projection : undefined;
}
/** Wording coverage and permission to replay clinical text are distinct.
 * A declared coverage bit follows its exact source; legacy agreement keeps
 * its existing requirement for a saved clinical projection. */
export function dosageHasAgreedSourceText(
  dosage: FhirDosage | EzDosage | FhirR6Dosage
): boolean {
  for (const marker of dosage.extension ?? []) {
    if (marker.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL) continue;
    const fields = marker.extension?.find(field => field.url === "row")?.extension ?? marker.extension;
    const covered = fields?.find(field => field.url === "sourceTextAgreed")?.valueBoolean;
    if (covered !== undefined) {
      const text = fields?.find(field => field.url === "textFingerprint")?.valueString;
      return covered && text !== undefined && text === dosageTextFingerprint(dosage);
    }
  }
  const agreement = getDosageSourceTextAgreement(dosage, false);
  if (agreement === false) return false;
  const text = getDosageSourceTextFingerprint(dosage);
  return text !== undefined && text === dosageTextFingerprint(dosage) &&
    getDosageSourceProjectionFingerprint(dosage) !== undefined &&
    (agreement === true || dosageMatchesSavedProjection(dosage) === true);
}
export function getDosageSourceTextAgreement(
  dosage: Pick<FhirR6Dosage, "extension" | "text">, acceptTextEdits = true
): boolean | undefined {
  for (const marker of dosage.extension ?? []) {
    if (marker.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL) continue;
    const row = marker.extension?.find(field => field.url === "row");
    const agreement = row?.extension?.find(field => field.url === "sourceAgreement")?.valueBoolean ??
      marker.extension?.find(field => field.url === "sourceAgreement")?.valueBoolean;
    if (agreement === undefined) {
      // Coverage alone never licenses clinical source replay.
      if (row?.extension?.some(field => field.url === "sourceTextAgreed" && typeof field.valueBoolean === "boolean") ||
          marker.extension?.some(field => field.url === "sourceTextAgreed" && typeof field.valueBoolean === "boolean")) return false;
      continue;
    }
    if (agreement || !acceptTextEdits) return agreement;
    const text = getDosageSourceTextFingerprint(dosage);
    // Current text can own its explicit replacement without certifying the
    // original serialized instruction graph. Replay callers reject edits.
    return text !== undefined && text !== dosageTextFingerprint(dosage) ? true : false;
  }
  return undefined;
}
/** Source ownership of an immutable parser row. These flags identify the
 * original HPSG projection; no clinical values are copied or watched. */
export interface FreshDoseSource {
  defaulted: boolean;
  clocks: boolean;
  events: boolean;
  site: boolean;
}
const FRESH_HPSG_DOSE_SOURCE = new WeakMap<FhirDosage, FreshDoseSource>();
export function markFreshDoseSource(
  dosage: FhirDosage, defaulted: boolean, sourceTextAgreed = false, sourceTextCovered = false
): void {
  const repeat = dosage.timing?.repeat;
  FRESH_HPSG_DOSE_SOURCE.set(dosage, {
    defaulted,
    clocks: repeat?.timeOfDay !== undefined ? Boolean(repeat.timeOfDay.length) :
      Boolean(repeat?.extension?.some(field =>
        field.url === TIMING_ADDITIONAL_CLOCK_EXTENSION_URL && field.valueTime !== undefined)),
    events: Boolean(repeat?.when?.length),
    site: Boolean(dosage.site),
  });
  if (sourceTextAgreed && dosage.text !== undefined) {
    const fields: FhirExtension[] = [
      { url: "sourceAgreement", valueBoolean: true },
      { url: "textFingerprint", valueString: dosageTextFingerprint(dosage) },
      { url: "projectionFingerprint", valueString: dosageClinicalProjectionFingerprint(dosage) },
    ];
    (dosage.extension ??= []).push({ url: DOSAGE_RENDERED_INSTRUCTION_R5_URL, extension: fields });
  } else if (sourceTextCovered && dosage.text !== undefined) {
    // Generated wording retains fresh parser authority without an edit baseline.
    (dosage.extension ??= []).push({ url: DOSAGE_RENDERED_INSTRUCTION_R5_URL, extension: [
      { url: "sourceAgreement", valueBoolean: true },
      { url: "sourceTextAgreed", valueBoolean: true },
      { url: "textFingerprint", valueString: dosageTextFingerprint(dosage) }
    ] });
  }
}
export function getFreshDoseSource(dosage: FhirDosage): FreshDoseSource | undefined {
  return FRESH_HPSG_DOSE_SOURCE.get(dosage);
}

export interface DosageSourceOwnership { clocks?: boolean; events?: boolean; site?: boolean; }
export function sourceOwnership(marker: FhirR6Extension): DosageSourceOwnership | undefined {
  let result: DosageSourceOwnership | undefined;
  let fields = marker.extension ?? [], local = false;
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!local && field.url === "row") {
      // Only this row's first baseline owns its primary source facts.
      fields = field.extension ?? [];
      index = -1; local = true;
      continue;
    }
    if (typeof field.valueBoolean !== "boolean") continue;
    if (field.url === "sourceHasStructuredClocks") (result ??= {}).clocks = field.valueBoolean;
    else if (field.url === "sourceHasStructuredEvents") (result ??= {}).events = field.valueBoolean;
    else if (field.url === "sourceHasStructuredSite") (result ??= {}).site = field.valueBoolean;
  }
  return result;
}

/** Saved primary-field ownership. Missing evidence never licenses removal
 * of independent clocks, event anchors, or sites supplied only by the graph. */
export function getDosageSourceOwnership(dosage: Pick<FhirR6Dosage, "extension">): DosageSourceOwnership | undefined {
  for (const marker of dosage.extension ?? []) {
    if (marker.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL) continue;
    const value = sourceOwnership(marker);
    if (value !== undefined) return value;
  }
  return undefined;
}
/** Known agreement remains owned even when its source Element has annotations. */
export function isSourceAgreementMarker(marker: FhirExtension): boolean {
  return marker.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL &&
    Boolean(marker.extension?.some(field => (field.url === "sourceAgreement" || field.url === "sourceTextAgreed") &&
      typeof field.valueBoolean === "boolean"));
}
export function isCompactSourceAgreementMarker(marker: FhirExtension | FhirR6Extension): boolean {
  if (marker.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL || Object.keys(marker).length !== 2 ||
      !marker.extension?.length || marker.extension.length > 7) return false;
  let fields = 0;
  for (const field of marker.extension) {
    if (Object.keys(field).length !== 2) return false;
    if (field.url === "sourceAgreement" && typeof field.valueBoolean === "boolean" && !(fields & 1)) fields |= 1;
    else if (field.url === "textFingerprint" && typeof field.valueString === "string" && !(fields & 2)) fields |= 2;
    else if (field.url === "projectionFingerprint" && typeof field.valueString === "string" && !(fields & 4)) fields |= 4;
    else if (field.url === "sourceHasStructuredClocks" && typeof field.valueBoolean === "boolean" && !(fields & 8)) fields |= 8;
    else if (field.url === "sourceHasStructuredEvents" && typeof field.valueBoolean === "boolean" && !(fields & 16)) fields |= 16;
    else if (field.url === "sourceHasStructuredSite" && typeof field.valueBoolean === "boolean" && !(fields & 32)) fields |= 32;
    else if (field.url === "sourceTextAgreed" && typeof field.valueBoolean === "boolean" && !(fields & 64)) fields |= 64;
    else return false;
  }
  return Boolean(fields & 65);
}

// Submitted rows are immutable by caller contract. A new supplied object
// receives its own first-read comparison with its persisted source fingerprint.
const SAVED_PROJECTION_MATCHES = new WeakMap<FhirDosage | EzDosage | FhirR6Dosage, boolean>();

/** Verify each immutable submitted dosage's source clinical authority once.
 * Missing provenance is unknown, not a mismatch. Fresh submissions always
 * compare their current fields with the retained projection fingerprint. */
export function dosageMatchesSavedProjection(dosage: FhirDosage | EzDosage | FhirR6Dosage): boolean | undefined {
  const cached = SAVED_PROJECTION_MATCHES.get(dosage);
  if (cached !== undefined) return cached;
  if (getDosageSourceTextAgreement(dosage, false) === false) {
    SAVED_PROJECTION_MATCHES.set(dosage, false);
    return false;
  }
  const projection = getDosageSourceProjectionFingerprint(dosage);
  if (projection !== undefined) {
    const matches = matchesDosageProjectionFingerprint(dosage, projection);
    SAVED_PROJECTION_MATCHES.set(dosage, matches);
    return matches;
  }
  // Older detached clock rows declared primary source ownership without a
  // local clinical baseline. That declaration cannot verify replay against
  // current clocks; retain the source while rendering the submitted fields.
  if (getDosageSourceOwnership(dosage)?.clocks) {
    SAVED_PROJECTION_MATCHES.set(dosage, false);
    return false;
  }
  return undefined;
}

export function dosageTextFingerprint(dosage: FhirDosage | EzDosage | FhirR6Dosage): string {
  return compactProjectionFingerprint(dosage.text ?? null);
}

/**
 * Attach source/display provenance using repeated, structured row extensions.
 * Both primary parser output and strict R5 export use this same representation.
 * @param dosages Independently editable rows being returned to the caller.
 * @param instruction The author's unmodified instruction, when supplied.
 * @param sourceAgreement Whether the producer established that wording agrees with the clinical fields.
 */
export interface DosageSourceTextBaseline {
  sourceAgreement: boolean;
  sourceTextAgreed?: boolean;
  projectionFingerprint?: string;
  textFingerprint?: string;
  sourceHasStructuredClocks?: boolean;
  sourceHasStructuredEvents?: boolean;
  sourceHasStructuredSite?: boolean;
}
export function withDosageEditProvenance<T extends FhirDosage|EzDosage>(
  dosages: readonly T[], instruction: string | undefined, sourceAgreement = true,
  rowSources?: readonly (DosageSourceTextBaseline | undefined)[], headerCovered = false
): T[] {
  if (!dosages.length) return [];
  const children: FhirExtension[] = instruction !== undefined ? [{ url: "instruction", valueString: instruction }] : [];
  if (!sourceAgreement || rowSources) children.push({ url: "sourceAgreement", valueBoolean: sourceAgreement });
  if (headerCovered) children.push({ url: "sourceTextAgreed", valueBoolean: true });
  const result: T[] = new Array(dosages.length);
  const placeMarker = (row: T, marker: FhirExtension | undefined, baseline: FhirExtension[],
    original: DosageSourceTextBaseline | undefined, keepLocalOwnership: boolean,
    rowAgreement: boolean, sourceText: string): T => {
    const extension: FhirExtension[] | undefined = marker || keepLocalOwnership ? [] : undefined;
    let sourceClocks = original?.sourceHasStructuredClocks,
      sourceEvents = original?.sourceHasStructuredEvents,
      sourceSite = original?.sourceHasStructuredSite, graph = false;
    for (const prior of row.extension ?? []) {
      if (prior.url === MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL) graph = true;
      if (prior.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL &&
          (sourceClocks === undefined || sourceEvents === undefined || sourceSite === undefined)) {
        const ownership = sourceOwnership(prior);
        sourceClocks ??= ownership?.clocks;
        sourceEvents ??= ownership?.events;
        sourceSite ??= ownership?.site;
      }
      if (!extension) continue;
      const ownedBaseline = isRenderedInstructionMarker(prior) || isSourceAgreementMarker(prior);
      if (!ownedBaseline) extension.push(prior);
      else if (hasUnrecognizedEditMetadata(prior))
        extension.push({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [prior] });
    }
    if (graph) {
      sourceClocks ??= Boolean(getTimingClocks(row.timing?.repeat)?.length);
      sourceEvents ??= Boolean(row.timing?.repeat?.when?.length);
      sourceSite ??= Boolean(row.site);
    }
    if (sourceClocks !== undefined) baseline.push({ url: "sourceHasStructuredClocks", valueBoolean: sourceClocks });
    if (sourceEvents !== undefined) baseline.push({ url: "sourceHasStructuredEvents", valueBoolean: sourceEvents });
    if (sourceSite !== undefined) baseline.push({ url: "sourceHasStructuredSite", valueBoolean: sourceSite });
    if (!marker && keepLocalOwnership && (sourceClocks !== undefined || sourceEvents !== undefined || sourceSite !== undefined)) {
      const fields: FhirExtension[] = [
        { url: "sourceAgreement", valueBoolean: rowAgreement },
        { url: "textFingerprint", valueString: sourceText },
      ];
      if (sourceClocks !== undefined) fields.push({ url: "sourceHasStructuredClocks", valueBoolean: sourceClocks });
      if (sourceEvents !== undefined) fields.push({ url: "sourceHasStructuredEvents", valueBoolean: sourceEvents });
      if (sourceSite !== undefined) fields.push({ url: "sourceHasStructuredSite", valueBoolean: sourceSite });
      marker = { url: DOSAGE_RENDERED_INSTRUCTION_R5_URL, extension: fields };
    }
    if (!marker || !extension) return row;
    extension.push(marker);
    return Object.assign({}, row, { extension });
  };
  for (let index = 0; index < dosages.length; index++) {
    let row = dosages[index];
    const original = rowSources?.[index];
    // Clause-local qualifiers acquire their final row identity where the
    // complete source baseline is written. Preserve every other typed child.
    const compact = compactCourseMarker(row);
    const position = compact?.extension?.find(child => child.url === "rowIndex");
    if (position?.valueInteger !== undefined && position.valueInteger !== index) {
      const marker = { ...compact!, extension: compact!.extension!.map(child =>
        child === position ? { ...child, valueInteger: index } : child) };
      row = Object.assign({}, row, { modifierExtension: row.modifierExtension!.map(child =>
        child === compact ? marker : child) });
    }
    result[index] = row;
    if (instruction === undefined && row.text === undefined) {
      if (original?.sourceHasStructuredClocks !== undefined || original?.sourceHasStructuredEvents !== undefined ||
          original?.sourceHasStructuredSite !== undefined) {
        // Source ownership survives when an earlier clinical edit retired stale
        // wording. This marker carries no text or new projection fingerprint.
        const fields: FhirExtension[] = [{ url: "sourceAgreement", valueBoolean: false }];
        result[index] = placeMarker(row, { url: DOSAGE_RENDERED_INSTRUCTION_R5_URL, extension: fields },
          fields, original, false, false, "");
      }
      continue;
    }
    const rowAgreement = original?.sourceAgreement ?? sourceAgreement;
    const currentText = dosageTextFingerprint(row);
    const sourceText = original?.textFingerprint ?? currentText;
    const sourceCovered = original?.sourceTextAgreed === true || dosageHasAgreedSourceText(row);
    const sourceTextAgreed = rowAgreement && sourceCovered;
    // The final producer establishes its current row baseline. Only an imported
    // native source can explicitly retain an older clinical agreement.
    const priorProjection = original?.projectionFingerprint;
    const localReplay = row.text !== undefined && Boolean(sourceTextAgreed || row.maxDosePerPeriod?.length ||
      row.maxDosePerAdministration || row.maxDosePerLifetime || (row as EzDosage).safety ||
      getTimingClocks(row.timing?.repeat)?.length);
    const baseline: FhirExtension[] = [{ url: "textFingerprint", valueString: currentText }];
    if (sourceCovered && !rowAgreement && index === 0 && instruction !== undefined)
      baseline.push({ url: "sourceTextAgreed", valueBoolean: true });
    // Preserve explicit established agreement even when the header has the
    // same default; legacy implicit agreement requires a current clinical match.
    if (instruction !== undefined && (rowAgreement !== sourceAgreement || rowAgreement &&
        (original?.sourceTextAgreed || sourceTextAgreed && getDosageSourceTextAgreement(row, false) === true)))
      baseline.push({ url: "sourceAgreement", valueBoolean: rowAgreement });
    const local = row.text !== undefined && (!rowAgreement || !sourceAgreement || localReplay) &&
      (index > 0 || instruction === undefined);
    const localFields: FhirExtension[] | undefined = local ? [] : undefined;
    if (localFields) {
      if (rowAgreement || !sourceCovered)
        localFields.push({ url: "sourceAgreement", valueBoolean: rowAgreement });
      localFields.push({ url: "textFingerprint", valueString: sourceText });
      if (sourceCovered) localFields.push({ url: "sourceTextAgreed", valueBoolean: true });
    }
    const marker = instruction !== undefined && index === 0
      ? { url: DOSAGE_RENDERED_INSTRUCTION_R5_URL, extension: children }
      : localFields ? { url: DOSAGE_RENDERED_INSTRUCTION_R5_URL, extension: localFields } : undefined;
    // Retired annotated markers are part of the returned row before its one
    // clinical fingerprint. The newly placed baseline itself is excluded.
    row = placeMarker(row, marker, baseline, original, index > 0 || instruction === undefined,
      rowAgreement, sourceText);
    if (localFields)
      for (const field of baseline)
        if (field.url === "sourceHasStructuredClocks" || field.url === "sourceHasStructuredEvents" ||
            field.url === "sourceHasStructuredSite") localFields.push(field);
    result[index] = row;
    const projection = priorProjection ?? (instruction !== undefined || localReplay ? dosageClinicalProjectionFingerprint(row) : undefined);
    if (instruction !== undefined) {
      if (index === 0 && !rowAgreement) children.push({ url: "textFingerprint", valueString: sourceText });
      baseline.unshift({ url: "projectionFingerprint", valueString: projection });
      children.push({ url: "row", extension: baseline });
    }
    if (localReplay && localFields) localFields.push({ url: "projectionFingerprint", valueString: projection });
  }
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
export function projectEditableR5Course(details:FhirR6DosageInstructionInput,strictPreview=false):{
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
export function fromDosageDetails(details: FhirR6DosageInstructionInput): {
  dosages: EzDosage[]; course: EzCourseMetadata;
} {
  const projected = projectEditableR5Course(details);
  return details.renderedInstruction === undefined ? projected : {
    ...projected,
    dosages: withDosageEditProvenance(projected.dosages, details.renderedInstruction, false, undefined,
      dosageHasAgreedSourceText({ text: details.renderedInstruction, extension: details.extension }))
  };
}

/** Requested R5 export: either input version is imported into native
 * clinical facts, then written directly to R5. Neither external format is an
 * intermediate representation for the other. */
export function toFhirR5Dosages(input:FhirR6DosageInstructionInput|readonly(FhirDosage|EzDosage)[],
  metadata?:EzCourseMetadata):FhirDosage[] {
  const native=Array.isArray(input)?courseFromR5(input,undefined,metadata)
    :courseFromR6(input as FhirR6DosageInstructionInput);
  return projectNativeR5Course(native).dosages;
}

/** R5-only fields whose original R6 spelling or metadata needs a local delta. */
export interface ComponentDeltaBaseline {
  condition?: string;
  safety?: string;
  site?: string;
  doseAndRate?: Array<{ dose?: string; rate?: string; doseExpression?: string; rateExpression?: string; expressionSlot?: boolean }>;
  timing?: string;
}

/** Each marker belongs to its live row, never to another component's snapshot. */
export interface CompactCourseRow {
  rowIndex: number;
  sequence: number;
  stepCount: number;
  /** Current saved-row contract: step.count repeats only that step. */
  countScope?: "step";
  step?: Omit<FhirR6DosageStep, "component">;
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

/** Period-local offsets are measured within the cadence period. A frequency
 * edit does not change that window while the R6 frequency > 1 constraint holds. */
export function offsetCadenceFingerprint(
  timing: FhirDosage["timing"] | FhirR6Dosage["timing"]
): string {
  const repeat = timing?.repeat;
  const period = "p:" + compactProjectionFingerprint({
    period: repeat?.period, periodMax: repeat?.periodMax, periodUnit: repeat?.periodUnit
  });
  // Incomplete external timing remains editable with its original offsets.
  // Only that exceptional source needs its original cadence observation too.
  return repeat?.frequency !== undefined && repeat.frequency > 1 && repeat.period !== undefined
    ? period : period + ":c:" + completeOffsetCadenceFingerprint(timing);
}
function completeOffsetCadenceFingerprint(
  timing: FhirDosage["timing"] | FhirR6Dosage["timing"]
): string {
  const repeat = timing?.repeat;
  return compactProjectionFingerprint({
    frequency: repeat?.frequency, frequencyMax: repeat?.frequencyMax,
    period: repeat?.period, periodMax: repeat?.periodMax, periodUnit: repeat?.periodUnit
  });
}
export function matchesOffsetCadence(
  timing: FhirDosage["timing"] | FhirR6Dosage["timing"], baseline: string | undefined
): boolean {
  if (baseline?.startsWith("p:")) {
    const current = offsetCadenceFingerprint(timing);
    return baseline === current || !current.includes(":c:") && baseline.startsWith(current + ":c:");
  }
  // Persisted rows written before period-only observations still prove their
  // unchanged cadence. Their hash cannot establish a changed period separately.
  return baseline === completeOffsetCadenceFingerprint(timing);
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
  const extension = encodeFields(retained, COMPACT_ROW);
  // The encoded children are already fresh output. Add current semantics
  // there instead of copying the complete retained row just for one field.
  if (retained.countScope === undefined) extension.push({ url: "countScope", valueCode: "step" });
  replacementExtensions(row, DOSAGE_DETAILS_R5_URL, { url: DOSAGE_DETAILS_R5_URL, extension });
}
/** Qualifiers in SimpleQuantity cannot be ignored as exact numeric doses.
 * The clause writer calls this only after finding a typed qualifier, using the
 * same modifier and edit baseline as the direct native R5 writer. */
export function attachQualifiedR5AmountDetails(row: FhirDosage): void {
  const amounts = row.doseAndRate;
  if (!amounts?.some(value =>
    getEmaQuantityComparator(value.doseQuantity) || getEmaQuantityComparator(value.doseRange?.low) ||
    getEmaQuantityComparator(value.doseRange?.high) || getEmaQuantityComparator(value.rateQuantity) ||
    getEmaQuantityComparator(value.rateRange?.low) || getEmaQuantityComparator(value.rateRange?.high) ||
    getEmaQuantityComparator(value.rateRatio?.denominator) ||
    !value.rateRatio?.numerator?.comparator && getEmaQuantityComparator(value.rateRatio?.numerator))) return;
  attachR5RetainedRow(row, {
    rowIndex: 0, sequence: row.sequence ?? 1, stepCount: row.sequence ?? 1,
    component: { doseAndRate: amounts },
    baseline: { doseAndRate: amounts.map(value => ({
      ...(value.doseQuantity || value.doseRange ? { dose: compactProjectionFingerprint({
        doseQuantity: value.doseQuantity, doseRange: value.doseRange
      }) } : {}),
      ...(value.rateQuantity || value.rateRange || value.rateRatio ? { rate: compactProjectionFingerprint({
        rateQuantity: value.rateQuantity, rateRange: value.rateRange, rateRatio: value.rateRatio
      }) } : {})
    })) }
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
export function decodeR5RetainedFields(marker:FhirR6Extension):Partial<CompactCourseRow> {
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
  live: readonly NonNullable<FhirR6Dosage["doseAndRate"]>[number][],
  baselines?: ComponentDeltaBaseline["doseAndRate"]
): Map<number, number> {
  const identity = (entry: typeof source[number]): string | undefined => {
    if (entry.id) return "id:" + entry.id;
    if (entry.type) return "type:" + compactProjectionFingerprint(entry.type);
    const slot = entry.extension?.find(item => item.url === R5_EXPRESSION_SLOT_SOURCE_URL);
    const dose = entry.doseExpression ?? slot?.extension?.find(item => item.url === "doseExpression")?.valueExpression;
    const rate = entry.rateExpression ?? slot?.extension?.find(item => item.url === "rateExpression")?.valueExpression;
    return dose || rate ? "expression:" + compactProjectionFingerprint({ dose, rate }) : undefined;
  };
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
  // A retained expression can have an ordinary representable sibling rate
  // (or dose). Its baseline belongs to the slot, and distinguishes reordered
  // anonymous entries without copying a second full source administration.
  let oldProjectionKeys: Array<string | undefined> | undefined;
  let liveProjectionKeys: Array<string | undefined> | undefined;
  let unchangedProjectionOrder = source.length === live.length;
  if (baselines) {
    const empty = compactProjectionFingerprint({});
    const projectionKey = (entry: typeof source[number], baseline: NonNullable<typeof baselines>[number] | undefined) => {
      const dose = baseline?.dose ?? empty, rate = baseline?.rate ?? empty;
      if (dose === empty && rate === empty) return undefined;
      return (entry.id ? "id:" + entry.id : entry.type ? "type:" + compactProjectionFingerprint(entry.type) : "") +
        "|" + dose + "|" + rate;
    };
    oldProjectionKeys = source.map((entry, index) => projectionKey(entry, baselines[index]));
    liveProjectionKeys = live.map((entry, index) => {
      const key = projectionKey(entry, {
        dose: compactProjectionFingerprint({ doseQuantity: simpleQuantityForR5(entry.doseQuantity), doseRange: entry.doseRange }),
        rate: compactProjectionFingerprint({ rateQuantity: simpleQuantityForR5(entry.rateQuantity), rateRange: entry.rateRange, rateRatio: entry.rateRatio }),
      });
      // An established same-position identity owns its own edits; only the
      // residual anonymous slots need unchanged projected ordering.
      if (matches.get(index) !== index && key !== oldProjectionKeys![index]) unchangedProjectionOrder = false;
      return key;
    });
    const oldProjected = new Map<string, number>(), liveProjected = new Map<string, number>();
    oldProjectionKeys.forEach((key, index) => {
      if (key && !used.has(index)) oldProjected.set(key, oldProjected.has(key) ? -1 : index);
    });
    liveProjectionKeys.forEach((key, index) => {
      if (key && !matches.has(index)) liveProjected.set(key, liveProjected.has(key) ? -1 : index);
    });
    for (const [key, oldIndex] of oldProjected) {
      const liveIndex = liveProjected.get(key);
      if (oldIndex < 0 || liveIndex === undefined || liveIndex < 0) continue;
      matches.set(liveIndex, oldIndex);
      used.add(oldIndex);
    }
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
  // Unchanged projected lists retain conventional ordering for anonymous
  // duplicate entries. Once numeric slots change, an unmatched keyed entry
  // has no proven association; keep its expression inert instead of guessing.
  // One anonymous source slot is unambiguous when its rate changes or it
  // receives its first Element.id; an existing source ID must still match. Each
  // individual dose/rate choice still passes its own edit reconciliation.
  if (source.length === live.length) {
    for (let i = 0; i < live.length; i++) {
      if (matches.has(i) || used.has(i) ||
          source[i]?.id || source.length > 1 && live[i]?.id ||
          source.length > 1 && oldProjectionKeys?.[i] !== undefined && (!unchangedProjectionOrder || oldProjectionKeys[i] !== liveProjectionKeys?.[i]) ||
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
  // The generated extension was the editable owner of an otherwise empty
  // expression-only slot. Removing it replaces that slot; its old expression
  // remains source provenance even when a new rate occupies the same position.
  if (baselines) for (const [liveIndex, sourceIndex] of matches)
    if (baselines[sourceIndex]?.expressionSlot &&
        !live[liveIndex].extension?.some(item => item.url === R5_EXPRESSION_SLOT_SOURCE_URL))
      matches.delete(liveIndex);
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
  for (const step of course.step ?? []) for (const component of step.component) {
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
  legacyValue?: ValueField;
  fields?: BridgeShape;
  repeated?: boolean;
  extension?: boolean;
  quantity?: true | "simple";
}
type BridgeShape = Readonly<Record<string, BridgeField>>;

/** Companion slots of the scalar choices declared by the typed bridge. */
function bridgePrimitiveCompanion(value: ValueField | undefined) {
  switch (value) {
    case "valueString": return "_valueString" as const;
    case "valueCode": return "_valueCode" as const;
    case "valueInteger": return "_valueInteger" as const;
    case "valueBoolean": return "_valueBoolean" as const;
    case "valueDecimal": return "_valueDecimal" as const;
    case "valueMarkdown": return "_valueMarkdown" as const;
    case "valueTime": return "_valueTime" as const;
    default: return undefined;
  }
}

const ELEMENT: BridgeShape = {
  id: { value: "valueString" },
  extension: { extension: true, repeated: true },
  modifierExtension: { extension: true, repeated: true }
};
const QUANTITY: BridgeField = { quantity: true };
const SIMPLE_QUANTITY: BridgeField = { quantity: "simple" };
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
  ifExceeded: { value: "valueString", legacyValue: "valueCode" },
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
    doseQuantity: SIMPLE_QUANTITY,
    doseExpression: { value: "valueExpression" },
    // A nested R6 numerator may carry "~", which is not legal inside
    // R5 Extension.valueRatio; reuse the typed Quantity codec.
    rateRatio: { fields: {
      ...ELEMENT, numerator: QUANTITY, denominator: { value: "valueQuantity" }
    } },
    rateRange: { value: "valueRange" },
    rateQuantity: SIMPLE_QUANTITY,
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
  countScope: { value: "valueCode" },
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
      dose: { value: "valueString" }, rate: { value: "valueString" },
      doseExpression: { value: "valueString" }, rateExpression: { value: "valueString" },
      expressionSlot: { value: "valueBoolean" }
    } }
  } },
  context: { value: "valueString" },
  contextRequired: { value: "valueBoolean" },
  course: { fields: COURSE },
  emptyStep: { fields: COURSE_STEP, repeated: true },
  missingContext: { value: "valueString", repeated: true }
};
/** Inactive R6 wire stages and lifted safety use the same named datatype
 * codec as the external course bridge. No native model or serialized text is
 * stored in these source records. Typed wire leaves are detached while encoding
 * the comparison snapshot, so an in-memory FHIR edit cannot mutate its baseline. */
const R6_DRAFT_SOURCE: BridgeShape = {
  drafts: { repeated: true, fields: {
    index: { value: "valueInteger" }, step: { fields: STEP }
  } },
  synthesizedStarts: { value: "valueInteger", repeated: true },
  projected: { fields: STEP, repeated: true }
};
const R6_SINGLE_SAFETY_SOURCE: BridgeShape = {
  course: { fields: SAFETY }, step: { fields: SAFETY }, projected: { fields: SAFETY },
  ownerId: { value: "valueString" }, ownerComponentIds: { value: "valueString", repeated: true },
  ownerFingerprint: { value: "valueString" }
};

export function encodeR6SourceMetadata(
  url: string, value: object, kind: "drafts" | "safety" | "step"
): FhirExtension {
  return { url, extension: encodeFields(value,
    kind === "drafts" ? R6_DRAFT_SOURCE : kind === "step" ? STEP : R6_SINGLE_SAFETY_SOURCE,
    true, kind !== "step") };
}

export function decodeR6SourceMetadata(
  marker: FhirR6Extension, kind: "drafts" | "safety" | "step"
): Record<string, unknown> | undefined {
  if (!marker.extension || marker.valueString !== undefined) return undefined;
  // Source snapshots are compared with live R6 wire objects. Every Quantity
  // keeps its supplied EMA/native spelling; ordinary R5 imports normalize it.
  return decodeFields(marker.extension,
    kind === "drafts" ? R6_DRAFT_SOURCE : kind === "step" ? STEP : R6_SINGLE_SAFETY_SOURCE,
    kind === "step" ? "simple" : true);
}

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
export function retainField(url: string, value: unknown): FhirExtension {
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

/** Restore one retained name/value pair as a literal enumerable field. */
function restoreRetainedField(result: Record<string, unknown>, child: FhirR6Extension): void {
  const name = child.extension?.find(part => part.url === "name")?.valueString;
  const value = child.extension?.find(part => part.url === "value");
  if (name !== undefined && value) Object.defineProperty(result, name, {
    value: readRetainedField(value), enumerable: true, writable: true, configurable: true
  });
}

/** Read retained fields without evaluating them or reparsing serialized text.
 * @param node One preserved field extension.
 */
export function readRetainedField(node: FhirR6Extension): unknown {
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
    restoreRetainedField(result, child);
  }
  return result;
}

/** Map a typed object into named FHIR children. Unfamiliar Extension objects are
 * copied intact under their source slot, including their original URLs/types.
 * @param value Source object.
 * @param shape Declared semantic fields for this backbone.
 */
function encodeFields(
  value: object, shape: BridgeShape, snapshot = false, preserveQuantityWire = false
): FhirExtension[] {
  const children: FhirExtension[] = [];
  // Safety policies and predicates have a declared semantic field order.
  // Keep generated bridges stable and unfamiliar source fields after them.
  const orderedFields = shape === SAFETY || shape === PREDICATE;
  const keys = Object.keys(orderedFields ? shape : value);
  if (orderedFields) for (const key of Object.keys(value))
    if (!Object.prototype.hasOwnProperty.call(shape, key)) keys.push(key);
  const source = value as Record<string, unknown>;
  for (let key of keys) {
    if (key.startsWith("_")) {
      const scalar = key.slice(1), field = shape[scalar];
      if (field && !field.repeated && bridgePrimitiveCompanion(field.value)) {
        if (Object.prototype.hasOwnProperty.call(source, scalar) || orderedFields) continue;
        key = scalar;
      }
    }
    const part = source[key];
    if (part === undefined && source[`_${key}`] === undefined) continue;
    const field = Object.prototype.hasOwnProperty.call(shape, key) ? shape[key] : undefined;
    const primitiveField = field?.value && !field.repeated ? bridgePrimitiveCompanion(field.value) : undefined;
    const companion = primitiveField ? source[`_${key}`] : undefined;
    if (part === undefined && companion === undefined) continue;
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
    const values = field.repeated && Array.isArray(part) ? part : undefined;
    const count = values ? values.length : 1;
    for (let index = 0; index < count; index++) {
      const item = values ? values[index] : part;
      if (field.extension) {
        const extension = preserveQuantityWire ? item as FhirR6Extension :
          quantityAnnotationExtensions([item as FhirR6Extension], "r5")[0];
        children.push({ url: key, extension: [
          (snapshot ? cloneStructuredValue(extension) : extension) as FhirExtension,
        ] });
      } else if (field.fields) {
        children.push({ url: key, extension: encodeFields(item as object, field.fields, snapshot, preserveQuantityWire) });
      } else if (field.quantity) {
        // General R5 Quantity supports <, <=, >, >=, ad natively.
        // SimpleQuantity roles require EMA for every operator; general
        // Quantity needs it only for approximation. The retained field's
        // declared role must survive decode/re-encode without false edits.
        const quantity = preserveQuantityWire ? item as FhirR6Quantity : field.quantity === "simple"
          ? simpleQuantityForR5(item as FhirR6Quantity)
          : generalQuantityForR5(item as FhirR6Quantity);
        // A source record keeps the supplied R6 spelling, including "~";
        // the shared Extension leaf type is narrower than retained wire data.
        // Only active R5 clinical projections normalize through the converters.
        children.push({ url: key, valueQuantity:
          (snapshot ? cloneStructuredValue(quantity) : quantity) as FhirQuantity | undefined });
      } else if (field.value) {
        let child: FhirExtension = item === undefined ? { url: key }
          : { url: key, [field.value]: item };
        if (companion !== undefined) {
          child = { ...child, [primitiveField!]: companion };
          if (!preserveQuantityWire)
            child = quantityAnnotationExtensions([child], "r5")[0] as FhirExtension;
        }
        children.push(snapshot ? cloneStructuredValue(child) : child);
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
function decodeFields(
  children: readonly FhirR6Extension[], shape: BridgeShape, preserveQuantityWire: boolean | "simple" = false
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const child of children) {
    if (child.url === "empty") continue;
    if (child.url === "emptyArray" && child.valueCode && shape[child.valueCode]?.repeated) {
      result[child.valueCode] = []; continue;
    }
    if (child.url === "retainedField") {
      restoreRetainedField(result, child);
      continue;
    }
    const field = Object.prototype.hasOwnProperty.call(shape, child.url) ? shape[child.url] : undefined;
    if (!field) {
      // Unknown bridge children retain their original context as provenance.
      const extensions = (result.extension ??= []) as FhirR6Extension[];
      extensions.push({ url: "urn:ezmedicationinput:StructureDefinition:medication-unrecognized-bridge-field",
        extension: [cloneStructuredValue(child)] });
      continue;
    }
    let value: unknown;
    if (field.extension) {
      const extensions = child.extension && !preserveQuantityWire
        ? quantityAnnotationExtensions(child.extension, "r6") : child.extension;
      value = extensions?.[0] && cloneStructuredValue(extensions[0]);
    } else if (field.fields) {
      // Older saved rateRatio bridges used FHIR Extension.valueRatio.
      // New nested field shapes take precedence when both are present.
      value = child.extension
        ? decodeFields(child.extension, field.fields, preserveQuantityWire)
        : child.url === "rateRatio" && child.valueRatio
          ? child.valueRatio : undefined;
    }
    else if (field.quantity) {
      value = child.valueQuantity && (preserveQuantityWire === true ||
        preserveQuantityWire === "simple" && field.quantity === "simple"
        ? cloneStructuredValue(child.valueQuantity)
        : quantityFromR5(cloneStructuredValue(child.valueQuantity)));
      if (!value && child.extension) {
        // Read previous versions of our bridge without emitting that old
        // private comparator-child representation on any new export.
        const quantity = child.extension.find(part => part.url === "quantity")?.valueQuantity;
        const comparator = child.extension.find(part => part.url === "comparator")?.valueCode;
        if (quantity) value = { ...cloneStructuredValue(quantity),
          ...(comparator ? { comparator } : {}) };
      }
    } else if (field.value) {
      const primaryCompanion = !field.repeated ? bridgePrimitiveCompanion(field.value) : undefined;
      const selected = child[field.value] !== undefined || primaryCompanion && child[primaryCompanion] !== undefined
        ? field.value : field.legacyValue ?? field.value;
      value = cloneStructuredValue(child[selected]);
      const primitiveField = !field.repeated ? bridgePrimitiveCompanion(selected) : undefined;
      if (primitiveField && child[primitiveField] !== undefined) {
        const current = preserveQuantityWire ? child : quantityAnnotationExtensions([child], "r6")[0];
        result[`_${child.url}`] = cloneStructuredValue(current[primitiveField]);
      }
    }
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
function decodeConditionPredicate(node: FhirR6Extension): unknown {
  return node.extension && node.valueString === undefined ? decodeFields(node.extension, PREDICATE) : undefined;
}

/** Preserve unmatched step metadata as structured source, not JSON text.
 * @param step Original editable course-step metadata.
 */
function encodeCourseStepSource(step: EzCourseStep): FhirExtension[] {
  return encodeFields(step, COURSE_STEP);
}
