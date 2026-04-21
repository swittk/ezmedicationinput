import { DEFAULT_ROUTE_SYNONYMS } from "./maps";
import { ParsedSigInternal, Token } from "./internal-types";
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
): { text?: string; coding?: FhirCoding } {
  return {
    text: instruction.text,
    coding: cloneCoding(instruction.coding)
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

function collectLeftoverSpans(internal: ParsedSigInternal): CanonicalSourceSpan[] {
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
  internal: ParsedSigInternal,
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

function buildClauseConfidence(internal: ParsedSigInternal, leftovers: CanonicalSourceSpan[]): number {
  let confidence = 1;
  confidence -= Math.min(0.4, leftovers.length * 0.12);
  confidence -= Math.min(0.2, internal.warnings.length * 0.08);

  if (!internal.routeCode && !internal.routeText && !internal.siteText && !internal.timingCode) {
    confidence -= 0.05;
  }

  return clampConfidence(confidence);
}

export function buildCanonicalSigClauses(
  internal: ParsedSigInternal
): CanonicalSigClause[] {
  const trimmedRange = computeTrimmedInputRange(internal.input);
  const raw = buildRangeSourceSpan(internal.input, trimmedRange);
  const leftovers = collectLeftoverSpans(internal);
  const clause: CanonicalSigClause = {
    kind: "administration",
    rawText: internal.input,
    span: trimmedRange,
    raw,
    leftovers,
    evidence: [],
    confidence: buildClauseConfidence(internal, leftovers)
  };

  if (internal.dose !== undefined || internal.doseRange || internal.unit) {
    const doseIndices = findTokensByLower(
      internal,
      (lower) =>
        lower === internal.unit?.toLowerCase() ||
        lower === String(internal.dose ?? "") ||
        lower === String(internal.doseRange?.low ?? "") ||
        lower === String(internal.doseRange?.high ?? "")
    );
    const doseSpan = spanFromTokenIndices(internal.input, internal.tokens, doseIndices) ?? raw;
    const evidence = buildEvidence("dose", doseSpan);
    clause.dose = {
      value: internal.dose,
      range: internal.doseRange
        ? {
          low: internal.doseRange.low,
          high: internal.doseRange.high
        }
        : undefined,
      unit: internal.unit,
      evidence
    };
    clause.evidence.push(...evidence);
  }

  if (internal.routeCode || internal.routeText) {
    const routeCode = internal.routeCode;
    const routeIndices = findTokensByLower(internal, (lower) => {
      const synonym = DEFAULT_ROUTE_SYNONYMS[lower];
      if (routeCode && synonym?.code === routeCode) {
        return true;
      }
      return Boolean(internal.routeText && lower === internal.routeText.toLowerCase());
    });
    const routeSpan = spanFromTokenIndices(internal.input, internal.tokens, routeIndices) ?? raw;
    const evidence = buildEvidence("route", routeSpan);
    clause.route = {
      code: internal.routeCode,
      text: internal.routeText,
      evidence
    };
    clause.evidence.push(...evidence);
  }

  if (internal.siteText || internal.siteCoding) {
    const siteSpan =
      spanFromTokenIndices(
        internal.input,
        internal.tokens,
        Array.from(internal.siteTokenIndices).sort((a, b) => a - b)
      ) ?? raw;
    const evidence = buildEvidence("site", siteSpan);
    clause.site = {
      text: internal.siteText,
      coding: internal.siteCoding?.code
        ? {
          code: internal.siteCoding.code,
          display: internal.siteCoding.display,
          system: internal.siteCoding.system
        }
        : undefined,
      source:
        internal.siteSource === "abbreviation" ? "abbreviation" : internal.siteSource ?? "text",
      evidence
    };
    clause.evidence.push(...evidence);
  }

  if (
    internal.timingCode ||
    internal.count !== undefined ||
    internal.frequency !== undefined ||
    internal.frequencyMax !== undefined ||
    internal.period !== undefined ||
    internal.periodMax !== undefined ||
    internal.periodUnit ||
    internal.dayOfWeek.length ||
    internal.when.length ||
    internal.timeOfDay?.length
  ) {
    const scheduleIndices = findTokensByLower(internal, (lower) => {
      return (
        lower === internal.timingCode?.toLowerCase() ||
        lower === "qam" ||
        lower === "qpm" ||
        lower === "nightly" ||
        lower === "daily" ||
        lower === "bid" ||
        lower === "tid" ||
        lower === "qid" ||
        lower === "qod" ||
        lower === "hs" ||
        lower === "ac" ||
        lower === "pc"
      );
    });
    const scheduleSpan = spanFromTokenIndices(internal.input, internal.tokens, scheduleIndices) ?? raw;
    const evidence = buildEvidence("schedule", scheduleSpan);
    clause.schedule = {
      timingCode: internal.timingCode,
      count: internal.count,
      frequency: internal.frequency,
      frequencyMax: internal.frequencyMax,
      period: internal.period,
      periodMax: internal.periodMax,
      periodUnit: internal.periodUnit,
      dayOfWeek: internal.dayOfWeek.length ? [...internal.dayOfWeek] : undefined,
      when: internal.when.length ? [...internal.when] : undefined,
      timeOfDay: internal.timeOfDay?.length ? [...internal.timeOfDay] : undefined,
      evidence
    };
    clause.evidence.push(...evidence);
  }

  if (internal.asNeeded || internal.asNeededReason || internal.asNeededReasonCoding) {
    const reasonWords = new Set(
      (internal.asNeededReason ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word.length > 0)
    );
    const prnIndices = findTokensByLower(
      internal,
      (lower) => lower === "prn" || lower === "needed" || reasonWords.has(lower)
    );
    const prnSpan = spanFromTokenIndices(internal.input, internal.tokens, prnIndices) ?? raw;
    const evidence = buildEvidence("prn", prnSpan);
    clause.prn = {
      enabled: Boolean(internal.asNeeded || internal.asNeededReason || internal.asNeededReasonCoding),
      reason: internal.asNeededReason || internal.asNeededReasonCoding
        ? {
          text: internal.asNeededReason,
          coding: cloneCoding(internal.asNeededReasonCoding)
        }
        : undefined,
      evidence
    };
    clause.evidence.push(...evidence);
  }

  if (internal.additionalInstructions?.length) {
    clause.additionalInstructions = internal.additionalInstructions.map((instruction) => ({
      text: instruction.text,
      coding: cloneCoding(instruction.coding),
      evidence: buildEvidence("additional-instruction", raw, instruction.text)
    }));
    clause.evidence.push(
      ...buildEvidence("additional-instruction", raw, "Trailing or workflow instruction")
    );
  }

  if (internal.warnings.length) {
    clause.warnings = [...internal.warnings];
  }

  return [clause];
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
