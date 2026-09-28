import type { HpsgSigSegment } from '../../src/hpsg/segmenter';
import type { CanonicalSigClause, ParseOptions } from '../../src/types';
import type { Token } from '../../src/parser-state';

export interface Range { start: number; end: number }
export type StructureKind = 'cycle-schedule' | 'target-list' | 'calendar-date-list' | 'clock-list' | 'weekday-list' | 'numeric-quantity' | 'parenthesized';
export interface StructuralClaim extends Range {
  id: string;
  kind: StructureKind;
  policy: 'no-external-split';
  producer: string;
  resolved: boolean;
}
export type BoundaryKind = 'coordination' | 'sequence' | 'comma' | 'hard' | 'slash' | 'adjacent-dose' | 'punctuation';
export type RegimenRelation = 'sequence' | 'coordination' | 'shared-duration' | 'independent';
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
  clause: CanonicalSigClause;
}
export interface PlannerMetrics {
  lexicalPasses: number;
  dateScans: number;
  actionScans: number;
  clauseProbes: number;
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
export interface PlanningInput { input: string; options?: ParseOptions; tokens: Token[] }

/** A licensed relation connects segment identities, never reconstructed from display text. */
export interface BoundaryRelation {
  from: number;
  to: number;
  kind: RegimenRelation;
  rule: string;
  range: Range;
}
