import { resolveBodySitePhrase } from "./body-site-grammar";
import { bodySiteTextWithLaterality, getBodySiteText } from "./body-site-lookup";
import { DEFAULT_BODY_SITE_SNOMED, normalizeBodySiteKey, splitBodySiteLaterality } from "./maps";
import { SNOMED_SYSTEM, SNOMED_CT_BILATERAL_QUALIFIER_CODE } from "./snomed";
import { parseSnomedBodySiteLateralityPostcoordinationCode } from "./snomed-postcoordination";
import {
  BodySiteCode,
  BodySiteDefinition,
  BodySiteSpatialRelation,
  CanonicalSiteExpr,
  FhirR6CodeableConcept,
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
const BODY_SITE_REFINEMENTS: Readonly<Record<string, { broader: string; lateralized?: true; unqualified?: string }>> = {
  "181178004": { broader: "117590005" }, // External auditory canal -> ear-related structure.
  "34338003": { broader: "117590005", lateralized: true }, // Both ears.
  "40638003": { broader: "81745001", lateralized: true }, // Both eyes.
  "368588007": { broader: "89644007", lateralized: true, unqualified: "181178004" }, // Left auditory canal -> left ear.
  "368566007": { broader: "25577004", lateralized: true, unqualified: "181178004" }, // Right auditory canal -> right ear.
  "723608007": { broader: "1797002", lateralized: true }, // Left anterior naris -> naris.
  "723609004": { broader: "1797002", lateralized: true }, // Right anterior naris -> naris.
  "244506005": { broader: "1797002" }, // Anterior nares -> naris.
  "1797002": { broader: "181195007" }, // Naris -> entire nose.
  "68426009": { broader: "181195007" }, // Nasal septum -> entire nose.
  "731075006": { broader: "56459004" }, // Entire sole of foot -> foot.
};

function refinesBodySite(code: string, broader: string): boolean {
  for (let parent = BODY_SITE_REFINEMENTS[code]; parent; parent = BODY_SITE_REFINEMENTS[parent.broader]) {
    if (parent.broader === broader) return true;
  }
  return false;
}

function bodySiteCodeForComparison(coding: Pick<FhirCoding, "system" | "code">): string | undefined {
  if (!coding.code) return undefined;
  const postcoordinated = parseSnomedBodySiteLateralityPostcoordinationCode(coding.code);
  const text = postcoordinated ? getBodySiteText(coding as BodySiteCode) : undefined;
  return text ? DEFAULT_BODY_SITE_SNOMED[normalizeBodySiteKey(text)]?.coding?.code ?? coding.code : coding.code;
}

function combinedBodySiteRefinement(textCode: string, codedCode: string | undefined): string | undefined {
  for (const code in BODY_SITE_REFINEMENTS) {
    const refinement = BODY_SITE_REFINEMENTS[code];
    if (refinement.unqualified === textCode && refinement.broader === codedCode) return code;
  }
  return undefined;
}

/** Compare exact stock site labels only. A lateralized label can refine its
 * registered unqualified anatomy; a different code alone is not a conflict. */
function compatibleBodySiteText(text: string, coding: Pick<FhirCoding, "system" | "code"> | undefined): string | undefined {
  const key = normalizeBodySiteKey(text);
  const definition = DEFAULT_BODY_SITE_SNOMED[key];
  const textCode = definition?.coding;
  if (definition && !textCode?.code && (coding?.system ?? SNOMED_SYSTEM) === SNOMED_SYSTEM) {
    const lateralized = parseSnomedBodySiteLateralityPostcoordinationCode(coding?.code);
    if (lateralized) {
      const refined = resolveBodySitePhrase(definition.text ?? text);
      const features = refined?.features;
      if (refined && features?.kind === "partitive" && features.attributive &&
          features.whole.coding?.code === lateralized.siteCode &&
          (features.whole.coding.system ?? SNOMED_SYSTEM) === SNOMED_SYSTEM) {
        const combined = bodySiteTextWithLaterality(refined.displayText, lateralized.lateralityCode);
        if (combined) return combined;
      }
    }
  }
  if (!textCode?.code || !coding?.code || textCode.code === coding.code ||
      (textCode.system ?? SNOMED_SYSTEM) !== (coding.system ?? SNOMED_SYSTEM)) return text;
  const codedCode = bodySiteCodeForComparison(coding)!;
  if (textCode.code === codedCode) return text;
  const combined = combinedBodySiteRefinement(textCode.code, codedCode);
  if (combined) return getBodySiteText({ code: combined, system: coding.system }) ?? text;
  const canonical = definition.text ?? key;
  const textLaterality = splitBodySiteLaterality(canonical);
  const textRefinement = BODY_SITE_REFINEMENTS[textCode.code];
  const codedRefinement = BODY_SITE_REFINEMENTS[codedCode];
  if (refinesBodySite(textCode.code, codedCode)) return text;
  if (textRefinement && !textRefinement.lateralized && !textLaterality) {
    const codedText = getBodySiteText(coding as BodySiteCode);
    const lateralized = codedText ? splitBodySiteLaterality(codedText) : undefined;
    const parent = lateralized ? DEFAULT_BODY_SITE_SNOMED[lateralized.baseText]?.coding : undefined;
    if (parent?.code && refinesBodySite(textCode.code, parent.code)) {
      const refined = bodySiteTextWithLaterality(definition.text ?? text, lateralized!.lateralityCode);
      if (refined) return refined;
    }
  }
  if (textRefinement && codedRefinement && textRefinement.broader === codedRefinement.broader) {
    if (!codedRefinement.lateralized) return text;
    // A paired refinement can agree with the registered paired broader site.
    const count = definition.administrationTargetCount;
    const codedCount = getBodySiteAdministrationTargetCount({ coding: { ...coding, code: coding.code } });
    if (count !== undefined && count > 1 && count === codedCount) return definition.text ?? text;
    if (!textRefinement.lateralized && codedCount === 2) {
      const pairedText = bodySiteTextWithLaterality(definition.text ?? text, SNOMED_CT_BILATERAL_QUALIFIER_CODE);
      const paired = pairedText ? DEFAULT_BODY_SITE_SNOMED[normalizeBodySiteKey(pairedText)] : undefined;
      if (paired?.coding?.code === textCode.code && paired.administrationTargetCount === codedCount) {
        return paired.text ?? pairedText;
      }
    }
  }
  const unqualified = textLaterality?.baseText;
  if (unqualified && unqualified !== canonical) {
    const baseCode = DEFAULT_BODY_SITE_SNOMED[unqualified]?.coding;
    if (baseCode?.code && (baseCode.code === codedCode || refinesBodySite(baseCode.code, codedCode) ||
        !codedRefinement?.lateralized && baseCode.code === codedRefinement?.broader) &&
        (baseCode.system ?? SNOMED_SYSTEM) === (coding.system ?? SNOMED_SYSTEM)) return text;
  }
  return undefined;
}

export function bodySiteTextConflictsWithCoding(text: string, coding: Pick<FhirCoding, "system" | "code"> | undefined): boolean {
  return compatibleBodySiteText(text, coding) === undefined;
}

export function resolveBodySiteTargetText(
  site: string | SiteLike | FhirR6CodeableConcept | undefined,
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
    const compatible = compatibleBodySiteText(text, coding);
    if (compatible !== undefined) return compatible;
  }
  if (coding?.code) {
    // Cache only stable default vocabulary lookups, never mutable fields.
    const cacheKey = options?.siteCodeMap ? undefined :
      (coding.system ?? SNOMED_SYSTEM) + "\0" + coding.code;
    let resolved: string | undefined;
    if (cacheKey !== undefined && defaultCodedSiteTexts.has(cacheKey)) {
      resolved = defaultCodedSiteTexts.get(cacheKey);
    } else {
      resolved = getBodySiteText(coding as BodySiteCode, { siteCodeMap: options?.siteCodeMap });
      if (cacheKey !== undefined) {
        if (defaultCodedSiteTexts.size >= TARGET_COUNT_CACHE_LIMIT) defaultCodedSiteTexts.clear();
        defaultCodedSiteTexts.set(cacheKey, resolved);
      }
    }
    if (resolved) return resolved;
  }
  return text ?? coding?.display ?? (Array.isArray(codings) ? codings.find(value => value.display)?.display : undefined);
}

/** Realization may use a retained equivalent Coding's label without changing
 * the selected anatomical identity or materializing text into its wire carrier. */
export function resolveBodySiteSpatialTargetText(relation: BodySiteSpatialRelation): string | undefined {
  return relation.targetText ?? relation.targetCoding?.display ??
    resolveBodySiteTargetText({ coding: relation.targetCoding }) ?? relation.targetConcept?.text ??
    relation.targetConcept?.coding?.find(coding => coding.display)?.display;
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
  concept: FhirR6CodeableConcept | { extension?: FhirExtension[] } | undefined
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
  site: string | SiteLike | FhirR6CodeableConcept | undefined,
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
  site:string|SiteLike|FhirR6CodeableConcept,options?:BodySiteTargetCountOptions
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
