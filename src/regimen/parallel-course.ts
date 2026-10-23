import {
  DOSAGE_DETAILS_R5_URL,
  PARALLEL_COMPONENT_PHASE_ORIGIN_URL,
  toDosageDetails,
  toFhirR5Dosages
} from '../dosage-course';
import { canonicalToFhir, type FhirProjectionOptions } from '../fhir';
import type { HpsgSigSegment } from '../hpsg/segmenter';
import type { BoundaryPlan } from './types';
import { anchoredScheduleDurationEnd, type RegimenGraph } from './regimen';
import type {
  CanonicalSigClause,
  EzCourseMetadata,
  EzDosage,
  FhirR6DosageDetails
} from '../types';

/** Treatment-relative positions retain calendar months as a distinct unit. */
export interface RegimenPosition { unit: 'd' | 'mo'; value: number }

export interface CanonicalParallelComponent {
  member: number;
  clause: CanonicalSigClause;
  /** Stage-local inclusive end without replacing explicit source semantics. */
  effectiveBoundsEnd?: string;
  boundsEndBasis?: 'next-phase-start' | 'anchored-duration';
  /** Original track-phase origin retained when copied across global steps. */
  phaseOrigin?: RegimenPosition;
}

export interface CanonicalParallelPhase {
  kind: 'relative' | 'calendar';
  members: CanonicalParallelComponent[];
  start?: RegimenPosition;
  end?: RegimenPosition;
}

export interface CanonicalParallelTrack {
  phases: CanonicalParallelPhase[];
}

export interface CanonicalParallelStage {
  sequence: number;
  start: RegimenPosition;
  end?: RegimenPosition;
  components: CanonicalParallelComponent[];
}

export type CanonicalParallelRegimen =
  | { kind: 'not-parallel' }
  | { kind: 'unresolved'; reason: string }
  | {
      kind: 'resolved';
      tracks: CanonicalParallelTrack[];
      stages: CanonicalParallelStage[];
    };

type ParallelProjection =
  | { kind: 'not-parallel' }
  | { kind: 'unresolved'; reason: string }
  | {
      kind: 'resolved';
      dosages: EzDosage[];
      course: EzCourseMetadata;
      details: FhirR6DosageDetails;
    };

const ZERO: RegimenPosition = { unit: 'd', value: 0 };

/** Calendar tracks use explicit dates; not offsets from treatment start. */
function precedingCalendarDay(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    return undefined;
  }
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** Dates without times are inclusive local calendar days, never UTC timestamps. */
function orderedCalendarBounds(earlier: string, later: string): boolean {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/u;
  if (dateOnly.test(earlier) && dateOnly.test(later)) return earlier < later;
  if (dateOnly.test(earlier) || dateOnly.test(later)) return false;
  const left = Date.parse(earlier);
  const right = Date.parse(later);
  return Number.isFinite(left) && Number.isFinite(right) && left < right;
}

function durationPosition(clause: CanonicalSigClause): RegimenPosition | undefined {
  const schedule = clause.schedule;
  if (!schedule || schedule.boundsStart || schedule.boundsEnd ||
      schedule.count !== undefined || schedule.countMax !== undefined ||
      schedule.duration === undefined || schedule.duration <= 0 ||
      !Number.isInteger(schedule.duration) ||
      schedule.durationMax !== undefined && schedule.durationMax !== schedule.duration) {
    return undefined;
  }
  switch (schedule.durationUnit) {
    case 'd': return { unit: 'd', value: schedule.duration };
    case 'wk': return { unit: 'd', value: schedule.duration * 7 };
    case 'mo': return { unit: 'mo', value: schedule.duration };
    case 'a': return { unit: 'mo', value: schedule.duration * 12 };
    default: return undefined;
  }
}

function hasRepeatSchedule(clause: CanonicalSigClause): boolean {
  const schedule = clause.schedule;
  return Boolean(schedule && (
    schedule.boundsStart || schedule.boundsEnd ||
    schedule.count !== undefined || schedule.countMax !== undefined ||
    schedule.duration !== undefined || schedule.frequency !== undefined ||
    schedule.frequencyMax !== undefined || schedule.period !== undefined ||
    schedule.periodMax !== undefined || schedule.offset !== undefined ||
    schedule.dayOfWeek?.length || schedule.when?.length || schedule.timeOfDay?.length
  ));
}

