import type {
  BoundaryDecision,
  BoundarySite,
  CoordinationConnectorKind,
  CoordinationScopeFacts,
  Evidence,
  Proposal,
  ProbeSummary,
  RegimenSemanticConstruction,
  RegimenSemanticSelection,
  TrailingInstructionScopeFacts
} from './types';

/** Typed boundary facts are a separate signature from the production clause grammar. */
export interface BoundaryFacts {
  site: BoundarySite; left: ProbeSummary; right: ProbeSummary; inheritedAdministration: boolean;
  connectorKind: CoordinationConnectorKind;
  explicitRightUnit: boolean; rightHasProcedure: boolean; rightAfterFirstAdministration: boolean;
  leftDateSpan: boolean; rightDateSpan: boolean;
  leftTargetCue: boolean; rightTargetCue: boolean;
}
interface Constraint { feature: string; satisfied: (facts: BoundaryFacts) => boolean }
interface Construction { id: string; priority: number; constraints: readonly Constraint[]; relation: Proposal['relation']; acceptsAdjacentDose?: boolean; inheritFollowingDuration?: boolean; semanticLicense?: Proposal['semanticLicense'] }
interface SemanticConstraint {
  feature: string;
  satisfied: (facts: CoordinationScopeFacts) => boolean;
}
interface SemanticConstruction extends RegimenSemanticConstruction {
  constraints: readonly SemanticConstraint[];
}
const constraint = (feature: string, satisfied: Constraint['satisfied']): Constraint => ({ feature, satisfied });
const coordinationOrSequence = constraint('connector.coordination-or-sequence', f => f.site.kind === 'coordination' || f.site.kind === 'sequence');
const conjunctionOrSequence = constraint('connector.conjunction-or-sequence', f =>
  f.site.kind === 'sequence' || f.connectorKind !== 'disjunction');
const usableLeft = constraint('left.head-or-inherited-complete-schedule', f => f.left.hasHead ||
  f.inheritedAdministration && f.left.complete && f.left.hasSchedule);
const scheduleRight = [
  constraint('right.not-procedural', f => !f.rightHasProcedure),
  constraint('right.complete', f => f.right.complete),
  constraint('right.hasSchedule', f => f.right.hasSchedule),
  constraint('right.omitsHead', f => !f.right.hasHead)
];
const targetSetsDiffer = (left: readonly string[], right: readonly string[]) =>
  left.length !== right.length || left.some(value => right.indexOf(value) < 0);
const clocksDiffer = (a: readonly string[], b: readonly string[]) => a.length !== b.length || a.some((v, i) => v !== b[i]);

const semanticConstraint = (
  feature: string,
  satisfied: SemanticConstraint['satisfied']
): SemanticConstraint => ({ feature, satisfied });

/**
 * Distributive cadence is licensed only for a coordinated dose continuation.
 * The right daughter is the scoped cadence donor; an independently headed,
 * incomplete, conflicting, or already-timed daughter cannot participate.
 */
