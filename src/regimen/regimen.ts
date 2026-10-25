import { terminalAdministrationDelay } from "./grammar";
import {
  AdviceArgumentRole, AdvicePolarity,
  EventTiming as SequenceEventTiming, FhirPeriodUnit
} from '../types';
import { equalStructuredValues, cloneStructuredValue } from '../stable-structure';
import type { BoundaryPlan, BoundaryRelation } from './types';
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
    schedule.when?.some(event => event !== SequenceEventTiming.Immediate) ||
    schedule.timeOfDay?.length
  ));
}

/**
 * A terminal affirmative STOP with a finite elapsed-duration daughter is
 * a medication-free pause before the next licensed regimen phase. This is
 * distinct from a dosage course end and never creates a fictitious dose.
 * There is no implied exact pause without both a typed STOP and its duration.
 */
function terminalTreatmentPauseDays(clause: CanonicalSigClause): number | undefined {
  const graph = clause.instructionGraph;
  const actions = graph?.actions;
  const last = actions?.[actions.length - 1];
  if (!last || last.predicate.semanticClass !== 'stop' ||
      last.polarity === AdvicePolarity.Negate ||
      (graph?.primaryAdministrationSpan &&
        last.span.start < graph.primaryAdministrationSpan.end)) return undefined;
  const quantity = last.args.find(arg =>
    arg.role === AdviceArgumentRole.Duration)?.quantity;
  if (!quantity || quantity.range || quantity.value === undefined ||
      quantity.value <= 0 || !Number.isFinite(quantity.value)) return undefined;
  const days = quantity.unit === 'd' ? quantity.value :
    quantity.unit === 'wk' ? quantity.value * 7 : undefined;
  return days !== undefined && Number.isInteger(days) ? days : undefined;
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
  for (const dependency of graph.administrationDependencies ?? []) {
    const donor = states[dependency.from]?.primaryClause;
    const recipient = states[dependency.to]?.primaryClause;
    if (!donor?.dose || !donor.schedule || !recipient) continue;
    recipient.dose = cloneStructuredValue(donor.dose);
    recipient.method = recipient.method ?? cloneStructuredValue(donor.method);
    recipient.route = recipient.route ?? cloneStructuredValue(donor.route);
    recipient.schedule = {
      ...cloneStructuredValue(donor.schedule),
      administrationOffsetMinutes: (donor.schedule.administrationOffsetMinutes ?? 0) + dependency.delayMinutes
    };
    appendEvidence(recipient.evidence, {
      rule: "hpsg.regimen.delayed-target-administration", spans: [],
      note: "The target inherits this administration's arguments and base schedule with the explicit intervening wait."
    });
  }
  const relativePhaseStarts = new Map<number, number>();
  for (const edge of graph.sequences) {
    const prior = graph.phases[edge.from].members;
    const next = graph.phases[edge.to].members;
    const priorStart = relativePhaseStarts.get(edge.from) ?? 0;
    const explicitStarts = next.map(index => states[index]?.primaryClause.schedule?.treatmentStartOffsetDays)
      .filter((value): value is number => value !== undefined);
    const typedChange = next.some(index => Boolean(states[index]?.primaryClause.regimenAdjustment));
    const explicitStart = typedChange && explicitStarts.length &&
      explicitStarts.every(value => value === explicitStarts[0]) ? explicitStarts[0] : undefined;
    if (explicitStart !== undefined && explicitStart > priorStart) {
      // An explicit source-relative ADD/REPLACE onset closes the preceding
      // phase. Never derive this from unrelated lowered parallel members.
      for (const member of prior) {
        const clause = states[member]?.primaryClause;
        const schedule = clause?.schedule;
        if (!clause || !schedule || schedule.duration !== undefined ||
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
    } else {
      const lengths = prior.map(index => {
        const schedule = states[index]?.primaryClause.schedule;
        return schedule?.duration !== undefined &&
          (schedule.durationUnit === 'd' || schedule.durationUnit === 'wk')
          ? schedule.duration * (schedule.durationUnit === 'wk' ? 7 : 1) : undefined;
      });
      if (lengths.length && lengths.every((value): value is number => value !== undefined)) {
        const pauses = prior.map(index =>
          states[index]?.primaryClause && terminalTreatmentPauseDays(states[index].primaryClause))
          .filter((days): days is number => days !== undefined);
        // The pause is a typed, single terminal action attached to a complete
        // finite predecessor. Multiple or conflicting pauses remain editable
        // counseling rather than executable guesses.
        const pauseDays = pauses.length === 1 ? pauses[0] : 0;
        const phaseStart = priorStart + Math.max(...lengths) + pauseDays;
        relativePhaseStarts.set(edge.to, phaseStart);
        if (pauseDays && lengths.every(length => length === lengths[0])) {
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
      }
    }
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
      if (sharedMethod && !clause.method) {
        clause.method = cloneStructuredValue(sharedMethod);
        fields.push('method');
      }
      if (schedule?.timingReference === "previous" && sharedAnchors && shared) {
        // The anaphor contributes recurrence, not the preceding phase's
        // duration or dates. Explicit local cadence/anchors remain local.
        const recurrence = {
          frequency: shared.frequency, frequencyMax: shared.frequencyMax,
          period: shared.period, periodMax: shared.periodMax, periodUnit: shared.periodUnit,
          timingCode: shared.timingCode, dayOfWeek: shared.dayOfWeek,
          when: shared.when?.filter(event => event !== SequenceEventTiming.Immediate),
          timeOfDay: shared.timeOfDay, eventWindow: shared.eventWindow,
          offset: shared.offset, offsetMin: shared.offsetMin, offsetMax: shared.offsetMax
        };
        Object.assign(schedule, { ...cloneStructuredValue(recurrence), ...schedule });
        delete schedule.timingReference;
        // Only remove the exact typed reference advice after it is resolved.
        // Without a predecessor the source preference stays readable/editable.
        if (clause.additionalInstructions?.length) {
          clause.additionalInstructions = clause.additionalInstructions.filter(instruction =>
            !instruction.evidence?.some(item =>
              (item.scheduleFields?.indexOf('timingReference') ?? -1) >= 0));
        }
        fields.push('timingReference');
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
      if (!schedule.boundsStart && start) {
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
        if (agreedDose) target.dose = cloneStructuredValue(sharedDose);
        else {
          // An omitted amount has no unique antecedent. Keep the clinician's
          // source instruction editable rather than choose the last dose.
          delete target.dose;
          target.patientInstruction = target.patientInstruction ?? target.rawText;
        }
      }
      // A source-licensed, restrictive clock adjustment replaces exactly
      // its named administration. Preserve every unrelated predecessor slot.
      // Without one explicit target clock there is no safe partial replacement.
      const replacedClock = target.regimenAdjustment === "replace-target" &&
        target.schedule?.timeOfDay?.length === 1
        ? target.schedule.timeOfDay[0] : undefined;
      if (target.dose && (target.regimenAdjustment !== "replace-target" ||
          replacedClock && previous.some(state =>
            state.primaryClause.schedule?.timeOfDay?.indexOf(replacedClock) !== -1))) {
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
                  schedule.periodUnit === 'd') schedule.frequency = remaining.length;
            }
          }
          if (schedule) {
            // The new phase keeps prior recurrence but has its own course window.
            delete schedule.duration; delete schedule.durationMax; delete schedule.durationUnit;
            delete schedule.boundsStart; delete schedule.boundsEnd; delete schedule.calendarEvents;
            // Cloned continuation daughters take the explicit onset of THIS
            // phase, not the donor's old onset. Step.start is executable
            // only when all new phase members agree on that source feature.
            delete schedule.treatmentStartOffsetDays;
            if (target.schedule?.treatmentStartOffsetDays !== undefined) {
              schedule.treatmentStartOffsetDays = target.schedule.treatmentStartOffsetDays;
            }
            if (target.schedule?.duration !== undefined) {
              schedule.duration = target.schedule.duration;
              schedule.durationUnit = target.schedule.durationUnit;
              schedule.durationMax = target.schedule.durationMax;
            }
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
