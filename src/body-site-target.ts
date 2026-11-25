import { resolveBodySitePhrase } from "./body-site-grammar";
import { getBodySiteText } from "./body-site-lookup";
import { DEFAULT_BODY_SITE_SNOMED, normalizeBodySiteKey } from "./maps";
import { SNOMED_SYSTEM } from "./snomed";
import {
  BodySiteCode,
  BodySiteDefinition,
  CanonicalSiteExpr,
  FhirCodeableConcept,
  FhirCoding,
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

export function normalizeAdministrationTargetCount(value: number | undefined): number | undefined {
  // Counts 0/1 do not require a multiplicity marker. Avoid a conversion for
  // the overwhelmingly common absent/single-target values.
  return value !== undefined && value >= 2 && Number.isFinite(value)
    ? Math.trunc(value) : undefined;
}

/** Declared anatomical refinements, independent of their localized labels. */
const BROADER_BODY_SITE_CODE: Readonly<Record<string, string>> = {
  "368588007": "89644007", // Entire left external auditory canal -> left ear.
  "368566007": "25577004", // Entire right external auditory canal -> right ear.
  "723608007": "1797002", // Left anterior naris -> naris.
  "723609004": "1797002", // Right anterior naris -> naris.
};

/** Compare exact stock site labels only. A lateralized label can refine its
 * registered unqualified anatomy; a different code alone is not a conflict. */
export function bodySiteTextConflictsWithCoding(text: string, coding: FhirCoding | undefined): boolean {
  const definition = DEFAULT_BODY_SITE_SNOMED[normalizeBodySiteKey(text)];
  const textCode = definition?.coding;
  if (!textCode?.code || !coding?.code || textCode.code === coding.code ||
      (textCode.system ?? SNOMED_SYSTEM) !== (coding.system ?? SNOMED_SYSTEM)) return false;
  if (BROADER_BODY_SITE_CODE[textCode.code] === coding.code) return false;
  const canonical = definition.text;
  const unqualified = canonical?.replace(/^(?:left|right|both) /u, "");
  if (unqualified && unqualified !== canonical) {
    const baseCode = DEFAULT_BODY_SITE_SNOMED[unqualified]?.coding;
    if (baseCode?.code === coding.code &&
        (baseCode.system ?? SNOMED_SYSTEM) === (coding.system ?? SNOMED_SYSTEM)) return false;
  }
  return true;
}

export function resolveBodySiteTargetText(
  site: string | SiteLike | FhirCodeableConcept | undefined,
  options?: BodySiteTargetCountOptions
): string | undefined {
  if (!site) {
    return undefined;
  }
  if (typeof site === "string") {
    return site;
  }
  const codings = "coding" in site ? site.coding : undefined;
  const coding = Array.isArray(codings)
    ? codings.find(candidate => candidate?.code && candidate.system === SNOMED_SYSTEM) ??
      codings.find(candidate => candidate?.code)
    : codings;
  const text = "text" in site ? site.text : undefined;
  if (text) {
    // Match the native preview's exact-known-label conflict rule. A coarser
    // code does not supersede authored spatial qualifiers or unfamiliar text.
    const staleText = bodySiteTextConflictsWithCoding(text, coding);
    if (!staleText) return text;
  }
  if (coding?.code) {
    // Cache only stable default vocabulary lookups, never mutable fields.
    const cacheKey = options?.siteCodeMap ? undefined :
      (coding.system ?? SNOMED_SYSTEM) + "\0" + coding.code;
    let resolved: string | undefined;
    if (cacheKey !== undefined && defaultCodedSiteTexts.has(cacheKey)) {
      resolved = defaultCodedSiteTexts.get(cacheKey);
    } else {
      resolved = getBodySiteText(coding, { siteCodeMap: options?.siteCodeMap });
      if (cacheKey !== undefined) {
        if (defaultCodedSiteTexts.size >= TARGET_COUNT_CACHE_LIMIT) defaultCodedSiteTexts.clear();
        defaultCodedSiteTexts.set(cacheKey, resolved);
      }
    }
    if (resolved) return resolved;
  }
  return text;
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
const defaultCodedSiteTexts = new Map<string, string | undefined>();
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
  const text = resolveBodySiteTargetText(site, options);
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
