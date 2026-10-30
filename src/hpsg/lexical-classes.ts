import { LexKind, type LexToken } from "../lexer/token-types";
import { AdviceModality, AdvicePolarity, AdviceRelation, EventTiming, FhirPeriodUnit, RouteCode } from "../types";
import { baseLanguageTag } from "../localization";
import {
  ACTION_SEQUENCE_MARKERS,
  ACTION_SEQUENCE_RELATION_SURFACES,
  BODY_SITE_EXTERNAL_LOCATIVE_PREFIXES,
  BODY_SITE_LOCATIVE_LEAD_TOKENS,
  listBodySiteRelationDefinitions,
  getAdviceRelationCanonicalSetByGrammarFeature
} from "../relation-terminology";
export { ACTION_SEQUENCE_MARKERS } from "../relation-terminology";
import source from "./lexical-classes.json";

type MealRelation = "before" | "after" | "with";
type MealTimingByRelation = Map<MealRelation, Map<EventTiming, EventTiming>>;
type BodySiteFeatureKind = "nominal" | "partitive" | "locative";
type ContextualPrnReasonLead = {
  parts: string[];
  canonical: string;
  requiresKnownReason?: boolean;
};
export type SiteRelativeMarkerLexeme = {
  surface: string;
  relation: "where";
};
export type SiteRestrictionPredicateIntroducer = {
  parts: string[];
  form: "existential";
};
export type SiteRestrictionPredicateLexeme = {
  lemma: string;
  form: "state";
  i18n?: Record<string, string>;
};
type CompoundDoseUnit = {
  head: string;
  tails: string[];
  tailSequences?: string[][];
  requiresSiteContext?: boolean;
  requiresProductContext?: boolean;
  unit: string;
};

function setOf(values: readonly string[]): Set<string> {
  return new Set(values);
}

function routeCodeSet(labels: readonly string[]): Set<RouteCode> {
  return new Set(
    labels
      .map((label) => RouteCode[label as keyof typeof RouteCode])
      .filter((code): code is RouteCode => Boolean(code))
  );
}

function eventTimingMap(record: Record<string, string>): Map<string, EventTiming> {
  const map = new Map<string, EventTiming>();
  const nodeEnv = (globalThis as { process?: { env?: { NODE_ENV?: string } } })
    .process?.env?.NODE_ENV;
  const shouldWarn = nodeEnv !== "production";
  for (const key in record) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      const rawValue = record[key];
      const value = EventTiming[rawValue as keyof typeof EventTiming];
      if (value) {
        map.set(key, value);
      } else if (shouldWarn) {
        console.warn(
          `eventTimingMap skipped invalid EventTiming entry: key="${key}" value="${rawValue}"`
        );
      }
    }
  }
  return map;
}

function mealTimingByRelation(
  record: Record<string, Record<string, string>>
): MealTimingByRelation {
  const outer = new Map<MealRelation, Map<EventTiming, EventTiming>>();
  for (const relation in record) {
    if (!Object.prototype.hasOwnProperty.call(record, relation)) {
      continue;
    }
    const inner = new Map<EventTiming, EventTiming>();
    const relationEntries = record[relation];
    for (const sourceTiming in relationEntries) {
      if (!Object.prototype.hasOwnProperty.call(relationEntries, sourceTiming)) {
        continue;
      }
      const sourceValue = EventTiming[sourceTiming as keyof typeof EventTiming];
      const targetValue = EventTiming[relationEntries[sourceTiming] as keyof typeof EventTiming];
      if (sourceValue && targetValue) {
        inner.set(sourceValue, targetValue);
      }
    }
    outer.set(relation as MealRelation, inner);
  }
  return outer;
}

function stringEntries(record: Record<string, string>): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const key in record) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      entries.push([key, record[key]]);
    }
  }
  return entries;
}

function numberRecord(record: Record<string, number>): Record<string, number> {
  return { ...record };
}

export type InstructionQuantityUnitLabel = {
  locales: Record<string, { one: string; other: string }>;
};

function instructionQuantityUnitLabelMap(
  record: Record<string, InstructionQuantityUnitLabel>
): Map<string, InstructionQuantityUnitLabel> {
  const result = new Map<string, InstructionQuantityUnitLabel>();
  for (const key in record) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      const locales: Record<string, { one: string; other: string }> = {};
      for (const locale of Object.keys(record[key].locales ?? {})) {
        const value = record[key].locales[locale];
        if (value) locales[locale] = { ...value };
      }
      result.set(key, { locales });
    }
  }
  return result;
}

function stringSetMap(record: Record<string, string[]>): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const key in record) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      result.set(key, setOf(record[key]));
    }
  }
  return result;
}

function numberEntries(record: Record<string, number>): Array<[string, number]> {
  const entries: Array<[string, number]> = [];
  for (const key in record) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      entries.push([key, record[key]]);
    }
  }
  return entries;
}

function periodUnitRecord(record: Record<string, string>) {
  const result = new Map<string, string>();
  for (const [token, label] of stringEntries(record)) {
    result.set(token, label);
  }
  return result;
}

