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
import type { FhirExtension, FhirQuantity, FhirR6Quantity, FhirSimpleQuantity } from "./types";

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
  quantity: Pick<FhirQuantity, "extension"> | undefined
): FhirR6Quantity["comparator"] {
  let found: FhirR6Quantity["comparator"];
  for (const ext of quantity?.extension ?? []) {
    if (ext.url !== EMA_QUANTITY_COMPARATOR_EXTENSION_URL ||
        ext.valueCoding?.system !== EMA_QUANTITY_OPERATOR_SYSTEM) continue;
    const code = ext.valueCoding.code;
    const comparator = code ? comparatorByEmaCode[code] : undefined;
    if (!comparator) continue;
    if (found && found !== comparator) return undefined;
    found = comparator;
  }
  return found;
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
  ext: FhirExtension, comparator: NonNullable<FhirR6Quantity["comparator"]>
): boolean {
  const coding = ext.valueCoding;
  return ext.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL &&
    coding?.system === EMA_QUANTITY_OPERATOR_SYSTEM &&
    coding.code === emaCodeByComparator[comparator] &&
    Object.keys(ext).length === 2 && Object.keys(coding).length === 2;
}

/** Translations describe a particular code, not an operator slot. Preserve
 * superseded labels under their original Coding, outside the active operator. */
const QUANTITY_OPERATOR_SOURCE_URL =
  "urn:ezmedicationinput:StructureDefinition:quantity-operator-source";
function editedOperator(
  extension: FhirExtension,
  comparator: FhirR6Quantity["comparator"],
  sources: FhirExtension[]
): FhirExtension {
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

/** Project a native R6 Quantity into a valid R5 SimpleQuantity, while using
 * the existing EMA comparator extension (including approximation). */
export function simpleQuantityForR5(quantity: FhirR6Quantity | undefined):
  FhirSimpleQuantity | undefined {
  if (!quantity) return undefined;
  const comparator = quantity.comparator;
  if (!comparator && quantity._comparator === undefined) return quantity as FhirSimpleQuantity;
  const { comparator: _r6Comparator, _comparator, ...numeric } = quantity;
  const existing = numeric.extension ?? [];
  const sources: FhirExtension[] = _comparator ? [{
    url: QUANTITY_OPERATOR_SOURCE_URL,
    ...(comparator ? { valueCode: comparator } : {}), _valueCode: _comparator,
  }] : [];
  if (!comparator) return { ...numeric, extension: [...existing, ...sources] };
  const code = emaCodeByComparator[comparator];
  let found = false;
  // An imported extension may carry id, display, or other authored metadata.
  // If the native comparator was edited, replace its recognized EMA code in
  // place. Appending a second active operator makes both interpretations fail.
  const extensions = existing.map(ext => {
    const coding = ext.valueCoding;
    if (ext.url !== EMA_QUANTITY_COMPARATOR_EXTENSION_URL ||
        coding?.system !== EMA_QUANTITY_OPERATOR_SYSTEM ||
        !coding.code || !(comparatorByEmaCode[coding.code] || coding.code === EMA_EQUALITY_OPERATOR_CODE)) return ext;
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

/** A general R5 Quantity supports older native comparators. Its only
 * missing R6 comparator is "~"; use the EMA extension for that case. */
export function quantityForR5(quantity: FhirR6Quantity | undefined):
  FhirQuantity | undefined {
  if (!quantity?.comparator) return quantity as FhirQuantity | undefined;
  if (quantity.comparator === "~") return simpleQuantityForR5(quantity);
  return quantityForR6(quantity) as FhirQuantity;
}

/** A native Quantity operator has one active owner. Retain authored EMA
 * annotations as inert source when writing that owner, so a subsequent edit
 * of the external native comparator cannot revive a hidden duplicate. EMA-only
 * input still owns its qualifier, and SimpleQuantity still writes active EMA. */
export function quantityForR6(quantity: FhirR6Quantity | undefined): FhirR6Quantity | undefined {
  if (!quantity?.comparator || !quantity.extension?.length) return quantity;
  let changed = false;
  const extension: FhirExtension[] = [];
  for (const item of quantity.extension) {
    const coding = item.valueCoding;
    if (item.url !== EMA_QUANTITY_COMPARATOR_EXTENSION_URL ||
        coding?.system !== EMA_QUANTITY_OPERATOR_SYSTEM || !coding.code ||
        !(comparatorByEmaCode[coding.code] || coding.code === EMA_EQUALITY_OPERATOR_CODE)) {
      extension.push(item);
      continue;
    }
    changed = true;
    if (!exactGeneratedComparatorExtension(item, quantity.comparator))
      extension.push({ url: QUANTITY_OPERATOR_SOURCE_URL, extension: [item] });
  }
  return changed ? { ...quantity, extension: extension.length ? extension : undefined } : quantity;
}

/** Recover the current R6 native comparator from the published EMA Coding.
 * Only an exact canonical extension can be consumed on normalization.
 * Unfamiliar/carrying-extra-metadata extensions remain in the source. */
export function quantityFromR5(quantity: FhirQuantity | FhirSimpleQuantity | undefined):
  FhirR6Quantity | undefined {
  if (!quantity) return undefined;
  if (quantity.comparator !== undefined) return quantity as FhirR6Quantity;
  if (!quantity.extension?.length) return quantity;
  let comparator: FhirR6Quantity["comparator"], conflict = false, hasOperator = false;
  let corrected: FhirExtension[] | undefined, equalitySources: FhirExtension[] | undefined;
  let metadataOnly: FhirExtension | undefined, ambiguousMetadata = false;
  let operatorPrimitives: Map<string, FhirExtension> | undefined;
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
      if (current) {
        if (comparator && comparator !== current) conflict = true;
        comparator = current;
      }
    } else if (item.url === QUANTITY_OPERATOR_SOURCE_URL && item.valueCode === undefined &&
        item._valueCode && Object.keys(item).length === 2) {
      if (metadataOnly) ambiguousMetadata = true;
      metadataOnly = item;
    } else if (item.url === QUANTITY_OPERATOR_SOURCE_URL && item.valueCode !== undefined &&
        item._valueCode && Object.keys(item).length === 3) {
      // A later external edit appends its current primitive after prior source.
      // Only the latest marker for the active operator can regain authority.
      (operatorPrimitives ??= new Map()).set(item.valueCode, item);
    }
    corrected?.push(currentItem);
  }
  if (corrected) quantity = { ...quantity, extension: [...corrected, ...equalitySources!] };
  if (conflict) comparator = undefined;
  if (!comparator) {
    if (hasOperator || quantity._comparator !== undefined || !metadataOnly || ambiguousMetadata) return quantity;
    const remaining = quantity.extension!.filter(item => item !== metadataOnly);
    return { ...quantity, _comparator: metadataOnly._valueCode,
      extension: remaining.length ? remaining : undefined };
  }
  const remaining: FhirExtension[] = [];
  const primitiveSource = quantity._comparator === undefined ? operatorPrimitives?.get(comparator) : undefined;
  const primitive = quantity._comparator ?? primitiveSource?._valueCode;
  for (const ext of quantity.extension ?? []) {
    if (exactGeneratedComparatorExtension(ext, comparator)) continue;
    // The primitive annotation belongs to this exact operator. A live EMA
    // edit must not inherit the prior operator's ID or extensions.
    if (ext !== primitiveSource) remaining.push(ext);
  }
  return {
    ...quantity,
    comparator,
    ...(primitive ? { _comparator: primitive } : {}),
    ...(remaining.length ? { extension: remaining } : { extension: undefined })
  };
}
