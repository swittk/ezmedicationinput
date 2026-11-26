import { MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL } from "./instruction-graph-fhir";
import { courseFromR5 } from "./adapters/r5-import";
import { projectNativeR5Course } from "./adapters/r5-course";
import { formatCanonicalCourse, formatCanonicalAdministration, prefersSourceInstruction,
  joinGeneratedClauses, appendMedicationConditionText, appendMedicationExcludedDatesText,
  appendMedicationExcludedWeekdaysText, unevaluatedExpressionText,
  rateRangePreview } from "./canonical/format-course";
import { administrationFromClause, courseFromAdministrations, courseFromParallel, courseFromPartialParallel, clauseForAdministration } from "./canonical/compile";
import { courseFromR6, courseToR6, projectFreshlyCompiledCourseToR6, rangeFromFhir, unchangedR6SourceDisplay, isR6DosageInstruction } from "./adapters/canonical-course";
import type { CanonicalCourse, CanonicalAdministration } from "./canonical/course";
import { hasAmountRole } from "./canonical/course";
import { cloneStructuredValue } from "./stable-structure";
import { getDoseQuantityUnit } from "./maps";
/** Replacement wording replays alone only while its clinical projection agrees.
 * Structured edits own current directions; explicitly replaced prose can be
 * shown separately in roundtrip mode without certifying its clinical meaning. */
function sourceDisplayEdit(dosage: FhirDosage): boolean | string | { authored: string } {
  // Parser rows are immutable by caller contract. Fresh external submissions
  // have no identity marker and verify their supplied fields below.
  if (getFreshDoseSource(dosage)) return false;
  const originalText = getDosageSourceTextFingerprint(dosage);
  const textChanged = originalText !== undefined && originalText !== dosageTextFingerprint(dosage);
  const matches = dosageMatchesSavedProjection(dosage);
  if (textChanged) return dosage.text?.trim()
    ? matches === true ? dosage.text : { authored: dosage.text }
    : true;
  // Without a saved agreement, narrative is original wording rather than
  // authority for any live clinical field. Both public preview paths share
  // this decision and the native renderer retains the authored wording.
  if (matches === undefined && dosage.text?.trim()) return { authored: dosage.text };
  return matches === false;
}

/** Source wording is authoritative only when the live dose still matches its
 * original source. Direct parser rows carry ownership flags; serialized
 * R5 rows use their existing persisted edit fingerprint. A failed match must
 * override stale lexical evidence retained in a deserialized grammar graph. */
function markOriginalGraphSource(
  dosage: FhirDosage,
  clause: CanonicalSigClause,
  options: FormatOptions | undefined,
  sourceOwnershipRead = false
): void {
  if (!clause.instructionGraph) return;
  const fresh = getFreshDoseSource(dosage);
  if (fresh) {
    clause.sourceHasStructuredClocks = fresh.clocks;
    clause.sourceHasStructuredEvents = fresh.events;
    clause.sourceHasStructuredSite = fresh.site;
  } else if (!sourceOwnershipRead &&
      (clause.sourceHasStructuredClocks === undefined || clause.sourceHasStructuredEvents === undefined ||
        clause.sourceHasStructuredSite === undefined)) {
    // Native import owns absent evidence too; only the direct R5 path needs
    // this lookup after clause projection.
    const sourceOwnership = getDosageSourceOwnership(dosage);
    if (sourceOwnership?.clocks !== undefined) clause.sourceHasStructuredClocks = sourceOwnership.clocks;
    if (sourceOwnership?.events !== undefined) clause.sourceHasStructuredEvents = sourceOwnership.events;
    if (sourceOwnership?.site !== undefined) clause.sourceHasStructuredSite = sourceOwnership.site;
  }
  if (options?.realizationMode !== "roundtrip" && clause.dose) return;
  const verified = fresh && !fresh.defaulted ? true : dosageMatchesSavedProjection(dosage) === true;
  // A matching dose cannot revive source text that the native import has
  // already rejected, including an explicit text clear.
  clause.sourceProjectionVerified = clause.sourceProjectionVerified !== false && verified;
  if (clause.dose) clause.dose.sourceDoseVerified = verified;
}

/** Internal native import/projection helpers. Existing .fhir / .fhirNext fields retain
 * their established versions; canonical is the internal source of meaning. */
export type { CanonicalCourse, CanonicalStage, CanonicalAdministration,
  CanonicalRecurrence, CanonicalTiming, CanonicalBoundary, CanonicalAmount,
  CanonicalDoseLimit, CanonicalMeasure, CanonicalRange, CanonicalRatio,
  CanonicalScheduleInput, CanonicalSupplyOptions } from "./canonical/course";
export { importCanonicalCourse } from "./adapters/canonical-course";
export { formatCanonicalCourse, formatCanonicalAdministration } from "./canonical/format-course";
export function projectCanonicalCourse(course: CanonicalCourse, options?: ParseOptions): {
  fhir: FhirDosage[]; fhirNext: FhirR6DosageInstruction
} {
  const fhirNext = courseToR6(course, {
    bodySitePostcoordination: options?.bodySitePostcoordination,
    includeTranslationExtensions: Boolean(options?.locale || options?.i18n)
  });
  return { fhir: projectNativeR5Course(course, {
    bodySitePostcoordination: options?.bodySitePostcoordination,
    includeTranslationExtensions: Boolean(options?.locale || options?.i18n)
  }).dosages, fhirNext };
}

import {
  toFhirR5Dosages as toFhirR5DosagesInternal, toEzDosages,
  assertCurrentR6DosageInstruction,
  withDosageEditProvenance,
  dosageMatchesSavedProjection, markFreshDoseSource, getFreshDoseSource,
  getDosageSourceTextAgreement,
  getDosageSourceOwnership,
  getDosageSourceTextFingerprint, dosageTextFingerprint,
  DOSAGE_DETAILS_R5_URL, DOSAGE_CONDITION_R5_URL, PARALLEL_COMPONENT_PHASE_ORIGIN_URL, R5_EXPRESSION_SLOT_SOURCE_URL,
  DOSAGE_EXCLUDED_DATES_R5_URL, DOSAGE_EXCLUDED_WEEKDAYS_R5_URL,
  getDosageAlternativeChoice, setDosageAlternativeChoice,
  getDosageCondition, getDosageExcludedDates, getDosageExcludedWeekdays
} from "./dosage-course";
import {
  buildCanonicalParallelRegimen
} from "./regimen/parallel-course";
import {
  applyCoordinatedCadenceScopes, composeCoordinatedTimingAnchors,
  scopeTrailingSharedDuration,
  scopeTrailingSharedNegativeInstructions, scopeMedicationConditionTargets
} from "./regimen/coordination-scope";
import { getQuantityComparator } from "./fhir-quantity-operator";
import type { BoundaryPlan } from "./hpsg/signature";
import { createBoundaryPlan, takeBoundaryParsedState } from "./regimen/planner";
import {
  buildRegimenGraph, regimenMemberSequences,
  scopeSequentialPhaseSemantics, expandRegimenAdjustmentPhases, type RegimenGraph
} from "./regimen/regimen";
import {
  administrationTargetProjections,
  cloneSiteRestrictions,
  projectAdministrationTargetClauses
} from "./hpsg/projection";
import { formatCanonicalClause, independentTimingText } from "./format";
import { preferredTimingCoding } from "./timing-summary";
import { canonicalFromFhir, canonicalToFhir, createEmptyCanonicalClause, TIMING_ACTIVITY_WINDOW_EXTENSION_URL } from "./fhir";
import { shiftCanonicalSigClauses } from "./ir";
import { resolveSigLocalization, resolveCourseLanguage, type CourseLanguage } from "./i18n";
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
import { getDoseUnitSemantics, getQuantityDurationUnit } from "./unit-lexicon";
import {
  applyInstructionSemanticResolvers,
  applyInstructionSemanticResolversAsync
} from "./instruction-semantic-resolver";
import {
  BodySiteCode,
  FhirDosage,
  FhirQuantity,
  EzDosage,
  FhirR6DosageInstruction,
  FhirR6DosageInstructionInput,
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
  CanonicalSiteExpr,
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
  INFUSION_CARRIER_MATERIAL_EXTENSION_URL,
  buildInfusionCarrierMaterialStructureDefinition,
  getTimingOccurrenceCap
} from "./fhir";
export { suggestSig } from "./suggest";
export {
  EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
  EMA_QUANTITY_OPERATOR_SYSTEM,
  FHIR_QUANTITY_COMPARATOR_SYSTEM,
  getEmaQuantityComparator
} from "./fhir-quantity-operator";
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
  resolveMedicationInstructionActionWithCodeFallback as resolveMedicationInstructionAction,
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
  toDosageDetails, toEzDosages, fromDosageDetails, projectEditableR5Course,
  getDosageCondition, setDosageCondition,
  getDosageExcludedDates, setDosageExcludedDates,
  getDosageExcludedWeekdays, setDosageExcludedWeekdays,
  DOSAGE_CONDITION_R5_URL, DOSAGE_EXCLUDED_DATES_R5_URL,
  DOSAGE_EXCLUDED_WEEKDAYS_R5_URL, DOSAGE_DETAILS_R5_URL,
  DOSAGE_ALTERNATIVE_CHOICE_URL, getDosageAlternativeChoice,
  setDosageAlternativeChoice, buildDosageAlternativeChoiceStructureDefinition
} from "./dosage-course";
export type { DosageAlternativeChoice } from "./dosage-course";
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
  CourseLanguage,
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
  doseRange?: ParserState["doseRange"];
  comparator?: NonNullable<CanonicalSigClause["dose"]>["comparator"];
  siteText?: ParserState["siteText"];
  siteI18n?: ParserState["siteI18n"];
  siteSource?: ParserState["siteSource"];
  siteCoding?: ParserState["siteCoding"];
  siteSpatialRelation?: ParserState["siteSpatialRelation"];
  administrationTargetGroup?: ParserState["administrationTargetGroup"];
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

