import { ResolvedBodySitePhrase, resolveBodySitePhrase } from "./body-site-grammar";
import { normalizeBodySiteKey } from "./maps";
import { ParserState } from "./parser-state";
import { BodySiteSpatialRelation, FhirCoding } from "./types";
import { arrayIncludes } from "./utils/array";

const SNOMED_SYSTEM = "http://snomed.info/sct";

export interface BodySiteResolutionCandidates {
  canonicals: string[];
  codings: FhirCoding[];
  normalizedSiteText: string;
  normalizedSiteCodingDisplay: string;
}

function pushUniqueCanonical(canonicals: string[], value: string | undefined): void {
  const normalized = normalizeBodySiteKey(value ?? "");
  if (!normalized || arrayIncludes(canonicals, normalized)) {
    return;
  }
  canonicals.push(normalized);
}

function pushUniqueCoding(codings: FhirCoding[], coding: FhirCoding | undefined): void {
  if (!coding?.code) {
    return;
  }
  const system = coding.system ?? SNOMED_SYSTEM;
  if (
    codings.some(
      (candidate) =>
        candidate.code === coding.code &&
        (candidate.system ?? SNOMED_SYSTEM) === system
    )
  ) {
    return;
  }
  codings.push({
    code: coding.code,
    display: coding.display,
    system
  });
}

function pushSpatialRelationTarget(
  canonicals: string[],
  codings: FhirCoding[],
  relation: BodySiteSpatialRelation | undefined
): void {
  pushUniqueCanonical(canonicals, relation?.targetText);
  const targetCoding = relation?.targetCoding;
  pushUniqueCoding(
    codings,
    targetCoding?.code
      ? {
        code: targetCoding.code,
        display: targetCoding.display,
        system: targetCoding.system
      }
      : undefined
  );
}

function pushResolvedSite(
  canonicals: string[],
  codings: FhirCoding[],
  value:
    | string
    | ResolvedBodySitePhrase
    | {
      canonical?: string;
      text?: string;
      coding?: FhirCoding;
      spatialRelation?: BodySiteSpatialRelation;
    }
    | undefined
): void {
  if (!value) {
    return;
  }
  const resolvedSite =
    typeof value === "string"
      ? resolveBodySitePhrase(value, undefined)
      : value;
  if (!resolvedSite) {
    return;
  }
  pushUniqueCanonical(canonicals, resolvedSite.canonical);
  pushUniqueCanonical(canonicals, "displayText" in resolvedSite ? resolvedSite.displayText : resolvedSite.text);
  pushUniqueCoding(codings, resolvedSite.coding);
  pushSpatialRelationTarget(canonicals, codings, resolvedSite.spatialRelation);
}

export function collectParsedBodySiteCandidates(
  internal: ParserState
): BodySiteResolutionCandidates {
  const canonicals: string[] = [];
  const codings: FhirCoding[] = [];
  const normalizedSiteText = normalizeBodySiteKey(internal.siteText ?? "");
  const siteCodingDisplay = internal.siteCoding?.display;
  const normalizedSiteCodingDisplay = siteCodingDisplay
    ? normalizeBodySiteKey(siteCodingDisplay)
    : "";

  pushResolvedSite(
    canonicals,
    codings,
    internal.siteLookupRequest
      ? {
        canonical: internal.siteLookupRequest.canonical,
        text: internal.siteLookupRequest.text,
        coding: internal.siteCoding,
        spatialRelation: internal.siteLookupRequest.spatialRelation
      }
      : undefined
  );
  pushResolvedSite(canonicals, codings, internal.siteText);
  pushUniqueCanonical(canonicals, internal.siteLookupRequest?.canonical);
  pushUniqueCanonical(canonicals, internal.siteText);
  pushUniqueCanonical(canonicals, siteCodingDisplay);
  pushUniqueCoding(codings, internal.siteCoding);
  pushSpatialRelationTarget(canonicals, codings, internal.siteLookupRequest?.spatialRelation);
  pushSpatialRelationTarget(canonicals, codings, internal.siteSpatialRelation);

  return {
    canonicals,
    codings,
    normalizedSiteText,
    normalizedSiteCodingDisplay
  };
}