function bodySiteFeatureScoreBonus(
  record: Record<string, number>
): Map<BodySiteFeatureKind, number> {
  const map = new Map<BodySiteFeatureKind, number>();
  for (const key in record) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      map.set(key as BodySiteFeatureKind, record[key]);
    }
  }
  return map;
}

function siteRestrictionPredicateMap(
  record: Record<string, SiteRestrictionPredicateLexeme>
): Map<string, SiteRestrictionPredicateLexeme> {
  const result = new Map<string, SiteRestrictionPredicateLexeme>();
  for (const surface in record) {
    if (Object.prototype.hasOwnProperty.call(record, surface)) {
      result.set(surface, { ...record[surface] });
    }
  }
  return result;
}

export const SITE_ANCHORS = new Set([
  ...source.siteAnchors,
  ...BODY_SITE_LOCATIVE_LEAD_TOKENS,
  ...BODY_SITE_EXTERNAL_LOCATIVE_PREFIXES
]);
/** Clause markers and standalone qualifiers share the relation registry. */
export const SITE_RELATIVE_MARKERS = (() => {
  const markers = new Map<string, SiteRelativeMarkerLexeme>();
  for (const relation of listBodySiteRelationDefinitions()) {
    if (relation.grammar.qualifierTarget !== "symptom" || relation.canonical !== "where") continue;
    for (const surface of [
      relation.canonical,
      ...relation.aliases,
      relation.realization.en?.surface,
      relation.realization.th?.surface
    ]) {
      if (!surface) continue;
      markers.set(surface.toLowerCase(), { surface, relation: relation.canonical });
    }
  }
  return markers;
})();
export const SITE_RESTRICTION_PREDICATE_INTRODUCERS: SiteRestrictionPredicateIntroducer[] =
  (source.siteRestrictionPredicateIntroducers as SiteRestrictionPredicateIntroducer[])
    .map((entry) => ({ ...entry, parts: [...entry.parts] }))
    .sort((left, right) => right.parts.length - left.parts.length);
export const SITE_RESTRICTION_PREDICATES = siteRestrictionPredicateMap(
  source.siteRestrictionPredicates as Record<string, SiteRestrictionPredicateLexeme>
);
export const SITE_RESTRICTION_PREDICATES_BY_LEMMA = (() => {
  const result = new Map<string, SiteRestrictionPredicateLexeme>();
  SITE_RESTRICTION_PREDICATES.forEach((entry) => {
    result.set(entry.lemma, entry);
  });
  return result;
})();
export const SITE_SELF_DISPLAY_ANCHORS = new Set([
  ...BODY_SITE_LOCATIVE_LEAD_TOKENS,
  ...BODY_SITE_EXTERNAL_LOCATIVE_PREFIXES
]);
export const SITE_FILLERS = setOf(source.siteFillers);
export const BODY_SITE_PARTITIVE_HEADS = setOf(source.bodySitePartitiveHeads);
export const BODY_SITE_PARTITIVE_MODIFIERS = setOf(source.bodySitePartitiveModifiers);
export const BODY_SITE_PARTITIVE_CONNECTORS = setOf(source.bodySitePartitiveConnectors);
export const BODY_SITE_BARE_NOMINAL_PREFIXES = setOf(source.bodySiteBareNominalPrefixes);
export const BODY_SITE_BARE_NOMINAL_PREFIX_I18N = source.bodySiteBareNominalPrefixI18n as
  Record<string, Record<string, string>>;
export const BODY_SITE_ATTRIBUTIVE_MODIFIERS = setOf(source.bodySiteAttributiveModifiers);
export const BODY_SITE_ATTRIBUTIVE_MODIFIER_I18N = source.bodySiteAttributiveModifierI18n as
  Record<string, Record<string, string>>;
export const OTIC_SITE_WORDS = setOf(source.oticSiteWords);
export const OPHTHALMIC_SITE_WORDS = setOf(source.ophthalmicSiteWords);
export const NASAL_SITE_WORDS = setOf(source.nasalSiteWords);
export const BODY_SITE_ADJECTIVE_SUFFIXES = source.bodySiteAdjectiveSuffixes as readonly string[];
export const BODY_SITE_DISPLAY_PENALTY_WORDS = setOf(source.bodySiteDisplayPenaltyWords);
export const BODY_SITE_FEATURE_SCORE_BONUS = bodySiteFeatureScoreBonus(source.bodySiteFeatureScoreBonus);
export const CONNECTORS = setOf(source.connectors);
const METHOD_AUXILIARY_VERBS_SOURCE = source.methodAuxiliaryVerbsByLocale as Record<string, string[]>;
const METHOD_AUXILIARY_VERBS_BY_LOCALE = Object.keys(METHOD_AUXILIARY_VERBS_SOURCE ?? {})
  .reduce<Record<string, Set<string>>>((result, locale) => {
    result[locale] = setOf(METHOD_AUXILIARY_VERBS_SOURCE[locale] ?? []);
    return result;
  }, {});
