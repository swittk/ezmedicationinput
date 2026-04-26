import { lexInput } from "../lexer/lex";
import { annotateLexTokens } from "../lexer/meaning";
import { Token } from "../parser-state";

export interface HpsgSigSegment {
  text: string;
  start: number;
  end: number;
}

const HARD_BOUNDARY_TOKENS = new Set(["+", "|", "||", "//"]);
const CLAUSE_LEAD_WORDS = new Set([
  "apply",
  "take",
  "instill",
  "inject",
  "insert",
  "spray",
  "use",
  "drink",
  "swallow",
  "inhale",
  "gargle",
  "rinse",
  "od",
  "os",
  "ou",
  "re",
  "le",
  "right",
  "left",
  "both",
  "each"
]);

function isBoundaryToken(token: Token): boolean {
  const text = token.original.trim().toLowerCase();
  return HARD_BOUNDARY_TOKENS.has(text) || text === "\n" || text === "\r";
}

function isCommaClauseBoundary(tokens: Token[], index: number): boolean {
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
    (/^[0-9]{1,2}$/.test(rawLower) && (following === "am" || following === "pm"))
  ) {
    return false;
  }
  if (/^\d/.test(lower)) {
    return true;
  }
  if (!CLAUSE_LEAD_WORDS.has(lower)) {
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
  const lower = next.lower.replace(/[.,;:]/g, "");
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

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const isBoundary =
      isBoundaryToken(token) ||
      isCommaClauseBoundary(tokens, index) ||
      isSlashClauseBoundary(tokens, index);
    if (!isBoundary) {
      continue;
    }
    pushSegment(segments, input, start, token.sourceStart);
    start = token.sourceEnd;
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