function collectCanonicalClauses(results: ParseResult[]): ParseResult["meta"]["canonical"]["clauses"] {
  const clauses: ParseResult["meta"]["canonical"]["clauses"] = [];
  for (const result of results) {
    clauses.push(...result.meta.canonical.clauses);
  }
  return clauses;
}

/** Prefer exact source wording for rich R6 course fields when it is available. */
/** R5 maximum-dose fields have no lossless canonical text realizer yet. */
function hasMaximumDoseForDisplay(dosage: FhirDosage): boolean {
  return Boolean(
    dosage.maxDosePerPeriod?.length ||
    dosage.maxDosePerAdministration ||
    dosage.maxDosePerLifetime
  );
}

/** Detach a structured R5 modifier marker without emitting non-JSON optional
 * fields. A missing optional property and an explicit undefined are identical
 * in FHIR, but in-memory consumers cannot validate the latter as JSON.
 * Recurses only for emitted course/activity markers, not ordinary single dosages.
 * @param value Source FHIR marker or nested datatype value.
 */
function cloneDefinedExtensionValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(part => cloneDefinedExtensionValue(part)) as T;
  if (value === null || typeof value !== "object") return value;
  const result = { ...value };
  for (const key of Object.keys(result) as (keyof T)[]) {
    if (result[key] === undefined) delete result[key];
    else result[key] = cloneDefinedExtensionValue(result[key]);
  }
  return result;
}

/** Normalize emitted course and activity-timing markers without touching
 * unfamiliar user-provided extensions. Ordinary R5 dosages cost only
 * cheap presence checks for these known semantic markers.
 * @param rows New FHIR dosage rows owned by the bridge.
 */
function normalizeEmittedSemanticMarkers(rows: FhirDosage[], keepExtendedSource = false): FhirDosage[] {
  let output = rows;
  for (let index = 0; index < rows.length; index++) {
    const source = rows[index];
    const course = source.modifierExtension?.some(extension => extension.url === DOSAGE_DETAILS_R5_URL);
    const activity = source.timing?.repeat?.extension?.some(extension =>
      extension.url === TIMING_ACTIVITY_WINDOW_EXTENSION_URL);
    if (!course && !activity) continue;
    // Only known emitted markers need JSON-normalized copies. The extended
    // preview may retain its original source annotations, so detach just
    // those rows rather than deep-cloning an entire returned course.
    if (keepExtendedSource) {
      if (output === rows) output = rows.slice();
      output[index] = { ...source };
    }
    const row = output[index];
    if (course) {
      row.modifierExtension = row.modifierExtension?.map(extension =>
        extension.url === DOSAGE_DETAILS_R5_URL
          ? cloneDefinedExtensionValue(extension) : extension
      );
    }
    const repeat = row.timing?.repeat;
    if (activity && repeat) {
      row.timing = { ...row.timing, repeat: {
        ...repeat,
        extension: repeat.extension?.map(extension =>
          extension.url === TIMING_ACTIVITY_WINDOW_EXTENSION_URL
            ? cloneDefinedExtensionValue(extension) : extension)
      } };
    }
  }
  return output;
}

/** The public strict R5 converter must carry the same in-memory FHIR contract
 * as parseSig().fhir; callers need not JSON-serialize before schema validation.
 * @param input Structured R6 course or existing R5/Ez dosage rows.
 * @param course Optional typed course metadata when inputs are flat rows.
 */
export function toFhirR5Dosages(
  input: Parameters<typeof toFhirR5DosagesInternal>[0],
  course?: Parameters<typeof toFhirR5DosagesInternal>[1]
): FhirDosage[] {
  return normalizeEmittedSemanticMarkers(toFhirR5DosagesInternal(input, course));
}

/** One whole-course public result, independent of the number of parsed clauses. */
function buildWholeCourseResult(
  input: string,
  results: ParseResult[],
  primary: ParseResult,
  segments: ReturnType<typeof parseSigSegments>,
  regimenGraph: RegimenGraph,
  options?: ParseOptions,
  parallel?: { canonical: CanonicalCourse }
): ParseBatchResult {
  const typedRepeatCycle = regimenGraph.repeatCycle ? { ...regimenGraph.repeatCycle } : undefined;
  // Parallel courses already own complete native administrations. Do not
  // compile a second standalone dosage model for each raw diagnostic item.
  const administrations = parallel ? [] : results.map(item => item.meta.canonical.administration!);
  const canonical = parallel?.canonical ?? courseFromAdministrations(
    administrations, input, typedRepeatCycle, regimenGraph.repeatCount);
  if (parallel) {
    if (typedRepeatCycle) canonical.cycleInterval = typedRepeatCycle;
    if (regimenGraph.repeatCount !== undefined)
      canonical.cycleCount = regimenGraph.repeatCount;
  }
  const fhirNext = projectFreshlyCompiledCourseToR6(canonical, {
    bodySitePostcoordination: options?.bodySitePostcoordination,
    includeTranslationExtensions: Boolean(options?.locale || options?.i18n)
  });
  // The established editable R5 persistence contract is an OUTPUT adapter.
  // Neither canonical course construction nor native execution consumes it.
  const typedSteps = !parallel && canonical.stages.some(stage => stage.start || stage.end || stage.count !== undefined ||
    stage.administrations.some(a => a.phaseStart || a.phaseEnd || a.phaseOrigin ||
      a.schedule?.recurrence?.calendarWindow?.end !== a.syntax?.schedule?.boundsEnd));
  const courseProjection = typedRepeatCycle || typedSteps || parallel
    ? projectNativeR5Course(canonical, {
      bodySitePostcoordination:options?.bodySitePostcoordination,
      includeTranslationExtensions:Boolean(options?.locale||options?.i18n)
    }, true, true, false) : undefined;
  const projectedFhir = courseProjection?.dosages ?? toEzDosages(results.map(item => item.fhir));
  // The same JSON-compatible structural bridge serves both public routes:
  // parser FHIR rows and callers using strict toFhirR5Dosages directly.
  const fhir = withDosageEditProvenance(normalizeEmittedSemanticMarkers(projectedFhir), input);
  const warnings = new Set<string>();
  const consumedTokens: string[] = [];
  const leftovers: string[] = [];
  const knownLeftovers=new Set<string>();
  for (const item of results) {
    for (const warning of item.warnings) warnings.add(warning);
    consumedTokens.push(...item.meta.consumedTokens);
    if (item.meta.leftoverText && !knownLeftovers.has(item.meta.leftoverText)) {
      knownLeftovers.add(item.meta.leftoverText);leftovers.push(item.meta.leftoverText);
    }
  }
  // Realize ordinary multi-clause courses afresh. Rich R6 courses prefer the
  // exact source wording when available, while their structured data remains primary.
  const displayCourse = results.length > 1 && !prefersSourceInstruction(canonical)
    ? { ...canonical, instruction: undefined } : canonical;
  return {
    input,
    count: results.length,
    items: results,
    fhir,
    fhirNext,
    ...(parallel ? { course: courseProjection!.course } : {}),
    shortText: results.length === 1 ? primary.shortText : formatCanonicalCourse(displayCourse, "short", options),
    longText: results.length === 1 ? primary.longText : formatCanonicalCourse(displayCourse, "long", options),
    warnings: [...warnings],
    meta: {
      ...primary.meta,
      consumedTokens,
      leftoverText: leftovers.length ? leftovers.join(" ") : undefined,
      canonical: {
        clauses: results.length
          ? collectCanonicalClauses(results)
          : primary.meta.canonical.clauses,
        course: canonical
      },
      segments: toSegmentMeta(segments)
    }
  };
}