function advance(start: RegimenPosition, duration: RegimenPosition): RegimenPosition | undefined {
  if (start.value === 0) return duration;
  if (start.unit !== duration.unit) return undefined;
  // Repeated month-end phases cannot be collapsed to one treatment-relative
  // offset without knowing the eventual treatment anchor.
  if (start.unit === 'mo') return undefined;
  return { unit: start.unit, value: start.value + duration.value };
}

function comparePositions(
  left: RegimenPosition,
  right: RegimenPosition
): -1 | 0 | 1 | undefined {
  if (left.value === 0 && right.value === 0) return 0;
  if (left.value === 0) return -1;
  if (right.value === 0) return 1;
  if (left.unit === right.unit) {
    return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
  }
  const leftMin = left.unit === 'mo' ? left.value * 28 : left.value;
  const leftMax = left.unit === 'mo' ? left.value * 31 : left.value;
  const rightMin = right.unit === 'mo' ? right.value * 28 : right.value;
  const rightMax = right.unit === 'mo' ? right.value * 31 : right.value;
  return leftMax < rightMin ? -1 : rightMax < leftMin ? 1 : undefined;
}

function withCalendarEnd(clause: CanonicalSigClause, boundsEnd: string): CanonicalSigClause {
  return {
    ...clause,
    schedule: { ...clause.schedule, boundsEnd }
  };
}

/** A global step owns its window, so its component keeps cadence but not the
 * source track's relative duration. This is a canonical stage, not a FHIR edit. */
function componentClause(clause: CanonicalSigClause): CanonicalSigClause {
  const schedule = clause.schedule;
  if (!schedule || schedule.duration === undefined) return clause;
  const {
    duration: _duration,
    durationMax: _durationMax,
    durationUnit: _durationUnit,
    ...cadence
  } = schedule;
  return { ...clause, schedule: cadence };
}

/**
 * Build independent track windows and canonical global stages from typed HPSG
 * clauses and licensed regimen relations. No FHIR object or source text is
 * inspected. Unsupported relationships remain editable through ordinary
 * per-clause results while this richer course projection stays unresolved.
 */
