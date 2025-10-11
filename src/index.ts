import { formatInternal } from "./format";
import { internalFromFhir, toFhir } from "./fhir";
import { parseInternal } from "./parser";
import { FhirDosage, ParseOptions, ParseResult } from "./types";

export { parseInternal } from "./parser";
export * from "./types";
export { nextDueDoses } from "./schedule";

export function parseSig(input: string, options?: ParseOptions): ParseResult {
  const internal = parseInternal(input, options);
  const shortText = formatInternal(internal, "short");
  const longText = formatInternal(internal, "long");
  const fhir = toFhir(internal);
  if (longText) {
    fhir.text = longText;
  }

  const consumedTokens = internal.tokens
    .filter((token) => internal.consumed.has(token.index))
    .map((token) => token.original);
  const leftoverTokens = internal.tokens.filter(
    (token) => !internal.consumed.has(token.index)
  );

  return {
    fhir,
    shortText,
    longText,
    warnings: internal.warnings,
    meta: {
      consumedTokens,
      leftoverText: leftoverTokens.length
        ? leftoverTokens.map((t) => t.original).join(" ")
        : undefined,
      normalized: {
        route: internal.routeCode,
        unit: internal.unit
      }
    }
  };
}

export function formatSig(dosage: FhirDosage, style: "short" | "long" = "short"): string {
  const internal = internalFromFhir(dosage);
  return formatInternal(internal, style);
}

export function fromFhirDosage(dosage: FhirDosage): ParseResult {
  const internal = internalFromFhir(dosage);
  const shortText = formatInternal(internal, "short");
  const longText = dosage.text ?? formatInternal(internal, "long");
  return {
    fhir: dosage,
    shortText,
    longText,
    warnings: [],
    meta: {
      consumedTokens: [],
      normalized: {
        route: internal.routeCode,
        unit: internal.unit
      }
    }
  };
}
