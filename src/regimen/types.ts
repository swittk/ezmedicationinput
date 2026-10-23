import type { HpsgSigSegment } from '../hpsg/segmenter';
import type { CanonicalSigClause, ParseOptions } from '../types';
import type { Token } from '../parser-state';
import type { MedicationDateListMatch } from '../date-interpretation';

export interface Range { start: number; end: number }
export type StructureKind = 'cycle-schedule' | 'target-list' | 'calendar-date-list' | 'clock-list' | 'weekday-list' | 'numeric-quantity' | 'parenthesized' | 'calendar-exclusion' | 'fronted-conditional-clause';
export interface StructuralClaim extends Range {
  id: string;
  kind: StructureKind;
  policy: 'no-external-split';
  producer: string;
  resolved: boolean;
}
export type BoundaryKind = 'coordination' | 'sequence' | 'comma' | 'hard' | 'slash' | 'adjacent-dose' | 'punctuation';
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
  semanticLicense?: "dose-continuation" | "target-transition";
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
  leftAdministrationContext: boolean;
  rightExplicitHead: boolean;
  leftHasSite: boolean;
  rightHasSite: boolean;
  targetsDistinct: boolean;
  leftHasSchedule: boolean;
  rightHasSchedule: boolean;
  leftHasCadence: boolean;
  rightHasCadence: boolean;
  leftHasPrn: boolean;
  rightHasPrn: boolean;
  leftHasFrontedSchedule: boolean;
  leftHasFrontedPrn: boolean;
  rightHasTrailingSchedule: boolean;
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
  | 'share-trailing-instruction'
  | 'share-leading-adjuncts'
  | 'preserve-disjunctive-dosages'
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
