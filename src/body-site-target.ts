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
  // Counts 0/1 do not require a multiplicity marker. Avoid a conversion for
  // the overwhelmingly common absent/single-target values.
  return value !== undefined && value >= 2 && Number.isFinite(value)
    ? Math.trunc(value) : undefined;
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
  const extensions = concept?.extension;
  if (!extensions?.length) return undefined;
  // Most sites have at most one extension. Inspect it directly without an
  // iterator/allocation; preserve first-match semantics for longer lists.
  if (extensions[0].url === BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL)
    return normalizeAdministrationTargetCount(extensions[0].valueInteger);
  for (let index = 1; index < extensions.length; index++) {
    const extension = extensions[index];
    if (extension.url === BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL)
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
    const markers = fact.extension;
    if (markers?.length) {
      const first = markers[0];
      if (first.url === BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL) {
        // The single-extension path dominates ordinary clinical lookups.
        // Skip a helper call and iteration on that already-known final field.
        const value = first.valueInteger;
        if (value !== undefined && value >= 2 && Number.isFinite(value))
          return Math.trunc(value);
      } else for (let index = 1; index < markers.length; index++) {
        const marker = markers[index];
        if (marker.url !== BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL) continue;
        const count = normalizeAdministrationTargetCount(marker.valueInteger);
        if (count !== undefined) return count;
        break;
      }
    }
  }
  return inferredBodySiteTargetCount(site,options);
}

/** Only uncoded/unmarked inputs need text lookup and the bounded vocabulary
 * cache. Keep this heavier path out of the direct typed-count reader so
 * repeated explicit-count queries do not carry its parsing/cache machinery. */
function inferredBodySiteTargetCount(
  site:string|SiteLike|FhirCodeableConcept,options?:BodySiteTargetCountOptions
):number|undefined {
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
