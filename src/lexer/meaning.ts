import {
  DAY_OF_WEEK_TOKENS,
  DEFAULT_ROUTE_SYNONYMS,
  EVENT_TIMING_TOKENS,
  TIMING_ABBREVIATIONS
} from "../maps";

const CONNECTOR_WORDS = new Set([
  "to",
  "in",
  "into",
  "on",
  "onto",
  "at",
  "with",
  "and",
  "or",
  "per",
  "each",
  "every",
  "for",
  "after",
  "before",
  "then"
]);

const EYE_SITE_ABBREVIATIONS = new Set([
  "od",
  "os",
  "ou",
  "re",
  "le",
  "be",
  "vod",
  "vos",
  "ivtod",
  "ivtre",
  "ivtos",
  "ivtle",
  "ivtou",
  "ivtbe"
]);

const DAY_GROUP_TOKENS = new Set([
  "weekend",
  "weekends",
  "wknd",
  "weekdays",
  "weekday",
  "วันธรรมดา",
  "วันทำงาน",
  "วันหยุด",
  "สุดสัปดาห์",
  "เสาร์อาทิตย์",
  "วันเสาร์อาทิตย์"
]);

interface Lowerable {
  lower: string;
}

export function hasDayOfWeekMeaning(token: Lowerable | undefined): boolean {
  if (!token) {
    return false;
  }

  const normalized = token.lower.replace(/[.,;:]/g, "");
  if (DAY_OF_WEEK_TOKENS[normalized] || DAY_GROUP_TOKENS.has(normalized)) {
    return true;
  }

  if (/^([^-–—~/]+)[-–—~/]([^-–—~/]+)$/.test(normalized)) {
    return true;
  }

  return /^(.+?)(ถึง|จนถึง|to|through|thru)(.+)$/u.test(normalized);
}

export function hasEventTimingMeaning(token: Lowerable | undefined): boolean {
  return Boolean(token && EVENT_TIMING_TOKENS[token.lower]);
}

export function hasTimingAbbreviationMeaning(token: Lowerable | undefined): boolean {
  return Boolean(token && TIMING_ABBREVIATIONS[token.lower]);
}

export function hasRouteMeaning(token: Lowerable | undefined): boolean {
  return Boolean(token && DEFAULT_ROUTE_SYNONYMS[token.lower]);
}

export function hasEyeSiteAbbreviationMeaning(token: Lowerable | undefined): boolean {
  return Boolean(token && EYE_SITE_ABBREVIATIONS.has(token.lower));
}

export function hasPrnMeaning(token: Lowerable | undefined): boolean {
  return Boolean(token && (token.lower === "prn" || token.lower === "needed"));
}

export function hasConnectorMeaning(token: Lowerable | undefined): boolean {
  return Boolean(
    token &&
    (CONNECTOR_WORDS.has(token.lower) || token.lower === "," || token.lower === ";")
  );
}
