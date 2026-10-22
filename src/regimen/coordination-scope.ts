import { parseMedicationGuard } from '../medication-condition';
import { matchCalendarExclusion } from '../clinical-safety';
import { selectHpsgCoordinationScopeConstruction } from '../hpsg/constructions';
import { findUnparsedTokenGroups } from '../parser';
import type { ParserState } from '../parser-state';
import type {
  CanonicalEvidence,
  CanonicalPrnExpr,
  CanonicalScheduleExpr,
  CanonicalSigClause,
  CanonicalSourceSpan
} from '../types';
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

function hasEvidence(clause: CanonicalSigClause, prefix: string): boolean {
  return clause.evidence.some(item => item.rule.startsWith(prefix));
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

type ScheduleSemanticField = Exclude<keyof CanonicalScheduleExpr, 'evidence'>;
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
    'occurrenceCap'
  ],
  eventAnchor: ['when', 'offset', 'offsetMin', 'offsetMax', 'activityTiming'],
  courseBounds: ['duration', 'durationMax', 'durationUnit', 'boundsStart', 'boundsEnd'],
  administrationDuration: [
    'administrationDuration', 'administrationDurationMax', 'administrationDurationUnit'
  ],
  calendarEvents: ['calendarEvents']
} as const satisfies Record<string, readonly ScheduleSemanticField[]>;

type GroupedScheduleField = (typeof SCHEDULE_FEATURE_GROUPS)[ScheduleFeatureGroup][number];
const scheduleFeatureCoverage: Exclude<ScheduleSemanticField, GroupedScheduleField> extends never
  ? true : never = true;
void scheduleFeatureCoverage;

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
  return (Object.keys(SCHEDULE_FEATURE_GROUPS) as ScheduleFeatureGroup[]).some(group =>
    SCHEDULE_FEATURE_GROUPS[group].some(field =>
      hasSemanticValue(scheduleFieldValue(schedule, field)))
  );
}

function sameSemanticValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

  for (const group of Object.keys(SCHEDULE_FEATURE_GROUPS) as ScheduleFeatureGroup[]) {
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

function hasCadenceConflict(state: ParserState): boolean {
  return state.warnings.some(warning =>
    /(?:unresolved|incompatible|conflict).*(?:schedule|timing)|(?:schedule|timing).*(?:unresolved|incompatible|conflict)/iu.test(warning)
  );
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
  return {
    ...evidence,
    spans: evidence.spans.map(span => ({
      start: span.start + donorStart - recipientStart,
      end: span.end + donorStart - recipientStart,
      text: span.text
    }))
  };
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
  return {
    ...evidence,
    spans: evidence.spans.map(span => ({
      ...span,
      tokenIndices: span.tokenIndices ? [...span.tokenIndices] : undefined
    }))
  };
}

function scheduleEvidenceGroups(rule: string): readonly ScheduleFeatureGroup[] {
  if (/eventOffset|activityTiming/iu.test(rule)) return ['eventAnchor'];
  if (/administrationDuration/iu.test(rule)) return ['administrationDuration'];
  if (/duration/iu.test(rule)) return ['courseBounds'];
  if (/calendarDateList/iu.test(rule)) return ['courseBounds', 'calendarEvents'];
  if (/occurrenceCap|count|frequency|interval|timing|clock|weekday/iu.test(rule)) {
    return ['recurrence'];
  }
  return [];
}

function sourceScheduleEvidence(
  clause: CanonicalSigClause,
  copiedGroups: ReadonlySet<ScheduleFeatureGroup>
): CanonicalEvidence[] {
  const evidence: CanonicalEvidence[] = [];
  for (const item of clause.schedule?.evidence ?? []) {
    if (scheduleEvidenceGroups(item.rule).some(group => copiedGroups.has(group))) {
      appendEvidence(evidence, item);
    }
  }
  for (const item of clause.evidence) {
    if (item.rule.startsWith('hpsg.lex.schedule.') &&
        scheduleEvidenceGroups(item.rule).some(group => copiedGroups.has(group))) {
      appendEvidence(evidence, item);
    }
  }
  return evidence;
}

function evidenceBounds(
  clause: CanonicalSigClause,
  prefix: string
): { start: number; end: number } | undefined {
  let start = Infinity;
  let end = -Infinity;
  for (const evidence of clause.evidence) {
    if (!evidence.rule.startsWith(prefix)) continue;
    for (const span of evidence.spans) {
      if (span.start < start) start = span.start;
      if (span.end > end) end = span.end;
    }
  }
  return start === Infinity ? undefined : { start, end };
}

function isFrontedEvidence(clause: CanonicalSigClause, prefix: string): boolean {
  const adjunct = evidenceBounds(clause, prefix);
  const head = evidenceBounds(clause, 'hpsg.lex.method') ??
    evidenceBounds(clause, 'hpsg.lex.dose');
  return Boolean(adjunct && head && adjunct.end <= head.start);
}

function isTrailingEvidence(clause: CanonicalSigClause, prefix: string): boolean {
  const adjunct = evidenceBounds(clause, prefix);
  const dose = evidenceBounds(clause, 'hpsg.lex.dose');
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
    if (item.rule.startsWith('hpsg.lex.prn')) appendEvidence(evidence, item);
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
    leftExplicitDose: Boolean(leftClause.dose && hasEvidence(leftClause, 'hpsg.lex.dose')),
    rightExplicitDose: Boolean(rightClause.dose && hasEvidence(rightClause, 'hpsg.lex.dose')),
    leftExplicitHead: hasEvidence(leftClause, 'hpsg.lex.method'),
    leftAdministrationContext: hasEvidence(leftClause, 'hpsg.lex.method') || inheritedAdministration,
    rightExplicitHead: hasEvidence(rightClause, 'hpsg.lex.method'),
    leftHasSite: Boolean(leftTarget),
    rightHasSite: Boolean(rightTarget),
    targetsDistinct: Boolean(leftTarget && rightTarget && leftTarget !== rightTarget),
    leftHasSchedule: scheduleHasSemantics(leftClause.schedule),
    rightHasSchedule: scheduleHasSemantics(rightClause.schedule),
    leftHasCadence: hasCadence(leftClause.schedule),
    rightHasCadence: hasCadence(rightClause.schedule),
    leftHasPrn: leftClause.prn?.enabled === true,
    rightHasPrn: rightClause.prn?.enabled === true,
    leftHasFrontedSchedule: isFrontedEvidence(leftClause, 'hpsg.lex.schedule.'),
    leftHasFrontedPrn: isFrontedEvidence(leftClause, 'hpsg.lex.prn'),
    rightHasTrailingSchedule: isTrailingEvidence(rightClause, 'hpsg.lex.schedule.'),
    rightHasTrailingPrn: isTrailingEvidence(rightClause, 'hpsg.lex.prn'),
    rightHasTrailingSafetyGuard: Boolean(
      rightClause.warnings?.some(warning =>
        warning.includes('ambiguous-shared-clinical-guard')) ||
      parseMedicationGuard(right.state.input) ||
      matchCalendarExclusion(right.state.input)
    ),
    rightHasCadenceConflict: hasCadenceConflict(right.state)
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
    if (relation.kind === 'coordination' && relation.rule === 'regimen.dose-continuation') {
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
    if (selected.semantic.construction.operation === 'quarantine-disjunctive-dosages' ||
        selected.semantic.construction.operation === 'quarantine-ambiguous-shared-guard') {
      if (pass.direction === 'leading') continue;
      // Alternative administrations are non-executable canonical daughters.
      // Remove their schedules before either daughter can be lowered to FHIR;
      // the downstream admissibility projection only serializes this already
      // typed decision as the standard unresolved marker.
      const reason = selected.semantic.construction.operation === 'quarantine-disjunctive-dosages'
        ? 'disjunctive-dose-choice' : 'ambiguous-shared-clinical-guard';
      const warning = `Unresolved schedule (${reason}): ${source}`;
      for (const item of [left, right]) {
        // Retain each alternative's actual parsed cadence for review, while
        // ensuring neither choice can be emitted as a mandatory administration.
        const clause = item.state.primaryClause;
        if (clause.schedule) clause.provisionalSchedule = clause.provisionalSchedule ?? clause.schedule;
        clause.schedule = undefined;
        if (!item.state.primaryClause.warnings?.some(text => text === warning)) {
          item.state.primaryClause.warnings = [
            ...(item.state.primaryClause.warnings ?? []), warning
          ];
        }
        if (item.state.warnings.indexOf(warning) < 0) item.state.warnings.push(warning);
      }
      applications.push({
        rule: selected.semantic.construction.id,
        from: states.indexOf(left),
        to: states.indexOf(right),
        fields: []
      });
      continue;
    }
    const leading = selected.semantic.construction.operation === 'share-leading-adjuncts';
    const trailing = selected.semantic.construction.operation === 'share-trailing-cadence' ||
      selected.semantic.construction.operation === 'share-trailing-adjuncts';
    if (!leading && !trailing) continue;
    if (leading !== (pass.direction === 'leading')) continue;

    const donor = leading ? left : right;
    const recipient = leading ? right : left;
    const donorClause = donor.state.primaryClause;
    const targetClause = recipient.state.primaryClause;
    const copySchedule = leading
      ? isFrontedEvidence(donorClause, 'hpsg.lex.schedule.')
      : isTrailingEvidence(donorClause, 'hpsg.lex.schedule.');
    const scheduleMerge = copySchedule
      ? mergeScheduleFeatureGroups(targetClause.schedule, donorClause.schedule)
      : { schedule: targetClause.schedule, fields: [], groups: new Set<ScheduleFeatureGroup>() };
    const inheritedEvidence = sourceScheduleEvidence(donorClause, scheduleMerge.groups).map(item =>
      shiftEvidenceToRecipient(item, donor.start, recipient.start)
    );
    const copyPrn = donorClause.prn?.enabled === true && (leading
      ? isFrontedEvidence(donorClause, 'hpsg.lex.prn')
      : isTrailingEvidence(donorClause, 'hpsg.lex.prn')) && targetClause.prn?.enabled !== true;
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
      note: `Scoped by ${relation.rule}; adjunct daughter is the ${leading ? 'left' : 'right'} administration clause.`
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
    if (!scheduleMerge.fields.length && !copyPrn) continue;
    for (const item of [...inheritedEvidence, ...inheritedPrnEvidence]) {
      appendEvidence(targetClause.evidence, cloneEvidence(item));
    }
    appendEvidence(targetClause.evidence, cloneEvidence(connectorEvidence));
    applications.push({
      rule: selected.semantic.construction.id,
      from: states.indexOf(donor),
      to: states.indexOf(recipient),
      fields: [...scheduleMerge.fields, ...(copyPrn ? ['prn'] : [])]
    });
    }
  }
  return applications;
}
