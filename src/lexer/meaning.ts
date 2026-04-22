import {
  DAY_OF_WEEK_TOKENS,
  DEFAULT_ROUTE_SYNONYMS,
  EVENT_TIMING_TOKENS,
  FrequencyDescriptor,
  ROUTE_TEXT,
  RouteSynonym,
  TIMING_ABBREVIATIONS
} from "../maps";
import { arrayIncludes } from "../utils/array";
import { EventTiming, FhirDayOfWeek, RouteCode } from "../types";
import { LexToken } from "./token-types";

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

const SITE_ANCHOR_WORDS = new Set([
  "to",
  "in",
  "into",
  "on",
  "onto",
  "at",
  "under",
  "around",
  "behind",
  "above",
  "below",
  "beneath",
  "near"
]);

const SITE_LIST_CONNECTOR_WORDS = new Set(["and", "or", "&", "+", ","]);

const SITE_SURFACE_MODIFIER_WORDS = new Set([
  "left",
  "right",
  "both",
  "bilateral",
  "upper",
  "lower",
  "middle",
  "mid",
  "front",
  "back",
  "behind",
  "around",
  "under",
  "above",
  "below",
  "beneath",
  "near",
  "side",
  "top",
  "external",
  "internal",
  "big",
  "great",
  "affected",
  "intact",
  "of"
]);

const WORKFLOW_INSTRUCTION_WORDS = new Set([
  "wash",
  "washing",
  "shower",
  "showering",
  "bath",
  "bathing",
  "shampoo",
  "shampooing",
  "rinse",
  "rinsing",
  "cover",
  "dressing",
  "leave",
  "clean",
  "dry",
  "off",
  "then"
]);

const APPLICATION_ROUTE_VERBS = new Set([
  "apply",
  "rub",
  "massage",
  "spread",
  "dab",
  "lather"
]);

const ADMINISTRATION_ROUTE_HINTS: Record<string, RouteCode> = {
  apply: RouteCode["Topical route"],
  rub: RouteCode["Topical route"],
  massage: RouteCode["Topical route"],
  spread: RouteCode["Topical route"],
  dab: RouteCode["Topical route"],
  lather: RouteCode["Topical route"],
  take: RouteCode["Oral route"],
  drink: RouteCode["Oral route"],
  swallow: RouteCode["Oral route"]
};

const COUNT_KEYWORDS = new Set([
  "time",
  "times",
  "dose",
  "doses",
  "application",
  "applications",
  "use",
  "uses"
]);

const MEAL_CONTEXT_CONNECTOR_WORDS = new Set(["and", "or", "&", "+", "plus", ","]);

const TOKEN_SITE_CANDIDATES: Record<string, SiteMeaningCandidate[]> = {
  od: [{ text: "right eye", route: RouteCode["Ophthalmic route"], source: "abbreviation" }],
  re: [{ text: "right eye", route: RouteCode["Ophthalmic route"], source: "abbreviation" }],
  os: [{ text: "left eye", route: RouteCode["Ophthalmic route"], source: "abbreviation" }],
  le: [{ text: "left eye", route: RouteCode["Ophthalmic route"], source: "abbreviation" }],
  ou: [{ text: "both eyes", route: RouteCode["Ophthalmic route"], source: "abbreviation" }],
  be: [{ text: "both eyes", route: RouteCode["Ophthalmic route"], source: "abbreviation" }],
  vod: [
    {
      text: "right eye",
      route: RouteCode["Intravitreal route (qualifier value)"],
      source: "abbreviation"
    }
  ],
  vos: [
    {
      text: "left eye",
      route: RouteCode["Intravitreal route (qualifier value)"],
      source: "abbreviation"
    }
  ],
  ivtod: [
    {
      text: "right eye",
      route: RouteCode["Intravitreal route (qualifier value)"],
      source: "abbreviation"
    }
  ],
  ivtre: [
    {
      text: "right eye",
      route: RouteCode["Intravitreal route (qualifier value)"],
      source: "abbreviation"
    }
  ],
  ivtos: [
    {
      text: "left eye",
      route: RouteCode["Intravitreal route (qualifier value)"],
      source: "abbreviation"
    }
  ],
  ivtle: [
    {
      text: "left eye",
      route: RouteCode["Intravitreal route (qualifier value)"],
      source: "abbreviation"
    }
  ],
  ivtou: [
    {
      text: "both eyes",
      route: RouteCode["Intravitreal route (qualifier value)"],
      source: "abbreviation"
    }
  ],
  ivtbe: [
    {
      text: "both eyes",
      route: RouteCode["Intravitreal route (qualifier value)"],
      source: "abbreviation"
    }
  ]
};

