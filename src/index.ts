import {
  toDosageDetails, toFhirR5Dosages, toEzDosages, fromDosageDetails,
  getDosageCondition, getDosageExcludedDates,
  getDosageExcludedWeekdays, getUnresolvedDosage
} from "./dosage-course";
import { applyClinicalConstraints } from "./clinical-safety";
import { quarantineSchedule } from "./regimen/admissibility";
import { projectParallelRegimen } from "./regimen/parallel-course";
import { recognizeCycles } from "./regimen/cycles";
import type { EzCourseMetadata } from "./types";
import type { BoundaryPlan } from "./regimen/types";
import { createBoundaryPlan, takeBoundaryParsedState } from "./regimen/candidate-adapter";
import { composeRegimenPhases } from "./regimen/regimen";
import { expandAdministrationTargets, expandLintAdministrationTargets } from "./regimen/targets";
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
import { cloneExtensions, cloneI18nRecord } from "./fhir-translations";
import { getDoseUnitSemantics } from "./unit-lexicon";
import {
  applyInstructionSemanticResolvers,
  applyInstructionSemanticResolversAsync
} from "./instruction-semantic-resolver";
import {
  BodySiteCode,
  FhirDosage,
  EzDosage,
  EzDoseAndRate,
  FhirR6DosageDetails,
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
export {
  TIMING_FREQUENCY_MIN_EXTENSION_URL,
  TIMING_OFFSET_MIN_EXTENSION_URL,
  TIMING_OFFSET_MAX_EXTENSION_URL,
  TIMING_OFFSET_EXACT_EXTENSION_URL,
  TIMING_ACTIVITY_WINDOW_EXTENSION_URL,
  TIMING_OCCURRENCE_CAP_EXTENSION_URL,
  TIMING_EVENT_CALENDAR_SOURCE_EXTENSION_URL,
  PRN_TRIGGER_PHASE_EXTENSION_URL,
  getTimingOccurrenceCap
} from "./fhir";
export { suggestSig } from "./suggest";
export {
  parseInstructionActions,
  realizeInstructionGraph
} from "./instruction-graph";
export {
  getInstructionActionLocaleAdapter,
  registerInstructionActionLocaleAdapter
} from "./instruction-action-locale-adapter";
export type {
  InstructionActionLocaleAdapter,
  InstructionActionRealizationInput
} from "./instruction-action-locale-adapter";
export {
  getAdviceLocaleAdapter,
  registerAdviceLocaleAdapter
} from "./advice-locale-adapter";
export type {
  AdviceLocaleAdapter,
  AdviceLocaleRealizationInput
} from "./advice-locale-adapter";
export {
  inferMedicationLocale,
  registerMedicationLocaleDetector
} from "./locale-detection";
export type { MedicationLocaleDetector } from "./locale-detection";
export {
  getMedicationLexerLocalePack,
  listMedicationLocaleLexemes,
  registerMedicationLexerLocalePack
} from "./lexer/locale";
export type {
  MedicationLexerLocalePack,
  MedicationLocaleLexeme
} from "./lexer/locale";
export {
  listMedicationSurfaceSegmenters,
  registerIntlMedicationSurfaceSegmenter,
  registerMedicationSurfaceSegmenter
} from "./lexer/surface-segmenter";
export type {
  MedicationSurfaceSegment,
  MedicationSurfaceSegmenter
} from "./lexer/surface-segmenter";
export {
  getSuggestLocaleAdapter,
  registerSuggestLocaleAdapter
} from "./suggest-locale-adapter";
export type {
  SuggestLocaleAdapter,
  SuggestLocaleLexemeResolver,
  SuggestLocaleUnitRoutePair
} from "./suggest-locale-adapter";
export {
  MEDICATION_INSTRUCTION_ACTION_SYSTEM,
  buildMedicationInstructionActionCodeSystem,
  getMedicationInstructionAction,
  listMedicationInstructionActions,
  resolveMedicationInstructionAction,
  resolveMedicationInstructionSequenceAction
} from "./instruction-action-terminology";
export type { MedicationInstructionActionCodeSystem } from "./instruction-action-terminology";
export {
  MEDICATION_INSTRUCTION_CONCEPT_SYSTEM,
  buildMedicationInstructionConceptCodeSystem,
  getMedicationInstructionConcept,
  listMedicationInstructionConcepts,
  resolveMedicationInstructionConcept
} from "./instruction-concept-terminology";
export type { MedicationInstructionConceptCodeSystem } from "./instruction-concept-terminology";
export {
  findSymptomDefinitionByCoding,
  listSymptomDefinitions,
  normalizeSymptomKey,
  resolveSymptomDefinition
} from "./symptom-terminology";
export type { SymptomDictionaryEntry } from "./symptom-terminology";
export {
  getAdviceRelationDefinition,
  getBodySiteRelationDefinition,
  getBodySiteRelationRealization,
  listAdviceRelationDefinitions,
  listBodySiteRelationDefinitions,
  localizeAdviceRelation,
  normalizeBodySiteRelation,
  resolveActionRelationSurface,
  resolveAdviceRelationSurface
} from "./relation-terminology";
export type {
  AdviceRelationDefinition,
  AdviceRelationGrammarFeatures,
  BodySiteLocativeRelation,
  BodySiteRelationDefinition,
  BodySiteRelationGrammarFeatures,
  BodySiteRelationRealization,
  RelationLocaleLexeme
} from "./relation-terminology";
export {
  MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL,
  buildInstructionGraphExtension,
  parseInstructionGraphExtension
} from "./instruction-graph-fhir";
export * from "./types";
export { nextDueDoses, calculateTotalUnits, MedicationQuantityCalculationError } from "./schedule";
export {
  toDosageDetails, toFhirR5Dosages, toEzDosages, fromDosageDetails,
  getDosageCondition, setDosageCondition,
  getDosageExcludedDates, setDosageExcludedDates,
  getDosageExcludedWeekdays, setDosageExcludedWeekdays, getUnresolvedDosage,
  DOSAGE_CONDITION_R5_URL, DOSAGE_EXCLUDED_DATES_R5_URL,
  DOSAGE_EXCLUDED_WEEKDAYS_R5_URL, DOSAGE_UNRESOLVED_R5_URL, DOSAGE_DETAILS_R5_URL
} from "./dosage-course";
export { evaluateMedicationCondition } from "./medication-condition";
export { parseStrength, parseStrengthIntoRatio, parseStrengthComponents } from "./utils/strength";
export {
  getDoseUnitApproximation,
  getDoseUnitKind,
  getDoseUnitSemantics,
  listDoseUnitTerminology
} from "./unit-lexicon";
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
  BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL,
  buildBodySiteAdministrationTargetCountExtension,
  getBodySiteAdministrationTargetCount,
  parseBodySiteAdministrationTargetCountExtension
} from "./body-site-target";
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
  findMedicationDateListSpans,
  listMedicationDateResolvers,
  parseMedicationDateListAt,
  registerMedicationDateResolver
} from "./date-interpretation";
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
  siteText?: ParserState["siteText"];
  siteI18n?: ParserState["siteI18n"];
  siteSource?: ParserState["siteSource"];
  siteCoding?: ParserState["siteCoding"];
  siteSpatialRelation?: ParserState["siteSpatialRelation"];
}

