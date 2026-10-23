import { MedicationDateListMatch } from '../date-interpretation';
import { lexicalRule, normalizeTokenLower } from '../hpsg/rule-context';
import { lexicalSign } from '../hpsg/signature';
import type { HpsgClauseContext } from '../hpsg/rule-context';
import type { Token } from '../parser-state';
import { ACTION_COORDINATION_CONNECTORS, ACTION_SEQUENCE_MARKERS } from '../hpsg/lexical-classes';
import { OPEN_ENDED_WORDS } from '../hpsg/lexical-classes';

interface OpenEndedMarkerMatch {
  start: number;
  markerStart: number;
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
    const event = date.events.length === 1 && !date.unresolved ? date.events[0] : undefined;
    if (!event || (date.relation !== 'event' && date.relation !== 'start-inclusive')) continue;
    output.push({ start: date.start, markerStart, end, date });
  }
  return output;
}

const CONTEXT_MARKERS = new WeakMap<HpsgClauseContext, OpenEndedMarkerMatch[]>();
function contextMarkers(context: HpsgClauseContext): OpenEndedMarkerMatch[] {
  const cached = CONTEXT_MARKERS.get(context);
  if (cached) return cached;
  const markers = resolveMarkers(context.tokens, context.dateSpans);
  CONTEXT_MARKERS.set(context, markers);
  return markers;
}

export function openEndedScheduleRule() {
  return lexicalRule('hpsg.lex.schedule.openEndedDate', (context: HpsgClauseContext, start: number) => {
    const first = context.tokens[start];
    if (!first) return [];
    const match = contextMarkers(context).find(value => value.start === first.sourceStart);
    if (!match) return [];
    const members = context.tokens
      .slice(start, context.limit)
      .filter(token => token.sourceStart >= match.start && token.sourceEnd <= match.end);
    const event = match.date.events[0];
    if (!members.length || !members.some(token => token.sourceStart >= match.markerStart)) return [];
    return [lexicalSign({
      type: 'schedule-sign',
      rule: 'hpsg.lex.schedule.openEndedDate',
      tokens: members,
      synsem: {
        head: {
          schedule: {
            boundsStart: event.isoDate,
            sourceRanges: [{ start: match.start, end: match.end }]
          }
        },
        valence: {},
        cont: { clauseKind: 'administration' }
      },
      score: 42 + members.length
    })];
  });
}
