import { Token, ParserState } from "../parser-state";
import { ParseOptions } from "../types";
import {
  ANTE_MERIDIEM_TOKENS,
  MERIDIEM_TOKENS,
  POST_MERIDIEM_TOKENS
} from "./lexical-classes";
import { HpsgLexicalRule } from "./signature";
import { HpsgProjectionDeps } from "./projection";
import { HpsgUnificationContext } from "./unification";

export interface HpsgClauseContext {
  state: ParserState;
  tokens: Token[];
  options?: ParseOptions;
  limit: number;
  deps: HpsgProjectionDeps & HpsgUnificationContext;
  project?: boolean;
}

export function normalizeTokenLower(token: Token): string {
  return token.lower.replace(/[{};]/g, "").replace(/^\.+|\.+$/g, "");
}

export function isPunctuation(lower: string): boolean {
  return !lower || /^[;:(),]+$/.test(lower);
}

export function isClockLikeLower(lower: string): boolean {
  return /^[0-9]{1,2}[:.][0-9]{2}$/.test(lower);
}

export function isAmPmLower(lower: string): boolean {
  return MERIDIEM_TOKENS.has(lower);
}

export function isAnteMeridiemLower(lower: string): boolean {
  return ANTE_MERIDIEM_TOKENS.has(lower);
}

export function isPostMeridiemLower(lower: string): boolean {
  return POST_MERIDIEM_TOKENS.has(lower);
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function parseClockToken(
  token: Token | undefined,
  meridiemToken?: Token | undefined
): { value: string; tokens: Token[] } | undefined {
  if (!token) {
    return undefined;
  }
  let lower = normalizeTokenLower(token);
  if (lower.startsWith("@")) {
    lower = lower.slice(1);
  }
  const meridiem = meridiemToken ? normalizeTokenLower(meridiemToken) : undefined;
  let hour: number;
  let minute = 0;
  const compactMeridiem = lower.match(/^([0-9]{1,2})\s*(am|pm)$/);
  if (compactMeridiem) {
    hour = parseInt(compactMeridiem[1], 10);
    if (hour < 1 || hour > 12) {
      return undefined;
    }
    if (isPostMeridiemLower(compactMeridiem[2]) && hour !== 12) {
      hour += 12;
    }
    if (isAnteMeridiemLower(compactMeridiem[2]) && hour === 12) {
      hour = 0;
    }
    return {
      value: `${pad2(hour)}:${pad2(minute)}:00`,
      tokens: [token]
    };
  }
  const clock = lower.match(/^([0-9]{1,2})[:.]([0-9]{2})$/);
  if (clock) {
    hour = parseInt(clock[1], 10);
    minute = parseInt(clock[2], 10);
  } else if (/^[0-9]{1,2}$/.test(lower) && meridiem && isAmPmLower(meridiem)) {
    hour = parseInt(lower, 10);
  } else {
    return undefined;
  }
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) {
    return undefined;
  }
  if (meridiem && isAmPmLower(meridiem)) {
    if (hour < 1 || hour > 12) {
      return undefined;
    }
    if (isPostMeridiemLower(meridiem) && hour !== 12) {
      hour += 12;
    }
    if (isAnteMeridiemLower(meridiem) && hour === 12) {
      hour = 0;
    }
    return {
      value: `${pad2(hour)}:${pad2(minute)}:00`,
      tokens: [token, meridiemToken as Token]
    };
  }
  if (hour < 0 || hour > 23) {
    return undefined;
  }
  return {
    value: `${pad2(hour)}:${pad2(minute)}:00`,
    tokens: [token]
  };
}

export function tokensAvailable(
  context: HpsgClauseContext,
  start: number,
  span: number
): Token[] | undefined {
  if (start + span > context.limit) {
    return undefined;
  }
  const tokens: Token[] = [];
  for (let offset = 0; offset < span; offset += 1) {
    const token = context.tokens[start + offset];
    if (!token || context.state.consumed.has(token.index)) {
      return undefined;
    }
    tokens.push(token);
  }
  return tokens;
}

export function rangeFromTokens(tokens: Token[]): { start: number; end: number } | undefined {
  if (!tokens.length) {
    return undefined;
  }
  return {
    start: tokens[0].sourceStart,
    end: tokens[tokens.length - 1].sourceEnd
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function splitByLexicalSeparators(text: string, separators: ReadonlySet<string>): string[] {
  const activeSeparators = Array.from(separators).filter((separator) => separator.length > 0);
  if (!activeSeparators.length) {
    return [text];
  }
  const separatorPattern = new RegExp(activeSeparators.map(escapeRegExp).join("|"), "g");
  return text.split(separatorPattern);
}

export function hasLexicalSeparator(text: string, separators: ReadonlySet<string>): boolean {
  return splitByLexicalSeparators(text, separators).length > 1;
}

export function joinTokenText(tokens: Token[]): string {
  return tokens
    .map((token) => token.original)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function lexicalRule(
  id: string,
  match: HpsgLexicalRule<HpsgClauseContext>["match"]
): HpsgLexicalRule<HpsgClauseContext> {
  return { id, type: "word-sign", match };
}
