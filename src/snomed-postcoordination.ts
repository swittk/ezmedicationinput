import { buildBodySiteSpatialRelationExtensions } from "./body-site-spatial";
import {
  SNOMED_CT_FINDING_SITE_ATTRIBUTE_CODE,
  SNOMED_SYSTEM
} from "./snomed";
import { BodySiteSpatialRelation, FhirCoding } from "./types";

const SNOMED_FINDING_SITE_ATTRIBUTE_MARKER = `:${SNOMED_CT_FINDING_SITE_ATTRIBUTE_CODE}=`;

export function hasSnomedFindingSitePostcoordination(code: string | undefined): boolean {
  return Boolean(code?.includes(SNOMED_FINDING_SITE_ATTRIBUTE_MARKER));
}

export function buildSnomedFindingSitePostcoordinationCode(
  focusCode: string,
  siteCode: string
): string {
  return `${focusCode}${SNOMED_FINDING_SITE_ATTRIBUTE_MARKER}${siteCode}`;
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

