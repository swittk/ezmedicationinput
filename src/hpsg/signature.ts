import type { HpsgSigSegment } from "./segmenter";
import type { CanonicalSigClause, ParseOptions } from "../types";
import type { MedicationDateListMatch } from "../date-interpretation";
import {
  AdviceFrame,
  AdviceRelation,
  CanonicalDoseRange,
  CanonicalClinicalAdjuncts,
  CanonicalAdditionalInstructionExpr,
  CanonicalActivityTimingExpr,
  CanonicalCalendarEventExpr,
  CanonicalCycleDayConstraint,
  CanonicalDosePeriodMaximumExpr,
  CanonicalOccurrenceCapExpr,
  AdministrationTargetCoordinationKind,
  CanonicalScheduleSemanticField,
  CanonicalLexicalCategory,
  BodySiteRestriction,
  BodySiteRestrictionPredicate,
  BodySiteSpatialRelation,
  EventTiming,
  FhirCoding,
  FhirDayOfWeek,
  FhirPeriodUnit,
  FhirPrimitiveElement,
  FhirQuantity,
  MedicationCondition,
  RouteCode,
  PrnReasonLookupRequest,
  SiteCodeLookupRequest,
  TextRange
} from "../types";
import { Token } from "../parser-state";
import { signFeatureStructure } from "./feature-structure";
import type { HpsgFeatureNode } from "./type-system";

export type HpsgType =
  | "sign"
  | "word-sign"
  | "phrase-sign"
  | "headed-phrase"
  | "head-complement-phrase"
  | "head-adjunct-phrase"
  | "head-marker-phrase"
  | "procedure-sequence-phrase"
  | "conditional-instruction-phrase"
  | "coordination-phrase"
  | "site-coordination-phrase"
  | "clause-sign"
  | "administration-clause"
  | "method-sign"
  | "route-sign"
  | "site-sign"
  | "site-relative-marker-sign"
  | "site-predicate-sign"
  | "site-relative-clause"
  | "restricted-site-phrase"
  | "recurring-course-phrase"
  | "dose-sign"
  | "schedule-sign"
  | "prn-sign"
  | "instruction-sign"
  | "conditional-sign"
  | "clinical-adjunct-sign"
  | "guard-predicate-sign"
  | "guard-operator-sign"
  | "guard-marker-sign"
  | "guard-predicate-phrase"
  | "guard-coordination-tail"
  | "guard-negation-phrase"
  | "medication-guard-phrase"
  | "adjustment-sign"
  | "connector-sign";

export interface HpsgEvidence {
  rule: string;
  /** Canonical provenance comes from the typed lexical sign, not its rule ID. */
  lexicalCategory?: CanonicalLexicalCategory;
  tokenIndices: number[];
  /** Lexical evidence that a schedule field is an inferred, construction-local default. */
  scheduleDefault?: "daily-frequency";
  /** Exact typed schedule fields contributed by this lexical evidence. */
  scheduleFields?: CanonicalScheduleSemanticField[];
}

export type HpsgConstructionKind =
  | "head-complement"
  | "head-adjunct"
  | "head-marker"
  | "procedure-sequence"
  | "conditional-instruction"
  | "coordination"
  | "administration-clause"
  | "generic";

export type HpsgConstructionOperation =
  | "unify"
  | "scope"
  | "form-site-relative"
  | "restrict-site"
  | "repeat-course";

export interface HpsgConstruction {
  kind: HpsgConstructionKind;
  operation?: HpsgConstructionOperation;
  headSide?: "left" | "right";
  leftType: HpsgType;
  rightType: HpsgType;
}


export interface HpsgMethodFeature {
  verb: string;
  headClass?: "administration" | "procedure";
  text?: string;
  textElement?: FhirPrimitiveElement;
  coding?: FhirCoding;
}

export interface HpsgRouteFeature {
  code: RouteCode;
  attachmentClass?: "administration" | "procedure";
  text?: string;
}