export function methodAuxiliaryVerbsForLocale(locale: string): ReadonlySet<string> {
  return METHOD_AUXILIARY_VERBS_BY_LOCALE[baseLanguageTag(locale) ?? locale.toLowerCase()] ?? new Set<string>();
}
export const COORDINATED_NOUN_METHOD_VERBS = setOf(source.coordinatedNounMethodVerbs);
export const METHOD_NOUN_LEFT_CONTEXT = stringSetMap(source.methodNounLeftContext);
export const PRODUCT_EXTERNAL_MODIFIERS = setOf(source.productExternalModifiers);
export const ROUTE_SITE_PREPOSITIONS = setOf(source.routeSitePrepositions);
export const SITE_DISPLAY_FILLERS = SITE_FILLERS;
export const SITE_MULTIPLICITY_WORDS = setOf(["both", "each", "bilateral"]);
export const NON_SITE_ANCHORED_PHRASES = setOf(source.nonSiteAnchoredPhrases);
export const EXTERNAL_SITE_LOCATIVE_PREFIXES = BODY_SITE_EXTERNAL_LOCATIVE_PREFIXES;
export const ROUTE_BLOCKED_BY_FOLLOWING_PARTITIVE_HEADS = setOf(
  source.routeBlockedByFollowingPartitiveHeads
);

export const PRN_LEADS = setOf(source.prnLeads);
export const SYMPTOM_ONSET_PREFIX_PATTERNS = (source.symptomOnsetPrefixPatterns ?? [])
  .map((parts) => [...parts])
  .sort((left, right) => right.length - left.length);
export const SYMPTOM_ONSET_SUFFIX_PATTERNS = (source.symptomOnsetSuffixPatterns ?? [])
  .map((entry) => ({ lead: [...entry.lead], suffix: [...entry.suffix] }))
  .sort((left, right) => (right.lead.length + right.suffix.length) - (left.lead.length + left.suffix.length));
export const PRN_REASON_LEAD_INS = setOf(source.prnReasonLeadIns);
export const PRN_STANDALONE_REASON_LEADS = setOf(source.prnStandaloneReasonLeads);
export const PRN_CONTEXTUAL_REASON_LEADS: ContextualPrnReasonLead[] =
  (source.prnContextualReasonLeads ?? []).map((lead) => ({
    parts: [...lead.parts],
    canonical: lead.canonical,
    requiresKnownReason: lead.requiresKnownReason
  }));
export const PRN_REASON_MULTIWORD_LEAD_INS = setOf(source.prnReasonMultiwordLeadIns);
export const PRN_REASON_SITE_CONNECTORS = setOf(source.prnReasonSiteConnectors);
export const PRN_REASON_COORDINATORS = setOf(source.prnReasonCoordinators);
export const PRN_CONDITIONAL_SITE_BOUNDARY_ANCHORS = setOf(source.prnConditionalSiteBoundaryAnchors);
export const PRN_PREDICATE_REASON_NORMALIZATIONS = new Map<string, string>(
  stringEntries(source.prnPredicateReasonNormalizations)
);
export const PRN_GENERIC_LOCATED_HEADS = new Map<string, string>(
  stringEntries(source.prnGenericLocatedHeads)
);
export const PRN_DEFAULT_SITE_CONNECTOR = source.prnDefaultSiteConnector;
export const PRN_COMPACT_REASON_SEPARATORS = setOf(source.prnCompactReasonSeparators);

export const SITE_ROUTE_HINTS_ALLOWED_IN_GRAMMAR = routeCodeSet(source.siteRouteHintsAllowedInGrammar);
export const PRODUCT_METHOD_REALIZATIONS = source.productMethodRealizations as
  Record<string, Partial<Record<string, Record<string, string>>>>;