export const COORDINATION_SCOPE_CONSTRUCTIONS: readonly SemanticConstruction[] = [{
  id: 'hpsg.cx.coordination.disjunctive-dosage-choice',
  priority: 900,
  operation: 'preserve-disjunctive-dosages',
  constraints: [
    semanticConstraint('relation.alternative', f => f.relation.kind === 'alternative'),
    semanticConstraint('relation.disjunction', f => f.relation.connectorKind === 'disjunction'),
    semanticConstraint('daughters.adjacent', f => f.adjacent),
    semanticConstraint('left.explicitDose', f => f.leftExplicitDose),
    semanticConstraint('right.explicitDose', f => f.rightExplicitDose)
  ]
}, {
  id: 'hpsg.cx.coordination.ambiguous-shared-guard',
  priority: 925,
  operation: 'share-trailing-adjuncts',
  constraints: [
    semanticConstraint('relation.coordination', f => f.relation.kind === 'coordination'),
    semanticConstraint('relation.conjunction', f => f.relation.connectorKind === 'conjunction'),
    semanticConstraint('daughters.adjacent', f => f.adjacent),
    semanticConstraint('left.explicitDose', f => f.leftExplicitDose),
    semanticConstraint('right.explicitDose', f => f.rightExplicitDose),
    semanticConstraint('left.adminContext', f => f.leftAdministrationContext),
    semanticConstraint('right.omitsHead', f => !f.rightExplicitHead),
    semanticConstraint('left.hasSite', f => f.leftHasSite),
    semanticConstraint('right.hasSite', f => f.rightHasSite),
    semanticConstraint('targets.distinct', f => f.targetsDistinct),
    semanticConstraint('right.trailingSafetyGuard', f => f.rightHasTrailingSafetyGuard)
  ]
}, {
  id: 'hpsg.cx.coordination.trailing-shared-cadence',
  priority: 800,
  operation: 'share-trailing-cadence',
  constraints: [
    semanticConstraint('relation.coordination', f => f.relation.kind === 'coordination'),
    semanticConstraint('relation.conjunction', f => f.relation.connectorKind === 'conjunction'),
    semanticConstraint('relation.licensed-dose-continuation', f => f.relation.semanticLicense === 'dose-continuation'),
    semanticConstraint('daughters.adjacent', f => f.adjacent),
    semanticConstraint('left.complete', f => f.leftComplete),
    semanticConstraint('right.complete', f => f.rightComplete),
    semanticConstraint('left.explicitDose', f => f.leftExplicitDose),
    semanticConstraint('right.explicitDose', f => f.rightExplicitDose),
    semanticConstraint('left.explicit-or-inherited-administration-head', f => f.leftAdministrationContext),
    semanticConstraint('right.omitsAdministrationHead', f => !f.rightExplicitHead),
    semanticConstraint('left.hasSite', f => f.leftHasSite),
    semanticConstraint('right.hasSite', f => f.rightHasSite),
    semanticConstraint('targets.distinct', f => f.targetsDistinct),
    semanticConstraint('left.omitsCadence', f => !f.leftHasCadence),
    semanticConstraint('right.hasCadence', f => f.rightHasCadence),
    semanticConstraint('right.cadenceConsistent', f => !f.rightHasCadenceConflict)
  ]
}, {
  id: 'hpsg.cx.coordination.trailing-shared-adjuncts',
  priority: 790,
  operation: 'share-trailing-adjuncts',
  constraints: [
    semanticConstraint('relation.coordination', f => f.relation.kind === 'coordination'),
    semanticConstraint('relation.conjunction', f => f.relation.connectorKind === 'conjunction'),
    semanticConstraint('relation.licensed-dose-continuation', f => f.relation.semanticLicense === 'dose-continuation'),
    semanticConstraint('daughters.adjacent', f => f.adjacent),
    semanticConstraint('left.complete', f => f.leftComplete),
    semanticConstraint('right.complete', f => f.rightComplete),
    semanticConstraint('left.explicitDose', f => f.leftExplicitDose),
    semanticConstraint('right.explicitDose', f => f.rightExplicitDose),
    semanticConstraint('left.explicit-or-inherited-administration-head', f => f.leftAdministrationContext),
    semanticConstraint('right.omitsAdministrationHead', f => !f.rightExplicitHead),
    semanticConstraint('left.hasSite', f => f.leftHasSite),
    semanticConstraint('right.hasSite', f => f.rightHasSite),
    semanticConstraint('targets.distinct', f => f.targetsDistinct),
    semanticConstraint('right.omitsCadence', f => !f.rightHasCadence),
    semanticConstraint('right.hasTrailingAdjunct', f =>
      f.rightHasTrailingSchedule || f.rightHasTrailingPrn),
    semanticConstraint('right.cadenceConsistent', f => !f.rightHasCadenceConflict)
  ]
}, {
  id: 'hpsg.cx.coordination.leading-shared-adjuncts',
  priority: 780,
  operation: 'share-leading-adjuncts',
  constraints: [
    semanticConstraint('relation.coordination', f => f.relation.kind === 'coordination'),
    semanticConstraint('relation.conjunction', f => f.relation.connectorKind === 'conjunction'),
    semanticConstraint('relation.licensed-dose-continuation', f => f.relation.semanticLicense === 'dose-continuation'),
    semanticConstraint('daughters.adjacent', f => f.adjacent),
    semanticConstraint('left.complete', f => f.leftComplete),
    semanticConstraint('right.complete', f => f.rightComplete),
    semanticConstraint('left.explicitDose', f => f.leftExplicitDose),
    semanticConstraint('right.explicitDose', f => f.rightExplicitDose),
    semanticConstraint('left.explicit-or-inherited-administration-head', f => f.leftAdministrationContext),
    semanticConstraint('right.omitsAdministrationHead', f => !f.rightExplicitHead),
    semanticConstraint('left.hasSite', f => f.leftHasSite),
    semanticConstraint('right.hasSite', f => f.rightHasSite),
    semanticConstraint('targets.distinct', f => f.targetsDistinct),
    semanticConstraint('left.hasFrontedAdjunct', f =>
      f.leftHasFrontedSchedule || f.leftHasFrontedPrn),
    semanticConstraint('right.omitsSharedSchedule', f =>
      !f.leftHasFrontedSchedule || !f.rightHasSchedule),
    semanticConstraint('right.omitsSharedPrn', f =>
      !f.leftHasFrontedPrn || !f.rightHasPrn),
    semanticConstraint('right.cadenceConsistent', f => !f.rightHasCadenceConflict)
  ]
}];

