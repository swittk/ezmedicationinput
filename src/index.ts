import { formatCanonicalClause } from "./format";
import { canonicalFromFhir, canonicalToFhir } from "./fhir";
import { shiftCanonicalSigClauses } from "./ir";
import { resolveSigLocalization } from "./i18n";
import { ParserState } from "./parser-state";
import {
  applyPrnReasonCoding,
  applyPrnReasonCodingAsync,
  applySiteCoding,
  applySiteCodingAsync,
  findUnparsedTokenGroups,
  parseClauseState,
  tokenize
} from "./parser";
import { parseSigSegments } from "./hpsg/segmenter";
import { cloneBodySiteSpatialRelation } from "./body-site-spatial";
import { cloneExtensions } from "./fhir-translations";
import {
  BodySiteCode,
  FhirDosage,
  FhirTimingRepeat,
  FormatBatchOptions,
  FormatOptions,
  LintIssue,
  LintBatchResult,
  LintResult,
  ParseBatchResult,
  ParseBatchSegmentMeta,
  ParseOptions,
  ParseResult,
  CanonicalSigClause,
  TextRange
} from "./types";
export { suggestSig } from "./suggest";
export * from "./types";
export { nextDueDoses, calculateTotalUnits } from "./schedule";
export { parseStrength, parseStrengthIntoRatio } from "./utils/strength";
export {
  buildBodySiteTopographicalModifierCoding,
  getBodySiteCode,
  getBodySiteCodeAsync,
  getBodySiteText,
  getBodySiteTextAsync,
  listSupportedBodySiteGrammar,
  listSupportedBodySiteText,
  lookupBodySite,
  lookupBodySiteAsync,
  suggestBodySiteText,
  suggestBodySites
} from "./body-site-lookup";
export type {
  BodySiteGrammarVocabulary,
  BodySiteLookupOptions,
  BodySiteLookupRequest,
  BodySiteLookupResult,
  BodySiteResolver,
  BodySiteTextLookupRequest,
  BodySiteTextOptions,
  BodySiteTextResolver,
  BodySiteVocabularyOptions
} from "./body-site-lookup";
export {
  BODY_SITE_SPATIAL_RELATION_EXTENSION_URL,
  buildBodySiteSpatialRelationExtension,
  buildBodySiteSpatialRelationExtensions,
  cloneBodySiteSpatialRelation,
  parseBodySiteSpatialRelationExtension
} from "./body-site-spatial";
export {
  SNOMED_CT_FINDING_SITE_ATTRIBUTE_CODE,
  SNOMED_CT_FINDING_SITE_ATTRIBUTE_DISPLAY,
  SNOMED_CT_BILATERAL_QUALIFIER_CODE,
  SNOMED_CT_BILATERAL_QUALIFIER_DISPLAY,
  SNOMED_CT_LATERALITY_ATTRIBUTE_CODE,
  SNOMED_CT_LATERALITY_ATTRIBUTE_DISPLAY,
  SNOMED_CT_LEFT_QUALIFIER_CODE,
  SNOMED_CT_LEFT_QUALIFIER_DISPLAY,
  SNOMED_CT_RIGHT_QUALIFIER_CODE,
  SNOMED_CT_RIGHT_QUALIFIER_DISPLAY,
  SNOMED_CT_TOPOGRAPHICAL_MODIFIER_CODE,
  SNOMED_CT_TOPOGRAPHICAL_MODIFIER_DISPLAY,
  SNOMED_SYSTEM
} from "./snomed";
export {
  buildSnomedBodySiteLateralityPostcoordinationCode,
  buildSnomedBodySiteTopographicalModifierPostcoordinationCode,
  buildSnomedFindingSiteCoding,
  buildSnomedFindingSitePostcoordinationCode,
  hasSnomedBodySiteLateralityPostcoordination,
  hasSnomedFindingSitePostcoordination,
  hasSnomedTopographicalModifierPostcoordination,
  parseSnomedBodySiteLateralityPostcoordinationCode,
  parseSnomedBodySiteTopographicalModifierPostcoordinationCode,
  parseSnomedFindingSitePostcoordinationCode
} from "./snomed-postcoordination";
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
  routeCode?: ParserState["routeCode"];
  routeText?: ParserState["routeText"];
  unit?: string;
  dose?: number;
}