export function productMethodRealizations(verb: string, product: string): Record<string, string> | undefined {
  const values = PRODUCT_METHOD_REALIZATIONS[verb]?.[product];
  return values ? { ...values } : undefined;
}
export const PRODUCT_FORM_MODIFIERS = setOf(source.productFormModifiers);
export const PRODUCT_SOURCE_PREPOSITIONS = setOf(source.productSourcePrepositions);
export const COMPOUND_DOSE_UNITS = source.compoundDoseUnits as CompoundDoseUnit[];
export const QUALITATIVE_DOSE_MODIFIERS = setOf(source.qualitativeDoseModifiers);
export const QUALITATIVE_DOSE_UNITS = setOf(source.qualitativeDoseUnits);
export const IMPLICIT_SINGLE_DOSE_UNITS = setOf(source.implicitSingleDoseUnits);
export const PERCENT_BODY_AREA_UNITS = new Map<string, string>(
  stringEntries(source.percentBodyAreaUnits)
);
export const DOSE_FRACTION_WORDS = new Map<string, number>(
  numberEntries(source.doseFractionWords as Record<string, number>)
);
export const DOSE_FRACTION_DENOMINATOR_WORDS = new Map<string, number>(
  numberEntries(source.doseFractionDenominatorWords as Record<string, number>)
);
export const DOSE_ADDITIVE_QUANTITY_CONNECTORS = setOf(source.doseAdditiveQuantityConnectors);
export const DOSE_FRACTION_ARTICLES = setOf(source.doseFractionArticles);
export const DOSE_NUMBER_WORDS = new Map<string, number>(
  numberEntries(source.doseNumberWords as Record<string, number>)
);
export const DOSE_UNIT_CONNECTORS = setOf(source.doseUnitConnectors);
export const MILLION_DOSE_MULTIPLIER_TOKENS = setOf(source.millionDoseMultiplierTokens);
export const SCHEDULE_UNIT_SEPARATOR_TOKENS = setOf(source.scheduleUnitSeparatorTokens);
export const COMPACT_LIST_SEPARATORS = setOf(source.compactListSeparators);
export const EVERY_INTERVAL_TOKENS_DATA = setOf(source.everyIntervalTokens);
export const COUNT_MARKER_TOKENS_DATA = setOf(source.countMarkerTokens);
export const COUNT_CONNECTOR_WORDS_DATA = setOf(source.countConnectorWords);
/** Restrictive supplemental-quantity modifiers shared by dose and action NPs. */
export const SUPPLEMENTAL_DOSE_MODIFIERS = new Set(
  ["additional", "extra"].filter(word => COUNT_CONNECTOR_WORDS_DATA.has(word))
);
export const MAXIMUM_COUNT_LEAD_TOKENS = setOf(source.maximumCountLeadTokens ?? []);
export const MAXIMUM_COUNT_LEAD_SEQUENCES = (source.maximumCountLeadSequences ?? [])
  .map((parts) => [...parts])
  .sort((left, right) => right.length - left.length);
export const OCCURRENCE_COUNT_WORDS = setOf(source.occurrenceCountWords ?? []);
export const OCCURRENCE_COUNT_MODIFIERS = setOf(source.occurrenceCountModifiers);
export const MAXIMUM_PERIOD_PREPOSITIONS = setOf(source.maximumPeriodPrepositions);
export const MAXIMUM_PERIOD_MODIFIERS = setOf(source.maximumPeriodModifiers);
export const OCCURRENCE_CAP_PERIOD_PHRASES = (source.occurrenceCapPeriodPhrases ?? [])
  .map((entry) => ({ parts: [...entry.parts], period: entry.period, periodUnit: entry.periodUnit }))
  .sort((left, right) => right.parts.length - left.parts.length);
export const FREQUENCY_SIMPLE_WORDS_DATA = numberRecord(source.frequencySimpleWords);
export const FREQUENCY_NUMBER_WORDS_DATA = numberRecord(source.frequencyNumberWords);
/** Coded course-end events remain advisory until an actual bound is known. */
export const OPEN_ENDED_COURSE_END_CONDITIONS = source.openEndedCourseEndConditions;
/** Nominal quantifiers and event membership for typed medication-dose references. */
export const DOSE_TARGET_SLOT_HEADS = setOf(source.doseTargetSlotHeads);
export const DOSE_TARGET_QUANTIFIERS = new Map<string, "all" | "both">(
  Object.keys(source.doseTargetQuantifiers).map(key => [key,
    (source.doseTargetQuantifiers as Record<string, "all" | "both">)[key]])
);
/** Broad named dayparts can select a unique already stated clock, never invent one. */
export const DOSE_TARGET_DAYPART_CLOCK_RANGES = new Map<EventTiming, { startHour: number; endHour: number }>(
  Object.keys(source.doseTargetDaypartClockRanges).map(key => [key as EventTiming,
    (source.doseTargetDaypartClockRanges as Record<string, { startHour: number; endHour: number }>)[key]])
);
/** Meridiem nominals select existing clock slots without asserting a meal time. */
export const DOSE_TARGET_MERIDIEM_CLOCK_RANGES = new Map<string, { startHour: number; endHour: number }>(
  Object.keys(source.doseTargetMeridiemClockRanges).map(key => [key,
    (source.doseTargetMeridiemClockRanges as Record<string, { startHour: number; endHour: number }>)[key]])
);
export const DOSE_TARGET_EVENT_MEMBERS = new Map<EventTiming, readonly EventTiming[]>(
  Object.keys(source.doseTargetEventMembers).map(key => [key as EventTiming,
    (source.doseTargetEventMembers as Record<string, EventTiming[]>)[key]])
);
export const CALENDAR_UNIVERSAL_DAY_QUANTIFIERS = setOf(source.calendarUniversalDayQuantifiers);
export const CALENDAR_COMPLEMENT_DAY_MODIFIERS = setOf(source.calendarComplementDayModifiers);
export const CALENDAR_COMPLEMENT_DETERMINERS = setOf(source.calendarComplementDeterminers);
export const FREQUENCY_TIMES_WORDS_DATA = setOf(source.frequencyTimesWords);
export const FREQUENCY_CONNECTOR_WORDS_DATA = setOf(source.frequencyConnectorWords);
export const FREQUENCY_ALTERNATIVE_CONNECTORS = setOf(source.frequencyAlternativeConnectors ?? []);
export const SINGLE_OCCURRENCE_PHRASES = (source.singleOccurrencePhrases ?? [])
  .map((parts) => [...parts])
  .sort((left, right) => right.length - left.length);