export interface HpsgAdministrationTargetFeature {
  attachmentClass?: "administration" | "procedure";
  text?: string;
  i18n?: Record<string, string>;
  source?: "abbreviation" | "text" | "selection" | "resolver";
  coding?: FhirCoding;
  spatialRelation?: BodySiteSpatialRelation;
  restrictions?: BodySiteRestriction[];
  lookupRequest?: SiteCodeLookupRequest;
  administrationTargetCount?: number;
  range?: TextRange;
}

export interface HpsgSiteCoordinationFeature {
  coordination: AdministrationTargetCoordinationKind;
  sourceText: string;
  range: TextRange;
  targets: HpsgAdministrationTargetFeature[];
}

export interface HpsgSiteFeature extends HpsgAdministrationTargetFeature {
  coordination?: HpsgSiteCoordinationFeature;
}

export interface HpsgCoordinationMarkerFeature {
  coordination: Exclude<AdministrationTargetCoordinationKind, "mixed">;
}

export interface HpsgSiteRelativeMarkerFeature {
  relation: BodySiteRestriction["relation"];
  range: TextRange;
}

export interface HpsgSitePredicateFeature extends BodySiteRestrictionPredicate {
  range: TextRange;
}

export interface HpsgPrnFeature {
  enabled: true;
  reasonText?: string;
  triggerPhase?: "onset";
  lookupRequest?: PrnReasonLookupRequest;
  reasons?: Array<{
    text: string;
    triggerPhase?: "onset";
    lookupRequest?: PrnReasonLookupRequest;
  }>;
  lookupRequests?: PrnReasonLookupRequest[];
}

export interface HpsgInstructionFeature extends CanonicalAdditionalInstructionExpr {}

export interface HpsgPatientInstructionFeature {
  text: string;
}

export interface HpsgConditionFeature {
  relation: AdviceRelation;
  text: string;
  fullText: string;
  sourceStart: number;
  sourceEnd: number;
  targetStart: number;
  targetEnd: number;
  safety: boolean;
  frames: AdviceFrame[];
}

/**
 * A medication-level guard or calendar omission contributed by a lexical
 * sign. This is distinct from HpsgConditionFeature, which scopes procedural
 * instruction programs such as "if irritation occurs, stop use".
 */
/** A predicate daughter can require a measurement head from an adjacent
 * coordinate. Only the HPSG coordination construction may discharge it. */
export type HpsgGuardExpression =
  | { kind: "predicate"; value: MedicationCondition; dayInvariant?: true }
  | { kind: "measurement-complement"; operation: "gt" | "ge" | "lt" | "le" | "eq";
      value: number; unit?: string; text: string }
  | { kind: "coordination"; operator: "all" | "any"; parts: HpsgGuardExpression[] }
  | { kind: "negation"; operand: HpsgGuardExpression };

/** Internal conditional constituent features, never a second FHIR schema. */
export interface HpsgGuardFeature {
  expression?: HpsgGuardExpression;
  operator?: "all" | "any" | "not";
  marker?: "if" | "only-if" | "unless";
  licensesBareIf?: true;
}

export interface HpsgClinicalAdjunctFeature {
  treatmentPause?: CanonicalClinicalAdjuncts["treatmentPause"];
  condition?: MedicationCondition;
  /** Day-domain meaning retained separately for typed anaphoric complements. */
  calendarDayCondition?: MedicationCondition;
  conditionTarget?: CanonicalClinicalAdjuncts["conditionTarget"];
  excludedDates?: string[];
  excludedWeekdays?: FhirDayOfWeek[];
  includedWeekdays?: FhirDayOfWeek[];
  /** Recognized adjunct boundary whose payload remains intentionally editable. */
  unresolved?: true;
  localRanges: TextRange[];
  /** Lexical provenance and typed clinical role are distinct. */
  evidence: Array<{
    rule: string;
    kind: "condition" | "calendar-exclusion" | "treatment-pause" | "unresolved";
    ranges: TextRange[];
  }>;
}

export interface HpsgScopedAdministrationFeature {
  condition: HpsgConditionFeature;
  head: HpsgSynsem["head"];
  site?: HpsgSiteFeature;
  prn?: HpsgPrnFeature;
  instructions?: HpsgInstructionFeature[];
  patientInstruction?: HpsgPatientInstructionFeature;
}

