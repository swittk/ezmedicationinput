import { DOSE_TARGET_EVENT_MEMBERS, DOSE_TARGET_DAYPART_CLOCK_RANGES, NEXT_DAY_SCHEDULE_RULE } from "../hpsg/lexical-classes";
import { terminalAdministrationDelay } from "./grammar";
import { EventTiming as SequenceEventTiming, FhirPeriodUnit } from '../types';
import { equalStructuredValues, cloneStructuredValue } from '../stable-structure';
import type { BoundaryPlan, BoundaryRelation } from '../hpsg/signature';
import type { HpsgSigSegment } from '../hpsg/segmenter';
import { ParserState } from '../parser-state';
import type {
  CanonicalEvidence,
  CanonicalSigClause,
  CanonicalSourceSpan,
  FhirQuantity
} from '../types';

export interface RegimenPhase {
  id: number;
  members: number[];
  /** Cycle agreed by every typed administration member in this phase. */
  repeatCycle?: FhirQuantity;
  repeatCount?: number;
}
export interface PhaseEdge { from: number; to: number; relation: BoundaryRelation }
export interface RegimenGraph {
  /** Per-administration dependencies within a repeating phase. */
  administrationDependencies?: Array<{ from: number; to: number; delayMinutes: number }>;
  phases: RegimenPhase[];
  sequences: PhaseEdge[];
  /** Whole-course interval contributed by a typed recurring cycle sign. */
  repeatCycle?: FhirQuantity;
  /** Explicit finite number of whole-course repetitions. */
  repeatCount?: number;
}
export interface InheritanceEvidence { rule: string; phase: number; sources: number[]; target: number; fields: string[] }

/** Retain coordination as a group; sequence and independent delimiters start new groups. */
export function buildRegimenGraph(
  plan: BoundaryPlan,
  segments: readonly HpsgSigSegment[],
  states?: readonly ParserState[]
): RegimenGraph {
  const phases: RegimenPhase[] = [], sequences: PhaseEdge[] = [];
  const administrationDependencies: NonNullable<RegimenGraph["administrationDependencies"]> = [];
  let original = 0;
  for (let index = 0; index < segments.length; index++) {
    while (original + 1 < plan.segments.length && segments[index].start >= plan.segments[original + 1].start) original++;
    const sameSource = index > 0 && segments[index].start === segments[index - 1].start;
    const incoming = sameSource ? undefined : plan.relations.find(e => e.to === original);
    if (incoming?.semanticLicense === "delayed-target" && index > 0) {
      const donor = states?.[index - 1]?.primaryClause;
      const delayMinutes = donor ? terminalAdministrationDelay(donor) : undefined;
      if (delayMinutes !== undefined) administrationDependencies.push({ from: index - 1, to: index, delayMinutes });
    }
    if (!phases.length || incoming && (incoming.kind === 'sequence' || incoming.kind === 'independent')) {
      const id = phases.length;
      phases.push({ id, members: [] });
      if (incoming?.kind === 'sequence' && id > 0) sequences.push({ from: id - 1, to: id, relation: incoming });
    }
    phases[phases.length - 1].members.push(index);
  }
  for (const phase of phases) {
    const firstSchedule = states?.[phase.members[0]]?.primaryClause.schedule;
    const firstCycle = firstSchedule?.repeatCycle;
    if (!firstCycle || !phase.members.every(member => {
      const schedule = states?.[member]?.primaryClause.schedule;
      const candidate = schedule?.repeatCycle;
      return Boolean(candidate &&
        candidate.value === firstCycle.value &&
        candidate.comparator === firstCycle.comparator &&
        candidate.unit === firstCycle.unit &&
        candidate.system === firstCycle.system &&
        candidate.code === firstCycle.code &&
        schedule?.repeatCount === firstSchedule.repeatCount);
    })) continue;
    phase.repeatCycle = { ...firstCycle };
    phase.repeatCount = firstSchedule.repeatCount;
  }
  const wholeCourseCycle = phases.length === 1 ? phases[0].repeatCycle : undefined;
  return {
    phases,
    sequences,
    administrationDependencies: administrationDependencies.length ? administrationDependencies : undefined,
    ...(wholeCourseCycle
      ? {
        repeatCycle: { ...wholeCourseCycle },
        ...(phases[0].repeatCount !== undefined ? { repeatCount: phases[0].repeatCount } : {})
      }
      : {})
  };
}

function advanceDate(value: string, days = 1): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return undefined;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * A date-anchored whole-day or calendar-month duration has one inclusive window.
 * Materialize that window on the typed schedule before FHIR projection so the
 * wire layer never has to choose between boundsPeriod and boundsDuration.
 */
