import { buildBodySiteSpatialRelationExtensions } from "./body-site-spatial";
import {
  SNOMED_CT_FINDING_SITE_ATTRIBUTE_CODE,
  SNOMED_CT_LATERALITY_ATTRIBUTE_CODE,
  SNOMED_CT_TOPOGRAPHICAL_MODIFIER_CODE,
  SNOMED_SYSTEM
} from "./snomed";
import { BodySiteSpatialRelation, FhirCoding } from "./types";

const SNOMED_FINDING_SITE_ATTRIBUTE_MARKER = `:${SNOMED_CT_FINDING_SITE_ATTRIBUTE_CODE}=`;
const SNOMED_TOPOGRAPHICAL_MODIFIER_MARKER = `:${SNOMED_CT_TOPOGRAPHICAL_MODIFIER_CODE}=`;
const SNOMED_LATERALITY_MARKER = `:${SNOMED_CT_LATERALITY_ATTRIBUTE_CODE}=`;

export function hasSnomedFindingSitePostcoordination(code: string | undefined): boolean {
  return Boolean(code?.includes(SNOMED_FINDING_SITE_ATTRIBUTE_MARKER));
}

export function buildSnomedFindingSitePostcoordinationCode(
  focusCode: string,
  siteCode: string
): string {
  const site = siteCode.trim();
  const value = /[:+]/u.test(site) && !(site.startsWith("(") && site.endsWith(")"))
    ? `(${site})` : site;
  return `${focusCode}${SNOMED_FINDING_SITE_ATTRIBUTE_MARKER}${value}`;
}

export function hasSnomedTopographicalModifierPostcoordination(code: string | undefined): boolean {
  return Boolean(code?.includes(SNOMED_TOPOGRAPHICAL_MODIFIER_MARKER));
}

export function buildSnomedBodySiteTopographicalModifierPostcoordinationCode(
  siteCode: string,
  modifierCode: string
): string {
  return `${siteCode}${SNOMED_TOPOGRAPHICAL_MODIFIER_MARKER}${modifierCode}`;
}

export function hasSnomedBodySiteLateralityPostcoordination(code: string | undefined): boolean {
  return Boolean(code?.includes(SNOMED_LATERALITY_MARKER));
}

export function buildSnomedBodySiteLateralityPostcoordinationCode(
  siteCode: string,
  lateralityCode: string
): string {
  return `${siteCode}${SNOMED_LATERALITY_MARKER}${lateralityCode}`;
}

export function parseSnomedBodySiteTopographicalModifierPostcoordinationCode(
  code: string | undefined
): { siteCode: string; modifierCode: string } | undefined {
  // A valid assignment starts at the FIRST colon; an embedded extra
  // relation cannot be mistaken for the requested top-level attribute.
  // Find the colon once, then compare its fixed-width marker directly.
  // No second substring search and no repeated array membership walk.
  const markerIndex = code?.indexOf(":") ?? -1;
  if (!code || markerIndex < 0 || code.slice(markerIndex, markerIndex + SNOMED_TOPOGRAPHICAL_MODIFIER_MARKER.length) !== SNOMED_TOPOGRAPHICAL_MODIFIER_MARKER) {
    return undefined;
  }
  const siteCode = code.slice(0, markerIndex).trim();
  const modifierCode = code
    .slice(markerIndex + SNOMED_TOPOGRAPHICAL_MODIFIER_MARKER.length)
    .trim();
  if (!siteCode || !modifierCode) {
    return undefined;
  }
  return { siteCode, modifierCode };
}

export function parseSnomedBodySiteLateralityPostcoordinationCode(
  code: string | undefined
): { siteCode: string; lateralityCode: string } | undefined {
  // A valid assignment starts at the FIRST colon; an embedded extra
  // relation cannot be mistaken for the requested top-level attribute.
  // Find the colon once, then compare its fixed-width marker directly.
  // No second substring search and no repeated array membership walk.
  const markerIndex = code?.indexOf(":") ?? -1;
  if (!code || markerIndex < 0 || code.slice(markerIndex, markerIndex + SNOMED_LATERALITY_MARKER.length) !== SNOMED_LATERALITY_MARKER) {
    return undefined;
  }
  const siteCode = code.slice(0, markerIndex).trim();
  const lateralityCode = code
    .slice(markerIndex + SNOMED_LATERALITY_MARKER.length)
    .trim();
  if (!siteCode || !lateralityCode) {
    return undefined;
  }
  return { siteCode, lateralityCode };
}

export function parseSnomedFindingSitePostcoordinationCode(
  code: string | undefined
): { focusCode: string; siteCode: string } | undefined {
  // A valid assignment starts at the FIRST colon; an embedded extra
  // relation cannot be mistaken for the requested top-level attribute.
  // Find the colon once, then compare its fixed-width marker directly.
  // No second substring search and no repeated array membership walk.
  const markerIndex = code?.indexOf(":") ?? -1;
  if (!code || markerIndex < 0 || code.slice(markerIndex, markerIndex + SNOMED_FINDING_SITE_ATTRIBUTE_MARKER.length) !== SNOMED_FINDING_SITE_ATTRIBUTE_MARKER) {
    return undefined;
  }
  const focusCode = code.slice(0, markerIndex).trim();
  const siteValue = code
    .slice(markerIndex + SNOMED_FINDING_SITE_ATTRIBUTE_MARKER.length)
    .trim();
  const siteCode = siteValue.startsWith("(") && siteValue.endsWith(")")
    ? siteValue.slice(1, -1).trim() : siteValue;
  if (!focusCode || !siteCode) {
    return undefined;
  }
  return { focusCode, siteCode };
}

export function buildSnomedFindingSiteCoding(params: {
  focusCoding: FhirCoding | undefined;
  siteCoding: FhirCoding | undefined;
  display?: string;
  spatialRelation?: BodySiteSpatialRelation;
}): FhirCoding | undefined {
  const focusCode = params.focusCoding?.code;
  const siteCode = params.siteCoding?.code;
  if (!focusCode || !siteCode || hasSnomedFindingSitePostcoordination(focusCode)) {
    return undefined;
  }

  const focusSystem = params.focusCoding?.system ?? SNOMED_SYSTEM;
  const siteSystem = params.siteCoding?.system ?? SNOMED_SYSTEM;
  if (focusSystem !== SNOMED_SYSTEM || siteSystem !== SNOMED_SYSTEM) {
    return undefined;
  }

  return {
    system: SNOMED_SYSTEM,
    code: buildSnomedFindingSitePostcoordinationCode(focusCode, siteCode),
    display: params.display,
    extension: buildBodySiteSpatialRelationExtensions(params.spatialRelation)
  };
}
