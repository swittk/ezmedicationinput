import {
  EventTiming,
  FhirCoding,
  FhirDayOfWeek,
  FhirPeriodUnit,
  FhirPrimitiveElement,
  RouteCode,
  SiteCodeLookupRequest
} from "./types";

export interface ClauseMethodContribution {
  verb: string;
  text?: string;
  textElement?: FhirPrimitiveElement;
  coding?: FhirCoding;
}

export interface ClauseRouteContribution {
  code: RouteCode;
  text?: string;
}

export interface ClauseSiteContribution {
  text?: string;
  source?: "abbreviation" | "text" | "selection" | "resolver";
  coding?: FhirCoding;
  lookupRequest?: SiteCodeLookupRequest;
}

export interface ClauseScheduleContribution {
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

export interface ClauseFeatureContribution {
  consumedTokenIndices: number[];
  siteTokenIndices?: number[];
  warnings?: string[];
  method?: ClauseMethodContribution;
  route?: ClauseRouteContribution;
  site?: ClauseSiteContribution;
  schedule?: ClauseScheduleContribution;
}

export function sameOptionalScalar<T>(
  current: T | undefined,
  next: T | undefined
): boolean {
  return current === undefined || next === undefined || current === next;
}

export function sameCoding(
  left: FhirCoding | undefined,
  right: FhirCoding | undefined
): boolean {
  if (!left?.code || !right?.code) {
    return left?.code === right?.code;
  }
  return (
    left.code === right.code &&
    (left.system ?? "http://snomed.info/sct") ===
      (right.system ?? "http://snomed.info/sct")
  );
}
