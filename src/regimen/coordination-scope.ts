import { selectHpsgCoordinationScopeConstruction } from '../hpsg/constructions';
import { coordinationConnectorKind } from '../hpsg/lexical-classes';
import { findUnparsedTokenGroups } from '../parser';
import type { ParserState } from '../parser-state';
import type {
  CanonicalEvidence,
  CanonicalScheduleExpr,
  CanonicalSigClause,
  CanonicalSourceSpan
} from '../types';
import type { BoundaryPlan, BoundaryRelation, CoordinationScopeFacts } from './types';

export interface CoordinatedClauseState {
  state: ParserState;
  start: number;
  end: number;
}

export interface CoordinationScopeApplication {
  rule: string;
  from: number;
  to: number;
  fields: string[];
}

function hasEvidence(clause: CanonicalSigClause, prefix: string): boolean {
  return clause.evidence.some(item => item.rule.startsWith(prefix));
}

function hasCadence(schedule: CanonicalScheduleExpr | undefined): boolean {
  return Boolean(schedule && (
    schedule.timingCode ||
    schedule.frequency !== undefined ||
    schedule.frequencyMax !== undefined ||
    schedule.period !== undefined ||
    schedule.periodMax !== undefined ||
    schedule.dayOfWeek?.length ||
    schedule.when?.length ||
    schedule.timeOfDay?.length
  ));
}

function hasCadenceConflict(state: ParserState): boolean {
  return state.warnings.some(warning =>
    /(?:unresolved|incompatible|conflict).*(?:schedule|timing)|(?:schedule|timing).*(?:unresolved|incompatible|conflict)/iu.test(warning)
  );
}

function targetKey(clause: CanonicalSigClause): string | undefined {
  const coding = clause.site?.coding;
  if (coding?.code) return `${coding.system ?? ''}|${coding.code}`;
  const text = clause.site?.text?.trim().toLocaleLowerCase().replace(/\s+/gu, ' ');
  return text || undefined;
}

function cloneCadence(schedule: CanonicalScheduleExpr): CanonicalScheduleExpr {
  return {
    timingCode: schedule.timingCode,
    frequency: schedule.frequency,
    frequencyMax: schedule.frequencyMax,
    period: schedule.period,
    periodMax: schedule.periodMax,
    periodUnit: schedule.periodUnit,
    dayOfWeek: schedule.dayOfWeek ? [...schedule.dayOfWeek] : undefined,
    when: schedule.when ? [...schedule.when] : undefined,
    timeOfDay: schedule.timeOfDay ? [...schedule.timeOfDay] : undefined
  };
}

function shiftEvidenceToRecipient(
  evidence: CanonicalEvidence,
  donorStart: number,
  recipientStart: number
): CanonicalEvidence {
  return {
    ...evidence,
    spans: evidence.spans.map(span => ({
      start: span.start + donorStart - recipientStart,
      end: span.end + donorStart - recipientStart,
      text: span.text
    }))
  };
}

function sameSpan(left: CanonicalSourceSpan, right: CanonicalSourceSpan): boolean {
  return left.start === right.start && left.end === right.end && left.text === right.text;
}

function appendEvidence(target: CanonicalEvidence[], candidate: CanonicalEvidence): void {
  const duplicate = target.some(item =>
    item.rule === candidate.rule &&
    item.spans.length === candidate.spans.length &&
    item.spans.every((span, index) => sameSpan(span, candidate.spans[index]))
  );
  if (!duplicate) target.push(candidate);
}

function sourceScheduleEvidence(clause: CanonicalSigClause): CanonicalEvidence[] {
  const evidence: CanonicalEvidence[] = [];
  for (const item of clause.schedule?.evidence ?? []) appendEvidence(evidence, item);
  for (const item of clause.evidence) {
    if (item.rule.startsWith('hpsg.lex.schedule.')) appendEvidence(evidence, item);
  }
  return evidence;
}

function factsFor(
  relation: BoundaryRelation,
  left: CoordinatedClauseState,
  right: CoordinatedClauseState,
  inheritedAdministration: boolean,
  source: string
): CoordinationScopeFacts {
  const leftClause = left.state.primaryClause;
  const rightClause = right.state.primaryClause;
  const leftTarget = targetKey(leftClause);
  const rightTarget = targetKey(rightClause);
  return {
    relation,
    connectorKind: coordinationConnectorKind(source.slice(relation.range.start, relation.range.end)),
    adjacent: relation.to === relation.from + 1,
    leftComplete: findUnparsedTokenGroups(left.state).length === 0,
    rightComplete: findUnparsedTokenGroups(right.state).length === 0,
    leftExplicitDose: Boolean(leftClause.dose && hasEvidence(leftClause, 'hpsg.lex.dose')),
    rightExplicitDose: Boolean(rightClause.dose && hasEvidence(rightClause, 'hpsg.lex.dose')),
    leftExplicitHead: hasEvidence(leftClause, 'hpsg.lex.method'),
    leftAdministrationContext: hasEvidence(leftClause, 'hpsg.lex.method') || inheritedAdministration,
    rightExplicitHead: hasEvidence(rightClause, 'hpsg.lex.method'),
    leftHasSite: Boolean(leftTarget),
    rightHasSite: Boolean(rightTarget),
    targetsDistinct: Boolean(leftTarget && rightTarget && leftTarget !== rightTarget),
    leftHasCadence: hasCadence(leftClause.schedule),
    rightHasCadence: hasCadence(rightClause.schedule),
    rightHasCadenceConflict: hasCadenceConflict(right.state)
  };
}

