import {
  AdviceParseContext,
  ParsedAdditionalInstruction,
  parseAdditionalInstructions
} from "./advice";
import { LexKind } from "./lexer/token-types";
import { Token } from "./parser-state";
import { TextRange } from "./types";

export interface TailTokenSegment {
  startOffset: number;
  tokens: Token[];
  leadingSeparatorTokens: Token[];
  range: TextRange;
  text: string;
}

export interface ParsedInstructionTokenSegment {
  segment: TailTokenSegment;
  instructions: ParsedAdditionalInstruction[];
}

function isTailBoundaryToken(token: Token): boolean {
  switch (token.kind) {
    case LexKind.Punctuation:
    case LexKind.Separator:
      break;
    default:
      return false;
  }
  const trimmed = token.original.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed === "," || trimmed === ";" || trimmed === ":" || trimmed === ".") {
    return true;
  }
  if (trimmed === "-") {
    return true;
  }
  return token.original.indexOf("\n") >= 0 || token.original.indexOf("\r") >= 0;
}

function computeSegmentRange(tokens: Token[]): TextRange | undefined {
  let start: number | undefined;
  let end: number | undefined;
  for (const token of tokens) {
    if (token.sourceStart === undefined || token.sourceEnd === undefined) {
      continue;
    }
    start = start === undefined ? token.sourceStart : Math.min(start, token.sourceStart);
    end = end === undefined ? token.sourceEnd : Math.max(end, token.sourceEnd);
  }
  if (start === undefined || end === undefined) {
    return undefined;
  }
  return { start, end };
}

function buildSegmentText(
  input: string,
  tokens: Token[],
  range: TextRange | undefined
): string {
  if (range) {
    return input.slice(range.start, range.end).replace(/\s+/g, " ").trim();
  }
  return tokens.map((token) => token.original).join(" ").replace(/\s+/g, " ").trim();
}

export function splitTailTokenSegments(
  input: string,
  tokens: Token[]
): TailTokenSegment[] {
  const segments: TailTokenSegment[] = [];
  let currentTokens: Token[] = [];
  let currentStartOffset = 0;
  let currentLeadingSeparators: Token[] = [];
  let pendingSeparators: Token[] = [];

  const flush = () => {
    if (!currentTokens.length) {
      return;
    }
    const computedRange = computeSegmentRange(currentTokens);
    const text = buildSegmentText(input, currentTokens, computedRange);
    if (text) {
      segments.push({
        startOffset: currentStartOffset,
        tokens: currentTokens,
        leadingSeparatorTokens: currentLeadingSeparators,
        range: computedRange ?? { start: 0, end: text.length },
        text
      });
    }
    currentTokens = [];
    currentLeadingSeparators = [];
  };

  for (let offset = 0; offset < tokens.length; offset++) {
    const token = tokens[offset];
    if (isTailBoundaryToken(token)) {
      flush();
      pendingSeparators.push(token);
      continue;
    }
    if (!currentTokens.length) {
      currentStartOffset = offset;
      currentLeadingSeparators = pendingSeparators;
      pendingSeparators = [];
    }
    currentTokens.push(token);
  }

  flush();
  return segments;
}

function hasStructuredInstruction(
  instructions: ParsedAdditionalInstruction[]
): boolean {
  for (const instruction of instructions) {
    if (instruction.coding?.code || instruction.frames.length > 0) {
      return true;
    }
  }
  return false;
}

export function findStructuredInstructionTailOffset(
  input: string,
  tokens: Token[],
  context: AdviceParseContext
): number | undefined {
  const segments = splitTailTokenSegments(input, tokens);
  for (const segment of segments) {
    const instructions = parseAdditionalInstructions(segment.text, segment.range, {
      ...context,
      allowFreeTextFallback: false
    });
    if (hasStructuredInstruction(instructions)) {
      return segment.startOffset;
    }
  }
  return undefined;
}

export function hasInstructionBoundaryBeforeToken(
  tokens: Token[],
  tokenIndex: number
): boolean {
  let cursor =
    tokens[tokenIndex] && tokens[tokenIndex].index === tokenIndex
      ? tokenIndex - 1
      : tokens.findIndex((candidate) => candidate.index === tokenIndex) - 1;
  for (; cursor >= 0; cursor--) {
    const candidate = tokens[cursor];
    if (!candidate) {
      continue;
    }
    if (isTailBoundaryToken(candidate)) {
      return true;
    }
    if (candidate.kind === LexKind.Punctuation || candidate.kind === LexKind.Separator) {
      continue;
    }
    return false;
  }
  return false;
}

export function parseInstructionTokenSegments(
  input: string,
  tokens: Token[],
  context: AdviceParseContext
): ParsedInstructionTokenSegment[] {
  const segments = splitTailTokenSegments(input, tokens);
  const results: ParsedInstructionTokenSegment[] = [];
  let firstSegment = true;
  for (const segment of segments) {
    const instructions = parseAdditionalInstructions(segment.text, segment.range, {
      ...context,
      allowFreeTextFallback:
        firstSegment ? context.allowFreeTextFallback : true
    });
    firstSegment = false;
    if (!instructions.length) {
      continue;
    }
    results.push({ segment, instructions });
  }
  return results;
}
