import {
  toDosageDetails, toFhirR5Dosages as toFhirR5DosagesInternal, toEzDosages, fromDosageDetails,
  withDosageEditProvenance, fromR6Dosage,
  DOSAGE_DETAILS_R5_URL,
  getDosageAlternativeChoice, setDosageAlternativeChoice,
  getDosageCondition, getDosageExcludedDates, getDosageExcludedWeekdays
} from "./dosage-course";
import {
  buildCanonicalParallelRegimen, projectParallelRegimen, relativeTime
} from "./regimen/parallel-course";
import {
  applyCoordinatedCadenceScopes, composeCoordinatedTimingAnchors,
  scopeTrailingSharedDuration,
  scopeTrailingSharedNegativeInstructions, scopeMedicationConditionTargets
} from "./regimen/coordination-scope";
import type { EzCourseMetadata } from "./types";
import type { BoundaryPlan } from "./hpsg/signature";
import { createBoundaryPlan, takeBoundaryParsedState } from "./regimen/planner";
import {
  buildRegimenGraph, regimenMemberSequences,
  scopeSequentialPhaseSemantics, expandRegimenAdjustmentPhases, type RegimenGraph
} from "./regimen/regimen";
import {
  administrationTargetProjections,
  projectAdministrationTargetClauses
} from "./hpsg/projection";
import { DAY_NAMES, formatCanonicalClause, joinWithAnd } from "./format";
import { canonicalFromFhir, canonicalToFhir, ADMINISTRATION_OFFSET_EXTENSION_URL, TIMING_ACTIVITY_WINDOW_EXTENSION_URL } from "./fhir";
import { shiftCanonicalSigClauses } from "./ir";
import { DAY_NAMES_THAI, joinWithAndThai, resolveSigLocalization } from "./i18n";
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
  FhirDayOfWeek,
  FhirQuantity,
  EzDosage,
  EzDoseAndRate,
  FhirR6DosageDetails,
  FormatBatchOptions,
  FormatOptions,
  LintIssue,
  LintBatchResult,
  LintResult,
  ParseBatchResult,
  ParseBatchSegmentMeta,
  ParseOptions,
  ParseResult,
  MedicationCondition,
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
  toDosageDetails, toEzDosages, fromDosageDetails,
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
function prefersR6CourseSourceForDisplay(course: FhirR6DosageDetails): boolean {
  return Boolean(course.repeatCycle || course.safety ||
    course.step.some(step => step.start || step.end ||
      step.count !== undefined || step.safety ||
      step.component.some(component => component.condition?.length ||
        component.safety || component.site?.reference ||
        component.doseAndRate?.some(rate => rate.doseExpression || rate.rateExpression))));
}

/** R5 maximum-dose fields have no lossless canonical text realizer yet. */
function hasMaximumDoseForDisplay(dosage: FhirDosage): boolean {
  return Boolean(
    dosage.maxDosePerPeriod?.length ||
    dosage.maxDosePerAdministration ||
    dosage.maxDosePerLifetime
  );
}

function joinGeneratedClauses(clauses: string[]): string {
  return clauses.map((clause, index) =>
    index < clauses.length - 1 ? clause.replace(/\.\s*$/u, "") : clause
  ).join("; ");
}

/**
 * Lower existing typed administration delays into R6 step starts only when
 * every component of that step shares the same source-backed offset.
 * Incompatible individual component offsets stay at their existing R5
 * dosage extensions; they must never shift unrelated parallel administrations.
 */
function typedAdministrationOffsetSteps(
  results: readonly ParseResult[]
): NonNullable<EzCourseMetadata["step"]> | undefined {
  if (!results.some(item =>
    item.meta.canonical.clauses[0]?.schedule?.administrationOffsetMinutes !== undefined
  )) return undefined;

  const sequenceOffsets = new Map<number, Array<number | undefined>>();
  const anchoredSequences = new Set<number>();
  for (const item of results) {
    const sequence = item.fhir.sequence ?? 1;
    const offsets = sequenceOffsets.get(sequence) ?? [];
    offsets.push(item.meta.canonical.clauses[0]?.schedule?.administrationOffsetMinutes);
    sequenceOffsets.set(sequence, offsets);
    if (item.fhir.timing?.repeat?.timeOfDay?.length ||
        item.fhir.timing?.repeat?.when?.length) anchoredSequences.add(sequence);
  }
  const steps: NonNullable<EzCourseMetadata["step"]> = [];
  for (const [sequence, offsets] of sequenceOffsets) {
    const minutes = offsets[0];
    if (minutes === undefined || minutes <= 0 || !Number.isFinite(minutes) ||
        !offsets.every(offset => offset === minutes) ||
        anchoredSequences.has(sequence)) continue;
    // Absolute clock/event anchors stay on their component: shifting a whole
    // course start instead would discard the dose-local time modifier.
    const unit = minutes % 1440 === 0 ? "d" : minutes % 60 === 0 ? "h" : "min";
    const value = unit === "d" ? minutes / 1440 : unit === "h" ? minutes / 60 : minutes;
    steps.push({ sequence, start: relativeTime({ value, unit }) });
  }
  return steps.length ? steps : undefined;
}

/**
 * A source-typed relative phase onset can include a deliberate interval
 * with NO medication (for example, an explicit STOP for seven days before
 * resuming). Project that onset only when every component in the phase
 * agrees; neither the wire layer nor the scheduler interprets free text.
 */
