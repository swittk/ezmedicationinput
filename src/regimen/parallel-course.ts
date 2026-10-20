import { toDosageDetails, toFhirR5Dosages, DOSAGE_DETAILS_R5_URL } from '../dosage-course';
import { buildRegimenGraph } from './regimen';
import type { BoundaryPlan } from './types';
import type { HpsgSigSegment } from '../hpsg/segmenter';
import type { EzCourseMetadata, EzDosage, FhirDosage, FhirR6DosageDetails, ParseResult } from '../types';

/**
 * Positions are relative to the common treatment start. Day/week and
 * calendar-month/year intervals deliberately remain distinct: e.g., four
 * weeks and one calendar month are not generally equivalent.
 */
type Position = { unit: 'd' | 'mo'; value: number };
interface Phase {
  members: FhirDosage[];
  start: Position;
  end?: Position;
}
type ParallelProjection =
  | { kind: 'not-parallel' }
  | { kind: 'unresolved'; reason: string }
  | { kind: 'resolved'; dosages: EzDosage[]; course: EzCourseMetadata; details: FhirR6DosageDetails };

const ZERO: Position = { unit: 'd', value: 0 };
const TREATMENT_START_CODE = 'treatment-start';
export const TREATMENT_START_SYSTEM = 'http://hl7.org/fhir/evidence-variable-event';

function durationPosition(dosage: FhirDosage): Position | undefined {
  const repeat = dosage.timing?.repeat;
  if (!repeat || repeat.boundsPeriod || repeat.boundsRange || repeat.count !== undefined ||
      repeat.countMax !== undefined) return undefined;
  const bounds = repeat.boundsDuration;
  const value = bounds?.value;
  if (value === undefined || !Number.isInteger(value) || value <= 0) return undefined;
  const unit = bounds?.code ?? bounds?.unit;
  switch (unit) {
    case 'd': case 'day': case 'days': return { unit: 'd', value };
    case 'wk': case 'week': case 'weeks': return { unit: 'd', value: value * 7 };
    case 'mo': case 'month': case 'months': return { unit: 'mo', value };
    case 'a': case 'year': case 'years': return { unit: 'mo', value: value * 12 };
    default: return undefined;
  }
}

function advance(start: Position, duration: Position): Position | undefined {
  if (start.value === 0) return duration;
  if (start.unit !== duration.unit) return undefined;
  // Successive calendar months at month-end cannot safely be collapsed to a
  // single offset from treatment start due to day-of-month clamping.
  if (start.unit === 'mo') return undefined;
  return { unit: start.unit, value: start.value + duration.value };
}

function comparePositions(a: Position, b: Position): -1 | 0 | 1 | undefined {
  if (a.value === 0 && b.value === 0) return 0;
  if (a.value === 0) return -1;
  if (b.value === 0) return 1;
  if (a.unit === b.unit) return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  const aMin = a.unit === 'mo' ? a.value * 28 : a.value;
  const aMax = a.unit === 'mo' ? a.value * 31 : a.value;
  const bMin = b.unit === 'mo' ? b.value * 28 : b.value;
  const bMax = b.unit === 'mo' ? b.value * 31 : b.value;
  return aMax < bMin ? -1 : bMax < aMin ? 1 : undefined;
}

function relativeTime(position: Position) {
  return {
    contextCode: {
      coding: [{
        system: TREATMENT_START_SYSTEM,
        code: TREATMENT_START_CODE,
        display: 'Start of Treatment'
      }]
    },
    offsetDuration: {
      value: position.value, unit: position.unit,
      system: 'http://unitsofmeasure.org', code: position.unit
    }
  };
}

/** The enclosing step owns its start/end. A copied component must not retain
 * a previous duration measured from the wrong step's start. */
function dosageInStep(dosage: FhirDosage, sequence: number): EzDosage {
  const timing = dosage.timing;
  const repeat = timing?.repeat;
  const nextRepeat = repeat
    ? (({ boundsDuration: _duration, boundsPeriod: _period, ...rest }) => rest)(repeat)
    : undefined;
  return {
    ...dosage,
    sequence,
    ...(timing && repeat ? { timing: { ...timing, repeat: nextRepeat } } : {})
  };
}

/**
 * Collapse independent sequential tracks to global R6 steps. Ordinary
 * single-track tapers never come through here and keep their established
 * sequence and recurrence behavior. Unsupported relative relationships are
 * explicitly reported, never flattened into a false global sequence.
 *
 * The planner supplies the independent and sequential relations: neither
 * medication names nor body sites are inspected here.
 */
