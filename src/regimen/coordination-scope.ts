import {
  selectHpsgCoordinationScopeConstruction,
  selectHpsgTimingAnchorCoordinationConstruction
} from '../hpsg/constructions';
import { grammaticalTrailingInstructionScope } from './grammar';
import { findUnparsedTokenGroups } from '../parser';
import type { ParserState } from '../parser-state';
import { AdvicePolarity } from '../types';
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
  CanonicalSourceSpan
} from '../types';
import type { HpsgSigSegment } from '../hpsg/segmenter';
import { shiftCanonicalSigClauses } from '../ir';
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
    'period', 'periodMax', 'periodUnit', 'dayOfWeek', 'timeOfDay',
    'occurrenceCap', 'maxDosePerPeriod'
  ],
  eventAnchor: ['when', 'offset', 'offsetMin', 'offsetMax', 'activityTiming'],
  courseBounds: ['duration', 'durationMax', 'durationUnit', 'boundsStart', 'boundsEnd'],
  administrationDuration: [
    'administrationDuration', 'administrationDurationMax', 'administrationDurationUnit'
  ],
  calendarEvents: ['calendarEvents'],
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
  'dayOfWeek', 'calendarEvents'
] as const satisfies readonly ScheduleSemanticField[];
const NON_ANCHOR_SCHEDULE_FIELDS = [
  'timingCode', 'count', 'countMax', 'frequency', 'frequencyMax',
  'period', 'periodMax', 'periodUnit', 'offset', 'offsetMin', 'offsetMax',
  'activityTiming', 'occurrenceCap', 'maxDosePerPeriod',
  'repeatCycle', 'repeatCount'
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

function sameSemanticValue(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

interface ScheduleMergeResult {
  schedule?: CanonicalScheduleExpr;
  fields: string[];
  groups: Set<ScheduleFeatureGroup>;
}

/** Merge whole typed feature groups while preserving explicit local groups. */
function mergeScheduleFeatureGroups(
  recipient: CanonicalScheduleExpr | undefined,
  donor: CanonicalScheduleExpr | undefined
): ScheduleMergeResult {
  if (!scheduleHasSemantics(donor)) {
    return { schedule: recipient, fields: [], groups: new Set() };
  }
  const schedule: CanonicalScheduleExpr = { ...(recipient ?? {}) };
  const writable = schedule as unknown as Record<string, unknown>;
  const fields: string[] = [];
  const groups = new Set<ScheduleFeatureGroup>();

  for (const group of SCHEDULE_GROUP_NAMES) {
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
        !sameSemanticValue(local, scheduleFieldValue(donor, field));
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
    leftHasPrn: leftClause.prn?.enabled === true,
    rightHasPrn: rightClause.prn?.enabled === true,
    leftHasFrontedSchedule: isFrontedEvidence(leftClause, 'schedule'),
    leftHasFrontedPrn: isFrontedEvidence(leftClause, 'prn'),
    rightHasTrailingSchedule: isTrailingEvidence(rightClause, 'schedule'),
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
      codings: frame.predicate.codings?.map(coding => ({ ...coding }))
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
    sameSemanticValue(left.range, right.range);
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
    sameSemanticValue(left.spatialRelation, right.spatialRelation);
}

function hasOnlyTimingAnchorSemantics(clause: CanonicalSigClause): boolean {
  return !clause.provisionalSchedule && !clause.prn?.enabled &&
    !clause.clinicalAdjuncts && !clause.clinicalQuantity &&
    !clause.patientInstruction && !clause.instructionGraph &&
    !clause.additionalInstructions?.length && !clause.leftovers.length;
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
    if (!sameSemanticValue(scheduleFieldValue(left, field), scheduleFieldValue(right, field))) {
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
  rule: 'hpsg.cx.regimen.coordinated-timing-anchors';
  recipient: number;
  donor: number;
  fields: Array<'when' | 'timeOfDay' | 'method'>;
}

export interface TimingAnchorCompositionResult {
  absorbed: Set<number>;
  applications: TimingAnchorCompositionApplication[];
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
    const selected = selectHpsgTimingAnchorCoordinationConstruction({
      relation: relation.relation,
      sameSourceExpansion: relation.sameSourceExpansion,
      adjacent: true,
      leftComplete: findUnparsedTokenGroups(recipient).length === 0,
      rightComplete: findUnparsedTokenGroups(donor).length === 0,
      sameAdministration: !recipient.siteLookups.length && !donor.siteLookups.length &&
        !recipient.prnReasonLookups.length && !donor.prnReasonLookups.length &&
        hasOnlyTimingAnchorSemantics(recipientClause) &&
        hasOnlyTimingAnchorSemantics(donorClause) &&
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
        addsTimingAnchor(recipientSchedule, donorSchedule))
    });
    if (!selected || !recipientSchedule || !donorSchedule) {
      recipientIndex = donorIndex;
      continue;
    }

    const donorOffset = donorSegment.start - recipientSegment.start;
    const fields: TimingAnchorCompositionApplication['fields'] = [];
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
    if (!additions.length) continue;
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
    for (const instruction of inherited) {
      for (const evidence of instruction.evidence ?? []) {
        appendEvidence(targetClause.evidence, cloneEvidence(evidence));
      }
    }
  }
}

/**
 * Apply licensed coordination scope to canonical clause semantics. FHIR is
 * intentionally absent here: every downstream representation is lowered from
 * the resulting canonical schedule/PRN semantics, making this the single
 * semantic source.
 */
export function applyCoordinatedCadenceScopes(
  states: readonly CoordinatedClauseState[],
  plan: BoundaryPlan,
  source: string
): CoordinationScopeApplication[] {
  const applications: CoordinationScopeApplication[] = [];
  const inheritedAdministrationSegments = new Set<number>();
  for (const relation of plan.relations) {
    if (relation.kind === 'coordination' && relation.semanticLicense === 'dose-continuation') {
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
    const alternative = selected.semantic.construction.operation ===
      'preserve-disjunctive-dosages';
    const leading = selected.semantic.construction.operation === 'share-leading-adjuncts';
    const trailing = alternative ||
      selected.semantic.construction.operation === 'share-trailing-cadence' ||
      selected.semantic.construction.operation === 'share-trailing-adjuncts';
    if (!leading && !trailing) continue;
    if (leading !== (pass.direction === 'leading')) continue;

    const donor = leading ? left : right;
    const recipient = leading ? right : left;
    const donorClause = donor.state.primaryClause;
    const targetClause = recipient.state.primaryClause;
    const copySchedule = leading
      ? isFrontedEvidence(donorClause, 'schedule')
      : isTrailingEvidence(donorClause, 'schedule');
    const scheduleMerge = copySchedule
      ? mergeScheduleFeatureGroups(targetClause.schedule, donorClause.schedule)
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
      donorClinical.condition.kind !== 'not';
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
