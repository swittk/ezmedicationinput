import { isWhitespaceChar } from "../utils/text";
import { SurfaceToken, SurfaceTokenKind } from "./token-types";

const SEPARATOR_CHARS = new Set([",", ";", "(", ")"]);
const PUNCTUATION_CHARS = new Set(["\\", "+", "&"]);

const THAI_SCRIPT = /[\u0E00-\u0E7F]/;

interface IntlWordSegment {
  segment: string;
  index: number;
  isWordLike?: boolean;
}

interface IntlWordSegmenter {
  segment(input: string): Iterable<IntlWordSegment>;
}

type IntlWordSegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: "word" }
) => IntlWordSegmenter;

let thaiWordSegmenter: IntlWordSegmenter | null | undefined;

function getThaiWordSegmenter(): IntlWordSegmenter | undefined {
  if (thaiWordSegmenter !== undefined) {
    return thaiWordSegmenter ?? undefined;
  }
  const Segmenter = (Intl as unknown as { Segmenter?: IntlWordSegmenterConstructor }).Segmenter;
  if (!Segmenter) {
    thaiWordSegmenter = null;
    return undefined;
  }
  try {
    thaiWordSegmenter = new Segmenter("th", { granularity: "word" });
    return thaiWordSegmenter;
  } catch {
    thaiWordSegmenter = null;
    return undefined;
  }
}

function pushTextRun(tokens: SurfaceToken[], original: string, start: number): void {
  const segmenter = THAI_SCRIPT.test(original) ? getThaiWordSegmenter() : undefined;
  if (!segmenter) {
    tokens.push({
      original,
      lower: original.toLowerCase(),
      index: tokens.length,
      kind: SurfaceTokenKind.Text,
      start,
      end: start + original.length
    });
    return;
  }

  for (const part of segmenter.segment(original)) {
    if (!part.segment || /^\s+$/.test(part.segment)) {
      continue;
    }
    const partStart = start + part.index;
    const standaloneKind = part.segment.length === 1
      ? classifySurfaceKind(part.segment)
      : undefined;
    tokens.push({
      original: part.segment,
      lower: part.segment.toLowerCase(),
      index: tokens.length,
      kind: standaloneKind ?? SurfaceTokenKind.Text,
      start: partStart,
      end: partStart + part.segment.length
    });
  }
}

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
    pushTextRun(tokens, original, start);
  }

  return tokens;
}
