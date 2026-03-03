import { formatInternal } from "./format";
import { internalFromFhir, toFhir } from "./fhir";
import { resolveSigLocalization } from "./i18n";
import { ParsedSigInternal } from "./internal-types";
import {
  applyPrnReasonCoding,
  applyPrnReasonCodingAsync,
  applySiteCoding,
  applySiteCodingAsync,
  findUnparsedTokenGroups,
  parseInternal,
  tokenize
} from "./parser";
import { splitSigSegments } from "./segment";
import {
  FhirDosage,
  FormatBatchOptions,
  FormatOptions,
  LintIssue,
  LintBatchResult,
  LintResult,
  ParseBatchResult,
  ParseBatchSegmentMeta,
  ParseOptions,
  ParseResult,
  TextRange
} from "./types";

export { parseInternal } from "./parser";
export { suggestSig } from "./suggest";
export * from "./types";
export { nextDueDoses, calculateTotalUnits } from "./schedule";
export { parseStrength, parseStrengthIntoRatio } from "./utils/strength";
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
export {
  DEFAULT_BODY_SITE_SNOMED,
  DEFAULT_BODY_SITE_SNOMED_SOURCE,
  DEFAULT_ROUTE_SYNONYMS,
  DEFAULT_UNIT_BY_ROUTE,
  KNOWN_DOSAGE_FORMS_TO_DOSE
} from './maps';

interface SegmentCarry {
  routeCode?: ParsedSigInternal["routeCode"];
  routeText?: ParsedSigInternal["routeText"];
  unit?: string;
  dose?: number;
}

type MealDashRelation = "meal" | "ac" | "pc";

function parseMealDashValues(token: string): number[] | undefined {
  if (!/^[0-9]+(?:\.[0-9]+)?(?:-[0-9]+(?:\.[0-9]+)?){2,3}$/.test(token)) {
    return undefined;
  }
  const values = token.split("-").map((part) => Number(part));
  if (values.length !== 3 && values.length !== 4) {
    return undefined;
  }
  if (!values.every((value) => Number.isFinite(value) && value >= 0)) {
    return undefined;
  }
  return values;
}

function mealDashEvents(length: number, relation: MealDashRelation): string[] {
  const base =
    relation === "ac"
      ? ["ACM", "ACD", "ACV"]
      : relation === "pc"
        ? ["PCM", "PCD", "PCV"]
        : ["CM", "CD", "CV"];
  if (length === 4) {
    return [...base, "HS"];
  }
  return base;
}