const DAY_GROUP_TOKENS: Record<string, FhirDayOfWeek[]> = {
  weekend: [FhirDayOfWeek.Saturday, FhirDayOfWeek.Sunday],
  weekends: [FhirDayOfWeek.Saturday, FhirDayOfWeek.Sunday],
  wknd: [FhirDayOfWeek.Saturday, FhirDayOfWeek.Sunday],
  weekdays: [
    FhirDayOfWeek.Monday,
    FhirDayOfWeek.Tuesday,
    FhirDayOfWeek.Wednesday,
    FhirDayOfWeek.Thursday,
    FhirDayOfWeek.Friday
  ],
  weekday: [
    FhirDayOfWeek.Monday,
    FhirDayOfWeek.Tuesday,
    FhirDayOfWeek.Wednesday,
    FhirDayOfWeek.Thursday,
    FhirDayOfWeek.Friday
  ],
  workday: [
    FhirDayOfWeek.Monday,
    FhirDayOfWeek.Tuesday,
    FhirDayOfWeek.Wednesday,
    FhirDayOfWeek.Thursday,
    FhirDayOfWeek.Friday
  ],
  workdays: [
    FhirDayOfWeek.Monday,
    FhirDayOfWeek.Tuesday,
    FhirDayOfWeek.Wednesday,
    FhirDayOfWeek.Thursday,
    FhirDayOfWeek.Friday
  ],
  วันธรรมดา: [
    FhirDayOfWeek.Monday,
    FhirDayOfWeek.Tuesday,
    FhirDayOfWeek.Wednesday,
    FhirDayOfWeek.Thursday,
    FhirDayOfWeek.Friday
  ],
  วันทำงาน: [
    FhirDayOfWeek.Monday,
    FhirDayOfWeek.Tuesday,
    FhirDayOfWeek.Wednesday,
    FhirDayOfWeek.Thursday,
    FhirDayOfWeek.Friday
  ],
  วันหยุด: [FhirDayOfWeek.Saturday, FhirDayOfWeek.Sunday],
  วันเสาร์อาทิตย์: [FhirDayOfWeek.Saturday, FhirDayOfWeek.Sunday],
  สุดสัปดาห์: [FhirDayOfWeek.Saturday, FhirDayOfWeek.Sunday],
  เสาร์อาทิตย์: [FhirDayOfWeek.Saturday, FhirDayOfWeek.Sunday],
  จันทร์ถึงศุกร์: [
    FhirDayOfWeek.Monday,
    FhirDayOfWeek.Tuesday,
    FhirDayOfWeek.Wednesday,
    FhirDayOfWeek.Thursday,
    FhirDayOfWeek.Friday
  ]
};

const DAY_SEQUENCE: readonly FhirDayOfWeek[] = [
  FhirDayOfWeek.Monday,
  FhirDayOfWeek.Tuesday,
  FhirDayOfWeek.Wednesday,
  FhirDayOfWeek.Thursday,
  FhirDayOfWeek.Friday,
  FhirDayOfWeek.Saturday,
  FhirDayOfWeek.Sunday
];

const DAY_RANGE_CONNECTOR_WORDS = new Set(["-", "to", "through", "thru", "ถึง", "จนถึง"]);

export enum ConnectorRole {
  General = "GENERAL",
  SiteAnchor = "SITE_ANCHOR",
  SiteList = "SITE_LIST",
  MealContext = "MEAL_CONTEXT",
  DayRange = "DAY_RANGE"
}

export enum TokenWordClass {
  AdministrationVerb = "ADMINISTRATION_VERB",
  SiteSurfaceModifier = "SITE_SURFACE_MODIFIER",
  WorkflowInstruction = "WORKFLOW_INSTRUCTION",
  ApplicationVerb = "APPLICATION_VERB",
  CountKeyword = "COUNT_KEYWORD"
}

export interface SiteMeaningCandidate {
  text: string;
  route?: RouteCode;
  source: string;
}

export interface RouteMeaningCandidate extends RouteSynonym {
  source: string;
}

export interface TokenAnnotations {
  eventTiming?: EventTiming;
  timingAbbreviation?: FrequencyDescriptor;
  dayOfWeek?: FhirDayOfWeek[];
  routeCandidates?: RouteMeaningCandidate[];
  siteCandidates?: SiteMeaningCandidate[];
  prn?: true;
  connectorRoles?: ConnectorRole[];
  wordClasses?: TokenWordClass[];
}