export function grammaticalCoordinationScopes(
  facts: CoordinationScopeFacts
): RegimenSemanticSelection[] {
  const selected: RegimenSemanticSelection[] = [];
  for (const construction of COORDINATION_SCOPE_CONSTRUCTIONS) {
    if (construction.constraints.some(item => !item.satisfied(facts))) continue;
    selected.push({
      construction: {
        id: construction.id,
        priority: construction.priority,
        operation: construction.operation
      },
      evidence: [
        { feature: 'relation.rule', value: facts.relation.rule, range: facts.relation.range },
        { feature: 'relation.kind', value: facts.relation.kind, range: facts.relation.range },
        { feature: 'right.hasCadence', value: facts.rightHasCadence },
        { feature: 'targets.distinct', value: facts.targetsDistinct }
      ]
    });
  }
  return selected.sort((a, b) =>
    b.construction.priority - a.construction.priority ||
    a.construction.id.localeCompare(b.construction.id)
  );
}

const TRAILING_INSTRUCTION_SCOPE_CONSTRUCTION: RegimenSemanticConstruction = {
  id: 'hpsg.cx.regimen.trailing-shared-negative-instruction',
  priority: 800,
  operation: 'share-trailing-instruction'
};

/**
 * License a terminal negative adjunct from typed action and regimen facts.
 * Surface recognition has already happened in HPSG; this rule only decides
 * whether that local adjunct scopes over a related compatible administration.
 */
export function grammaticalTrailingInstructionScope(
  facts: TrailingInstructionScopeFacts
): RegimenSemanticSelection | undefined {
  if (!facts.localNegativeAction || !facts.semicolonDelimited || !facts.related ||
      !facts.sameRoute || !facts.compatibleMethod) return undefined;
  return {
    construction: TRAILING_INSTRUCTION_SCOPE_CONSTRUCTION,
    evidence: [
      { feature: 'instruction.polarity', value: 'negate' },
      { feature: 'instruction.position', value: 'semicolon-terminal' },
      ...facts.relationPath.map(relation => ({
        feature: 'relation.rule',
        value: relation.rule,
        range: relation.range
      }))
    ]
  };
}