type MealDashRelation = "meal" | "ac" | "pc";

const REPEAT_NON_ANCHOR_KEYS: Array<keyof FhirTimingRepeat> = [
  "count",
  "frequency",
  "frequencyMax",
  "period",
  "periodMax",
  "periodUnit",
  "offset"
];

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
  segment: ReturnType<typeof parseSigSegments>[number]
): ReturnType<typeof parseSigSegments> {
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
  segments: ReturnType<typeof parseSigSegments>,
  options?: ParseOptions
): ReturnType<typeof parseSigSegments> {
  if (!options?.enableMealDashSyntax) {
    return segments;
  }
  const expanded: ReturnType<typeof parseSigSegments> = [];
  for (const segment of segments) {
    expanded.push(...expandMealDashSegment(segment));
  }
  return expanded;
}

function toSegmentMeta(segments: ReturnType<typeof parseSigSegments>): ParseBatchSegmentMeta[] {
  return segments.map((segment, index) => ({
    index,
    text: segment.text,
    range: { start: segment.start, end: segment.end }
  }));
}

/**
 * Deep equality helper for plain JSON-like parser output objects.
 *
 * @param left Left-side value.
 * @param right Right-side value.
 * @returns `true` when both values are structurally equal.
 */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || right === null) {
    return left === right;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      return false;
    }
    if (left.length !== right.length) {
      return false;
    }
    for (let i = 0; i < left.length; i += 1) {
      if (!deepEqual(left[i], right[i])) {
        return false;
      }
    }
    return true;
  }
  if (typeof left !== "object" || typeof right !== "object") {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) {
      return false;
    }
    if (!deepEqual(leftRecord[key], rightRecord[key])) {
      return false;
    }
  }
  return true;
}

/**
 * Compares two string arrays as sets.
 *
 * @param left Left array.
 * @param right Right array.
 * @returns `true` when both arrays contain the same unique values.
 */
function sameStringSet(left?: string[], right?: string[]): boolean {
  const a = left ?? [];
  const b = right ?? [];
  if (a.length !== b.length) {
    return false;
  }
  const set = new Set(a);
  if (set.size !== b.length) {
    return false;
  }
  for (const value of b) {
    if (!set.has(value)) {
      return false;
    }
  }
  return true;
}

/**
 * Determines whether a repeat block only uses merge-safe anchor fields.
 *
 * @param repeat FHIR timing repeat payload.
 * @returns `true` when repeat contains only `when`/`timeOfDay`/`dayOfWeek`.
 */
function isMergeableAnchorRepeat(repeat?: FhirTimingRepeat): boolean {
  if (!repeat) {
    return true;
  }
  for (const key of REPEAT_NON_ANCHOR_KEYS) {
    if (repeat[key] !== undefined) {
      return false;
    }
  }
  return true;
}

/**
 * Checks whether two parsed items can be merged without changing semantics.
 *
 * @param base Existing merged item candidate.
 * @param next Incoming parsed item.
 * @returns `true` when both items differ only by merge-safe timing anchors.
 */
function canMergeTimingOnly(base: ParseResult, next: ParseResult): boolean {
  const baseTiming = base.fhir.timing;
  const nextTiming = next.fhir.timing;
  const baseRepeat = baseTiming?.repeat;
  const nextRepeat = nextTiming?.repeat;

  if (!baseRepeat || !nextRepeat) {
    return false;
  }
  if (!isMergeableAnchorRepeat(baseRepeat) || !isMergeableAnchorRepeat(nextRepeat)) {
    return false;
  }
  if (!sameStringSet(baseRepeat.dayOfWeek, nextRepeat.dayOfWeek)) {
    return false;
  }
  if (!deepEqual(baseTiming?.code, nextTiming?.code)) {
    return false;
  }
  if (!deepEqual(baseTiming?.event, nextTiming?.event)) {
    return false;
  }

  return (
    deepEqual(base.fhir.doseAndRate, next.fhir.doseAndRate) &&
    deepEqual(base.fhir.route, next.fhir.route) &&
    deepEqual(base.fhir.site, next.fhir.site) &&
    deepEqual(base.fhir.additionalInstruction, next.fhir.additionalInstruction) &&
    deepEqual(base.fhir.asNeededBoolean, next.fhir.asNeededBoolean) &&
    deepEqual(base.fhir.asNeededFor, next.fhir.asNeededFor)
  );
}