export interface HpsgDoseFeature {
  attachmentClass?: "administration" | "procedure";
  value?: number;
  range?: CanonicalDoseRange;
  unit?: string;
  /**
   * Dimensionally typed clinical quantity contributed by the grammar.  This
   * remains distinct from `value`/`unit`: an infusion rate must never be
   * projected through the ordinary doseQuantity path.
   */
  clinicalQuantity?: HpsgClinicalQuantityFeature;
  /** Number of administrations dividing a stated period-total quantity. */
  divisionCount?: number;
}

export type HpsgClinicalQuantityDimension =
  | "mass"
  | "volume"
  | "biologic-activity"
  | "patient-mass"
  | "time";

export interface HpsgDimensionalQuantityTerm {
  value: number;
  unit: string;
  dimension: HpsgClinicalQuantityDimension;
}

export interface HpsgClinicalQuantityFeature {
  representation: "dose" | "rate-quantity" | "dose-with-rate-ratio";
  status: "resolved" | "incomplete" | "unsupported";
  numerator: HpsgDimensionalQuantityTerm;
  denominators: HpsgDimensionalQuantityTerm[];
  /** Per-administration value after an explicit daily total is divided. */
  projectedDose?: { value: number; unit: string };
  /** Carrier amount used for an administration rate when it differs from the active drug dose. */
  rateNumerator?: { value: number; unit: string };
  /** Source-backed vehicle NP scoped to the carrier volume, not the active drug.
   * It is descriptive and uncoded unless terminology separately confirms it. */
  carrierMaterial?: { text: string; range?: TextRange };
  dailyTotal?: boolean;
  dividedDoseCount?: number;
  administrationDuration?: { value: number; unit: FhirPeriodUnit };
  requiresPatientWeight?: true;
  reviewReason?:
    | "incomplete-weight-based-dose"
    | "unsupported-weight-based-rate";
}

/**
 * The public canonical schema predates rate parsing.  Declaration merging
 * exposes the typed grammar contribution without forcing it into the scalar
 * CanonicalDoseExpr shape.  FHIR lowering can therefore distinguish a dose,
 * a rateQuantity, and a dose/rateRatio without reparsing source text.
 */
declare module "../types" {
  interface CanonicalSigClause {
    clinicalQuantity?: HpsgClinicalQuantityFeature;
  }
}

export interface HpsgScheduleFeature {
  cycleDayConstraint?: CanonicalCycleDayConstraint;
  /** Typed whole-course interval for a recurring active/rest construction. */
  repeatCycle?: FhirQuantity;
  /** Explicit finite number of whole-course repetitions; absent means unbounded. */
  repeatCount?: number;
  /** Explicit local-clock interval window; not a list of endpoint doses. */
  clockWindow?: { start: string; end: string; endInclusive: boolean };
  /** Weekday occurrence in each month; -1 denotes the last occurrence. */
  weekdayOrdinal?: -1 | 1 | 2 | 3 | 4 | 5;
  timingReference?: "previous" | "previous-weekday-complement";
  /** Source-relative phase onset, in elapsed days from treatment start. */
  treatmentStartOffsetDays?: number;
  attachmentClass?: "administration" | "procedure";
  /** Exact source owned by this schedule construction, retained for generic attachment arbitration. */
  sourceRanges?: TextRange[];
  timingCode?: string;
  count?: number;
  countMax?: number;
  duration?: number;
  durationMax?: number;
  durationUnit?: FhirPeriodUnit;
  /** Elapsed delay before one administration, not a course duration. */
  administrationOffsetMinutes?: number;
  boundsStart?: string;
  boundsEnd?: string;
  frequency?: number;
  frequencyMax?: number;
  period?: number;
  periodMax?: number;
  periodUnit?: FhirPeriodUnit;
  offset?: number;
  offsetMin?: number;
  offsetMax?: number;
  when?: EventTiming[];
  dayOfWeek?: FhirDayOfWeek[];
  /** Recurring calendar dates of each month; e.g. days 1–14. */
  dayOfMonth?: number[];
  timeOfDay?: string[];
  calendarEvents?: CanonicalCalendarEventExpr[];
  activityTiming?: CanonicalActivityTimingExpr[];
  eventWindow?: { start: EventTiming; end: EventTiming };
  occurrenceCap?: CanonicalOccurrenceCapExpr;
  maxDosePerPeriod?: CanonicalDosePeriodMaximumExpr[];
}

