/** Established EMA SPOR Quantity Operator representation for R5 quantities.
 *
 * R5 Dosage.doseAndRate.doseQuantity / rateQuantity use SimpleQuantity,
 * which has no comparator field. EMA's published comparator extension is
 * applicable to Element and preserves the qualifier without erasing the
 * numeric dose. General Quantity supports native comparators; SimpleQuantity
 * remains comparator-free in both R5 and R6.
 *
 * Sources:
 * EMA http://ema.europa.eu/fhir/extension/comparator
 * EMA http://spor.ema.europa.eu/v1/lists/100000000008
 * HL7 http://hl7.org/fhir/quantity-comparator
 */
/** Inactive retained wire data is shared by the version-boundary codecs.
 * Keep this identifier in the leaf codec so annotation conversion does not
 * initialize the course importer or clinical grammar. */
export const DOSAGE_RECONCILIATION_SOURCE_URL =
  "urn:ezmedicationinput:StructureDefinition:medication-course-reconciliation-source";
import type { FhirQuantity, FhirR6Quantity, FhirSimpleQuantity,
  FhirR6SimpleQuantity, FhirR6Period, FhirR6Coding, FhirR6CodeableConcept, FhirR6Reference, FhirR6Extension, FhirPrimitiveElement, FhirR6PrimitiveElement } from "./types";

export const EMA_QUANTITY_COMPARATOR_EXTENSION_URL =
  "http://ema.europa.eu/fhir/extension/comparator";
export const EMA_QUANTITY_OPERATOR_SYSTEM =
  "http://spor.ema.europa.eu/v1/lists/100000000008";
export const FHIR_QUANTITY_COMPARATOR_SYSTEM =
  "http://hl7.org/fhir/quantity-comparator";

const emaCodeByComparator = {
  "<": "100000000050",
  "<=": "100000000052",
  ">": "100000000051",
  ">=": "100000000053",
  "~": "100000000055",
  ad: "100000165006"
} as const satisfies Record<NonNullable<FhirR6Quantity["comparator"]>, string>;

// EMA exact equality is an active operator even without an HL7 comparator.
const EMA_EQUALITY_OPERATOR_CODE = "100000000049";

const comparatorByEmaCode: Record<string, NonNullable<FhirR6Quantity["comparator"]>> = {
  "100000000050": "<",
  "100000000052": "<=",
  "100000000051": ">",
  "100000000053": ">=",
  "100000000055": "~",
  "100000165006": "ad"
};

/** Published EMA Quantity Operator display labels (CodeSystem version 5.0.0).
 * When the clinician changes the code, a stale old display must not claim
 * that the new comparator is still approximate. */
const emaDisplayByComparator: Record<NonNullable<FhirR6Quantity["comparator"]>, string> = {
  "<": "less than",
  "<=": "less than or equal to",
  ">": "more than",
  ">=": "more than or equal to",
  "~": "approximately equal to",
  ad: "quantity sufficient"
};

const knownEmaDisplays = new Set<string>(["equal to"]);
for (const comparator of ["<", "<=", ">", ">=", "~", "ad"] as const)
  knownEmaDisplays.add(emaDisplayByComparator[comparator]);

/** Read the published EMA Coding without treating "average", "equivalent"
 * or "range" as invented HL7 comparator semantics. */
export function getEmaQuantityComparator(
  quantity: Pick<FhirR6Quantity, "extension"> | undefined
): FhirR6Quantity["comparator"] {
  let found: FhirR6Quantity["comparator"], equality = false;
  for (const ext of quantity?.extension ?? []) {
    if (ext.url !== EMA_QUANTITY_COMPARATOR_EXTENSION_URL ||
        ext.valueCoding?.system !== EMA_QUANTITY_OPERATOR_SYSTEM) continue;
    const code = ext.valueCoding.code;
    if (code === EMA_EQUALITY_OPERATOR_CODE) { equality = true; continue; }
    const comparator = code ? comparatorByEmaCode[code] : undefined;
    if (!comparator) continue;
    if (found && found !== comparator) return undefined;
    found = comparator;
  }
  return equality ? undefined : found;
}

/** Read the active qualifier. A clinician-edited native Quantity comparator
 * wins over retained EMA metadata; SimpleQuantity falls back to EMA Coding.
 * Use this for meaning/display, not the extension-only inspection API. */