/**
 * Returns a stable unique list preserving first-seen order.
 *
 * @param values Input values.
 * @returns Deduplicated values in insertion order.
 */
function uniqueStrings<T extends string>(values: T[]): T[] {
  const seen = new Set<T>();
  const output: T[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      output.push(value);
    }
  }
  return output;
}

/**
 * Merges two parse results that are known to be timing-compatible.
 *
 * @param base Existing merged result.
 * @param next Next result to fold into `base`.
 * @param options Parse options used to render localized text.
 * @returns New merged parse result.
 */
function mergeParseResults(base: ParseResult, next: ParseResult, options?: ParseOptions): ParseResult {
  const baseRepeat = base.fhir.timing?.repeat ?? {};
  const nextRepeat = next.fhir.timing?.repeat ?? {};
  const mergedWhen = uniqueStrings([...(baseRepeat.when ?? []), ...(nextRepeat.when ?? [])]);
  const mergedTimeOfDay = uniqueStrings([...(baseRepeat.timeOfDay ?? []), ...(nextRepeat.timeOfDay ?? [])]).sort();
  const mergedRepeat: FhirTimingRepeat = {
    ...baseRepeat,
    ...(nextRepeat.dayOfWeek ? { dayOfWeek: nextRepeat.dayOfWeek } : {}),
    ...(mergedWhen.length ? { when: mergedWhen } : {}),
    ...(mergedTimeOfDay.length ? { timeOfDay: mergedTimeOfDay } : {})
  };
  const mergedFhir: FhirDosage = {
    ...base.fhir,
    timing: {
      ...(base.fhir.timing ?? {}),
      repeat: mergedRepeat
    }
  };

  const shortText = formatSig(mergedFhir, "short", options);
  const longText = formatSig(mergedFhir, "long", options);
  mergedFhir.text = longText;

  return {
    fhir: mergedFhir,
    shortText,
    longText,
    warnings: uniqueStrings([...(base.warnings ?? []), ...(next.warnings ?? [])]),
    meta: {
      ...base.meta,
      consumedTokens: uniqueStrings([...(base.meta.consumedTokens ?? []), ...(next.meta.consumedTokens ?? [])]),
      leftoverText: uniqueStrings(
        [base.meta.leftoverText, next.meta.leftoverText].filter((value): value is string => !!value)
      ).join(" ").trim() || undefined,
      canonical: {
        clauses: [...base.meta.canonical.clauses, ...next.meta.canonical.clauses]
      },
      siteLookups: [...(base.meta.siteLookups ?? []), ...(next.meta.siteLookups ?? [])],
      prnReasonLookups: [...(base.meta.prnReasonLookups ?? []), ...(next.meta.prnReasonLookups ?? [])]
    }
  };
}

/**
 * Appends a parsed segment result to the batch, reusing the current item when
 * timing-only expansion can be represented as a single dosage element.
 *
 * @param items Accumulated batch items.
 * @param next Newly parsed segment result.
 * @param options Parse options used to format merged text.
 */
function appendParseResult(
  items: ParseResult[],
  next: ParseResult,
  options?: ParseOptions
): void {
  const previous = items[items.length - 1];
  if (previous && canMergeTimingOnly(previous, next)) {
    items[items.length - 1] = mergeParseResults(previous, next, options);
    return;
  }
  items.push(next);
}