/** Rules inspect features only. Surface/locale recognition belongs to lexical and span producers. */
export const CONSTRUCTIONS: readonly Construction[] = [
  { id: 'regimen.disjunctive-dosage-choice', priority: 900, relation: 'alternative', constraints: [
    constraint('connector.coordination', f => f.site.kind === 'coordination'),
    constraint('connector.disjunction', f => f.connectorKind === 'disjunction'),
    constraint('left.complete', f => f.left.complete),
    constraint('right.complete', f => f.right.complete),
    constraint('left.hasDose', f => f.left.hasDose),
    constraint('right.hasDose', f => f.right.hasDose),
    constraint('right.explicitUnit', f => f.explicitRightUnit),
    constraint('right.not-procedural', f => !f.rightHasProcedure)
  ] },
  { id: 'regimen.dose-continuation', priority: 700, relation: 'coordination',
    semanticLicense: 'dose-continuation', constraints: [
    coordinationOrSequence, conjunctionOrSequence,
    constraint('right.explicitUnit', f => f.explicitRightUnit), constraint('left.hasDose', f => f.left.hasDose),
    constraint('right.hasDose', f => f.right.hasDose), constraint('right.not-after-first-administration', f => !f.rightAfterFirstAdministration),
    constraint('right.schedule-method-or-target', f => f.right.hasSchedule || f.right.method || f.right.hasTargets)
  ] },
  { id: 'regimen.sequence', priority: 750, relation: 'sequence', constraints: [
    constraint('connector.sequence', f => f.site.kind === 'sequence'), ...scheduleRight, usableLeft
  ] },
  { id: 'regimen.target-phase-transition', priority: 770, relation: 'sequence',
    semanticLicense: 'target-transition', constraints: [
    coordinationOrSequence, conjunctionOrSequence,
    constraint('left.targetCue', f => f.leftTargetCue),
    constraint('right.targetCue', f => f.rightTargetCue),
    constraint('neighbors.two-date-spans', f => f.leftDateSpan && f.rightDateSpan),
    constraint('left.hasExactDate', f => f.left.hasDates),
    constraint('left.notRecurring', f => !f.left.hasRecurringCadence),
    constraint('right.hasExactAnchor', f => f.right.hasDates),
    constraint('right.recurring', f => f.right.hasRecurringCadence),
    constraint('left.hasTargets', f => f.left.hasTargets),
    constraint('right.hasTargets', f => f.right.hasTargets),
    constraint('targets.distinct', f => targetSetsDiffer(f.left.targets, f.right.targets))
  ] },
  { id: 'regimen.target-change', priority: 755, relation: 'coordination',
    semanticLicense: 'target-transition', constraints: [
    coordinationOrSequence, conjunctionOrSequence,
    constraint('left.targetCue', f => f.leftTargetCue),
    constraint('right.targetCue', f => f.rightTargetCue),
    constraint('left.hasIndependentCadence', f =>
      f.left.hasRecurringCadence || f.left.hasClocks || f.left.hasOffset),
    constraint('right.hasIndependentCadence', f =>
      f.right.hasRecurringCadence || f.right.hasClocks || f.right.hasOffset),
    constraint('left.hasTargets', f => f.left.hasTargets),
    constraint('right.hasTargets', f => f.right.hasTargets),
    constraint('targets.distinct', f => targetSetsDiffer(f.left.targets, f.right.targets))
  ] },
  { id: 'regimen.distinct-date-clock-pairs', priority: 740, relation: 'coordination', constraints: [
    constraint('neighbors.two-date-spans', f => f.leftDateSpan && f.rightDateSpan),
    ...scheduleRight, usableLeft, constraint('left.hasDates', f => f.left.hasDates), constraint('right.hasDates', f => f.right.hasDates),
    constraint('left.hasClocks', f => f.left.hasClocks), constraint('right.hasClocks', f => f.right.hasClocks),
    constraint('clocks.distinct', f => clocksDiffer(f.left.clocks, f.right.clocks))
  ] },
  { id: 'regimen.exact-recurring-union', priority: 730, relation: 'coordination', constraints: [
    constraint('neighbors.calendar-context', f => f.leftDateSpan || f.rightDateSpan),
    ...scheduleRight, usableLeft, constraint('neighbors.exact-and-recurring', f =>
      f.left.hasDates && f.right.hasRecurringCadence || f.left.hasRecurringCadence && f.right.hasDates)
  ] },
  { id: 'regimen.relative-administration', priority: 720, relation: 'coordination', constraints: [
    coordinationOrSequence, ...scheduleRight, usableLeft, constraint('left.hasOffset', f => f.left.hasOffset)
  ] },
  { id: 'regimen.comma-timed-administrations', priority: 760, relation: 'coordination', constraints: [
    constraint('connector.comma', f => f.site.kind === 'comma'),
    constraint('right.explicitUnit', f => f.explicitRightUnit),
    constraint('left.complete', f => f.left.complete), constraint('left.hasDose', f => f.left.hasDose),
    constraint('left.hasSchedule', f => f.left.hasSchedule), constraint('right.complete', f => f.right.complete),
    constraint('right.hasDose', f => f.right.hasDose), constraint('right.hasSchedule', f => f.right.hasSchedule),
    constraint('right.not-procedural', f => !f.rightHasProcedure)
  ] },
  { id: 'regimen.adjacent-timed-doses', priority: 760, relation: 'coordination',
    acceptsAdjacentDose: true, inheritFollowingDuration: true, constraints: [
    constraint('connector.adjacent-dose', f => f.site.kind === 'adjacent-dose'),
    constraint('left.complete', f => f.left.complete), constraint('left.hasDose', f => f.left.hasDose),
    constraint('left.hasSchedule', f => f.left.hasSchedule), constraint('right.complete', f => f.right.complete),
    constraint('right.hasDose', f => f.right.hasDose), constraint('right.hasSchedule', f => f.right.hasSchedule),
    constraint('right.not-procedural', f => !f.rightHasProcedure)
  ] }
];

