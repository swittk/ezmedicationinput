import { DEFAULT_BODY_SITE_SNOMED, normalizeBodySiteKey } from "./maps";
import { objectEntries } from "./utils/object";
import { BodySiteDefinition, FhirCoding, RouteCode } from "./types";

const SNOMED_SYSTEM = "http://snomed.info/sct";

const LOCATIVE_RELATIONS = new Set([
  "behind",
  "around",
  "under",
  "above",
  "below",
  "beneath",
  "near",
  "outside",
  "inside"
]);

const PARTITIVE_HEADS = new Set([
  "top",
  "back",
  "front",
  "side",
  "middle",
  "mid",
  "center",
  "centre",
  "palm",
  "sole"
]);

const BARE_NOMINAL_PREFIXES = new Set([
  "both",
  "each",
  "either",
  "every",
  "all",
  "bilateral"
]);

const OTIC_SITE_WORDS = new Set(["ear", "ears", "canal"]);
const OPHTHALMIC_SITE_WORDS = new Set(["eye", "eyes", "eyelid", "eyelids"]);
const NASAL_SITE_WORDS = new Set(["nostril", "nostrils", "naris", "nares", "nose"]);

const BODY_SITE_ADJECTIVE_SUFFIXES = [
  "al",
  "ial",
  "ual",
  "ic",
  "ous",
  "ive",
  "ary",
  "ory",
  "atic",
  "etic",
  "ular",
  "otic",
  "ile",
  "eal",
  "inal",
  "aneal",
  "enal"
] as const;

const DEFAULT_SITE_SYNONYM_KEYS = (() => {
  const map = new Map<BodySiteDefinition, string[]>();
  for (const [key, definition] of objectEntries(DEFAULT_BODY_SITE_SNOMED)) {
    if (!definition) {
      continue;
    }
    const normalized = key.trim();
    if (!normalized) {
      continue;
    }
    const existing = map.get(definition);
    if (existing) {
      if (existing.indexOf(normalized) === -1) {
        existing.push(normalized);
      }
    } else {
      map.set(definition, [normalized]);
    }
  }
  return map;
})();

export type BodySiteGrammarKind = "nominal" | "partitive" | "locative";
export type BodySiteLocativeRelation =
  | "behind"
  | "around"
  | "under"
  | "above"
  | "below"
  | "beneath"
  | "near"
  | "outside"
  | "inside";

export interface BodySiteNominalFeatures {
  kind: "nominal";
  text: string;
  canonical: string;
  coding?: FhirCoding;
  article: "definite" | "bare";
}

export interface BodySitePartitiveFeatures {
  kind: "partitive";
  part: string;
  whole: BodySiteNominalFeatures;
}

export interface BodySiteLocativeFeatures {
  kind: "locative";
  relation: BodySiteLocativeRelation;
  target: BodySiteNominalFeatures | BodySitePartitiveFeatures;
}

export type BodySiteFeatureStructure =
  | BodySiteNominalFeatures
  | BodySitePartitiveFeatures
  | BodySiteLocativeFeatures;

export interface ResolvedBodySitePhrase {
  lookupCanonical: string;
  canonical: string;
  displayText: string;
  coding?: FhirCoding;
  definition?: BodySiteDefinition;
  features: BodySiteFeatureStructure;
  englishObjectText: string;
  preferredPreposition?: "to" | "at" | "in" | "into";
}

export function lookupBodySiteDefinition(
  map: Record<string, BodySiteDefinition> | undefined,
  canonical: string
): BodySiteDefinition | undefined {
  if (!map) {
    return undefined;
  }
  const direct = map[canonical];
  if (direct) {
    return direct;
  }
  for (const [key, definition] of objectEntries(map)) {
    if (normalizeBodySiteKey(key) === canonical) {
      return definition;
    }
    if (definition.aliases) {
      for (const alias of definition.aliases) {
        if (normalizeBodySiteKey(alias) === canonical) {
          return definition;
        }
      }
    }
  }
  return undefined;
}

function buildBodySiteCoding(
  definition: BodySiteDefinition | undefined
): FhirCoding | undefined {
  const coding = definition?.coding;
  if (!coding?.code) {
    return undefined;
  }
  return {
    code: coding.code,
    display: coding.display,
    system: coding.system ?? SNOMED_SYSTEM
  };
}

function isAdjectivalSitePhrase(phrase: string): boolean {
  const normalized = phrase.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const words = normalized.split(/\s+/).filter((word) => word.length > 0);
  if (words.length !== 1) {
    return false;
  }
  const last = words[words.length - 1];
  if (last.length <= 3) {
    return false;
  }
  return BODY_SITE_ADJECTIVE_SUFFIXES.some((suffix) => last.endsWith(suffix));
}