export const FREQUENCY_ADVERB_UNITS_DATA = periodUnitRecord(source.frequencyAdverbUnits);
export const INTERVAL_UNIT_TOKENS_DATA = periodUnitRecord(source.intervalUnitTokens);

export const WORKFLOW_START_WORDS = new Set([
  ...source.workflowStartWords,
  ...getAdviceRelationCanonicalSetByGrammarFeature("workflowStart")
]);
export const WORKFLOW_NOUNS = setOf(source.workflowNouns);
/** Finite event-phase verbs that complete a workflow temporal noun phrase. */
export const WORKFLOW_EVENT_PHASE_VERBS = setOf(source.workflowEventPhaseVerbs);
export const ANTE_MERIDIEM_TOKENS = setOf(source.anteMeridiemTokens);
export const POST_MERIDIEM_TOKENS = setOf(source.postMeridiemTokens);
export const MERIDIEM_TOKENS = setOf(source.meridiemTokens);
export const LIST_SEPARATORS = setOf(source.listSeparators);

const THAI_DAYPART_LIST_SEPARATORS = setOf(source.thaiDaypartListSeparators);
/** Thai daypart daughters license their compact conjunction punctuation.
 * Numeric dose slots and non-Thai time ranges do not use this lexical sense.
 */
export function isThaiDaypartListSeparator(
  separator: LexToken | undefined, left: LexToken | undefined, right: LexToken | undefined
): boolean {
  return Boolean(separator && left && right &&
    THAI_DAYPART_LIST_SEPARATORS.has(separator.canonical ?? separator.lower) &&
    /[\u0E00-\u0E7F]/u.test(left.original) && /[\u0E00-\u0E7F]/u.test(right.original));
}
export const MEDICATION_OBJECT_FILLERS = setOf(source.medicationObjectFillers);
/** Typed resultative adjustment leads; the following cadence owns the new phase. */
export const PHASE_ADJUSTMENT_LEAD_SEQUENCES =
  source.phaseAdjustmentLeadSequences.map(parts => [...parts]);
export const PHASE_ADDITION_LEAD_SEQUENCES = source.phaseAdditionLeadSequences;

/** Lexically marked reference to clock/event anchors of a preceding phase. */
export const TIMING_ANAPHORA_PHRASES =
  source.timingAnaphoraPhrases.map(parts => [...parts])
    .sort((left, right) => right.length - left.length);

export const CLOCK_LEAD_TOKENS = setOf(source.clockLeadTokens);
export const EVENT_PREPOSITIONS = setOf(source.eventPrepositions);
export const EVENT_ARTICLE_TOKENS = setOf(source.eventArticleTokens);
export const FIXED_EVENT_PHRASES = eventTimingMap(source.fixedEventPhrases);
export const MEAL_RELATION_BY_TOKEN = new Map<string, MealRelation>(
  stringEntries(source.mealRelationTokens).map(([token, relation]) => [token, relation as MealRelation])
);
export const MEAL_TIMING_BY_RELATION = mealTimingByRelation(source.mealTimingByRelation);
export const SLEEP_EVENT_ALIASES = setOf(source.sleepEventAliases);
export const WAKE_EVENT_ALIASES = setOf(source.wakeEventAliases);
export const FOOD_EVENT_ALIASES = setOf(source.foodEventAliases);
export const DAY_RANGE_CONNECTORS = setOf(source.dayRangeConnectors);
/** Typed calendar-month day nouns; prefix + numeric range + monthly daughter. */
export const CALENDAR_MONTH_DAY_FRAMES = source.calendarMonthDayFrames;

export const RANGE_CONNECTORS = setOf(source.rangeConnectors);
export const DURATION_LEAD_TOKENS = getAdviceRelationCanonicalSetByGrammarFeature("durationLead");

/** Shared source-lexical reading of an unspaced headed duration NP.
 * HPSG schedule and procedural action grammar consume the same daughter.
 * No semantic meaning is assigned until each consumer licenses the unit. */
export function compactDurationParts(surface: string): {
  value: number;
  unitSurface: string;
} | undefined {
  const match = surface.toLowerCase().match(/^([a-z]+)([0-9]+(?:\.[0-9]+)?)([a-z]+)$/u);
  if (!match || !DURATION_LEAD_TOKENS.has(match[1])) return undefined;
  const value = Number(match[2]);
  return Number.isFinite(value) && value > 0
    ? { value, unitSurface: match[3] }
    : undefined;
}
export const EVENT_OFFSET_MINIMUM_LEAD_SEQUENCES =
  (source.eventOffsetMinimumLeadSequences ?? []).map((parts) => [...parts]);
export const EVENT_OFFSET_MAXIMUM_LEAD_SEQUENCES =
  (source.eventOffsetMaximumLeadSequences ?? []).map((parts) => [...parts]);