type MealDashRelation = "meal" | "ac" | "pc";

const MERGEABLE_REPEAT_KEYS = new Set<keyof FhirTimingRepeat>([
  "when",
  "timeOfDay",
  "dayOfWeek",
  "boundsDuration",
  "boundsPeriod",
  "boundsRange",
  "duration",
  "durationMax",
  "durationUnit"
]);

const MERGEABLE_SHARED_REPEAT_KEYS: Array<keyof FhirTimingRepeat> = [
  "boundsDuration",
  "boundsPeriod",
  "boundsRange",
  "duration",
  "durationMax",
  "durationUnit"
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
 * Determines whether a repeat block only uses merge-safe anchor fields plus
 * shared course/administration duration fields. Shared fields are compared
 * separately before merging.
 *
 * @param repeat FHIR timing repeat payload.
 * @returns `true` when repeat contains only explicitly merge-safe fields.
 */
function isMergeableAnchorRepeat(repeat?: FhirTimingRepeat): boolean {
  if (!repeat) {
    return true;
  }
  for (const key of Object.keys(repeat) as Array<keyof FhirTimingRepeat>) {
    if (repeat[key] !== undefined && !MERGEABLE_REPEAT_KEYS.has(key)) {
      return false;
    }
  }
  return true;
}

function sameMergeableSharedRepeat(
  left: FhirTimingRepeat | undefined,
  right: FhirTimingRepeat | undefined
): boolean {
  for (const key of MERGEABLE_SHARED_REPEAT_KEYS) {
    if (!deepEqual(left?.[key], right?.[key])) {
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
 * @returns `true` when both items differ only by timing anchors and any
 * shared duration/bounds fields are identical.
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
  if (!sameMergeableSharedRepeat(baseRepeat, nextRepeat)) {
    return false;
  }
  if (!deepEqual(baseTiming?.code, nextTiming?.code)) {
    return false;
  }
  if (!deepEqual(baseTiming?.event, nextTiming?.event)) {
    return false;
  }

  return (
    base.fhir.sequence === next.fhir.sequence &&
    deepEqual(base.fhir.doseAndRate, next.fhir.doseAndRate) &&
    deepEqual(base.fhir.route, next.fhir.route) &&
    deepEqual(base.fhir.site, next.fhir.site) &&
    deepEqual(base.fhir.additionalInstruction, next.fhir.additionalInstruction) &&
    deepEqual(base.fhir.asNeeded, next.fhir.asNeeded) &&
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

function mergeParseResultList(
  rawResults: ParseResult[],
  options?: ParseOptions
): ParseResult[] {
  const merged: ParseResult[] = [];
  for (const result of rawResults) {
    appendParseResult(merged, result, options);
  }
  return merged;
}

function normalizedSafetyText(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[\s,;:.()]+/g, " ").trim();
}

function sameDosageConcept(
  left: { coding?: Array<{ system?: string; code?: string }>; text?: string } | undefined,
  right: { coding?: Array<{ system?: string; code?: string }>; text?: string } | undefined
): boolean {
  const leftCoding = left?.coding?.[0];
  const rightCoding = right?.coding?.[0];
  if (leftCoding?.code && rightCoding?.code) {
    return leftCoding.code === rightCoding.code && (leftCoding.system ?? "") === (rightCoding.system ?? "");
  }
  return normalizedSafetyText(left?.text) === normalizedSafetyText(right?.text);
}

/**
 * A semicolon-delimited trailing negated instruction after a heterogeneous
 * dose regimen is regimen-level safety text. FHIR Dosage has no batch-level
 * additionalInstruction slot, so copy that safety instruction onto each
 * compatible Dosage item rather than silently attaching it only to the final
 * dose clause.
 */
function propagateTrailingSharedSafety(results: ParseResult[], options?: ParseOptions): void {
  if (results.length < 2) return;
  const last = results[results.length - 1];
  const clause = last.meta.canonical.clauses[0];
  const raw = clause?.raw.text ?? "";
  const separator = raw.lastIndexOf(";");
  if (separator < 0) return;
  const trailing = normalizedSafetyText(raw.slice(separator + 1));
  if (!trailing) return;

  const sharedCanonical = (clause?.additionalInstructions ?? []).filter((instruction) => {
    const text = normalizedSafetyText(instruction.text);
    return Boolean(
      text && trailing.includes(text) &&
      instruction.frames?.some((frame) => frame.polarity === "negate")
    );
  });
  if (!sharedCanonical.length) return;
  const sharedTexts = sharedCanonical.map((instruction) => normalizedSafetyText(instruction.text));
  const sharedFhir = (last.fhir.additionalInstruction ?? []).filter((instruction) => {
    const text = normalizedSafetyText(instruction.text);
    return Boolean(text && sharedTexts.some((candidate) => text === candidate || text.includes(candidate) || candidate.includes(text)));
  });
  if (!sharedFhir.length) return;

  for (let index = 0; index < results.length - 1; index += 1) {
    const item = results[index];
    if (!sameDosageConcept(item.fhir.route, last.fhir.route)) continue;
    if (item.fhir.method && last.fhir.method && !sameDosageConcept(item.fhir.method, last.fhir.method)) {
      continue;
    }
    const existing = item.fhir.additionalInstruction ?? [];
    const additions = sharedFhir.filter((candidate) => {
      const key = normalizedSafetyText(candidate.text);
      return !existing.some((value) => normalizedSafetyText(value.text) === key);
    });
    if (!additions.length) continue;
    item.fhir.additionalInstruction = [...existing, ...additions.map((value) => ({ ...value }))];
    const canonical = item.meta.canonical.clauses[0];
    if (canonical) {
      canonical.additionalInstructions = [
        ...(canonical.additionalInstructions ?? []),
        ...sharedCanonical.filter((candidate) => !canonical.additionalInstructions?.some(
          (value) => normalizedSafetyText(value.text) === normalizedSafetyText(candidate.text)
        ))
      ];
    }
    item.longText = formatSig(item.fhir, "long", options);
    item.shortText = formatSig(item.fhir, "short", options);
    item.fhir.text = item.longText;
  }
}

function propagateTrailingSharedDuration(
  results: ParseResult[],
  segments: ReturnType<typeof parseSigSegments>,
  options?: ParseOptions
): void {
  for (let index = results.length - 2; index >= 0; index -= 1) {
    if (!segments[index]?.inheritTrailingDurationFromNext) continue;
    const current = results[index];
    const next = results[index + 1];
    const currentClause = current.meta.canonical.clauses[0];
    const nextClause = next.meta.canonical.clauses[0];
    const nextSchedule = nextClause?.schedule;
    if (!currentClause || !nextSchedule?.durationUnit || nextSchedule.duration === undefined) continue;
    if (currentClause.schedule?.duration !== undefined || currentClause.schedule?.durationUnit !== undefined) continue;

    currentClause.schedule = {
      ...(currentClause.schedule ?? {}),
      duration: nextSchedule.duration,
      durationMax: nextSchedule.durationMax,
      durationUnit: nextSchedule.durationUnit
    };
    const nextRepeat = next.fhir.timing?.repeat;
    if (nextRepeat?.boundsDuration || nextRepeat?.boundsRange) {
      current.fhir.timing = current.fhir.timing ?? {};
      current.fhir.timing.repeat = {
        ...(current.fhir.timing.repeat ?? {}),
        boundsDuration: nextRepeat.boundsDuration ? { ...nextRepeat.boundsDuration } : undefined,
        boundsRange: nextRepeat.boundsRange ? {
          ...nextRepeat.boundsRange,
          low: nextRepeat.boundsRange.low ? { ...nextRepeat.boundsRange.low } : undefined,
          high: nextRepeat.boundsRange.high ? { ...nextRepeat.boundsRange.high } : undefined
        } : undefined
      };
    }
    current.longText = formatSig(current.fhir, "long", options);
    current.shortText = formatSig(current.fhir, "short", options);
    current.fhir.text = current.longText;
  }
}

function nextIsoCalendarDay(value: string): string | undefined {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return undefined;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return undefined;
  date.setUTCDate(date.getUTCDate() + 1);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1);
  const day = String(date.getUTCDate());
  return `${year}-${month.length < 2 ? `0${month}` : month}-${day.length < 2 ? `0${day}` : day}`;
}

function propagateDateTransitionEventTiming(
  results: ParseResult[],
  segments: ReturnType<typeof parseSigSegments>,
  input: string,
  options?: ParseOptions
): void {
  for (let index = 1; index < results.length; index += 1) {
    const previousSegment = segments[index - 1];
    const currentSegment = segments[index];
    if (!previousSegment || !currentSegment) continue;
    const transitionGap = input.slice(previousSegment.end, currentSegment.start);
    if (!/(?:\bthen\b|จากนั้น)/iu.test(transitionGap)) continue;

    const previous = results[index - 1];
    const current = results[index];
    const previousSchedule = previous.meta.canonical.clauses[0]?.schedule;
    const currentClause = current.meta.canonical.clauses[0];
    const currentSchedule = currentClause?.schedule;
    if (!previousSchedule?.calendarEvents?.length || !currentClause || !currentSchedule) continue;
    const isRecurring = Boolean(
      currentSchedule.dayOfWeek?.length ||
      currentSchedule.frequency !== undefined ||
      currentSchedule.period !== undefined ||
      currentSchedule.timingCode
    );
    if (!isRecurring || currentSchedule.calendarEvents?.length) continue;

    let changed = false;
    if (!currentSchedule.boundsStart) {
      let latestDate: string | undefined;
      for (const event of previousSchedule.calendarEvents) {
        if (!latestDate || event.isoDate > latestDate) latestDate = event.isoDate;
      }
      const nextDay = latestDate ? nextIsoCalendarDay(latestDate) : undefined;
      if (nextDay) {
        currentSchedule.boundsStart = nextDay;
        changed = true;
      }
    }
    if (!currentSchedule.when?.length && previousSchedule.when?.length) {
      currentSchedule.when = [...previousSchedule.when];
      changed = true;
    }
    if (!currentSchedule.timeOfDay?.length && previousSchedule.timeOfDay?.length) {
      currentSchedule.timeOfDay = [...previousSchedule.timeOfDay];
      changed = true;
    }
    if (!changed) continue;

    current.fhir.timing = current.fhir.timing ?? {};
    current.fhir.timing.repeat = {
      ...(current.fhir.timing.repeat ?? {}),
      ...(currentSchedule.boundsStart || currentSchedule.boundsEnd
        ? {
          boundsPeriod: {
            ...(currentSchedule.boundsStart ? { start: currentSchedule.boundsStart } : {}),
            ...(currentSchedule.boundsEnd ? { end: currentSchedule.boundsEnd } : {})
          }
        }
        : {}),
      ...(currentSchedule.when?.length ? { when: [...currentSchedule.when] } : {}),
      ...(currentSchedule.timeOfDay?.length ? { timeOfDay: [...currentSchedule.timeOfDay] } : {})
    };
    current.longText = formatSig(current.fhir, "long", options);
    current.shortText = formatSig(current.fhir, "short", options);
    current.fhir.text = current.longText;
  }
}

function collectCanonicalClauses(results: ParseResult[]): ParseResult["meta"]["canonical"]["clauses"] {
  const clauses: ParseResult["meta"]["canonical"]["clauses"] = [];
  for (const result of results) {
    clauses.push(...result.meta.canonical.clauses);
  }
  return clauses;
}

/** Rich R6 course fields cannot be safely flattened to an R5 display sentence.
 * Keep the exact same guard here and in formatSig, without exception handling
 * in the normal parse path.
 */
function requiresR6CourseSourceForDisplay(course: FhirR6DosageDetails): boolean {
  return Boolean(course.repeatCycle || course.safety ||
    course.step.some(step => step.start || step.end ||
      step.count !== undefined || step.safety ||
      step.component.some(component => component.condition?.length ||
        component.safety || component.site?.reference ||
        component.doseAndRate?.some(rate => rate.doseExpression || rate.rateExpression))));
}

/** One whole-course public result, independent of the number of parsed clauses. */
function buildWholeCourseResult(
  input: string,
  results: ParseResult[],
  primary: ParseResult,
  segments: ReturnType<typeof parseSigSegments>,
  parallel?: { dosages: EzDosage[]; course: EzCourseMetadata; details: FhirR6DosageDetails }
): ParseBatchResult {
  const dosageItems = results.map(item => item.fhir);
  const fhir = parallel?.dosages ?? toEzDosages(dosageItems);
  const fhirNext = parallel?.details ?? toDosageDetails(dosageItems, input);
  const warnings = new Set<string>();
  const consumedTokens: string[] = [];
  const leftovers: string[] = [];
  for (const item of results) {
    for (const warning of item.warnings) warnings.add(warning);
    consumedTokens.push(...item.meta.consumedTokens);
    if (item.meta.leftoverText && leftovers.indexOf(item.meta.leftoverText) < 0) {
      leftovers.push(item.meta.leftoverText);
    }
  }
  // Only ordinary R5-compatible multi-clause courses can be safely realized.
  // A staged/conditional R6 course keeps the source wording; never drop a phase.
  const displayCourse = results.length > 1 && !requiresR6CourseSourceForDisplay(fhirNext)
    ? { ...fhirNext, renderedInstruction: undefined }
    : fhirNext;
  return {
    input,
    count: results.length,
    items: results,
    fhir,
    fhirNext,
    ...(parallel ? { course: parallel.course } : {}),
    shortText: results.length === 1 ? primary.shortText : formatSig(displayCourse, "short"),
    longText: results.length === 1 ? primary.longText : formatSig(displayCourse, "long"),
    warnings: [...warnings],
    meta: {
      ...primary.meta,
      consumedTokens,
      leftoverText: leftovers.length ? leftovers.join(" ") : undefined,
      canonical: {
        clauses: results.length
          ? collectCanonicalClauses(results)
          : primary.meta.canonical.clauses
      },
      segments: toSegmentMeta(segments)
    }
  };
}

/**
 * When a planned "then" spans a semicolon followed by a separately dosed
 * instruction, it may have joined two independent regimen tracks. Until the
 * grammar produces their true concurrent step structure, do not execute any
 * partial or falsely sequential timetable.
 *
 * This check concerns syntax/ownership, not a particular drug or body site.
 */
function quarantineMergedIndependentRegimens(
  results: ParseResult[],
  segments: ReturnType<typeof parseSigSegments>,
  plan: BoundaryPlan,
  source: string,
  options?: ParseOptions
): void {
  if (!plan.relations.some(edge => edge.kind === "sequence")) return;
  for (const segment of segments) {
    if (!segment.text.includes(";")) continue;
    for (let offset = segment.text.indexOf(";"); offset >= 0;
      offset = segment.text.indexOf(";", offset + 1)) {
      const continuation = segment.text.slice(offset + 1).trim();
      if (!continuation) continue;
      const parsed = parseClauseState(continuation, options);
      if (!parsed.primaryClause.dose) continue;
      for (const result of results) {
        quarantineSchedule(result, source, "independent-sequences-not-yet-resolved");
      }
      return;
    }
  }
}

/**
 * Invalid but explicitly framed medication cycles must not contribute their
 * day numbers as dose amounts. Keep original offsets intact by masking only
 * the invalid cycle frame while parsing the preceding administered amount.
 * The original source is still quarantined by composeRegimenPhases, including
 * the precise cycle error and all unparsed clinical text.
 *
 * Ordinary "on day N" text is not a cycle frame; valid explicit cycles are
 * parsed normally without this fallback.
 */
function parseCycleSafeClauseState(text: string, options?: ParseOptions) {
  if (!/(?:\bcycles?\b|วันที่ของรอบ|\bstarting\b)/iu.test(text)) {
    return parseClauseState(text, options);
  }
  const invalid = recognizeCycles(text, options).filter(frame => frame.error);
  if (!invalid.length) return parseClauseState(text, options);
  const chars = text.split("");
  for (const frame of invalid) {
    for (let index = frame.start; index < frame.end; index++) {
      if (chars[index] !== "\n") chars[index] = " ";
    }
  }
  return parseClauseState(chars.join(""), options);
}

export function parseSig(input: string, options?: ParseOptions): ParseBatchResult {
  const boundaryPlan = createBoundaryPlan(input, options);
  const segments = expandMealDashSegments(boundaryPlan.segments, options);
  const carry: SegmentCarry = {};
  const rawResults: ParseResult[] = [];

  for (const segment of segments) {
    if (boundaryPlan.relations.some(edge => edge.kind === "independent" &&
        boundaryPlan.segments[edge.to]?.start === segment.start)) {
      // Explicit independent instructions must not inherit another track's
      // dose, route, site or administration unit.
      for (const key of Object.keys(carry) as Array<keyof SegmentCarry>) delete carry[key];
    }
    const hasInvalidCycles = /(?:\bcycles?\b|วันที่ของรอบ|\bstarting\b)/iu.test(segment.text) &&
      recognizeCycles(segment.text, options).some(frame => frame.error);
    const state = (Object.keys(carry).length === 0 && !hasInvalidCycles
      ? takeBoundaryParsedState(boundaryPlan, segment.start, segment.end, segment.text)
      : undefined) ?? (hasInvalidCycles
        ? parseCycleSafeClauseState(segment.text, options)
        : parseClauseState(segment.text, options));
    applyCarryForward(state, carry);
    applyPrnReasonCoding(state, options);
    applySiteCoding(state, options);
    applyInstructionSemanticResolvers(state, options);
    const result = buildParseResult(state, options);
    rebaseParseResult(result, input, segment.start);
    rawResults.push(result);
    updateCarryForward(carry, state);
  }

  propagateTrailingSharedDuration(rawResults, segments, options);
  composeRegimenPhases(rawResults, segments, boundaryPlan, options, formatSig);
  for (let index = 0; index < rawResults.length; index++) {
    applyClinicalConstraints(rawResults[index], segments[index].text, options);
  }
  let results = mergeParseResultList(rawResults, options);
  propagateTrailingSharedSafety(results, options);
  const compatibilityPrimary = resolvePrimaryParseResult(results, input, options);
  results = expandAdministrationTargets(results, options, formatSig);
  quarantineMergedIndependentRegimens(results, segments, boundaryPlan, input, options);
  const parallel = projectParallelRegimen(results, segments, boundaryPlan, input);
  if (parallel.kind === "unresolved") {
    for (const item of results) quarantineSchedule(item, input, parallel.reason);
  }
  const primary = compatibilityPrimary;

  return buildWholeCourseResult(input, results, primary, segments,
    parallel.kind === "resolved" ? parallel : undefined);
}

export function lintSig(input: string, options?: ParseOptions): LintBatchResult {
  const boundaryPlan = createBoundaryPlan(input, options);
  const segments = expandMealDashSegments(boundaryPlan.segments, options);
  const carry: SegmentCarry = {};
  const results: LintResult[] = [];

  for (const segment of segments) {
    if (boundaryPlan.relations.some(edge => edge.kind === "independent" &&
        boundaryPlan.segments[edge.to]?.start === segment.start)) {
      // Explicit independent instructions must not inherit another track's
      // dose, route, site or administration unit.
      for (const key of Object.keys(carry) as Array<keyof SegmentCarry>) delete carry[key];
    }
    const hasInvalidCycles = /(?:\bcycles?\b|วันที่ของรอบ|\bstarting\b)/iu.test(segment.text) &&
      recognizeCycles(segment.text, options).some(frame => frame.error);
    const state = (Object.keys(carry).length === 0 && !hasInvalidCycles
      ? takeBoundaryParsedState(boundaryPlan, segment.start, segment.end, segment.text)
      : undefined) ?? (hasInvalidCycles
        ? parseCycleSafeClauseState(segment.text, options)
        : parseClauseState(segment.text, options));
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

  const lintParseResults = results.map((item) => item.result);
  propagateTrailingSharedDuration(lintParseResults, segments, options);
  composeRegimenPhases(lintParseResults, segments, boundaryPlan, options, formatSig);
  for (let index = 0; index < lintParseResults.length; index++) {
    const parsed = applyClinicalConstraints(lintParseResults[index], segments[index].text, options);
    results[index].issues = results[index].issues.filter(issue =>
      !issue.range || !parsed.ownedRanges.some(range => range.start <= issue.range!.start && range.end >= issue.range!.end)
    );
    for (const warning of lintParseResults[index].warnings) {
      if (!warning.startsWith("Unresolved schedule")) continue;
      if (results[index].issues.some(issue => issue.message === warning)) continue;
      results[index].issues.push({
        message: warning,
        text: segments[index].text,
        tokens: [],
        range: { start: segments[index].start, end: segments[index].end }
      });
    }
  }
  const expandedLintResults = expandLintAdministrationTargets(results, options, formatSig);
  const lintDosages = expandedLintResults.map(entry => entry.result);
  quarantineMergedIndependentRegimens(
    lintDosages, segments, boundaryPlan, input, options
  );
  const parallel = projectParallelRegimen(lintDosages, segments, boundaryPlan, input);
  if (parallel.kind === "unresolved") {
    for (const item of lintDosages) quarantineSchedule(item, input, parallel.reason);
  }
  for (const entry of expandedLintResults) {
    for (const warning of entry.result.warnings) {
      if (!warning.startsWith("Unresolved schedule")) continue;
      if (entry.issues.some(issue => issue.message === warning)) continue;
      entry.issues.push({
        message: warning,
        text: input,
        tokens: [],
        range: { start: 0, end: input.length }
      });
    }
  }
  const primary = resolvePrimaryLintResult(expandedLintResults, input, options);
  const issues: LintIssue[] = [];
  const seenIssues = new Set<string>();
  for (const entry of expandedLintResults) {
    for (const issue of entry.issues) {
      const key = issue.message + ":" + (issue.range?.start ?? -1) +
        ":" + (issue.range?.end ?? -1) + ":" + issue.text;
      if (seenIssues.has(key)) continue;
      seenIssues.add(key);
      issues.push(issue);
    }
  }

  return {
    input,
    count: expandedLintResults.length,
    items: expandedLintResults,
    result: primary.result,
    issues,
    meta: {
      segments: toSegmentMeta(segments)
    }
  };
}

export async function parseSigAsync(
  input: string,
  options?: ParseOptions
): Promise<ParseBatchResult> {
  const boundaryPlan = createBoundaryPlan(input, options);
  const segments = expandMealDashSegments(boundaryPlan.segments, options);
  const carry: SegmentCarry = {};
  const rawResults: ParseResult[] = [];

  for (const segment of segments) {
    if (boundaryPlan.relations.some(edge => edge.kind === "independent" &&
        boundaryPlan.segments[edge.to]?.start === segment.start)) {
      // Explicit independent instructions must not inherit another track's
      // dose, route, site or administration unit.
      for (const key of Object.keys(carry) as Array<keyof SegmentCarry>) delete carry[key];
    }
    const hasInvalidCycles = /(?:\bcycles?\b|วันที่ของรอบ|\bstarting\b)/iu.test(segment.text) &&
      recognizeCycles(segment.text, options).some(frame => frame.error);
    const state = (Object.keys(carry).length === 0 && !hasInvalidCycles
      ? takeBoundaryParsedState(boundaryPlan, segment.start, segment.end, segment.text)
      : undefined) ?? (hasInvalidCycles
        ? parseCycleSafeClauseState(segment.text, options)
        : parseClauseState(segment.text, options));
    applyCarryForward(state, carry);
    await applyPrnReasonCodingAsync(state, options);
    await applySiteCodingAsync(state, options);
    await applyInstructionSemanticResolversAsync(state, options);
    const result = buildParseResult(state, options);
    rebaseParseResult(result, input, segment.start);
    rawResults.push(result);
    updateCarryForward(carry, state);
  }

  propagateTrailingSharedDuration(rawResults, segments, options);
  composeRegimenPhases(rawResults, segments, boundaryPlan, options, formatSig);
  for (let index = 0; index < rawResults.length; index++) {
    applyClinicalConstraints(rawResults[index], segments[index].text, options);
  }
  let results = mergeParseResultList(rawResults, options);
  propagateTrailingSharedSafety(results, options);
  const compatibilityPrimary = resolvePrimaryParseResult(results, input, options);
  results = expandAdministrationTargets(results, options, formatSig);
  quarantineMergedIndependentRegimens(results, segments, boundaryPlan, input, options);
  const parallel = projectParallelRegimen(results, segments, boundaryPlan, input);
  if (parallel.kind === "unresolved") {
    for (const item of results) quarantineSchedule(item, input, parallel.reason);
  }
  const primary = compatibilityPrimary;

  return buildWholeCourseResult(input, results, primary, segments,
    parallel.kind === "resolved" ? parallel : undefined);
}

export function formatSig(
  input: FhirDosage | FhirR6DosageDetails | readonly EzDosage[],
  style: "short" | "long" = "short",
  options?: FormatOptions
): string {
  if (Array.isArray(input)) {
    return formatSigBatch(input as EzDosage[], style, options);
  }
  const oneOrCourse = input as FhirDosage | FhirR6DosageDetails;
  if ("step" in oneOrCourse) {
    // R6's renderedInstruction is the whole-course instruction. Do not
    // accidentally reduce a taper to a single component or discard its
    // boolean conditions in an English/Thai realization attempt.
    if (oneOrCourse.renderedInstruction) return oneOrCourse.renderedInstruction;
    if (oneOrCourse.step.length === 0) return "";
    if (requiresR6CourseSourceForDisplay(oneOrCourse)) {
      throw new Error("Cannot safely generate text from R6-only course metadata without renderedInstruction");
    }
    const flattened = toFhirR5Dosages(oneOrCourse);
    let index = 0;
    return oneOrCourse.step.map(step => step.component.map(() =>
      formatSig(flattened[index++], style, options)
    ).join("; ")).filter(Boolean).join(" then ");
  }
  const dosage = oneOrCourse as EzDosage;
  const quantity = dosage.doseAndRate?.[0];
  // Ordinary R5 dosages have no custom extensions. Avoid scanning unrelated
  // extension types or allocating temporary arrays while rendering them.
  const hasModifiers = Boolean(dosage.modifierExtension?.length);
  // Until rich rate and relative-weight units have dedicated realizers, retain
  // the prescriber's original statement instead of silently dropping semantics.
  if (dosage.text && (
    quantity?.rateQuantity || quantity?.rateRatio || quantity?.rateRange ||
    quantity?.doseExpression || quantity?.rateExpression ||
    (quantity?.doseQuantity?.unit !== undefined &&
      quantity.doseQuantity.unit.indexOf("/kg") >= 0) ||
    (dosage.maxDosePerPeriod?.length ?? 0) > 0 ||
    dosage.condition?.length || dosage.safety || dosage.siteReference ||
    dosage.excludedDates?.length ||
    (hasModifiers && (
      getDosageCondition(dosage) !== undefined ||
      getDosageExcludedDates(dosage).length > 0 ||
      getUnresolvedDosage(dosage) !== undefined
    )) ||
    (dosage.extension?.length && getDosageExcludedWeekdays(dosage).length > 0)
  )) return dosage.text;
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

/**
 * Load an R6 DosageDetails without reparsing a generated text instruction.
 * R5 component lowerings exist solely for per-clause provenance and formatting;
 * the original whole-course R6 object remains the primary FHIR output.
 */
export function fromFhir(
  dosageDetails: FhirR6DosageDetails,
  options?: FormatOptions
): ParseBatchResult {
  const { dosages, course } = fromDosageDetails(dosageDetails);
  const items = toFhirR5Dosages(dosageDetails).map(dosage =>
    fromFhirDosage(dosage, options)
  );
  const primary = items[0] ?? fromFhirDosage({
    text: dosageDetails.renderedInstruction ?? ""
  }, options);
  const clauses: CanonicalSigClause[] = [];
  const warnings = new Set<string>();
  for (const item of items) {
    clauses.push(...item.meta.canonical.clauses);
    for (const warning of item.warnings) warnings.add(warning);
  }
  // Importing structured R6 data must not depend on the presence of an
  // optional human-readable instruction. If the renderer cannot faithfully
  // express R6-only clinical semantics, preserve the full data and report
  // that text generation needs an original renderedInstruction.
  const safeFormat = (style: "short" | "long"): string => {
    try {
      return formatSig(dosageDetails, style, options);
    } catch (error) {
      if (!(error instanceof Error) ||
          !error.message.startsWith("Cannot safely generate text from R6-only course metadata")) {
        throw error;
      }
      warnings.add("Cannot render advanced R6 dosage without renderedInstruction");
      return "";
    }
  };
  const shortText = safeFormat("short");
  const longText = safeFormat("long");
  return {
    input: dosageDetails.renderedInstruction ?? "",
    count: items.length,
    items,
    fhir: dosages,
    fhirNext: dosageDetails,
    course,
    shortText,
    longText,
    warnings: [...warnings],
    meta: {
      ...primary.meta,
      canonical: { clauses },
      // An imported FHIR object has no original per-clause character positions.
      segments: []
    }
  };
}

export function fromFhirDosage(
  dosage: FhirDosage,
  options?: FormatOptions
): ParseResult {
  const clause = canonicalFromFhir(dosage);
  const localization = resolveSigLocalization(options?.locale, options?.i18n);
  const guarded = getDosageCondition(dosage) !== undefined ||
    getDosageExcludedDates(dosage).length > 0 ||
    getDosageExcludedWeekdays(dosage).length > 0 ||
    getUnresolvedDosage(dosage) !== undefined;
  const shortText = guarded && dosage.text ? dosage.text : formatCanonicalClause(clause, "short", localization, options);
  const computedLong = guarded && dosage.text ? dosage.text : formatCanonicalClause(clause, "long", localization, options);
  const longText = computedLong || dosage.text || "";
  dosage.text = longText;
  return {
    fhir: dosage,
    shortText,
    longText,
    warnings: clause.warnings ?? [],
    meta: {
      consumedTokens: [],
      normalized: buildNormalizedMetaFromClause(clause, dosage, options),
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
  coding?: {
    code?: string;
    display?: string;
    system?: string;
    extension?: ReturnType<typeof cloneExtensions>;
  }
): {
  code?: string;
  display?: string;
  system?: string;
  extension?: ReturnType<typeof cloneExtensions>;
} | undefined {
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
  i18n?: Record<string, string>;
}): BodySiteCode | undefined {
  if (!coding?.code) {
    return undefined;
  }
  return {
    code: coding.code,
    display: coding.display,
    system: coding.system,
    i18n: cloneI18nRecord(coding.i18n)
  };
}

function buildNormalizedMetaFromClause(
  clause: CanonicalSigClause,
  fhir?: FhirDosage,
  options?: ParseOptions | FormatOptions
): ParseResult["meta"]["normalized"] {
  const additionalInstructions = clause.additionalInstructions?.length
    ? clause.additionalInstructions.map((instruction) => ({
      text: instruction.text,
      coding: cloneCoding(instruction.coding)
    }))
    : undefined;
  const siteCoding = cloneBodySiteCoding(clause.site?.coding) ??
    cloneBodySiteCoding(fhir?.site?.coding?.[0]);
  const parseContext = options && "context" in options
    ? (options as ParseOptions).context
    : undefined;
  const unitSemantics = getDoseUnitSemantics(clause.dose?.unit, parseContext);

  return {
    route: clause.route?.code,
    unit: clause.dose?.unit,
    unitKind: unitSemantics?.kind,
    unitSemantics,
    site:
      clause.site?.text ||
      clause.site?.coding?.code ||
      clause.site?.spatialRelation ||
      clause.site?.administrationTargetCount !== undefined
        ? {
          text: clause.site?.text,
          coding: siteCoding,
          spatialRelation: cloneBodySiteSpatialRelation(clause.site?.spatialRelation),
          administrationTargetCount: clause.site?.administrationTargetCount
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
    instructionGraph: clause.instructionGraph,
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
    bodySitePostcoordination: options?.bodySitePostcoordination,
    includeTranslationExtensions: Boolean(options?.locale || options?.i18n)
  });

  const graphUnderstoodSpans: TextRange[] = [];
  for (const candidate of canonicalClauses) {
    const graph = candidate.instructionGraph;
    if (!graph) continue;
    for (const action of graph.actions) graphUnderstoodSpans.push(action.span);
    for (const relation of graph.relations ?? []) {
      if (relation.span) graphUnderstoodSpans.push(relation.span);
    }
  }
  const tokenUnderstoodByGraph = (value: { sourceStart: number; sourceEnd: number }): boolean =>
    graphUnderstoodSpans.some((span) =>
      span.start <= value.sourceStart && value.sourceEnd <= span.end
    );
  const consumedTokens: string[] = [];
  const leftoverParts: string[] = [];
  for (const token of state.tokens) {
    if (state.consumed.has(token.index) || tokenUnderstoodByGraph(token)) {
      consumedTokens.push(token.original);
    } else {
      leftoverParts.push(token.sourceText || token.original);
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
      normalized: buildNormalizedMetaFromClause(clause, fhir, options),
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

  if (!internal.siteText && !internal.siteCoding && (carry.siteText || carry.siteCoding)) {
    internal.siteText = carry.siteText;
    internal.siteI18n = carry.siteI18n;
    internal.siteSource = carry.siteSource;
    internal.siteCoding = carry.siteCoding;
    internal.siteSpatialRelation = carry.siteSpatialRelation;
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
  if (internal.siteText || internal.siteCoding) {
    carry.siteText = internal.siteText;
    carry.siteI18n = internal.siteI18n;
    carry.siteSource = internal.siteSource;
    carry.siteCoding = internal.siteCoding;
    carry.siteSpatialRelation = internal.siteSpatialRelation;
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
  applyInstructionSemanticResolvers(state, options);
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
