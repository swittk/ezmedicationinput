import { lexInput } from "../lexer/lex";
import { annotateLexTokens } from "../lexer/meaning";
import { Token } from "../parser-state";
import { parseAdditionalInstructions } from "../advice";
import { AdviceForce } from "../types";
import {
  CLAUSE_LEAD_WORDS,
  HARD_SEGMENT_BOUNDARY_TOKENS,
  LATERAL_MODIFIER_WORDS,
  MERIDIEM_TOKENS
} from "./lexical-classes";

export interface HpsgSigSegment {
  text: string;
  start: number;
  end: number;
}

function isBoundaryToken(token: Token): boolean {
  const text = token.original.trim().toLowerCase();
  return HARD_SEGMENT_BOUNDARY_TOKENS.has(text) || text === "\n" || text === "\r";
}

function parsesAsInstructionContinuation(input: string, tokens: Token[], index: number): boolean {
  const lead = tokens[index + 1];
  const firstInstructionToken = tokens[index + 2];
  if (!lead || !firstInstructionToken || !CLAUSE_LEAD_WORDS.has(lead.lower.replace(/[.,;:]/g, ""))) {
    return false;
  }
  const start = firstInstructionToken.sourceStart;
  let end = input.length;
  for (let cursor = index + 2; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (cursor > index + 2 && token.original === ",") {
      end = token.sourceStart;
      break;
    }
  }
  const text = input.slice(start, end).replace(/\s+/g, " ").trim();
  if (!text) {
    return false;
  }
  const instructions = parseAdditionalInstructions(text, { start, end }, {
    defaultPredicate: lead.lower.replace(/[.,;:]/g, "") || "take",
    defaultForce: AdviceForce.Instruction,
    allowFreeTextFallback: false
  });
  return instructions.some((instruction) => instruction.coding?.code || instruction.frames.length);
}

function isCommaClauseBoundary(input: string, tokens: Token[], index: number): boolean {
  const token = tokens[index];
  if (!token || token.original !== ",") {
    return false;
  }
  const next = tokens[index + 1];
  if (!next) {
    return false;
  }
  const lower = next.lower.replace(/[.,;:]/g, "");
  const rawLower = next.lower.replace(/^\.+|\.+$/g, "");
  const following = tokens[index + 2]?.lower.replace(/^\.+|\.+$/g, "");
  if (
    /^[0-9]{1,2}[:.][0-9]{2}$/.test(rawLower) ||
    (/^[0-9]{1,2}$/.test(rawLower) && Boolean(following && MERIDIEM_TOKENS.has(following)))
  ) {
    return false;
  }
  if (/^\d/.test(lower)) {
    return true;
  }
  if (LATERAL_MODIFIER_WORDS.has(lower) && (!following || !/^\d/.test(following))) {
    return false;
  }
  if (!CLAUSE_LEAD_WORDS.has(lower)) {
    return false;
  }
  if (parsesAsInstructionContinuation(input, tokens, index)) {
    return false;
  }
  return true;
}

function isSlashClauseBoundary(tokens: Token[], index: number): boolean {
  const token = tokens[index];
  if (!token || token.original !== "/") {
    return false;
  }
  const next = tokens[index + 1];
  if (!next) {
    return false;
  }
  const previous = tokens[index - 1];
  const previousLower = previous?.lower.replace(/[.,;:]/g, "") ?? "";
  const lower = next.lower.replace(/[.,;:]/g, "");
  if (/^\d+(?:\.\d+)?$/.test(previousLower) && /^\d+(?:\.\d+)?$/.test(lower)) {
    return false;
  }
  return /^\d/.test(lower) || CLAUSE_LEAD_WORDS.has(lower);
}

function pushSegment(
  segments: HpsgSigSegment[],
  input: string,
  start: number,
  end: number
): void {
  let trimmedStart = start;
  let trimmedEnd = end;
  while (trimmedStart < trimmedEnd && /\s/.test(input[trimmedStart] ?? "")) {
    trimmedStart += 1;
  }
  while (trimmedEnd > trimmedStart && /\s/.test(input[trimmedEnd - 1] ?? "")) {
    trimmedEnd -= 1;
  }
  if (trimmedEnd <= trimmedStart) {
    return;
  }
  segments.push({
    text: input.slice(trimmedStart, trimmedEnd),
    start: trimmedStart,
    end: trimmedEnd
  });
}

export function parseSigSegments(input: string): HpsgSigSegment[] {
  const tokens = annotateLexTokens(lexInput(input));
  const segments: HpsgSigSegment[] = [];
  let start = 0;
  let parenDepth = 0;
  let scannedOffset = 0;

  const scanParens = (end: number) => {
    for (; scannedOffset < end; scannedOffset += 1) {
      const char = input[scannedOffset];
      if (char === "(") {
        parenDepth += 1;
      } else if (char === ")") {
        parenDepth = Math.max(0, parenDepth - 1);
      }
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    scanParens(token.sourceStart);
    if (token.original === "(") {
      parenDepth += 1;
      scannedOffset = token.sourceEnd;
      continue;
    }
    if (token.original === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      scannedOffset = token.sourceEnd;
      continue;
    }
    if (parenDepth > 0) {
      scannedOffset = token.sourceEnd;
      continue;
    }
    const isBoundary =
      isBoundaryToken(token) ||
      isCommaClauseBoundary(input, tokens, index) ||
      isSlashClauseBoundary(tokens, index);
    if (!isBoundary) {
      scannedOffset = token.sourceEnd;
      continue;
    }
    pushSegment(segments, input, start, token.sourceStart);
    start = token.sourceEnd;
    scannedOffset = token.sourceEnd;
  }

  pushSegment(segments, input, start, input.length);
  if (segments.length) {
    return segments;
  }

  const text = input.trim();
  if (!text) {
    return [];
  }
  const startIndex = input.indexOf(text);
  return [{ text, start: startIndex, end: startIndex + text.length }];
}