export interface AnnotatedLexToken extends LexToken {
  annotations?: TokenAnnotations;
}

interface Lowerable {
  lower: string;
  annotations?: TokenAnnotations;
}

function normalizeMeaningKey(value: string): string {
  return value.toLowerCase().replace(/[.{}]/g, "");
}

function pushEnum<T extends string>(values: T[] | undefined, value: T): T[] {
  if (!values) {
    return [value];
  }
  if (!arrayIncludes(values, value)) {
    values.push(value);
  }
  return values;
}

function pushRouteCandidate(
  candidates: RouteMeaningCandidate[] | undefined,
  candidate: RouteMeaningCandidate
): RouteMeaningCandidate[] {
  if (!candidates) {
    return [candidate];
  }
  for (const existing of candidates) {
    if (existing.code === candidate.code && existing.text === candidate.text) {
      return candidates;
    }
  }
  candidates.push(candidate);
  return candidates;
}

export function expandDayMeaningRange(
  start: FhirDayOfWeek,
  end: FhirDayOfWeek
): FhirDayOfWeek[] {
  const startIndex = DAY_SEQUENCE.indexOf(start);
  const endIndex = DAY_SEQUENCE.indexOf(end);
  if (startIndex < 0 || endIndex < 0) {
    return [start, end];
  }
  if (startIndex <= endIndex) {
    return DAY_SEQUENCE.slice(startIndex, endIndex + 1);
  }
  return [...DAY_SEQUENCE.slice(startIndex), ...DAY_SEQUENCE.slice(0, endIndex + 1)];
}

export function resolveDayMeaning(tokenLower: string): FhirDayOfWeek[] | undefined {
  const normalized = normalizeMeaningKey(tokenLower);
  const direct = DAY_OF_WEEK_TOKENS[normalized];
  if (direct) {
    return [direct];
  }
  const grouped = DAY_GROUP_TOKENS[normalized];
  if (grouped) {
    return grouped.slice();
  }
  const rangeMatch = normalized.match(/^([^-–—~/]+)[-–—~/]([^-–—~/]+)$/);
  if (rangeMatch) {
    const startKey = rangeMatch[1].trim();
    const endKey = rangeMatch[2].trim();
    const start = DAY_OF_WEEK_TOKENS[startKey];
    const end = DAY_OF_WEEK_TOKENS[endKey];
    if (start && end) {
      return expandDayMeaningRange(start, end);
    }
  }
  const compactConnectorRange = normalized.match(/^(.+?)(ถึง|จนถึง|to|through|thru)(.+)$/u);
  if (compactConnectorRange) {
    const startKey = compactConnectorRange[1].trim();
    const endKey = compactConnectorRange[3].trim();
    const start = DAY_OF_WEEK_TOKENS[startKey];
    const end = DAY_OF_WEEK_TOKENS[endKey];
    if (start && end) {
      return expandDayMeaningRange(start, end);
    }
  }
  return undefined;
}