export function getQuantityComparator(
  quantity: Pick<FhirR6Quantity, "comparator" | "extension"> | undefined
): FhirR6Quantity["comparator"] {
  return quantity?.comparator ?? getEmaQuantityComparator(quantity);
}

function exactGeneratedComparatorExtension(
  ext: FhirR6Extension, comparator: NonNullable<FhirR6Quantity["comparator"]>
): boolean {
  const coding = ext.valueCoding;
  return ext.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL &&
    coding?.system === EMA_QUANTITY_OPERATOR_SYSTEM &&
    coding.code === emaCodeByComparator[comparator] &&
    Object.keys(ext).length === 2 && Object.keys(coding).length === 2;
}

/** Translations describe a particular code, not an operator slot. Preserve
 * superseded labels under their original Coding, outside the active operator. */
export const QUANTITY_OPERATOR_SOURCE_URL =
  "urn:ezmedicationinput:StructureDefinition:quantity-operator-source";
function editedOperator(
  extension: FhirR6Extension,
  comparator: FhirR6Quantity["comparator"],
  sources: FhirR6Extension[]
): FhirR6Extension {
  const coding = extension.valueCoding!;
  const code = comparator ? emaCodeByComparator[comparator] : EMA_EQUALITY_OPERATOR_CODE;
  const display = comparator ? emaDisplayByComparator[comparator] : "equal to";
  const { _code, _display, i18n, ...current } = coding;
  if (coding.code !== code || coding.display !== undefined ||
      _code !== undefined || _display !== undefined || i18n !== undefined)
    sources.push({ url: QUANTITY_OPERATOR_SOURCE_URL, valueCoding: coding });
  return { ...extension, valueCoding: {
    ...current, code,
    ...(coding.display !== undefined ? { display } : {})
  } };
}

/** Quantity/Duration, Ratio/Range, Period, Reference/CodeableReference, Coding/Concept
 * and their declared primitive annotations share the existing operator bridge.
 * Other Extension value choices remain opaque. */
