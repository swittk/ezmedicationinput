import { formatInternal } from "./format";
import { internalFromFhir, toFhir } from "./fhir";
import { resolveSigLocalization } from "./i18n";
import {
  applyPrnReasonCoding,
  applyPrnReasonCodingAsync,
  applySiteCoding,
  applySiteCodingAsync,
  parseInternal
} from "./parser";
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
  applyPrnReasonCoding(internal, options);
  applySiteCoding(internal, options);
  return buildParseResult(internal, options);
}

export async function parseSigAsync(
  input: string,
  options?: ParseOptions
): Promise<ParseResult> {
  const internal = parseInternal(input, options);
  await applyPrnReasonCodingAsync(internal, options);
  await applySiteCodingAsync(internal, options);
  return buildParseResult(internal, options);
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
        unit: internal.unit,
        site: internal.siteText || internal.siteCoding?.code
          ? {
              text: internal.siteText,
              coding: internal.siteCoding?.code
                ? {
                    code: internal.siteCoding.code,
                    display: internal.siteCoding.display,
                    system: internal.siteCoding.system
                  }
                : undefined
            }
          : undefined,
        prnReason: internal.asNeededReason || internal.asNeededReasonCoding?.code
          ? {
              text: internal.asNeededReason,
              coding: internal.asNeededReasonCoding?.code
                ? {
                    code: internal.asNeededReasonCoding.code,
                    display: internal.asNeededReasonCoding.display,
                    system: internal.asNeededReasonCoding.system
                  }
                : undefined
            }
          : undefined,
        additionalInstructions: internal.additionalInstructions?.length
          ? internal.additionalInstructions.map((instruction) => ({
              text: instruction.text,
              coding: instruction.coding?.code
                ? {
                    code: instruction.coding.code,
                    display: instruction.coding.display,
                    system: instruction.coding.system
                  }
                : undefined
            }))
          : undefined
      }
    }
  };
}

function buildParseResult(
  internal: ReturnType<typeof parseInternal>,
  options?: ParseOptions
): ParseResult {
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

  const siteCoding = internal.siteCoding?.code
    ? {
        code: internal.siteCoding.code,
        display: internal.siteCoding.display,
        system: internal.siteCoding.system
      }
    : undefined;

  const prnReasonCoding = internal.asNeededReasonCoding?.code
    ? {
        code: internal.asNeededReasonCoding.code,
        display: internal.asNeededReasonCoding.display,
        system: internal.asNeededReasonCoding.system
      }
    : undefined;

  const additionalInstructions = internal.additionalInstructions?.length
    ? internal.additionalInstructions.map((instruction) => ({
        text: instruction.text,
        coding: instruction.coding?.code
          ? {
              code: instruction.coding.code,
              display: instruction.coding.display,
              system: instruction.coding.system
            }
          : undefined
      }))
    : undefined;

  const siteLookups = internal.siteLookups.length
    ? internal.siteLookups.map((entry) => ({
        request: entry.request,
        suggestions: entry.suggestions.map((suggestion) => ({
          coding: {
            code: suggestion.coding.code,
            display: suggestion.coding.display,
            system: suggestion.coding.system
          },
          text: suggestion.text
        }))
      }))
    : undefined;

  const prnReasonLookups = internal.prnReasonLookups.length
    ? internal.prnReasonLookups.map((entry) => ({
        request: entry.request,
        suggestions: entry.suggestions.map((suggestion) => ({
          coding: suggestion.coding
            ? {
                code: suggestion.coding.code,
                display: suggestion.coding.display,
                system: suggestion.coding.system
              }
            : undefined,
          text: suggestion.text
        }))
      }))
    : undefined;

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
        unit: internal.unit,
        site:
          internal.siteText || siteCoding
            ? {
                text: internal.siteText,
                coding: siteCoding
              }
            : undefined,
        prnReason:
          internal.asNeededReason || prnReasonCoding
            ? {
                text: internal.asNeededReason,
                coding: prnReasonCoding
              }
            : undefined,
        additionalInstructions
      },
      siteLookups,
      prnReasonLookups
    }
  };
}
