import { equalStructuredValues, cloneStructuredValue } from '../stable-structure';
import {
  selectHpsgCoordinationScopeConstruction,
  selectHpsgCalendarClockEllipsisConstruction,
  selectHpsgTimingAnchorCoordinationConstruction
} from '../hpsg/constructions';
import { grammaticalTrailingInstructionScope, hasAdministrationAdjunct } from './grammar';
import { findUnparsedTokenGroups } from '../parser';
import { ParserState } from '../parser-state';
import { AdviceArgumentRole, AdvicePolarity, FhirDayOfWeek, FhirPeriodUnit } from '../types';
import { MEAL_TIMING_BY_RELATION } from '../hpsg/lexical-classes';
import { resolveEventTimingExpression } from '../event-timing-expression';
import { EVENT_TIMING_TOKENS } from '../maps';
import { ordinalWeekStageHeaderAt } from '../hpsg/rules/timing-rules';
import { cloneExtensions, cloneI18nRecord, clonePrimitiveElement } from '../fhir-translations';
import type {
  AdviceFrame,
  CanonicalAdditionalInstructionExpr,
  CanonicalEvidence,
  CanonicalLexicalCategory,
  CanonicalMethodExpr,
  CanonicalPrnExpr,
  CanonicalScheduleExpr,
  CanonicalScheduleSemanticField,
  CanonicalSigClause,
  CanonicalSourceSpan,
  MedicationCondition
} from '../types';
import type { HpsgSigSegment } from '../hpsg/segmenter';
import { shiftCanonicalSigClauses } from '../ir';
import type { BoundaryPlan, BoundaryRelation, CoordinationScopeFacts } from '../hpsg/signature';

/**
 * A bare event complement of a LICENSED event-timing-ellipsis construction
 * inherits the omitted preposition/offset from its governing left event.
 *
 * This unifies typed event features, not surface words. A right constituent
 * with its own relation or offset is already complete and must remain intact:
 * "15 minutes BEFORE breakfast OR immediately AFTER dinner" must not acquire
 * the left offset or BEFORE relation.
 */
function inheritEllipticEventAnchor(
  donor: CanonicalScheduleExpr | undefined,
  recipient: CanonicalScheduleExpr | undefined,
  donorTokens: ParserState["tokens"],
  recipientTokens: ParserState["tokens"]
): ScheduleSemanticField[] {
  if (!donor || !recipient || donor.when?.length !== 1 || recipient.when?.length !== 1) {
    return [];
  }
  // Direct eventTiming is the open-class noun daughter; eventPhrase, relative
  // offset, and event preposition signs are explicitly bound and never inherit.
  const directlyNamedEventRules = new Set([
    'hpsg.lex.schedule.eventTiming',
    'hpsg.lex.schedule.eventPhrase.fixed'
  ]);
  const bareEvent = recipient.evidence?.some(item =>
    directlyNamedEventRules.has(item.rule) &&
    item.scheduleFields?.indexOf('when') !== -1
  ) && !recipient.evidence?.some(item =>
    !directlyNamedEventRules.has(item.rule) &&
    item.scheduleFields?.indexOf('when') !== -1
  );
  if (!bareEvent) return [];
  const left = donor.when[0];
  const bare = recipient.when[0];
  for (const [relation, eventMap] of MEAL_TIMING_BY_RELATION) {
    if (relation === 'with') continue;
    let donorBase: typeof bare | undefined;
    for (const [sourceEvent, targetEvent] of eventMap) {
      if (targetEvent === left) {
        donorBase = sourceEvent;
        break;
      }
    }
    if (donorBase === undefined) continue;
    let mapped = eventMap.get(bare);
    if (!mapped) {
      // The right daughter may be a bare daypart in an omitted shared
      // nominal head, e.g. Thai meal-[morning OR evening]. Reuse the exact
      // open-class EVENT EXPRESSION lexicon already used by HPSG, not a
      // language/surface-specific evening-to-dinner conversion.
      const donorWords = donorTokens.map(token => token.canonical ?? token.lower);
      for (let index = 0; index < donorWords.length; index += 1) {
        const governingEvent = resolveEventTimingExpression(donorWords, index);
        if (!governingEvent || governingEvent.length < 2 ||
            governingEvent.timing !== donorBase) continue;
        const sharedHead = donorWords.slice(index, index + governingEvent.length - 1);
        for (const token of recipientTokens) {
          const word = token.canonical ?? token.lower;
          if (EVENT_TIMING_TOKENS[word] !== bare) continue;
          const composite = resolveEventTimingExpression([...sharedHead, word]);
          if (composite?.length !== sharedHead.length + 1) continue;
          const candidate = eventMap.get(composite.timing);
          if (!candidate) continue;
          mapped = candidate;
          break;
        }
        if (mapped) break;
      }
    }
    if (!mapped || mapped === bare) continue;
    recipient.when = [mapped];
    const inherited: ScheduleSemanticField[] = ['when'];
    if (recipient.offset === undefined &&
        recipient.offsetMin === undefined && recipient.offsetMax === undefined) {
      for (const field of ['offset', 'offsetMin', 'offsetMax'] as const) {
        const value = donor[field];
        if (value === undefined) continue;
        recipient[field] = value;
        inherited.push(field);
      }
    }
    return inherited;
  }
  return [];
}

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