export interface HpsgSynsem {
  head: {
    method?: HpsgMethodFeature;
    route?: HpsgRouteFeature;
    dose?: HpsgDoseFeature;
    schedule?: HpsgScheduleFeature;
  };
  valence: {
    site?: HpsgSiteFeature;
    prn?: HpsgPrnFeature;
    instructions?: HpsgInstructionFeature[];
    patientInstruction?: HpsgPatientInstructionFeature;
  };
  cont: {
    /** Source operation on the preceding regimen, resolved before projection. */
    regimenAdjustment?: "replace" | "add" | "replace-target";
    clauseKind?: "administration";
    condition?: HpsgConditionFeature;
    clinicalAdjunct?: HpsgClinicalAdjunctFeature;
    guard?: HpsgGuardFeature;
    scopedAdministrations?: HpsgScopedAdministrationFeature[];
    scopeClosed?: true;
    coordinationMarker?: HpsgCoordinationMarkerFeature;
    siteRelativeMarker?: HpsgSiteRelativeMarkerFeature;
    sitePredicate?: HpsgSitePredicateFeature;
    siteRestriction?: BodySiteRestriction;
  };
  nonlocal?: {
    scopeRequirements?: HpsgConditionFeature[];
  };
}

export interface HpsgSign {
  type: HpsgType;
  span: { start: number; end: number };
  tokens: Token[];
  synsem: HpsgSynsem;
  /** Formal typed feature graph used by the HPSG constraint substrate. */
  fs: HpsgFeatureNode;
  /** Immediate phrase-construction provenance for non-lexical signs. */
  construction?: HpsgConstruction;
  consumedTokenIndices: number[];
  siteTokenIndices?: number[];
  warnings?: string[];
  evidence: HpsgEvidence[];
  score: number;
}

export interface HpsgLexicalRule<TContext> {
  id: string;
  type: HpsgType;
  match(context: TContext, start: number): HpsgSign[];
}

export interface HpsgPhraseRule<TContext> {
  id: string;
  left?: HpsgType;
  right?: HpsgType;
  combine(context: TContext, left: HpsgSign, right: HpsgSign): HpsgSign | undefined;
}

export interface HpsgGrammar<TContext> {
  lexicalRules: HpsgLexicalRule<TContext>[];
  phraseRules: HpsgPhraseRule<TContext>[];
}

export function emptySynsem(): HpsgSynsem {
  return {
    head: {},
    valence: {},
    cont: {},
    nonlocal: {}
  };
}

