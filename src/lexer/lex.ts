import { DAY_OF_WEEK_TOKENS } from "../maps";
import { LexKind, LexToken, SurfaceToken, SurfaceTokenKind } from "./token-types";
import { scanSurfaceTokens } from "./surface";

const PER_SLASH_UNITS = new Set([
  "d",
  "day",
  "days",
  "wk",
  "w",
  "week",
  "weeks",
  "mo",
  "month",
  "months",
  "hr",
  "hrs",
  "hour",
  "hours",
  "h",
  "min",
  "mins",
  "minute",
  "minutes"
]);

const COMPACT_DISCRETE_UNITS_PATTERN =
  /^(tab|tabs|tablet|tablets|cap|caps|capsule|capsules|mg|mcg|ml|g|drops|drop|puff|puffs|spray|sprays|patch|patches)$/i;

function classifyLexKind(value: string): {
  kind: LexKind;
  value?: number;
  low?: number;
  high?: number;
} {
  const lower = value.toLowerCase();

  if (/^[0-9]+(?:\.[0-9]+)?$/.test(lower)) {
    return { kind: LexKind.Number, value: parseFloat(value) };
  }

  const rangeMatch = lower.match(/^([0-9]+(?:\.[0-9]+)?)-([0-9]+(?:\.[0-9]+)?)$/);
  if (rangeMatch) {
    return {
      kind: LexKind.NumberRange,
      low: parseFloat(rangeMatch[1]),
      high: parseFloat(rangeMatch[2])
    };
  }

  if (/^[0-9]+(?:st|nd|rd|th)$/i.test(lower)) {
    return { kind: LexKind.Ordinal };
  }

  if (
    /^@?\d{1,2}([:.]\d{2})?\s*(am|pm)?$/i.test(lower) ||
    /^\d{1,2}\s*(am|pm)$/i.test(lower)
  ) {
    return { kind: LexKind.TimeLike };
  }

  if (lower === "," || lower === ";") {
    return { kind: LexKind.Separator };
  }

  if (lower === "@" || lower === "&" || lower === "+") {
    return { kind: LexKind.Punctuation };
  }

  return { kind: LexKind.Word };
}

function isNumericText(value: string): boolean {
  return /^[0-9]+(?:\.[0-9]+)?$/.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasWhitespaceAround(surface: SurfaceToken, input: string): boolean {
  const before = surface.start > 0 ? input[surface.start - 1] : "";
  const after = surface.end < input.length ? input[surface.end] : "";
  return /\s/.test(before) && /\s/.test(after);
}

function isSurfaceText(surface: SurfaceToken | undefined): surface is SurfaceToken {
  return Boolean(surface && surface.kind === SurfaceTokenKind.Text);
}

function buildToken(
  text: string,
  surfaces: SurfaceToken[],
  input: string,
  start?: number,
  end?: number,
  derived?: true
): LexToken {
  const first = surfaces[0];
  const last = surfaces[surfaces.length - 1];
  const sourceStart = start ?? first.start;
  const sourceEnd = end ?? last.end;
  const classified = classifyLexKind(text);

  return {
    original: text,
    lower: text.toLowerCase(),
    index: -1,
    kind: classified.kind,
    value: classified.value,
    low: classified.low,
    high: classified.high,
    sourceStart,
    sourceEnd,
    surfaceIndices: surfaces.map((surface) => surface.index),
    sourceText: input.slice(sourceStart, sourceEnd),
    derived
  };
}

function pushSplitParts(
  output: LexToken[],
  surface: SurfaceToken,
  parts: string[],
  input: string
): void {
  let searchOffset = 0;
  const sourceLower = surface.lower;

  for (const part of parts) {
    const lowerPart = part.toLowerCase();
    const pattern = new RegExp(escapeRegExp(lowerPart), "i");
    const relative = sourceLower.slice(searchOffset).search(pattern);
    if (relative === -1) {
      output.push(buildToken(part, [surface], input, undefined, undefined, true));
      continue;
    }

    const partStart = surface.start + searchOffset + relative;
    const partEnd = partStart + part.length;
    searchOffset = partEnd - surface.start;
    output.push(
      buildToken(
        part,
        [surface],
        input,
        partStart,
        partEnd,
        part !== surface.original ? true : undefined
      )
    );
  }
}

function splitCompactToken(token: string): string[] {
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(token)) {
    return [token];
  }

  const compactTimesWord = token.match(/^([0-9]+(?:\.[0-9]+)?[x*])([A-Za-z]+)$/i);
  if (compactTimesWord) {
    return [compactTimesWord[1], compactTimesWord[2]];
  }

  const compactPoMeal = token.match(/^(po)(ac|pc|c)$/i);
  if (compactPoMeal) {
    return [compactPoMeal[1], compactPoMeal[2]];
  }

  if (/^[A-Za-z]+$/.test(token)) {
    return [token];
  }

  const qRange = token.match(/^q([0-9]+(?:\.[0-9]+)?)-([0-9]+(?:\.[0-9]+)?)([A-Za-z]+)$/i);
  if (qRange) {
    return [token.charAt(0), `${qRange[1]}-${qRange[2]}`, qRange[3]];
  }

  const match = token.match(/^([0-9]+(?:\.[0-9]+)?)([A-Za-z]+)$/);
  if (match) {
    const [, numberPart, suffix] = match;
    if (/^(st|nd|rd|th)$/i.test(suffix)) {
      return [token];
    }
    const compactPoMealUnit = suffix.match(/^(po)(ac|pc|c)$/i);
    if (compactPoMealUnit) {
      return [numberPart, compactPoMealUnit[1], compactPoMealUnit[2]];
    }
    if (!/^x\d+/i.test(suffix) && !/^q\d+/i.test(suffix)) {
      return [numberPart, suffix];
    }
  }

  return [token];
}