const codingPrimitiveFields = ["_system", "_version", "_code", "_display", "_userSelected"] as const;
const extensionPrimitiveFields = ["_valueCode", "_valueString", "_valueMarkdown", "_valueDecimal", "_valueTime", "_valueInteger", "_valueBoolean"] as const;
export function quantityAnnotationExtensions(
  source: FhirR6Extension[], target: "r5" | "r6"
): FhirR6Extension[] {
  let result: FhirR6Extension[] | undefined;
  for (let index = 0; index < source.length; index++) {
    const item = source[index];
    // Retired wire values remain literal source, not current annotations.
    if (item.url === DOSAGE_RECONCILIATION_SOURCE_URL) {
      result?.push(item);
      continue;
    }
    const quantity = target === "r5" ? quantityForR5(item.valueQuantity) : quantityFromWire(item.valueQuantity);
    const duration = target === "r5" ? quantityForR5(item.valueDuration) : quantityFromWire(item.valueDuration);
    let ratio = item.valueRatio;
    if (ratio) {
      const numerator = target === "r5" ? quantityForR5(ratio.numerator) : quantityFromWire(ratio.numerator);
      const denominator = target === "r5" ? simpleQuantityForR5(ratio.denominator) : simpleQuantityForR6(ratio.denominator);
      const extension = ratio.extension ? quantityAnnotationExtensions(ratio.extension, target) : undefined;
      if (numerator !== ratio.numerator || denominator !== ratio.denominator || extension !== ratio.extension) ratio = {
        ...ratio,
        ...(numerator !== ratio.numerator ? { numerator } : {}),
        ...(denominator !== ratio.denominator ? { denominator } : {}),
        ...(extension !== ratio.extension ? { extension } : {})
      };
    }
    let range = item.valueRange;
    if (range) {
      const low = target === "r5" ? simpleQuantityForR5(range.low) : simpleQuantityForR6(range.low);
      const high = target === "r5" ? simpleQuantityForR5(range.high) : simpleQuantityForR6(range.high);
      const extension = range.extension ? quantityAnnotationExtensions(range.extension, target) : undefined;
      if (low !== range.low || high !== range.high || extension !== range.extension) range = {
        ...range,
        ...(low !== range.low ? { low } : {}),
        ...(high !== range.high ? { high } : {}),
        ...(extension !== range.extension ? { extension } : {})
      };
    }
    const period = quantityPeriodForWire(item.valuePeriod, target);
    const coding = quantityCodingForWire(item.valueCoding, target);
    const concept = quantityConceptForWire(item.valueCodeableConcept, target);
    const directReference = quantityReferenceForWire(item.valueReference, target);
    let reference = item.valueCodeableReference;
    if (reference) {
      const concept = quantityConceptForWire(reference.concept, target);
      const nestedReference = quantityReferenceForWire(reference.reference, target);
      const extension = reference.extension ? quantityAnnotationExtensions(reference.extension, target) : undefined;
      if (concept !== reference.concept || nestedReference !== reference.reference || extension !== reference.extension) reference = {
        ...reference,
        ...(concept !== reference.concept ? { concept } : {}),
        ...(nestedReference !== reference.reference ? { reference: nestedReference } : {}),
        ...(extension !== reference.extension ? { extension } : {}),
      };
    }
    const children = item.extension ? quantityAnnotationExtensions(item.extension, target) : undefined;
    let current = quantity === item.valueQuantity && duration === item.valueDuration && ratio === item.valueRatio &&
      range === item.valueRange && period === item.valuePeriod && coding === item.valueCoding && concept === item.valueCodeableConcept &&
      directReference === item.valueReference && reference === item.valueCodeableReference && children === item.extension ? item : {
      ...item, ...(quantity !== item.valueQuantity ? { valueQuantity: quantity } : {}),
      ...(duration !== item.valueDuration ? { valueDuration: duration } : {}),
      ...(ratio !== item.valueRatio ? { valueRatio: ratio } : {}),
      ...(range !== item.valueRange ? { valueRange: range } : {}),
      ...(period !== item.valuePeriod ? { valuePeriod: period } : {}),
      ...(coding !== item.valueCoding ? { valueCoding: coding } : {}),
      ...(concept !== item.valueCodeableConcept ? { valueCodeableConcept: concept } : {}),
      ...(directReference !== item.valueReference ? { valueReference: directReference } : {}),
      ...(reference !== item.valueCodeableReference ? { valueCodeableReference: reference } : {}),
      ...(children !== item.extension ? { extension: children } : {}),
    };
    for (const field of extensionPrimitiveFields) {
      const primitive = quantityPrimitiveForWire(item[field], target);
      if (primitive === item[field]) continue;
      if (current === item) current = { ...item };
      current[field] = primitive;
    }
    if (current !== item) result ??= source.slice(0, index);
    result?.push(current);
  }
  return result ?? source;
}
function quantityPeriodForWire(
  period: FhirR6Period | undefined, target: "r5" | "r6"
): FhirR6Period | undefined {
  if (!period) return period;
  const extension = period.extension ? quantityAnnotationExtensions(period.extension, target) : undefined;
  const start = quantityPrimitiveForWire(period._start, target);
  const end = quantityPrimitiveForWire(period._end, target);
  return extension === period.extension && start === period._start && end === period._end ? period : {
    ...period,
    ...(extension !== period.extension ? { extension } : {}),
    ...(start !== period._start ? { _start: start } : {}),
    ...(end !== period._end ? { _end: end } : {})
  };
}
function quantityReferenceForWire(
  reference: FhirR6Reference | undefined, target: "r5" | "r6"
): FhirR6Reference | undefined {
  if (!reference) return reference;
  const extension = reference.extension ? quantityAnnotationExtensions(reference.extension, target) : undefined;
  let result = extension === reference.extension ? reference : { ...reference, extension };
  for (const field of ["_reference", "_type", "_display"] as const) {
    const primitive = quantityPrimitiveForWire(reference[field], target);
    if (primitive === reference[field]) continue;
    if (result === reference) result = { ...reference };
    result[field] = primitive;
  }
  const identifier = reference.identifier;
  if (identifier) {
    const extension = identifier.extension ? quantityAnnotationExtensions(identifier.extension, target) : undefined;
    const type = quantityConceptForWire(identifier.type, target);
    const assigner = quantityReferenceForWire(identifier.assigner, target);
    const period = quantityPeriodForWire(identifier.period, target);
    let current = extension === identifier.extension && type === identifier.type &&
      assigner === identifier.assigner && period === identifier.period ? identifier : {
      ...identifier,
      ...(extension !== identifier.extension ? { extension } : {}),
      ...(type !== identifier.type ? { type } : {}),
      ...(assigner !== identifier.assigner ? { assigner } : {}),
      ...(period !== identifier.period ? { period } : {})
    };
    for (const field of ["_use", "_system", "_value"] as const) {
      const primitive = quantityPrimitiveForWire(identifier[field], target);
      if (primitive === identifier[field]) continue;
      if (current === identifier) current = { ...identifier };
      current[field] = primitive;
    }
    if (current !== identifier) {
      if (result === reference) result = { ...reference };
      result.identifier = current;
    }
  }
  return result;
}
function quantityConceptForWire(
  concept: FhirR6CodeableConcept | undefined, target: "r5" | "r6"
): FhirR6CodeableConcept | undefined {
  if (!concept) return concept;
  const extension = concept.extension ? quantityAnnotationExtensions(concept.extension, target) : undefined;
  const text = quantityPrimitiveForWire(concept._text, target);
  let codings: FhirR6Coding[] | undefined;
  for (let index = 0; index < (concept.coding?.length ?? 0); index++) {
    const current = quantityCodingForWire(concept.coding![index], target)!;
    if (current !== concept.coding![index]) codings ??= concept.coding!.slice(0, index);
    codings?.push(current);
  }
  return extension !== concept.extension || text !== concept._text || codings ? {
    ...concept,
    ...(extension !== concept.extension ? { extension } : {}),
    ...(text !== concept._text ? { _text: text } : {}),
    ...(codings ? { coding: codings } : {})
  } : concept;
}
export function quantityCodingForWire(
  coding: FhirR6Coding | undefined, target: "r5" | "r6"
): FhirR6Coding | undefined {
  if (!coding) return coding;
  const extension = coding.extension ? quantityAnnotationExtensions(coding.extension, target) : undefined;
  let result = extension === coding.extension ? coding : { ...coding, extension };
  for (const field of codingPrimitiveFields) {
    const primitive = quantityPrimitiveForWire(coding[field], target);
    if (primitive === coding[field]) continue;
    if (result === coding) result = { ...coding };
    result[field] = primitive;
  }
  return result;
}
function quantityPrimitiveForWire(
  primitive: FhirR6PrimitiveElement | undefined, target: "r5" | "r6"
): FhirR6PrimitiveElement | undefined {
  if (!primitive?.extension?.length) return primitive;
  const extension = quantityAnnotationExtensions(primitive.extension, target);
  return extension === primitive.extension ? primitive : { ...primitive, extension };
}
/** The known Quantity choice is projected; all unrelated opaque annotations
 * retain their original datatype and fields at this version boundary. */
