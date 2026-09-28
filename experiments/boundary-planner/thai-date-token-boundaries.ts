import { findMedicationDateListSpans } from '../../src/date-interpretation';
import { LexKind, LexToken } from '../../src/lexer/token-types';
import type { ParseOptions } from '../../src/types';

const NUMERIC_DATE = /\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?/gu;

function fragmentToken(token: LexToken, input: string, start: number, end: number): LexToken {
  const original = input.slice(start, end);
  const numeric = /^\d+(?:\.\d+)?$/u.test(original);
  return {
    ...token,
    original,
    lower: original.toLowerCase(),
    canonical: undefined,
    kind: numeric ? LexKind.Number : LexKind.Word,
    value: numeric ? Number(original) : undefined,
    low: undefined,
    high: undefined,
    sourceStart: start,
    sourceEnd: end,
    sourceText: original,
    surfaceIndices: [...token.surfaceIndices],
    derived: true
  };
}

/**
 * Split only at numeric calendar-date boundaries already recognized from raw text.
 * This is intentionally not a general Thai-letter/digit splitter.
 */
export function splitTokensAtRecognizedThaiDateBoundaries(
  tokens: readonly LexToken[],
  input: string,
  options?: ParseOptions
): LexToken[] {
  const cuts = new Set<number>();
  for (const span of findMedicationDateListSpans(input, options)) {
    if (span.unresolved) continue;
    NUMERIC_DATE.lastIndex = 0;
    for (let match = NUMERIC_DATE.exec(span.sourceText); match; match = NUMERIC_DATE.exec(span.sourceText)) {
      const start = span.start + match.index;
      cuts.add(start);
      cuts.add(start + match[0].length);
    }
  }
  if (!cuts.size) return tokens.map((token, index) => ({ ...token, index }));

  const output: LexToken[] = [];
  for (const token of tokens) {
    const boundaries = [...cuts]
      .filter(cut => token.sourceStart < cut && cut < token.sourceEnd)
      .sort((left, right) => left - right);
    if (!boundaries.length) {
      output.push({ ...token });
      continue;
    }
    let start = token.sourceStart;
    for (const end of [...boundaries, token.sourceEnd]) {
      if (end > start) output.push(fragmentToken(token, input, start, end));
      start = end;
    }
  }
  for (let index = 0; index < output.length; index++) output[index].index = index;
  return output;
}