export function lexicalSign(args: {
  type: HpsgType;
  rule: string;
  lexicalCategory?: CanonicalLexicalCategory;
  tokens: Token[];
  synsem: HpsgSynsem;
  consumedTokenIndices?: number[];
  siteTokenIndices?: number[];
  warnings?: string[];
  score?: number;
  scheduleDefault?: HpsgEvidence["scheduleDefault"];
  scheduleFields?: CanonicalScheduleSemanticField[];
}): HpsgSign {
  const tokenIndices = args.tokens
    .map((token) => token.index)
    .filter((index) => Number.isFinite(index));
  if (!tokenIndices.length) {
    throw new Error(`Cannot build lexical sign for ${args.rule} without token indices.`);
  }
  const start = Math.min(...tokenIndices);
  const end = Math.max(...tokenIndices) + 1;
  const evidence: HpsgEvidence = {
    rule: args.rule,
    tokenIndices,
    lexicalCategory: args.lexicalCategory,
    scheduleDefault: args.scheduleDefault
  };
  switch (args.type) {
    case "dose-sign": evidence.lexicalCategory = "dose"; break;
    case "method-sign": evidence.lexicalCategory = "method"; break;
    case "prn-sign": evidence.lexicalCategory = "prn"; break;
    case "connector-sign": evidence.lexicalCategory = "connector"; break;
  }
  // Each lexical schedule sign declares the typed features it contributes.
  // Coordination must NEVER guess those features from the production name.
  const schedule = args.synsem.head.schedule;
  if (args.scheduleFields?.length) {
    evidence.scheduleFields = [...args.scheduleFields];
  } else if (schedule) {
    const fields: CanonicalScheduleSemanticField[] = [];
    for (const key of Object.keys(schedule)) {
      if (key === "attachmentClass" || key === "sourceRanges") continue;
      const field = key as keyof HpsgScheduleFeature;
      // Optional undefined values contribute no feature to the lexical sign.
      if (schedule[field] !== undefined) fields.push(key as CanonicalScheduleSemanticField);
    }
    if (fields.length) evidence.scheduleFields = fields;
  }
  return {
    type: args.type,
    span: { start, end },
    tokens: args.tokens,
    synsem: args.synsem,
    fs: signFeatureStructure(args.type, args.synsem),
    consumedTokenIndices:
      args.consumedTokenIndices ?? tokenIndices,
    siteTokenIndices: args.siteTokenIndices,
    warnings: args.warnings,
    evidence: [evidence],
    score: args.score ?? 1
  };
}

/** Cross-clause HPSG construction facts and source-boundary plans. */
export interface Range { start: number; end: number }
export type StructureKind = 'cycle-schedule' | 'target-list' | 'calendar-date-list' | 'clock-list' | 'weekday-list' | 'numeric-quantity' | 'parenthesized' | 'calendar-exclusion' | 'fronted-conditional-clause' | 'procedural-argument' | 'clinical-condition' | 'event-timing-list';
export interface StructuralClaim extends Range {
  id: string;
  kind: StructureKind;
  policy: 'no-external-split';
  producer: string;
  resolved: boolean;
}
export type BoundaryKind = 'coordination' | 'alternative' | 'sequence' | 'comma' | 'hard' | 'slash' | 'adjacent-dose' | 'punctuation';
export type CoordinationConnectorKind = 'conjunction' | 'disjunction' | 'unknown';
export type RegimenRelation = 'sequence' | 'coordination' | 'alternative' | 'shared-duration' | 'independent';
export interface BoundarySite extends Range {
  tokenIndex: number;
  lastTokenIndex: number;
  rightIndex: number;
  kind: BoundaryKind;
  surface: string;
}
export interface Evidence {
  feature: string;
  value: string | number | boolean | readonly string[];
  range?: Range;
}
export interface Proposal {
  action: 'keep' | 'split';
  rule: string;
  priority: number;
  relation?: RegimenRelation;
  /** Typed boundary license to inherit a following sibling's course duration. */
  inheritFollowingDuration?: boolean;
  /** Typed construction license, never inferred from its display rule id. */
  semanticLicense?: "dose-continuation" | "target-transition" | "delayed-target" | "event-timing-ellipsis" | "interval-origin";
  evidence: Evidence[];
}
export interface BoundaryDecision {
  site: BoundarySite;
  selected: Proposal;
  alternatives: Proposal[];
  conflict: boolean;
  rejectedRules?: Array<{ rule: string; failedConstraints: string[] }>;
}
export interface ProbeSummary extends Range {
  complete: boolean;
  hasHead: boolean;
  hasDose: boolean;
  hasSchedule: boolean;
  hasRecurringCadence: boolean;
  hasDates: boolean;
  hasClocks: boolean;
  hasOffset: boolean;
  method: boolean;
  prn: boolean;
  clocks: readonly string[];
  conditionStarts: readonly number[];
  targets: readonly string[];
  hasTargets: boolean;
  siteCoordinations: Array<Range & {
    type: 'site-coordination-phrase';
    coordination: 'conjunction' | 'disjunction' | 'mixed';
  }>;
  clause: CanonicalSigClause;
}
export interface PlannerMetrics {
  lexicalPasses: number;
  dateScans: number;
  actionScans: number;
  clauseProbes: number;
  siteCoordinationProbes: number;
  probeCacheHits: number;
  probedTokens: number;
  candidates: number;
  claimedCandidates: number;
}
export interface BoundaryPlan {
  experimental: true;
  segments: HpsgSigSegment[];
  claims: StructuralClaim[];
  decisions: BoundaryDecision[];
  relations: BoundaryRelation[];
  metrics: PlannerMetrics;
}
export interface PlannerOptions {
  trace?: boolean;
  ownership?: boolean;
  cache?: boolean;
}
export interface PlanningInput {
  input: string;
  options?: ParseOptions;
  tokens: Token[];
  dateSpans?: MedicationDateListMatch[];
}