/** Yield a parsed clause before advancing carry, so synchronous or asynchronous
 * semantic resolvers can complete before the next clause inherits route/site.
 * Coordination is applied only after all daughters are resolved, and before
 * any clause is lowered to FHIR.
 */
function* iterateCoordinatedSegmentStates(
  options: ParseOptions | undefined,
  boundaryPlan: BoundaryPlan,
  segments: ReturnType<typeof parseSigSegments>
): Generator<ParserState> {
  const independentStarts = boundaryPlan.relations.length ? new Set<number>() : undefined;
  if (independentStarts) {
    for (const edge of boundaryPlan.relations) {
      if (edge.kind !== "independent") continue;
      const segment = boundaryPlan.segments[edge.to];
      if (segment) independentStarts.add(segment.start);
    }
  }
  let carry: SegmentCarry = {};
  for (const segment of segments) {
    if (independentStarts?.has(segment.start)) carry = {};
    const state = takeBoundaryParsedState(
      boundaryPlan, segment.start, segment.end, segment.text
    ) ?? parseClauseState(segment.text, options);
    applyCarryForward(state, carry);
    yield state;
    updateCarryForward(carry, state);
  }
}

function scopeCoordinatedSegmentStates(
  states: ParserState[],
  boundaryPlan: BoundaryPlan,
  segments: ReturnType<typeof parseSigSegments>,
  input: string
): void {
  if (!boundaryPlan.relations.length) return;
  applyCoordinatedCadenceScopes(
    states.map((state, index) => ({
      state,
      start: segments[index].start,
      end: segments[index].end
    })),
    boundaryPlan,
    input
  );
}

function expandRegimenGraphMembers(
  graph: ReturnType<typeof buildRegimenGraph>,
  projectionCounts: readonly number[]
): ReturnType<typeof buildRegimenGraph> {
  const projectedIndices: number[][] = [];
  let next = 0;
  for (const count of projectionCounts) {
    const indices: number[] = [];
    for (let offset = 0; offset < count; offset += 1) indices.push(next++);
    projectedIndices.push(indices);
  }
  return {
    ...graph,
    phases: graph.phases.map((phase) => {
      const members: number[] = [];
      for (const member of phase.members) members.push(...(projectedIndices[member] ?? []));
      return { ...phase, members };
    }),
    sequences: graph.sequences.map((edge) => ({ ...edge }))
  };
}

function retainComposedMembers<T>(values: readonly T[], absorbed: ReadonlySet<number>): T[] {
  return values.filter((_value, index) => !absorbed.has(index));
}

/**
 * Parallel-course construction consumes projected canonical HPSG members,
 * never already-lowered FHIR. Site conjunctions are expanded only through
 * the typed administration-target group, with a matching typed regimen graph.
 */
function prepareCanonicalParallel(
  states: readonly ParserState[],
  segments: ReturnType<typeof parseSigSegments>,
  plan: BoundaryPlan,
  graph: ReturnType<typeof buildRegimenGraph>
) {
  if (!graph.sequences.length || !plan.relations.some(edge => edge.kind === 'independent')) {
    return { kind: 'not-parallel' as const };
  }
  const clauses: CanonicalSigClause[] = [];
  const projectedSegments: ReturnType<typeof parseSigSegments> = [];
  const counts: number[] = [];
  for (let index = 0; index < states.length; index++) {
    const state = states[index];
    const targets = administrationTargetProjections(state.clauses);
    counts.push(targets.length);
    for (const target of targets) {
      clauses.push(getPrimaryClause(
        projectAdministrationTargetClauses(state.clauses, target), state.input
      ));
      projectedSegments.push(segments[index]);
    }
  }
  return buildCanonicalParallelRegimen(
    clauses, projectedSegments, plan, expandRegimenGraphMembers(graph, counts)
  );
}


/** Compose already interpreted segments once, before any FHIR lowering.
 * Sync, async and lint consumers share exactly the same semantic orchestration.
 * @param input Original instruction for source-span provenance.
 * @param boundaryPlan Typed constituent/boundary ownership.
 * @param segments Segment views selected by the boundary planner.
 * @param states Clause states after the caller's terminology resolvers complete.
 */
function composeParsedStates(
  input: string, boundaryPlan: BoundaryPlan,
  segments: ReturnType<typeof parseSigSegments>, states: ParserState[],
  options?: ParseOptions
) {
  scopeCoordinatedSegmentStates(states, boundaryPlan, segments, input);
  scopeTrailingSharedDuration(states, segments);
  scopeTrailingSharedNegativeInstructions(states, boundaryPlan, segments, input);
  scopeMedicationConditionTargets(states, boundaryPlan, segments);
  const regimenGraph = buildRegimenGraph(boundaryPlan, segments, states);
  scopeSequentialPhaseSemantics(states, segments, regimenGraph, input, options);
  const timingComposition = states.length > 1
    ? composeCoordinatedTimingAnchors(states, boundaryPlan, segments, input)
    : undefined;
  const hasComposedTiming = Boolean(timingComposition?.absorbed.size);
  const outputStates = hasComposedTiming
    ? retainComposedMembers(states, timingComposition!.absorbed)
    : states;
  const outputSegments = hasComposedTiming
    ? retainComposedMembers(segments, timingComposition!.absorbed)
    : segments;
  const outputRegimenGraph = hasComposedTiming
    ? buildRegimenGraph(boundaryPlan, outputSegments)
    : regimenGraph;
  const expanded = expandRegimenAdjustmentPhases(outputStates, outputSegments, outputRegimenGraph);
  const phaseSequences = regimenMemberSequences(expanded.graph);
  return { regimenGraph, outputStates: expanded.states, outputSegments: expanded.segments,
    outputRegimenGraph: expanded.graph, phaseSequences };
}

/**
 * Lower proven HPSG alternative edges into explicit must-understand choice
 * membership. The original segment supplies stable branch identity, so several
 * projected targets of the same branch remain one option rather than new ORs.
 * No text is reparsed and no branch is selected during interpretation.
 * @param results Source-rebased, independently editable administration results.
 * @param plan The production typed boundary/regimen relations.
 */
function applyRegimenAlternativeMembership(
  results: readonly ParseResult[], plan: BoundaryPlan, parallel?: CanonicalCourse
): void {
  const edges = plan.relations.filter(edge => edge.kind === "alternative");
  if (!edges.length) return;
  const nativeMembers = new Map<number, CanonicalAdministration[]>();
  if (parallel) for (const stage of parallel.stages) for (const administration of stage.administrations) {
    const index = administration.sourceMember;
    if (index === undefined) continue;
    let members = nativeMembers.get(index);
    if (!members) nativeMembers.set(index, members = []);
    members.push(administration);
  }
  const parent = new Map<number, number>();
  const root = (index: number): number => {
    let current = index;
    while (parent.has(current) && parent.get(current) !== current) current = parent.get(current)!;
    return current;
  };
  for (const edge of edges) {
    if (!parent.has(edge.from)) parent.set(edge.from, edge.from);
    if (!parent.has(edge.to)) parent.set(edge.to, edge.to);
    const left = root(edge.from), right = root(edge.to);
    parent.set(Math.max(left, right), Math.min(left, right));
  }
  const groups = new Map<number, number[]>();
  for (const member of parent.keys()) {
    const group = root(member);
    const members = groups.get(group) ?? [];
    members.push(member); groups.set(group, members);
  }
  const ordered = [...groups.values()].map(members => members.sort((a, b) => a - b))
    .sort((left, right) => left[0] - right[0]);
  for (let group = 0; group < ordered.length; group++) {
    for (const member of ordered[group]) {
      const segment = plan.segments[member];
      if (!segment) continue;
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        const raw = result.meta.canonical.clauses[0]?.raw;
        if (!raw || raw.start < segment.start || raw.start >= segment.end) continue;
        const choice = { groupId: `choice-${group + 1}`, branchId: `branch-${member + 1}` };
        if (result.meta.canonical.administration) result.meta.canonical.administration.choice = choice;
        for (const administration of nativeMembers.get(index) ?? []) administration.choice = choice;
        setDosageAlternativeChoice(result.fhir, { ...choice, selectionBehavior: "exactly-one" });
      }
    }
  }
}

