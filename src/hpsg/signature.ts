import {
  CanonicalDoseRange,
  CanonicalAdditionalInstructionExpr,
  BodySiteSpatialRelation,
  EventTiming,
  FhirCoding,
  FhirDayOfWeek,
  FhirPeriodUnit,
  FhirPrimitiveElement,
  RouteCode,
  PrnReasonLookupRequest,
  SiteCodeLookupRequest
} from "../types";
import { Token } from "../parser-state";

export type HpsgType =
  | "sign"
  | "word-sign"
  | "phrase-sign"
  | "clause-sign"
  | "method-sign"
  | "route-sign"
  | "site-sign"
  | "dose-sign"
  | "schedule-sign"
  | "prn-sign"
  | "instruction-sign"
  | "connector-sign";

export interface HpsgEvidence {
  rule: string;
  tokenIndices: number[];
}

export interface HpsgMethodFeature {
  verb: string;
  text?: string;
  textElement?: FhirPrimitiveElement;
  coding?: FhirCoding;
}

export interface HpsgRouteFeature {
  code: RouteCode;
  text?: string;
}

export interface HpsgSiteFeature {
  text?: string;
  source?: "abbreviation" | "text" | "selection" | "resolver";
  coding?: FhirCoding;
  spatialRelation?: BodySiteSpatialRelation;
  lookupRequest?: SiteCodeLookupRequest;
}

export interface HpsgPrnFeature {
  enabled: true;
  reasonText?: string;
  lookupRequest?: PrnReasonLookupRequest;
  reasons?: Array<{
    text: string;
    lookupRequest?: PrnReasonLookupRequest;
  }>;
  lookupRequests?: PrnReasonLookupRequest[];
}

export interface HpsgInstructionFeature extends CanonicalAdditionalInstructionExpr {}

export interface HpsgPatientInstructionFeature {
  text: string;
}

export interface HpsgDoseFeature {
  value?: number;
  range?: CanonicalDoseRange;
  unit?: string;
}

export interface HpsgScheduleFeature {
  timingCode?: string;
  count?: number;
  duration?: number;
  durationMax?: number;
  durationUnit?: FhirPeriodUnit;
  frequency?: number;
  frequencyMax?: number;
  period?: number;
  periodMax?: number;
  periodUnit?: FhirPeriodUnit;
  when?: EventTiming[];
  dayOfWeek?: FhirDayOfWeek[];
  timeOfDay?: string[];
}

export interface HpsgSynsem {
  head: {
    method?: HpsgMethodFeature;
    route?: HpsgRouteFeature;
    dose?: HpsgDoseFeature;
    schedule?: HpsgScheduleFeature;
  };
  valence: {
    site?: HpsgSiteFeature;
    prn?: HpsgPrnFeature;
    instructions?: HpsgInstructionFeature[];
    patientInstruction?: HpsgPatientInstructionFeature;
  };
  cont: {
    clauseKind?: "administration";
  };
}

export interface HpsgSign {
  type: HpsgType;
  span: { start: number; end: number };
  tokens: Token[];
  synsem: HpsgSynsem;
  consumedTokenIndices: number[];
  siteTokenIndices?: number[];
  warnings?: string[];
  evidence: HpsgEvidence[];
  score: number;
}

export interface HpsgLexicalRule<TContext> {
  id: string;
  type: HpsgType;
  match(context: TContext, start: number): HpsgSign[];
}

export interface HpsgPhraseRule<TContext> {
  id: string;
  left?: HpsgType;
  right?: HpsgType;
  combine(context: TContext, left: HpsgSign, right: HpsgSign): HpsgSign | undefined;
}

export interface HpsgGrammar<TContext> {
  lexicalRules: HpsgLexicalRule<TContext>[];
  phraseRules: HpsgPhraseRule<TContext>[];
}

export function emptySynsem(): HpsgSynsem {
  return {
    head: {},
    valence: {},
    cont: {}
  };
}

export function lexicalSign(args: {
  type: HpsgType;
  rule: string;
  tokens: Token[];
  synsem: HpsgSynsem;
  consumedTokenIndices?: number[];
  siteTokenIndices?: number[];
  warnings?: string[];
  score?: number;
}): HpsgSign {
  const tokenIndices = args.tokens
    .map((token) => token.index)
    .filter((index) => Number.isFinite(index));
  if (!tokenIndices.length) {
    throw new Error(`Cannot build lexical sign for ${args.rule} without token indices.`);
  }
  const start = Math.min(...tokenIndices);
  const end = Math.max(...tokenIndices) + 1;
  return {
    type: args.type,
    span: { start, end },
    tokens: args.tokens,
    synsem: args.synsem,
    consumedTokenIndices:
      args.consumedTokenIndices ?? tokenIndices,
    siteTokenIndices: args.siteTokenIndices,
    warnings: args.warnings,
    evidence: [
      {
        rule: args.rule,
        tokenIndices
      }
    ],
    score: args.score ?? 1
  };
}