export function anchoredScheduleDurationEnd(
  schedule: CanonicalSigClause['schedule']
): string | undefined {
  if (!schedule?.boundsStart || schedule.duration === undefined ||
      schedule.durationComparator || schedule.durationMaxComparator ||
      schedule.durationIsRange && schedule.durationMax === undefined ||
      schedule.durationMax !== undefined && (schedule.durationMax !== schedule.duration ||
        schedule.durationMaxUnit && schedule.durationMaxUnit !== schedule.durationUnit)) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(schedule.boundsStart) || schedule.duration <= 0) {
    return undefined;
  }
  const date = new Date(`${schedule.boundsStart}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return undefined;
  const months = schedule.durationUnit === 'mo' ? schedule.duration :
    schedule.durationUnit === 'a' ? schedule.duration * 12 : undefined;
  if (months !== undefined) {
    if (!Number.isInteger(months)) return undefined;
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    // Clamp the exclusive anniversary before converting it to an inclusive day.
    date.setUTCDate(Math.min(day, lastDay) - 1);
  } else {
    const factor = schedule.durationUnit === 'd' ? 1 : schedule.durationUnit === 'wk' ? 7 : undefined;
    if (factor === undefined || !Number.isInteger(schedule.duration * factor)) return undefined;
    date.setUTCDate(date.getUTCDate() + schedule.duration * factor - 1);
  }
  return date.toISOString().slice(0, 10);
}

function materializeAnchoredScheduleWindow(schedule: CanonicalSigClause['schedule']): void {
  if (!schedule || schedule.boundsEnd) return;
  const durationEnd = anchoredScheduleDurationEnd(schedule);
  if (durationEnd) schedule.boundsEnd = durationEnd;
}
/** An exact fixed-day phase can establish a later relative origin. */
function exactPhaseDurationDays(schedule: CanonicalSigClause["schedule"]): number | undefined {
  if (!schedule || schedule.duration === undefined || schedule.durationComparator ||
      schedule.durationMaxComparator || schedule.durationIsRange && schedule.durationMax === undefined ||
      schedule.durationMax !== undefined && (schedule.durationMax !== schedule.duration ||
        schedule.durationMaxUnit && schedule.durationMaxUnit !== schedule.durationUnit)) return undefined;
  return schedule.durationUnit === "d" ? schedule.duration :
    schedule.durationUnit === "wk" ? schedule.duration * 7 : undefined;
}

/** Half-open phase endpoint derived from explicit dates, end bounds, or anchored duration. */
function phaseEndExclusive(schedule: CanonicalSigClause['schedule']): string | undefined {
  if (!schedule) return undefined;
  let endpoint = schedule.boundsEnd ? advanceDate(schedule.boundsEnd) : undefined;
  const inclusiveDurationEnd = anchoredScheduleDurationEnd(schedule);
  const durationEnd = inclusiveDurationEnd ? advanceDate(inclusiveDurationEnd) : undefined;
  if (durationEnd && (!endpoint || durationEnd < endpoint)) endpoint = durationEnd;
  // Explicit finite phase bounds take precedence over the date of its last dose.
  if (endpoint) return endpoint;
  if (schedule.calendarEvents?.length) {
    let latest = '';
    for (const event of schedule.calendarEvents) if (event.isoDate > latest) latest = event.isoDate;
    return advanceDate(latest);
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

/** Keep inherited source evidence in the recipient's local coordinate space.
 * The standard final rebase will then point back to the actual donor text.
 * Only cross-segment inheritance uses this; local parser evidence is unchanged.
 */
function cloneInheritedValue<T extends { evidence?: CanonicalEvidence[] }>(
  source: T | undefined,
  donorStart: number,
  recipientStart: number
): T | undefined {
  if (!source) return undefined;
  const copy = cloneStructuredValue(source);
  if (copy.evidence?.length) {
    copy.evidence = copy.evidence.map(item => shiftEvidence(item, donorStart, recipientStart));
  }
  return copy;
}

function cloneInheritedSite(
  source: CanonicalSigClause["site"],
  donorStart: number,
  recipientStart: number
): CanonicalSigClause["site"] {
  const copy = cloneInheritedValue(source, donorStart, recipientStart);
  if (!copy) return undefined;
  const delta = donorStart - recipientStart;
  const shift = (span: { start: number; end: number } | undefined) => {
    if (span) { span.start += delta; span.end += delta; }
  };
  shift(copy.range);
  for (const restriction of copy.restrictions ?? []) {
    shift(restriction.range);
    shift(restriction.markerRange);
    shift(restriction.predicate.range);
  }
  return copy;
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
    schedule.when?.some(event => event !== SequenceEventTiming.Immediate) ||
    schedule.timeOfDay?.length
  ));
}

/** A single clock without independent recurrence or phase boundaries can
 * locate the initial administration in an explicitly ordered clock sequence. */
function singleClockWithoutRecurrence(schedule: CanonicalSigClause['schedule']): string | undefined {
  if (schedule?.timeOfDay?.length !== 1 || schedule.when?.length ||
      schedule.frequency !== undefined || schedule.frequencyMax !== undefined ||
      schedule.period !== undefined || schedule.periodMax !== undefined || schedule.periodUnit !== undefined ||
      schedule.timingCode || schedule.count !== undefined || schedule.countMax !== undefined ||
      schedule.duration !== undefined || schedule.durationMax !== undefined || schedule.durationUnit !== undefined ||
      schedule.boundsStart || schedule.boundsEnd || schedule.calendarEvents?.length ||
      schedule.dayOfWeek?.length || schedule.dayOfMonth?.length || schedule.weekdayOrdinal !== undefined ||
      schedule.clockWindow || schedule.eventWindow || schedule.activityTiming?.length ||
      schedule.repeatCycle || schedule.cycleDayConstraint || schedule.occurrenceCap ||
      schedule.treatmentStartOffsetDays !== undefined || schedule.phaseStartReference || schedule.timingReference ||
      schedule.administrationOffsetMinutes !== undefined || schedule.administrationDuration !== undefined ||
      schedule.administrationDurationRange || schedule.offset !== undefined ||
      schedule.offsetMin !== undefined || schedule.offsetMax !== undefined) return undefined;
  return schedule.timeOfDay[0];
}

/** Consume the HPSG pause only at the end of its administration program. */
function terminalTreatmentPauseDays(clause: CanonicalSigClause): number | undefined {
  const pause = clause.clinicalAdjuncts?.treatmentPause;
  const graph = clause.instructionGraph;
  const actions = graph?.actions;
  const last = actions?.[actions.length - 1];
  if (!pause || !last || last.span.start !== pause.range.start ||
      last.span.end !== pause.range.end ||
      (graph?.primaryAdministrationSpan &&
        last.span.start < graph.primaryAdministrationSpan.end)) return undefined;
  return pause.durationDays;
}

/** A divided daily total retains its denominator as derivation; the resolved
 * per-administration dose does not become an infusion-method antecedent. */
function isAdministrationRate(quantity: CanonicalSigClause["clinicalQuantity"]): boolean {
  return !!quantity && (quantity.representation !== "dose" ||
    quantity.status !== "resolved" && !!quantity.dailyTotal &&
      quantity.denominators.some(term => term.dimension === "time"));
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
  for (const state of states) {
    const clause = state.primaryClause, schedule = clause.schedule;
    materializeAnchoredScheduleWindow(schedule);
    // A typed relative delay without a recurrence denotes one future point.
    // Establish it before both native and R5 projection; neither execution
    // nor an interchange adapter should infer it from an empty repeat.
    if (schedule?.administrationOffsetMinutes !== undefined &&
        schedule.count === undefined && schedule.countMax === undefined &&
        !hasRecurringSchedule(schedule) && schedule.frequencyMax === undefined &&
        schedule.periodMax === undefined && schedule.periodUnit === undefined &&
        !schedule.dayOfMonth?.length && schedule.weekdayOrdinal === undefined &&
        !schedule.activityTiming?.length && !schedule.clockWindow && !schedule.eventWindow &&
        !schedule.calendarEvents?.length && !schedule.cycleDayConstraint && !schedule.occurrenceCap &&
        schedule.duration === undefined && schedule.durationMax === undefined && schedule.durationUnit === undefined) {
      schedule.count = 1;
      clause.evidence.push({ rule: "hpsg.regimen.delayed-administration-point", spans: [],
        scheduleFields: ["count"],
        note: "The relative interval locates one administration unless a recurrence is independently stated." });
    }
  }
  for (const dependency of graph.administrationDependencies ?? []) {
    const donor = states[dependency.from]?.primaryClause;
    const recipient = states[dependency.to]?.primaryClause;
    if (!donor?.dose || !donor.schedule || !recipient) continue;
    const donorStart = segments[dependency.from]?.start ?? 0;
    const recipientStart = segments[dependency.to]?.start ?? 0;
    recipient.dose = recipient.dose ?? cloneInheritedValue(donor.dose, donorStart, recipientStart);
    recipient.method = recipient.method ?? cloneInheritedValue(donor.method, donorStart, recipientStart);
    recipient.route = recipient.route ?? cloneInheritedValue(donor.route, donorStart, recipientStart);
    recipient.schedule = {
      ...cloneInheritedValue(donor.schedule, donorStart, recipientStart),
      administrationOffsetMinutes: (donor.schedule.administrationOffsetMinutes ?? 0) + dependency.delayMinutes
    };
    appendEvidence(recipient.evidence, {
      rule: "hpsg.regimen.delayed-target-administration", spans: [],
      note: "The target inherits this administration's arguments and base schedule with the explicit intervening wait."
    });
  }
  const relativePhaseStarts = new Map<number, number | null>();
  for (const edge of graph.sequences) {
    const prior = graph.phases[edge.from].members;
    const next = graph.phases[edge.to].members;
    const schedules = prior.map(index => states[index]?.primaryClause.schedule);
    if (edge.relation.semanticLicense === 'dose-continuation' && prior.length === 1 && next.length === 1) {
      const precedingClock = singleClockWithoutRecurrence(schedules[0]);
      const followingClock = precedingClock && singleClockWithoutRecurrence(states[next[0]]?.primaryClause.schedule);
      if (precedingClock && followingClock && precedingClock > followingClock) {
        // The existing clock-order construction kept these daughters sequential.
        // Complete its initial point; native phase completion owns the next
        // eligible successor clock, including an order after today's first clock.
        schedules[0]!.count = 1;
        states[prior[0]].primaryClause.evidence.push({
          rule: "hpsg.regimen.single-clock-before-clock-transition", spans: [], scheduleFields: ["count"],
          note: "The explicit backward-clock continuation follows this initial administration."
        });
      }
    }
    const endpoints = schedules.map(phaseEndExclusive);
    // All coordinated daughters must be finite. An unbounded sibling prevents
    // the sequence construction from inventing a phase boundary.
    const start = endpoints.length && endpoints.every((value): value is string => !!value)
      ? endpoints.reduce((latest, value) => value > latest ? value : latest, '')
      : undefined;
    const recordedStart = relativePhaseStarts.get(edge.from);
    const inheritedStart = recordedStart !== undefined ? recordedStart : 0;
    const firstSchedule = schedules[0];
    let priorStart: number | null = firstSchedule?.treatmentStartOffsetDays ?? inheritedStart;
    // An omitted member onset inherits the phase origin, not a sibling's
    // independently authored onset. Distinct origins keep their dependency
    // for the native phase resolver, which already owns member completion.
    let phasePauseDays = 0;
    let terminalPauses = 0;
    for (let index = 0; index < schedules.length; index++) {
      const schedule = schedules[index];
      if (index > 0 && ((schedule?.treatmentStartOffsetDays ?? inheritedStart) !== priorStart ||
          schedule?.phaseStartReference !== firstSchedule?.phaseStartReference ||
          schedule?.boundsStart !== firstSchedule?.boundsStart)) priorStart = null;
      const clause = states[prior[index]]?.primaryClause;
      if (clause?.clinicalAdjuncts?.treatmentPause) {
        const days = terminalTreatmentPauseDays(clause);
        if (days !== undefined) {
          phasePauseDays = days;
          terminalPauses++;
        }
      }
    }
    // Only one typed terminal action can supply a shared pause. Conflicting
    // pauses remain counseling instead of becoming an executable guess.
    if (terminalPauses !== 1) phasePauseDays = 0;
    let nextDayRelation = false;
    let contextualNextDay = false;
    let localNextDay = false;
    let datedNextDay: string | undefined;
    let contextualPredecessor: boolean | undefined;
    let singleClockPredecessor: number | undefined;
    let relativeNextDay: number | null | undefined;
    for (const member of next) {
      const clause = states[member]?.primaryClause;
      const schedule = clause?.schedule;
      if (!clause || !schedule?.evidence?.some(item => item.rule === NEXT_DAY_SCHEDULE_RULE)) continue;
      if (contextualPredecessor === undefined) {
        const preceding = prior.length === 1 ? schedules[0] : undefined;
        // A sequential next-morning construction closes one explicitly
        // clocked administration. Its actual occurrence, which can move to
        // tomorrow after a late order, owns the following local day.
        const onceDaily = preceding?.frequency === 1 && preceding.period === 1 &&
          preceding.periodUnit === FhirPeriodUnit.Day;
        if (preceding?.timeOfDay?.length === 1 && preceding.count === undefined &&
            preceding.countMax === undefined && preceding.duration === undefined &&
            preceding.durationMax === undefined && preceding.durationUnit === undefined &&
            (onceDaily || preceding.frequency === undefined && preceding.period === undefined) &&
            preceding.frequencyMax === undefined && preceding.periodMax === undefined &&
            !preceding.dayOfWeek?.length && !preceding.dayOfMonth?.length &&
            preceding.weekdayOrdinal === undefined && !preceding.repeatCycle &&
            !preceding.boundsStart && !preceding.boundsEnd && !preceding.calendarEvents?.length) {
          // A named daypart can qualify this same clock. A separate event
          // position, including a meal, cannot be closed by a one-dose cap.
          const hour = preceding.when?.length ? Number(preceding.timeOfDay[0].slice(0, 2)) : 0;
          if (!preceding.when?.length || preceding.when.every(event => {
            const range = DOSE_TARGET_DAYPART_CLOCK_RANGES.get(event);
            return range && hour >= range.startHour && hour < range.endHour;
          })) singleClockPredecessor = prior[0];
        }
        // Every finite duration can end within a local day. The execution
        // owner knows its actual endpoint, order clock and timezone; grammar
        // must preserve NEXT instead of reducing it to an elapsed offset.
        // A fully dated predecessor already supplies its civil endpoint.
        contextualPredecessor = !start && (singleClockPredecessor !== undefined || priorStart === null ||
          schedules.some(value => value?.count !== undefined || value?.countMax !== undefined ||
            value?.phaseStartReference === 'previous-phase-next-day' ||
            value?.duration !== undefined || value?.durationUnit !== undefined));
      }
      const authoredOffset = schedule.evidence.some(item => item.rule !== NEXT_DAY_SCHEDULE_RULE &&
        (item.scheduleFields?.indexOf('treatmentStartOffsetDays') ?? -1) >= 0 &&
        item.spans.some(span => span.start >= 0 && span.end <= clause.rawText.length));
      // A standalone NEXT starts at the next civil day. In a sequence this
      // provisional anchor is replaced by the predecessor's own boundary.
      if (!authoredOffset && schedule.phaseStartReference === "treatment-day-start")
        delete schedule.phaseStartReference;
      // An independent source onset remains its own owner. Remove only the
      // provisional relative-day offset when an authored calendar start owns it.
      if (authoredOffset || contextualPredecessor && (schedule.boundsStart || schedule.calendarEvents?.length)) {
        if (!authoredOffset) delete schedule.treatmentStartOffsetDays;
        continue;
      }
      nextDayRelation = true;
      if (singleClockPredecessor !== undefined) {
        const predecessor = states[singleClockPredecessor].primaryClause;
        predecessor.schedule!.count = 1;
        predecessor.evidence.push({ rule: "hpsg.regimen.single-clock-before-next-day", spans: [],
          scheduleFields: ["count"],
          note: "The next-morning continuation follows this one explicitly clocked administration." });
        singleClockPredecessor = undefined;
      }
      if (contextualPredecessor) {
        contextualNextDay = true;
        if (phasePauseDays) schedule.treatmentStartOffsetDays = phasePauseDays;
        else delete schedule.treatmentStartOffsetDays;
        schedule.phaseStartReference = 'previous-phase-next-day';
      } else if (start) {
        // A dated predecessor supplies an actual next calendar day. It must
        // not also claim the unrelated second day of treatment.
        datedNextDay = phasePauseDays ? advanceDate(start, phasePauseDays) : start;
        schedule.boundsStart ??= datedNextDay;
        delete schedule.treatmentStartOffsetDays;
      } else if (firstSchedule?.boundsStart && priorStart !== null) {
        // An open dated phase supplies a civil origin, not a completion.
        // NEXT follows that shared date; keep the predecessor's authored end
        // absent, rather than replacing its calendar origin with treatment day 2.
        datedNextDay = advanceDate(firstSchedule.boundsStart, 1 + phasePauseDays);
        schedule.boundsStart ??= datedNextDay;
        delete schedule.treatmentStartOffsetDays;
      } else {
        if (relativeNextDay === undefined) {
          // Finite and dependent predecessors were handled above. An
          // otherwise unbounded NEXT uses the established local-day origin.
          relativeNextDay = priorStart === null ? null : priorStart + 1;
          localNextDay = relativeNextDay !== null;
        }
        if (relativeNextDay === null) delete schedule.treatmentStartOffsetDays;
        else {
          schedule.treatmentStartOffsetDays = relativeNextDay;
          if (localNextDay) schedule.phaseStartReference = "treatment-day-start";
        }
      }
      clause.evidence.push({ rule: 'hpsg.regimen.next-day-onset', spans: [],
        scheduleFields: schedule.phaseStartReference && schedule.treatmentStartOffsetDays !== undefined
          ? ["phaseStartReference", "treatmentStartOffsetDays"]
          : schedule.phaseStartReference ? ['phaseStartReference'] :
            datedNextDay ? ['boundsStart'] : relativeNextDay === null ? [] : ['treatmentStartOffsetDays'],
        note: 'The next-day daughter follows the complete preceding phase, retaining its authored endpoint or origin.' });
    }
    if (contextualNextDay || localNextDay || datedNextDay) {
      // Coordination already established one successor phase. Its onset scopes
      // over daughters that omit an onset, while independently authored dates
      // and treatment offsets remain local to their own administrations.
      for (const member of next) {
        const clause = states[member]?.primaryClause;
        if (!clause) continue;
        const schedule = clause.schedule;
        if (schedule?.phaseStartReference || schedule?.treatmentStartOffsetDays !== undefined ||
            schedule?.boundsStart || schedule?.calendarEvents?.length) continue;
        clause.schedule ??= {};
        if (datedNextDay) clause.schedule.boundsStart = datedNextDay;
        else {
          clause.schedule.phaseStartReference = contextualNextDay ? 'previous-phase-next-day' : "treatment-day-start";
          if (contextualNextDay && phasePauseDays)
            clause.schedule.treatmentStartOffsetDays = phasePauseDays;
          else if (localNextDay && relativeNextDay !== null && relativeNextDay !== undefined)
            clause.schedule.treatmentStartOffsetDays = relativeNextDay;
        }
        clause.evidence.push({ rule: 'hpsg.regimen.shared-next-day-onset', spans: [],
          scheduleFields: datedNextDay ? ['boundsStart'] : clause.schedule.treatmentStartOffsetDays !== undefined
            ? ["phaseStartReference", "treatmentStartOffsetDays"] : ['phaseStartReference'],
          note: 'The coordinated successor shares the phase onset while retaining its local dose and clock.' });
      }
    }
    const explicitStarts = next.map(index => states[index]?.primaryClause.schedule?.treatmentStartOffsetDays)
      .filter((value): value is number => value !== undefined);
    const typedChange = next.some(index => Boolean(states[index]?.primaryClause.regimenAdjustment));
    const explicitStart = !contextualNextDay && (typedChange || nextDayRelation) && explicitStarts.length &&
      explicitStarts.every(value => value === explicitStarts[0]) ? explicitStarts[0] : undefined;
    if (explicitStart !== undefined && priorStart !== null && explicitStart > priorStart) {
      // An explicit source-relative ADD/REPLACE onset closes the preceding
      // phase. Civil NEXT already supplies the successor boundary to execution;
      // an elapsed length here would incorrectly keep the predecessor past midnight.
      // Never derive an elapsed length from unrelated lowered parallel members.
      for (const member of prior) {
        const clause = states[member]?.primaryClause;
        const schedule = clause?.schedule;
        if (!clause || !schedule || localNextDay || schedule.duration !== undefined ||
            schedule.boundsStart || schedule.boundsEnd || schedule.calendarEvents?.length) continue;
        schedule.duration = explicitStart - priorStart;
        schedule.durationUnit = FhirPeriodUnit.Day;
        clause.evidence.push({ rule: 'hpsg.regimen.relative-adjustment-onset',
          spans: [], scheduleFields: ['duration', 'durationUnit'],
          note: 'The next source-typed phase starts at its explicit treatment-relative offset.' });
      }
      relativePhaseStarts.set(edge.to, explicitStart);
      // The same source onset also belongs to the succeeding step's start.
      // Do not erase it after bounding the predecessor: R6/R5 lowering must
      // still emit the exact treatment-relative date on the next phase.
    } else if (!contextualNextDay) {
      const lengths = schedules.map(exactPhaseDurationDays);
      if (priorStart !== null && lengths.length &&
          lengths.every((value): value is number => value !== undefined)) {
        const phaseStart = priorStart + Math.max(...lengths) + phasePauseDays;
        relativePhaseStarts.set(edge.to, phaseStart);
        if (phasePauseDays && lengths.every(length => length === lengths[0])) {
          for (const member of next) {
            const clause = states[member]?.primaryClause;
            const schedule = clause?.schedule;
            if (!clause || !schedule || schedule.treatmentStartOffsetDays !== undefined ||
                schedule.boundsStart || schedule.boundsEnd) continue;
            schedule.treatmentStartOffsetDays = phaseStart;
            clause.evidence.push({
              rule: "hpsg.regimen.terminal-treatment-pause",
              spans: [], scheduleFields: ["treatmentStartOffsetDays"],
              note: "The next administration starts after an explicit finite no-medication interval."
            });
          }
        }
      } else relativePhaseStarts.set(edge.to, null);
    } else relativePhaseStarts.set(edge.to, null);
    const shared = schedules[0];
    const sharedAnchors = schedules.every(schedule =>
      sameSet(schedule?.when, shared?.when) &&
      sameSet(schedule?.timeOfDay, shared?.timeOfDay) &&
      equalStructuredValues(schedule?.clockWindow, shared?.clockWindow) &&
      equalStructuredValues(schedule?.eventWindow, shared?.eventWindow) &&
      equalStructuredValues(schedule?.activityTiming, shared?.activityTiming)
    );
    // The target-transition construction may carry an omitted administration
    // method only when the entire predecessor phase agrees on the typed head.
    const sourceMethods = prior.map(index => states[index]?.primaryClause.method);
    const priorHasRate = prior.every(index => isAdministrationRate(states[index]?.primaryClause.clinicalQuantity));
    const sharedMethod = (edge.relation.semanticLicense === 'target-transition' ||
      edge.relation.semanticLicense === 'dose-continuation') &&
      sourceMethods[0] &&
      sourceMethods.every(method => equalStructuredValues(method, sourceMethods[0]))
      ? sourceMethods[0] : undefined;

    for (const index of graph.phases[edge.to].members) {
      const clause = states[index]?.primaryClause;
      const schedule = clause?.schedule;
      if (!clause) continue;

      const fields: string[] = [];
      const donorStart = segments[prior[0]]?.start ?? 0;
      const recipientStart = segments[index]?.start ?? 0;
      if (edge.relation.semanticLicense === 'dose-continuation' && clause.prn?.enabled &&
          !clause.clinicalQuantity && !clause.evidence.some(item => item.lexicalCategory === 'dose' &&
            item.spans.some(span => span.start >= 0 && span.end <= clause.rawText.length))) {
        // A PRN successor can omit the repeated administration, but only
        // features shared by the whole predecessor phase have an antecedent.
        // In particular, never pick the last of several different doses.
        const antecedents = prior.map(member => states[member]?.primaryClause);
        const first = antecedents[0];
        if (first?.dose && antecedents.every(value => equalStructuredValues(value?.dose, first.dose))) {
          clause.dose = cloneInheritedValue(first.dose, donorStart, recipientStart);
          fields.push('dose');
        } else {
          // Earlier local ellipsis may have a nearest-neighbor quantity;
          // it is not authoritative across a multi-component predecessor.
          delete clause.dose;
          clause.patientInstruction = clause.patientInstruction ?? clause.rawText;
        }
        if (!clause.route && first?.route && antecedents.every(value => equalStructuredValues(value?.route, first.route))) {
          clause.route = cloneInheritedValue(first.route, donorStart, recipientStart);
          fields.push('route');
        }
        if (!clause.site && first?.site && antecedents.every(value => equalStructuredValues(value?.site, first.site))) {
          clause.site = cloneInheritedSite(first.site, donorStart, recipientStart);
          fields.push('site');
        }
      }
      const recipientHasRate = isAdministrationRate(clause.clinicalQuantity);
      if (sharedMethod && !clause.method && (!recipientHasRate || priorHasRate)) {
        clause.method = cloneInheritedValue(sharedMethod, donorStart, recipientStart);
        fields.push('method');
      }
      const onsetOnlyContinuation = edge.relation.rule === "regimen.treatment-relative-phase-onset" &&
        prior.length === 1 && schedule && !hasRecurringSchedule(schedule);
      if (schedule && (schedule.timingReference === "previous" || onsetOnlyContinuation) && sharedAnchors && shared) {
        // A timing anaphor or licensed onset-only dose continuation inherits
        // recurrence, not the preceding phase's duration, count or dates.
        // The onset-only construction has one complete cadence antecedent.
        // Explicit local cadence/anchors remain local.
        const recurrence = {
          frequency: shared.frequency, frequencyMax: shared.frequencyMax,
          period: shared.period, periodMax: shared.periodMax, periodUnit: shared.periodUnit,
          timingCode: shared.timingCode, dayOfWeek: shared.dayOfWeek,
          dayOfMonth: shared.dayOfMonth, weekdayOrdinal: shared.weekdayOrdinal,
          when: shared.when?.filter(event => event !== SequenceEventTiming.Immediate),
          timeOfDay: shared.timeOfDay, clockWindow: shared.clockWindow, eventWindow: shared.eventWindow,
          activityTiming: shared.activityTiming,
          offset: shared.offset, offsetMin: shared.offsetMin, offsetMax: shared.offsetMax
        };
        // ParserState setters may create own keys with an undefined value;
        // only an actually defined local value can override inherited recurrence.
        for (const key of Object.keys(recurrence) as (keyof typeof recurrence)[]) {
          const inherited = recurrence[key];
          if (schedule[key] === undefined && inherited !== undefined) {
            (schedule as Record<string, unknown>)[key] = cloneStructuredValue(inherited);
          }
        }
        if (schedule.timingReference === "previous" &&
            (schedule.when?.length || schedule.timeOfDay?.length || schedule.clockWindow || schedule.eventWindow)) {
          delete schedule.timingReference;
          // Only remove the exact typed reference advice after it is resolved.
          // Without a predecessor the source preference stays readable/editable.
          if (clause.additionalInstructions?.length) {
            clause.additionalInstructions = clause.additionalInstructions.filter(instruction =>
              !instruction.evidence?.some(item =>
                (item.scheduleFields?.indexOf('timingReference') ?? -1) >= 0));
          }
          fields.push('timingReference');
        } else fields.push('recurrence');
      }
      if (!schedule || schedule.calendarEvents?.length || !hasRecurringSchedule(schedule)) {
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
      if (!schedule.boundsStart && !schedule.phaseStartReference &&
          schedule.treatmentStartOffsetDays === undefined && start) {
        schedule.boundsStart = start;
        fields.push('boundsStart');
        materializeAnchoredScheduleWindow(schedule);
      }
      // An explicit local meal/event or clock anchor owns the whole anchor
      // group, so inherited anchors can never create a mixed local/donor pair.
      if (!schedule.when?.length && !schedule.timeOfDay?.length && sharedAnchors) {
        // A point event belongs to its administration. A successor may
        // inherit recurring meal/day anchors, never the predecessor's "now".
        const recurringAnchors = shared?.when?.filter(event => event !== SequenceEventTiming.Immediate);
        if (recurringAnchors?.length) {
          schedule.when = recurringAnchors;
          fields.push('when');
        }
        // A newly explicit cadence cannot inherit an incompatible number
        // of exact clock anchors from the preceding phase. In particular,
        // QID -> TID does not license guessing which three of four times to
        // keep. The original source still accompanies the editable schedule.
        const donorClockCount = shared?.timeOfDay?.length ?? 0;
        const matchesSuccessorCadence = schedule.frequency === undefined || (
          schedule.frequency === donorClockCount &&
          (schedule.period === undefined || schedule.period === 1) &&
          (schedule.periodUnit === undefined || schedule.periodUnit === 'd') &&
          (schedule.frequencyMax === undefined || schedule.frequencyMax === donorClockCount)
        );
        if (shared?.timeOfDay?.length && matchesSuccessorCadence) {
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


/** Materialize an explicit ADD phase over its preceding typed regimen.
 * Source-only operation resolution runs before FHIR; ordinary parses return
 * their original arrays and unrelated parallel tracks are never inspected.
 * @param states Interpreted source clause states.
 * @param segments Source ranges corresponding to those states.
 * @param graph Source-licensed phase relations before wire projection.
 */
export function expandRegimenAdjustmentPhases(
  states: ParserState[], segments: HpsgSigSegment[], graph: RegimenGraph
): { states: ParserState[]; segments: HpsgSigSegment[]; graph: RegimenGraph } {
  if (!states.some(state => state.primaryClause.regimenAdjustment === "add" ||
      state.primaryClause.regimenAdjustment === "replace-target")) {
    return { states, segments, graph };
  }
  const outputStates: ParserState[] = [];
  const outputSegments: HpsgSigSegment[] = [];
  const phases: RegimenPhase[] = [];
  for (const phase of graph.phases) {
    const members: number[] = [];
    const adjustments = phase.members.filter(index =>
      states[index]?.primaryClause.regimenAdjustment === "add" ||
      states[index]?.primaryClause.regimenAdjustment === "replace-target");
    const preceding = graph.sequences.find(edge => edge.to === phase.id);
    const prior = preceding ? phases[preceding.from] : undefined;
    const target = adjustments.length ? states[adjustments[0]]?.primaryClause : undefined;
    if (target && prior) {
      const previous = prior.members.map(index => outputStates[index]);
      const sharedDose = previous[0]?.primaryClause.dose;
      const explicitDose = target.evidence.some(item => item.lexicalCategory === "dose" &&
        item.spans.some(span => span.start >= 0 && span.end <= target.rawText.length));
      if (!explicitDose && !target.clinicalQuantity) {
        const agreedDose = sharedDose && previous.every(state =>
          equalStructuredValues(state.primaryClause.dose, sharedDose));
        if (agreedDose) {
          target.dose = cloneInheritedValue(
            sharedDose,
            outputSegments[prior.members[0]]?.start ?? 0,
            segments[adjustments[0]]?.start ?? 0
          );
        } else {
          // An omitted amount has no unique antecedent. Keep the clinician's
          // source instruction editable rather than choose the last dose.
          delete target.dose;
          target.patientInstruction = target.patientInstruction ?? target.rawText;
        }
      }
      // A restricted clock or event nominal names an existing administration.
      // Dinner can select a before-dinner dose without changing its meal relation;
      // a unique typed antecedent, never a guessed clock-to-event mapping, is required.
      const replacedClock = target.regimenAdjustment === "replace-target" &&
        target.schedule?.timeOfDay?.length === 1
        ? target.schedule.timeOfDay[0] : undefined;
      const eventTarget = target.regimenAdjustment === "replace-target" &&
        target.schedule?.when?.length === 1 && !replacedClock ? target.schedule.when[0] : undefined;
      let replacedEvent: SequenceEventTiming | undefined;
      if (eventTarget && target.schedule) {
        const eventFamily = DOSE_TARGET_EVENT_MEMBERS.get(eventTarget) ??
          [...DOSE_TARGET_EVENT_MEMBERS.values()].find(members => members.indexOf(eventTarget) >= 0) ?? [eventTarget];
        const matches: SequenceEventTiming[] = [];
        for (const state of previous) for (const event of state.primaryClause.schedule?.when ?? []) {
          if (eventFamily.indexOf(event) >= 0) matches.push(event);
        }
        const exact = matches.indexOf(eventTarget) >= 0 ? eventTarget :
          matches.length === 1 ? matches[0] : undefined;
        if (exact) {
          replacedEvent = exact;
          target.schedule.when = [exact];
          const donor = previous.find(state =>
            (state.primaryClause.schedule?.when?.indexOf(exact) ?? -1) >= 0)?.primaryClause.schedule;
          if (donor) for (const field of ["offset", "offsetMin", "offsetMax"] as const) {
            if (target.schedule[field] === undefined && donor[field] !== undefined) {
              target.schedule[field] = donor[field];
            }
          }
        }
      }
      // ADD continues every predecessor administration even when its new dose
      // has no unique antecedent. REPLACE may partition only a matched target.
      const continuesPredecessor = target.regimenAdjustment === "add" ||
        Boolean(replacedEvent) ||
        Boolean(replacedClock && previous.some(state =>
          (state.primaryClause.schedule?.timeOfDay?.indexOf(replacedClock) ?? -1) >= 0));
      if (continuesPredecessor) {
        for (const donorIndex of prior.members) {
          const donor = outputStates[donorIndex];
          const clone = new ParserState(donor.input, donor.tokens, donor.customSiteHints);
          Object.assign(clone.primaryClause, cloneStructuredValue(donor.primaryClause));
          clone.consumed = new Set(donor.consumed);
          clone.methodVerb = donor.methodVerb;
          clone.productFormKey = donor.productFormKey;
          clone.warnings = [...donor.warnings];
          delete clone.primaryClause.regimenAdjustment;
          const schedule = clone.primaryClause.schedule;
          if (schedule && replacedClock && target.regimenAdjustment === "replace-target") {
            const oldClocks = schedule.timeOfDay ?? [];
            if (oldClocks.indexOf(replacedClock) >= 0) {
              const remaining = oldClocks.filter(clock => clock !== replacedClock);
              if (!remaining.length && !schedule.when?.length) continue;
              schedule.timeOfDay = remaining;
              if (schedule.frequency === oldClocks.length && schedule.period === 1 &&
                  schedule.periodUnit === 'd') {
                schedule.frequency = remaining.length;
                // The surviving partition has its own cadence; the donor's
                // coded frequency no longer describes this administration.
                delete schedule.timingCode;
              }
            }
          }
          if (schedule && replacedEvent && target.regimenAdjustment === "replace-target") {
            const oldEvents = schedule.when ?? [];
            if (oldEvents.indexOf(replacedEvent) >= 0) {
              const remaining = oldEvents.filter(event => event !== replacedEvent);
              if (!remaining.length && !schedule.timeOfDay?.length) continue;
              schedule.when = remaining;
              if (schedule.frequency === oldEvents.length && schedule.period === 1 &&
                  schedule.periodUnit === 'd') {
                schedule.frequency = remaining.length;
                // The surviving partition has its own cadence; the donor's
                // coded frequency no longer describes this administration.
                delete schedule.timingCode;
              }
            }
          }
          if (schedule) {
            // The new phase keeps prior recurrence but owns its complete
            // course window, including open ranges and endpoint qualifiers.
            Object.assign(schedule, {
              duration: target.schedule?.duration,
              durationMax: target.schedule?.durationMax,
              durationUnit: target.schedule?.durationUnit,
              durationMaxUnit: target.schedule?.durationMaxUnit,
              durationComparator: target.schedule?.durationComparator,
              durationMaxComparator: target.schedule?.durationMaxComparator,
              durationIsRange: target.schedule?.durationIsRange,
            });
            delete schedule.boundsStart; delete schedule.boundsEnd; delete schedule.calendarEvents;
            // Cloned continuation daughters take the explicit onset of THIS
            // phase, not the donor's old onset. Step.start is executable
            // only when all new phase members agree on that source feature.
            delete schedule.treatmentStartOffsetDays;
            delete schedule.phaseStartReference;
            if (target.schedule?.treatmentStartOffsetDays !== undefined) {
              schedule.treatmentStartOffsetDays = target.schedule.treatmentStartOffsetDays;
            }
            if (target.schedule?.phaseStartReference)
              schedule.phaseStartReference = target.schedule.phaseStartReference;
            if (target.schedule?.boundsStart) schedule.boundsStart = target.schedule.boundsStart;
            if (target.schedule?.boundsEnd) schedule.boundsEnd = target.schedule.boundsEnd;
          }
          clone.primaryClause.evidence.push({
            rule: target.regimenAdjustment === "replace-target"
              ? "hpsg.regimen.targeted-replacement-continuation"
              : "hpsg.regimen.explicit-addition-continuation",
            spans: [],
            note: target.regimenAdjustment === "replace-target"
              ? "The typed restricted adjustment retains this unaffected predecessor administration."
              : "The typed ADD operation continues this preceding administration in the new phase."
          });
          members.push(outputStates.length);
          outputStates.push(clone); outputSegments.push(outputSegments[donorIndex]);
        }
      }
    }
    for (const index of phase.members) {
      members.push(outputStates.length);
      outputStates.push(states[index]); outputSegments.push(segments[index]);
    }
    phases.push({ ...phase, members });
  }
  return { states: outputStates, segments: outputSegments, graph: { ...graph, phases } };
}
