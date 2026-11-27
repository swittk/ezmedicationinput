import { precedingCalendarDay, orderedCalendarBounds } from '../canonical/compile';
import { earliestCalendarOpening, compareRegimenPositions, type CanonicalBoundary, type RegimenPosition } from '../canonical/course';
import type { HpsgSigSegment } from '../hpsg/segmenter';
import type { BoundaryPlan } from '../hpsg/signature';
import { anchoredScheduleDurationEnd, hasExactScheduleDuration, type RegimenGraph } from './regimen';
import type { CanonicalSigClause } from '../types';

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
  /** Origin of the known relative start; absent retains elapsed semantics. */
  startReference?: "treatment-day-start";
  end?: RegimenPosition;
  /** A known same-track successor caps this phase without replacing its own end. */
  phaseEnd?: CanonicalBoundary;
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

const ZERO: RegimenPosition = { unit: 'd', value: 0 };

function durationPosition(clause: CanonicalSigClause): RegimenPosition | undefined {
  const schedule = clause.schedule;
  // A delayed duration starts at its resolved administration origin.
  if (!hasExactScheduleDuration(schedule) || schedule.boundsStart || schedule.boundsEnd ||
      schedule.count !== undefined || schedule.countMax !== undefined ||
      !!schedule.administrationOffsetMinutes || schedule.duration <= 0 || !Number.isInteger(schedule.duration) ||
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


/** A source date list supplies a known calendar onset without replacing its
 * explicit events. An authored start bound retains its existing ownership. */
function calendarPhaseStart(clause: CanonicalSigClause): string | undefined {
  const schedule = clause.schedule;
  if (schedule?.boundsStart) return schedule.boundsStart;
  let earliest: string | undefined;
  for (const event of schedule?.calendarEvents ?? [])
    if (earliest === undefined || event.isoDate < earliest) earliest = event.isoDate;
  return earliest;
}

/** Normalize one already calendar-bound phase using its own successor.
 * Both complete and partial parallel courses retain these same known cuts. */
function calendarPhaseMembers(
  members: readonly CanonicalParallelComponent[],
  nextClauses: readonly CanonicalSigClause[] | undefined
): CanonicalParallelComponent[] | string {
  const opening = earliestCalendarOpening((nextClauses ?? []).map(clause => ({
    kind: "administration", asNeeded: clause.prn?.enabled,
    predicate: clause.clinicalAdjuncts?.condition,
    calendarPredicate: clause.clinicalAdjuncts?.calendarDayCondition,
    schedule: {
      recurrence: { calendarWindow: { start: clause.schedule?.boundsStart },
        clocks: clause.schedule?.timeOfDay, anchors: clause.schedule?.when },
      explicitEvents: clause.schedule?.calendarEvents?.map(event => event.fhirDateTime ?? event.isoDate),
    },
  })));
  const nextStart = opening?.start;
  if (nextClauses?.length && !nextStart) return 'parallel-regimen-next-calendar-start-required';
  const inferredEnd = opening && !opening.clocked ? precedingCalendarDay(opening.start) : undefined;
  const normalized: CanonicalParallelComponent[] = [];
  for (const item of members) {
    const schedule = item.clause.schedule;
    if (!schedule) {
      normalized.push(item);
      continue;
    }
    const durationEnd = anchoredScheduleDurationEnd(schedule);
    const durationCutsEarlier = Boolean(durationEnd && schedule.boundsEnd &&
      durationEnd < schedule.boundsEnd);
    // An authored date list keeps its events. Recurrences stop before their
    // replacement starts, including when their authored duration ends later.
    const explicitEvents = Boolean(schedule.calendarEvents?.length);
    const authoredEnd = durationCutsEarlier ? durationEnd : schedule.boundsEnd;
    const nextPhaseCutsEarlier = !explicitEvents && inferredEnd &&
      (!authoredEnd || orderedCalendarBounds(inferredEnd, authoredEnd));
    const effectiveEnd = nextPhaseCutsEarlier ? inferredEnd : authoredEnd;
    if ((nextStart && (effectiveEnd ? !orderedCalendarBounds(effectiveEnd, nextStart) : !explicitEvents)) ||
        (effectiveEnd && schedule.boundsStart && orderedCalendarBounds(effectiveEnd, schedule.boundsStart)))
      return 'parallel-regimen-calendar-phase-overlap';
    normalized.push(!effectiveEnd || effectiveEnd === schedule.boundsEnd ? item : {
      ...item,
      effectiveBoundsEnd: effectiveEnd,
      boundsEndBasis: nextPhaseCutsEarlier ? 'next-phase-start' : 'anchored-duration'
    });
  }
  return normalized;
}

/** A phase's authored treatment onset owns its origin; an exact prior end is
 * only the default when this phase omits an onset. Coordinated members must
 * agree before one origin can represent their complete phase. Null marks
 * conflicting authored onsets; undefined means no onset was supplied. */
function authoredPhaseStart(members: readonly CanonicalParallelComponent[]): RegimenPosition | null | undefined {
  let value: number | undefined, missing = false;
  for (const member of members) {
    const schedule = member.clause.schedule;
    const onset = schedule?.treatmentStartOffsetDays;
    if (onset === undefined || schedule?.phaseStartReference === "previous-phase-next-day") {
      missing = true;
      continue;
    }
    if (value !== undefined && value !== onset) return null;
    value = onset;
  }
  return value === undefined ? undefined : missing ? null : { unit: 'd', value };
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
    let atReference: CanonicalParallelPhase["startReference"];
    for (let index = 0; index < source.length; index++) {
      const phase = source[index];
      let hasAuthoredDayStart = false, hasAuthoredElapsedStart = false, hasDependentStart = false;
      let members = phase.members.map(member => {
        const clause = clauses[member], schedule = clause.schedule;
        if (schedule?.phaseStartReference === "previous-phase-next-day") hasDependentStart = true;
        else if (schedule?.treatmentStartOffsetDays !== undefined) {
          if (schedule.phaseStartReference === "treatment-day-start") hasAuthoredDayStart = true;
          else hasAuthoredElapsedStart = true;
        }
        return { member, clause };
      });
      const calendar = members.some(item => item.clause.schedule?.boundsStart || item.clause.schedule?.boundsEnd ||
        item.clause.schedule?.calendarEvents?.length);
      if (calendar) {
        const normalized = calendarPhaseMembers(members, source[index + 1]?.members.map(member => clauses[member]));
        if (typeof normalized !== "string") members = normalized;
      }
      // A dated successor also closes an undated predecessor on this track.
      // Retain its relative origin and authored duration; only the execution
      // end is inferred, using the same calendar cutoff as dated predecessors.
      if (calendar && index > 0 && phases[index - 1].kind === "relative") {
        const previous = phases[index - 1];
        const normalized = calendarPhaseMembers(previous.members, members.map(item => item.clause));
        if (typeof normalized !== "string") previous.members = normalized;
      }
      const first = members[0] && durationPosition(members[0].clause);
      const exact = first && members.every(item => {
        const duration = durationPosition(item.clause);
        return duration && compareRegimenPositions(duration, first) === 0;
      });
      // A pause after a predecessor has no fixed treatment origin. It cannot
      // supply an absolute end for this phase or its unanchored successor.
      const authoredStart = hasDependentStart ? undefined : authoredPhaseStart(members);
      const hasAuthoredStart = hasAuthoredDayStart || hasAuthoredElapsedStart || hasDependentStart;
      // Mixed member onsets do not become a shared phase origin. The known
      // track origin still supplies the default for an unanchored member;
      // independently authored onsets remain on their own administrations.
      const start: RegimenPosition | undefined = calendar ? undefined
        : authoredStart ?? (hasAuthoredStart && authoredStart !== null ? undefined : at);
      const startReference = authoredStart
        ? hasAuthoredDayStart && !hasAuthoredElapsedStart ? "treatment-day-start" : undefined
        : hasAuthoredStart && authoredStart !== null ? undefined : atReference;
      const end: RegimenPosition | undefined = start && exact && authoredStart !== null &&
        !(hasAuthoredDayStart && hasAuthoredElapsedStart) ? advance(start, first) : undefined;
      const planned: CanonicalParallelPhase = { kind: calendar ? "calendar" : "relative", members,
        ...(start ? { start } : {}), ...(end ? { end } : {}) };
      if (start && startReference) planned.startReference = startReference;
      // A known successor replaces the old cadence even when its predecessor
      // has no duration. Keep the authored end separately: it can leave a gap.
      // Mixed or dependent origins cannot supply a concrete treatment cutoff.
      if (index > 0 && start && authoredStart !== null && !hasDependentStart &&
          !(hasAuthoredDayStart && hasAuthoredElapsedStart))
        phases[index - 1].phaseEnd = {
          anchor: startReference ?? "treatment-start",
          displacement: { value: start.value, unit: start.unit, code: start.unit, system: "http://unitsofmeasure.org" }
        };
      phases.push(planned);
      at = end;
      atReference = end ? startReference : undefined;
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
    let calendarBounded = false;
    for (const members of sourcePhases) {
      for (const item of members) {
        // Civil days and predecessor-dependent onsets cannot share elapsed
        // global cuts. Keep each member's typed origin in its own track.
        if (item.clause.schedule?.phaseStartReference)
          return partialParallelRegimen(trackPhases, clauses, "parallel-regimen-local-day-origin");
        allMembers.push(item);
        calendarBounded ||= Boolean(item.clause.schedule?.boundsStart || item.clause.schedule?.boundsEnd ||
          item.clause.schedule?.calendarEvents?.length);
      }
    }

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
          phases[index + 1]?.members.map(item => item.clause));
        if (typeof normalized === "string") return partialParallelRegimen(trackPhases, clauses, normalized);
        phases[index] = { ...phases[index], members: normalized };
      }
      tracks.push({ phases });
      const projectedCalendar: CanonicalParallelComponent[] = [];
      for (const phase of phases) {
        for (const item of phase.members) {
          projectedCalendar.push(item);
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
      const authoredStart = authoredPhaseStart(members);
      if (authoredStart === null)
        return partialParallelRegimen(trackPhases, clauses, 'parallel-regimen-conflicting-onsets');
      if (authoredStart) {
        if (phases.length && compareRegimenPositions(phases[phases.length - 1].start!, authoredStart) !== -1)
          return partialParallelRegimen(trackPhases, clauses, 'parallel-regimen-non-increasing-onsets');
        at = authoredStart;
        boundaries.push(at);
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
      const phase = phases.find((candidate, phaseIndex) => {
        const begins = compareRegimenPositions(candidate.start!, start);
        const finishes = candidate.end ? compareRegimenPositions(start, candidate.end) : -1;
        // A licensed same-track successor replaces execution eligibility.
        // Keep the authored end separate so an earlier end still leaves a gap.
        const nextStart = phases[phaseIndex + 1]?.start;
        const beforeSuccessor = !nextStart || compareRegimenPositions(start, nextStart) === -1;
        return (begins === -1 || begins === 0) && finishes === -1 && beforeSuccessor;
      });
      if (phase) {
        components.push(...phase.members.map(item => ({
          ...item,
          // Retain the authored course length; its own phase origin prevents
          // an unrelated global step cut from restarting that duration.
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
