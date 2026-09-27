import { recognizeCycles } from './cycles';
import { quarantineSchedule } from './admissibility';
import { normalizeAnchoredBounds, normalizeClockFrequency } from './bounds';
import type { BoundaryPlan, BoundaryRelation } from './types';
import type { HpsgSigSegment } from '../../src/hpsg/segmenter';
import type { ParseResult, ParseOptions, FhirDosage, CanonicalSigClause } from '../../src/types';

type Render = (dosage: FhirDosage, style: 'short' | 'long', options?: ParseOptions) => string;
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

/** Compose a whole predecessor phase, preserving explicit values and refusing arbitrary anchor selection. */
export function composeRegimenPhases(results: ParseResult[], segments: HpsgSigSegment[], plan: BoundaryPlan,
  options: ParseOptions | undefined, render: Render): InheritanceEvidence[] {
  for (let index = 0; index < results.length; index++) {
    const invalid = recognizeCycles(segments[index]?.text ?? '', options).find(c => c.error);
    if (invalid) quarantineSchedule(results[index], segments[index].text, invalid.error!);
  }
  if (results.length < 2) return [];
  const graph = buildRegimenGraph(plan, segments), evidence: InheritanceEvidence[] = [];
  for (const edge of graph.sequences) {
    const prior = graph.phases[edge.from].members;
    const schedules = prior.map(i => results[i]?.meta.canonical.clauses[0]?.schedule);
    const endpoints = schedules.map(phaseEndExclusive);
    // All members must have an explicit finite end; an unbounded sibling prevents inference.
    const start = endpoints.length && endpoints.every((s): s is string => !!s)
      ? endpoints.reduce((latest, value) => value! > latest ? value! : latest, '') : undefined;
    const shared = schedules[0];
    const sharedAnchors = schedules.every(s => sameSet(s?.when, shared?.when) && sameSet(s?.timeOfDay, shared?.timeOfDay));
    for (const index of graph.phases[edge.to].members) {
      const item = results[index], clause = item?.meta.canonical.clauses[0], schedule = clause?.schedule;
      if (!item || !schedule || schedule.calendarEvents?.length) continue;
      if (!schedule.dayOfWeek?.length && schedule.frequency === undefined && schedule.period === undefined && !schedule.timingCode && !schedule.when?.length && !schedule.timeOfDay?.length) continue;
      if (start && schedule.boundsStart && schedule.boundsStart < start) {
        quarantineSchedule(item, segments[index].text, 'phase-start-precedes-predecessor-end');
        continue;
      }
      if (!schedule.when?.length && !schedule.timeOfDay?.length && !sharedAnchors &&
          schedules.some(s => s?.when?.length || s?.timeOfDay?.length)) {
        quarantineSchedule(item, segments[index].text, 'ambiguous-inherited-clock');
        continue;
      }
      const fields: string[] = [];
      if (!schedule.boundsStart && start) { schedule.boundsStart = start; fields.push('boundsStart'); }
      // A clock explicitly supplied by this phase overrides inherited meal/clock anchors together.
      if (!schedule.when?.length && !schedule.timeOfDay?.length && sharedAnchors) {
        if (shared?.when?.length) { schedule.when = [...shared.when]; fields.push('when'); }
        if (shared?.timeOfDay?.length) { schedule.timeOfDay = [...shared.timeOfDay]; fields.push('timeOfDay'); }
      }
      if (!fields.length) continue;
      item.fhir.timing = item.fhir.timing ?? {};
      const repeat = { ...(item.fhir.timing.repeat ?? {}) };
      if (schedule.boundsStart || schedule.boundsEnd) repeat.boundsPeriod = {
        ...(schedule.boundsStart ? { start: schedule.boundsStart } : {}),
        ...(schedule.boundsEnd ? { end: schedule.boundsEnd } : {})
      };
      if (schedule.when?.length) repeat.when = [...schedule.when];
      if (schedule.timeOfDay?.length) repeat.timeOfDay = [...schedule.timeOfDay];
      normalizeAnchoredBounds(repeat, schedule);
      normalizeClockFrequency(repeat);
      item.fhir.timing.repeat = repeat;
      item.longText = render(item.fhir, 'long', options);
      item.shortText = render(item.fhir, 'short', options);
      item.fhir.text = item.longText;
      evidence.push({ rule: 'regimen.sequence.whole-predecessor-phase', phase: edge.to, sources: [...prior], target: index, fields });
    }
  }
  return evidence;
}
