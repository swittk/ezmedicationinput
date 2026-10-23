import type { BoundaryPlan, BoundaryRelation } from './types';
import type { HpsgSigSegment } from '../hpsg/segmenter';
import type { ParserState } from '../parser-state';
import type {
  CanonicalEvidence,
  CanonicalSigClause,
  CanonicalSourceSpan
} from '../types';

export interface RegimenPhase { id: number; members: number[] }
export interface PhaseEdge { from: number; to: number; relation: BoundaryRelation }
export interface RegimenGraph { phases: RegimenPhase[]; sequences: PhaseEdge[] }
export interface InheritanceEvidence { rule: string; phase: number; sources: number[]; target: number; fields: string[] }

/** Retain coordination as a group; sequence and independent delimiters start new groups. */
export function buildRegimenGraph(plan: BoundaryPlan, segments: readonly HpsgSigSegment[]): RegimenGraph {
  const phases: RegimenPhase[] = [], sequences: PhaseEdge[] = [];
  let original = 0;
  for (let index = 0; index < segments.length; index++) {
    while (original + 1 < plan.segments.length && segments[index].start >= plan.segments[original + 1].start) original++;
    const sameSource = index > 0 && segments[index].start === segments[index - 1].start;
    const incoming = sameSource ? undefined : plan.relations.find(e => e.to === original);
    if (!phases.length || incoming && (incoming.kind === 'sequence' || incoming.kind === 'independent')) {
      const id = phases.length;
      phases.push({ id, members: [] });
      if (incoming?.kind === 'sequence' && id > 0) sequences.push({ from: id - 1, to: id, relation: incoming });
    }
    phases[phases.length - 1].members.push(index);
  }
  return { phases, sequences };
}

