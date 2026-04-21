import { DEFAULT_ROUTE_SYNONYMS } from "./maps";
import { ParserState, Token } from "./parser-state";
import {
  CanonicalEvidence,
  CanonicalAdditionalInstructionExpr,
  CanonicalSigClause,
  CanonicalSourceSpan,
  FhirCoding,
  TextRange
} from "./types";

function computeTrimmedInputRange(input: string): TextRange | undefined {
  if (!input) {
    return undefined;
  }
  const start = input.search(/\S/);
  if (start === -1) {
    return undefined;
  }
  let end = input.length;
  while (end > start && /\s/.test(input[end - 1] ?? "")) {
    end -= 1;
  }
  return { start, end };
}

function clampConfidence(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return Number(value.toFixed(2));
}

function cloneCoding(coding?: FhirCoding): FhirCoding | undefined {
  if (!coding?.code && !coding?.display && !coding?.system) {
    return undefined;
  }
  return {
    code: coding.code,
    display: coding.display,
    system: coding.system
  };
}

function cloneAdditionalInstruction(
  instruction: CanonicalAdditionalInstructionExpr
): { text?: string; coding?: FhirCoding; frames?: CanonicalAdditionalInstructionExpr["frames"] } {
  return {
    text: instruction.text,
    coding: cloneCoding(instruction.coding),
    frames: instruction.frames ? [...instruction.frames] : undefined
  };
}

function buildSourceSpan(
  input: string,
  start: number,
  end: number,
  tokenIndices?: number[]
): CanonicalSourceSpan {
  return {
    start,
    end,
    text: input.slice(start, end),
    tokenIndices: tokenIndices?.length ? [...tokenIndices] : undefined
  };
}

function buildRangeSourceSpan(
  input: string,
  range: TextRange | undefined,
  tokenIndices?: number[]
): CanonicalSourceSpan {
  const safeRange = range ?? { start: 0, end: input.length };
  return buildSourceSpan(input, safeRange.start, safeRange.end, tokenIndices);
}

function spanFromTokenIndices(
  input: string,
  tokens: Token[],
  tokenIndices: number[]
): CanonicalSourceSpan | undefined {
  let start: number | undefined;
  let end: number | undefined;
  const resolvedIndices: number[] = [];

  for (const tokenIndex of tokenIndices) {
    const token = tokens[tokenIndex];
    if (!token) {
      continue;
    }
    resolvedIndices.push(tokenIndex);
    start = start === undefined ? token.sourceStart : Math.min(start, token.sourceStart);
    end = end === undefined ? token.sourceEnd : Math.max(end, token.sourceEnd);
  }

  if (start === undefined || end === undefined) {
    return undefined;
  }

  return buildSourceSpan(input, start, end, resolvedIndices);
}

function buildEvidence(
  rule: string,
  span: CanonicalSourceSpan | undefined,
  note?: string,
  score?: number
): CanonicalEvidence[] {
  if (!span) {
    return [];
  }
  return [
    {
      rule,
      spans: [
        {
          ...span,
          tokenIndices: span.tokenIndices ? [...span.tokenIndices] : undefined
        }
      ],
      note,
      score
    }
  ];
}

function collectLeftoverSpans(internal: ParserState): CanonicalSourceSpan[] {
  const groups: CanonicalSourceSpan[] = [];
  let current: number[] = [];

  const flush = () => {
    if (!current.length) {
      return;
    }
    const span = spanFromTokenIndices(internal.input, internal.tokens, current);
    if (span) {
      groups.push(span);
    }
    current = [];
  };

  for (const token of internal.tokens) {
    if (internal.consumed.has(token.index)) {
      flush();
      continue;
    }

    if (current.length > 0 && token.index !== current[current.length - 1] + 1) {
      flush();
    }

    current.push(token.index);
  }

  flush();
  return groups;
}

function findTokensByLower(
  internal: ParserState,
  matcher: (lower: string) => boolean
): number[] {
  const matches: number[] = [];

  for (const token of internal.tokens) {
    if (!internal.consumed.has(token.index)) {
      continue;
    }
    if (matcher(token.lower)) {
      matches.push(token.index);
    }
  }

  return matches;
}

function buildClauseConfidence(internal: ParserState, leftovers: CanonicalSourceSpan[]): number {
  let confidence = 1;
  confidence -= Math.min(0.4, leftovers.length * 0.12);
  confidence -= Math.min(0.2, internal.warnings.length * 0.08);

  if (!internal.routeCode && !internal.routeText && !internal.siteText && !internal.timingCode) {
    confidence -= 0.05;
  }

  return clampConfidence(confidence);
}

export function buildCanonicalSigClauses(
  internal: ParserState
): CanonicalSigClause[] {
  return internal.clauses;
}

export function shiftCanonicalSigClauses(
  clauses: CanonicalSigClause[],
  offset: number
): void {
  for (const clause of clauses) {
    if (clause.span) {
      clause.span = {
        start: clause.span.start + offset,
        end: clause.span.end + offset
      };
    }

    clause.raw = {
      ...clause.raw,
      start: clause.raw.start + offset,
      end: clause.raw.end + offset
    };

    for (const leftover of clause.leftovers) {
      leftover.start += offset;
      leftover.end += offset;
    }

    const shiftEvidenceSpans = (evidence: CanonicalEvidence[] | undefined) => {
      if (!evidence) {
        return;
      }
      for (const entry of evidence) {
        for (const span of entry.spans) {
          span.start += offset;
          span.end += offset;
        }
      }
    };

    shiftEvidenceSpans(clause.evidence);
    shiftEvidenceSpans(clause.dose?.evidence);
    shiftEvidenceSpans(clause.route?.evidence);
    shiftEvidenceSpans(clause.site?.evidence);
    shiftEvidenceSpans(clause.schedule?.evidence);
    shiftEvidenceSpans(clause.prn?.evidence);

    if (clause.additionalInstructions) {
      for (const instruction of clause.additionalInstructions) {
        shiftEvidenceSpans(instruction.evidence);
      }
    }
  }
}