export function annotateLexToken(token: LexToken): AnnotatedLexToken {
  const normalized = normalizeMeaningKey(token.lower);
  let annotations: TokenAnnotations | undefined;

  const eventTiming = EVENT_TIMING_TOKENS[normalized];
  if (eventTiming) {
    annotations = annotations || {};
    annotations.eventTiming = eventTiming;
  }

  const timingAbbreviation = TIMING_ABBREVIATIONS[normalized];
  if (timingAbbreviation) {
    annotations = annotations || {};
    annotations.timingAbbreviation = timingAbbreviation;
  }

  const dayOfWeek = resolveDayMeaning(normalized);
  if (dayOfWeek) {
    annotations = annotations || {};
    annotations.dayOfWeek = dayOfWeek;
  }

  const routeSynonym = DEFAULT_ROUTE_SYNONYMS[normalized];
  if (routeSynonym) {
    annotations = annotations || {};
    annotations.routeCandidates = pushRouteCandidate(
      annotations.routeCandidates,
      {
        ...routeSynonym,
        source: "synonym"
      }
    );
  }

  const administrationRoute = ADMINISTRATION_ROUTE_HINTS[normalized];
  if (administrationRoute) {
    annotations = annotations || {};
    annotations.routeCandidates = pushRouteCandidate(
      annotations.routeCandidates,
      {
        code: administrationRoute,
        text: ROUTE_TEXT[administrationRoute],
        source: "verb"
      }
    );
    annotations.wordClasses = pushEnum(
      annotations.wordClasses,
      TokenWordClass.AdministrationVerb
    );
  }

  const siteCandidates = TOKEN_SITE_CANDIDATES[normalized];
  if (siteCandidates) {
    annotations = annotations || {};
    annotations.siteCandidates = siteCandidates.slice();
  }

  if (normalized === "prn" || normalized === "needed") {
    annotations = annotations || {};
    annotations.prn = true;
  }

  if (CONNECTOR_WORDS.has(normalized) || normalized === "," || normalized === ";") {
    annotations = annotations || {};
    annotations.connectorRoles = pushEnum(
      annotations.connectorRoles,
      ConnectorRole.General
    );
  }

  if (SITE_ANCHOR_WORDS.has(normalized)) {
    annotations = annotations || {};
    annotations.connectorRoles = pushEnum(
      annotations.connectorRoles,
      ConnectorRole.SiteAnchor
    );
  }

  if (SITE_LIST_CONNECTOR_WORDS.has(normalized)) {
    annotations = annotations || {};
    annotations.connectorRoles = pushEnum(
      annotations.connectorRoles,
      ConnectorRole.SiteList
    );
  }

  if (MEAL_CONTEXT_CONNECTOR_WORDS.has(normalized)) {
    annotations = annotations || {};
    annotations.connectorRoles = pushEnum(
      annotations.connectorRoles,
      ConnectorRole.MealContext
    );
  }

  if (DAY_RANGE_CONNECTOR_WORDS.has(normalized)) {
    annotations = annotations || {};
    annotations.connectorRoles = pushEnum(
      annotations.connectorRoles,
      ConnectorRole.DayRange
    );
  }

  if (SITE_SURFACE_MODIFIER_WORDS.has(normalized)) {
    annotations = annotations || {};
    annotations.wordClasses = pushEnum(
      annotations.wordClasses,
      TokenWordClass.SiteSurfaceModifier
    );
  }

  if (WORKFLOW_INSTRUCTION_WORDS.has(normalized)) {
    annotations = annotations || {};
    annotations.wordClasses = pushEnum(
      annotations.wordClasses,
      TokenWordClass.WorkflowInstruction
    );
  }

  if (APPLICATION_ROUTE_VERBS.has(normalized)) {
    annotations = annotations || {};
    annotations.wordClasses = pushEnum(
      annotations.wordClasses,
      TokenWordClass.ApplicationVerb
    );
  }

  if (COUNT_KEYWORDS.has(normalized)) {
    annotations = annotations || {};
    annotations.wordClasses = pushEnum(
      annotations.wordClasses,
      TokenWordClass.CountKeyword
    );
  }

  if (!annotations) {
    return token;
  }

  return {
    ...token,
    annotations
  };
}

export function annotateLexTokens(tokens: LexToken[]): AnnotatedLexToken[] {
  return tokens.map((token) => annotateLexToken(token));
}

export function hasConnectorRole(
  token: AnnotatedLexToken | undefined,
  role: ConnectorRole
): boolean {
  return Boolean(token?.annotations?.connectorRoles && arrayIncludes(token.annotations.connectorRoles, role));
}

export function hasTokenWordClass(
  token: AnnotatedLexToken | undefined,
  wordClass: TokenWordClass
): boolean {
  return Boolean(token?.annotations?.wordClasses && arrayIncludes(token.annotations.wordClasses, wordClass));
}

export function hasDayOfWeekMeaning(token: Lowerable | undefined): boolean {
  if (token?.annotations?.dayOfWeek) {
    return true;
  }
  return Boolean(token && resolveDayMeaning(token.lower));
}

export function getDayOfWeekMeaning(
  token: Lowerable | undefined
): FhirDayOfWeek[] | undefined {
  if (token?.annotations?.dayOfWeek) {
    return token.annotations.dayOfWeek.slice();
  }
  if (!token) {
    return undefined;
  }
  return resolveDayMeaning(token.lower);
}

export function hasEventTimingMeaning(token: Lowerable | undefined): boolean {
  if (token?.annotations?.eventTiming) {
    return true;
  }
  return Boolean(token && EVENT_TIMING_TOKENS[normalizeMeaningKey(token.lower)]);
}

export function getEventTimingMeaning(
  token: Lowerable | undefined
): EventTiming | undefined {
  if (token?.annotations?.eventTiming) {
    return token.annotations.eventTiming;
  }
  if (!token) {
    return undefined;
  }
  return EVENT_TIMING_TOKENS[normalizeMeaningKey(token.lower)];
}

