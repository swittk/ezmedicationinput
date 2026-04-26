import { EventTiming, FhirCoding, RouteCode } from "../types";
import source from "./lexical-classes.json";

type MealRelation = "before" | "after" | "with";
type MealTimingByRelation = Map<MealRelation, Map<EventTiming, EventTiming>>;
type BodySiteFeatureKind = "nominal" | "partitive" | "locative";
type CompoundDoseUnit = {
  head: string;
  tails: string[];
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

function codingRecord(record: Record<string, FhirCoding>): Map<string, FhirCoding> {
  const map = new Map<string, FhirCoding>();
  for (const key in record) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      map.set(key, { ...record[key] });
    }
  }
  return map;
}

export const SITE_ANCHORS = setOf(source.siteAnchors);
export const SITE_SELF_DISPLAY_ANCHORS = setOf(source.siteSelfDisplayAnchors);
export const SITE_FILLERS = setOf(source.siteFillers);
export const BODY_SITE_LOCATIVE_RELATIONS = setOf(source.bodySiteLocativeRelations);
export const BODY_SITE_LOCATIVE_RENDER_PREPOSITIONS = new Map<string, string>(
  stringEntries(source.bodySiteLocativeRenderPrepositions)
);
export const BODY_SITE_SPATIAL_RELATION_CODINGS = codingRecord(
  source.bodySiteSpatialRelationCodings
);
export const BODY_SITE_PARTITIVE_HEADS = setOf(source.bodySitePartitiveHeads);
export const BODY_SITE_PARTITIVE_MODIFIERS = setOf(source.bodySitePartitiveModifiers);
export const BODY_SITE_PARTITIVE_CONNECTORS = setOf(source.bodySitePartitiveConnectors);
export const BODY_SITE_BARE_NOMINAL_PREFIXES = setOf(source.bodySiteBareNominalPrefixes);
export const OTIC_SITE_WORDS = setOf(source.oticSiteWords);
export const OPHTHALMIC_SITE_WORDS = setOf(source.ophthalmicSiteWords);
export const NASAL_SITE_WORDS = setOf(source.nasalSiteWords);
export const BODY_SITE_ADJECTIVE_SUFFIXES = source.bodySiteAdjectiveSuffixes as readonly string[];
export const BODY_SITE_DISPLAY_PENALTY_WORDS = setOf(source.bodySiteDisplayPenaltyWords);
export const BODY_SITE_FEATURE_SCORE_BONUS = bodySiteFeatureScoreBonus(source.bodySiteFeatureScoreBonus);
export const CONNECTORS = setOf(source.connectors);
export const ROUTE_SITE_PREPOSITIONS = setOf(source.routeSitePrepositions);
export const SITE_DISPLAY_FILLERS = SITE_FILLERS;
export const NON_SITE_ANCHORED_PHRASES = setOf(source.nonSiteAnchoredPhrases);
export const EXTERNAL_SITE_LOCATIVE_PREFIXES = setOf(source.externalSiteLocativePrefixes);
export const ROUTE_BLOCKED_BY_FOLLOWING_PARTITIVE_HEADS = setOf(
  source.routeBlockedByFollowingPartitiveHeads
);

export const PRN_LEADS = setOf(source.prnLeads);
export const PRN_REASON_LEAD_INS = setOf(source.prnReasonLeadIns);
export const PRN_STANDALONE_REASON_LEADS = setOf(source.prnStandaloneReasonLeads);
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
export const PRODUCT_METHOD_TEXT = source.productMethodText as Record<string, Partial<Record<string, string>>>;
export const PRODUCT_METHOD_THAI = source.productMethodThai as Record<string, string>;
export const COMPOUND_DOSE_UNITS = source.compoundDoseUnits as CompoundDoseUnit[];
export const MILLION_DOSE_MULTIPLIER_TOKENS = setOf(source.millionDoseMultiplierTokens);
export const SCHEDULE_UNIT_SEPARATOR_TOKENS = setOf(source.scheduleUnitSeparatorTokens);
export const COMPACT_LIST_SEPARATORS = setOf(source.compactListSeparators);
export const EVERY_INTERVAL_TOKENS_DATA = setOf(source.everyIntervalTokens);
export const COUNT_MARKER_TOKENS_DATA = setOf(source.countMarkerTokens);
export const COUNT_CONNECTOR_WORDS_DATA = setOf(source.countConnectorWords);
export const FREQUENCY_SIMPLE_WORDS_DATA = numberRecord(source.frequencySimpleWords);
export const FREQUENCY_NUMBER_WORDS_DATA = numberRecord(source.frequencyNumberWords);
export const FREQUENCY_TIMES_WORDS_DATA = setOf(source.frequencyTimesWords);
export const FREQUENCY_CONNECTOR_WORDS_DATA = setOf(source.frequencyConnectorWords);
export const FREQUENCY_ADVERB_UNITS_DATA = periodUnitRecord(source.frequencyAdverbUnits);
export const INTERVAL_UNIT_TOKENS_DATA = periodUnitRecord(source.intervalUnitTokens);

export const WORKFLOW_START_WORDS = setOf(source.workflowStartWords);
export const WORKFLOW_NOUNS = setOf(source.workflowNouns);
export const ANTE_MERIDIEM_TOKENS = setOf(source.anteMeridiemTokens);
export const POST_MERIDIEM_TOKENS = setOf(source.postMeridiemTokens);
export const MERIDIEM_TOKENS = setOf(source.meridiemTokens);
export const LIST_SEPARATORS = setOf(source.listSeparators);
export const MEDICATION_OBJECT_FILLERS = setOf(source.medicationObjectFillers);
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
export const RANGE_CONNECTORS = setOf(source.rangeConnectors);
export const DURATION_LEAD_TOKENS = setOf(source.durationLeadTokens);

export const INSTRUCTION_LEADING_SEPARATORS = setOf(source.instructionLeadingSeparators);
export const INSTRUCTION_START_WORDS = setOf(source.instructionStartWords);
export const WORKFLOW_CONTINUATION_LICENSES = setOf(source.workflowContinuationLicenses);
export const AS_NEEDED_LEAD_PHRASES = setOf(source.asNeededLeadPhrases);
export const PRN_BREAKING_COORDINATORS = setOf(source.prnBreakingCoordinators);

export const EYE_SITE_ABBREVIATIONS = setOf(source.eyeSiteAbbreviations);
export const NON_OCULAR_DOSE_UNITS = setOf(source.nonOcularDoseUnits);
export const OCULAR_ROUTE_CODES = routeCodeSet(source.ocularRouteCodes);
export const HARD_SEGMENT_BOUNDARY_TOKENS = setOf(source.hardSegmentBoundaryTokens);
export const CLAUSE_LEAD_WORDS = setOf(source.clauseLeadWords);
export const LATERAL_MODIFIER_WORDS = setOf(source.lateralModifierWords);