export function quantityPrimitiveForR5(
  primitive: FhirR6PrimitiveElement | undefined
): FhirPrimitiveElement | undefined {
  return quantityPrimitiveForWire(primitive, "r5") as FhirPrimitiveElement | undefined;
}
const quantityPrimitiveFields = ["_value", "_unit", "_system", "_code", "_comparator"] as const;
function quantityMetadataForWire(
  quantity: FhirR6Quantity, target: "r5" | "r6"
): FhirR6Quantity {
  if (!quantity.extension?.length && !quantity._value && !quantity._unit && !quantity._system &&
      !quantity._code && !quantity._comparator) return quantity;
  const extension = quantity.extension?.length
    ? quantityAnnotationExtensions(quantity.extension, target) : quantity.extension;
  let result = extension === quantity.extension ? quantity : { ...quantity, extension };
  for (const field of quantityPrimitiveFields) {
    const primitive = quantityPrimitiveForWire(quantity[field], target);
    if (primitive === quantity[field]) continue;
    if (result === quantity) result = { ...quantity };
    result[field] = primitive;
  }
  return result;
}

function recognizedEmaOperatorCoding(extension: FhirR6Extension): FhirR6Extension["valueCoding"] {
  const coding = extension.valueCoding;
  return extension.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL &&
    coding?.system === EMA_QUANTITY_OPERATOR_SYSTEM && coding.code &&
    (comparatorByEmaCode[coding.code] || coding.code === EMA_EQUALITY_OPERATOR_CODE)
      ? coding : undefined;
}

