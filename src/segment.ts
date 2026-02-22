export interface SigSegment {
  text: string;
  start: number;
  end: number;
}

interface SeparatorRule {
  name: string;
  match: (input: string, index: number, currentStart: number) => number;
}

const COMMA_SEGMENT_STARTERS = new Set([
  "apply",
  "take",
  "instill",
  "inject",
  "spray",
  "use",
  "od",
  "os",
  "ou",
  "re",
  "le",
  "be",
  "right",
  "left",
  "both",
  "each"
]);

const DIRECTIONAL_SEGMENT_STARTERS = new Set(["right", "left", "both", "each"]);

const SEPARATOR_RULES: SeparatorRule[] = [
  {
    name: "double-slash",
    match: (input, index) => (input.startsWith("//", index) ? 2 : 0)
  },
  {
    name: "line-break",
    match: (input, index) => {
      const ch = input[index];
      if (ch === "\r" && input[index + 1] === "\n") {
        return 2;
      }
      return ch === "\n" || ch === "\r" ? 1 : 0;
    }
  },
  {
    name: "pipe",
    match: (input, index) =>
      input[index] === "|" && hasNonWhitespaceAround(input, index) ? consumePipeRun(input, index) : 0
  },
  {
    name: "plus",
    match: (input, index) =>
      input[index] === "+" && hasNonWhitespaceAround(input, index) ? 1 : 0
  },
  {
    name: "slash-divider",
    match: (input, index) =>
      input[index] === "/" && isDividerSlash(input, index) ? 1 : 0
  },
  {
    name: "comma-clause",
    match: (input, index, currentStart) =>
      input[index] === "," && shouldSplitComma(input, index, currentStart) ? 1 : 0
  }
];

export function splitSigSegments(input: string): SigSegment[] {
  const segments: SigSegment[] = [];
  let currentStart = 0;
  let depth = 0;

  const pushSegment = (rawStart: number, rawEnd: number) => {
    let start = rawStart;
    let end = rawEnd;
    while (start < end && /\s/.test(input[start])) {
      start += 1;
    }
    while (end > start && /\s/.test(input[end - 1])) {
      end -= 1;
    }
    if (end <= start) {
      return;
    }
    segments.push({
      text: input.slice(start, end),
      start,
      end
    });
  };

  for (let index = 0; index < input.length; index += 1) {
    const ch = input[index];
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      continue;
    }
    if ((ch === ")" || ch === "]" || ch === "}") && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth > 0) {
      continue;
    }

    for (const rule of SEPARATOR_RULES) {
      const length = rule.match(input, index, currentStart);
      if (!length) {
        continue;
      }
      pushSegment(currentStart, index);
      currentStart = index + length;
      index = currentStart - 1;
      break;
    }
  }

  pushSegment(currentStart, input.length);

  if (segments.length > 0) {
    return segments;
  }

  const fallback = input.trim();
  if (!fallback) {
    return [];
  }
  const start = input.indexOf(fallback);
  return [{ text: fallback, start, end: start + fallback.length }];
}

function hasNonWhitespaceAround(input: string, index: number): boolean {
  const left = previousNonWhitespace(input, index - 1);
  const right = nextNonWhitespace(input, index + 1);
  return left !== undefined && right !== undefined;
}

function isDividerSlash(input: string, index: number): boolean {
  if (input[index - 1] === "/" || input[index + 1] === "/") {
    return false;
  }
  const previous = previousNonWhitespace(input, index - 1);
  const next = nextNonWhitespace(input, index + 1);
  if (previous === undefined || next === undefined) {
    return false;
  }
  if (/\d/.test(previous) && /\d/.test(next)) {
    return false;
  }
  return /\s/.test(input[index - 1] ?? "") || /\s/.test(input[index + 1] ?? "");
}

function shouldSplitComma(
  input: string,
  index: number,
  currentStart: number
): boolean {
  if (!hasNonWhitespaceAround(input, index)) {
    return false;
  }

  const left = input.slice(currentStart, index).trim();
  const right = input.slice(index + 1).trim();
  if (!left || !right) {
    return false;
  }
  if (startsWithTimeExpression(right)) {
    return false;
  }

  const rightToken = right.match(/^([a-z]+|\d+(?:\.\d+)?)/i)?.[1]?.toLowerCase();
  if (!rightToken) {
    return false;
  }
  if (/^\d/.test(rightToken)) {
    return true;
  }
  if (COMMA_SEGMENT_STARTERS.has(rightToken)) {
    if (DIRECTIONAL_SEGMENT_STARTERS.has(rightToken)) {
      return looksLikeDirectionalClause(right);
    }
    return true;
  }
  return false;
}

function looksLikeDirectionalClause(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (/\b\d+(?:\.\d+)?\b/.test(normalized)) {
    return true;
  }

  return /\b(once|twice|thrice|daily|bid|tid|qid|q\d+[a-z0-9/-]*|every|prn|hs|morning|lunch|dinner|noon|night|weekly|monthly)\b/.test(
    normalized
  );
}

function startsWithTimeExpression(text: string): boolean {
  const trimmed = text.replace(/^\s+/, "");
  if (!trimmed) {
    return false;
  }
  return (
    /^@\s*\d{1,2}([:.]\d{2})?\s*(am|pm)?\b/i.test(trimmed) ||
    /^\d{1,2}[:.]\d{2}\s*(am|pm)?\b/i.test(trimmed) ||
    /^\d{1,2}\s*(am|pm)\b/i.test(trimmed)
  );
}

function previousNonWhitespace(input: string, index: number): string | undefined {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const ch = input[cursor];
    if (!/\s/.test(ch)) {
      return ch;
    }
  }
  return undefined;
}

function nextNonWhitespace(input: string, index: number): string | undefined {
  for (let cursor = index; cursor < input.length; cursor += 1) {
    const ch = input[cursor];
    if (!/\s/.test(ch)) {
      return ch;
    }
  }
  return undefined;
}

function consumePipeRun(input: string, index: number): number {
  let cursor = index;
  while (cursor < input.length && input[cursor] === "|") {
    cursor += 1;
  }
  return cursor - index;
}
