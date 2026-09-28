import { findMedicationDateListSpans, MedicationDateListMatch } from '../../src/date-interpretation';
import { lexInput } from '../../src/lexer/lex';
import { annotateLexTokens } from '../../src/lexer/meaning';
import { lexicalRule, normalizeTokenLower } from '../../src/hpsg/rule-context';
import { emptySynsem, lexicalSign } from '../../src/hpsg/signature';
import type { HpsgClauseContext } from '../../src/hpsg/rule-context';
import type { Token } from '../../src/parser-state';
import type { ParseOptions, ParseResult } from '../../src/types';
import { ACTION_COORDINATION_CONNECTORS, ACTION_SEQUENCE_MARKERS } from '../../src/hpsg/lexical-classes';
import { quarantineSchedule } from './admissibility';
import { buildInstructionGraphExtension, MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL } from '../../src/instruction-graph-fhir';
import { OPEN_ENDED_WORDS } from './temporal-relation-vocabulary';

interface OpenEndedMarkerMatch {
  start: number;
  end: number;
  date: MedicationDateListMatch;
}

function markerEnd(tokens: readonly Token[], index: number): number | undefined {
  const first = tokens[index];
  if (!first) return undefined;
  const surface = first.lower.replace(/^[.,;:]+|[.,;:]+$/gu, '');
  if (OPEN_ENDED_WORDS.has(surface)) return first.sourceEnd;
  const second = tokens[index + 1];
  const secondSurface = second?.lower.replace(/^[.,;:]+|[.,;:]+$/gu, '');
  if ((surface === 'เป็นต้น' || surface === 'ต่อ') && second && secondSurface === 'ไป') return second.sourceEnd;
  const previous = tokens[index - 1];
  const previousSurface = previous?.lower.replace(/^[.,;:]+|[.,;:]+$/gu, '');
  if (surface === 'ไป' && previousSurface !== 'ต่อ' && previousSurface !== 'เป็นต้น') return first.sourceEnd;
  return undefined;
}

function hasBlockingBoundary(tokens: readonly Token[], start: number, end: number): boolean {
  return tokens.some(token => token.sourceStart >= start && token.sourceEnd <= end && (
    ACTION_COORDINATION_CONNECTORS.has(normalizeTokenLower(token)) ||
    ACTION_SEQUENCE_MARKERS.has(normalizeTokenLower(token)) ||
    /[;!?]/u.test(token.original)
  ));
}

function resolveMarkers(
  input: string,
  tokens: readonly Token[],
  spans: readonly MedicationDateListMatch[]
): OpenEndedMarkerMatch[] {
  const output: OpenEndedMarkerMatch[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const end = markerEnd(tokens, index);
    if (end === undefined) continue;
    const markerStart = tokens[index].sourceStart;
    const date = [...spans]
      .filter(span => span.end <= markerStart && !hasBlockingBoundary(tokens, span.end, markerStart))
      .sort((left, right) => right.end - left.end)[0];
    if (!date) continue;
    const surface = tokens[index].lower.replace(/^[.,;:]+|[.,;:]+$/gu, '');
    if (surface === 'ไป' && date.relation !== 'start-inclusive' && date.relation !== 'start-exclusive') continue;
    output.push({ start: markerStart, end, date });
  }
  return output;
}

/** Resolve marker/date ownership for post-parse normalization with one lexical pass. */
export function findOpenEndedMarkers(input: string, options?: ParseOptions): OpenEndedMarkerMatch[] {
  const tokens = annotateLexTokens(lexInput(input));
  return resolveMarkers(input, tokens, findMedicationDateListSpans(input, options));
}

const CONTEXT_MARKERS = new WeakMap<HpsgClauseContext, OpenEndedMarkerMatch[]>();
function contextMarkers(context: HpsgClauseContext): OpenEndedMarkerMatch[] {
  const cached = CONTEXT_MARKERS.get(context);
  if (cached) return cached;
  const markers = resolveMarkers(context.state.input, context.tokens, context.dateSpans);
  CONTEXT_MARKERS.set(context, markers);
  return markers;
}