/** Both scalar wire versions use comparator-free SimpleQuantity and the
 * existing EMA operator. Primitive annotations keep their target version. */
function simpleQuantityForWire(quantity: FhirR6Quantity | undefined, target: "r5" | "r6"):
  FhirR6SimpleQuantity | undefined {
  if (!quantity) return undefined;
  quantity = quantityMetadataForWire(quantity, target);
  const comparator = quantity.comparator;
  if (!comparator && quantity._comparator === undefined) return quantity as FhirR6SimpleQuantity;
  const { comparator: _r6Comparator, _comparator, ...numeric } = quantity;
  const existing = numeric.extension ?? [];
  const sources: FhirR6Extension[] = _comparator ? [{
    url: QUANTITY_OPERATOR_SOURCE_URL,
    ...(comparator ? { valueCode: comparator } : {}),
    _valueCode: target === "r5" ? quantityPrimitiveForR5(_comparator) : _comparator,
  }] : [];
  if (!comparator) return { ...numeric, extension: [...existing, ...sources] };
  const code = emaCodeByComparator[comparator];
  let found = false;
  // An imported extension may carry id, display, or other authored metadata.
  // If the native comparator was edited, replace its recognized EMA code in
  // place. Appending a second active operator makes both interpretations fail.
  const extensions = existing.map(ext => {
    const coding = recognizedEmaOperatorCoding(ext);
    if (!coding) return ext;
    found = true;
    const staleDisplay = coding.display !== undefined &&
      coding.display !== emaDisplayByComparator[comparator] && knownEmaDisplays.has(coding.display);
    return coding.code === code && !staleDisplay ? ext : editedOperator(ext, comparator, sources);
  });
  extensions.push(...sources);
  if (!found) extensions.push({
    url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
    valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code }
  });
  return { ...numeric, extension: extensions };
}

export function simpleQuantityForR5(quantity: FhirR6Quantity | undefined): FhirSimpleQuantity | undefined {
  // Quantity primitive values are projected above. Unrelated opaque
  // annotation choices retain their supplied wire fields.
  return simpleQuantityForWire(quantity, "r5") as FhirSimpleQuantity | undefined;
}
/** R6 SimpleQuantity keeps native primitive annotations while using the same
 * comparator-free scalar representation as R5. */
export function simpleQuantityForR6(quantity: FhirR6Quantity | undefined): FhirR6SimpleQuantity | undefined {
  return simpleQuantityForWire(quantity, "r6");
}

/** A general R5 Quantity supports older native comparators. Its only
 * missing R6 comparator is "~"; use the EMA extension for that case. */
export function quantityForR5(quantity: FhirR6Quantity | undefined):
  FhirQuantity | undefined {
  if (!quantity) return undefined;
  if (quantity.comparator === "~") return simpleQuantityForR5(quantity);
  quantity = quantityMetadataForWire(quantity, "r5");
  if (!quantity.comparator) return quantity as FhirQuantity;
  return quantityForR6(quantity) as FhirQuantity;
}

/** A native Quantity operator has one active owner. Retain authored EMA
 * annotations as inert source when writing that owner, so a subsequent edit
 * of the external native comparator cannot revive a hidden duplicate. EMA-only
 * input still owns its qualifier, and SimpleQuantity still writes active EMA. */
export function quantityForR6(quantity: FhirR6Quantity | undefined): FhirR6Quantity | undefined {
  if (!quantity?.comparator || !quantity.extension?.length) return quantity;
  let changed = false;
  const extension: FhirR6Extension[] = [];
  for (const item of quantity.extension) {
    if (!recognizedEmaOperatorCoding(item)) {
      extension.push(item);
      continue;
    }
    changed = true;
    if (!exactGeneratedComparatorExtension(item, quantity.comparator))
      extension.push({ url: QUANTITY_OPERATOR_SOURCE_URL, extension: [item] });
  }
  return changed ? { ...quantity, extension: extension.length ? extension : undefined } : quantity;
}

/** Read the current quantity operator at either FHIR boundary. The same EMA
 * coding owns a SimpleQuantity in R5 and R6; native comparators take priority.
 * Authored annotations and superseded labels remain recoverable source. */