function hasEvidence(clause: CanonicalSigClause, category: CanonicalLexicalCategory): boolean {
  return clause.evidence.some(item => item.lexicalCategory === category);
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

type ScheduleSemanticField = CanonicalScheduleSemanticField;
type ScheduleFeatureGroup = keyof typeof SCHEDULE_FEATURE_GROUPS;

/**
 * Schedule semantics move through coordination in dependency-closed groups.
 * In particular, an event anchor never loses its offset and a recurrence
 * never loses its total/per-period occurrence limit. The compile-time
 * coverage assertion makes a newly added canonical field fail here instead
 * of being silently omitted by a hand-maintained cadence copier.
 */
const SCHEDULE_FEATURE_GROUPS = {
  recurrence: [
    'timingCode', 'count', 'countMax', 'frequency', 'frequencyMax',
    'period', 'periodMax', 'periodUnit', 'dayOfWeek', 'dayOfMonth', 'timeOfDay',
    'occurrenceCap', 'maxDosePerPeriod', 'eventWindow', 'clockWindow', 'weekdayOrdinal'
  ],
  eventAnchor: ['when', 'offset', 'offsetMin', 'offsetMax', 'activityTiming'],
  courseBounds: ['duration', 'durationMax', 'durationUnit', 'boundsStart', 'boundsEnd'],
  administrationDuration: [
    'administrationDuration', 'administrationDurationMax', 'administrationDurationUnit'
  ],
  calendarEvents: ['calendarEvents', 'cycleDayConstraint'],
  // A derived per-administration dependency is not a lexical trailing cadence.
  administrationDependency: ['administrationOffsetMinutes'],
  // A source anaphor is a typed request to the regimen donor, not an
  // executable inherited recurrence. Resolve before lowering to FHIR.
  sourceTimingReference: ['timingReference'],
  sourcePhaseStart: ['treatmentStartOffsetDays'],
  regimenCycle: ['repeatCycle', 'repeatCount']
} as const satisfies Record<string, readonly ScheduleSemanticField[]>;

// The feature inventory is static; don't allocate its keys for every scope probe.
const SCHEDULE_GROUP_NAMES = Object.keys(SCHEDULE_FEATURE_GROUPS) as ScheduleFeatureGroup[];

type GroupedScheduleField = (typeof SCHEDULE_FEATURE_GROUPS)[ScheduleFeatureGroup][number];
const scheduleFeatureCoverage: Exclude<ScheduleSemanticField, GroupedScheduleField> extends never
  ? true : never = true;
void scheduleFeatureCoverage;

const COORDINATED_ANCHOR_FIELDS = ['when', 'timeOfDay'] as const;
const COORDINATED_ANCHOR_CONTEXT_FIELDS = [
  'duration', 'durationMax', 'durationUnit', 'boundsStart', 'boundsEnd',
  'administrationDuration', 'administrationDurationMax', 'administrationDurationUnit',
  'dayOfWeek', 'dayOfMonth', 'weekdayOrdinal', 'calendarEvents', 'cycleDayConstraint'
] as const satisfies readonly ScheduleSemanticField[];
const NON_ANCHOR_SCHEDULE_FIELDS = [
  'timingCode', 'count', 'countMax', 'frequency', 'frequencyMax',
  'period', 'periodMax', 'periodUnit', 'offset', 'offsetMin', 'offsetMax',
  'activityTiming', 'eventWindow', 'clockWindow', 'occurrenceCap', 'maxDosePerPeriod', 'administrationOffsetMinutes',
  'timingReference', 'treatmentStartOffsetDays', 'repeatCycle', 'repeatCount'
] as const satisfies readonly ScheduleSemanticField[];
type CoordinatedScheduleField =
  | (typeof COORDINATED_ANCHOR_FIELDS)[number]
  | (typeof COORDINATED_ANCHOR_CONTEXT_FIELDS)[number]
  | (typeof NON_ANCHOR_SCHEDULE_FIELDS)[number];
const coordinatedScheduleCoverage:
  Exclude<ScheduleSemanticField, CoordinatedScheduleField> extends never ? true : never = true;
void coordinatedScheduleCoverage;

function cloneScheduleField(
  schedule: CanonicalScheduleExpr,
  field: ScheduleSemanticField
): unknown {
  const value = schedule[field];
  if (!Array.isArray(value)) {
    return value && typeof value === 'object' ? { ...value } : value;
  }
  if (field === 'activityTiming') {
    return schedule.activityTiming?.map(item => ({
      ...item,
      activity: {
        ...item.activity,
        i18n: item.activity.i18n ? { ...item.activity.i18n } : undefined,
        coding: item.activity.coding ? { ...item.activity.coding } : undefined
      }
    }));
  }
  if (field === 'calendarEvents') {
    return schedule.calendarEvents?.map(item => ({ ...item }));
  }
  if (field === 'maxDosePerPeriod') {
    return schedule.maxDosePerPeriod?.map(item => ({ ...item }));
  }
  return [...value];
}

function scheduleFieldValue(
  schedule: CanonicalScheduleExpr | undefined,
  field: ScheduleSemanticField
): unknown {
  return schedule?.[field];
}

function hasSemanticValue(value: unknown): boolean {
  return value !== undefined && (!Array.isArray(value) || value.length > 0);
}

function scheduleHasSemantics(schedule: CanonicalScheduleExpr | undefined): boolean {
  return SCHEDULE_GROUP_NAMES.some(group =>
    SCHEDULE_FEATURE_GROUPS[group].some(field =>
      hasSemanticValue(scheduleFieldValue(schedule, field)))
  );
}

interface ScheduleMergeResult {
  schedule?: CanonicalScheduleExpr;
  fields: string[];
  groups: Set<ScheduleFeatureGroup>;
}

/** Merge whole typed feature groups while preserving explicit local groups. */
function mergeScheduleFeatureGroups(
  recipient: CanonicalScheduleExpr | undefined,
  donor: CanonicalScheduleExpr | undefined,
  eligibleGroups: readonly ScheduleFeatureGroup[] = SCHEDULE_GROUP_NAMES
): ScheduleMergeResult {
  if (!scheduleHasSemantics(donor)) {
    return { schedule: recipient, fields: [], groups: new Set() };
  }
  const schedule: CanonicalScheduleExpr = { ...(recipient ?? {}) };
  const writable = schedule as unknown as Record<string, unknown>;
  const fields: string[] = [];
  const groups = new Set<ScheduleFeatureGroup>();

  for (const group of eligibleGroups) {
    const groupFields = SCHEDULE_FEATURE_GROUPS[group];
    const donorFields = groupFields.filter(field =>
      hasSemanticValue(scheduleFieldValue(donor, field))
    );
    if (!donorFields.length) continue;
    const recipientFields = groupFields.filter(field =>
      hasSemanticValue(scheduleFieldValue(recipient, field))
    );

    // A local bound, event anchor, administration duration or explicit-date
    // group owns that group. Recurrence is compositional: a local total cap
    // can safely combine with a donor cadence, but conflicting values cannot.
    if (group !== 'recurrence' && recipientFields.length) continue;
    if (group === 'recurrence' && donorFields.some(field => {
      const local = scheduleFieldValue(recipient, field);
      return hasSemanticValue(local) &&
        !equalStructuredValues(local, scheduleFieldValue(donor, field));
    })) continue;

    for (const field of donorFields) {
      if (hasSemanticValue(scheduleFieldValue(recipient, field))) continue;
      writable[field] = cloneScheduleField(donor!, field);
      fields.push(field);
    }
    if (fields.some(field => (groupFields as readonly string[]).indexOf(field) >= 0)) {
      groups.add(group);
    }
  }
  return { schedule, fields, groups };
}

function targetKey(clause: CanonicalSigClause): string | undefined {
  const coding = clause.site?.coding;
  if (coding?.code) return `${coding.system ?? ''}|${coding.code}`;
  const text = clause.site?.text?.trim().toLocaleLowerCase().replace(/\s+/gu, ' ');
  return text || undefined;
}

function shiftEvidenceToRecipient(
  evidence: CanonicalEvidence,
  donorStart: number,
  recipientStart: number
): CanonicalEvidence {
  const shifted: CanonicalEvidence = {
    ...evidence,
    spans: evidence.spans.map(span => ({
      start: span.start + donorStart - recipientStart,
      end: span.end + donorStart - recipientStart,
      text: span.text
    }))
  };
  if (evidence.scheduleFields) shifted.scheduleFields = [...evidence.scheduleFields];
  return shifted;
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

function cloneEvidence(evidence: CanonicalEvidence): CanonicalEvidence {
  const clone: CanonicalEvidence = {
    ...evidence,
    spans: evidence.spans.map(span => ({
      ...span,
      tokenIndices: span.tokenIndices ? [...span.tokenIndices] : undefined
    }))
  };
  if (evidence.scheduleFields) clone.scheduleFields = [...evidence.scheduleFields];
  return clone;
}

function scheduleEvidenceGroups(evidence: CanonicalEvidence): readonly ScheduleFeatureGroup[] {
  if (!evidence.scheduleFields?.length) return [];
  const groups: ScheduleFeatureGroup[] = [];
  for (const group of SCHEDULE_GROUP_NAMES) {
    const groupFields = SCHEDULE_FEATURE_GROUPS[group] as readonly ScheduleSemanticField[];
    if (evidence.scheduleFields.some(field => groupFields.indexOf(field) >= 0)) {
      groups.push(group);
    }
  }
  return groups;
}

function sourceScheduleEvidence(
  clause: CanonicalSigClause,
  copiedGroups: ReadonlySet<ScheduleFeatureGroup>
): CanonicalEvidence[] {
  const evidence: CanonicalEvidence[] = [];
  for (const item of clause.schedule?.evidence ?? []) {
    if (scheduleEvidenceGroups(item).some(group => copiedGroups.has(group))) {
      appendEvidence(evidence, item);
    }
  }
  for (const item of clause.evidence) {
    if (item.scheduleFields?.length &&
        scheduleEvidenceGroups(item).some(group => copiedGroups.has(group))) {
      appendEvidence(evidence, item);
    }
  }
  return evidence;
}

function evidenceBounds(
  clause: CanonicalSigClause,
  category: CanonicalLexicalCategory | 'schedule'
): { start: number; end: number } | undefined {
  let start = Infinity;
  let end = -Infinity;
  for (const evidence of clause.evidence) {
    const contributes = category === 'schedule'
      ? Boolean(evidence.scheduleFields?.length)
      : evidence.lexicalCategory === category;
    if (!contributes) continue;
    for (const span of evidence.spans) {
      if (span.start < start) start = span.start;
      if (span.end > end) end = span.end;
    }
  }
  return start === Infinity ? undefined : { start, end };
}

function isFrontedEvidence(clause: CanonicalSigClause, category: 'schedule' | 'prn'): boolean {
  const adjunct = evidenceBounds(clause, category);
  const head = evidenceBounds(clause, 'method') ??
    evidenceBounds(clause, 'dose');
  return Boolean(adjunct && head && adjunct.end <= head.start);
}

function isTrailingEvidence(clause: CanonicalSigClause, category: 'schedule' | 'prn'): boolean {
  const adjunct = evidenceBounds(clause, category);
  const dose = evidenceBounds(clause, 'dose');
  return Boolean(adjunct && dose && adjunct.start >= dose.end);
}

function scheduleGroupEvidenceBounds(
  clause: CanonicalSigClause,
  group: ScheduleFeatureGroup
): { start: number; end: number } | undefined {
  const groupFields = SCHEDULE_FEATURE_GROUPS[group] as readonly ScheduleSemanticField[];
  let start = Infinity;
  let end = -Infinity;
  for (const evidence of [...(clause.schedule?.evidence ?? []), ...clause.evidence]) {
    if (!evidence.scheduleFields?.some(field => groupFields.indexOf(field) >= 0)) continue;
    for (const span of evidence.spans) {
      if (span.start < start) start = span.start;
      if (span.end > end) end = span.end;
    }
  }
  return start === Infinity ? undefined : { start, end };
}

function hasCourseDuration(schedule: CanonicalScheduleExpr | undefined): boolean {
  return Boolean(schedule?.duration !== undefined && schedule.durationUnit);
}

/**
 * Materialize the one-week bound only after the planner has licensed a
 * consecutive ordinal-week treatment sequence. The lexical header remains
 * source-typed on its own, but a lone `Week N` never fabricates a course.
 */
function materializeOrdinalWeekStageDurations(
  states: readonly CoordinatedClauseState[],
  plan: BoundaryPlan
): void {
  if (!plan.relations.some(relation => relation.rule === 'regimen.ordinal-week-stage' &&
      relation.kind === 'sequence')) return;
  let scope: { state: CoordinatedClauseState; header: NonNullable<ReturnType<typeof ordinalWeekStageHeaderAt>> } | undefined;
  for (const clauseState of states) {
    const clause = clauseState.state.primaryClause;
    const header = ordinalWeekStageHeaderAt(clauseState.state.tokens, 0);
    if (header) scope = { state: clauseState, header };
    else if (scope) {
      const segmentIndex = plan.segments.findIndex(segment =>
        segment.start === clauseState.start && segment.end === clauseState.end);
      const incoming = plan.relations.find(relation => relation.to === segmentIndex);
      // An unlabelled sequential stage is outside the preceding header.
      // Only its parallel/coordinate daughters remain in that week's scope.
      if (incoming?.kind === 'sequence') scope = undefined;
    }
    // A week header scopes the entire following coordinated/parallel stage,
    // not just the last dose touching its outgoing sequence boundary.
    // Keep explicit local bounds and an open-ended final stage intact.
    if (!scope || scope.header.openEnded || hasCourseDuration(clause.schedule)) continue;
    const offset = scope.state.start - clauseState.start;
    const evidence: CanonicalEvidence = {
      rule: 'hpsg.cx.regimen.ordinal-week-stage-duration',
      spans: [{
        start: scope.header.start + offset,
        end: scope.header.end + offset,
        text: scope.state.state.input.slice(scope.header.start, scope.header.end)
      }],
      scheduleFields: ['duration', 'durationUnit'],
      note: 'A bounded ordinal-week header scopes every administration in its source stage.'
    };
    clause.schedule = {
      ...(clause.schedule ?? {}),
      duration: 1,
      durationUnit: FhirPeriodUnit.Week,
      evidence: [...(clause.schedule?.evidence ?? [])]
    };
    appendEvidence(clause.schedule.evidence!, cloneEvidence(evidence));
    appendEvidence(clause.evidence, evidence);
  }
}

function instructionDurationUnit(unit: string | undefined): FhirPeriodUnit | undefined {
  switch (unit) {
    case FhirPeriodUnit.Second:
    case FhirPeriodUnit.Minute:
    case FhirPeriodUnit.Hour:
    case FhirPeriodUnit.Day:
    case FhirPeriodUnit.Week:
    case FhirPeriodUnit.Month:
    case FhirPeriodUnit.Year:
      return unit;
    default:
      return undefined;
  }
}

/**
 * A positive CONTINUE-TREATMENT action with a typed Duration valence states
 * the course bound of its administration clause. Materialize that typed
 * contribution before coordination selection so the ordinary course-bound
 * construction can distribute it; no instruction wording is reparsed here.
 */
function materializeTypedContinueCourseDuration(clause: CanonicalSigClause): void {
  if (hasCourseDuration(clause.schedule)) return;
  const actions = clause.instructionGraph?.actions;
  if (!actions?.length) return;
  const dose = evidenceBounds(clause, 'dose');
  for (const action of actions) {
    if (action.predicate.lemma !== 'continue-treatment' ||
        action.predicate.semanticClass !== 'course' ||
        action.polarity === AdvicePolarity.Negate ||
        dose && action.span.start < dose.end) continue;
    const duration = action.args.find(argument =>
      argument.role === AdviceArgumentRole.Duration && argument.span
    );
    const unit = instructionDurationUnit(duration?.quantity?.unit);
    const value = duration?.quantity?.value ?? duration?.quantity?.range?.low;
    const valueMax = duration?.quantity?.range?.high;
    if (!duration?.span || !unit || value === undefined ||
        !Number.isFinite(value) || value <= 0 ||
        valueMax !== undefined && (!Number.isFinite(valueMax) || valueMax < value)) continue;

    const evidence: CanonicalEvidence = {
      rule: 'hpsg.cx.instruction.continue-treatment-course-duration',
      spans: [{ ...duration.span, text: duration.text }],
      scheduleFields: valueMax === undefined
        ? ['duration', 'durationUnit']
        : ['duration', 'durationMax', 'durationUnit'],
      note: 'A typed positive continue-treatment action contributes its Duration valence as the regimen course bound.'
    };
    clause.schedule = {
      ...(clause.schedule ?? {}),
      duration: value,
      durationMax: valueMax,
      durationUnit: unit,
      evidence: [...(clause.schedule?.evidence ?? [])]
    };
    appendEvidence(clause.schedule.evidence!, cloneEvidence(evidence));
    appendEvidence(clause.evidence, evidence);
    return;
  }
}

function hasTrailingCourseDurationEvidence(clause: CanonicalSigClause): boolean {
  const duration = scheduleGroupEvidenceBounds(clause, 'courseBounds');
  const head = evidenceBounds(clause, 'dose') ?? scheduleGroupEvidenceBounds(clause, 'eventAnchor');
  // An elliptic event daughter has no dose token, but its explicit timing
  // constituent still establishes where a following course bound attaches.
  return Boolean(duration && head && duration.start >= head.end);
}

function clonePrn(prn: CanonicalPrnExpr): CanonicalPrnExpr {
  const cloneReason = (reason: NonNullable<CanonicalPrnExpr['reason']>) => ({
    ...reason,
    i18n: reason.i18n ? { ...reason.i18n } : undefined,
    spatialRelation: reason.spatialRelation ? { ...reason.spatialRelation } : undefined,
    coding: reason.coding ? {
      ...reason.coding,
      i18n: reason.coding.i18n ? { ...reason.coding.i18n } : undefined,
      extension: reason.coding.extension?.map(item => ({ ...item }))
    } : undefined
  });
  return {
    enabled: prn.enabled,
    reason: prn.reason ? cloneReason(prn.reason) : undefined,
    reasons: prn.reasons?.map(cloneReason),
    evidence: prn.evidence?.map(item => ({
      ...item,
      spans: item.spans.map(span => ({ ...span }))
    }))
  };
}

function sourcePrnEvidence(clause: CanonicalSigClause): CanonicalEvidence[] {
  const evidence: CanonicalEvidence[] = [];
  for (const item of clause.prn?.evidence ?? []) appendEvidence(evidence, item);
  for (const item of clause.evidence) {
    if (item.lexicalCategory === 'prn') appendEvidence(evidence, item);
  }
  return evidence;
}

function factsFor(
  relation: BoundaryRelation,
  left: CoordinatedClauseState,
  right: CoordinatedClauseState,
  inheritedAdministration: boolean
): CoordinationScopeFacts {
  const leftClause = left.state.primaryClause;
  const rightClause = right.state.primaryClause;
  const leftTarget = targetKey(leftClause);
  const rightTarget = targetKey(rightClause);
  return {
    relation,
    adjacent: relation.to === relation.from + 1,
    leftComplete: findUnparsedTokenGroups(left.state).length === 0,
    rightComplete: findUnparsedTokenGroups(right.state).length === 0,
    leftExplicitDose: Boolean(leftClause.dose && hasEvidence(leftClause, 'dose')),
    rightExplicitDose: Boolean(rightClause.dose && hasEvidence(rightClause, 'dose')),
    leftExplicitHead: hasEvidence(leftClause, 'method'),
    leftHasMethod: inheritedAdministration ||
      Boolean(leftClause.method?.coding?.code || leftClause.method?.text),
    // A typed dose and administration site constitute an elliptical
    // administration even without an explicit verb ("1 drop OD"). That
    // licenses a shared trailing cadence across coordinated site doses.
    leftAdministrationContext: hasEvidence(leftClause, 'method') ||
      inheritedAdministration || Boolean(leftClause.dose && leftClause.site),
    rightExplicitHead: hasEvidence(rightClause, 'method'),
    leftHasSite: Boolean(leftTarget),
    rightHasSite: Boolean(rightTarget),
    targetsDistinct: Boolean(leftTarget && rightTarget && leftTarget !== rightTarget),
    leftHasSchedule: scheduleHasSemantics(leftClause.schedule),
    rightHasSchedule: scheduleHasSemantics(rightClause.schedule),
    leftHasCadence: hasCadence(leftClause.schedule),
    rightHasCadence: hasCadence(rightClause.schedule),
    rightHasAdministrationAdjunct: hasAdministrationAdjunct(rightClause),
    leftHasCourseDuration: hasCourseDuration(leftClause.schedule),
    rightHasCourseDuration: hasCourseDuration(rightClause.schedule),
    leftHasPrn: leftClause.prn?.enabled === true,
    rightHasPrn: rightClause.prn?.enabled === true,
    leftHasFrontedSchedule: isFrontedEvidence(leftClause, 'schedule'),
    leftHasFrontedPrn: isFrontedEvidence(leftClause, 'prn'),
    rightHasTrailingSchedule: isTrailingEvidence(rightClause, 'schedule'),
    rightHasTrailingCourseDuration: hasTrailingCourseDurationEvidence(rightClause),
    rightHasTrailingPrn: isTrailingEvidence(rightClause, 'prn'),
    rightHasTrailingSafetyGuard: Boolean(
      (rightClause.clinicalAdjuncts?.condition &&
       rightClause.clinicalAdjuncts.condition.kind !== 'not') ||
      rightClause.clinicalAdjuncts?.excludedDates?.length ||
      rightClause.clinicalAdjuncts?.excludedWeekdays?.length ||
      rightClause.prn?.enabled === true ||
      ((rightClause.leftovers?.length ?? 0) > 0 &&
       ((rightClause.schedule?.dayOfWeek?.length ?? 0) > 0 ||
        (rightClause.schedule?.calendarEvents?.length ?? 0) > 0))
    )
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

function normalizedInstructionText(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[\s,;:.()]+/gu, ' ').trim();
}

function sameRoute(
  left: CanonicalSigClause['route'],
  right: CanonicalSigClause['route']
): boolean {
  if (left?.code && right?.code) return left.code === right.code;
  return normalizedInstructionText(left?.text) === normalizedInstructionText(right?.text);
}

function compatibleMethod(
  left: CanonicalSigClause['method'],
  right: CanonicalSigClause['method']
): boolean {
  const leftPresent = Boolean(left?.coding?.code || left?.text);
  const rightPresent = Boolean(right?.coding?.code || right?.text);
  if (!leftPresent || !rightPresent) return true;
  if (left?.coding?.code && right?.coding?.code) {
    return left.coding.code === right.coding.code &&
      (left.coding.system ?? '') === (right.coding.system ?? '');
  }
  return normalizedInstructionText(left?.text) === normalizedInstructionText(right?.text);
}

function shiftedRange(range: { start: number; end: number }, offset: number) {
  return { start: range.start + offset, end: range.end + offset };
}

function cloneAdviceFrame(frame: AdviceFrame, offset: number): AdviceFrame {
  // Clone the locale records without Object.entries/fromEntries (our output
  // target includes older mobile JavaScript engines).
  const sourceLocales = frame.predicate.realizerConfig?.locales;
  const locales = sourceLocales ? { ...sourceLocales } : undefined;
  if (locales) {
    for (const locale of Object.keys(locales)) {
      locales[locale] = { ...locales[locale] };
    }
  }
  return {
    ...frame,
    predicate: {
      ...frame.predicate,
      i18n: frame.predicate.i18n ? { ...frame.predicate.i18n } : undefined,
      realizerConfig: frame.predicate.realizerConfig
        ? {
          ...frame.predicate.realizerConfig,
          locales
        }
        : undefined,
      codings: frame.predicate.codings?.map(coding => ({ ...coding })),
      semanticComponents: frame.predicate.semanticComponents?.map(part => ({
        role: part.role, coding: { ...part.coding }
      }))
    },
    args: frame.args.map(argument => ({
      ...argument,
      coding: argument.coding ? { ...argument.coding } : undefined,
      codings: argument.codings?.map(coding => ({ ...coding })),
      i18n: argument.i18n ? { ...argument.i18n } : undefined,
      quantity: argument.quantity ? {
        ...argument.quantity,
        range: argument.quantity.range ? { ...argument.quantity.range } : undefined
      } : undefined,
      span: argument.span ? shiftedRange(argument.span, offset) : undefined
    })),
    span: shiftedRange(frame.span, offset),
    coding: frame.coding ? { ...frame.coding } : undefined
  };
}

function cloneInstruction(
  instruction: CanonicalAdditionalInstructionExpr,
  offset: number
): CanonicalAdditionalInstructionExpr {
  return {
    ...instruction,
    i18n: instruction.i18n ? { ...instruction.i18n } : undefined,
    coding: instruction.coding ? { ...instruction.coding } : undefined,
    frames: instruction.frames?.map(frame => cloneAdviceFrame(frame, offset)),
    evidence: instruction.evidence?.map(item => shiftEvidenceToRecipient(item, offset, 0))
  };
}

function terminalSemicolon(clause: CanonicalSigClause): CanonicalSourceSpan | undefined {
  let selected: CanonicalSourceSpan | undefined;
  for (const evidence of clause.evidence) {
    if (evidence.lexicalCategory !== 'connector') continue;
    for (const span of evidence.spans) {
      if (span.text.trim() !== ';') continue;
      if (!selected || span.start > selected.start) selected = span;
    }
  }
  return selected;
}

function trimmedTailSpan(state: ParserState, start: number): CanonicalSourceSpan | undefined {
  let tailStart = start;
  let tailEnd = state.input.length;
  while (tailStart < tailEnd && /\s/u.test(state.input[tailStart])) tailStart++;
  while (tailEnd > tailStart && /\s/u.test(state.input[tailEnd - 1])) tailEnd--;
  if (tailStart >= tailEnd) return undefined;
  return {
    start: tailStart,
    end: tailEnd,
    text: state.input.slice(tailStart, tailEnd)
  };
}

function planSegmentIndex(
  plan: BoundaryPlan,
  segment: { start: number; end: number }
): number | undefined {
  const exact = plan.segments.findIndex(candidate =>
    candidate.start === segment.start && candidate.end === segment.end
  );
  if (exact >= 0) return exact;
  for (let index = plan.segments.length - 1; index >= 0; index -= 1) {
    const candidate = plan.segments[index];
    if (segment.start >= candidate.start && segment.end <= candidate.end) return index;
  }
  return undefined;
}

function sameStringValueSet(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  if ((left?.length ?? 0) !== (right?.length ?? 0)) return false;
  return (left ?? []).every(value => right?.indexOf(value) !== -1);
}

function sameDose(
  left: CanonicalSigClause['dose'],
  right: CanonicalSigClause['dose']
): boolean {
  if (!left || !right) return left === right;
  return left.value === right.value && left.unit === right.unit &&
    equalStructuredValues(left.range, right.range);
}

function sameSite(
  left: CanonicalSigClause['site'],
  right: CanonicalSigClause['site']
): boolean {
  if (!left || !right) return left === right;
  const sameIdentity = left.coding?.code && right.coding?.code
    ? left.coding.code === right.coding.code &&
      (left.coding.system ?? '') === (right.coding.system ?? '')
    : normalizedInstructionText(left.text) === normalizedInstructionText(right.text);
  return Boolean(sameIdentity) &&
    left.administrationTargetCount === right.administrationTargetCount &&
    equalStructuredValues(left.spatialRelation, right.spatialRelation);
}

function hasOnlyTimingAnchorSemantics(clause: CanonicalSigClause, retainAdvice = false): boolean {
  return !clause.provisionalSchedule && !clause.prn?.enabled &&
    !clause.clinicalAdjuncts && !clause.clinicalQuantity &&
    !clause.patientInstruction && !clause.instructionGraph &&
    (retainAdvice || !clause.additionalInstructions?.length) && !clause.leftovers.length;
}

function isAnchorOnlySchedule(schedule: CanonicalScheduleExpr | undefined): boolean {
  if (!schedule || (!schedule.when?.length && !schedule.timeOfDay?.length)) return false;
  return !NON_ANCHOR_SCHEDULE_FIELDS.some(field =>
    hasSemanticValue(scheduleFieldValue(schedule, field))
  );
}

function sameAnchorScheduleContext(
  left: CanonicalScheduleExpr,
  right: CanonicalScheduleExpr
): boolean {
  for (const field of COORDINATED_ANCHOR_CONTEXT_FIELDS) {
    if (field === 'dayOfWeek') {
      if (!sameStringValueSet(left.dayOfWeek, right.dayOfWeek)) return false;
      continue;
    }
    if (!equalStructuredValues(scheduleFieldValue(left, field), scheduleFieldValue(right, field))) {
      return false;
    }
  }
  return true;
}

function uniqueStringValues<T extends string>(values: readonly T[]): T[] {
  const result: T[] = [];
  for (const value of values) {
    if (result.indexOf(value) < 0) result.push(value);
  }
  return result;
}

function addsTimingAnchor(
  left: CanonicalScheduleExpr,
  right: CanonicalScheduleExpr
): boolean {
  return (right.when ?? []).some(value => (left.when?.indexOf(value) ?? -1) < 0) ||
    (right.timeOfDay ?? []).some(value => (left.timeOfDay?.indexOf(value) ?? -1) < 0);
}

function cloneMethodForRecipient(
  method: CanonicalMethodExpr,
  donorStart: number,
  recipientStart: number
): CanonicalMethodExpr {
  return {
    ...method,
    _text: clonePrimitiveElement(method._text),
    coding: method.coding ? {
      ...method.coding,
      _display: clonePrimitiveElement(method.coding._display),
      i18n: cloneI18nRecord(method.coding.i18n),
      extension: cloneExtensions(method.coding.extension)
    } : undefined,
    evidence: method.evidence?.map(item =>
      shiftEvidenceToRecipient(item, donorStart, recipientStart)
    )
  };
}

function appendShiftedEvidence(
  recipient: { evidence?: CanonicalEvidence[] } | undefined,
  donor: { evidence?: CanonicalEvidence[] } | undefined,
  donorStart: number,
  recipientStart: number
): void {
  if (!recipient || !donor?.evidence?.length) return;
  recipient.evidence = [...(recipient.evidence ?? [])];
  for (const item of donor.evidence) {
    appendEvidence(recipient.evidence, shiftEvidenceToRecipient(item, donorStart, recipientStart));
  }
}

function appendDonorTokens(
  recipient: ParserState,
  donor: ParserState,
  offset: number
): void {
  for (const token of donor.tokens) {
    const index = recipient.tokens.length;
    recipient.tokens.push({
      ...token,
      index,
      sourceStart: token.sourceStart + offset,
      sourceEnd: token.sourceEnd + offset,
      surfaceIndices: [...token.surfaceIndices]
    });
    if (donor.consumed.has(token.index)) recipient.consumed.add(index);
  }
}

function relationBetweenSegments(
  plan: BoundaryPlan,
  left: HpsgSigSegment,
  right: HpsgSigSegment
): { relation?: BoundaryRelation; sameSourceExpansion: boolean } {
  const leftIndex = planSegmentIndex(plan, left);
  const rightIndex = planSegmentIndex(plan, right);
  const sameSourceExpansion = leftIndex !== undefined && leftIndex === rightIndex &&
    left.start === right.start && left.end === right.end;
  if (sameSourceExpansion || leftIndex === undefined || rightIndex === undefined) {
    return { sameSourceExpansion };
  }
  return {
    relation: plan.relations.find(candidate =>
      candidate.from === leftIndex && candidate.to === rightIndex
    ),
    sameSourceExpansion: false
  };
}

export interface TimingAnchorCompositionApplication {
  rule: 'hpsg.cx.regimen.coordinated-timing-anchors' | 'hpsg.cx.regimen.interval-origin';
  recipient: number;
  donor: number;
  fields: Array<ScheduleSemanticField | 'method'>;
}

export interface TimingAnchorCompositionResult {
  absorbed: Set<number>;
  applications: TimingAnchorCompositionApplication[];
}

/**
 * A sequential phase may inherit predecessor anchors only while its local
 * recurrence leaves them compatible. If a successor explicitly changes the
 * daily frequency, a differently sized predecessor clock list is no longer
 * a valid ellipsis. The predecessor retains its clocks and source evidence;
 * only the derived recipient copy is withdrawn.
 */
function removeConflictingInheritedClockLists(states: readonly ParserState[]): void {
  for (const state of states) {
    const clause = state.primaryClause;
    const schedule = clause.schedule;
    if (!schedule?.timeOfDay?.length || schedule.frequency === undefined ||
        schedule.frequency === schedule.timeOfDay.length) continue;
    const inheritedBySequence = schedule.evidence?.some(item =>
      item.rule === 'regimen.sequence.whole-predecessor-phase'
    );
    if (!inheritedBySequence) continue;
    const localClockEvidence = schedule.evidence?.some(item =>
      item.scheduleFields?.indexOf('timeOfDay') !== -1 &&
      item.spans.some(span => span.start >= 0 && span.end <= state.input.length)
    );
    if (localClockEvidence) continue;
    delete schedule.timeOfDay;
    schedule.evidence = schedule.evidence?.filter(item =>
      !(item.scheduleFields?.indexOf('timeOfDay') !== -1 &&
        item.spans.every(span => span.end <= 0 || span.start >= state.input.length))
    );
    appendEvidence(schedule.evidence ?? (schedule.evidence = []), {
      rule: 'hpsg.cx.regimen.explicit-frequency-resets-inherited-clocks',
      spans: [],
      note: 'The successor explicit frequency conflicts with the predecessor clock count, so the derived clock-list ellipsis is not licensed.'
    });
  }
}

/**
 * Compose equivalent typed administration daughters before FHIR lowering.
 * Only clock/event anchors may differ; every other schedule and administration
 * feature must already unify, so independent routes, sites and phases survive.
 */
export function composeCoordinatedTimingAnchors(
  states: readonly ParserState[],
  plan: BoundaryPlan,
  segments: readonly HpsgSigSegment[],
  source: string
): TimingAnchorCompositionResult {
  removeConflictingInheritedClockLists(states);
  const absorbed = new Set<number>();
  const applications: TimingAnchorCompositionApplication[] = [];
  let recipientIndex = 0;

  for (let donorIndex = 1; donorIndex < states.length; donorIndex += 1) {
    const recipient = states[recipientIndex];
    const donor = states[donorIndex];
    const recipientSegment = segments[recipientIndex];
    const priorSegment = segments[donorIndex - 1];
    const donorSegment = segments[donorIndex];
    if (!recipient || !donor || !recipientSegment || !priorSegment || !donorSegment) {
      recipientIndex = donorIndex;
      continue;
    }
    const recipientClause = recipient.primaryClause;
    const donorClause = donor.primaryClause;
    const recipientSchedule = recipientClause.schedule;
    const donorSchedule = donorClause.schedule;
    const relation = relationBetweenSegments(plan, priorSegment, donorSegment);
    const originOfRightInterval = Boolean(
      relation.relation?.semanticLicense === 'interval-origin' &&
      recipientSchedule?.when?.length === 1 && donorSchedule?.eventWindow &&
      recipientSchedule.when[0] === donorSchedule.eventWindow.start &&
      !donorSchedule.when?.length && !donorSchedule.timeOfDay?.length &&
      donorSchedule.period && donorSchedule.period > 0 &&
      (donorSchedule.periodUnit === 'h' || donorSchedule.periodUnit === 'min' ||
       donorSchedule.periodUnit === 's')
    );
    const selected = selectHpsgTimingAnchorCoordinationConstruction({
      relation: relation.relation,
      sameSourceExpansion: relation.sameSourceExpansion,
      adjacent: true,
      leftComplete: findUnparsedTokenGroups(recipient).length === 0,
      rightComplete: findUnparsedTokenGroups(donor).length === 0,
      sameAdministration: !recipient.siteLookups.length && !donor.siteLookups.length &&
        !recipient.prnReasonLookups.length && !donor.prnReasonLookups.length &&
        hasOnlyTimingAnchorSemantics(recipientClause) &&
        hasOnlyTimingAnchorSemantics(donorClause, originOfRightInterval) &&
        sameDose(recipientClause.dose, donorClause.dose) &&
        sameRoute(recipientClause.route, donorClause.route) &&
        sameSite(recipientClause.site, donorClause.site),
      compatibleMethod: compatibleMethod(recipientClause.method, donorClause.method),
      leftHasMethod: Boolean(recipientClause.method?.coding?.code || recipientClause.method?.text),
      rightHasMethod: Boolean(donorClause.method?.coding?.code || donorClause.method?.text),
      leftAnchorOnly: isAnchorOnlySchedule(recipientSchedule),
      rightAnchorOnly: isAnchorOnlySchedule(donorSchedule),
      sameScheduleContext: Boolean(recipientSchedule && donorSchedule &&
        sameAnchorScheduleContext(recipientSchedule, donorSchedule)),
      addsAnchor: Boolean(recipientSchedule && donorSchedule &&
        addsTimingAnchor(recipientSchedule, donorSchedule)),
      originOfRightInterval
    });
    if (!selected || !recipientSchedule || !donorSchedule) {
      recipientIndex = donorIndex;
      continue;
    }

    const donorOffset = donorSegment.start - recipientSegment.start;
    const fields: TimingAnchorCompositionApplication['fields'] = [];
    if (selected.scheduleComposition === 'right-interval') {
      // The first event is already an occurrence of this exact interval.
      // Compose source semantics once; do not deduplicate unrelated doses
      // in the executor or fabricate a second waking administration.
      recipientClause.schedule = cloneStructuredValue(donorSchedule);
      recipientClause.schedule.evidence = [...(recipientSchedule.evidence ?? [])];
      recipientClause.additionalInstructions = donorClause.additionalInstructions
        ? cloneStructuredValue(donorClause.additionalInstructions) : undefined;
      fields.push('period', 'periodUnit', 'eventWindow');
    } else {
      const when = uniqueStringValues([
        ...(recipientSchedule.when ?? []),
        ...(donorSchedule.when ?? [])
      ]);
      const timeOfDay = uniqueStringValues([
        ...(recipientSchedule.timeOfDay ?? []),
        ...(donorSchedule.timeOfDay ?? [])
      ]).sort();
      if (when.length) fields.push('when');
      if (timeOfDay.length) fields.push('timeOfDay');
      recipientClause.schedule = {
        ...recipientSchedule,
        ...(when.length ? { when } : {}),
        ...(timeOfDay.length ? { timeOfDay } : {}),
        evidence: [...(recipientSchedule.evidence ?? [])]
      };
    }
    appendShiftedEvidence(
      recipientClause.schedule,
      donorSchedule,
      donorSegment.start,
      recipientSegment.start
    );

    if (!recipientClause.method && donorClause.method) {
      recipientClause.method = cloneMethodForRecipient(
        donorClause.method,
        donorSegment.start,
        recipientSegment.start
      );
      fields.push('method');
    } else {
      appendShiftedEvidence(
        recipientClause.method,
        donorClause.method,
        donorSegment.start,
        recipientSegment.start
      );
    }
    appendShiftedEvidence(recipientClause.dose, donorClause.dose,
      donorSegment.start, recipientSegment.start);
    appendShiftedEvidence(recipientClause.route, donorClause.route,
      donorSegment.start, recipientSegment.start);
    appendShiftedEvidence(recipientClause.site, donorClause.site,
      donorSegment.start, recipientSegment.start);

    for (const item of donorClause.evidence) {
      appendEvidence(recipientClause.evidence,
        shiftEvidenceToRecipient(item, donorSegment.start, recipientSegment.start));
    }
    const constructionEvidence: CanonicalEvidence = {
      rule: selected.id,
      spans: [
        ...(relation.relation && relation.relation.range.end > relation.relation.range.start
          ? [{
            start: relation.relation.range.start - recipientSegment.start,
            end: relation.relation.range.end - recipientSegment.start,
            text: source.slice(relation.relation.range.start, relation.relation.range.end)
          }]
          : []),
        {
          start: donorSegment.start - recipientSegment.start,
          end: donorSegment.end - recipientSegment.start,
          text: source.slice(donorSegment.start, donorSegment.end)
        }
      ],
      note: 'Equivalent administration daughters contribute coordinated timing anchors.'
    };
    appendEvidence(recipientClause.schedule.evidence!, cloneEvidence(constructionEvidence));
    appendEvidence(recipientClause.evidence, cloneEvidence(constructionEvidence));

    const combinedText = source.slice(recipientSegment.start, donorSegment.end);
    recipient.input = combinedText;
    recipientClause.rawText = combinedText;
    recipientClause.raw = { start: 0, end: combinedText.length, text: combinedText };
    recipientClause.span = { start: 0, end: combinedText.length };
    shiftCanonicalSigClauses(donor.clauses, donorOffset);
    recipient.clauses.push(...donor.clauses);
    appendDonorTokens(recipient, donor, donorOffset);
    for (const warning of donor.warnings) {
      if (recipient.warnings.indexOf(warning) < 0) recipient.warnings.push(warning);
    }

    absorbed.add(donorIndex);
    applications.push({ rule: selected.id, recipient: recipientIndex, donor: donorIndex, fields });
  }

  return { absorbed, applications };
}

function relationPathsTo(
  plan: BoundaryPlan,
  terminal: number
): Map<number, BoundaryRelation[]> {
  const paths = new Map<number, BoundaryRelation[]>([[terminal, []]]);
  for (let pass = 0; pass < plan.segments.length; pass += 1) {
    let changed = false;
    for (let index = plan.relations.length - 1; index >= 0; index -= 1) {
      const relation = plan.relations[index];
      const suffix = paths.get(relation.to);
      if (!suffix || paths.has(relation.from)) continue;
      paths.set(relation.from, [relation, ...suffix]);
      changed = true;
    }
    if (!changed) break;
  }
  return paths;
}

/**
 * Scope a semicolon-terminal negative instruction over compatible dosage
 * daughters before FHIR lowering. The HPSG action licenses the adjunct, and
 * the boundary graph supplies its regimen path; no surface text is reparsed.
 */
export function scopeTrailingSharedNegativeInstructions(
  states: readonly ParserState[],
  plan: BoundaryPlan,
  segments: readonly { start: number; end: number }[],
  source: string
): void {
  if (states.length < 2) return;
  const donorIndex = states.length - 1;
  const donor = states[donorIndex];
  const donorClause = donor.primaryClause;
  const separator = terminalSemicolon(donorClause);
  if (!separator) return;
  const tail = trimmedTailSpan(donor, separator.end);
  if (!tail) return;
  const negativeActions = (donorClause.instructionGraph?.actions ?? []).filter(action =>
    action.polarity === AdvicePolarity.Negate && action.span.start >= separator.end
  );
  if (!negativeActions.length) return;
  const tailText = normalizedInstructionText(tail.text);
  const shared = (donorClause.additionalInstructions ?? []).filter(instruction => {
    const text = normalizedInstructionText(instruction.text);
    return Boolean(text && tailText.includes(text) && instruction.frames?.some(frame =>
      frame.polarity === AdvicePolarity.Negate && frame.span.start >= separator.end
    ));
  });
  if (!shared.length) return;
  // Share the predicate only when it is source-owned by this same untargeted
  // prohibition. A selected clock/daypart is handled by nominal target scope,
  // never widened merely because its readable instruction is also retained.
  const donorClinical = donorClause.clinicalAdjuncts;
  const target = donorClinical?.conditionTarget;
  const selectedTarget = target && (target.when?.length || target.timeOfDay?.length ||
    target.clockRange || target.quantifier);
  const sharedGuard = donorClinical?.condition?.kind === 'not' &&
    !selectedTarget && donorClinical.localRanges?.length &&
    donorClinical.localRanges.every(range => tail.start <= range.start && range.end <= tail.end)
    ? donorClinical : undefined;

  const localEvidence: CanonicalEvidence = {
    rule: 'hpsg.cx.instruction.semicolon-trailing-negative-adjunct',
    spans: [{ ...tail }]
  };
  for (const instruction of shared) {
    instruction.evidence = [...(instruction.evidence ?? [])];
    appendEvidence(instruction.evidence, cloneEvidence(localEvidence));
  }

  const terminalPlanIndex = planSegmentIndex(plan, segments[donorIndex]);
  if (terminalPlanIndex === undefined) return;
  const paths = relationPathsTo(plan, terminalPlanIndex);
  for (let recipientIndex = 0; recipientIndex < donorIndex; recipientIndex += 1) {
    const recipientPlanIndex = planSegmentIndex(plan, segments[recipientIndex]);
    const path = recipientPlanIndex === undefined ? undefined : paths.get(recipientPlanIndex);
    const recipient = states[recipientIndex];
    const targetClause = recipient.primaryClause;
    const selected = grammaticalTrailingInstructionScope({
      localNegativeAction: true,
      semicolonDelimited: true,
      related: Boolean(path),
      sameRoute: sameRoute(targetClause.route, donorClause.route),
      compatibleMethod: compatibleMethod(targetClause.method, donorClause.method),
      relationPath: path ?? []
    });
    if (!selected) continue;

    const additions = shared.filter(instruction =>
      !targetClause.additionalInstructions?.some(existing =>
        normalizedInstructionText(existing.text) === normalizedInstructionText(instruction.text)
      )
    );
    if (!additions.length && !sharedGuard) continue;
    const donorOffset = segments[donorIndex].start - segments[recipientIndex].start;
    const scopeEvidence: CanonicalEvidence = {
      rule: selected.construction.id,
      spans: [
        ...(path ?? []).filter(relation => relation.range.end > relation.range.start).map(relation => ({
          start: relation.range.start - segments[recipientIndex].start,
          end: relation.range.end - segments[recipientIndex].start,
          text: source.slice(relation.range.start, relation.range.end)
        })),
        {
          start: tail.start + donorOffset,
          end: tail.end + donorOffset,
          text: tail.text
        }
      ],
      note: 'The terminal negative instruction scopes over this related compatible dosage clause.'
    };
    const inherited = additions.map(instruction => {
      const clone = cloneInstruction(instruction, donorOffset);
      if (donorClause.instructionGraph?.sourceLocale?.toLowerCase().startsWith('th') &&
          clone.text && /[\u0E00-\u0E7F]/u.test(clone.text)) {
        clone.i18n = { ...(clone.i18n ?? {}), th: clone.text };
      }
      clone.evidence = [...(clone.evidence ?? [])];
      appendEvidence(clone.evidence, cloneEvidence(scopeEvidence));
      return clone;
    });
    targetClause.additionalInstructions = [
      ...(targetClause.additionalInstructions ?? []),
      ...inherited
    ];
    if (sharedGuard?.condition) {
      const clinical = targetClause.clinicalAdjuncts ?? (targetClause.clinicalAdjuncts = {});
      const prior = clinical.condition;
      const alreadyShared = prior && equalStructuredValues(prior, sharedGuard.condition);
      const dayConstant = sharedGuard.calendarDayCondition &&
        equalStructuredValues(sharedGuard.calendarDayCondition, sharedGuard.condition) &&
        (!prior || alreadyShared || equalStructuredValues(clinical.calendarDayCondition, prior));
      clinical.condition = !prior || alreadyShared
        ? cloneStructuredValue(sharedGuard.condition)
        : { kind: 'all', conditions: [prior, cloneStructuredValue(sharedGuard.condition)] };
      if (dayConstant) clinical.calendarDayCondition = cloneStructuredValue(clinical.condition);
      else delete clinical.calendarDayCondition;
      // These are inherited source spans, not local text in the recipient.
      const guardEvidence: CanonicalEvidence = {
        rule: selected.construction.id,
        spans: sharedGuard.localRanges!.map(range => ({
          start: range.start + donorOffset, end: range.end + donorOffset,
          text: donor.input.slice(range.start, range.end)
        })),
        note: 'The source-shared negative instruction carries its already typed administration predicate.'
      };
      clinical.evidence = [...(clinical.evidence ?? [])];
      appendEvidence(clinical.evidence, guardEvidence);
      appendEvidence(targetClause.evidence, cloneEvidence(guardEvidence));
    }
    for (const instruction of inherited) {
      for (const evidence of instruction.evidence ?? []) {
        appendEvidence(targetClause.evidence, cloneEvidence(evidence));
      }
    }
  }
}

/**
 * Bind a typed medication-dose nominal reference to its related administration
 * daughters. The HPSG conditional has already supplied predicate, polarity,
 * quantifier and event membership; this construction never reads source words,
 * production-rule names, FHIR rows, or rendered text to decide clinical scope.
 * An unspecified object stays local; an explicit daypart selects matching
 * daughters; a universal/both quantifier scopes only over the connected regimen.
 */
/** Match a typed nominal selector to already supplied administration anchors.
 * @param schedule Source-owned explicit times and events.
 * @param target Typed nominal reference; no missing clock is fabricated.
 */
function selectedConditionAnchors(
  schedule: CanonicalScheduleExpr | undefined,
  target: NonNullable<NonNullable<CanonicalSigClause["clinicalAdjuncts"]>["conditionTarget"]>
): { times: string[]; events: NonNullable<CanonicalScheduleExpr["when"]> } {
  const times = (schedule?.timeOfDay ?? []).filter(clock => (target.timeOfDay?.indexOf(clock) ?? -1) >= 0);
  if (!times.length && target.clockRange && !target.timeOfDay?.length) {
    const range = target.clockRange;
    const within = (schedule?.timeOfDay ?? []).filter(clock => {
      const hour = Number(clock.slice(0, 2));
      return hour >= range.startHour && hour < range.endHour;
    });
    // A singular daypart dose must have a unique existing clock antecedent.
    if (within.length === 1) times.push(within[0]);
  }
  const events = (schedule?.when ?? []).filter(event => (target.when?.indexOf(event) ?? -1) >= 0);
  return { times, events };
}

/** Partition an already typed multi-anchor administration before applying a
 * selective adjunct. Source segments and phase identity remain identical.
 * @param states Canonical source states, never FHIR or rendered instructions.
 * @param segments Matching source provenance for each administration.
 * @param target Existing dose-nominal selection supplied by the HPSG frame.
 * @param donorIndex Source state carrying the selective instruction.
 */
function partitionConditionTargetStates(
  states: ParserState[], segments: HpsgSigSegment[], plan: BoundaryPlan,
  target: NonNullable<NonNullable<CanonicalSigClause["clinicalAdjuncts"]>["conditionTarget"]>,
  donorIndex: number
): number {
  if (!target.when?.length && !target.timeOfDay?.length && !target.clockRange) return donorIndex;
  const terminal = planSegmentIndex(plan, segments[donorIndex]);
  const paths = terminal === undefined ? undefined : relationPathsTo(plan, terminal);
  for (let index = 0; index <= donorIndex; index++) {
    if (index !== donorIndex) {
      const member = planSegmentIndex(plan, segments[index]);
      if (member === undefined || !paths?.has(member)) continue;
    }
    const state = states[index], schedule = state.primaryClause.schedule;
    if (!schedule) continue;
    const selected = selectedConditionAnchors(schedule, target);
    const total = (schedule.timeOfDay?.length ?? 0) + (schedule.when?.length ?? 0);
    const count = selected.times.length + selected.events.length;
    if (!count || count === total) continue;
    const selectedState = new ParserState(state.input, state.tokens, state.customSiteHints);
    Object.assign(selectedState.primaryClause, cloneStructuredValue(state.primaryClause));
    selectedState.consumed = new Set(state.consumed);
    selectedState.methodVerb = state.methodVerb;
    selectedState.productFormKey = state.productFormKey;
    selectedState.warnings = [...state.warnings];
    const selectedSchedule = selectedState.primaryClause.schedule!;
    selectedSchedule.timeOfDay = selected.times.length ? selected.times : undefined;
    selectedSchedule.when = selected.events.length ? selected.events : undefined;
    const remainingTimes = (schedule.timeOfDay ?? []).filter(clock => selected.times.indexOf(clock) < 0);
    const remainingEvents = (schedule.when ?? []).filter(event => selected.events.indexOf(event) < 0);
    schedule.timeOfDay = remainingTimes.length ? remainingTimes : undefined;
    schedule.when = remainingEvents.length ? remainingEvents : undefined;
    if (schedule.frequency === total && schedule.period === 1 && schedule.periodUnit === 'd') {
      schedule.frequency = total - count;
      selectedSchedule.frequency = count;
    }
    if (index === donorIndex) {
      const clinical = state.primaryClause.clinicalAdjuncts;
      if (clinical) {
        delete clinical.condition; delete clinical.conditionTarget;
        delete clinical.excludedWeekdays; delete clinical.excludedDates;
      }
    }
    states.splice(index + 1, 0, selectedState);
    segments.splice(index + 1, 0, segments[index]);
    if (index <= donorIndex) donorIndex++;
    index++;
  }
  return donorIndex;
}

export function scopeMedicationConditionTargets(
  states: ParserState[],
  plan: BoundaryPlan,
  segments: HpsgSigSegment[]
): void {
  for (let donorIndex = 0; donorIndex < states.length; donorIndex += 1) {
    let donor = states[donorIndex];
    let clinical = donor.primaryClause.clinicalAdjuncts;
    const target = clinical?.conditionTarget;
    const predicate = clinical?.condition;
    const excludedWeekdays = clinical?.excludedWeekdays;
    const excludedDates = clinical?.excludedDates;
    if (!target || !predicate && !excludedWeekdays?.length && !excludedDates?.length) continue;
    donorIndex = partitionConditionTargetStates(states, segments, plan, target, donorIndex);
    donor = states[donorIndex];
    clinical = donor.primaryClause.clinicalAdjuncts!;
    const explicitTarget = Boolean(target.when?.length || target.timeOfDay?.length || target.clockRange || target.quantifier);
    const terminal = planSegmentIndex(plan, segments[donorIndex]);
    const paths = explicitTarget && terminal !== undefined
      ? relationPathsTo(plan, terminal) : undefined;
    const selected: number[] = [];
    for (let index = 0; index <= donorIndex; index += 1) {
      if (!explicitTarget && index !== donorIndex) continue;
      if (index !== donorIndex) {
        const member = planSegmentIndex(plan, segments[index]);
        if (member === undefined || !paths?.has(member)) continue;
      }
      const clause = states[index].primaryClause;
      if (!clause.dose && !clause.method && !clause.schedule) continue;
      if (target.when?.length || target.timeOfDay?.length || target.clockRange) {
        const anchors = selectedConditionAnchors(clause.schedule, target);
        if (!anchors.times.length && !anchors.events.length) continue;
      }
      selected.push(index);
    }
    if (!selected.length || target.quantifier === 'both' && selected.length !== 2) {
      // The nominal reference has no unique binding in the available regimen.
      // Keep the original instruction and target reference available for
      // editing, but do not claim an executable predicate on the wrong daughter.
      clinical.condition = { kind: 'text', text: donor.input };
      delete clinical.calendarDayCondition;
      donor.primaryClause.patientInstruction = donor.primaryClause.patientInstruction ?? donor.input;
      const note = 'Unresolved medication-condition target: confirm which administration the instruction refers to.';
      if (donor.warnings.indexOf(note) < 0) donor.warnings.push(note);
      continue;
    }
    delete clinical.condition;
    delete clinical.conditionTarget;
    delete clinical.excludedWeekdays;
    delete clinical.excludedDates;
    for (const index of selected) {
      const recipient = states[index].primaryClause;
      const adjunct = recipient.clinicalAdjuncts ?? (recipient.clinicalAdjuncts = {});
      if (predicate) {
        const prior = adjunct.condition;
        adjunct.condition = prior && !equalStructuredValues(prior, predicate)
          ? { kind: 'all', conditions: [prior, cloneStructuredValue(predicate)] }
          : cloneStructuredValue(predicate);
      }
      if (excludedWeekdays?.length) {
        adjunct.excludedWeekdays = [...new Set([...(adjunct.excludedWeekdays ?? []), ...excludedWeekdays])];
        if (recipient.schedule) {
          const days = recipient.schedule.dayOfWeek ?? [FhirDayOfWeek.Monday, FhirDayOfWeek.Tuesday,
            FhirDayOfWeek.Wednesday, FhirDayOfWeek.Thursday, FhirDayOfWeek.Friday, FhirDayOfWeek.Saturday, FhirDayOfWeek.Sunday];
          recipient.schedule.dayOfWeek = days.filter(day => adjunct.excludedWeekdays!.indexOf(day) < 0);
        }
      }
      if (excludedDates?.length) adjunct.excludedDates = [...new Set([...(adjunct.excludedDates ?? []), ...excludedDates])];
      if (index === donorIndex) continue;
      const evidence = (clinical.evidence ?? []).map(item =>
        shiftEvidenceToRecipient(item, segments[donorIndex].start, segments[index].start)
      );
      adjunct.evidence = [...(adjunct.evidence ?? [])];
      for (const item of evidence) appendEvidence(adjunct.evidence, item);
    }
  }
}

/**
 * Apply licensed coordination scope to canonical clause semantics. FHIR is
 * intentionally absent here: every downstream representation is lowered from
 * the resulting canonical schedule/PRN semantics, making this the single
 * semantic source.
 */
/** Resolve an explicitly typed calendar-day complement against its adjacent
 * source antecedent, retaining unknown references as editable instructions.
 * @param states Already parsed source clauses, before any FHIR projection.
 * @param plan Typed boundary relations between the source administrations.
 * @param applications Shared provenance record for performed operations.
 */
function resolveWeekdayComplements(
  states: readonly CoordinatedClauseState[],
  plan: BoundaryPlan,
  applications: CoordinationScopeApplication[]
): void {
  const domain = [FhirDayOfWeek.Monday, FhirDayOfWeek.Tuesday, FhirDayOfWeek.Wednesday,
    FhirDayOfWeek.Thursday, FhirDayOfWeek.Friday, FhirDayOfWeek.Saturday, FhirDayOfWeek.Sunday];
  for (const relation of plan.relations) {
    if (relation.kind !== 'coordination' && relation.kind !== 'independent') continue;
    const leftSegment = plan.segments[relation.from], rightSegment = plan.segments[relation.to];
    if (!leftSegment || !rightSegment) continue;
    const left = exactClauseState(states, leftSegment.start, leftSegment.end)?.state.primaryClause;
    const right = exactClauseState(states, rightSegment.start, rightSegment.end)?.state.primaryClause;
    const recipient = right?.schedule, donor = left?.schedule;
    if (!right || recipient?.timingReference !== 'previous-weekday-complement' ||
        donor?.calendarEvents?.length || recipient.dayOfWeek?.length) continue;
    const dayCondition = left?.clinicalAdjuncts?.calendarDayCondition;
    if (dayCondition && !donor?.dayOfWeek?.length) {
      const members: MedicationCondition[] = [cloneStructuredValue(dayCondition)];
      let previous = relation.from;
      const visited = new Set<number>();
      // Consecutive activity-day alternatives form the antecedent union. Only
      // source-typed calendar predicates participate, never arbitrary guards.
      while (!visited.has(previous)) {
        visited.add(previous);
        const edge = plan.relations.find(candidate => candidate.to === previous);
        if (!edge || (edge.kind !== 'coordination' && edge.kind !== 'independent')) break;
        const segment = plan.segments[edge.from];
        if (!segment) break;
        const prior = exactClauseState(states, segment.start, segment.end)?.state.primaryClause;
        const membership = prior?.clinicalAdjuncts?.calendarDayCondition;
        if (!membership || prior.schedule?.dayOfWeek?.length ||
            prior.schedule?.calendarEvents?.length || prior.schedule?.timingReference) break;
        if (!members.some(member => equalStructuredValues(member, membership))) {
          members.push(cloneStructuredValue(membership));
        }
        previous = edge.from;
      }
      const domain: MedicationCondition = members.length === 1 ? members[0] :
        { kind: 'any', conditions: members };
      const complement: MedicationCondition = domain.kind === 'not'
        ? cloneStructuredValue(domain.condition) : { kind: 'not', condition: domain };
      const clinical = right.clinicalAdjuncts ?? (right.clinicalAdjuncts = {});
      clinical.condition = clinical.condition && !equalStructuredValues(clinical.condition, complement)
        ? { kind: 'all', conditions: [clinical.condition, complement] } : complement;
      clinical.calendarDayCondition = cloneStructuredValue(complement);
      delete recipient.timingReference;
      right.additionalInstructions = right.additionalInstructions?.filter(instruction =>
        !instruction.evidence?.some(item =>
          (item.scheduleFields?.indexOf('timingReference') ?? -1) >= 0));
      const fields: ScheduleSemanticField[] = ['timingReference'];
      const rule = 'hpsg.cx.coordination.calendar-condition-complement';
      const evidence: CanonicalEvidence = { rule, spans: [], scheduleFields: fields,
        note: 'The remaining activity days are the Boolean complement of source-typed calendar membership.' };
      right.evidence.push(evidence);
      clinical.evidence = [...(clinical.evidence ?? []), evidence];
      applications.push({ rule, from: relation.from, to: relation.to, fields });
      continue;
    }
    if (!donor?.dayOfWeek?.length) continue;
    const antecedent = new Set(donor.dayOfWeek);
    let previous = relation.from;
    const visited = new Set<number>();
    // "MWF ..., Tuesday ..., other days ..." refers to the union of the
    // explicitly enumerated alternatives in this same treatment phase.
    while (!visited.has(previous)) {
      visited.add(previous);
      const edge = plan.relations.find(candidate => candidate.to === previous);
      if (!edge || (edge.kind !== 'coordination' && edge.kind !== 'independent')) break;
      const segment = plan.segments[edge.from];
      if (!segment) break;
      const prior = exactClauseState(states, segment.start, segment.end)?.state.primaryClause.schedule;
      if (!prior?.dayOfWeek?.length || prior.calendarEvents?.length || prior.timingReference) break;
      for (const day of prior.dayOfWeek) antecedent.add(day);
      previous = edge.from;
    }
    const days = domain.filter(day => !antecedent.has(day));
    // Empty complements do not license a default-every-day recurrence.
    if (!days.length) continue;
    recipient.dayOfWeek = days;
    if (recipient.period === undefined) {
      recipient.period = 1;
      recipient.periodUnit = FhirPeriodUnit.Week;
    }
    delete recipient.timingReference;
    right.additionalInstructions = right.additionalInstructions?.filter(instruction =>
      !instruction.evidence?.some(item =>
        (item.scheduleFields?.indexOf('timingReference') ?? -1) >= 0));
    const fields: ScheduleSemanticField[] = ['dayOfWeek', 'period', 'periodUnit', 'timingReference'];
    const rule = 'hpsg.cx.coordination.weekday-set-complement';
    const evidence: CanonicalEvidence = { rule, spans: [], scheduleFields: fields,
      note: 'The explicitly named remaining weekdays are the calendar-domain complement of the adjacent source weekday set.' };
    right.evidence.push(evidence);
    recipient.evidence = [...(recipient.evidence ?? []), evidence];
    applications.push({ rule, from: relation.from, to: relation.to, fields });
  }
}

function hasCalendarDomain(clause: CanonicalSigClause): boolean {
  return Boolean(clause.schedule?.dayOfWeek?.length ||
    clause.clinicalAdjuncts?.calendarDayCondition) &&
    !clause.schedule?.calendarEvents?.length && !clause.schedule?.timingReference;
}

/** Bind only an omitted clock of parallel calendar-domain dose alternatives. */
function inheritCalendarClockEllipses(
  states: readonly CoordinatedClauseState[], plan: BoundaryPlan, source: string,
  applications: CoordinationScopeApplication[]
): void {
  for (const relation of plan.relations) {
    if (relation.kind !== 'coordination' && relation.kind !== 'independent') continue;
    const segment = plan.segments[relation.to];
    if (!segment) continue;
    const right = exactClauseState(states, segment.start, segment.end);
    const recipient = right?.state.primaryClause;
    if (!right || !recipient || !hasCalendarDomain(recipient) ||
        hasEvidence(recipient, 'method')) continue;
    const schedule = recipient.schedule;
    const hasLocalClock = Boolean(schedule && (
      schedule.timeOfDay?.length || schedule.when?.length || schedule.activityTiming?.length ||
      schedule.clockWindow || schedule.eventWindow || schedule.calendarEvents?.length ||
      schedule.offset !== undefined || schedule.offsetMin !== undefined || schedule.offsetMax !== undefined ||
      schedule.administrationOffsetMinutes !== undefined || schedule.timingCode ||
      (schedule.frequency ?? 0) > 1 || (schedule.frequencyMax ?? 0) > 1 ||
      schedule.periodUnit === FhirPeriodUnit.Second || schedule.periodUnit === FhirPeriodUnit.Minute ||
      schedule.periodUnit === FhirPeriodUnit.Hour
    ));
    if (hasLocalClock) continue;
    const donors: CoordinatedClauseState[] = [];
    const visited = new Set<number>();
    let previous = relation.from;
    while (!visited.has(previous)) {
      visited.add(previous);
      const priorSegment = plan.segments[previous];
      const prior = priorSegment && exactClauseState(states, priorSegment.start, priorSegment.end);
      if (!prior || !hasCalendarDomain(prior.state.primaryClause)) break;
      donors.push(prior);
      const edge = plan.relations.find(candidate => candidate.to === previous);
      if (!edge || (edge.kind !== 'coordination' && edge.kind !== 'independent')) break;
      previous = edge.from;
    }
    if (!donors.length) continue;
    const clauses = donors.map(item => item.state.primaryClause);
    let calendarAlternatives = false;
    if (recipient.schedule?.dayOfWeek?.length &&
        clauses.every(clause => Boolean(clause.schedule?.dayOfWeek?.length))) {
      const antecedentDays = new Set<FhirDayOfWeek>();
      for (const clause of clauses) {
        for (const day of clause.schedule!.dayOfWeek!) antecedentDays.add(day);
      }
      calendarAlternatives = recipient.schedule.dayOfWeek.every(day => !antecedentDays.has(day));
    } else {
      const membership = recipient.clinicalAdjuncts?.calendarDayCondition;
      const members: MedicationCondition[] = [];
      for (const clause of clauses) {
        const value = clause.clinicalAdjuncts?.calendarDayCondition;
        if (value && !members.some(member => equalStructuredValues(member, value))) members.push(value);
      }
      if (membership && clauses.every(clause => clause.clinicalAdjuncts?.calendarDayCondition)) {
        const antecedent: MedicationCondition = members.length === 1 ? members[0] :
          { kind: 'any', conditions: members };
        calendarAlternatives = membership.kind === 'not' && equalStructuredValues(membership.condition, antecedent) ||
          antecedent.kind === 'not' && equalStructuredValues(antecedent.condition, membership);
      }
    }
    const donorClocks: Array<string | undefined> = [];
    for (const clause of clauses) {
      donorClocks.push(...(clause.schedule?.timeOfDay?.length ? clause.schedule.timeOfDay : [undefined]));
    }
    const selected = selectHpsgCalendarClockEllipsisConstruction({
      relation, adjacent: relation.to === relation.from + 1, calendarAlternatives,
      compatibleAdministration: Boolean(recipient.dose && !recipient.prn?.enabled && clauses.every(clause =>
        clause.dose && !clause.prn?.enabled && compatibleMethod(clause.method, recipient.method) &&
        (!clause.route || !recipient.route || sameRoute(clause.route, recipient.route)) &&
        (!clause.site || !recipient.site || sameSite(clause.site, recipient.site)))),
      omittedHead: !hasEvidence(recipient, 'method'), omittedClock: !hasLocalClock,
      donorClocks
    });
    if (!selected) continue;
    const target = recipient.schedule ?? (recipient.schedule = {});
    target.timeOfDay = [...selected.timeOfDay];
    const donor = donors[0];
    const inherited = sourceScheduleEvidence(donor.state.primaryClause,
      new Set<ScheduleFeatureGroup>(['recurrence']))
      .filter(item => (item.scheduleFields?.indexOf('timeOfDay') ?? -1) >= 0)
      .map(item => shiftEvidenceToRecipient({ ...item, scheduleFields: ['timeOfDay'] }, donor.start, right.start));
    const evidence: CanonicalEvidence = { rule: selected.id,
      spans: [{ start: relation.range.start - right.start, end: relation.range.end - right.start,
        text: source.slice(relation.range.start, relation.range.end) }],
      scheduleFields: ['timeOfDay'],
      note: 'Parallel calendar alternatives share their unique source clock when the recipient omits its head and clock.' };
    target.evidence = [...(target.evidence ?? [])];
    for (const item of [...inherited, evidence]) {
      appendEvidence(target.evidence, cloneEvidence(item));
      appendEvidence(recipient.evidence, cloneEvidence(item));
    }
    applications.push({ rule: selected.id, from: states.indexOf(donor), to: states.indexOf(right), fields: ['timeOfDay'] });
  }
}

export function applyCoordinatedCadenceScopes(
  states: readonly CoordinatedClauseState[],
  plan: BoundaryPlan,
  source: string
): CoordinationScopeApplication[] {
  const applications: CoordinationScopeApplication[] = [];
  resolveWeekdayComplements(states, plan, applications);
  inheritCalendarClockEllipses(states, plan, source, applications);
  materializeOrdinalWeekStageDurations(states, plan);
  for (const item of states) {
    materializeTypedContinueCourseDuration(item.state.primaryClause);
  }
  const inheritedAdministrationSegments = new Set<number>();
  for (const relation of plan.relations) {
    if (relation.semanticLicense === 'dose-continuation' || relation.semanticLicense === 'event-timing-ellipsis') {
      inheritedAdministrationSegments.add(relation.to);
    }
  }
  const passes: Array<{ direction: 'trailing' | 'leading'; indices: number[] }> = [{
    direction: 'trailing',
    indices: plan.relations.map((_relation, index) => index).reverse()
  }, {
    direction: 'leading',
    indices: plan.relations.map((_relation, index) => index)
  }];
  for (const pass of passes) {
    for (const index of pass.indices) {
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
      inheritedAdministrationSegments.has(relation.from)
    ));
    if (!selected) continue;
    const eventAndCourseEllipsis = selected.semantic.construction.operation ===
      'inherit-event-timing-and-share-trailing-course-duration';
    const eventEllipsis = selected.semantic.construction.operation === 'inherit-event-timing-administration' ||
      eventAndCourseEllipsis;
    const headAndCourseEllipsis = selected.semantic.construction.operation ===
      'inherit-administration-head-and-share-trailing-course-duration';
    const headEllipsis = selected.semantic.construction.operation === 'inherit-administration-head' ||
      headAndCourseEllipsis;
    if (eventEllipsis || headEllipsis) {
      // Heads flow left-to-right; a shared right-edge course flows right-to-left.
      // Keep these independent so an N-way dose list inherits its final bound
      // through every licensed daughter, not only the last adjacent pair.
      if (pass.direction === 'leading') {
        const donor = left.state.primaryClause;
        const recipient = right.state.primaryClause;
        // Only a licensed EVENT ellipsis inherits an omitted event relation.
        // A right daughter with its own dose inherits the administration head,
        // never the left daughter's event, offset, dose, or clinical condition.
        const scopedEventFields = eventEllipsis
          ? inheritEllipticEventAnchor(
              donor.schedule, recipient.schedule, left.state.tokens, right.state.tokens
            )
          : [];
        const copiedFields: string[] = [...scopedEventFields];
        if (donor.method && !hasEvidence(recipient, 'method') &&
            !equalStructuredValues(recipient.method, donor.method)) {
          recipient.method = cloneMethodForRecipient(donor.method, left.start, right.start);
          copiedFields.push('method');
        }
        if (eventEllipsis && donor.dose && !hasEvidence(recipient, 'dose') &&
            !equalStructuredValues(recipient.dose, donor.dose)) {
          recipient.dose = cloneStructuredValue(donor.dose);
          copiedFields.push('dose');
        }
        if (donor.route && !recipient.route?.code && !recipient.route?.text) {
          recipient.route = cloneStructuredValue(donor.route);
          copiedFields.push('route');
        }
        if (copiedFields.length) {
          const scopeEvidence: CanonicalEvidence = {
            rule: selected.semantic.construction.id,
            spans: [{ start: relation.range.start - right.start,
              end: relation.range.end - right.start,
              text: source.slice(relation.range.start, relation.range.end) }],
            scheduleFields: scopedEventFields.length ? scopedEventFields : undefined,
            note: scopedEventFields.length
              ? 'Bare event inherits omitted relative-event relation and offset; explicit right timing remains authoritative.'
              : 'Omitted administration inherits its typed left head; explicit dose, event timing, and conditions remain right-local.'
          };
          appendEvidence(recipient.evidence, scopeEvidence);
          if (scopedEventFields.length && recipient.schedule) {
            recipient.schedule.evidence = [...(recipient.schedule.evidence ?? [])];
            appendEvidence(recipient.schedule.evidence, cloneEvidence(scopeEvidence));
          }
          applications.push({ rule: selected.semantic.construction.id,
            from: states.indexOf(left), to: states.indexOf(right), fields: copiedFields });
        }
      }
      if ((headAndCourseEllipsis || eventAndCourseEllipsis) && pass.direction === 'trailing') {
        const durationDonor = right.state.primaryClause;
        const durationRecipient = left.state.primaryClause;
        const durationMerge = mergeScheduleFeatureGroups(
          durationRecipient.schedule,
          durationDonor.schedule,
          ['courseBounds']
        );
        if (durationMerge.fields.length && durationMerge.schedule) {
          const inheritedDurationEvidence = sourceScheduleEvidence(
            durationDonor,
            durationMerge.groups
          ).map(item => shiftEvidenceToRecipient(item, right.start, left.start));
          const durationScopeEvidence: CanonicalEvidence = {
            rule: selected.semantic.construction.id,
            spans: [{
              start: relation.range.start - left.start,
              end: relation.range.end - left.start,
              text: source.slice(relation.range.start, relation.range.end)
            }],
            scheduleFields: durationMerge.fields as CanonicalScheduleSemanticField[],
            note: 'The source-trailing course duration scopes over both coordinated dose-and-cadence daughters.'
          };
          durationMerge.schedule.evidence = [...(durationRecipient.schedule?.evidence ?? [])];
          for (const item of inheritedDurationEvidence) {
            appendEvidence(durationMerge.schedule.evidence, cloneEvidence(item));
            appendEvidence(durationRecipient.evidence, cloneEvidence(item));
          }
          appendEvidence(durationMerge.schedule.evidence, cloneEvidence(durationScopeEvidence));
          appendEvidence(durationRecipient.evidence, cloneEvidence(durationScopeEvidence));
          durationRecipient.schedule = durationMerge.schedule;
          applications.push({
            rule: selected.semantic.construction.id,
            from: states.indexOf(right),
            to: states.indexOf(left),
            fields: durationMerge.fields
          });
        }
      }
      continue;
    }
    const alternative = selected.semantic.construction.operation ===
      'preserve-disjunctive-dosages';
    const leading = selected.semantic.construction.operation === 'share-leading-adjuncts';
    const trailing = alternative ||
      selected.semantic.construction.operation === 'share-trailing-cadence' ||
      selected.semantic.construction.operation === 'share-trailing-adjuncts' ||
      selected.semantic.construction.operation === 'share-trailing-course-duration';
    if (!leading && !trailing) continue;
    if (leading !== (pass.direction === 'leading')) continue;

    const donor = leading ? left : right;
    const recipient = leading ? right : left;
    const donorClause = donor.state.primaryClause;
    const targetClause = recipient.state.primaryClause;
    const courseDurationOnly = selected.semantic.construction.operation ===
      'share-trailing-course-duration';
    const copySchedule = courseDurationOnly
      ? hasTrailingCourseDurationEvidence(donorClause)
      : leading
      ? isFrontedEvidence(donorClause, 'schedule')
      : isTrailingEvidence(donorClause, 'schedule');
    const scheduleMerge = copySchedule
      ? mergeScheduleFeatureGroups(
          targetClause.schedule,
          donorClause.schedule,
          courseDurationOnly ? ['courseBounds'] : SCHEDULE_GROUP_NAMES
        )
      : { schedule: targetClause.schedule, fields: [], groups: new Set<ScheduleFeatureGroup>() };
    const inheritedEvidence = sourceScheduleEvidence(donorClause, scheduleMerge.groups).map(item =>
      shiftEvidenceToRecipient(item, donor.start, recipient.start)
    );
    const copyPrn = donorClause.prn?.enabled === true && (leading
      ? isFrontedEvidence(donorClause, 'prn')
      : isTrailingEvidence(donorClause, 'prn')) && targetClause.prn?.enabled !== true;
    const inheritedPrnEvidence = copyPrn
      ? sourcePrnEvidence(donorClause).map(item =>
        shiftEvidenceToRecipient(item, donor.start, recipient.start)
      )
      : [];
    const connectorEvidence: CanonicalEvidence = {
      rule: selected.semantic.construction.id,
      spans: [{
        start: relation.range.start - recipient.start,
        end: relation.range.end - recipient.start,
        text: source.slice(relation.range.start, relation.range.end)
      }],
      note: alternative
        ? `Scoped by ${relation.rule}; the right adjunct scopes over both alternative administration clauses.`
        : `Scoped by ${relation.rule}; adjunct daughter is the ${leading ? 'left' : 'right'} administration clause.`
    };
    if (scheduleMerge.fields.length && scheduleMerge.schedule) {
      scheduleMerge.schedule.evidence = [...(targetClause.schedule?.evidence ?? [])];
      for (const item of inheritedEvidence) {
        appendEvidence(scheduleMerge.schedule.evidence, cloneEvidence(item));
      }
      appendEvidence(scheduleMerge.schedule.evidence, cloneEvidence(connectorEvidence));
      targetClause.schedule = scheduleMerge.schedule;
    }
    if (copyPrn) {
      targetClause.prn = clonePrn(donorClause.prn!);
      targetClause.prn.evidence = [...(targetClause.prn.evidence ?? [])];
      for (const item of inheritedPrnEvidence) {
        appendEvidence(targetClause.prn.evidence, cloneEvidence(item));
      }
      appendEvidence(targetClause.prn.evidence, cloneEvidence(connectorEvidence));
    }
    // Share only the clinical adjuncts licensed by the selected typed
    // coordination construction. The donor's parsed semantics, never FHIR or
    // a second surface regex pass, determine what the recipient inherits.
    const donorClinical = donorClause.clinicalAdjuncts;
    const targetClinical = targetClause.clinicalAdjuncts;
    const positiveGuard = donorClinical?.condition &&
      !donorClinical.conditionTarget && donorClinical.condition.kind !== 'not';
    const clinicalSharing = !leading &&
      (selected.semantic.construction.operation === 'share-trailing-adjuncts' ||
       scheduleMerge.fields.length > 0 || copyPrn);
    const copyCondition = Boolean(clinicalSharing && positiveGuard &&
      !targetClinical?.condition);
    const copyExcludedWeekdays = Boolean(clinicalSharing &&
      donorClinical?.excludedWeekdays?.length &&
      scheduleMerge.fields.indexOf('dayOfWeek') >= 0);
    const copyExcludedDates = Boolean(clinicalSharing &&
      donorClinical?.excludedDates?.length &&
      (scheduleMerge.fields.length > 0 || copyPrn));
    const clinicalFields: string[] = [];
    if (copyCondition || copyExcludedDates || copyExcludedWeekdays) {
      const scopedClinical = targetClinical ?? {};
      if (copyCondition) {
        scopedClinical.condition = donorClinical!.condition;
        clinicalFields.push('condition');
      }
      if (copyExcludedWeekdays) {
        scopedClinical.excludedWeekdays = [...new Set([
          ...(scopedClinical.excludedWeekdays ?? []),
          ...donorClinical!.excludedWeekdays!
        ])];
        clinicalFields.push('excludedWeekdays');
      }
      if (copyExcludedDates) {
        scopedClinical.excludedDates = [...new Set([
          ...(scopedClinical.excludedDates ?? []),
          ...donorClinical!.excludedDates!
        ])].sort();
        clinicalFields.push('excludedDates');
      }
      const clinicalEvidence = (donorClinical!.evidence ?? []).map(item =>
        shiftEvidenceToRecipient(item, donor.start, recipient.start)
      );
      scopedClinical.evidence = [
        ...(scopedClinical.evidence ?? []),
        ...clinicalEvidence.map(item => cloneEvidence(item)),
        cloneEvidence(connectorEvidence)
      ];
      targetClause.clinicalAdjuncts = scopedClinical;
      for (const item of clinicalEvidence) appendEvidence(targetClause.evidence, cloneEvidence(item));
    }
    if (!scheduleMerge.fields.length && !copyPrn && !clinicalFields.length) continue;
    for (const item of [...inheritedEvidence, ...inheritedPrnEvidence]) {
      appendEvidence(targetClause.evidence, cloneEvidence(item));
    }
    appendEvidence(targetClause.evidence, cloneEvidence(connectorEvidence));
    applications.push({
      rule: selected.semantic.construction.id,
      from: states.indexOf(donor),
      to: states.indexOf(recipient),
      fields: [...scheduleMerge.fields, ...(copyPrn ? ['prn'] : []), ...clinicalFields]
    });
    }
  }
  return applications;
}


/**
 * Apply the segmenter's licensed trailing shared course duration directly to
 * typed HPSG clauses. This intentionally never touches FHIR or rendered text.
 */
export function scopeTrailingSharedDuration(
  states: readonly ParserState[],
  segments: readonly {
    start: number;
    text: string;
    inheritTrailingDurationFromNext?: boolean;
  }[]
): void {
  for (let index = states.length - 2; index >= 0; index -= 1) {
    if (!segments[index]?.inheritTrailingDurationFromNext) continue;
    const current = states[index].primaryClause;
    const next = states[index + 1].primaryClause;
    const duration = next.schedule;
    if (!duration?.durationUnit || duration.duration === undefined) continue;
    if (current.schedule?.duration !== undefined ||
        current.schedule?.durationUnit !== undefined) continue;
    current.schedule = {
      ...(current.schedule ?? {}),
      duration: duration.duration,
      durationMax: duration.durationMax,
      durationUnit: duration.durationUnit
    };
    const donorStart = segments[index + 1].start - segments[index].start;
    current.evidence.push({
      rule: "hpsg.cx.regimen.trailing-shared-duration",
      spans: [{ start: donorStart, end: donorStart + segments[index + 1].text.length,
        text: segments[index + 1].text }]
    });
  }
}