function scoreBodySitePhrase(phrase: string): number {
  const lower = phrase.toLowerCase();
  const words = lower.split(/\s+/).filter((part) => part.length > 0);
  let score = 0;
  if (
    !lower.includes("structure") &&
    !lower.includes("region") &&
    !lower.includes("entire") &&
    !lower.includes("proper") &&
    !lower.includes("body")
  ) {
    score += 3;
  }
  if (!lower.includes(" of ")) {
    score += 1;
  }
  if (words.length <= 2) {
    score += 1;
  }
  if (words.length === 1) {
    score += 0.5;
  }
  score -= words.length * 0.2;
  score -= lower.length * 0.01;
  return score;
}

function pickPreferredBodySitePhrase(
  canonical: string,
  definition: BodySiteDefinition,
  customSiteMap?: Record<string, BodySiteDefinition>
): string | undefined {
  const synonyms = new Set<string>();
  synonyms.add(canonical);

  if (definition.aliases) {
    for (const alias of definition.aliases) {
      const normalizedAlias = normalizeBodySiteKey(alias);
      if (normalizedAlias) {
        synonyms.add(normalizedAlias);
      }
    }
  }

  const defaultSynonyms = DEFAULT_SITE_SYNONYM_KEYS.get(definition);
  if (defaultSynonyms) {
    for (const synonym of defaultSynonyms) {
      synonyms.add(synonym);
    }
  }

  if (customSiteMap) {
    for (const [key, candidate] of objectEntries(customSiteMap)) {
      if (!candidate || candidate !== definition) {
        continue;
      }
      const normalizedKey = normalizeBodySiteKey(key);
      if (normalizedKey) {
        synonyms.add(normalizedKey);
      }
      if (candidate.aliases) {
        for (const alias of candidate.aliases) {
          const normalizedAlias = normalizeBodySiteKey(alias);
          if (normalizedAlias) {
            synonyms.add(normalizedAlias);
          }
        }
      }
    }
  }

  const candidates = Array.from(synonyms).filter(
    (phrase) => phrase && !isAdjectivalSitePhrase(phrase)
  );
  if (!candidates.length) {
    return undefined;
  }

  candidates.sort((a, b) => scoreBodySitePhrase(b) - scoreBodySitePhrase(a));
  const best = candidates[0];
  if (!best) {
    return undefined;
  }
  return normalizeBodySiteKey(best) === canonical ? undefined : best;
}

function normalizeSiteDisplayText(
  text: string,
  customSiteMap?: Record<string, BodySiteDefinition>
): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }

  const canonicalInput = normalizeBodySiteKey(trimmed);
  if (!canonicalInput) {
    return trimmed;
  }

  const directDefinition =
    lookupBodySiteDefinition(customSiteMap, canonicalInput) ??
    DEFAULT_BODY_SITE_SNOMED[canonicalInput];
  if (directDefinition) {
    return directDefinition.text ?? canonicalInput;
  }

  const resolvePreferred = (
    canonical: string
  ): { text: string; canonical: string } | undefined => {
    const definition =
      lookupBodySiteDefinition(customSiteMap, canonical) ??
      DEFAULT_BODY_SITE_SNOMED[canonical];
    if (!definition) {
      return undefined;
    }
    const preferred = pickPreferredBodySitePhrase(
      canonical,
      definition,
      customSiteMap
    );
    const textValue = definition.text ?? preferred ?? canonical;
    const normalized = normalizeBodySiteKey(textValue);
    if (!normalized) {
      return undefined;
    }
    return { text: textValue, canonical: normalized };
  };

  const direct = resolvePreferred(canonicalInput);
  if (direct) {
    return direct.text;
  }

  if (isAdjectivalSitePhrase(canonicalInput)) {
    return trimmed;
  }

  const words = canonicalInput.split(/\s+/).filter((word) => word.length > 0);
  for (let index = 1; index < words.length; index += 1) {
    const prefix = words.slice(0, index);
    if (!prefix.every((word) => isAdjectivalSitePhrase(word))) {
      continue;
    }
    const candidateCanonical = words.slice(index).join(" ");
    const candidatePreferred = resolvePreferred(candidateCanonical);
    if (!candidatePreferred) {
      continue;
    }
    const prefixMatches = prefix.every((word) => {
      const normalizedPrefix = resolvePreferred(word);
      return (
        normalizedPrefix !== undefined &&
        normalizedPrefix.canonical === candidatePreferred.canonical
      );
    });
    if (prefixMatches) {
      return candidatePreferred.text;
    }
  }

  return trimmed;
}