/** Lower the common sync/async result after terminology resolution.
 * @param input Original clinician instruction.
 * @param options Terminology and rendering options.
 * @param boundaryPlan Completed typed boundary plan.
 * @param segments Ordered parsed segments.
 * @param states Resolved clause states; never parsed again here.
 */
function finishParsedBatch(
  input: string, options: ParseOptions | undefined, boundaryPlan: BoundaryPlan,
  segments: ReturnType<typeof parseSigSegments>, states: ParserState[]
): ParseBatchResult {
  const { regimenGraph, outputStates, outputSegments, outputRegimenGraph, phaseSequences } =
    composeParsedStates(input, boundaryPlan, segments, states, options);
  const canonicalParallel = prepareCanonicalParallel(outputStates, outputSegments, boundaryPlan, outputRegimenGraph);
  const hasParallel = canonicalParallel.kind === "resolved" ||
    canonicalParallel.kind === "unresolved" && Boolean(canonicalParallel.tracks);
  const rawResults: ParseResult[] = [];
  const projectedBatches: ParseResult[][] = [];

  for (let index = 0; index < outputSegments.length; index += 1) {
    const projected = buildParseResults(outputStates[index], options, phaseSequences[index],
      !hasParallel);
    projectedBatches.push(projected);
    rawResults.push(...projected);
  }

  // Complete native clinical meaning before any course-level projection.
  // Diagnostic spans are independently cloned/rebased below. In particular,
  // do not serialize R6/R5 here and then serialize them a second time in the
  // whole-course result builder.
  const parallel = canonicalParallel.kind === "resolved"
    ? courseFromParallel(canonicalParallel, rawResults.map(result => result.longText), input)
    : canonicalParallel.kind === "unresolved" && canonicalParallel.tracks
      ? courseFromPartialParallel(canonicalParallel, rawResults.map(result => result.longText), input)
      : undefined;
  for (let index = 0; index < projectedBatches.length; index += 1) {
    const shiftedSpans = new WeakSet<object>();
    for (const result of projectedBatches[index]) {
      rebaseParseResult(result, input, outputSegments[index].start, shiftedSpans);
    }
  }

  const results = rawResults;
  applyRegimenAlternativeMembership(results, boundaryPlan, parallel);
  const primary = resolvePrimaryParseResult(results, input, options);
  return buildWholeCourseResult(input, results, primary, segments, regimenGraph, options,
    parallel ? { canonical: parallel } : undefined);
}

export function parseSig(input: string, options?: ParseOptions): ParseBatchResult {
  const boundaryPlan = createBoundaryPlan(input, options);
  const segments = expandMealDashSegments(boundaryPlan.segments, options);
  const states: ParserState[] = [];
  for (const state of iterateCoordinatedSegmentStates(options, boundaryPlan, segments)) {
    applyPrnReasonCoding(state, options);
    applySiteCoding(state, options);
    applyInstructionSemanticResolvers(state, options);
    states.push(state);
  }
  return finishParsedBatch(input, options, boundaryPlan, segments, states);
}

