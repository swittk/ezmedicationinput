import { findMedicationDateListSpans } from '../../src/date-interpretation';
import { getDayOfWeekMeaning } from '../../src/lexer/meaning';
import { LexKind } from '../../src/lexer/token-types';
import { ACTION_COORDINATION_CONNECTORS, MERIDIEM_TOKENS } from '../../src/hpsg/lexical-classes';
import type { Token } from '../../src/parser-state';
import type { PlanningInput, StructuralClaim } from './types';

/** Use the existing locale normalizer; grammar never maintains Thai connector spellings. */
export function lexeme(token: Token | undefined): string {
  return token ? (token.canonical ?? token.lower).replace(/^[.,;:]+|[.,;:]+$/g, '') : '';
}

/** Recognize typed clock atoms, including a numeral followed by a shared meridiem token. */
export function clockEnd(tokens: Token[], index: number): number | undefined {
  const token = tokens[index];
  if (!token) return undefined;
  if (token.kind === LexKind.TimeLike) {
    return MERIDIEM_TOKENS.has(lexeme(tokens[index + 1])) ? index + 2 : index + 1;
  }
  if (token.kind === LexKind.Number && token.value !== undefined &&
      token.value >= 1 && token.value <= 12 && Number.isInteger(token.value) &&
      MERIDIEM_TOKENS.has(lexeme(tokens[index + 1]))) return index + 2;
  return undefined;
}

function listConnector(token: Token | undefined): boolean {
  return Boolean(token && (token.original === ',' || ACTION_COORDINATION_CONNECTORS.has(lexeme(token))));
}

/** Claims prevent only external segmentation; all internal tokens still reach clause HPSG. */
export function recognizeStructures(context: PlanningInput): StructuralClaim[] {
  const { input, options, tokens } = context;
  const claims: StructuralClaim[] = [];
  const add = (kind: StructuralClaim['kind'], start: number, end: number, producer: string, resolved = true) => {
    if (end > start) claims.push({ id: `${kind}:${start}:${end}`, kind, start, end, producer, resolved, policy: 'no-external-split' });
  };
  for (const span of findMedicationDateListSpans(input, options)) {
    add('calendar-date-list', span.start, span.end, 'findMedicationDateListSpans', !span.unresolved);
  }
  // List constructions compose typed atoms and canonical coordinators, not medication phrases.
  for (const kind of ['clock-list', 'weekday-list'] as const) {
    const atomEnd = (index: number): number | undefined => kind === 'clock-list'
      ? clockEnd(tokens, index)
      : getDayOfWeekMeaning(tokens[index])?.length ? index + 1 : undefined;
    for (let start = 0; start < tokens.length; start++) {
      let end = atomEnd(start);
      if (end === undefined) continue;
      let members = 1;
      while (listConnector(tokens[end])) {
        let next = end + 1;
        if (tokens[end]?.original === ',' && ACTION_COORDINATION_CONNECTORS.has(lexeme(tokens[next]))) next++;
        const after = atomEnd(next);
        if (after === undefined) break;
        members++; end = after;
      }
      if (members > 1) {
        add(kind, tokens[start].sourceStart, tokens[end - 1].sourceEnd, `structure.${kind}.coordination`);
        start = end - 1;
      }
    }
  }
  for (const token of tokens) {
    if (token.kind === LexKind.NumberRange ||
        token.kind === LexKind.Number && (token.sourceText ?? token.original).includes('/')) {
      add('numeric-quantity', token.sourceStart, token.sourceEnd, 'lexInput.numeric-span');
    }
  }
  const parens: number[] = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '(') parens.push(i);
    else if (input[i] === ')' && parens.length) {
      const start = parens.pop()!;
      if (!parens.length) add('parenthesized', start, i + 1, 'structure.balanced-parentheses');
    }
  }
  // Match the existing unmatched-parenthesis scope without swallowing text before the opener.
  if (parens.length) add('parenthesized', parens[0], input.length, 'structure.open-parenthesis', false);
  return claims.sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id));
}

/** Immutable interval index with prefix maxima: queries work for overlapping and nested claims. */
export class OwnershipIndex {
  private readonly maxEnd: number[] = [];
  constructor(readonly claims: StructuralClaim[]) {
    let max = -1;
    for (const claim of claims) { max = Math.max(max, claim.end); this.maxEnd.push(max); }
  }
  owner(offset: number): StructuralClaim | undefined {
    let lo = 0, hi = this.claims.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.claims[mid].start < offset) lo = mid + 1; else hi = mid; }
    let best: StructuralClaim | undefined;
    for (let i = lo - 1; i >= 0 && this.maxEnd[i] > offset; i--) {
      const claim = this.claims[i];
      if (claim.end > offset && (!best || claim.end - claim.start > best.end - best.start)) best = claim;
    }
    return best;
  }
}