function buildNominalFeatures(
  text: string,
  canonical: string,
  coding?: FhirCoding
): BodySiteNominalFeatures {
  const normalized = normalizeBodySiteKey(text);
  const firstWord = normalized.split(/\s+/)[0];
  return {
    kind: "nominal",
    text,
    canonical,
    coding,
    article: firstWord && BARE_NOMINAL_PREFIXES.has(firstWord) ? "bare" : "definite"
  };
}

function parseBodySiteFeatures(
  text: string,
  coding?: FhirCoding
): BodySiteFeatureStructure {
  const normalized = normalizeBodySiteKey(text);
  if (!normalized) {
    return buildNominalFeatures(text, normalized, coding);
  }
  const words = normalized.split(/\s+/).filter((word) => word.length > 0);
  if (!words.length) {
    return buildNominalFeatures(text, normalized, coding);
  }

  const firstWord = words[0];
  if (firstWord && LOCATIVE_RELATIONS.has(firstWord) && words.length > 1) {
    const targetText = words.slice(1).join(" ");
    const targetFeatures = parseBodySiteFeatures(targetText);
    return {
      kind: "locative",
      relation: firstWord as BodySiteLocativeRelation,
      target: targetFeatures.kind === "locative"
        ? buildNominalFeatures(targetText, normalizeBodySiteKey(targetText))
        : targetFeatures
    };
  }

  if (
    words.length > 2 &&
    words[1] === "of" &&
    firstWord &&
    PARTITIVE_HEADS.has(firstWord)
  ) {
    const wholeText = words.slice(2).join(" ");
    return {
      kind: "partitive",
      part: firstWord,
      whole: buildNominalFeatures(wholeText, normalizeBodySiteKey(wholeText))
    };
  }

  return buildNominalFeatures(text, normalized, coding);
}

function renderNominalObject(features: BodySiteNominalFeatures): string {
  return features.article === "bare" ? features.text : `the ${features.text}`;
}

function renderBodySiteObject(
  features: BodySiteFeatureStructure
): string {
  switch (features.kind) {
    case "locative":
      return `${features.relation === "inside" ? "in" : features.relation} ${renderBodySiteObject(features.target)}`;
    case "partitive":
      return `the ${features.part} of ${renderNominalObject(features.whole)}`;
    case "nominal":
      return renderNominalObject(features);
  }
}

function inferPreferredPreposition(
  canonical: string,
  features: BodySiteFeatureStructure,
  definition?: BodySiteDefinition
): "to" | "at" | "in" | "into" | undefined {
  if (features.kind === "locative") {
    return undefined;
  }
  const routeHint = definition?.routeHint;
  if (
    routeHint === RouteCode["Topical route"] ||
    routeHint === RouteCode["Transdermal route"]
  ) {
    return "to";
  }
  if (
    routeHint === RouteCode["Per rectum"] ||
    routeHint === RouteCode["Per vagina"] ||
    routeHint === RouteCode["Subcutaneous route"] ||
    routeHint === RouteCode["Intramuscular route"] ||
    routeHint === RouteCode["Intravenous route"] ||
    routeHint === RouteCode["Nasal route"]
  ) {
    return routeHint === RouteCode["Nasal route"] ? "into" : "to";
  }
  const words = canonical.split(/\s+/).filter((word) => word.length > 0);
  for (const word of words) {
    if (OTIC_SITE_WORDS.has(word) || OPHTHALMIC_SITE_WORDS.has(word)) {
      return "in";
    }
    if (NASAL_SITE_WORDS.has(word)) {
      return "into";
    }
  }
  return undefined;
}

export function resolveBodySitePhrase(
  text: string,
  customSiteMap?: Record<string, BodySiteDefinition>
): ResolvedBodySitePhrase | undefined {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return undefined;
  }

  const lookupCanonical = normalizeBodySiteKey(trimmed);
  const displayText = normalizeSiteDisplayText(trimmed, customSiteMap);
  const canonical = normalizeBodySiteKey(displayText);
  const definition =
    lookupBodySiteDefinition(customSiteMap, lookupCanonical) ??
    DEFAULT_BODY_SITE_SNOMED[lookupCanonical] ??
    lookupBodySiteDefinition(customSiteMap, canonical) ??
    DEFAULT_BODY_SITE_SNOMED[canonical];
  const coding = buildBodySiteCoding(definition);
  const finalDisplayText = definition?.text ?? displayText;
  const features = parseBodySiteFeatures(finalDisplayText, coding);

  return {
    lookupCanonical,
    canonical: normalizeBodySiteKey(finalDisplayText) || canonical,
    displayText: finalDisplayText,
    coding,
    definition,
    features,
    englishObjectText: renderBodySiteObject(features),
    preferredPreposition: inferPreferredPreposition(
      normalizeBodySiteKey(finalDisplayText) || canonical,
      features,
      definition
    )
  };
}
