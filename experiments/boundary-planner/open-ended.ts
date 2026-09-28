import { findMedicationDateListSpans } from '../../src/date-interpretation';
import { lexicalRule, normalizeTokenLower } from '../../src/hpsg/rule-context';
import { emptySynsem, lexicalSign } from '../../src/hpsg/signature';
import type { HpsgClauseContext } from '../../src/hpsg/rule-context';
import type { ParseOptions, ParseResult } from '../../src/types';
import { ACTION_COORDINATION_CONNECTORS, ACTION_SEQUENCE_MARKERS } from '../../src/hpsg/lexical-classes';
import { quarantineSchedule } from './admissibility';

const MARKERS = new Set(['onward', 'onwards', 'ต่อไป']);

function markerTokens(context: HpsgClauseContext, start: number) {
  const first = context.tokens[start];
  if (!first) return [] as typeof context.tokens;
  const lower = normalizeTokenLower(first);
  if (MARKERS.has(lower)) return [first];
  const second = context.tokens[start + 1];
  if (lower === 'เป็นต้น' && second && normalizeTokenLower(second) === 'ไป') return [first, second];
  return [] as typeof context.tokens;
}

function priorDateForMarker(context: HpsgClauseContext, markerStart: number) {
  const spans = findMedicationDateListSpans(context.state.input, context.options);
  const candidates = spans.filter(span => span.end <= markerStart).sort((left, right) => right.end - left.end);
  for (const span of candidates) {
    const blocked = context.tokens.some(token =>
      token.sourceStart >= span.end && token.sourceEnd <= markerStart && (
        ACTION_COORDINATION_CONNECTORS.has(normalizeTokenLower(token)) ||
        ACTION_SEQUENCE_MARKERS.has(normalizeTokenLower(token)) ||
        /[;!?]/u.test(token.original)
      )
    );
    if (!blocked && (span.relation === 'event' || span.relation === 'start-inclusive')) return span;
  }
  return undefined;
}

export function openEndedBoundMarkerRule() {
  return lexicalRule('hpsg.lex.schedule.openEndedMarker', (context: HpsgClauseContext, start: number) => {
    const tokens = markerTokens(context, start);
    if (!tokens.length) return [];
    const prior = priorDateForMarker(context, tokens[0].sourceStart);
    if (!prior) return [];
    return [lexicalSign({
      type: 'connector-sign',
      rule: 'hpsg.lex.schedule.openEndedMarker',
      tokens,
      synsem: emptySynsem(),
      score: 3
    })];
  });
}

export function normalizeOpenEndedSchedule(item: ParseResult, source: string, options?: ParseOptions): void {
  const clause = item.meta.canonical.clauses[0];
  const schedule = clause?.schedule;
  if (!clause || !schedule) return;
  const markers = clause.evidence
    .filter(evidence => evidence.rule === 'hpsg.lex.schedule.openEndedMarker')
    .flatMap(evidence => evidence.spans);
  if (!markers.length) return;
  const recurring = Boolean(
    schedule.frequency !== undefined || schedule.period !== undefined || schedule.dayOfWeek?.length || schedule.timingCode
  );
  if (!recurring) {
    quarantineSchedule(item, source, 'open-ended-bound-without-cadence');
    return;
  }
  const spans = findMedicationDateListSpans(source, options);
  for (const marker of markers) {
    const span = spans.filter(value => value.end <= marker.start).sort((left, right) => right.end - left.end)[0];
    if (!span || span.events.length !== 1 || span.unresolved || span.relation !== 'event') continue;
    const iso = span.events[0].isoDate;
    schedule.boundsStart = schedule.boundsStart ?? iso;
    schedule.calendarEvents = (schedule.calendarEvents ?? []).filter(event => event.isoDate !== iso);
    if (!schedule.calendarEvents.length) delete schedule.calendarEvents;
    if (item.fhir.timing?.event) {
      item.fhir.timing.event = item.fhir.timing.event.filter(event => event.slice(0, 10) !== iso);
      if (!item.fhir.timing.event.length) delete item.fhir.timing.event;
    }
    if (item.fhir.timing?._event) delete item.fhir.timing._event;
    item.fhir.timing = item.fhir.timing ?? {};
    item.fhir.timing.repeat = {
      ...(item.fhir.timing.repeat ?? {}),
      boundsPeriod: {
        ...(item.fhir.timing.repeat?.boundsPeriod ?? {}),
        start: schedule.boundsStart
      }
    };
  }
}