function typedRelativePhaseStartSteps(
  results: readonly ParseResult[]
): NonNullable<EzCourseMetadata["step"]> | undefined {
  if (!results.some(item =>
    item.meta.canonical.clauses[0]?.schedule?.treatmentStartOffsetDays !== undefined
  )) return undefined;
  const bySequence = new Map<number, Array<number | undefined>>();
  for (const item of results) {
    const sequence = item.fhir.sequence ?? 1;
    const offsets = bySequence.get(sequence) ?? [];
    offsets.push(item.meta.canonical.clauses[0]?.schedule?.treatmentStartOffsetDays);
    bySequence.set(sequence, offsets);
  }
  const steps: NonNullable<EzCourseMetadata["step"]> = [];
  for (const [sequence, offsets] of bySequence) {
    const days = offsets[0];
    if (sequence < 2 || days === undefined || !Number.isFinite(days) ||
        days <= 0 || !offsets.every(offset => offset === days)) continue;
    steps.push({ sequence, start: relativeTime({ value: days, unit: "d" }) });
  }
  return steps.length ? steps : undefined;
}

/**
 * A parallel set of independently dosed administrations may share one
 * treatment-course end. Project an R6 step end only when every typed daughter
 * in the same initial step owns the exact same finite course duration.
 * Heterogeneous bounds remain local to their respective R5 components.
 */