export function insideOpenEndedMarker(context: HpsgClauseContext, start: number): boolean {
  const token = context.tokens[start];
  if (!token) return false;
  return contextMarkers(context).some(marker =>
    token.sourceStart >= marker.start && token.sourceEnd <= marker.end
  );
}

export function openEndedBoundMarkerRule() {
  return lexicalRule('hpsg.lex.schedule.openEndedMarker', (context: HpsgClauseContext, start: number) => {
    const first = context.tokens[start];
    if (!first) return [];
    const match = contextMarkers(context).find(value => value.start === first.sourceStart);
    if (!match) return [];
    const members = context.tokens
      .slice(start)
      .filter(token => token.sourceStart >= match.start && token.sourceEnd <= match.end);
    if (!members.length) return [];
    return [lexicalSign({
      type: 'connector-sign',
      rule: 'hpsg.lex.schedule.openEndedMarker',
      tokens: members,
      synsem: emptySynsem(),
      score: 3
    })];
  });
}

function removeOwnedInstructionArtifacts(item: ParseResult, markers: OpenEndedMarkerMatch[]): void {
  const clause = item.meta.canonical.clauses[0];
  if (!clause) return;
  const base = clause.raw.start;
  const ranges = markers.map(marker => ({ start: base + marker.start, end: base + marker.end }));
  const overlaps = (start: number, end: number) => ranges.some(range => start < range.end && end > range.start);
  const graph = clause.instructionGraph;
  if (graph) {
    graph.actions = graph.actions.filter(action => !overlaps(action.span.start, action.span.end));
    graph.opaqueSpans = (graph.opaqueSpans ?? []).filter(span => !overlaps(span.start, span.end));
    if (graph.coverage) {
      const opaqueCharacters = (graph.opaqueSpans ?? []).reduce((sum, span) => sum + Math.max(0, span.end - span.start), 0);
      graph.coverage.opaqueCharacters = opaqueCharacters;
      graph.coverage.complete = opaqueCharacters === 0;
    }
    if (!graph.actions.length && !graph.opaqueSpans?.length) delete clause.instructionGraph;
  }
  if (clause.patientInstruction && markers.some(marker =>
    clause.patientInstruction!.replace(/\s+/gu, '') === item.meta.canonical.clauses[0].rawText.slice(marker.start, marker.end).replace(/\s+/gu, '')
  )) {
    delete clause.patientInstruction;
  }
  const retained = (item.fhir.extension ?? []).filter(extension => extension.url !== MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL);
  const graphExtension = buildInstructionGraphExtension(clause.instructionGraph);
  item.fhir.extension = graphExtension ? [...retained, graphExtension] : retained.length ? retained : undefined;
}

/**
 * Open continuation is semantically compatible with event/start bounds only.
 * End bounds followed by an open-continuation marker are contradictory and
 * deliberately become non-executable instead of being guessed.
 */
export function normalizeOpenEndedSchedule(item: ParseResult, source: string, options?: ParseOptions): boolean {
  const clause = item.meta.canonical.clauses[0];
  const schedule = clause?.schedule;
  if (!clause || !schedule) return false;
  const markers = findOpenEndedMarkers(source, options);
  if (!markers.length) return false;
  removeOwnedInstructionArtifacts(item, markers);

  const recurring = Boolean(
    schedule.frequency !== undefined || schedule.period !== undefined || schedule.dayOfWeek?.length || schedule.timingCode
  );
  if (!recurring) {
    quarantineSchedule(item, source, 'open-ended-bound-without-cadence');
    return false;
  }

  for (const marker of markers) {
    const span = marker.date;
    if (span.events.length !== 1 || span.unresolved) continue;
    if (span.relation === 'end-inclusive' || span.relation === 'end-exclusive') {
      quarantineSchedule(item, source, 'open-ended-marker-after-end-bound');
      return false;
    }
    if (span.relation !== 'event') continue;

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
  return true;
}
