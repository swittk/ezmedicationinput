import { formatInternal } from "./format";
import { internalFromFhir, toFhir } from "./fhir";
import { resolveSigLocalization } from "./i18n";
import { parseInternal } from "./parser";
import { FhirDosage, FormatOptions, ParseOptions, ParseResult } from "./types";

export { parseInternal } from "./parser";
export { suggestSig } from "./suggest";
export * from "./types";
export { nextDueDoses } from "./schedule";
export {
  getRegisteredSigLocalizations,
  registerSigLocalization,
  resolveSigLocalization,
  resolveSigTranslation
} from "./i18n";
export type {
  SigLocalization,
  SigLocalizationConfig,
  SigTranslation,
  SigTranslationConfig
} from "./i18n";

export function parseSig(input: string, options?: ParseOptions): ParseResult {
  const internal = parseInternal(input, options);
  const localization = resolveSigLocalization(options?.locale, options?.i18n);
  const shortText = formatInternal(internal, "short", localization);
  const longText = formatInternal(internal, "long", localization);
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

export function formatSig(
  dosage: FhirDosage,
  style: "short" | "long" = "short",
  options?: FormatOptions
): string {
  const internal = internalFromFhir(dosage);
  const localization = resolveSigLocalization(options?.locale, options?.i18n);
  return formatInternal(internal, style, localization);
}

export function fromFhirDosage(
  dosage: FhirDosage,
  options?: FormatOptions
): ParseResult {
  const internal = internalFromFhir(dosage);
  const localization = resolveSigLocalization(options?.locale, options?.i18n);
  const shortText = formatInternal(internal, "short", localization);
  const computedLong = formatInternal(internal, "long", localization);
  const longText = localization ? computedLong : dosage.text ?? computedLong;
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