function collectCanonicalClauses(results: ParseResult[]): ParseResult["meta"]["canonical"]["clauses"] {
  const clauses: ParseResult["meta"]["canonical"]["clauses"] = [];
  for (const result of results) {
    clauses.push(...result.meta.canonical.clauses);
  }
  return clauses;
}

export function parseSig(input: string, options?: ParseOptions): ParseBatchResult {
  const segments = expandMealDashSegments(parseSigSegments(input), options);
  const carry: SegmentCarry = {};
  const results: ParseResult[] = [];

  for (const segment of segments) {
    const state = parseClauseState(segment.text, options);
    applyCarryForward(state, carry);
    applyPrnReasonCoding(state, options);
    applySiteCoding(state, options);
    const result = buildParseResult(state, options);
    rebaseParseResult(result, input, segment.start);
    appendParseResult(results, result, options);
    updateCarryForward(carry, state);
  }

  const primary = resolvePrimaryParseResult(results, input, options);

  return {
    input,
    count: results.length,
    items: results,
    fhir: primary.fhir,
    shortText: primary.shortText,
    longText: primary.longText,
    warnings: primary.warnings,
    meta: {
      ...primary.meta,
      canonical: {
        clauses: results.length
          ? collectCanonicalClauses(results)
          : primary.meta.canonical.clauses
      },
      segments: toSegmentMeta(segments)
    }
  };
}

export function lintSig(input: string, options?: ParseOptions): LintBatchResult {
  const segments = expandMealDashSegments(parseSigSegments(input), options);
  const carry: SegmentCarry = {};
  const results: LintResult[] = [];

  for (const segment of segments) {
    const state = parseClauseState(segment.text, options);
    applyCarryForward(state, carry);
    applyPrnReasonCoding(state, options);
    applySiteCoding(state, options);
    const result = buildParseResult(state, options);
    rebaseParseResult(result, input, segment.start);
    const groups = findUnparsedTokenGroups(state);
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
    issues.push(
      ...buildSemanticLintIssues(result, input, {
        start: segment.start,
        end: segment.start + segment.text.length
      })
    );
    results.push({ result, issues });
    updateCarryForward(carry, state);
  }

  const primary = resolvePrimaryLintResult(results, input, options);

  return {
    input,
    count: results.length,
    items: results,
    result: primary.result,
    issues: primary.issues,
    meta: {
      segments: toSegmentMeta(segments)
    }
  };
}

export async function parseSigAsync(
  input: string,
  options?: ParseOptions
): Promise<ParseBatchResult> {
  const segments = expandMealDashSegments(parseSigSegments(input), options);
  const carry: SegmentCarry = {};
  const results: ParseResult[] = [];

  for (const segment of segments) {
    const state = parseClauseState(segment.text, options);
    applyCarryForward(state, carry);
    await applyPrnReasonCodingAsync(state, options);
    await applySiteCodingAsync(state, options);
    const result = buildParseResult(state, options);
    rebaseParseResult(result, input, segment.start);
    appendParseResult(results, result, options);
    updateCarryForward(carry, state);
  }

  const primary = resolvePrimaryParseResult(results, input, options);

  return {
    input,
    count: results.length,
    items: results,
    fhir: primary.fhir,
    shortText: primary.shortText,
    longText: primary.longText,
    warnings: primary.warnings,
    meta: {
      ...primary.meta,
      canonical: {
        clauses: results.length
          ? collectCanonicalClauses(results)
          : primary.meta.canonical.clauses
      },
      segments: toSegmentMeta(segments)
    }
  };
}

export function formatSig(
  dosage: FhirDosage,
  style: "short" | "long" = "short",
  options?: FormatOptions
): string {
  const clause = canonicalFromFhir(dosage);
  const localization = resolveSigLocalization(options?.locale, options?.i18n);
  return formatCanonicalClause(clause, style, localization, options);
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
  const clause = canonicalFromFhir(dosage);
  const localization = resolveSigLocalization(options?.locale, options?.i18n);
  const shortText = formatCanonicalClause(clause, "short", localization, options);
  const computedLong = formatCanonicalClause(clause, "long", localization, options);
  const longText = computedLong || dosage.text || "";
  dosage.text = longText;
  return {
    fhir: dosage,
    shortText,
    longText,
    warnings: clause.warnings ?? [],
    meta: {
      consumedTokens: [],
      normalized: buildNormalizedMetaFromClause(clause, dosage),
      canonical: {
        clauses: [clause]
      }
    }
  };
}