export function quantityFromWire(quantity: FhirQuantity | FhirR6Quantity | FhirSimpleQuantity | undefined):
  FhirR6Quantity | undefined {
  if (!quantity) return undefined;
  quantity = quantityMetadataForWire(quantity, "r6");
  if (quantity.comparator !== undefined) return quantity;
  if (!quantity.extension?.length) return quantity;
  let comparator: FhirR6Quantity["comparator"], conflict = false, hasOperator = false, equalityActive = false;
  let corrected: FhirR6Extension[] | undefined, equalitySources: FhirR6Extension[] | undefined;
  let metadataOnly: FhirR6Extension | undefined, ambiguousMetadata = false;
  let operatorPrimitives: Map<string, FhirR6Extension> | undefined;
  let primitiveSources: Set<FhirR6Extension> | undefined;
  // Classify the current operator and metadata-only source in one walk. Ordinary
  // exact annotated quantities do not pay a second scan for a rare source marker.
  for (let index = 0; index < quantity.extension.length; index++) {
    const item = quantity.extension[index];
    let currentItem = item;
    if (item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL && item.valueCoding) {
      hasOperator = true;
      const coding = item.valueCoding;
      if (coding.system !== EMA_QUANTITY_OPERATOR_SYSTEM || !coding.code) {
        corrected?.push(item);
        continue;
      }
      const current = comparatorByEmaCode[coding.code];
      if (coding.code === EMA_EQUALITY_OPERATOR_CODE && coding.display !== undefined &&
          coding.display !== "equal to" && knownEmaDisplays.has(coding.display)) {
        corrected ??= quantity.extension.slice(0, index);
        currentItem = editedOperator(item, undefined, equalitySources ??= []);
      }
      if (coding.code === EMA_EQUALITY_OPERATOR_CODE) {
        if (comparator) conflict = true;
        equalityActive = true;
      } else if (current) {
        if (equalityActive || comparator && comparator !== current) conflict = true;
        comparator = current;
      }
    } else if (item.url === QUANTITY_OPERATOR_SOURCE_URL && item.valueCode === undefined &&
        item._valueCode && Object.keys(item).length === 2) {
      if (metadataOnly) ambiguousMetadata = true;
      metadataOnly = item;
      (primitiveSources ??= new Set()).add(item);
    } else if (item.url === QUANTITY_OPERATOR_SOURCE_URL && item.valueCode !== undefined &&
        item._valueCode && Object.keys(item).length === 3) {
      // A later external edit appends its current primitive after prior source.
      // Only the latest marker for the active operator can regain authority.
      (operatorPrimitives ??= new Map()).set(item.valueCode, item);
      (primitiveSources ??= new Set()).add(item);
    }
    corrected?.push(currentItem);
  }
  if (corrected) quantity = { ...quantity, extension: [...corrected, ...equalitySources!] };
  if (conflict) comparator = undefined;
  if (!comparator && (!primitiveSources || !hasOperator && !operatorPrimitives && ambiguousMetadata))
    return quantity;
  const remaining: FhirR6Extension[] = [];
  const primitiveSource = quantity._comparator === undefined
    ? comparator ? operatorPrimitives?.get(comparator) : !hasOperator ? metadataOnly : undefined
    : undefined;
  const primitive = quantityPrimitiveForWire(quantity._comparator ?? primitiveSource?._valueCode, "r6");
  for (const ext of quantity.extension ?? []) {
    if (comparator && exactGeneratedComparatorExtension(ext, comparator)) continue;
    // The primitive annotation belongs to this exact operator. A live EMA
    // edit must not inherit the prior operator's ID or extensions.
    if (ext !== primitiveSource) remaining.push(primitiveSources?.has(ext)
      ? { url: QUANTITY_OPERATOR_SOURCE_URL, extension: [ext] } : ext);
  }
  return {
    ...quantity,
    ...(comparator ? { comparator } : {}),
    ...(primitive ? { _comparator: primitive } : {}),
    ...(remaining.length ? { extension: remaining } : { extension: undefined })
  };
}

// Existing R5 adapter name shares the boundary owner without a wrapper.
export { quantityFromWire as quantityFromR5 };