function nextDate(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return undefined;
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * A date-anchored exact day/week duration has one canonical inclusive window.
 * Materialize that window on the typed schedule before FHIR projection so the
 * wire layer never has to choose between boundsPeriod and boundsDuration.
 */
export function anchoredScheduleDurationEnd(
  schedule: CanonicalSigClause['schedule']
): string | undefined {
  if (!schedule?.boundsStart || schedule.duration === undefined ||
      schedule.durationMax !== undefined && schedule.durationMax !== schedule.duration) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(schedule.boundsStart) || schedule.duration <= 0) {
    return undefined;
  }
  const factor = schedule.durationUnit === 'd' ? 1 : schedule.durationUnit === 'wk' ? 7 : undefined;
  if (factor === undefined || !Number.isInteger(schedule.duration * factor)) return undefined;
  const date = new Date(`${schedule.boundsStart}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return undefined;
  date.setUTCDate(date.getUTCDate() + schedule.duration * factor - 1);
  return date.toISOString().slice(0, 10);
}

function materializeAnchoredScheduleWindow(schedule: CanonicalSigClause['schedule']): void {
  if (!schedule || schedule.boundsEnd) return;
  const durationEnd = anchoredScheduleDurationEnd(schedule);
  if (durationEnd) schedule.boundsEnd = durationEnd;
}
/** Half-open phase endpoint derived from explicit dates, end bounds, or anchored duration. */
function phaseEndExclusive(schedule: CanonicalSigClause['schedule']): string | undefined {
  if (!schedule) return undefined;
  let endpoint = schedule.boundsEnd ? nextDate(schedule.boundsEnd) : undefined;
  if (schedule.boundsStart && schedule.duration !== undefined && schedule.durationUnit) {
    const factor = schedule.durationUnit === 'd' ? 1 : schedule.durationUnit === 'wk' ? 7 : undefined;
    if (factor !== undefined && Number.isInteger(schedule.duration * factor) && schedule.duration > 0) {
      const start = new Date(`${schedule.boundsStart}T00:00:00Z`);
      if (Number.isFinite(start.getTime())) {
        start.setUTCDate(start.getUTCDate() + schedule.duration * factor);
        const durationEnd = start.toISOString().slice(0, 10);
        if (!endpoint || durationEnd < endpoint) endpoint = durationEnd;
      }
    }
  }
  // Explicit finite phase bounds take precedence over the date of its last dose.
  if (endpoint) return endpoint;
  if (schedule.calendarEvents?.length) {
    let latest = '';
    for (const event of schedule.calendarEvents) if (event.isoDate > latest) latest = event.isoDate;
    return nextDate(latest);
  }
  return undefined;
}

function sameSet(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return (left?.length ?? 0) === (right?.length ?? 0) && (left ?? []).every(v => (right?.indexOf(v) ?? -1) >= 0);
}

function sameSpan(left: CanonicalSourceSpan, right: CanonicalSourceSpan): boolean {
  return left.start === right.start && left.end === right.end && left.text === right.text;
}

function appendEvidence(target: CanonicalEvidence[], candidate: CanonicalEvidence): void {
  if (!target.some(item =>
    item.rule === candidate.rule &&
    item.spans.length === candidate.spans.length &&
    item.spans.every((span, index) => sameSpan(span, candidate.spans[index]))
  )) target.push(candidate);
}

function shiftEvidence(
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

function appendPredecessorScheduleEvidence(
  target: CanonicalEvidence[],
  clause: CanonicalSigClause,
  donorStart: number,
  recipientStart: number
): void {
  for (const item of clause.schedule?.evidence ?? []) {
    appendEvidence(target, shiftEvidence(item, donorStart, recipientStart));
  }
  for (const item of clause.evidence) {
    if (!item.rule.startsWith('hpsg.lex.schedule.')) continue;
    appendEvidence(target, shiftEvidence(item, donorStart, recipientStart));
  }
}

function hasRecurringSchedule(schedule: CanonicalSigClause['schedule']): boolean {
  return Boolean(schedule && (
    schedule.dayOfWeek?.length ||
    schedule.frequency !== undefined ||
    schedule.period !== undefined ||
    schedule.timingCode ||
    schedule.when?.length ||
    schedule.timeOfDay?.length
  ));
}

/**
 * License sequential schedule inheritance on the typed regimen graph before
 * canonical clauses are lowered to FHIR. A complete predecessor phase owns
 * the derived start, and only anchors shared by every predecessor daughter
 * may fill an otherwise unanchored successor.
 */
export function scopeSequentialPhaseSemantics(
  states: readonly ParserState[],
  segments: readonly HpsgSigSegment[],
  graph: RegimenGraph,
  source: string
): InheritanceEvidence[] {
  const applications: InheritanceEvidence[] = [];
  for (const state of states) materializeAnchoredScheduleWindow(state.primaryClause.schedule);
  for (const edge of graph.sequences) {
    const prior = graph.phases[edge.from].members;
    const schedules = prior.map(index => states[index]?.primaryClause.schedule);
    const endpoints = schedules.map(phaseEndExclusive);
    // All coordinated daughters must be finite. An unbounded sibling prevents
    // the sequence construction from inventing a phase boundary.
    const start = endpoints.length && endpoints.every((value): value is string => !!value)
      ? endpoints.reduce((latest, value) => value > latest ? value : latest, '')
      : undefined;
    const shared = schedules[0];
    const sharedAnchors = schedules.every(schedule =>
      sameSet(schedule?.when, shared?.when) &&
      sameSet(schedule?.timeOfDay, shared?.timeOfDay)
    );
    // The target-transition construction may carry an omitted administration
    // method only when the entire predecessor phase agrees on the typed head.
    const sourceMethods = prior.map(index => states[index]?.primaryClause.method);
    const sharedMethod = edge.relation.rule.startsWith('regimen.target-') &&
      sourceMethods[0] &&
      sourceMethods.every(method => JSON.stringify(method) === JSON.stringify(sourceMethods[0]))
      ? sourceMethods[0] : undefined;

    for (const index of graph.phases[edge.to].members) {
      const clause = states[index]?.primaryClause;
      const schedule = clause?.schedule;
      if (!clause || !schedule || schedule.calendarEvents?.length || !hasRecurringSchedule(schedule)) continue;

      const fields: string[] = [];
      if (sharedMethod && !clause.method) {
        clause.method = JSON.parse(JSON.stringify(sharedMethod));
        fields.push('method');
      }
      if (!hasRecurringSchedule(schedule)) {
        if (fields.length) {
          clause.evidence.push({
            rule: 'hpsg.cx.regimen.shared-administration-method',
            spans: [{ start: edge.relation.range.start - (segments[index]?.start ?? 0),
              end: edge.relation.range.end - (segments[index]?.start ?? 0),
              text: source.slice(edge.relation.range.start, edge.relation.range.end) }]
          });
          applications.push({
            rule: 'regimen.sequence.whole-predecessor-phase',
            phase: edge.to, sources: [...prior], target: index, fields
          });
        }
        continue;
      }
      if (!schedule.boundsStart && start) {
        schedule.boundsStart = start;
        fields.push('boundsStart');
        materializeAnchoredScheduleWindow(schedule);
      }
      // An explicit local meal/event or clock anchor owns the whole anchor
      // group, so inherited anchors can never create a mixed local/donor pair.
      if (!schedule.when?.length && !schedule.timeOfDay?.length && sharedAnchors) {
        if (shared?.when?.length) {
          schedule.when = [...shared.when];
          fields.push('when');
        }
        if (shared?.timeOfDay?.length) {
          schedule.timeOfDay = [...shared.timeOfDay];
          fields.push('timeOfDay');
        }
      }
      if (!fields.length) continue;

      const scheduleEvidence = [...(schedule.evidence ?? [])];
      for (const donor of prior) {
        const donorClause = states[donor]?.primaryClause;
        const donorSegment = segments[donor];
        const recipientSegment = segments[index];
        if (!donorClause || !donorSegment || !recipientSegment) continue;
        appendPredecessorScheduleEvidence(
          scheduleEvidence,
          donorClause,
          donorSegment.start,
          recipientSegment.start
        );
      }
      const recipientStart = segments[index]?.start ?? 0;
      appendEvidence(scheduleEvidence, {
        rule: 'regimen.sequence.whole-predecessor-phase',
        spans: [{
          start: edge.relation.range.start - recipientStart,
          end: edge.relation.range.end - recipientStart,
          text: source.slice(edge.relation.range.start, edge.relation.range.end)
        }],
        note: `Licensed by ${edge.relation.rule}; inherited ${fields.join(', ')} from the complete predecessor phase.`
      });
      schedule.evidence = scheduleEvidence;
      applications.push({
        rule: 'regimen.sequence.whole-predecessor-phase',
        phase: edge.to,
        sources: [...prior],
        target: index,
        fields
      });
    }
  }
  return applications;
}

/** Sequence belongs to the typed graph, before FHIR projection. */
export function regimenMemberSequences(graph: RegimenGraph): number[] {
  if (!graph.sequences.length) return [];
  const phaseSequence = graph.phases.map(() => 1);
  for (const edge of graph.sequences) {
    phaseSequence[edge.to] = Math.max(phaseSequence[edge.to], phaseSequence[edge.from] + 1);
  }
  const members: number[] = [];
  for (const phase of graph.phases) {
    for (const member of phase.members) members[member] = phaseSequence[phase.id];
  }
  return members;
}
