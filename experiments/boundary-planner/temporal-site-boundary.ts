import { hasDayOfWeekMeaning, hasEventTimingMeaning, hasTimingAbbreviationMeaning } from '../../src/lexer/meaning';
import { WORD_FREQUENCIES } from '../../src/maps';
import {
  EVERY_INTERVAL_TOKENS,
  FREQUENCY_NUMBER_WORDS,
  FREQUENCY_SIMPLE_WORDS,
  FREQUENCY_TIMES_WORDS,
  mapFrequencyAdverb,
  mapIntervalUnit
} from '../../src/hpsg/timing-lexicon';
import { ACTION_COORDINATION_CONNECTORS } from '../../src/hpsg/lexical-classes';
import { isClockLikeLower, normalizeTokenLower } from '../../src/hpsg/rule-context';
import type { HpsgClauseContext } from '../../src/hpsg/rule-context';

export function temporalRelationStarts(context: HpsgClauseContext, index: number): boolean {
  const token = context.tokens[index];
  if (!token) return false;
  return context.dateSpans.some(span =>
    span.start === token.sourceStart && span.relation !== 'event'
  );
}

function scheduleStarts(context: HpsgClauseContext, index: number): boolean {
  const token = context.tokens[index];
  if (!token) return false;
  const lower = normalizeTokenLower(token);
  return Boolean(
    temporalRelationStarts(context, index) ||
    WORD_FREQUENCIES[lower] ||
    FREQUENCY_SIMPLE_WORDS[lower] !== undefined ||
    FREQUENCY_NUMBER_WORDS[lower] !== undefined ||
    FREQUENCY_TIMES_WORDS.has(lower) ||
    EVERY_INTERVAL_TOKENS.has(lower) ||
    mapFrequencyAdverb(lower) ||
    mapIntervalUnit(lower) ||
    hasTimingAbbreviationMeaning(token) ||
    hasEventTimingMeaning(token) ||
    hasDayOfWeekMeaning(token) ||
    isClockLikeLower(lower)
  );
}

export function coordinationLeadsToSchedule(context: HpsgClauseContext, index: number): boolean {
  const token = context.tokens[index];
  if (!token || !ACTION_COORDINATION_CONNECTORS.has(normalizeTokenLower(token))) return false;
  return scheduleStarts(context, index + 1);
}
