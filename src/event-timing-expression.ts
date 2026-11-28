import { EVENT_TIMING_TOKENS } from "./maps";
import { EVENT_ARTICLE_TOKENS, FIXED_EVENT_PHRASES } from "./hpsg/lexical-classes";
import { EventTiming } from "./types";

export interface EventTimingExpression {
  timing: EventTiming;
  length: number;
}

export const MAX_EVENT_TIMING_EXPRESSION_PARTS = 1 + Math.max(
  1,
  ...Array.from(FIXED_EVENT_PHRASES.keys()).map((phrase) => phrase.split(/\s+/u).length)
);

/** Resolve the most specific canonical event expression at `start`. */
export function resolveEventTimingExpression(
  parts: readonly string[],
  start = 0,
  endExclusive = parts.length
): EventTimingExpression | undefined {
  const articleLength = EVENT_ARTICLE_TOKENS.has(parts[start] ?? "") ? 1 : 0;
  const nominalStart = start + articleLength;
  const available = Math.max(0, Math.min(endExclusive, parts.length) - nominalStart);
  if (!available) return undefined;
  const longest = Math.min(MAX_EVENT_TIMING_EXPRESSION_PARTS - 1, available);
  for (let length = longest; length >= 2; length -= 1) {
    const timing = FIXED_EVENT_PHRASES.get(parts.slice(nominalStart, nominalStart + length).join(" "));
    if (timing) return { timing, length: length + articleLength };
  }
  const direct = EVENT_TIMING_TOKENS[parts[nominalStart] ?? ""];
  return direct ? { timing: direct, length: 1 + articleLength } : undefined;
}