function formatMealDashAmount(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return String(value).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function expandMealDashSegment(
  segment: ReturnType<typeof splitSigSegments>[number]
): ReturnType<typeof splitSigSegments> {
  const tokens = tokenize(segment.text);
  if (tokens.length === 0) {
    return [segment];
  }

  const firstToken = tokens[0];
  const values = parseMealDashValues(firstToken.lower);
  if (!values) {
    return [segment];
  }

  let relation: MealDashRelation = "meal";
  let relationIndex = -1;
  for (let i = 1; i < tokens.length; i += 1) {
    const lower = tokens[i].lower.replace(/[.,;:]/g, "");
    if (lower === "ac") {
      relation = "ac";
      relationIndex = i;
      break;
    }
    if (lower === "pc") {
      relation = "pc";
      relationIndex = i;
      break;
    }
  }

  const suffixTokens = tokens
    .filter((token, index) => index !== 0 && index !== relationIndex)
    .map((token) => token.original);
  const events = mealDashEvents(values.length, relation);

  const expanded = values
    .map((value, index) => ({ value, event: events[index] }))
    .filter(({ value }) => value > 0)
    .map(({ value, event }) => {
      const text = [formatMealDashAmount(value), ...suffixTokens, event]
        .filter((part) => part && part.trim().length > 0)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      return {
        text,
        start: segment.start,
        end: segment.end
      };
    })
    .filter((item) => item.text.length > 0);

  if (expanded.length === 0) {
    return [segment];
  }
  return expanded;
}

function expandMealDashSegments(
  segments: ReturnType<typeof splitSigSegments>,
  options?: ParseOptions
): ReturnType<typeof splitSigSegments> {
  if (!options?.enableMealDashSyntax) {
    return segments;
  }
  const expanded: ReturnType<typeof splitSigSegments> = [];
  for (const segment of segments) {
    expanded.push(...expandMealDashSegment(segment));
  }
  return expanded;
}

function toSegmentMeta(segments: ReturnType<typeof splitSigSegments>): ParseBatchSegmentMeta[] {
  return segments.map((segment, index) => ({
    index,
    text: segment.text,
    range: { start: segment.start, end: segment.end }
  }));
}

export function parseSig(input: string, options?: ParseOptions): ParseBatchResult {
  const segments = expandMealDashSegments(splitSigSegments(input), options);
  const carry: SegmentCarry = {};
  const results: ParseResult[] = [];

  for (const segment of segments) {
    const internal = parseInternal(segment.text, options);
    applyCarryForward(internal, carry);
    applyPrnReasonCoding(internal, options);
    applySiteCoding(internal, options);
    const result = buildParseResult(internal, options);
    rebaseParseResult(result, input, segment.start);
    results.push(result);
    updateCarryForward(carry, internal);
  }

  const legacy = resolveLegacyParseResult(results, input, options);

  return {
    input,
    count: results.length,
    items: results,
    fhir: legacy.fhir,
    shortText: legacy.shortText,
    longText: legacy.longText,
    warnings: legacy.warnings,
    meta: {
      ...legacy.meta,
      segments: toSegmentMeta(segments)
    }
  };
}

export function lintSig(input: string, options?: ParseOptions): LintBatchResult {
  const segments = expandMealDashSegments(splitSigSegments(input), options);
  const carry: SegmentCarry = {};
  const results: LintResult[] = [];

  for (const segment of segments) {
    const internal = parseInternal(segment.text, options);
    applyCarryForward(internal, carry);
    applyPrnReasonCoding(internal, options);
    applySiteCoding(internal, options);
    const result = buildParseResult(internal, options);
    rebaseParseResult(result, input, segment.start);
    const groups = findUnparsedTokenGroups(internal);
    const issues: LintIssue[] = groups.map((group) => {
      const shiftedRange = shiftRange(group.range, segment.start);
      const text = shiftedRange
        ? input.slice(shiftedRange.start, shiftedRange.end)
        : group.tokens.map((token) => token.original).join(" ");
      return {
        message: "Unrecognized text",
        text: text.trim() || text,
        tokens: group.tokens.map((token) => token.original),
        range: shiftedRange
      };
    });
    results.push({ result, issues });
    updateCarryForward(carry, internal);
  }

  const legacy = resolveLegacyLintResult(results, input, options);

  return {
    input,
    count: results.length,
    items: results,
    result: legacy.result,
    issues: legacy.issues,
    meta: {
      segments: toSegmentMeta(segments)
    }
  };
}

export async function parseSigAsync(
  input: string,
  options?: ParseOptions
): Promise<ParseBatchResult> {
  const segments = expandMealDashSegments(splitSigSegments(input), options);
  const carry: SegmentCarry = {};
  const results: ParseResult[] = [];

  for (const segment of segments) {
    const internal = parseInternal(segment.text, options);
    applyCarryForward(internal, carry);
    await applyPrnReasonCodingAsync(internal, options);
    await applySiteCodingAsync(internal, options);
    const result = buildParseResult(internal, options);
    rebaseParseResult(result, input, segment.start);
    results.push(result);
    updateCarryForward(carry, internal);
  }

  const legacy = resolveLegacyParseResult(results, input, options);

  return {
    input,
    count: results.length,
    items: results,
    fhir: legacy.fhir,
    shortText: legacy.shortText,
    longText: legacy.longText,
    warnings: legacy.warnings,
    meta: {
      ...legacy.meta,
      segments: toSegmentMeta(segments)
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

export function formatSigBatch(
  dosages: FhirDosage[],
  style: "short" | "long" = "short",
  options?: FormatBatchOptions
): string {
  const separator = options?.separator ?? ", ";
  const formatted: string[] = [];
  for (const dosage of dosages) {
    const text = formatSig(dosage, style, options);
    if (text.trim()) {
      formatted.push(text);
    }
  }
  return formatted.join(separator);
}

export function formatParseBatch(
  batch: ParseBatchResult,
  style: "short" | "long" = "short",
  separator = ", "
): string {
  const texts = batch.items
    .map((item) => (style === "short" ? item.shortText : item.longText))
    .filter((text) => typeof text === "string" && text.trim().length > 0);
  return texts.join(separator);
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

function applyCarryForward(internal: ParsedSigInternal, carry: SegmentCarry): void {
  if (!internal.routeCode && !internal.routeText) {
    if (carry.routeCode) {
      internal.routeCode = carry.routeCode;
    }
    if (!internal.routeText && carry.routeText) {
      internal.routeText = carry.routeText;
    }
  }

  if (!internal.unit && carry.unit) {
    internal.unit = carry.unit;
  }

  if (
    internal.dose === undefined &&
    internal.doseRange === undefined &&
    carry.dose !== undefined &&
    internal.unit &&
    internal.unit === carry.unit
  ) {
    internal.dose = carry.dose;
  }
}

function updateCarryForward(carry: SegmentCarry, internal: ParsedSigInternal): void {
  if (internal.routeCode) {
    carry.routeCode = internal.routeCode;
  }
  if (internal.routeText) {
    carry.routeText = internal.routeText;
  }
  if (internal.unit) {
    carry.unit = internal.unit;
  }
  if (internal.dose !== undefined) {
    carry.dose = internal.dose;
  }
}

function rebaseParseResult(result: ParseResult, fullInput: string, offset: number): void {
  const rebaseRequest = <T extends { inputText: string; sourceText?: string; range?: TextRange }>(
    request: T
  ) => {
    request.inputText = fullInput;
    if (request.range) {
      request.range = shiftRange(request.range, offset);
      if (request.range) {
        request.sourceText = fullInput.slice(request.range.start, request.range.end);
      }
    }
  };

  if (result.meta.siteLookups) {
    for (const lookup of result.meta.siteLookups) {
      rebaseRequest(lookup.request);
    }
  }
  if (result.meta.prnReasonLookups) {
    for (const lookup of result.meta.prnReasonLookups) {
      rebaseRequest(lookup.request);
    }
  }
}

function shiftRange(range: TextRange | undefined, offset: number): TextRange | undefined {
  if (!range) {
    return undefined;
  }
  return {
    start: range.start + offset,
    end: range.end + offset
  };
}

function resolveLegacyParseResult(
  results: ParseResult[],
  input: string,
  options?: ParseOptions
): ParseResult {
  if (results.length > 0) {
    return results[0];
  }
  const internal = parseInternal(input, options);
  applyPrnReasonCoding(internal, options);
  applySiteCoding(internal, options);
  return buildParseResult(internal, options);
}

function resolveLegacyLintResult(
  results: LintResult[],
  input: string,
  options?: ParseOptions
): LintResult {
  if (results.length > 0) {
    return results[0];
  }
  const internal = parseInternal(input, options);
  applyPrnReasonCoding(internal, options);
  applySiteCoding(internal, options);
  const result = buildParseResult(internal, options);
  const groups = findUnparsedTokenGroups(internal);
  const issues: LintIssue[] = groups.map((group) => {
    const text = group.range
      ? internal.input.slice(group.range.start, group.range.end)
      : group.tokens.map((token) => token.original).join(" ");
    return {
      message: "Unrecognized text",
      text: text.trim() || text,
      tokens: group.tokens.map((token) => token.original),
      range: group.range
    };
  });
  return { result, issues };
}