function tryDayRangeToken(
  surfaces: SurfaceToken[],
  index: number,
  input: string
): { token: LexToken; nextIndex: number } | undefined {
  const start = surfaces[index];
  const hyphen = surfaces[index + 1];
  const end = surfaces[index + 2];

  if (
    !isSurfaceText(start) ||
    !hyphen ||
    hyphen.original !== "-" ||
    !isSurfaceText(end) ||
    !DAY_OF_WEEK_TOKENS[start.lower] ||
    !DAY_OF_WEEK_TOKENS[end.lower]
  ) {
    return undefined;
  }

  return {
    token: buildToken(`${start.original}-${end.original}`, [start, hyphen, end], input, undefined, undefined, true),
    nextIndex: index + 3
  };
}

function tryQRangeToken(
  surfaces: SurfaceToken[],
  index: number,
  input: string
): { token: LexToken; nextIndex: number } | undefined {
  const start = surfaces[index];
  const hyphen = surfaces[index + 1];
  const end = surfaces[index + 2];

  if (!isSurfaceText(start) || !hyphen || hyphen.original !== "-" || !isSurfaceText(end)) {
    return undefined;
  }

  const startMatch = start.lower.match(/^q([0-9]+(?:\.[0-9]+)?)$/);
  const endMatch = end.lower.match(/^([0-9]+(?:\.[0-9]+)?)([a-z]+)$/);
  if (!startMatch || !endMatch) {
    return undefined;
  }

  return {
    token: buildToken(
      `q${startMatch[1]}-${endMatch[1]}${endMatch[2]}`,
      [start, hyphen, end],
      input,
      undefined,
      undefined,
      true
    ),
    nextIndex: index + 3
  };
}

function tryNumericRangeToken(
  surfaces: SurfaceToken[],
  index: number,
  input: string
): { token: LexToken; nextIndex: number } | undefined {
  const start = surfaces[index];
  const hyphen = surfaces[index + 1];
  const end = surfaces[index + 2];

  if (
    !isSurfaceText(start) ||
    !hyphen ||
    hyphen.original !== "-" ||
    !isSurfaceText(end) ||
    hasWhitespaceAround(hyphen, input) ||
    !isNumericText(start.lower) ||
    !isNumericText(end.lower)
  ) {
    return undefined;
  }

  return {
    token: buildToken(`${start.original}-${end.original}`, [start, hyphen, end], input, undefined, undefined, true),
    nextIndex: index + 3
  };
}

function trySlashUnitExpansion(
  surfaces: SurfaceToken[],
  index: number,
  input: string
): { tokens: LexToken[]; nextIndex: number } | undefined {
  const valueToken = surfaces[index];
  const slash = surfaces[index + 1];
  const unitToken = surfaces[index + 2];

  if (
    !isSurfaceText(valueToken) ||
    !slash ||
    slash.original !== "/" ||
    !isSurfaceText(unitToken) ||
    !isNumericText(valueToken.lower) ||
    !PER_SLASH_UNITS.has(unitToken.lower)
  ) {
    return undefined;
  }

  return {
    tokens: [
      buildToken(valueToken.original, [valueToken], input),
      buildToken("per", [slash], input, slash.start, slash.end, true),
      buildToken(unitToken.original, [unitToken], input)
    ],
    nextIndex: index + 3
  };
}

function tryFractionToken(
  surfaces: SurfaceToken[],
  index: number,
  input: string
): { token: LexToken; nextIndex: number } | undefined {
  const left = surfaces[index];
  const slash = surfaces[index + 1];
  const right = surfaces[index + 2];

  if (!isSurfaceText(left) || !slash || slash.original !== "/" || !isSurfaceText(right)) {
    return undefined;
  }

  const leftMatch = left.lower.match(/^([a-z]*)([0-9]+(?:\.[0-9]+)?)$/i);
  const rightMatch = right.lower.match(/^([0-9]+(?:\.[0-9]+)?)([a-z]*)$/i);
  if (!leftMatch || !rightMatch) {
    return undefined;
  }

  const numerator = parseFloat(leftMatch[2]);
  const denominator = parseFloat(rightMatch[1]);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return undefined;
  }

  const value = numerator / denominator;
  const prefix = leftMatch[1];
  const suffix = rightMatch[2];
  const normalized = `${prefix}${value.toString()}${suffix}`;

  return {
    token: buildToken(normalized, [left, slash, right], input, undefined, undefined, true),
    nextIndex: index + 3
  };
}

