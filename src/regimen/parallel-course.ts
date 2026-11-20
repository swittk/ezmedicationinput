import { projectNativeR5Course } from "../adapters/r5-course";
import { fromDosageDetails } from '../dosage-course';
import { type FhirProjectionOptions } from '../fhir';
import { courseFromParallel } from '../canonical/compile';
import { projectFreshlyCompiledCourseToR6 } from '../adapters/canonical-course';
import { compareRegimenPositions, type CanonicalCourse, type RegimenPosition } from '../canonical/course';
import type { HpsgSigSegment } from '../hpsg/segmenter';
import type { BoundaryPlan } from '../hpsg/signature';
import { anchoredScheduleDurationEnd, type RegimenGraph } from './regimen';
import type {
  CanonicalSigClause,
  EzCourseMetadata,
  EzDosage,
  FhirR6DosageInstruction
} from '../types';

export type { RegimenPosition } from '../canonical/course';

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
  | { kind: 'unresolved'; reason: string; tracks?: CanonicalParallelTrack[] }
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
      details: FhirR6DosageInstruction;
      canonical: CanonicalCourse;
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
      schedule.durationComparator !== undefined || schedule.durationMaxComparator !== undefined ||
      schedule.duration === undefined || schedule.duration <= 0 ||
      !Number.isInteger(schedule.duration) ||
      schedule.durationIsRange && schedule.durationMax === undefined ||
      schedule.durationMax !== undefined && schedule.durationMax !== schedule.duration ||
      schedule.durationMaxUnit !== undefined && schedule.durationMaxUnit !== schedule.durationUnit) {
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


function withCalendarEnd(clause: CanonicalSigClause, boundsEnd: string): CanonicalSigClause {
  return {
    ...clause,
    schedule: { ...clause.schedule, boundsEnd }
  };
}

/** Normalize one already calendar-bound phase using its own successor.
 * Both complete and partial parallel courses retain these same known cuts. */
function calendarPhaseMembers(
  members: readonly CanonicalParallelComponent[],
  nextStarts: readonly (string | undefined)[] | undefined
): CanonicalParallelComponent[] | string {
  if (nextStarts?.some(value => !value)) return 'parallel-regimen-next-calendar-start-required';
  const nextStart = nextStarts?.reduce<string>((earliest, value) =>
    value && value < earliest ? value : earliest, nextStarts[0]!);
  const inferredEnd = nextStart ? precedingCalendarDay(nextStart) : undefined;
  const normalized: CanonicalParallelComponent[] = [];
  for (const item of members) {
    const schedule = item.clause.schedule!;
    const durationEnd = anchoredScheduleDurationEnd(schedule);
    const durationCutsEarlier = Boolean(durationEnd && schedule.boundsEnd &&
      durationEnd < schedule.boundsEnd);
    const effectiveEnd = durationCutsEarlier ? durationEnd : schedule.boundsEnd ?? inferredEnd;
    if ((nextStart && (!effectiveEnd || !orderedCalendarBounds(effectiveEnd, nextStart))) ||
        (effectiveEnd && schedule.boundsStart && orderedCalendarBounds(effectiveEnd, schedule.boundsStart)))
      return 'parallel-regimen-calendar-phase-overlap';
    normalized.push(!effectiveEnd || effectiveEnd === schedule.boundsEnd ? item : {
      ...item,
      effectiveBoundsEnd: effectiveEnd,
      boundsEndBasis: durationCutsEarlier ? 'anchored-duration' : 'next-phase-start'
    });
  }
  return normalized;
}

/** A global step owns its window, so its component keeps cadence but not the
 * source track's relative duration. This is a canonical stage, not a FHIR edit. */
function componentClause(clause: CanonicalSigClause): CanonicalSigClause {
  const schedule = clause.schedule;
  if (!schedule || schedule.duration === undefined ||
      schedule.durationComparator !== undefined || schedule.durationMaxComparator !== undefined) return clause;
  const {
    duration: _duration,
    durationMax: _durationMax,
    durationUnit: _durationUnit,
    durationMaxUnit: _durationMaxUnit,
    durationIsRange: _durationIsRange,
    ...cadence
  } = schedule;
  return { ...clause, schedule: cadence };
}

/** Keep independent phase ownership when global cuts cannot be ordered.
 * This rare fallback reuses typed phase durations; it never assigns one
 * track's uncertain completion to another track's known transition. */
function partialParallelRegimen(
  sourceTracks: readonly RegimenGraph["phases"][],
  clauses: readonly CanonicalSigClause[],
  reason: string
): Extract<CanonicalParallelRegimen, { kind: "unresolved" }> {
  const tracks: CanonicalParallelTrack[] = [];
  for (const source of sourceTracks) {
    const phases: CanonicalParallelPhase[] = [];
    let at: RegimenPosition | undefined = ZERO;
    for (let index = 0; index < source.length; index++) {
      const phase = source[index];
      let members = phase.members.map(member => ({ member, clause: clauses[member] }));
      const calendar = members.some(item => item.clause.schedule?.boundsStart || item.clause.schedule?.boundsEnd);
      if (calendar && members.every(item => item.clause.schedule?.boundsStart || item.clause.schedule?.boundsEnd)) {
        const normalized = calendarPhaseMembers(members, source[index + 1]?.members.map(member =>
          clauses[member].schedule?.boundsStart));
        if (typeof normalized !== "string") members = normalized;
      }
      const first = members[0] && durationPosition(members[0].clause);
      const exact = first && members.every(item => {
        const duration = durationPosition(item.clause);
        return duration && compareRegimenPositions(duration, first) === 0;
      });
      const end: RegimenPosition | undefined = !calendar && at && exact ? advance(at, first) : undefined;
      phases.push({ kind: calendar ? "calendar" : "relative", members,
        ...(!calendar && at ? { start: at } : {}), ...(end ? { end } : {}) });
      at = end;
    }
    tracks.push({ phases });
  }
  return { kind: "unresolved", reason, tracks };
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
        return partialParallelRegimen(trackPhases, clauses, 'parallel-regimen-mixed-track-bounds');
      }
      const phases: CanonicalParallelPhase[] = sourcePhases.map(members => ({
        kind: 'calendar',
        members
      }));
      for (let index = 0; index < phases.length; index++) {
        const normalized = calendarPhaseMembers(phases[index].members,
          phases[index + 1]?.members.map(item => item.clause.schedule?.boundsStart));
        if (typeof normalized === "string") return partialParallelRegimen(trackPhases, clauses, normalized);
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
        return partialParallelRegimen(trackPhases, clauses, 'parallel-regimen-incomplete-dose');
      }
      const durations = members.map(item => durationPosition(item.clause));
      const concrete = durations.filter(
        (duration): duration is RegimenPosition => duration !== undefined
      );
      let end: RegimenPosition | undefined;
      if (concrete.length) {
        if (concrete.length !== members.length ||
            concrete.some(value => compareRegimenPositions(value, concrete[0]) !== 0)) {
          return partialParallelRegimen(trackPhases, clauses, 'parallel-regimen-conflicting-duration');
        }
        end = advance(at, concrete[0]);
        if (!end) {
          return partialParallelRegimen(trackPhases, clauses, 'parallel-regimen-mixed-relative-duration');
        }
        boundaries.push(end);
      } else if (index + 1 < sourcePhases.length) {
        return partialParallelRegimen(trackPhases, clauses, 'parallel-regimen-missing-transition-duration');
      }
      phases.push({ kind: 'relative', members, start: at, ...(end ? { end } : {}) });
      if (end) at = end;
    }
    tracks.push({ phases });
    relativeTracks.push(phases);
  }

  const ordered: RegimenPosition[] = [];
  for (const position of boundaries) {
    if (ordered.some(existing => compareRegimenPositions(existing, position) === 0)) continue;
    let before = ordered.length;
    for (let index = 0; index < ordered.length; index++) {
      const comparison = compareRegimenPositions(position, ordered[index]);
      if (comparison === undefined) {
        return partialParallelRegimen(trackPhases, clauses, 'parallel-regimen-calendar-order-ambiguous');
      }
      if (comparison < 0) {
        before = index;
        break;
      }
    }
    ordered.splice(before, 0, position);
  }
  if (ordered.length < 2 && !calendarComponents.length) {
    return partialParallelRegimen(trackPhases, clauses, 'parallel-regimen-no-phase-cut');
  }

  const stages: CanonicalParallelStage[] = [];
  for (let index = 0; index < ordered.length; index++) {
    const start = ordered[index];
    const end = ordered[index + 1];
    const components: CanonicalParallelComponent[] = [];
    for (const phases of relativeTracks) {
      const phase = phases.find(candidate => {
        const begins = compareRegimenPositions(candidate.start!, start);
        const finishes = candidate.end ? compareRegimenPositions(start, candidate.end) : -1;
        return (begins === -1 || begins === 0) && finishes === -1;
      });
      if (phase) {
        components.push(...phase.members.map(item => ({
          ...item,
          clause: phase.end ? componentClause(item.clause) : item.clause,
          phaseOrigin: phase.start
        })));
      }
    }
    for (const calendarTrack of calendarComponents) components.push(...calendarTrack);
    if (!components.length) {
      if (index === ordered.length - 1) break;
      return partialParallelRegimen(trackPhases, clauses, 'parallel-regimen-empty-step');
    }
    stages.push({ sequence: index + 1, start, ...(end ? { end } : {}), components });
  }
  return { kind: 'resolved', tracks, stages };
}

const TREATMENT_START_CODE = 'treatment-start';
export const TREATMENT_START_SYSTEM = 'http://hl7.org/fhir/evidence-variable-event';

/** Shared pure lowering of an already-typed treatment-relative position. */
export function relativeTime(position: RegimenPosition | {
  unit: "s" | "min" | "h" | "wk" | "a"; value: number
}) {
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
  const canonical = courseFromParallel(regimen, clauseTexts, renderedInstruction);
  const details = projectFreshlyCompiledCourseToR6(canonical, options);
  // These are public interchange projections, not the course's working state.
  const { dosages, course } = projectNativeR5Course(canonical,options,true,true);
  return { kind: 'resolved', dosages, course, details, canonical };
}