export function projectParallelRegimen(
  results: readonly ParseResult[],
  segments: readonly HpsgSigSegment[],
  plan: BoundaryPlan,
  renderedInstruction: string
): ParallelProjection {
  const independentEdges = plan.relations.filter(edge => edge.kind === 'independent');
  // The overwhelmingly common single-site regimen bypasses graph building.
  if (!independentEdges.length) return { kind: 'not-parallel' };
  const graph = buildRegimenGraph(plan, segments);
  if (!graph.sequences.length) return { kind: 'not-parallel' };
  // Planner edges refer to the ORIGINAL boundary-plan segments, whereas
  // phase.members refer to the EXPANDED sequence after meal-dash lowering.
  // The extra segments can share the same source range; a raw segment only
  // starts one independent track, regardless of its expansion multiplicity.
  const independentStarts = new Set(independentEdges.map(edge => {
    const target = plan.segments[edge.to];
    return target ? target.start + ":" + target.end : "";
  }).filter(Boolean));
  if (results.length !== segments.length || graph.phases.some(phase =>
    phase.members.some(index => !results[index]))) {
    return { kind: 'unresolved', reason: 'parallel-regimen-expansion-ambiguous' };
  }
  // Do not construct a plausible-looking timeline if part of one branch
  // remains uninterpreted. In particular, an omitted transition could
  // otherwise turn a conditional second phase into an unconditional first.
  if (results.some(item => item.meta.leftoverText?.trim())) {
    return { kind: 'unresolved', reason: 'parallel-regimen-unparsed-clause' };
  }

  const tracks: Array<typeof graph.phases> = [];
  let current: typeof graph.phases = [];
  for (const phase of graph.phases) {
    if (phase.members.some(index => {
      const source = segments[index];
      return !!source && independentStarts.has(source.start + ":" + source.end);
    }) && current.length) {
      tracks.push(current);
      current = [];
    }
    current.push(phase);
  }
  if (current.length) tracks.push(current);
  if (tracks.length < 2) return { kind: 'not-parallel' };

  const windows: Phase[][] = [];
  const boundaries: Position[] = [ZERO];

  for (const track of tracks) {
    const phases: Phase[] = [];
    let at: Position = ZERO;
    for (let index = 0; index < track.length; index++) {
      const members = track[index].members.map(i => results[i].fhir);
      if (!members.length || members.some(item => !item.timing?.repeat ||
          item.modifierExtension?.some(ext => ext.url.endsWith('/medication-unresolved-schedule')))) {
        return { kind: 'unresolved', reason: 'parallel-regimen-incomplete-dose' };
      }
      // A phase may have several simultaneous components. They must share
      // an end before a next step can be derived from a relative duration.
      const durations = members.map(durationPosition);
      const concrete = durations.filter((duration): duration is Position => duration !== undefined);
      let end: Position | undefined;
      if (concrete.length) {
        if (concrete.length !== members.length ||
            concrete.some(value => comparePositions(value, concrete[0]) !== 0)) {
          return { kind: 'unresolved', reason: 'parallel-regimen-conflicting-duration' };
        }
        end = advance(at, concrete[0]);
        if (!end) return { kind: 'unresolved', reason: 'parallel-regimen-mixed-relative-duration' };
        boundaries.push(end);
      } else if (index + 1 < track.length) {
        return { kind: 'unresolved', reason: 'parallel-regimen-missing-transition-duration' };
      }
      phases.push({ members, start: at, ...(end ? { end } : {}) });
      if (end) at = end;
    }
    windows.push(phases);
  }

  // Sort only if ordering is independent of the eventual treatment start
  // date (the length of a month varies). Equal comparable cuts are merged.
  const ordered: Position[] = [];
  for (const position of boundaries) {
    if (ordered.some(existing => comparePositions(existing, position) === 0)) continue;
    let before = ordered.length;
    for (let index = 0; index < ordered.length; index++) {
      const cmp = comparePositions(position, ordered[index]);
      if (cmp === undefined) return { kind: 'unresolved', reason: 'parallel-regimen-calendar-order-ambiguous' };
      if (cmp < 0) { before = index; break; }
    }
    ordered.splice(before, 0, position);
  }
  if (ordered.length < 2) return { kind: 'unresolved', reason: 'parallel-regimen-no-phase-cut' };

  const dosages: EzDosage[] = [];
  const stepMetadata: NonNullable<EzCourseMetadata['step']> = [];
  for (let index = 0; index < ordered.length; index++) {
    const start = ordered[index];
    const end = ordered[index + 1];
    const members: FhirDosage[] = [];
    for (const phases of windows) {
      const phase = phases.find(value =>
        (comparePositions(value.start, start) === -1 || comparePositions(value.start, start) === 0) &&
        (!value.end || comparePositions(start, value.end) === -1)
      );
      if (phase) members.push(...phase.members);
    }
    if (!members.length) {
      // If every track has terminated at the final cut, the entire course
      // ends there. A gap *before* another cut remains unresolved; never
      // manufacture an administration merely to fill a timetable slot.
      if (index === ordered.length - 1) break;
      return { kind: 'unresolved', reason: 'parallel-regimen-empty-step' };
    }
    for (const item of members) dosages.push(dosageInStep(item, index + 1));
    stepMetadata.push({
      sequence: index + 1,
      ...(index ? { start: relativeTime(start) } : {}),
      ...(end ? { end: relativeTime(end) } : {})
    });
  }

  const course: EzCourseMetadata = {
    renderedInstruction,
    step: stepMetadata
  };
  const details = toDosageDetails(dosages, renderedInstruction, course);

  // Preserve the entire relative course when a caller serializes ONLY the
  // flat R5-style array. That modifier prevents old R5 schedulers from
  // treating copied global components as unconditional simultaneous doses.
  const marker = toFhirR5Dosages(details)[0]?.modifierExtension?.find(
    extension => extension.url === DOSAGE_DETAILS_R5_URL
  );
  if (marker && dosages[0]) {
    dosages[0].modifierExtension = [...(dosages[0].modifierExtension ?? []), marker];
  }
  return { kind: 'resolved', dosages, course, details };
}