function tryTimeLikeToken(
  surfaces: SurfaceToken[],
  index: number,
  input: string
): { token: LexToken; nextIndex: number } | undefined {
  const hour = surfaces[index];
  const separator = surfaces[index + 1];
  const minute = surfaces[index + 2];

  if (
    !isSurfaceText(hour) ||
    !separator ||
    (separator.original !== ":" && separator.original !== ".") ||
    !isSurfaceText(minute) ||
    separator.start !== hour.end ||
    separator.end !== minute.start ||
    !/^\d{1,2}$/.test(hour.lower) ||
    !/^\d{2}$/.test(minute.lower)
  ) {
    return undefined;
  }

  return {
    token: buildToken(`${hour.original}${separator.original}${minute.original}`, [hour, separator, minute], input, undefined, undefined, true),
    nextIndex: index + 3
  };
}

function pushTextToken(output: LexToken[], surface: SurfaceToken, input: string): void {
  const slashUnitMatch = surface.original.match(
    /^([0-9]+(?:\.[0-9]+)?)\/(d|day|days|wk|w|week|weeks|mo|month|months|hr|hrs|hour|hours|h|min|mins|minute|minutes)$/i
  );
  if (slashUnitMatch) {
    const slashIndex = surface.original.indexOf("/");
    const valuePart = slashUnitMatch[1];
    const unitPart = slashUnitMatch[2];
    output.push(
      buildToken(valuePart, [surface], input, surface.start, surface.start + valuePart.length, true)
    );
    output.push(
      buildToken(
        "per",
        [surface],
        input,
        surface.start + slashIndex,
        surface.start + slashIndex + 1,
        true
      )
    );
    output.push(
      buildToken(
        unitPart,
        [surface],
        input,
        surface.end - unitPart.length,
        surface.end,
        true
      )
    );
    return;
  }

  const fractionMatch = surface.lower.match(
    /^([a-z]*)([0-9]+(?:\.[0-9]+)?)\/([0-9]+(?:\.[0-9]+)?)([a-z]*)$/i
  );
  if (fractionMatch) {
    const numerator = parseFloat(fractionMatch[2]);
    const denominator = parseFloat(fractionMatch[3]);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
      const normalized = `${fractionMatch[1]}${(numerator / denominator).toString()}${fractionMatch[4]}`;
      output.push(buildToken(normalized, [surface], input, undefined, undefined, true));
      return;
    }
  }

  const compactDiscrete = surface.original.match(
    /^([0-9]+(?:\.[0-9]+)?)([A-Za-z]+)$/
  );
  if (compactDiscrete && COMPACT_DISCRETE_UNITS_PATTERN.test(compactDiscrete[2])) {
    pushSplitParts(output, surface, [compactDiscrete[1], compactDiscrete[2]], input);
    return;
  }

  pushSplitParts(output, surface, splitCompactToken(surface.original), input);
}

export function lexInput(input: string): LexToken[] {
  const surfaces = scanSurfaceTokens(input);
  const output: LexToken[] = [];
  let index = 0;

  while (index < surfaces.length) {
    const current = surfaces[index];

    const dayRange = tryDayRangeToken(surfaces, index, input);
    if (dayRange) {
      output.push(dayRange.token);
      index = dayRange.nextIndex;
      continue;
    }

    const qRange = tryQRangeToken(surfaces, index, input);
    if (qRange) {
      output.push(qRange.token);
      index = qRange.nextIndex;
      continue;
    }

    const numericRange = tryNumericRangeToken(surfaces, index, input);
    if (numericRange) {
      output.push(numericRange.token);
      index = numericRange.nextIndex;
      continue;
    }

    const slashUnit = trySlashUnitExpansion(surfaces, index, input);
    if (slashUnit) {
      output.push(...slashUnit.tokens);
      index = slashUnit.nextIndex;
      continue;
    }

    const fraction = tryFractionToken(surfaces, index, input);
    if (fraction) {
      output.push(fraction.token);
      index = fraction.nextIndex;
      continue;
    }

    const timeLike = tryTimeLikeToken(surfaces, index, input);
    if (timeLike) {
      output.push(timeLike.token);
      index = timeLike.nextIndex;
      continue;
    }

    if (current.kind === SurfaceTokenKind.Separator) {
      if (current.original === "," || current.original === ";") {
        output.push(buildToken(current.original, [current], input));
      }
      index += 1;
      continue;
    }

    if (current.kind === SurfaceTokenKind.Punctuation) {
      if (current.original === "-" && hasWhitespaceAround(current, input)) {
        output.push(buildToken(";", [current], input, current.start, current.end, true));
      } else if (
        current.original === "@" ||
        current.original === "&" ||
        current.original === "+"
      ) {
        output.push(buildToken(current.original, [current], input));
      }
      index += 1;
      continue;
    }

    pushTextToken(output, current, input);
    index += 1;
  }

  for (let tokenIndex = 0; tokenIndex < output.length; tokenIndex += 1) {
    output[tokenIndex].index = tokenIndex;
  }

  return output;
}