function createEmptyCanonicalClause(rawText: string): CanonicalSigClause {
  return {
    kind: "administration",
    rawText,
    raw: {
      start: 0,
      end: rawText.length,
      text: rawText
    },
    leftovers: [],
    evidence: [],
    confidence: 1
  };
}

function getPrimaryClause(
  clauses: CanonicalSigClause[],
  rawText: string
): CanonicalSigClause {
  return clauses[0] ?? createEmptyCanonicalClause(rawText);
}

function cloneCoding(
  coding?: { code?: string; display?: string; system?: string; extension?: ReturnType<typeof cloneExtensions> }
): { code?: string; display?: string; system?: string; extension?: ReturnType<typeof cloneExtensions> } | undefined {
  if (!coding?.code && !coding?.display && !coding?.system) {
    return undefined;
  }
  return {
    code: coding.code,
    display: coding.display,
    system: coding.system,
    extension: cloneExtensions(coding.extension)
  };
}

function cloneBodySiteCoding(coding?: {
  code?: string;
  display?: string;
  system?: string;
}): BodySiteCode | undefined {
  if (!coding?.code) {
    return undefined;
  }
  return {
    code: coding.code,
    display: coding.display,
    system: coding.system
  };
}

function buildNormalizedMetaFromClause(
  clause: CanonicalSigClause,
  fhir?: FhirDosage
): ParseResult["meta"]["normalized"] {
  const additionalInstructions = clause.additionalInstructions?.length
    ? clause.additionalInstructions.map((instruction) => ({
      text: instruction.text,
      coding: cloneCoding(instruction.coding)
    }))
    : undefined;
  const siteCoding = cloneBodySiteCoding(clause.site?.coding) ??
    cloneBodySiteCoding(fhir?.site?.coding?.[0]);

  return {
    route: clause.route?.code,
    unit: clause.dose?.unit,
    site:
      clause.site?.text || clause.site?.coding?.code || clause.site?.spatialRelation
        ? {
          text: clause.site?.text,
          coding: siteCoding,
          spatialRelation: cloneBodySiteSpatialRelation(clause.site?.spatialRelation)
        }
        : undefined,
    method:
      clause.method?.text || clause.method?.coding?.code
        ? {
          text: clause.method?.text,
          coding: cloneCoding(clause.method?.coding)
        }
        : undefined,
    patientInstruction: clause.patientInstruction,
    prnReason:
      clause.prn?.reason?.text || clause.prn?.reason?.coding?.code
        ? {
          text: clause.prn?.reason?.text,
          coding: cloneCoding(clause.prn?.reason?.coding),
          spatialRelation: cloneBodySiteSpatialRelation(clause.prn?.reason?.spatialRelation)
        }
        : undefined,
    prnReasons: clause.prn?.reasons?.length
      ? clause.prn.reasons.map((reason) => ({
        text: reason.text,
        coding: cloneCoding(reason.coding),
        spatialRelation: cloneBodySiteSpatialRelation(reason.spatialRelation)
      }))
      : undefined,
    additionalInstructions
  };
}