export function lintSig(input: string, options?: ParseOptions): LintBatchResult {
  const boundaryPlan = createBoundaryPlan(input, options);
  const segments = expandMealDashSegments(boundaryPlan.segments, options);
  const states: ParserState[] = [];
  for (const state of iterateCoordinatedSegmentStates(options, boundaryPlan, segments)) {
    applyPrnReasonCoding(state, options);
    applySiteCoding(state, options);
    states.push(state);
  }
  const { outputStates, outputSegments, phaseSequences } =
    composeParsedStates(input, boundaryPlan, segments, states, options);
  const results: LintResult[] = [];
  const resultSegments: typeof segments = [];

  for (let index = 0; index < outputSegments.length; index += 1) {
    const segment = outputSegments[index];
    const state = outputStates[index];
    const groups = findUnparsedTokenGroups(state);
    const recognizedIssues: LintIssue[] = groups.map((group) => {
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
    const projected = buildParseResults(state, options, phaseSequences[index]);
    const shiftedSpans = new WeakSet<object>();
    for (const result of projected) {
      rebaseParseResult(result, input, segment.start, shiftedSpans);
      const issues = [...recognizedIssues];
      issues.push(
        ...buildSemanticLintIssues(result, input, {
          start: segment.start,
          end: segment.start + segment.text.length
        })
      );
      results.push({ result, issues });
      resultSegments.push(segment);
    }
  }

  const lintParseResults = results.map((item) => item.result);
  applyRegimenAlternativeMembership(lintParseResults, boundaryPlan);
  for (let index = 0; index < lintParseResults.length; index++) {
    const segment = resultSegments[index];
    for (const warning of lintParseResults[index].warnings) {
      if (!warning.startsWith("Unresolved schedule")) continue;
      if (results[index].issues.some(issue => issue.message === warning)) continue;
      results[index].issues.push({
        message: warning,
        text: segment.text,
        tokens: [],
        range: { start: segment.start, end: segment.end }
      });
    }
  }
  for (const entry of results) {
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
  const primary = resolvePrimaryLintResult(results, input, options);
  const issues: LintIssue[] = [];
  const seenIssues = new Set<string>();
  for (const entry of results) {
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
    count: results.length,
    items: results,
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
  const states: ParserState[] = [];
  for (const state of iterateCoordinatedSegmentStates(options, boundaryPlan, segments)) {
    await applyPrnReasonCodingAsync(state, options);
    await applySiteCodingAsync(state, options);
    await applyInstructionSemanticResolversAsync(state, options);
    states.push(state);
  }
  return finishParsedBatch(input, options, boundaryPlan, segments, states);
}


/** Append structured rate ranges ONLY to a freshly computed preview.
 * Authored text is selected by the CALLER, not inferred here from the
 * presence of Dosage.text (which may be unused during structured editing).
 * Ordinary one-entry SIGs exit at the single optional-field check. */
function appendSourceLessRateRanges(
  displayed: string, dosage: FhirDosage, words: CourseLanguage
): string {
  const entries = dosage.doseAndRate;
  if (!entries?.length) return displayed;
  if (entries.length === 1 && !entries[0].rateRange) return displayed;
  const expressions: string[] = [];
  for (const entry of entries) {
    const range = entry.rateRange && rateRangePreview(rangeFromFhir(entry.rateRange)!);
    if (range) expressions.push(words.rateRangeLabel + range);
  }
  return expressions.length
    ? joinGeneratedClauses(displayed ? [displayed, ...expressions] : expressions)
    : displayed;
}

/** Compact clauses cannot carry independent phase origins, references or qualified ranges. */
function needsNativeR5Preview(dosage: EzDosage, options?: FormatOptions): boolean {
  // The compact calendar view requires a civil day. Native rendering keeps
  // authored year/month precision visible without assigning a missing date.
  for (const event of dosage.timing?.event ?? [])
    if (event !== null && /^\d{4}(?:-\d{2})?$/u.test(event)) return true;
  // The native schedule owns independent Timing.code text. Keep that label
  // visible without promoting arbitrary prose into the compact lexical code.
  const timingLabel = dosage.timing?.code?.text;
  if (timingLabel && independentTimingText(timingLabel, dosage.timing?.repeat) &&
      !preferredTimingCoding(dosage.timing!)?.code) return true;
  // Native quantities retain opaque duration units and independent endpoints.
  const duration = dosage.timing?.repeat?.boundsDuration;
  const durationRange = dosage.timing?.repeat?.boundsRange;
  if (duration?.value !== undefined && !getQuantityDurationUnit(duration) ||
      durationRange?.low?.value !== undefined && !getQuantityDurationUnit(durationRange.low) ||
      durationRange?.high?.value !== undefined && !getQuantityDurationUnit(durationRange.high)) return true;
  const missingSite = !dosage.site?.text && !dosage.site?.coding?.some(coding => coding.code);
  if (missingSite && dosage.siteReference?.display) return true;
  if (dosage.modifierExtension?.some(extension => extension.url === PARALLEL_COMPONENT_PHASE_ORIGIN_URL ||
      extension.url === DOSAGE_DETAILS_R5_URL &&
      extension.extension?.some(child => child.url === "timingOffsets" || missingSite &&
        // Compact rows expose the retained reference directly. Historical
        // full-course rows use the existing native owner reconciliation.
        (child.url === "dosageDetails" || child.url === "component" &&
          child.extension?.some(field => field.url === "site" &&
            field.valueCodeableReference?.reference?.display)) ||
        (child.url === "step" || child.url === "course") && child.extension?.some(field => field.url === "safety"))))
    return true;
  const primary = dosage.doseAndRate?.[0];
  // Native source ownership preserves directions beside independent advice.
  // Unverified roundtrip inputs already take that path in sourceDisplayEdit;
  // verified source mode retains the existing graph-source replay below.
  if (!primary && !dosage.method && dosage.text?.trim() && options?.realizationMode !== "roundtrip") return true;
  if (primary?.extension?.some(extension => extension.url === R5_EXPRESSION_SLOT_SOURCE_URL)) return true;
  if ((dosage.doseAndRate?.length ?? 0) > 1 || hasAmountRole(primary?.type)) return true;
  if ((primary?.rateQuantity || primary?.rateRatio || primary?.rateRange || primary?.doseExpression || primary?.rateExpression) &&
      !dosage.text?.trim()) return true;
  // Normalization is the default, including when no mode is supplied.
  // Explicit source replay keeps its separate authored-text behavior.
  if (options?.realizationMode !== "roundtrip" &&
      (primary?.rateQuantity || primary?.rateRatio || primary?.rateRange ||
       primary?.doseExpression || primary?.rateExpression || dosage.maxDosePerPeriod?.length ||
       dosage.maxDosePerAdministration || dosage.maxDosePerLifetime || dosage.safety ||
       dosage.condition?.length || dosage.modifierExtension?.some(extension =>
         extension.url === DOSAGE_CONDITION_R5_URL))) return true;
  const range = primary?.doseRange;
  return Boolean(range && (getQuantityComparator(range.low) || getQuantityComparator(range.high) ||
    range.low?.value !== undefined && range.high?.value !== undefined &&
    (range.low.unit ?? getDoseQuantityUnit(range.low)) !==
    (range.high.unit ?? getDoseQuantityUnit(range.high))));
}

/** Apply display defaults without changing the supplied plain options. */
function defaultFormatOptions(options?: FormatBatchOptions, separator?: string): FormatBatchOptions {
  if (options?.realizationMode !== undefined && separator === undefined) return options;
  return {
    ...options,
    realizationMode: options?.realizationMode ?? "normalized",
    ...(separator !== undefined ? { separator } : {}),
  };
}

export function formatSig(
  input: FhirDosage | FhirR6DosageInstructionInput | readonly EzDosage[] | CanonicalCourse | CanonicalAdministration,
  style: "short" | "long" = "short",
  options?: FormatOptions
): string {
  options = defaultFormatOptions(options);
  if (Array.isArray(input)) {
    return formatSigBatch(input as EzDosage[], style, options);
  }
  if ("kind" in input && input.kind === "course")
    return formatCanonicalCourse(input, style, options);
  if ("kind" in input && input.kind === "administration")
    return formatCanonicalAdministration(input, style, options);
  const oneOrCourse = input as FhirDosage | FhirR6DosageInstructionInput;
  if (isR6DosageInstruction(oneOrCourse)) {
    const source = unchangedR6SourceDisplay(oneOrCourse, options);
    if (source !== undefined) return source;
    return formatCanonicalCourse(courseFromR6(oneOrCourse, true), style, options);
  }
  const dosage = oneOrCourse as EzDosage;
  const edit = sourceDisplayEdit(dosage);
  if (typeof edit === "string" && options?.realizationMode === "roundtrip") return edit;
  if (getDosageSourceTextAgreement(dosage, false) === false || edit !== false) {
    const course = courseFromR5([dosage], undefined, undefined, undefined, true);
    // Source agreement or the submitted fields rejected retained wording.
    // Carry that result into the generated native view.
    const administration = course.stages.find(stage => stage.administrations.length)?.administrations[0];
    if (administration?.provenance) administration.provenance.sourceTextVerified = false;
    (course.provenance ??= { format: "r5", data: {} }).sourceTextVerified = false;
    const authored = typeof edit === "object" && options?.realizationMode === "roundtrip"
      ? { text: edit.authored, rendered: false } : undefined;
    const rendered = formatCanonicalCourse(course, style, options ?? {}, undefined, authored);
    if (authored && !authored.rendered) {
      const words = resolveCourseLanguage(options?.locale, options?.i18n);
      return words.withAuthoredDirections(rendered.replace(/\.\s*$/u, ""), authored.text);
    }
    return rendered;
  }
  if (needsNativeR5Preview(dosage, options))
    return formatCanonicalCourse(courseFromR5([dosage], undefined, undefined, undefined, true), style, options ?? {});
  const hasModifiers = Boolean(dosage.modifierExtension?.length);
  let displayCondition = dosage.condition?.length
    ? getDosageCondition(dosage)
    : undefined;
  let displayExcludedDates = dosage.excludedDates?.length
    ? [...dosage.excludedDates]
    : [];
  const displayExcludedWeekdays = getDosageExcludedWeekdays(dosage);
  let hasDisplayRelevantModifier = displayExcludedWeekdays.length > 0;
  if (hasModifiers) {
    if (!displayCondition) displayCondition = getDosageCondition(dosage);
    displayExcludedDates = getDosageExcludedDates(dosage);
    hasDisplayRelevantModifier = displayCondition !== undefined ||
      displayExcludedDates.length > 0 || displayExcludedWeekdays.length > 0;
  }
  if (hasMaximumDoseForDisplay(dosage)) {
    if (typeof dosage.text === "string" && dosage.text.trim().length > 0) {
      return dosage.text;
    }
    const clause = canonicalFromFhir(dosage, options);
    const localization = resolveSigLocalization(options?.locale, options?.i18n);
    let displayed = provisionalFhirDisplay(dosage, clause, style, localization, options, false);
    if (displayCondition && style !== "long") {
      displayed = appendMedicationConditionText(displayed, displayCondition, options);
    }
    if (displayExcludedDates.length) {
      displayed = appendMedicationExcludedDatesText(displayed, displayExcludedDates, options);
    }
    if (displayExcludedWeekdays.length) {
      displayed = appendMedicationExcludedWeekdaysText(displayed, displayExcludedWeekdays, options);
    }
    return appendSourceLessRateRanges(displayed, dosage,
      resolveCourseLanguage(options?.locale,options?.i18n,localization));
  }
  const quantity = dosage.doseAndRate?.[0];
  // Until rich rate and relative-weight units have dedicated realizers, retain
  // the prescriber's original statement instead of silently dropping semantics.
  if (dosage.text && (
    quantity?.rateQuantity || quantity?.rateRatio || quantity?.rateRange ||
    quantity?.doseExpression || quantity?.rateExpression ||
    (quantity?.doseQuantity?.unit !== undefined &&
      quantity.doseQuantity.unit.indexOf("/kg") >= 0) ||
    dosage.condition?.length || dosage.safety || dosage.siteReference ||
    dosage.excludedDates?.length ||
    hasDisplayRelevantModifier
  )) return dosage.text;
  const clause = canonicalFromFhir(dosage, options);
  // Roundtrip can reuse an HPSG-owned source quantity omitted from the
  // auxiliary action graph only when the persisted R5 clinical projection
  // STILL matches. A newly added/edited dose invalidates that source replay.
  // Other format modes need that proof only when the live dose was removed.
  markOriginalGraphSource(dosage,clause,options);
  const localization = resolveSigLocalization(options?.locale, options?.i18n);
  const rendered = formatCanonicalClause(clause, style, localization, options);
  let displayed = displayCondition && style !== "long"
    ? appendMedicationConditionText(rendered, displayCondition, options)
    : rendered;
  if (displayExcludedDates.length) {
    displayed = appendMedicationExcludedDatesText(displayed, displayExcludedDates, options);
  }
  if (displayExcludedWeekdays.length) {
    displayed = appendMedicationExcludedWeekdaysText(displayed, displayExcludedWeekdays, options);
  }
  return appendSourceLessRateRanges(displayed, dosage,
    resolveCourseLanguage(options?.locale,options?.i18n,localization));
}

export function formatSigBatch(
  dosages:FhirDosage[],style:"short"|"long"="short",options?:FormatBatchOptions
):string {
  const separator=options?.separator??", ";
  const sequence=dosages[0]?.sequence??1;
  let hasCourse=false,hasChoice=false;
  // One classification walk. Do not format through an R6 intermediary or
  // repeat a whole-array scan for each independent classification flag.
  for(const dosage of dosages){
    if((dosage.sequence??1)!==sequence)hasCourse=true;
    for(const e of dosage.modifierExtension??[])
      if(e.url===DOSAGE_DETAILS_R5_URL||e.url===PARALLEL_COMPONENT_PHASE_ORIGIN_URL)hasCourse=true;
    if(!hasChoice&&getDosageAlternativeChoice(dosage))hasChoice=true;
  }
  if(hasCourse||hasChoice) {
    // The complete native group owns choice wording; individual row previews
    // may already need that formatter for their independent clinical facts.
    return formatCanonicalCourse(courseFromR5(dosages,undefined,undefined,undefined,true),style,
      defaultFormatOptions(options, hasCourse ? undefined : separator));
  }
  const text:string[]=[];
  for(const dosage of dosages){const value=formatSig(dosage,style,options);if(value.trim())text.push(value);}
  return text.join(separator);
}

// Retain the native renderer's presentation decision on its immutable result.
const importedBatchesWithHeaderDirections = new WeakSet<ParseBatchResult>();

export function formatParseBatch(batch:ParseBatchResult,style:"short"|"long"="short",separator=", "):string {
  // Keep already-localized whole-course timing and choice wording. Ordinary
  // items are collected once without mapping an unused array of FHIR rows.
  const wireSteps=batch.fhirNext.step;
  if(wireSteps!==undefined&&wireSteps.length>1)return style==="short"?batch.shortText:batch.longText;
  return formatParseBatchContents(batch,style,separator,wireSteps);
}

function formatParseBatchContents(
  batch:ParseBatchResult,style:"short"|"long",separator:string,
  wireSteps:ParseBatchResult["fhirNext"]["step"]
):string {
  const course=batch.meta.canonical.course,steps=course?.stages??wireSteps;
  const whole=style==="short"?batch.shortText:batch.longText;
  // Preserve the imported renderer's selected directions without repeating
  // its clinical-fact classification or replacing independent item joining.
  if(importedBatchesWithHeaderDirections.has(batch)||
      course?.provenance?.format==="r6"&&course.instruction&&whole===course.instruction)return whole;
  if(steps&&steps.length>1)return whole;
  if(batch.fhirNext.repeatCycle||batch.fhirNext.safety||course?.cycleCount!==undefined||course?.cycleCountUnresolved)
    return style==="short"?batch.shortText:batch.longText;
  for(const step of steps??[])if(step.start||step.end||step.count!==undefined||step.safety)
    return style==="short"?batch.shortText:batch.longText;
  const text:string[]=[];
  const members=batch.meta.canonical.course?.stages[0]?.administrations;
  let memberIndex=0;
  for(const item of batch.items){
    const member=members?.[memberIndex++];
    if(member?.phaseOrigin||member?.phaseStart||member?.phasePredecessors?.length||getDosageAlternativeChoice(item.fhir))
      return style==="short"?batch.shortText:batch.longText;
    const value=style==="short"?item.shortText:item.longText;if(value?.trim())text.push(value);
  }
  return text.join(separator);
}

/**
 * Load the current R6 DosageInstruction without reparsing a generated text instruction.
 * Native components are imported into the same clinical course the parser
 * produces. R5 component rows are OUTPUT projections only, never interpreted
 * or formatted back into native semantics.
 */
export function fromFhir(
  wire: FhirR6DosageInstructionInput,
  options?: FormatOptions
): ParseBatchResult {
  const importWarnings = assertCurrentR6DosageInstruction(wire);
  let dosageDetails = wire;
  if (wire.step?.length === 0) {
    const { step: _emptyStep, ...header } = wire;
    dosageDetails = header;
  }
  // R5 is a public output only. Project its strict component view and
  // extended editable view in ONE component traversal; do not separately
  // lower this entire R6 course into R5 twice just to format native items.
  const native = courseFromR6(dosageDetails, true);
  const projection = projectNativeR5Course(native,undefined,true,false,false,true,undefined,true);
  const hasAdministrations = native.stages.some(stage => stage.administrations.length);
  if (!hasAdministrations) projection.dosages = [];
  const course = projection.course;
  const strict = projection.strictDosages ?? projection.dosages;
  const normalizedStrict = strict.length
    ? normalizeEmittedSemanticMarkers(strict, projection.dosages === strict)
    : strict;
  const r5Rows = normalizedStrict.length
    ? hasAdministrations
      ? withDosageEditProvenance(normalizedStrict, dosageDetails.renderedInstruction, false, projection.sourceBaselines,
          native.provenance?.sourceTextAgreed === true)
      : normalizedStrict
    : toFhirR5Dosages(dosageDetails); // zero-component text/safety carrier only
  const dosages = projection.dosages === normalizedStrict
    ? r5Rows
    : withDosageEditProvenance(projection.dosages, dosageDetails.renderedInstruction, false, projection.sourceBaselines,
        native.provenance?.sourceTextAgreed === true);
  const compiled = new Map<CanonicalAdministration, CanonicalSigClause>();
  const items: ParseResult[] = [];
  let row = 0;
  for (const stage of native.stages) for (const administration of stage.administrations) {
    const clause = clauseForAdministration(administration, options);
    compiled.set(administration, clause);
    const projection = r5Rows[row++];
    items.push({
      fhir: projection,
      shortText: formatCanonicalAdministration(administration, "short", options, compiled, undefined, stage.safety),
      longText: formatCanonicalAdministration(administration, "long", options, compiled, undefined, stage.safety),
      warnings: clause.warnings ?? [],
      meta: { consumedTokens: [],
        normalized: buildNormalizedMetaFromClause(clause, projection, options),
        canonical: { clauses: [clause], administration }
      }
    });
  }
  const authored = native.instruction
    ? { text: native.instruction, rendered: false, headerRendered: false } : undefined;
  const shortText = formatCanonicalCourse(native, "short", options, compiled, authored);
  const longText = formatCanonicalCourse(native, "long", options, compiled, authored);
  // A header-only instruction keeps the editable carrier. Its course
  // constraints are visible on that item as well as the batch preview.
  if (!items.length && r5Rows.length) {
    const text = native.instruction ?? "";
    const clause = createEmptyCanonicalClause(text);
    const structured = native.safety || native.cycleInterval || native.cycleCount !== undefined ||
      native.cycleCountUnresolved || native.stages.length;
    items.push({ fhir: r5Rows[0],
      shortText: structured ? shortText : text,
      longText: structured ? longText : text, warnings: [],
      meta: { consumedTokens: [], normalized: {}, canonical: { clauses: [clause] } } });
  }
  const primary = items[0] ?? fromFhirDosage({
    text: dosageDetails.renderedInstruction ?? ""
  }, options);
  const clauses: CanonicalSigClause[] = [];
  const warnings = new Set<string>(importWarnings);
  for (const item of items) {
    clauses.push(...item.meta.canonical.clauses);
    for (const warning of item.warnings) warnings.add(warning);
  }
  // Importing structured R6 data is best-effort and data-preserving.
  const result: ParseBatchResult = {
    input: dosageDetails.renderedInstruction ?? "",
    count: items.length,
    items,
    // A valid text-only R6 instruction has zero components but still needs
    // an editable R5 text row. Do not return [] and lose that instruction.
    fhir: dosages.length ? dosages : r5Rows,
    fhirNext: dosageDetails,
    course,
    shortText,
    longText,
    warnings: [...warnings],
    meta: {
      ...primary.meta,
      canonical: { clauses, course: native },
      // An imported FHIR object has no original per-clause character positions.
      segments: []
    }
  };
  if (authored?.headerRendered) importedBatchesWithHeaderDirections.add(result);
  return result;
}

/**
 * An import can display facts it understands even when no safe *complete*
 * SIG can be generated. The label is deliberately non-prescriptive and is
 * never written into FHIR Dosage.text: unrendered safety still requires review.
 */
function provisionalFhirDisplay(
  dosage: FhirDosage,
  clause: CanonicalSigClause,
  style: "short" | "long",
  localization: ReturnType<typeof resolveSigLocalization>,
  options?: FormatOptions,
  showIncompleteLabel = true
): string {
  const words=resolveCourseLanguage(options?.locale,options?.i18n,localization);
  const prefix=words.incompleteInterpretation;
  const recognized = formatCanonicalClause(clause, style, localization, options).trim();
  const maximums: string[] = [];
  const readableQuantity = (quantity: FhirQuantity | undefined): string | undefined => {
    if (quantity?.value === undefined || !Number.isFinite(quantity.value)) return undefined;
    const unit = quantity.unit ?? quantity.code;
    const comparator = getQuantityComparator(quantity);
    return `${comparator ?? ""}${quantity.value}${unit ? " " + unit : ""}`;
  };
  const perAdministration = readableQuantity(dosage.maxDosePerAdministration);
  const lifetime = readableQuantity(dosage.maxDosePerLifetime);
  if (perAdministration) maximums.push(words.maxAdministrationLabel+perAdministration);
  if (lifetime) maximums.push(words.maxLifetimeLabel+lifetime);
  for (const period of dosage.maxDosePerPeriod ?? []) {
    const numerator = readableQuantity(period.numerator);
    const denominator = readableQuantity(period.denominator);
    if (numerator && denominator) maximums.push(words.maxPeriodLabel+numerator+" / "+denominator);
  }
  for (const amount of (dosage as EzDosage).doseAndRate ?? []) {
    if (amount.doseExpression)
      maximums.push(unevaluatedExpressionText(amount.doseExpression, "dose",words));
    if (amount.rateExpression)
      maximums.push(unevaluatedExpressionText(amount.rateExpression, "rate",words));
  }
  const body = joinGeneratedClauses([recognized, ...maximums].filter(Boolean));
  if (!showIncompleteLabel) return body || words.retainedStructure;
  return body ? `${prefix}: ${body}` : `${prefix}. ${words.retainedStructure}.`;
}

function fromFhirDosageInternal(
  dosage: FhirDosage,
  options: FormatOptions | undefined
): ParseResult {
  options = defaultFormatOptions(options);
  const edit = sourceDisplayEdit(dosage);
  const replacementText = typeof edit === "string" && options?.realizationMode === "roundtrip" ? edit : undefined;
  const unverified = replacementText === undefined &&
    (getDosageSourceTextAgreement(dosage, false) === false || edit !== false);
  const nativeCourse = unverified || needsNativeR5Preview(dosage, options)
    ? courseFromR5([dosage], undefined, undefined, undefined, true)
    : undefined;
  const nativeStage = nativeCourse?.stages.find(stage => stage.administrations.length);
  const native = nativeStage?.administrations[0];
  const nativeDisplayCourse: CanonicalCourse | undefined = native && nativeCourse?.safety ? {
    kind: "course", safety: nativeCourse.safety,
    stages: [{ administrations: [native], safety: nativeStage?.safety }],
  } : undefined;
  if (unverified && native?.provenance) native.provenance.sourceTextVerified = false;
  if (unverified && nativeCourse && !native)
    (nativeCourse.provenance ??= { format: "r5", data: {} }).sourceTextVerified = false;
  const hasMaximumDose = hasMaximumDoseForDisplay(dosage);
  const maximumDoseSource = !unverified && hasMaximumDose &&
      typeof dosage.text === "string" && dosage.text.trim().length > 0
    ? dosage.text
    : undefined;
  const suppressMaximumDisplay = hasMaximumDose && maximumDoseSource === undefined;
  const clause = native ? clauseForAdministration(native, options) : canonicalFromFhir(dosage, options);
  const compiled = native ? new Map([[native, clause]]) : undefined;
  // The saved fingerprint proves that a primary source dose still matches
  // its exported R5 clinical fields, even if the auxiliary instruction
  // graph contains no Amount. A removed dose also needs this ownership proof.
  markOriginalGraphSource(dosage,clause,options,native !== undefined);
  const localization = resolveSigLocalization(options?.locale, options?.i18n);
  const guarded = getDosageCondition(dosage) !== undefined ||
    getDosageExcludedDates(dosage).length > 0 ||
    getDosageExcludedWeekdays(dosage).length > 0;
  const exactSource = replacementText ?? maximumDoseSource ?? (!unverified && guarded && dosage.text ? dosage.text : undefined);
  const authored = typeof edit === "object" && options?.realizationMode === "roundtrip" ? edit.authored : undefined;
  const shortAuthored = authored ? { text: authored, rendered: false } : undefined;
  const longAuthored = authored ? { text: authored, rendered: false } : undefined;
  let shortText = replacementText ?? (nativeDisplayCourse
    ? formatCanonicalCourse(nativeDisplayCourse, "short", options, compiled, shortAuthored)
    : native ? formatCanonicalAdministration(native, "short", options, compiled, shortAuthored, nativeStage?.safety)
    : nativeCourse ? formatCanonicalCourse(nativeCourse, "short", options, undefined, shortAuthored) : suppressMaximumDisplay
    ? provisionalFhirDisplay(dosage, clause, "short", localization, options, false)
    : exactSource ?? formatCanonicalClause(clause, "short", localization, options));
  let computedLong = replacementText ?? (nativeDisplayCourse
    ? formatCanonicalCourse(nativeDisplayCourse, "long", options, compiled, longAuthored)
    : native ? formatCanonicalAdministration(native, "long", options, compiled, longAuthored, nativeStage?.safety)
    : nativeCourse ? formatCanonicalCourse(nativeCourse, "long", options, undefined, longAuthored) : suppressMaximumDisplay
    ? provisionalFhirDisplay(dosage, clause, "long", localization, options, false)
    : exactSource ?? formatCanonicalClause(clause, "long", localization, options));
  if (!exactSource && !nativeCourse) {
    const condition = getDosageCondition(dosage);
    const exclusions = getDosageExcludedDates(dosage);
    const excludedWeekdays = getDosageExcludedWeekdays(dosage);
    if (condition) {
      shortText = appendMedicationConditionText(shortText, condition, options);
    }
    if (exclusions.length) {
      shortText = appendMedicationExcludedDatesText(shortText, exclusions, options);
      computedLong = appendMedicationExcludedDatesText(computedLong, exclusions, options);
    }
    if (excludedWeekdays.length) {
      shortText = appendMedicationExcludedWeekdaysText(shortText, excludedWeekdays, options);
      computedLong = appendMedicationExcludedWeekdaysText(computedLong, excludedWeekdays, options);
    }
    const words=resolveCourseLanguage(options?.locale,options?.i18n,localization);
    shortText = appendSourceLessRateRanges(shortText, dosage, words);
    computedLong = appendSourceLessRateRanges(computedLong, dosage, words);
  }
  if (typeof edit === "object" && options?.realizationMode === "roundtrip") {
    // The explicit replacement is independently authored prose. Current
    // structured fields remain the directions; do not certify or parse it.
    const words = resolveCourseLanguage(options.locale, options.i18n, localization);
    if (!shortAuthored?.rendered)
      shortText = words.withAuthoredDirections(shortText.replace(/\.\s*$/u, ""), edit.authored);
    if (!longAuthored?.rendered)
      computedLong = words.withAuthoredDirections(computedLong.replace(/\.\s*$/u, ""), edit.authored);
  }
  const longText = computedLong || dosage.text || "";
  const warnings = [...(clause.warnings ?? [])];
  return {
    fhir: dosage,
    shortText,
    longText,
    warnings,
    meta: {
      consumedTokens: [],
      normalized: buildNormalizedMetaFromClause(clause, dosage, options),
      canonical: {
        clauses: [clause],
        ...(native ? { administration: native } : nativeCourse ? { course: nativeCourse } : {})
      }
    }
  };
}

export function fromFhirDosage(
  dosage: FhirDosage,
  options?: FormatOptions
): ParseResult {
  // Keep source-less structured imports useful without overwriting the fact
  // that no original Dosage.text was supplied.
  return fromFhirDosageInternal(dosage, options);
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
    version?: string;
    extension?: ReturnType<typeof cloneExtensions>;
  }
): {
  code?: string;
  display?: string;
  system?: string;
  version?: string;
  extension?: ReturnType<typeof cloneExtensions>;
} | undefined {
  if (!coding?.code && !coding?.display && !coding?.system) {
    return undefined;
  }
  return {
    code: coding.code,
    display: coding.display,
    system: coding.system,
    version: coding.version,
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
          ...(clause.site?.restrictions?.length ? {
            restrictions: cloneSiteRestrictions(clause.site.restrictions)
          } : {}),
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
  options?: ParseOptions,
  projectedTarget?: CanonicalSiteExpr,
  sequence?: number,
  compileStandaloneAdministration = true
): ParseResult {
  const canonicalClauses = projectAdministrationTargetClauses(
    state.clauses,
    projectedTarget
  );
  const clause = getPrimaryClause(canonicalClauses, state.input);
  const localization = resolveSigLocalization(options?.locale, options?.i18n);
  const graphUnderstoodSpans: TextRange[] = [];
  for (const candidate of canonicalClauses) {
    const graph = candidate.instructionGraph;
    if (!graph) continue;
    for (const action of graph.actions) graphUnderstoodSpans.push(action.span);
    for (const relation of graph.relations ?? []) {
      if (relation.span) graphUnderstoodSpans.push(relation.span);
    }
  }
  const sourceRangeUnderstoodByGraph = (value: { start: number; end: number }): boolean =>
    graphUnderstoodSpans.some((span) =>
      span.start <= value.start && value.end <= span.end
    );
  // The typed instruction graph already owns procedural IF/UNLESS scope.
  // Keep exact author wording when its free-standing modifier remains
  // unrealized, without dispatching on a lexical rule's production name.
  const hasUnrealizedTypedConditionSource = Boolean(
    clause.instructionGraph && !clause.instructionGraph.coverage?.complete &&
    clause.instructionGraph.relations?.some(relation =>
      relation.kind === "if" || relation.kind === "unless"
    ) && clause.leftovers.some(leftover => !sourceRangeUnderstoodByGraph(leftover))
  );
  // Rich typed HPSG meaning keeps the clinician's exact wording as its primary
  // realization. No source text is reparsed to make this choice.
  const hasUnrealizedLexicalTail = Boolean(
    clause.leftovers?.length && !clause.instructionGraph?.actions.length
  );
  // A retained instruction can already realize the complete local guard.
  // Its source evidence licenses normal formatting without losing the guard;
  // other clinical adjuncts still retain their exact original wording.
  const adjunct = clause.clinicalAdjuncts;
  const guardRanges = adjunct?.localRanges?.length ? adjunct.localRanges :
    adjunct?.evidence?.reduce<TextRange[]>((ranges, evidence) => {
      ranges.push(...evidence.spans);
      return ranges;
    }, []);
  const guardRenderedByInstruction = Boolean(
    adjunct?.condition &&
    !adjunct.excludedDates?.length && !adjunct.excludedWeekdays?.length &&
    guardRanges?.length && guardRanges.every(range =>
      clause.additionalInstructions?.some(instruction => instruction.text &&
        instruction.evidence?.some(evidence => evidence.spans.some(span =>
          span.start <= range.start && range.end <= span.end
        )))
    )
  );
  const useOriginalText = Boolean(
    clause.clinicalQuantity ||
    (adjunct?.localRanges?.length && !guardRenderedByInstruction) ||
    clause.schedule?.maxDosePerPeriod?.length ||
    hasUnrealizedTypedConditionSource ||
    hasUnrealizedLexicalTail
  );
  let shortText = useOriginalText
    ? clause.rawText
    : formatCanonicalClause(clause, "short", localization, options);
  let longText = useOriginalText
    ? clause.rawText
    : formatCanonicalClause(clause, "long", localization, options);
  // An adjunct inherited by a typed coordination construction has no local
  // source span in this daughter. Realize that already-resolved meaning before
  // the one FHIR projection instead of deleting and regenerating Dosage.text.
  if (clause.clinicalAdjuncts && !clause.clinicalAdjuncts.localRanges?.length) {
    const condition = clause.clinicalAdjuncts.condition;
    if (condition && !guardRenderedByInstruction) {
      shortText = appendMedicationConditionText(shortText, condition, options);
      if (useOriginalText)
        longText = appendMedicationConditionText(longText, condition, options);
    }
    const excludedDates = clause.clinicalAdjuncts.excludedDates ?? [];
    if (excludedDates.length) {
      shortText = appendMedicationExcludedDatesText(shortText, excludedDates, options);
      longText = appendMedicationExcludedDatesText(longText, excludedDates, options);
    }
    const excludedWeekdays = clause.clinicalAdjuncts.excludedWeekdays ?? [];
    if (excludedWeekdays.length) {
      shortText = appendMedicationExcludedWeekdaysText(shortText, excludedWeekdays, options);
      longText = appendMedicationExcludedWeekdaysText(longText, excludedWeekdays, options);
    }
  }
  const administration = compileStandaloneAdministration
    ? administrationFromClause(clause, longText, sequence) : undefined;
  const fhir = canonicalToFhir(clause, longText, {
    sequence,
    bodySitePostcoordination: options?.bodySitePostcoordination,
    includeTranslationExtensions: Boolean(options?.locale || options?.i18n)
  });
  // Mark immutable parser-origin source ownership. Defaulted amounts still
  // do not prove graph authorship; fresh submitted copies use persisted proof.
  markFreshDoseSource(fhir, clause.dose?.defaulted === true, administration
    ? administration.provenance?.sourceTextAgreed === true
    : Boolean(clause.instructionGraph?.actions.length) && !fhir.doseAndRate?.length, !useOriginalText);
  const tokenUnderstoodByGraph = (value: { sourceStart: number; sourceEnd: number }): boolean =>
    sourceRangeUnderstoodByGraph({ start: value.sourceStart, end: value.sourceEnd });
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
        clauses: canonicalClauses,
        administration
      },
      siteLookups,
      prnReasonLookups
    }
  };
}

function buildParseResults(
  state: ReturnType<typeof parseClauseState>,
  options?: ParseOptions,
  sequence?: number,
  compileStandaloneAdministration = true
): ParseResult[] {
  return administrationTargetProjections(state.clauses).map((target) =>
    buildParseResult(state, options, target, sequence, compileStandaloneAdministration)
  );
}

function applyCarryForward(internal: ParserState, carry: SegmentCarry): void {
  const routeChanged = internal.routeCode && carry.routeCode
    ? internal.routeCode !== carry.routeCode
    : Boolean(internal.routeText && carry.routeText && internal.routeText !== carry.routeText);
  if (routeChanged) {
    // An explicit new route starts a new site-inheritance scope. Only the
    // donor carry is cleared; a locally authored recipient site stays intact.
    carry.siteText = undefined;
    carry.siteI18n = undefined;
    carry.siteSource = undefined;
    carry.siteCoding = undefined;
    carry.siteSpatialRelation = undefined;
    carry.administrationTargetGroup = undefined;
  }
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
    const group = carry.administrationTargetGroup;
    // A site carried from an earlier segment retains its meaning, not the
    // donor's segment-local provenance. Rebase must never shift those spans
    // as if they originated in the recipient.
    internal.administrationTargetGroup = group && {
      ...group,
      range: undefined,
      targets: group.targets.map(target => ({
        ...target,
        range: undefined,
        evidence: undefined,
        restrictions: target.restrictions?.map(restriction => ({
          ...restriction,
          range: undefined,
          markerRange: undefined,
          predicate: { ...restriction.predicate, range: undefined }
        }))
      }))
    };
  }

  if (
    internal.dose === undefined &&
    internal.doseRange === undefined &&
    !internal.primaryClause.clinicalQuantity &&
    (carry.dose !== undefined || carry.doseRange !== undefined) &&
    internal.unit &&
    internal.unit === carry.unit
  ) {
    if (carry.doseRange) internal.doseRange = { ...carry.doseRange };
    else internal.dose = carry.dose;
    if (carry.comparator && internal.primaryClause.dose)
      internal.primaryClause.dose.comparator = carry.comparator;
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
    carry.administrationTargetGroup = internal.administrationTargetGroup;
  }
  if (internal.dose !== undefined || internal.doseRange !== undefined) {
    carry.dose = internal.dose;
    carry.doseRange = internal.doseRange;
    // A newly authored exact dose explicitly supersedes the previous
    // comparator. Only an actually inherited amount inherits its qualifier.
    carry.comparator = internal.primaryClause.dose?.comparator;
  } else if (internal.primaryClause.clinicalQuantity) {
    // A rate-only phase supersedes the prior scalar amount. Subsequent
    // elliptical phases cannot revive the earlier bolus as their dose.
    carry.dose = undefined;
    carry.doseRange = undefined;
    carry.comparator = undefined;
  }
}

function rebaseParseResult(
  result: ParseResult, fullInput: string, offset: number,
  shiftedSpans: WeakSet<object>
): void {
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
  if (offset !== 0) {
    // Public diagnostic ranges are document-relative; the canonical source
    // grammar remains segment-local. Clone the diagnostic view, not the
    // semantic course or serialized FHIR, so repeated exports remain stable.
    result.meta.canonical.clauses = cloneStructuredValue(result.meta.canonical.clauses);
    if (result.meta.normalized.instructionGraph)
      result.meta.normalized.instructionGraph = result.meta.canonical.clauses[0]?.instructionGraph;
  }
  shiftCanonicalSigClauses(result.meta.canonical.clauses, offset, shiftedSpans);
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