export const EVENT_OFFSET_FRACTIONS = new Map<string, number>(
  numberEntries(source.eventOffsetFractions ?? {})
);
export const RELATIVE_INTERVAL_TRAILING_RELATIONS = new Map<string, AdviceRelation>(
  stringEntries(source.relativeIntervalTrailingRelations as Record<string, string>)
    .map(([surface, relation]) => [surface, relation as AdviceRelation])
);
export const EVENT_OFFSET_ARTICLES = setOf(source.eventOffsetArticles ?? []);

export const INSTRUCTION_LEADING_SEPARATORS = setOf(source.instructionLeadingSeparators);
export const INSTRUCTION_START_WORDS = new Set([
  ...source.instructionStartWords,
  ...getAdviceRelationCanonicalSetByGrammarFeature("instructionStart")
]);
export const POSITIVE_DIRECTIVE_MARKERS = setOf(source.positiveDirectiveMarkers);
export const ACTION_DIRECTIVE_PREFIXES = source.actionDirectivePrefixes.map((prefix) => ({
  parts: prefix.parts as readonly string[],
  polarity: prefix.polarity as AdvicePolarity | undefined,
  modality: prefix.modality as AdviceModality | undefined,
  complement: prefix.complement as "contact-clause" | undefined
}));
export const ACTION_COORDINATION_CONNECTORS = setOf(source.actionCoordinationConnectors);
/** Closed-class contrast that connects two instructions, not a new action. */
export const ACTION_DISCOURSE_CONNECTORS = setOf(source.actionDiscourseConnectors);
/** Compositional phrasal sequencers; single-token THEN remains the relation lexicon's authority. */
export const REGIMEN_SEQUENCE_CONNECTOR_PHRASES: readonly (readonly string[])[] =
  source.regimenSequenceConnectorPhrases
    .map(parts => [...parts])
    .sort((left, right) => right.length - left.length);
const PHRASE_SEQUENCERS_BY_FIRST = new Map<string, Array<readonly string[]>>();
for (const parts of REGIMEN_SEQUENCE_CONNECTOR_PHRASES) {
  const bucket = PHRASE_SEQUENCERS_BY_FIRST.get(parts[0]) ?? [];
  bucket.push(parts);
  PHRASE_SEQUENCERS_BY_FIRST.set(parts[0], bucket);
}

/** Source-backed sequence marker shared by clause and course constructions.
 * @param tokens Existing normalized lexical stream.
 * @param start Candidate marker head; no search beyond its licensed phrase.
 */
function sequenceLexeme(token: LexToken | undefined): string {
  return token ? (token.canonical ?? token.lower).replace(/^[.,;:]+|[.,;:]+$/g, "") : "";
}

export function sequenceConnectorEnd(tokens: readonly LexToken[], start: number): number | undefined {
  const initial = sequenceLexeme(tokens[start]);
  // "for [the] next week" is a bounded course, not a new regimen phase.
  // Keep bare "next week" as an explicit subsequent-phase connector.
  if (initial === "next" && sequenceLexeme(tokens[start + 1]) === "week") {
    const before = sequenceLexeme(tokens[start - 1]);
    const durationLead = before === "the" ? start - 2 : start - 1;
    if (DURATION_LEAD_TOKENS.has(sequenceLexeme(tokens[durationLead]))) return undefined;
  }
  if (ACTION_SEQUENCE_MARKERS.has(initial)) return start + 1;
  const canonicalCandidates = PHRASE_SEQUENCERS_BY_FIRST.get(initial);
  const surface = tokens[start]?.lower;
  const surfaceCandidates = surface && surface !== initial
    ? PHRASE_SEQUENCERS_BY_FIRST.get(surface) : undefined;
  if (!canonicalCandidates && !surfaceCandidates) return undefined;
  const matched = (parts: readonly string[]) => parts.every((part, offset) => {
    const token = tokens[start + offset];
    return token && (part === sequenceLexeme(token) || part === token.lower);
  });
  for (const parts of canonicalCandidates ?? []) if (matched(parts)) return start + parts.length;
  for (const parts of surfaceCandidates ?? []) if (matched(parts)) return start + parts.length;
  return undefined;
}

/** Count nouns select whole treatment cycles rather than doses or days. */
export const CYCLE_COUNT_HEADS = setOf(source.cycleCountHeads);

/** Cheap source-lexical gate for typed treatment-relative phase onsets. */
export const TREATMENT_PERIOD_START_LEADS = setOf(source.treatmentPeriodStartLeads);
export const ACTION_COORDINATION_CONNECTOR_I18N = source.actionCoordinationConnectorI18n as
  Record<string, Record<string, string>>;
/** Disjunction is alternative administration, never conjunctive dose sharing.
 * The lexicon owns the connective meaning; regimen constructions consume the
 * resulting typed distinction without rematching arbitrary instruction text.
 */
