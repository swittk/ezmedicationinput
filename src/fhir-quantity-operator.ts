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

/** Project a native R6 Quantity into a valid R5 SimpleQuantity, while using
 * the existing EMA comparator extension (including approximation). */
export function simpleQuantityForR5(quantity: FhirR6Quantity | undefined):
  FhirSimpleQuantity | undefined {
  if (!quantity) return undefined;
  const comparator = quantity.comparator;
  if (!comparator) return quantity as FhirSimpleQuantity;
  const { comparator: _r6Comparator, ...numeric } = quantity;
  const existing = numeric.extension ?? [];
  const code = emaCodeByComparator[comparator];
  let found = false;
  // An imported extension may carry id, display, or other authored metadata.
  // If the native comparator was edited, replace its recognized EMA code in
  // place. Appending a second active operator makes both interpretations fail.
  const extensions = existing.map(ext => {
    const coding = ext.valueCoding;
    if (ext.url !== EMA_QUANTITY_COMPARATOR_EXTENSION_URL ||
        coding?.system !== EMA_QUANTITY_OPERATOR_SYSTEM ||
        !coding.code || !comparatorByEmaCode[coding.code]) return ext;
    found = true;
    return coding.code === code ? ext : {
      ...ext, valueCoding: {
        ...coding, code,
        ...(coding.display !== undefined
          ? { display: emaDisplayByComparator[comparator] } : {})
      }
    };
  });
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
  // Ordinary R5 comparisons are native, but imported enriched EMA metadata
  // must not contradict an edited native comparator.
  if (!quantity.extension?.length) return quantity as FhirQuantity;
  const code = emaCodeByComparator[quantity.comparator];
  let changed = false;
  const extension = quantity.extension.map(ext => {
    const coding = ext.valueCoding;
    if (ext.url !== EMA_QUANTITY_COMPARATOR_EXTENSION_URL ||
        coding?.system !== EMA_QUANTITY_OPERATOR_SYSTEM ||
        !coding.code || !comparatorByEmaCode[coding.code] || coding.code === code) return ext;
    changed = true;
    return { ...ext, valueCoding: {
      ...coding, code,
      ...(coding.display !== undefined
        ? { display: emaDisplayByComparator[quantity.comparator!] } : {})
    } };
  });
  // A native R5 operator needs no generated fallback. Otherwise removing the
  // active comparator later would unexpectedly revive it from our own marker.
  return changed ? { ...quantity, extension } as FhirQuantity : quantity as FhirQuantity;
}

/** Recover the current R6 native comparator from the published EMA Coding.
 * Only an exact canonical extension can be consumed on normalization.
 * Unfamiliar/carrying-extra-metadata extensions remain in the source. */
export function quantityFromR5(quantity: FhirQuantity | FhirSimpleQuantity | undefined):
  FhirR6Quantity | undefined {
  if (!quantity) return undefined;
  if (quantity.comparator !== undefined) return quantity as FhirR6Quantity;
  const comparator = getEmaQuantityComparator(quantity);
  if (!comparator) return quantity;
  const remaining = quantity.extension?.filter(ext =>
    !exactGeneratedComparatorExtension(ext, comparator)) ?? [];
  return {
    ...quantity,
    comparator,
    ...(remaining.length ? { extension: remaining } : { extension: undefined })
  };
}
