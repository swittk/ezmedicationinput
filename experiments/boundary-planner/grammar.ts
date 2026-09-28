import type { BoundaryDecision, BoundarySite, Evidence, Proposal, ProbeSummary } from './types';

/** Typed boundary facts are a separate signature from the production clause grammar. */
export interface BoundaryFacts {
  site: BoundarySite; left: ProbeSummary; right: ProbeSummary; inheritedAdministration: boolean;
  explicitRightUnit: boolean; rightHasProcedure: boolean; rightAfterFirstAdministration: boolean;
  leftDateSpan: boolean; rightDateSpan: boolean;
  leftTargetCue: boolean; rightTargetCue: boolean;
}
interface Constraint { feature: string; satisfied: (facts: BoundaryFacts) => boolean }
interface Construction { id: string; priority: number; constraints: readonly Constraint[]; relation: Proposal['relation'] }
const constraint = (feature: string, satisfied: Constraint['satisfied']): Constraint => ({ feature, satisfied });
const coordinationOrSequence = constraint('connector.coordination-or-sequence', f => f.site.kind === 'coordination' || f.site.kind === 'sequence');
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

/** Rules inspect features only. Surface/locale recognition belongs to lexical and span producers. */
export const CONSTRUCTIONS: readonly Construction[] = [
  { id: 'regimen.dose-continuation', priority: 700, relation: 'coordination', constraints: [
    coordinationOrSequence, constraint('right.explicitUnit', f => f.explicitRightUnit), constraint('left.hasDose', f => f.left.hasDose),
    constraint('right.hasDose', f => f.right.hasDose), constraint('right.not-after-first-administration', f => !f.rightAfterFirstAdministration),
    constraint('right.schedule-or-method', f => f.right.hasSchedule || f.right.method)
  ] },
  { id: 'regimen.sequence', priority: 750, relation: 'sequence', constraints: [
    constraint('connector.sequence', f => f.site.kind === 'sequence'), ...scheduleRight, usableLeft
  ] },
  { id: 'regimen.target-phase-transition', priority: 770, relation: 'sequence', constraints: [
    coordinationOrSequence,
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
  { id: 'regimen.target-change', priority: 755, relation: 'coordination', constraints: [
    coordinationOrSequence,
    constraint('left.targetCue', f => f.leftTargetCue),
    constraint('right.targetCue', f => f.rightTargetCue),
    constraint('left.hasSchedule', f => f.left.hasSchedule),
    constraint('right.hasSchedule', f => f.right.hasSchedule),
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
  { id: 'regimen.adjacent-timed-doses', priority: 760, relation: 'shared-duration', constraints: [
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
    if (f.site.kind === 'adjacent-dose' && rule.id !== 'regimen.adjacent-timed-doses') continue;
    const failed: string[] = [];
    for (const constraint of rule.constraints) {
      if (!constraint.satisfied(f)) {
        failed.push(constraint.feature);
        if (!rejected) break;
      }
    }
    if (failed.length) { rejected?.push({ rule: rule.id, failedConstraints: failed }); continue; }
    proposals.push({ action: 'split', rule: rule.id, priority: rule.priority,
      relation: f.site.kind === 'sequence' ? 'sequence' : rule.relation, evidence: describe() });
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
