import { EventTiming, FhirDayOfWeek, FhirPeriodUnit, RouteCode } from "./types";

export interface Token {
  original: string;
  lower: string;
  index: number;
}

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
  timingCode?: string;
  asNeeded?: boolean;
  asNeededReason?: string;
  warnings: string[];
  siteText?: string;
  siteSource?: "abbreviation" | "text";
  siteTokenIndices: Set<number>;
}