export function hasTimingAbbreviationMeaning(token: Lowerable | undefined): boolean {
  if (token?.annotations?.timingAbbreviation) {
    return true;
  }
  return Boolean(token && TIMING_ABBREVIATIONS[normalizeMeaningKey(token.lower)]);
}

export function getTimingAbbreviationMeaning(
  token: Lowerable | undefined
): FrequencyDescriptor | undefined {
  if (token?.annotations?.timingAbbreviation) {
    return token.annotations.timingAbbreviation;
  }
  if (!token) {
    return undefined;
  }
  return TIMING_ABBREVIATIONS[normalizeMeaningKey(token.lower)];
}

export function hasRouteMeaning(token: Lowerable | undefined): boolean {
  if (token?.annotations?.routeCandidates?.length) {
    return true;
  }
  return Boolean(token && DEFAULT_ROUTE_SYNONYMS[normalizeMeaningKey(token.lower)]);
}

export function getRouteMeaning(
  token: Lowerable | undefined
): RouteMeaningCandidate | undefined {
  if (token?.annotations?.routeCandidates?.length) {
    return token.annotations.routeCandidates[0];
  }
  if (!token) {
    return undefined;
  }
  const synonym = DEFAULT_ROUTE_SYNONYMS[normalizeMeaningKey(token.lower)];
  return synonym
    ? {
        ...synonym,
        source: "synonym"
      }
    : undefined;
}

export function hasSiteMeaningCandidate(token: Lowerable | undefined): boolean {
  if (token?.annotations?.siteCandidates?.length) {
    return true;
  }
  return Boolean(token && TOKEN_SITE_CANDIDATES[normalizeMeaningKey(token.lower)]);
}

export function getSiteMeaningCandidates(
  token: Lowerable | undefined
): SiteMeaningCandidate[] | undefined {
  if (token?.annotations?.siteCandidates?.length) {
    return token.annotations.siteCandidates.slice();
  }
  if (!token) {
    return undefined;
  }
  const candidates = TOKEN_SITE_CANDIDATES[normalizeMeaningKey(token.lower)];
  return candidates ? candidates.slice() : undefined;
}

export function getPrimarySiteMeaningCandidate(
  token: Lowerable | undefined
): SiteMeaningCandidate | undefined {
  const candidates = getSiteMeaningCandidates(token);
  return candidates && candidates.length > 0 ? candidates[0] : undefined;
}

export function hasPrnMeaning(token: Lowerable | undefined): boolean {
  if (token?.annotations?.prn) {
    return true;
  }
  if (!token) {
    return false;
  }
  const normalized = normalizeMeaningKey(token.lower);
  return normalized === "prn" || normalized === "needed";
}

export function hasConnectorMeaning(token: Lowerable | undefined): boolean {
  if (token?.annotations?.connectorRoles?.length) {
    return true;
  }
  if (!token) {
    return false;
  }
  const normalized = normalizeMeaningKey(token.lower);
  return CONNECTOR_WORDS.has(normalized) || normalized === "," || normalized === ";";
}

export function isSiteAnchorWord(word: string): boolean {
  return SITE_ANCHOR_WORDS.has(normalizeMeaningKey(word));
}

export function isSiteListConnectorWord(word: string): boolean {
  return SITE_LIST_CONNECTOR_WORDS.has(normalizeMeaningKey(word));
}

export function isSiteSurfaceModifierWord(word: string): boolean {
  return SITE_SURFACE_MODIFIER_WORDS.has(normalizeMeaningKey(word));
}

export function isWorkflowInstructionWord(word: string): boolean {
  return WORKFLOW_INSTRUCTION_WORDS.has(normalizeMeaningKey(word));
}

export function isApplicationVerbWord(word: string): boolean {
  return APPLICATION_ROUTE_VERBS.has(normalizeMeaningKey(word));
}

export function isAdministrationVerbWord(word: string): boolean {
  return normalizeMeaningKey(word) in ADMINISTRATION_ROUTE_HINTS;
}

export function isCountKeywordWord(word: string): boolean {
  return COUNT_KEYWORDS.has(normalizeMeaningKey(word));
}

export function isMealContextConnectorWord(word: string): boolean {
  return MEAL_CONTEXT_CONNECTOR_WORDS.has(normalizeMeaningKey(word));
}

export function isDayRangeConnectorWord(word: string): boolean {
  return DAY_RANGE_CONNECTOR_WORDS.has(normalizeMeaningKey(word));
}