function exactClauseState(
  states: readonly CoordinatedClauseState[],
  start: number,
  end: number
): CoordinatedClauseState | undefined {
  let match: CoordinatedClauseState | undefined;
  for (const item of states) {
    if (item.start !== start || item.end !== end) continue;
    if (match) return undefined;
    match = item;
  }
  return match;
}

/**
 * Apply licensed distributive cadence to canonical clause semantics. FHIR is
 * intentionally absent here: every downstream representation is lowered from
 * the resulting canonical schedule, making this the single semantic source.
 */
export function applyCoordinatedCadenceScopes(
  states: readonly CoordinatedClauseState[],
  plan: BoundaryPlan,
  source: string
): CoordinationScopeApplication[] {
  const applications: CoordinationScopeApplication[] = [];
  const inheritedAdministrationSegments = new Set<number>();
  for (const relation of plan.relations) {
    if (relation.kind === 'coordination' && relation.rule === 'regimen.dose-continuation') {
      inheritedAdministrationSegments.add(relation.to);
    }
  }
  for (let index = plan.relations.length - 1; index >= 0; index -= 1) {
    const relation = plan.relations[index];
    const leftSegment = plan.segments[relation.from];
    const rightSegment = plan.segments[relation.to];
    if (!leftSegment || !rightSegment) continue;
    const left = exactClauseState(states, leftSegment.start, leftSegment.end);
    const right = exactClauseState(states, rightSegment.start, rightSegment.end);
    if (!left || !right) continue;

    const selected = selectHpsgCoordinationScopeConstruction(factsFor(
      relation,
      left,
      right,
      inheritedAdministrationSegments.has(relation.from),
      source
    ));
    if (!selected) continue;
    if (selected.semantic.construction.operation === 'quarantine-disjunctive-dosages') {
      // The grammar identifies alternative administrations; the later safety
      // gate prevents either alternative from being executed as if mandatory.
      applications.push({
        rule: selected.semantic.construction.id,
        from: states.indexOf(left),
        to: states.indexOf(right),
        fields: []
      });
      continue;
    }
    if (selected.semantic.construction.operation !== 'share-trailing-cadence') continue;
    const donorSchedule = right.state.primaryClause.schedule;
    if (!donorSchedule) continue;

    const targetClause = left.state.primaryClause;
    const inherited = cloneCadence(donorSchedule);
    const inheritedEvidence = sourceScheduleEvidence(right.state.primaryClause).map(item =>
      shiftEvidenceToRecipient(item, right.start, left.start)
    );
    const connectorEvidence: CanonicalEvidence = {
      rule: selected.semantic.construction.id,
      spans: [{
        start: relation.range.start - left.start,
        end: relation.range.end - left.start,
        text: source.slice(relation.range.start, relation.range.end)
      }],
      note: `Scoped by ${relation.rule}; cadence daughter is the right administration clause.`
    };
    // The left daughter may already constrain the course (count, duration,
    // calendar bounds, offsets, etc.) without having its own cadence. Share
    // only the donor's cadence, retaining those independently parsed facts.
    const scopedSchedule: CanonicalScheduleExpr = {
      ...(targetClause.schedule ?? {}),
      ...inherited,
      evidence: [...(targetClause.schedule?.evidence ?? [])]
    };
    for (const item of inheritedEvidence) appendEvidence(scopedSchedule.evidence!, item);
    appendEvidence(scopedSchedule.evidence!, connectorEvidence);
    targetClause.schedule = scopedSchedule;
    for (const item of inheritedEvidence) appendEvidence(targetClause.evidence, item);
    appendEvidence(targetClause.evidence, connectorEvidence);
    applications.push({
      rule: selected.semantic.construction.id,
      from: relation.to,
      to: relation.from,
      fields: ['timingCode', 'frequency', 'frequencyMax', 'period', 'periodMax', 'periodUnit',
        'dayOfWeek', 'when', 'timeOfDay']
    });
  }
  return applications;
}