export function buildCanonicalParallelRegimen(
  clauses: readonly CanonicalSigClause[],
  segments: readonly HpsgSigSegment[],
  plan: BoundaryPlan,
  graph: RegimenGraph
): CanonicalParallelRegimen {
  const independentEdges = plan.relations.filter(edge => edge.kind === 'independent');
  if (!independentEdges.length || !graph.sequences.length) return { kind: 'not-parallel' };

  const independentStarts = new Set(independentEdges.map(edge => {
    const target = plan.segments[edge.to];
    return target ? `${target.start}:${target.end}` : '';
  }).filter(Boolean));
  if (clauses.length !== segments.length || graph.phases.some(phase =>
    phase.members.some(member => !clauses[member]))) {
    return { kind: 'unresolved', reason: 'parallel-regimen-expansion-ambiguous' };
  }

  const trackPhases: Array<typeof graph.phases> = [];
  let current: typeof graph.phases = [];
  for (const phase of graph.phases) {
    if (phase.members.some(member => {
      const source = segments[member];
      return Boolean(source && independentStarts.has(`${source.start}:${source.end}`));
    }) && current.length) {
      trackPhases.push(current);
      current = [];
    }
    current.push(phase);
  }
  if (current.length) trackPhases.push(current);
  if (trackPhases.length < 2) return { kind: 'not-parallel' };

  const tracks: CanonicalParallelTrack[] = [];
  const relativeTracks: CanonicalParallelPhase[][] = [];
  const calendarComponents: CanonicalParallelComponent[][] = [];
  const boundaries: RegimenPosition[] = [ZERO];

  for (const track of trackPhases) {
    const sourcePhases = track.map(phase => phase.members.map(member => ({
      member,
      clause: clauses[member]
    })));
    const allMembers: CanonicalParallelComponent[] = [];
    for (const members of sourcePhases) allMembers.push(...members);
    const calendarBounded = allMembers.some(item => Boolean(
      item.clause.schedule?.boundsStart || item.clause.schedule?.boundsEnd
    ));

    if (calendarBounded) {
      if (allMembers.some(item =>
        !item.clause.schedule ||
        !(item.clause.schedule.boundsStart || item.clause.schedule.boundsEnd) ||
        item.clause.schedule.duration !== undefined && !item.clause.schedule.boundsEnd)) {
        return { kind: 'unresolved', reason: 'parallel-regimen-mixed-track-bounds' };
      }
      const phases: CanonicalParallelPhase[] = sourcePhases.map(members => ({
        kind: 'calendar',
        members
      }));
      for (let index = 0; index < phases.length; index++) {
        const nextStarts = phases[index + 1]?.members.map(item =>
          item.clause.schedule?.boundsStart);
        if (nextStarts?.some(value => !value)) {
          return { kind: 'unresolved', reason: 'parallel-regimen-next-calendar-start-required' };
        }
        const nextStart = nextStarts?.reduce<string>((earliest, value) =>
          value && value < earliest ? value : earliest, nextStarts[0]!);
        const inferredEnd = nextStart ? precedingCalendarDay(nextStart) : undefined;
        const normalized: CanonicalParallelComponent[] = [];
        for (const item of phases[index].members) {
          const schedule = item.clause.schedule!;
          const durationEnd = anchoredScheduleDurationEnd(schedule);
          const durationCutsEarlier = Boolean(durationEnd && schedule.boundsEnd &&
            durationEnd < schedule.boundsEnd);
          const effectiveEnd = durationCutsEarlier
            ? durationEnd
            : schedule.boundsEnd ?? inferredEnd;
          if ((nextStart && (!effectiveEnd || !orderedCalendarBounds(effectiveEnd, nextStart))) ||
              (effectiveEnd && schedule.boundsStart &&
              orderedCalendarBounds(effectiveEnd, schedule.boundsStart))) {
            return { kind: 'unresolved', reason: 'parallel-regimen-calendar-phase-overlap' };
          }
          normalized.push(!effectiveEnd || effectiveEnd === schedule.boundsEnd ? item : {
            ...item,
            effectiveBoundsEnd: effectiveEnd,
            boundsEndBasis: durationCutsEarlier ? 'anchored-duration' : 'next-phase-start'
          });
        }
        phases[index] = { ...phases[index], members: normalized };
      }
      tracks.push({ phases });
      const projectedCalendar: CanonicalParallelComponent[] = [];
      for (const phase of phases) {
        for (const item of phase.members) {
          projectedCalendar.push(item.effectiveBoundsEnd ? {
            ...item,
            clause: withCalendarEnd(item.clause, item.effectiveBoundsEnd)
          } : item);
        }
      }
      calendarComponents.push(projectedCalendar);
      continue;
    }

    const phases: CanonicalParallelPhase[] = [];
    let at = ZERO;
    for (let index = 0; index < sourcePhases.length; index++) {
      const members = sourcePhases[index];
      if (!members.length || members.some(item => !hasRepeatSchedule(item.clause))) {
        return { kind: 'unresolved', reason: 'parallel-regimen-incomplete-dose' };
      }
      const durations = members.map(item => durationPosition(item.clause));
      const concrete = durations.filter(
        (duration): duration is RegimenPosition => duration !== undefined
      );
      let end: RegimenPosition | undefined;
      if (concrete.length) {
        if (concrete.length !== members.length ||
            concrete.some(value => comparePositions(value, concrete[0]) !== 0)) {
          return { kind: 'unresolved', reason: 'parallel-regimen-conflicting-duration' };
        }
        end = advance(at, concrete[0]);
        if (!end) {
          return { kind: 'unresolved', reason: 'parallel-regimen-mixed-relative-duration' };
        }
        boundaries.push(end);
      } else if (index + 1 < sourcePhases.length) {
        return { kind: 'unresolved', reason: 'parallel-regimen-missing-transition-duration' };
      }
      phases.push({ kind: 'relative', members, start: at, ...(end ? { end } : {}) });
      if (end) at = end;
    }
    tracks.push({ phases });
    relativeTracks.push(phases);
  }

  const ordered: RegimenPosition[] = [];
  for (const position of boundaries) {
    if (ordered.some(existing => comparePositions(existing, position) === 0)) continue;
    let before = ordered.length;
    for (let index = 0; index < ordered.length; index++) {
      const comparison = comparePositions(position, ordered[index]);
      if (comparison === undefined) {
        return { kind: 'unresolved', reason: 'parallel-regimen-calendar-order-ambiguous' };
      }
      if (comparison < 0) {
        before = index;
        break;
      }
    }
    ordered.splice(before, 0, position);
  }
  if (ordered.length < 2 && !calendarComponents.length) {
    return { kind: 'unresolved', reason: 'parallel-regimen-no-phase-cut' };
  }

  const stages: CanonicalParallelStage[] = [];
  for (let index = 0; index < ordered.length; index++) {
    const start = ordered[index];
    const end = ordered[index + 1];
    const components: CanonicalParallelComponent[] = [];
    for (const phases of relativeTracks) {
      const phase = phases.find(candidate => {
        const begins = comparePositions(candidate.start!, start);
        const finishes = candidate.end ? comparePositions(start, candidate.end) : -1;
        return (begins === -1 || begins === 0) && finishes === -1;
      });
      if (phase) {
        components.push(...phase.members.map(item => ({
          ...item,
          clause: componentClause(item.clause),
          phaseOrigin: phase.start
        })));
      }
    }
    for (const calendarTrack of calendarComponents) components.push(...calendarTrack);
    if (!components.length) {
      if (index === ordered.length - 1) break;
      return { kind: 'unresolved', reason: 'parallel-regimen-empty-step' };
    }
    stages.push({ sequence: index + 1, start, ...(end ? { end } : {}), components });
  }
  return { kind: 'resolved', tracks, stages };
}