export interface RejectedConstruction { rule: string; failedConstraints: string[] }
export function grammaticalProposals(f: BoundaryFacts, rejected?: RejectedConstruction[]): Proposal[] {
  const describe = (): Evidence[] => [
    { feature: 'connector.kind', value: f.connectorKind, range: f.site },
    { feature: 'left.hasDose', value: f.left.hasDose, range: f.left },
    { feature: 'left.hasDates', value: f.left.hasDates, range: f.left },
    { feature: 'left.hasRecurringCadence', value: f.left.hasRecurringCadence, range: f.left },
    { feature: 'left.clocks', value: f.left.clocks, range: f.left },
    { feature: 'left.targets', value: f.left.targets, range: f.left },
    { feature: 'right.complete', value: f.right.complete, range: f.right },
    { feature: 'right.hasDose', value: f.right.hasDose, range: f.right },
    { feature: 'right.hasDates', value: f.right.hasDates, range: f.right },
    { feature: 'right.hasRecurringCadence', value: f.right.hasRecurringCadence, range: f.right },
    { feature: 'right.clocks', value: f.right.clocks, range: f.right },
    { feature: 'right.targets', value: f.right.targets, range: f.right },
    { feature: 'inheritedAdministration', value: f.inheritedAdministration }
  ].map(e => e.range ? { ...e, range: { start: e.range.start, end: e.range.end } } : e);
  const proposals: Proposal[] = [];
  for (const rule of CONSTRUCTIONS) {
    if (f.site.kind === 'adjacent-dose' && !rule.acceptsAdjacentDose) continue;
    const failed: string[] = [];
    for (const constraint of rule.constraints) {
      if (!constraint.satisfied(f)) {
        failed.push(constraint.feature);
        if (!rejected) break;
      }
    }
    if (failed.length) { rejected?.push({ rule: rule.id, failedConstraints: failed }); continue; }
    proposals.push({ action: 'split', rule: rule.id, priority: rule.priority,
      relation: f.site.kind === 'sequence' ? 'sequence' : rule.relation,
      inheritFollowingDuration: rule.inheritFollowingDuration,
      semanticLicense: rule.semanticLicense,
      evidence: describe() });
  }
  return proposals;
}

/** Hard constraints dominate licensed rules; equal-priority conflicting actions stay unresolved/kept. */
export function arbitrate(site: BoundarySite, proposals: Proposal[]): BoundaryDecision {
  const sorted = [...proposals].sort((a, b) => b.priority - a.priority || a.rule.localeCompare(b.rule));
  const winner = sorted[0] ?? { action: 'keep' as const, rule: 'boundary.no-licensed-split', priority: 0,
    evidence: [{ feature: 'licensedSplitCount', value: 0 }] };
  const conflict = sorted.some(p => p.priority === winner.priority &&
    (p.action !== winner.action || p.action === 'split' && p.relation !== winner.relation));
  return { site, conflict, selected: conflict
    ? { action: 'keep', rule: 'boundary.unresolved-conflict', priority: winner.priority,
      evidence: [{ feature: 'conflictingRules', value: sorted.filter(p => p.priority === winner.priority).map(p => p.rule) }] }
    : winner, alternatives: sorted.filter(p => p !== winner) };
}