/** A licensed relation connects segment identities, never reconstructed from display text. */
export interface BoundaryRelation {
  from: number;
  to: number;
  kind: RegimenRelation;
  connectorKind: CoordinationConnectorKind;
  rule: string;
  semanticLicense?: Proposal["semanticLicense"];
  range: Range;
}

/** Typed facts consumed by cross-clause HPSG coordination constructions. */
export interface CoordinationScopeFacts {
  relation: BoundaryRelation;
  adjacent: boolean;
  leftComplete: boolean;
  rightComplete: boolean;
  leftExplicitDose: boolean;
  rightExplicitDose: boolean;
  leftExplicitHead: boolean;
  /** An available typed method, whether explicit or inherited from an earlier daughter. */
  leftHasMethod: boolean;
  leftAdministrationContext: boolean;
  rightExplicitHead: boolean;
  leftHasSite: boolean;
  rightHasSite: boolean;
  targetsDistinct: boolean;
  leftHasSchedule: boolean;
  rightHasSchedule: boolean;
  leftHasCadence: boolean;
  rightHasCadence: boolean;
  /** An independently scoped administration modifier without an invented cadence. */
  rightHasAdministrationAdjunct?: boolean;
  leftHasCourseDuration: boolean;
  rightHasCourseDuration: boolean;
  leftHasPrn: boolean;
  rightHasPrn: boolean;
  leftHasFrontedSchedule: boolean;
  leftHasFrontedPrn: boolean;
  rightHasTrailingSchedule: boolean;
  rightHasTrailingCourseDuration: boolean;
  rightHasTrailingPrn: boolean;
  /** A typed, exact trailing clinical predicate/exclusion whose mother scope is unresolved. */
  rightHasTrailingSafetyGuard: boolean;
}

/** Typed facts for a terminal negative instruction scoped over one regimen. */
export interface TrailingInstructionScopeFacts {
  /** HPSG parsed a local negative action after the terminal semicolon. */
  localNegativeAction: boolean;
  /** The terminal action is separated from the administration by grammar evidence. */
  semicolonDelimited: boolean;
  /** Segment relations connect this recipient to the terminal donor. */
  related: boolean;
  /** Route identity is shared with the terminal administration. */
  sameRoute: boolean;
  /** Missing methods are compatible; two explicit methods must agree. */
  compatibleMethod: boolean;
  relationPath: readonly BoundaryRelation[];
}

export type RegimenSemanticOperation =
  | 'share-trailing-cadence'
  | 'share-trailing-adjuncts'
  | 'share-trailing-course-duration'
  | 'share-trailing-instruction'
  | 'share-leading-adjuncts'
  | 'preserve-disjunctive-dosages'
  | 'inherit-event-timing-administration'
  | 'inherit-event-timing-and-share-trailing-course-duration'
  | 'inherit-administration-head'
  | 'inherit-administration-head-and-share-trailing-course-duration'
  | 'preserve-ambiguous-shared-guard';

export interface RegimenSemanticConstruction {
  id: string;
  priority: number;
  operation: RegimenSemanticOperation;
}

export interface RegimenSemanticSelection {
  construction: RegimenSemanticConstruction;
  evidence: Evidence[];
}