const TREATMENT_START_CODE = 'treatment-start';
export const TREATMENT_START_SYSTEM = 'http://hl7.org/fhir/evidence-variable-event';

function relativeTime(position: RegimenPosition) {
  return {
    contextCode: {
      coding: [{
        system: TREATMENT_START_SYSTEM,
        code: TREATMENT_START_CODE,
        display: 'Start of Treatment'
      }]
    },
    offsetDuration: {
      value: position.value,
      unit: position.unit,
      system: 'http://unitsofmeasure.org',
      code: position.unit
    }
  };
}

/** Pure one-way serialization of an already composed canonical course. */
export function projectParallelRegimen(
  regimen: CanonicalParallelRegimen,
  clauseTexts: readonly (string | undefined)[],
  renderedInstruction: string,
  options?: FhirProjectionOptions
): ParallelProjection {
  if (regimen.kind !== 'resolved') return regimen;
  const dosages: EzDosage[] = [];
  const stepMetadata: NonNullable<EzCourseMetadata['step']> = [];
  for (const stage of regimen.stages) {
    for (const component of stage.components) {
      const projected = canonicalToFhir(
        component.clause,
        clauseTexts[component.member],
        { ...options, sequence: stage.sequence }
      ) as EzDosage;
      const phaseOrigin = component.phaseOrigin;
      dosages.push(phaseOrigin ? {
        ...projected,
        modifierExtension: [
          ...(projected.modifierExtension ?? []).filter(extension =>
            extension.url !== PARALLEL_COMPONENT_PHASE_ORIGIN_URL),
          {
            url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL,
            valueQuantity: {
              value: phaseOrigin.value,
              unit: phaseOrigin.unit,
              system: 'http://unitsofmeasure.org',
              code: phaseOrigin.unit
            }
          }
        ]
      } : projected);
    }
    stepMetadata.push({
      sequence: stage.sequence,
      ...(stage.sequence > 1 ? { start: relativeTime(stage.start) } : {}),
      ...(stage.end ? { end: relativeTime(stage.end) } : {})
    });
  }

  const course: EzCourseMetadata = { renderedInstruction, step: stepMetadata };
  const details = toDosageDetails(dosages, renderedInstruction, course);
  const marker = toFhirR5Dosages(details)[0]?.modifierExtension?.find(
    extension => extension.url === DOSAGE_DETAILS_R5_URL
  );
  if (marker) {
    for (const dosage of dosages) {
      dosage.modifierExtension = [
        ...(dosage.modifierExtension ?? []).filter(extension =>
          extension.url !== DOSAGE_DETAILS_R5_URL),
        marker
      ];
    }
  }
  return { kind: 'resolved', dosages, course, details };
}
