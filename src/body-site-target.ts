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
  for(const extension of concept?.extension??[]) {
    if(extension.url===BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL)
      return normalizeAdministrationTargetCount(extension.valueInteger);
  }
  return undefined;
}

/** Default body-site grammar is stable; keyed text/context results are
 * inexpensive immutable facts. Custom maps deliberately bypass this cache,
 * and changing an imported object's text creates a different key (no stale
 * object-identity memoization). Limit memory to a small bounded vocabulary. */
const defaultTargetCounts=new Map<string,number>();
const TARGET_COUNT_CACHE_LIMIT=2048;
export function getBodySiteAdministrationTargetCount(
  site: string | SiteLike | FhirCodeableConcept | undefined,
  options?: BodySiteTargetCountOptions
): number | undefined {
  if (!site) {
    return undefined;
  }
  if(typeof site!=="string") {
    const fact=site as {administrationTargetCount?:number;extension?:FhirExtension[]};
    const explicitCount=fact.administrationTargetCount;
    // Ordinary FHIR concepts carry only the extension. Do not normalize an
    // absent internal count before reading that known final field.
    if(explicitCount!==undefined){
      const direct=normalizeAdministrationTargetCount(explicitCount);
      if(direct!==undefined)return direct;
    }
    for(const marker of fact.extension??[]) {
      if(marker.url!==BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL)continue;
      const count=normalizeAdministrationTargetCount(marker.valueInteger);
      if(count!==undefined)return count;
      break;
    }
  }
  const text = siteTextFromLike(site, options);
  if (!text) {
    return undefined;
  }
  const key=!options?.siteCodeMap?(options?.bodySiteContext??"")+"\u0000"+text:undefined;
  if(key!==undefined){const known=defaultTargetCounts.get(key);if(known!==undefined)return known||undefined;}
  const resolved = resolveBodySitePhrase(text, options?.siteCodeMap, {
    bodySiteContext: options?.bodySiteContext
  });
  const count=normalizeAdministrationTargetCount(resolved?.definition?.administrationTargetCount);
  if(key!==undefined){
    if(defaultTargetCounts.size>=TARGET_COUNT_CACHE_LIMIT)defaultTargetCounts.delete(defaultTargetCounts.keys().next().value!);
    defaultTargetCounts.set(key,count??0);
  }
  return count;
}
