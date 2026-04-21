import { isWhitespaceChar } from "../utils/text";
import { SurfaceToken, SurfaceTokenKind } from "./token-types";

const SEPARATOR_CHARS = new Set([",", ";", "(", ")"]);
const PUNCTUATION_CHARS = new Set(["\\", "+", "&"]);

function classifySurfaceKind(char: string): SurfaceTokenKind | undefined {
  if (SEPARATOR_CHARS.has(char)) {
    return SurfaceTokenKind.Separator;
  }
  if (PUNCTUATION_CHARS.has(char)) {
    return SurfaceTokenKind.Punctuation;
  }
  return undefined;
}

function isStandaloneSurfaceChar(char: string): boolean {
  return classifySurfaceKind(char) !== undefined;
}

export function scanSurfaceTokens(input: string): SurfaceToken[] {
  const tokens: SurfaceToken[] = [];
  let cursor = 0;

  while (cursor < input.length) {
    const char = input[cursor];

    if (isWhitespaceChar(char)) {
      cursor += 1;
      continue;
    }

    const standaloneKind = classifySurfaceKind(char);
    if (standaloneKind) {
      tokens.push({
        original: char,
        lower: char.toLowerCase(),
        index: tokens.length,
        kind: standaloneKind,
        start: cursor,
        end: cursor + 1
      });
      cursor += 1;
      continue;
    }

    const start = cursor;
    cursor += 1;
    while (cursor < input.length) {
      const next = input[cursor];
      if (isWhitespaceChar(next) || isStandaloneSurfaceChar(next)) {
        break;
      }
      cursor += 1;
    }

    const original = input.slice(start, cursor);
    tokens.push({
      original,
      lower: original.toLowerCase(),
      index: tokens.length,
      kind: SurfaceTokenKind.Text,
      start,
      end: cursor
    });
  }

  return tokens;
}