function coordinationSurfaceSet(canonical: string, defaults: readonly string[]): Set<string> {
  const result = new Set(defaults);
  const localized = ACTION_COORDINATION_CONNECTOR_I18N[canonical];
  if (localized) {
    for (const locale in localized) {
      if (Object.prototype.hasOwnProperty.call(localized, locale))
        result.add(localized[locale]);
    }
  }
  return result;
}
const CONJUNCTIVE_COORDINATION_SURFACES = coordinationSurfaceSet("and", ["and"]);
const DISJUNCTIVE_COORDINATION_SURFACES = coordinationSurfaceSet("or", ["or", "and/or"]);
export function coordinationConnectorKind(surface: string):
  "conjunction" | "disjunction" | "unknown" {
  const normalized = surface.trim().replace(/^[,;]+|[,;]+$/gu, "").trim().toLowerCase();
  if (DISJUNCTIVE_COORDINATION_SURFACES.has(normalized)) return "disjunction";
  if (CONJUNCTIVE_COORDINATION_SURFACES.has(normalized)) return "conjunction";
  return "unknown";
}
export const ACTION_SEQUENCE_RELATION_TOKENS = ACTION_SEQUENCE_RELATION_SURFACES;
export const COURSE_DURATION_UNITS = setOf(source.courseDurationUnits);
export const INSTRUCTION_DURATION_UNITS = new Map<string, string>(
  stringEntries(source.instructionDurationUnits)
);
export const INSTRUCTION_DURATION_APPROXIMATION_LEADS = setOf(
  source.instructionDurationApproximationLeads
);
export const INSTRUCTION_QUANTITY_UNIT_LABELS = instructionQuantityUnitLabelMap(
  source.instructionQuantityUnitLabels as Record<string, InstructionQuantityUnitLabel>
);
export const FREE_TEXT_DIRECTIVE_STARTS = new Set([
  ...source.freeTextDirectiveStarts,
  ...getAdviceRelationCanonicalSetByGrammarFeature("freeTextDirectiveStart")
]);
export const CONDITIONAL_INSTRUCTION_EXCLUSIVE_LEADS =
  getAdviceRelationCanonicalSetByGrammarFeature("conditionalInstructionExclusive");
export const ALTERNATE_EVENT_CADENCES = (source.alternateEventCadences ?? [])
  .map((entry) => ({
    parts: [...entry.parts],
    when: EventTiming[entry.when as keyof typeof EventTiming],
    period: entry.period,
    periodUnit: entry.periodUnit
  }))
  .filter((entry): entry is { parts: string[]; when: EventTiming; period: number; periodUnit: string } =>
    Boolean(entry.when && entry.parts.length && entry.period > 0)
  )
  .sort((left, right) => right.parts.length - left.parts.length);

/** Day-membership adjuncts around registered activity nouns; never calendar inference. */
export const ACTIVITY_DAY_ADJUNCTS = source.activityDayAdjuncts;

export const ADMINISTRATION_WINDOW_INSTRUCTIONS = (source.administrationWindowInstructions ?? [])
  .map((entry) => ({
    parts: [...entry.parts],
    text: entry.text,
    offsetOnly: (entry as { offsetOnly?: boolean }).offsetOnly === true,
    i18n: entry.i18n ? { ...entry.i18n } : undefined,
    relation: entry.relation as "before" | "after" | undefined,
    activity: entry.activity as string | undefined,
    eventWindow: (
      (entry as { when?: keyof typeof EventTiming }).when &&
      (entry as { windowEnd?: keyof typeof EventTiming }).windowEnd
    ) ? {
      start: EventTiming[(entry as { when: keyof typeof EventTiming }).when],
      end: EventTiming[(entry as { windowEnd: keyof typeof EventTiming }).windowEnd]
    } : undefined
  }))
  .sort((left, right) => right.parts.length - left.parts.length);
export const SITE_TRAILING_INSTRUCTION_WORDS = setOf(source.siteTrailingInstructionWords);
export const WORKFLOW_CONTINUATION_LICENSES = setOf(source.workflowContinuationLicenses);
export const WORKFLOW_ACTION_RELATION_LEADS =
  getAdviceRelationCanonicalSetByGrammarFeature("workflowActionLead");
export const AS_NEEDED_LEAD_PHRASES = setOf(source.asNeededLeadPhrases);
export const PRN_BREAKING_COORDINATORS = setOf(source.prnBreakingCoordinators);
export const SYMPTOM_ADJUSTMENT_LEADS = setOf(source.symptomAdjustmentLeads);
export const SYMPTOM_ADJUSTMENT_CONNECTORS = setOf(source.symptomAdjustmentConnectors);
export const SYMPTOM_ADJUSTMENT_PATIENT_INSTRUCTION_LEADS = setOf(
  source.symptomAdjustmentPatientInstructionLeads
);

export const EYE_SITE_ABBREVIATIONS = setOf(source.eyeSiteAbbreviations);
export const NON_OCULAR_DOSE_UNITS = setOf(source.nonOcularDoseUnits);
export const OCULAR_ROUTE_CODES = routeCodeSet(source.ocularRouteCodes);
export const HARD_SEGMENT_BOUNDARY_TOKENS = setOf(source.hardSegmentBoundaryTokens);
export const CLAUSE_LEAD_WORDS = setOf(source.clauseLeadWords);
export const LATERAL_MODIFIER_WORDS = setOf(source.lateralModifierWords);

