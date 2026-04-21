import { AnnotatedLexToken } from "./lexer/meaning";
import {
  EventTiming,
  FhirCoding,
  FhirDayOfWeek,
  FhirPeriodUnit,
  PrnReasonLookupRequest,
  PrnReasonSuggestion,
  RouteCode,
  SiteCodeLookupRequest,
  SiteCodeSuggestion
} from "./types";

export interface SiteLookupDetail {
  request: SiteCodeLookupRequest;
  suggestions: SiteCodeSuggestion[];
}

export interface PrnReasonLookupDetail {
  request: PrnReasonLookupRequest;
  suggestions: PrnReasonSuggestion[];
}

export interface Token extends AnnotatedLexToken {}

export interface ParsedSigInternal {
  input: string;
  tokens: Token[];
  consumed: Set<number>;
  dose?: number;
  doseRange?: { low: number; high: number };
  unit?: string;
  routeCode?: RouteCode;
  routeText?: string;
  count?: number;
  frequency?: number;
  frequencyMax?: number;
  period?: number;
  periodMax?: number;
  periodUnit?: FhirPeriodUnit;
  dayOfWeek: FhirDayOfWeek[];
  when: EventTiming[];
  timeOfDay?: string[];
  timingCode?: string;
  asNeeded?: boolean;
  asNeededReason?: string;
  asNeededReasonCoding?: FhirCoding & { i18n?: Record<string, string> };
  warnings: string[];
  siteText?: string;
  siteSource?: "abbreviation" | "text";
  siteTokenIndices: Set<number>;
  siteCoding?: FhirCoding & { i18n?: Record<string, string> };
  siteLookupRequest?: SiteCodeLookupRequest;
  siteLookups: SiteLookupDetail[];
  customSiteHints?: Set<string>;
  prnReasonLookupRequest?: PrnReasonLookupRequest;
  prnReasonLookups: PrnReasonLookupDetail[];
  additionalInstructions: Array<{ text?: string; coding?: FhirCoding & { i18n?: Record<string, string> } }>;
}
