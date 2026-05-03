import { resolveBodySitePhrase } from "./body-site-grammar";
import { getBodySiteText } from "./body-site-lookup";
import {
  BodySiteCode,
  BodySiteDefinition,
  CanonicalSiteExpr,
  FhirCodeableConcept,
  FhirExtension
} from "./types";

export const BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL =
  "urn:ezmedicationinput:body-site-administration-target-count";

type SiteLike =
  | CanonicalSiteExpr
  | {
      text?: string;
      coding?: BodySiteCode;
      administrationTargetCount?: number;
      extension?: FhirExtension[];
    };

interface BodySiteTargetCountOptions {
  siteCodeMap?: Record<string, BodySiteDefinition>;
  bodySiteContext?: string;
}

function normalizeAdministrationTargetCount(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || value === undefined) {
    return undefined;
  }
  const rounded = Math.trunc(value);
  return rounded >= 2 ? rounded : undefined;
}

function siteTextFromLike(
  site: string | SiteLike | FhirCodeableConcept | undefined,
  options?: BodySiteTargetCountOptions
): string | undefined {
  if (!site) {
    return undefined;
  }
  if (typeof site === "string") {
    return site;
  }
  if ("text" in site && site.text) {
    return site.text;
  }
  const coding = "coding" in site
    ? Array.isArray(site.coding)
      ? site.coding.find((candidate) => candidate?.code)
      : site.coding
    : undefined;
  return coding?.code
    ? getBodySiteText(
        {
          system: coding.system,
          code: coding.code,
          display: coding.display
        },
        { siteCodeMap: options?.siteCodeMap }
      )
    : undefined;
}

export function buildBodySiteAdministrationTargetCountExtension(
  targetCount: number | undefined
): FhirExtension | undefined {
  const normalized = normalizeAdministrationTargetCount(targetCount);
  if (normalized === undefined) {
    return undefined;
  }
  return {
    url: BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL,
    valueInteger: normalized
  };
}

export function parseBodySiteAdministrationTargetCountExtension(
  concept: FhirCodeableConcept | { extension?: FhirExtension[] } | undefined
): number | undefined {
  const extension = concept?.extension?.find(
    (candidate) => candidate.url === BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL
  );
  return normalizeAdministrationTargetCount(extension?.valueInteger);
}

export function getBodySiteAdministrationTargetCount(
  site: string | SiteLike | FhirCodeableConcept | undefined,
  options?: BodySiteTargetCountOptions
): number | undefined {
  if (!site) {
    return undefined;
  }
  if (typeof site !== "string" && "administrationTargetCount" in site) {
    const direct = normalizeAdministrationTargetCount(site.administrationTargetCount);
    if (direct !== undefined) {
      return direct;
    }
  }
  if (typeof site !== "string") {
    if ("extension" in site) {
      const fromExtension = parseBodySiteAdministrationTargetCountExtension(site);
      if (fromExtension !== undefined) {
        return fromExtension;
      }
    }
  }
  const text = siteTextFromLike(site, options);
  if (!text) {
    return undefined;
  }
  const resolved = resolveBodySitePhrase(text, options?.siteCodeMap, {
    bodySiteContext: options?.bodySiteContext
  });
  return normalizeAdministrationTargetCount(resolved?.definition?.administrationTargetCount);
}