/** Explicit temporal construction vocabulary; no medication or specialty-specific dispatch. */
export const CYCLE_WORDS = {
  name: String.raw`(?:menstrual\s+)?cycle\b`,
  dayLead: String.raw`(?:\bon\s+days?\s+|\bdays?\s+|\bD(?=\d)|วันที่ของรอบ\s*)`,
  dayPart: String.raw`\d{1,3}(?:\s*[-–]\s*\d{1,3})?`,
  listSeparator: String.raw`\s*(?:,\s*(?:and\s+|และ\s*)?|and\s+|และ\s*)`,
  periodLead: String.raw`(?:each\s+|every\s+|q\s*|ทุก\s*)`,
  periodUnit: String.raw`(?:days?\b|d\b|วัน)`,
  startLead: String.raw`(?:starting(?:\s+on)?|from|เริ่ม(?:วันที่)?|ตั้งแต่วันที่)`,
  repeatCount: String.raw`(?:for\s+|x\s*|จำนวน\s*)(\d{1,3})\s*(?:cycles?\b|รอบ)`
};

/** Declarative surface vocabulary for calendar-date relations for typed calendar constituents. */
export const TEMPORAL_DATE_RELATION_SOURCES = {
  startInclusive: String.raw`(?:\bfrom\b\s+|\bsince\b\s+|\bas\s+(?:of|from)\b\s+|\beffective(?:\s+(?:from|as\s+of))?\b\s+|\b(?:starting|beginning|commencing|commence)(?:\s+(?:on|from))?\b\s+|(?:มี\s*ผล\s*ตั้งแต่|ตั้งแต่|นับ\s*(?:ตั้งแต่|จาก|แต่)|เริ่ม(?:\s*(?:ตั้งแต่|ใช้))?)(?:\s*วัน(?:ที่)?)?\s*)`,
  startExclusive: String.raw`(?:\bafter\b\s+|หลัง(?:\s*จาก)?(?:\s*วัน(?:ที่)?)?\s*)`,
  endInclusive: String.raw`(?:\b(?:until|through|till)\b\s+|(?:จน\s*)?ถึง(?:\s*วัน(?:ที่)?)?\s*)`,
  endExclusive: String.raw`(?:\bbefore\b\s+|\bprior(?:\s+to)?\b\s+|ก่อน(?:\s*ถึง)?(?:\s*วัน(?:ที่)?)?\s*)`
} as const;

export const TEMPORAL_RELATION_LEAD_WORDS = new Set([
  'from','since','as','effective','starting','beginning','commencing','commence','after','before','prior','until','through','till',
  'ตั้งแต่','นับ','นับตั้งแต่','นับจาก','เริ่ม','มี','หลัง','ก่อน','ถึง','จน','จนถึง'
]);

export const OPEN_ENDED_WORDS = new Set(['onward','onwards','forward','forwards','ต่อไป']);

const COURSE_CONTINUATION_DURATION_HEADS = setOf(source.courseContinuationDurationHeads);

/** Resolve the duration-complement sense of a polysemous continuation head.
 * A physical attachment still requires its object and is not licensed by this
 * time-quantity valence. One source constituent is shared by action sense
 * selection and the HPSG schedule lexicon, avoiding competing ownership.
 * @param tokens Source-preserving normalized lexical tokens.
 * @param start Candidate head; never searches later unrelated text.
 * @param limit Exclusive constituent boundary.
 * @returns Complete duration daughter, or undefined for an object/negated sense.
 */
export function courseContinuationDurationAt(
  tokens: readonly Pick<LexToken, "lower" | "canonical" | "kind" | "value">[],
  start: number,
  limit = tokens.length
): { end: number; value: number; unit: FhirPeriodUnit } | undefined {
  const head = tokens[start];
  if (!head || start >= limit || !COURSE_CONTINUATION_DURATION_HEADS.has(head.lower)) return undefined;
  const normalized = (index: number) => tokens[index]?.canonical ?? tokens[index]?.lower ?? "";
  if (ACTION_DIRECTIVE_PREFIXES.some(prefix => prefix.polarity === AdvicePolarity.Negate &&
      start >= prefix.parts.length && prefix.parts.every((part, index) =>
        normalized(start - prefix.parts.length + index) === part))) return undefined;
  let cursor = start + 1;
  if (cursor < limit && OCCURRENCE_COUNT_MODIFIERS.has(normalized(cursor))) cursor++;
  if (cursor + 1 >= limit) return undefined;
  const cardinal = tokens[cursor];
  const value = cardinal?.kind === LexKind.Number ? cardinal.value :
    FREQUENCY_NUMBER_WORDS_DATA[normalized(cursor)];
  const label = INTERVAL_UNIT_TOKENS_DATA.get(normalized(cursor + 1));
  const unit = label ? FhirPeriodUnit[label as keyof typeof FhirPeriodUnit] : undefined;
  return value !== undefined && Number.isFinite(value) && value > 0 && unit
    ? { end: cursor + 2, value, unit } : undefined;
}
