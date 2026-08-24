import {
  AdviceFrame,
  AdviceRelation,
  CanonicalDoseRange,
  CanonicalAdditionalInstructionExpr,
  CanonicalActivityTimingExpr,
  CanonicalOccurrenceCapExpr,
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
import { signFeatureStructure } from "./feature-structure";
import type { HpsgFeatureNode } from "./type-system";

export type HpsgType =
  | "sign"
  | "word-sign"
  | "phrase-sign"
  | "headed-phrase"
  | "head-complement-phrase"
  | "head-adjunct-phrase"
  | "head-marker-phrase"
  | "procedure-sequence-phrase"
  | "conditional-instruction-phrase"
  | "coordination-phrase"
  | "clause-sign"
  | "administration-clause"
  | "method-sign"
  | "route-sign"
  | "site-sign"
  | "dose-sign"
  | "schedule-sign"
  | "prn-sign"
  | "instruction-sign"
  | "conditional-sign"
  | "adjustment-sign"
  | "connector-sign";

export interface HpsgEvidence {
  rule: string;
  tokenIndices: number[];
}

export type HpsgConstructionKind =
  | "head-complement"
  | "head-adjunct"
  | "head-marker"
  | "procedure-sequence"
  | "conditional-instruction"
  | "coordination"
  | "administration-clause"
  | "generic";

export type HpsgConstructionOperation = "unify" | "scope";

export interface HpsgConstruction {
  kind: HpsgConstructionKind;
  operation?: HpsgConstructionOperation;
  headSide?: "left" | "right";
  leftType: HpsgType;
  rightType: HpsgType;
}


export interface HpsgMethodFeature {
  verb: string;
  headClass?: "administration" | "procedure";
  text?: string;
  textElement?: FhirPrimitiveElement;
  coding?: FhirCoding;
}

export interface HpsgRouteFeature {
  code: RouteCode;
  attachmentClass?: "administration" | "procedure";
  text?: string;
}

export interface HpsgSiteFeature {
  attachmentClass?: "administration" | "procedure";
  text?: string;
  i18n?: Record<string, string>;
  source?: "abbreviation" | "text" | "selection" | "resolver";
  coding?: FhirCoding;
  spatialRelation?: BodySiteSpatialRelation;
  lookupRequest?: SiteCodeLookupRequest;
}

export interface HpsgPrnFeature {
  enabled: true;
  reasonText?: string;
  triggerPhase?: "onset";
  lookupRequest?: PrnReasonLookupRequest;
  reasons?: Array<{
    text: string;
    triggerPhase?: "onset";
    lookupRequest?: PrnReasonLookupRequest;
  }>;
  lookupRequests?: PrnReasonLookupRequest[];
}

export interface HpsgInstructionFeature extends CanonicalAdditionalInstructionExpr {}

export interface HpsgPatientInstructionFeature {
  text: string;
}

export interface HpsgConditionFeature {
  relation: AdviceRelation;
  text: string;
  fullText: string;
  sourceStart: number;
  sourceEnd: number;
  targetStart: number;
  targetEnd: number;
  safety: boolean;
  frames: AdviceFrame[];
}

export interface HpsgScopedAdministrationFeature {
  condition: HpsgConditionFeature;
  head: HpsgSynsem["head"];
  site?: HpsgSiteFeature;
  prn?: HpsgPrnFeature;
  instructions?: HpsgInstructionFeature[];
  patientInstruction?: HpsgPatientInstructionFeature;
}

export interface HpsgDoseFeature {
  attachmentClass?: "administration" | "procedure";
  value?: number;
  range?: CanonicalDoseRange;
  unit?: string;
}

export interface HpsgScheduleFeature {
  attachmentClass?: "administration" | "procedure";
  timingCode?: string;
  count?: number;
  countMax?: number;
  duration?: number;
  durationMax?: number;
  durationUnit?: FhirPeriodUnit;
  frequency?: number;
  frequencyMax?: number;
  period?: number;
  periodMax?: number;
  periodUnit?: FhirPeriodUnit;
  offset?: number;
  offsetMin?: number;
  offsetMax?: number;
  when?: EventTiming[];
  dayOfWeek?: FhirDayOfWeek[];
  timeOfDay?: string[];
  activityTiming?: CanonicalActivityTimingExpr[];
  occurrenceCap?: CanonicalOccurrenceCapExpr;
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
    condition?: HpsgConditionFeature;
    scopedAdministrations?: HpsgScopedAdministrationFeature[];
    scopeClosed?: true;
  };
  nonlocal?: {
    scopeRequirements?: HpsgConditionFeature[];
  };
}

export interface HpsgSign {
  type: HpsgType;
  span: { start: number; end: number };
  tokens: Token[];
  synsem: HpsgSynsem;
  /** Formal typed feature graph used by the HPSG constraint substrate. */
  fs: HpsgFeatureNode;
  /** Immediate phrase-construction provenance for non-lexical signs. */
  construction?: HpsgConstruction;
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
    cont: {},
    nonlocal: {}
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
    fs: signFeatureStructure(args.type, args.synsem),
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