function typedSharedCourseEndSteps(
  results: readonly ParseResult[]
): NonNullable<EzCourseMetadata["step"]> | undefined {
  if (results.length < 2) return undefined;
  const groups = new Map<number, ParseResult[]>();
  for (const item of results) {
    const sequence = item.fhir.sequence ?? 1;
    const members = groups.get(sequence) ?? [];
    members.push(item);
    groups.set(sequence, members);
  }
  const steps: NonNullable<EzCourseMetadata["step"]> = [];
  for (const [sequence, members] of groups) {
    // Later phases have independent relative starts; they are represented
    // by the existing typed parallel-regimen projection, not this simple end.
    if (sequence !== 1 || members.length < 2) continue;
    const schedule = members[0].meta.canonical.clauses[0]?.schedule;
    const duration = schedule?.duration;
    const unit = schedule?.durationUnit;
    if (duration === undefined || duration <= 0 || !Number.isFinite(duration) ||
        !unit || !members.every(member => {
          const own = member.meta.canonical.clauses[0]?.schedule;
          return own?.duration === duration && own.durationUnit === unit &&
            own.boundsStart === undefined && own.boundsEnd === undefined;
        })) continue;
    steps.push({ sequence, end: relativeTime({ value: duration, unit }) });
  }
  return steps.length ? steps : undefined;
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
function normalizeEmittedSemanticMarkers(rows: FhirDosage[]): FhirDosage[] {
  for (const row of rows) {
    if (row.modifierExtension?.some(extension => extension.url === DOSAGE_DETAILS_R5_URL)) {
      row.modifierExtension = row.modifierExtension.map(extension =>
        extension.url === DOSAGE_DETAILS_R5_URL
          ? cloneDefinedExtensionValue(extension) : extension
      );
    }
    const repeat = row.timing?.repeat;
    if (repeat?.extension?.some(extension => extension.url === TIMING_ACTIVITY_WINDOW_EXTENSION_URL)) {
      row.timing = { ...row.timing, repeat: {
        ...repeat,
        extension: repeat.extension.map(extension =>
          extension.url === TIMING_ACTIVITY_WINDOW_EXTENSION_URL
            ? cloneDefinedExtensionValue(extension) : extension)
      } };
    }
  }
  return rows;
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
  parallel?: { dosages: EzDosage[]; course: EzCourseMetadata; details: FhirR6DosageDetails }
): ParseBatchResult {
  const dosageItems = results.map(item => item.fhir);
  const typedRepeatCycle = regimenGraph.repeatCycle
    ? { ...regimenGraph.repeatCycle }
    : undefined;
  const delayedSteps = parallel ? undefined : typedAdministrationOffsetSteps(results);
  const relativeStarts = parallel ? undefined : typedRelativePhaseStartSteps(results);
  const sharedCourseEnds = parallel ? undefined : typedSharedCourseEndSteps(results);
  const typedSteps: NonNullable<EzCourseMetadata["step"]> = delayedSteps?.slice() ?? [];
  const loweredSequences = new Set((delayedSteps ?? []).map(step => step.sequence));
  for (const relative of relativeStarts ?? []) {
    const step = typedSteps.find(item => item.sequence === relative.sequence);
    if (step) {
      // Step start owns the course/phase onset. Preserve a distinct dose-local
      // delay on the component instead of overwriting its timing or applying it twice.
      step.start = relative.start;
      loweredSequences.delete(relative.sequence);
    } else typedSteps.push(relative);
  }
  for (const shared of sharedCourseEnds ?? []) {
    const step = typedSteps.find(item => item.sequence === shared.sequence);
    if (step) step.end = shared.end;
    else typedSteps.push(shared);
  }
  if (typedRepeatCycle && regimenGraph.repeatCount !== undefined) {
    const first = typedSteps.find(step => step.sequence === 1);
    if (first) first.count = regimenGraph.repeatCount;
    else typedSteps.push({ sequence: 1, count: regimenGraph.repeatCount });
  }
  const typedCourse: EzCourseMetadata | undefined =
    typedRepeatCycle || typedSteps.length
      ? {
        ...(typedRepeatCycle ? { repeatCycle: typedRepeatCycle } : {}),
        ...(typedSteps.length ? { step: typedSteps } : {})
      }
      : undefined;
  // R6 step.start now owns a shared typed delay. Keeping the same modifier
  // on its component would apply the delay again during relative scheduling.
  // Non-lowered, independently offset components preserve their modifier.
  const courseDosages = loweredSequences.size
    ? dosageItems.map(row => loweredSequences.has(row.sequence ?? 1) ? {
      ...row,
      modifierExtension: row.modifierExtension?.filter(extension =>
        extension.url !== ADMINISTRATION_OFFSET_EXTENSION_URL)
    } : row)
    : dosageItems;
  const fhirNext = parallel?.details
    ? {
      ...parallel.details,
      ...(typedRepeatCycle ? { repeatCycle: typedRepeatCycle } : {}),
      ...(regimenGraph.repeatCount !== undefined
        ? {
          step: parallel.details.step.map((step, index) =>
            index === 0 ? { ...step, count: regimenGraph.repeatCount } : step)
        }
        : {})
    }
    : toDosageDetails(
      courseDosages,
      input,
      typedCourse
    );
  // A recurring-cycle course is projected as one R6 object and flattened by
  // the established R6->R5 bridge. No source text is reparsed or injected.
  const projectedFhir = typedRepeatCycle || typedSteps.length
    ? fromDosageDetails(fhirNext).dosages
    : parallel?.dosages ?? toEzDosages(dosageItems);
  // The same JSON-compatible structural bridge serves both public routes:
  // parser FHIR rows and callers using strict toFhirR5Dosages directly.
  const fhir = withDosageEditProvenance(normalizeEmittedSemanticMarkers(projectedFhir), input);
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
  // Realize ordinary multi-clause courses afresh. Rich R6 courses prefer the
  // exact source wording when available, while their structured data remains primary.
  const displayCourse = results.length > 1 && !prefersR6CourseSourceForDisplay(fhirNext)
    ? { ...fhirNext, renderedInstruction: undefined }
    : fhirNext;
  return {
    input,
    count: results.length,
    items: results,
    fhir,
    fhirNext,
    ...(parallel ? {
      course: typedRepeatCycle
        ? {
          ...parallel.course,
          repeatCycle: typedRepeatCycle,
          ...(regimenGraph.repeatCount !== undefined
            ? {
              step: [
                ...(parallel.course.step ?? []).filter(step => step.sequence !== 1),
                {
                  ...(parallel.course.step?.find(step => step.sequence === 1) ?? { sequence: 1 }),
                  count: regimenGraph.repeatCount
                }
              ].sort((left, right) => left.sequence - right.sequence)
            }
            : {})
        }
        : parallel.course
    } : {}),
    shortText: results.length === 1 ? primary.shortText : formatSig(displayCourse, "short", options),
    longText: results.length === 1 ? primary.longText : formatSig(displayCourse, "long", options),
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
  segments: ReturnType<typeof parseSigSegments>, states: ParserState[]
) {
  scopeCoordinatedSegmentStates(states, boundaryPlan, segments, input);
  scopeTrailingSharedDuration(states, segments);
  scopeTrailingSharedNegativeInstructions(states, boundaryPlan, segments, input);
  scopeMedicationConditionTargets(states, boundaryPlan, segments);
  const regimenGraph = buildRegimenGraph(boundaryPlan, segments, states);
  scopeSequentialPhaseSemantics(states, segments, regimenGraph, input);
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
function applyRegimenAlternativeMembership(results: readonly ParseResult[], plan: BoundaryPlan): void {
  const edges = plan.relations.filter(edge => edge.kind === "alternative");
  if (!edges.length) return;
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
      for (const result of results) {
        const raw = result.meta.canonical.clauses[0]?.raw;
        if (!raw || raw.start < segment.start || raw.start >= segment.end) continue;
        setDosageAlternativeChoice(result.fhir, {
          groupId: `choice-${group + 1}`,
          branchId: `branch-${member + 1}`,
          selectionBehavior: "exactly-one"
        });
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
    composeParsedStates(input, boundaryPlan, segments, states);
  const canonicalParallel = prepareCanonicalParallel(outputStates, outputSegments, boundaryPlan, outputRegimenGraph);
  const rawResults: ParseResult[] = [];
  const projectedBatches: ParseResult[][] = [];

  for (let index = 0; index < outputSegments.length; index += 1) {
    const projected = buildParseResults(outputStates[index], options, phaseSequences[index]);
    projectedBatches.push(projected);
    rawResults.push(...projected);
  }

  // Canonical parallel components share their segment-local graph frames with
  // these projections. Serialize FHIR before rebasing in-memory source spans,
  // otherwise sourceText stays local while its embedded spans turn absolute.
  const parallel = canonicalParallel.kind === "resolved"
    ? projectParallelRegimen(
      canonicalParallel, rawResults.map(result => result.longText), input, {
        bodySitePostcoordination: options?.bodySitePostcoordination,
        includeTranslationExtensions: Boolean(options?.locale || options?.i18n)
      }
    )
    : canonicalParallel;
  for (let index = 0; index < projectedBatches.length; index += 1) {
    const shiftedSpans = new WeakSet<object>();
    for (const result of projectedBatches[index]) {
      rebaseParseResult(result, input, outputSegments[index].start, shiftedSpans);
    }
  }

  const results = rawResults;
  applyRegimenAlternativeMembership(results, boundaryPlan);
  const primary = resolvePrimaryParseResult(results, input, options);
  return buildWholeCourseResult(input, results, primary, segments, regimenGraph, options,
    parallel.kind === "resolved" ? parallel : undefined);
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
    composeParsedStates(input, boundaryPlan, segments, states);
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


function medicationConditionBody(
  condition: MedicationCondition,
  locale?: string
): string {
  const thai = (locale ?? "").toLowerCase().indexOf("th") === 0;
  switch (condition.kind) {
    case "measurement": {
      // Imported FHIR often supplies only the concept label as text. It is
      // not a realization of a comparator, value, or negated Boolean state.
      if (condition.text?.trim() && condition.text.trim() !== condition.name.trim()) {
        return condition.text.trim();
      }
      const operator = {
        gt: ">", ge: ">=", lt: "<", le: "<=", eq: "=", ne: "!="
      }[condition.operation];
      return condition.name + " " + operator + " " + condition.value +
        (condition.unit ? " " + condition.unit : "");
    }
    case "state":
      // Imported FHIR often supplies only the concept label as text. It is
      // not a realization of a comparator, value, or negated Boolean state.
      if (condition.text?.trim() && condition.text.trim() !== condition.name.trim()) {
        return condition.text.trim();
      }
      return condition.expected
        ? condition.name
        : (thai ? "ไม่ " : "not ") + condition.name;
    case "text":
      return condition.text;
    case "not":
      return (thai ? "ไม่ " : "not ") + "(" +
        medicationConditionBody(condition.condition, locale) + ")";
    case "all":
    case "any":
      return condition.conditions.map(value => {
        const body = medicationConditionBody(value, locale);
        // Mixed Boolean daughters retain the exact tree grouping. Only the
        // outer NOT uses "unless"; an inner NOT must remain explicit here.
        return (value.kind === "all" || value.kind === "any") && value.kind !== condition.kind
          ? "(" + body + ")" : body;
      }).join(condition.kind === "all" ? (thai ? " และ " : " and ") :
        (thai ? " หรือ " : " or "));
  }
}

function appendMedicationExcludedDatesText(
  text: string,
  dates: readonly string[],
  options?: FormatOptions
): string {
  if (!dates.length) return text;
  const thai = (options?.locale ?? "").toLowerCase().indexOf("th") === 0;
  const trimmed = text.trim().replace(/[.!?]+$/u, "");
  const lead = thai ? "ยกเว้นวันที่" : "except";
  const separator = thai ? " และ " : " and ";
  return (trimmed ? trimmed + " " : "") + lead + " " +
    dates.join(separator) + ".";
}

/** Realize a typed weekday exclusion when no source-written instruction exists.
 * Reuse the ordinary localizers rather than introducing a competing day lexicon.
 */
function appendMedicationExcludedWeekdaysText(
  text: string,
  days: readonly FhirDayOfWeek[],
  options?: FormatOptions
): string {
  if (!days.length) return text;
  const thai = (options?.locale ?? "").toLowerCase().startsWith("th");
  const labels = [...new Set(days)].map(day =>
    (thai ? DAY_NAMES_THAI[day] : DAY_NAMES[day]) ?? day
  );
  const readable = thai ? joinWithAndThai(labels) : joinWithAnd(labels);
  const trimmed = text.trim().replace(/[.!?]+$/u, "");
  return (trimmed ? trimmed + " " : "") +
    (thai ? "ยกเว้น" : "except ") + readable + ".";
}

function appendMedicationConditionText(
  text: string,
  condition: MedicationCondition,
  options?: FormatOptions
): string {
  const locale = options?.locale;
  const thai = (locale ?? "").toLowerCase().indexOf("th") === 0;
  const body = condition.kind === "not"
    ? medicationConditionBody(condition.condition, locale)
    : medicationConditionBody(condition, locale);
  const lead = condition.kind === "not"
    ? (thai ? "เว้นแต่" : "unless")
    : (thai ? "เฉพาะเมื่อ" : "only if");
  const trimmed = text.trim().replace(/[.!?]+$/u, "");
  return (trimmed ? trimmed + " " : "") + lead + " " + body + ".";
}

/** Render same-step concurrent members and typed alternative branches distinctly.
 * @param members Editable R5 or R6 components carrying native modifier extensions.
 * @param render A component realizer; never a semantic parser.
 * @param options Requested locale and conjunction punctuation.
 * @param separator Separator for independently concurrent members.
 */
function formatChoiceMembers<T extends Pick<FhirDosage, "modifierExtension">>(
  members: readonly T[], render: (member: T) => string,
  options?: FormatOptions, separator = "; "
): string {
  if (!members.some(member => getDosageAlternativeChoice(member))) {
    return joinGeneratedClauses(members.map(render).filter(text => text.trim()));
  }
  const thai = (options?.locale ?? "").toLowerCase().indexOf("th") === 0;
  const emitted = new Set<string>();
  const parts: string[] = [];
  for (const member of members) {
    const choice = getDosageAlternativeChoice(member);
    if (!choice) {
      const text = render(member).trim();
      if (text) parts.push(text);
      continue;
    }
    if (emitted.has(choice.groupId)) continue;
    emitted.add(choice.groupId);
    const branches = new Map<string, string[]>();
    for (const candidate of members) {
      const candidateChoice = getDosageAlternativeChoice(candidate);
      if (candidateChoice?.groupId !== choice.groupId) continue;
      const texts = branches.get(candidateChoice.branchId) ?? [];
      const text = render(candidate).trim().replace(/[.!?]+$/u, "");
      if (text) texts.push(text);
      branches.set(candidateChoice.branchId, texts);
    }
    const alternatives = [...branches.values()].map(texts => texts.join("; ")).filter(Boolean);
    if (alternatives.length) {
      parts.push((thai ? "เลือกอย่างใดอย่างหนึ่ง: " : "Choose one: ") +
        alternatives.join(thai ? " หรือ " : " or ") + ".");
    }
  }
  return parts.join(separator);
}

/** Resolve exact day/week quantities without converting clock-time units to calendar days.
 * @param quantity Typed FHIR duration, including its original unit and comparator.
 * @returns Whole nonnegative calendar days, or undefined when not exact.
 */
function exactCourseDays(quantity: FhirQuantity | undefined): number | undefined {
  if (!quantity || quantity.comparator || quantity.value === undefined ||
      !Number.isFinite(quantity.value) || quantity.value < 0) return undefined;
  const unit = quantity.code ?? quantity.unit;
  const days = unit === "d" ? quantity.value : unit === "wk" ? quantity.value * 7 : undefined;
  return days !== undefined && Number.isInteger(days) ? days : undefined;
}

/** Find gaps in the union of all typed course windows, not between adjacent rows.
 * An open-ended or unresolved parallel stage cannot license a global withholding instruction.
 * @param windows Resolved treatment-day windows for every nonempty step.
 * @param repeatCycle Original whole-course period, when the schedule repeats.
 * @returns Half-open calendar-day intervals where the entire course has no medication.
 */
function medicationFreeCourseWindows(
  windows: readonly { start: number | undefined; end: number | undefined }[],
  repeatCycle: FhirQuantity | undefined
): Array<{ start: number; end: number }> {
  const ordered: Array<{ start: number; end: number }> = [];
  for (const window of windows) {
    if (window.start === undefined ||
        (window.end !== undefined && window.end <= window.start)) return [];
    ordered.push({ start: window.start, end: window.end ?? Infinity });
  }
  if (!ordered.length) return [];
  const cycleDays = exactCourseDays(repeatCycle);
  // A stage extending into another cycle can cover its apparent gap. Show
  // the exact stage and repeat period, but never assert a global pause there.
  if (repeatCycle && (cycleDays === undefined || cycleDays <= 0 ||
      ordered.some(window => window.end > cycleDays))) return [];
  ordered.sort((left, right) => left.start - right.start);
  const gaps: Array<{ start: number; end: number }> = [];
  let coveredUntil = 0;
  for (const window of ordered) {
    if (window.start > coveredUntil) gaps.push({ start: coveredUntil, end: window.start });
    coveredUntil = Math.max(coveredUntil, window.end);
  }
  if (cycleDays !== undefined && cycleDays > coveredUntil) {
    gaps.push({ start: coveredUntil, end: cycleDays });
  }
  return gaps;
}

/** Realize a temporal quantity without approximating calendar months or years.
 * @param quantity Original typed temporal quantity.
 * @param thai Whether the requested realization is Thai.
 * @returns The original amount/comparator with a localized temporal unit.
 */
function formatCourseTimeQuantity(quantity: FhirQuantity, thai: boolean): string {
  const units: Record<string, readonly [string, string, string]> = {
    s: ["second", "seconds", "วินาที"], min: ["minute", "minutes", "นาที"],
    h: ["hour", "hours", "ชั่วโมง"], d: ["day", "days", "วัน"],
    wk: ["week", "weeks", "สัปดาห์"], mo: ["month", "months", "เดือน"],
    a: ["year", "years", "ปี"]
  };
  const unit = quantity.code ?? quantity.unit ?? "";
  const label = units[unit]?.[thai ? 2 : quantity.value === 1 ? 0 : 1] ?? quantity.unit ?? unit;
  return `${quantity.comparator ?? ""}${quantity.value ?? ""} ${label}`.trim();
}

/** Render the typed whole-course repetition interval independently of component cadence.
 * @param cycle Original R6 repeatCycle quantity; unknown units remain verbatim.
 * @param thai Whether the requested realization is Thai.
 * @param count Supplied common step repetition count, when explicitly finite.
 * @returns A visible cycle instruction preserving the supplied count without inventing an end date.
 */
function formatCourseRepeatCycle(cycle: FhirQuantity, thai: boolean, count?: number): string {
  const unit = cycle.code ?? cycle.unit ?? "";
  const interval = formatCourseTimeQuantity(cycle, thai);
  if (cycle.comparator || cycle.value === undefined || !Number.isFinite(cycle.value) ||
      cycle.value <= 0 || !unit) {
    return thai ? `ระยะรอบการใช้ยา: ${interval}.` : `Repeat-cycle interval: ${interval}.`;
  }
  const iterations = count === undefined ? "" : thai ? ` จำนวน ${count} รอบ` :
    ` for ${count} ${count === 1 ? "cycle" : "cycles"}`;
  return thai
    ? `ทำซ้ำแผนการใช้ยานี้ทุก ${interval}${iterations} (นับวันที่ใหม่ในแต่ละรอบ).`
    : `Repeat this schedule every ${interval}${iterations} (days are numbered within each cycle).`;
}

/** Read a typed treatment-start quantity without reinterpreting its calendar unit.
 * @param relative Source R6 boundary and event context.
 * @returns Its finite nonnegative offset, or undefined for another/uncertain event.
 */
function treatmentStepOffsetQuantity(
  relative: FhirR6DosageDetails["step"][number]["start"]
): FhirQuantity | undefined {
  if (!relative || relative.contextReference || relative.contextDefinition ||
      relative.contextPath || relative.offsetRange) return undefined;
  if (!relative.contextCode?.coding?.some(coding =>
    coding.system === "http://hl7.org/fhir/evidence-variable-event" &&
    coding.code === "treatment-start")) return undefined;
  const quantity = relative.offsetDuration;
  return quantity && quantity.value !== undefined && Number.isFinite(quantity.value) &&
    quantity.value >= 0 && !quantity.comparator ? quantity : undefined;
}

/** Convert an exact treatment-start boundary into a calendar-day ordinal.
 * @param relative Source R6 step boundary.
 * @returns Its day offset, leaving month/year boundaries unconverted.
 */
function treatmentStepOffsetDays(
  relative: FhirR6DosageDetails["step"][number]["start"]
): number | undefined {
  return exactCourseDays(treatmentStepOffsetQuantity(relative));
}

/** Format a calendar-valued step when day ordinals cannot faithfully represent it.
 * @param start Source-backed onset, including an inherited preceding end if known.
 * @param end Source-backed end of the phase.
 * @param thai Whether the requested realization is Thai.
 * @returns Exact relative calendar wording without a guessed treatment start date.
 */
function formatCalendarStepWindow(
  start: FhirQuantity | undefined, end: FhirQuantity | undefined, thai: boolean
): string {
  const point = (quantity: FhirQuantity) => quantity.value === 0
    ? (thai ? "เริ่มการรักษา" : "treatment start")
    : thai ? `${formatCourseTimeQuantity(quantity, true)}หลังเริ่มการรักษา`
      : `${formatCourseTimeQuantity(quantity, false)} after treatment start`;
  if (start && end) return thai ? `ตั้งแต่${point(start)}จนถึง${point(end)}` :
    `From ${point(start)} until ${point(end)}`;
  if (start) return thai ? `ตั้งแต่${point(start)}เป็นต้นไป` : `From ${point(start)} onward`;
  return end ? (thai ? `จนถึง${point(end)}` : `Until ${point(end)}`) : "";
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
    // boolean conditions in an English/Thai realization attempt. For an
    // ordinary R5-compatible course, explicit format options request a fresh
    // realization instead of the potentially stale saved display string.
    const prefersCourseSource = prefersR6CourseSourceForDisplay(oneOrCourse);
    if (oneOrCourse.renderedInstruction &&
        (options === undefined || options.realizationMode === "roundtrip" ||
         oneOrCourse.step.length === 0 || prefersCourseSource)) {
      // An explicitly requested round trip preserves the *original* source
      // surface, not a normalized paraphrase. Edited R5 inputs have their
      // stale source invalidated by the R5->R6 reconciliation first.
      return oneOrCourse.renderedInstruction;
    }
    if (oneOrCourse.step.length === 0) return "";
    // Rendering needs each component's projection, not a persisted copy of
    // the whole course plus edit markers on every component.
    const thai = (options?.locale ?? "").toLowerCase().startsWith("th");
    const stages: string[] = [];
    const firstRepeatCount = oneOrCourse.step[0]?.count;
    const courseRepeatCount = firstRepeatCount !== undefined &&
      oneOrCourse.step.every(step => step.count === firstRepeatCount) ? firstRepeatCount : undefined;
    let priorEndDays: number | undefined;
    const windows = oneOrCourse.step.map((step, index) => {
      const start = step.start ? treatmentStepOffsetDays(step.start) : index === 0 ? 0 : priorEndDays;
      const end = treatmentStepOffsetDays(step.end);
      priorEndDays = end;
      return { start, end };
    });
    for (const [index, step] of oneOrCourse.step.entries()) {
      const { start: startDays, end: endDays } = windows[index];
      const rendered = formatChoiceMembers(step.component, component => {
        const recognized = formatSig(fromR6Dosage(component, index + 1), style, options);
        const expressions: string[] = [];
        for (const amount of component.doseAndRate ?? []) {
          if (amount.doseExpression?.expression) {
            expressions.push(`unevaluated dose expression: ${amount.doseExpression.expression}`);
          }
          if (amount.rateExpression?.expression) {
            expressions.push(`unevaluated rate expression: ${amount.rateExpression.expression}`);
          }
        }
        return joinGeneratedClauses([recognized, ...expressions].filter(Boolean));
      }, options);
      if (!rendered.trim()) continue;
      let timing = "";
      if (step.start || step.end) {
        if ((step.start && startDays === undefined) ||
            (step.end && endDays === undefined) ||
            (startDays !== undefined && endDays !== undefined &&
              endDays <= startDays)) {
          // Unsupported event anchors must stay visible instead of becoming
          // an unconditional dose when the original source text is absent.
          const startQuantity = step.start ? treatmentStepOffsetQuantity(step.start) :
            index === 0 ? { value: 0, unit: "d" } :
              treatmentStepOffsetQuantity(oneOrCourse.step[index - 1].end);
          const endQuantity = treatmentStepOffsetQuantity(step.end);
          if ((!step.start || startQuantity) && (!step.end || endQuantity) &&
              !(startDays !== undefined && endDays !== undefined && endDays <= startDays)) {
            timing = formatCalendarStepWindow(startQuantity, endQuantity, thai);
          } else {
            const source = [step.start?.text, step.end?.text]
              .filter((value): value is string => Boolean(value?.trim())).join("; ");
            timing = source ? (thai ? `ต้องตรวจสอบช่วงเวลา: ${source}` : `Timing requires review: ${source}`) :
              (thai ? "ต้องตรวจสอบช่วงเวลาการใช้ยา" : "Stage timing requires review");
          }
        } else if (endDays !== undefined && startDays !== undefined) {
          timing = thai ? `วันที่ ${startDays + 1}–${endDays}` :
            `Days ${startDays + 1}–${endDays}`;
        } else if (startDays !== undefined) {
          timing = thai ? `ตั้งแต่วันที่ ${startDays + 1} เป็นต้นไป` :
            `From day ${startDays + 1} onward`;
        } else if (endDays !== undefined) {
          timing = thai ? `ถึงวันที่ ${endDays}` : `Through day ${endDays}`;
        }
      }
      const stageCount = oneOrCourse.repeatCycle && courseRepeatCount === undefined &&
        step.count !== undefined ? (thai ? `จำนวน ${step.count} รอบ` :
          `for ${step.count} ${step.count === 1 ? "cycle" : "cycles"}`) : "";
      const heading = [timing, stageCount].filter(Boolean).join("; ");
      stages.push(heading ? `${heading}: ${rendered}` : rendered);
    }
    const hasTimedStages = oneOrCourse.step.some(step => step.start || step.end);
    if (hasTimedStages) {
      const pauses = medicationFreeCourseWindows(
        windows.filter((_, index) => oneOrCourse.step[index].component.length > 0),
        oneOrCourse.repeatCycle
      );
      for (const pause of pauses) {
        stages.push(thai ? `งดยาในวันที่ ${pause.start + 1}–${pause.end}.` :
          `No doses on days ${pause.start + 1}–${pause.end}.`);
      }
    }
    if (oneOrCourse.repeatCycle) {
      stages.push(formatCourseRepeatCycle(oneOrCourse.repeatCycle, thai, courseRepeatCount));
    }
    return stages.join(hasTimedStages || oneOrCourse.repeatCycle ? " " : thai ? " จากนั้น " : " then ");
  }
  const dosage = oneOrCourse as EzDosage;
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
    const clause = canonicalFromFhir(dosage);
    const localization = resolveSigLocalization(options?.locale, options?.i18n);
    let displayed = provisionalFhirDisplay(dosage, clause, style, localization, options, false);
    if (displayCondition) {
      displayed = appendMedicationConditionText(displayed, displayCondition, options);
    }
    if (displayExcludedDates.length) {
      displayed = appendMedicationExcludedDatesText(displayed, displayExcludedDates, options);
    }
    if (displayExcludedWeekdays.length) {
      displayed = appendMedicationExcludedWeekdaysText(displayed, displayExcludedWeekdays, options);
    }
    return displayed;
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
  const clause = canonicalFromFhir(dosage);
  const localization = resolveSigLocalization(options?.locale, options?.i18n);
  const rendered = formatCanonicalClause(clause, style, localization, options);
  let displayed = displayCondition
    ? appendMedicationConditionText(rendered, displayCondition, options)
    : rendered;
  if (displayExcludedDates.length) {
    displayed = appendMedicationExcludedDatesText(displayed, displayExcludedDates, options);
  }
  if (displayExcludedWeekdays.length) {
    displayed = appendMedicationExcludedWeekdaysText(displayed, displayExcludedWeekdays, options);
  }
  return displayed;
}

export function formatSigBatch(
  dosages: FhirDosage[],
  style: "short" | "long" = "short",
  options?: FormatBatchOptions
): string {
  const separator = options?.separator ?? ", ";
  const firstSequence = dosages[0]?.sequence ?? 1;
  // Distinct ordinary R5 sequences also carry course-level ordering, even
  // without a retained R6 marker. Equal/absent sequences remain concurrent.
  if (dosages.some(dosage => (dosage.sequence ?? 1) !== firstSequence ||
    dosage.modifierExtension?.some(extension => extension.url === DOSAGE_DETAILS_R5_URL))) {
    // Batch formatting requests a realization; undefined native R6 options
    // instead request the original course source. Keep those APIs distinct.
    return formatSig(toDosageDetails(dosages), style, options ?? {});
  }
  if (dosages.some(dosage => getDosageAlternativeChoice(dosage))) {
    return formatChoiceMembers(dosages, dosage => formatSig(dosage, style, options), options, separator);
  }
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
  // Item displays cannot encode course-wide starts, pauses or repetition.
  // Keep the already realized whole-course text (and its locale) for those
  // semantics; the custom separator still applies to ordinary flat batches.
  if (batch.fhirNext.step.length > 1 || batch.fhirNext.repeatCycle ||
    batch.fhirNext.step.some(step => step.start || step.end || step.count !== undefined)) {
    return style === "short" ? batch.shortText : batch.longText;
  }
  const dosages = batch.items.map(item => item.fhir);
  if (dosages.some(dosage => getDosageAlternativeChoice(dosage))) {
    // The batch already owns a localized, mutually exclusive choice display.
    return style === "short" ? batch.shortText : batch.longText;
  }
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
    fromFhirDosageInternal(dosage, options)
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
  // Importing structured R6 data is best-effort and data-preserving.
  const shortText = formatSig(dosageDetails, "short", options);
  const longText = formatSig(dosageDetails, "long", options);
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
  const prefix = String(options?.locale ?? "").toLowerCase().startsWith("th")
    ? "ข้อมูลบางส่วนเท่านั้น — ต้องตรวจสอบข้อจำกัดการใช้ยา"
    : "INCOMPLETE medication interpretation — safety restrictions require review";
  const recognized = formatCanonicalClause(clause, style, localization, options).trim();
  const maximums: string[] = [];
  const readableQuantity = (quantity: FhirQuantity | undefined): string | undefined => {
    if (quantity?.value === undefined || !Number.isFinite(quantity.value)) return undefined;
    const unit = quantity.unit ?? quantity.code;
    return `${quantity.comparator ?? ""}${quantity.value}${unit ? " " + unit : ""}`;
  };
  const perAdministration = readableQuantity(dosage.maxDosePerAdministration);
  const lifetime = readableQuantity(dosage.maxDosePerLifetime);
  if (perAdministration) maximums.push(`max per administration: ${perAdministration}`);
  if (lifetime) maximums.push(`max lifetime: ${lifetime}`);
  for (const period of dosage.maxDosePerPeriod ?? []) {
    const numerator = readableQuantity(period.numerator);
    const denominator = readableQuantity(period.denominator);
    if (numerator && denominator) maximums.push(`max per period: ${numerator} / ${denominator}`);
  }
  for (const amount of (dosage as EzDosage).doseAndRate ?? []) {
    if (amount.doseExpression?.expression) {
      maximums.push(`unevaluated dose expression: ${amount.doseExpression.expression}`);
    }
    if (amount.rateExpression?.expression) {
      maximums.push(`unevaluated rate expression: ${amount.rateExpression.expression}`);
    }
  }
  const body = joinGeneratedClauses([recognized, ...maximums].filter(Boolean));
  if (!showIncompleteLabel) return body || "Structured FHIR data is retained";
  return body ? `${prefix}: ${body}` : `${prefix}. Structured FHIR data is retained.`;
}

function fromFhirDosageInternal(
  dosage: FhirDosage,
  options: FormatOptions | undefined
): ParseResult {
  const hasMaximumDose = hasMaximumDoseForDisplay(dosage);
  const maximumDoseSource = hasMaximumDose &&
      typeof dosage.text === "string" && dosage.text.trim().length > 0
    ? dosage.text
    : undefined;
  const suppressMaximumDisplay = hasMaximumDose && maximumDoseSource === undefined;
  const clause = canonicalFromFhir(dosage);
  const localization = resolveSigLocalization(options?.locale, options?.i18n);
  const guarded = getDosageCondition(dosage) !== undefined ||
    getDosageExcludedDates(dosage).length > 0 ||
    getDosageExcludedWeekdays(dosage).length > 0;
  const exactSource = maximumDoseSource ?? (guarded && dosage.text ? dosage.text : undefined);
  let shortText = suppressMaximumDisplay
    ? provisionalFhirDisplay(dosage, clause, "short", localization, options, false)
    : exactSource ?? formatCanonicalClause(clause, "short", localization, options);
  let computedLong = suppressMaximumDisplay
    ? provisionalFhirDisplay(dosage, clause, "long", localization, options, false)
    : exactSource ?? formatCanonicalClause(clause, "long", localization, options);
  if (!exactSource) {
    const condition = getDosageCondition(dosage);
    const exclusions = getDosageExcludedDates(dosage);
    const excludedWeekdays = getDosageExcludedWeekdays(dosage);
    if (condition) {
      shortText = appendMedicationConditionText(shortText, condition, options);
      computedLong = appendMedicationConditionText(computedLong, condition, options);
    }
    if (exclusions.length) {
      shortText = appendMedicationExcludedDatesText(shortText, exclusions, options);
      computedLong = appendMedicationExcludedDatesText(computedLong, exclusions, options);
    }
    if (excludedWeekdays.length) {
      shortText = appendMedicationExcludedWeekdaysText(shortText, excludedWeekdays, options);
      computedLong = appendMedicationExcludedWeekdaysText(computedLong, excludedWeekdays, options);
    }
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
        clauses: [clause]
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
            restrictions: clause.site.restrictions.map(restriction => ({
              ...restriction,
              range: restriction.range ? { ...restriction.range } : undefined,
              markerRange: restriction.markerRange ? { ...restriction.markerRange } : undefined,
              predicate: {
                ...restriction.predicate,
                range: restriction.predicate.range ? { ...restriction.predicate.range } : undefined
              }
            }))
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
  sequence?: number
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
  const fhir = canonicalToFhir(clause, longText, {
    sequence,
    bodySitePostcoordination: options?.bodySitePostcoordination,
    includeTranslationExtensions: Boolean(options?.locale || options?.i18n)
  });
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
        clauses: canonicalClauses
      },
      siteLookups,
      prnReasonLookups
    }
  };
}

function buildParseResults(
  state: ReturnType<typeof parseClauseState>,
  options?: ParseOptions,
  sequence?: number
): ParseResult[] {
  return administrationTargetProjections(state.clauses).map((target) =>
    buildParseResult(state, options, target, sequence)
  );
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
    carry.administrationTargetGroup = internal.administrationTargetGroup;
  }
  if (internal.dose !== undefined) {
    carry.dose = internal.dose;
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
