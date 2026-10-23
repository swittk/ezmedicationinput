import type {
  FhirExtension, FhirR6DosageDetails, FhirR6Quantity, MedicationCondition,
  EzCourseStep
} from "./types";
import { cloneStructuredValue } from "./stable-structure";

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
      extensions.push({ url: "https://github.com/swittk/ezmedicationinput/fhir/StructureDefinition/medication-unrecognized-bridge-field",
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

/** Encode the complete R6 course using named, typed R5 extension children.
 * @param details Course whose step/component semantics must survive R5 storage.
 */
export function encodeCourseDetails(details: FhirR6DosageDetails): FhirExtension {
  return { url: "dosageDetails", extension: encodeFields(details, COURSE) };
}

/** Recover a course from a structured extension, leaving malformed originals
 * with the caller for preservation. No string payload is interpreted here.
 * @param node The dosageDetails extension child.
 */
export function decodeCourseDetails(node: FhirExtension): FhirR6DosageDetails | undefined {
  if (!node.extension || node.valueString !== undefined) return undefined;
  const value = decodeFields(node.extension, COURSE);
  if (!Array.isArray(value.step) || !value.step.every(step =>
    step && typeof step === "object" && Array.isArray(step.component))) return undefined;
  return { ...value, step: value.step } as FhirR6DosageDetails;
}

/** Encode a Boolean predicate with explicit all/any/not child relationships.
 * @param condition Typed predicate supplied by the HPSG or external API.
 */
export function encodeConditionPredicate(condition: MedicationCondition): FhirExtension {
  return { url: "predicate", extension: encodeFields(condition, PREDICATE) };
}

/** Decode structural predicate fields; the caller checks the small predicate
 * union before using them as meaning and preserves unfamiliar input unchanged.
 * @param node The predicate child extension.
 */
export function decodeConditionPredicate(node: FhirExtension): unknown {
  return node.extension && node.valueString === undefined ? decodeFields(node.extension, PREDICATE) : undefined;
}

/** Preserve unmatched step metadata as structured source, not JSON text.
 * @param step Original editable course-step metadata.
 */
export function encodeCourseStepSource(step: EzCourseStep): FhirExtension[] {
  return encodeFields(step, COURSE_STEP);
}