function buildParseResult(
  state: ReturnType<typeof parseClauseState>,
  options?: ParseOptions
): ParseResult {
  const canonicalClauses = state.clauses;
  const clause = getPrimaryClause(canonicalClauses, state.input);
  const localization = resolveSigLocalization(options?.locale, options?.i18n);
  const shortText = formatCanonicalClause(clause, "short", localization, options);
  const longText = formatCanonicalClause(clause, "long", localization, options);
  const fhir = canonicalToFhir(clause, longText, {
    bodySitePostcoordination: options?.bodySitePostcoordination
  });

  const consumedTokens: string[] = [];
  const leftoverParts: string[] = [];
  for (const token of state.tokens) {
    if (state.consumed.has(token.index)) {
      consumedTokens.push(token.original);
    } else {
      leftoverParts.push(token.original);
    }
  }

  const siteLookups: ParseResult["meta"]["siteLookups"] =
    state.siteLookups.length ? [] : undefined;
  if (siteLookups) {
    for (const entry of state.siteLookups) {
      const suggestions: Array<{ coding: BodySiteCode; text?: string }> = [];
      for (const suggestion of entry.suggestions) {
        suggestions.push({
          coding: {
            code: suggestion.coding.code,
            display: suggestion.coding.display,
            system: suggestion.coding.system
          },
          text: suggestion.text
        });
      }
      siteLookups.push({
        request: entry.request,
        suggestions
      });
    }
  }

  const prnReasonLookups: ParseResult["meta"]["prnReasonLookups"] =
    state.prnReasonLookups.length ? [] : undefined;
  if (prnReasonLookups) {
    for (const entry of state.prnReasonLookups) {
      const suggestions: Array<{ coding?: { code?: string; display?: string; system?: string }; text?: string }> = [];
      for (const suggestion of entry.suggestions) {
        suggestions.push({
          coding: cloneCoding(suggestion.coding),
          text: suggestion.text
        });
      }
      prnReasonLookups.push({
        request: entry.request,
        suggestions
      });
    }
  }

  return {
    fhir,
    shortText,
    longText,
    warnings: state.warnings,
    meta: {
      consumedTokens,
      leftoverText: leftoverParts.length ? leftoverParts.join(" ") : undefined,
      normalized: buildNormalizedMetaFromClause(clause, fhir),
      canonical: {
        clauses: canonicalClauses
      },
      siteLookups,
      prnReasonLookups
    }
  };
}

function applyCarryForward(internal: ParserState, carry: SegmentCarry): void {
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

function updateCarryForward(carry: SegmentCarry, internal: ParserState): void {
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
  shiftCanonicalSigClauses(result.meta.canonical.clauses, offset);
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

function resolvePrimaryParseResult(
  results: ParseResult[],
  input: string,
  options?: ParseOptions
): ParseResult {
  if (results.length > 0) {
    return results[0];
  }
  const state = parseClauseState(input, options);
  applyPrnReasonCoding(state, options);
  applySiteCoding(state, options);
  return buildParseResult(state, options);
}

function buildSemanticLintIssues(
  result: ParseResult,
  input: string,
  fallbackRange?: TextRange
): LintIssue[] {
  const issues: LintIssue[] = [];
  const clause = result.meta.canonical.clauses[0];
  const range = clause?.span ?? fallbackRange;
  const text = range
    ? input.slice(range.start, range.end)
    : input;
  const trimmedText = text.trim() || text;
  const tokens = trimmedText ? trimmedText.split(/\s+/).filter((part) => part.length > 0) : [];

  for (const warning of result.warnings) {
    if (!warning.startsWith("Incomplete sig:")) {
      continue;
    }
    issues.push({
      message: warning,
      text: trimmedText,
      tokens,
      range
    });
  }

  return issues;
}

function resolvePrimaryLintResult(
  results: LintResult[],
  input: string,
  options?: ParseOptions
): LintResult {
  if (results.length > 0) {
    return results[0];
  }
  const state = parseClauseState(input, options);
  applyPrnReasonCoding(state, options);
  applySiteCoding(state, options);
  const result = buildParseResult(state, options);
  const groups = findUnparsedTokenGroups(state);
  const issues: LintIssue[] = groups.map((group) => {
    const text = group.range
      ? state.input.slice(group.range.start, group.range.end)
      : group.tokens.map((token) => token.original).join(" ");
    return {
      message: "Unrecognized text",
      text: text.trim() || text,
      tokens: group.tokens.map((token) => token.original),
      range: group.range
    };
  });
  issues.push(...buildSemanticLintIssues(result, input));
  return { result, issues };
}
