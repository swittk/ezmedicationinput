import { DEFAULT_BODY_SITE_SNOMED, normalizeBodySiteKey } from "./maps";
import { objectEntries } from "./utils/object";
import { BodySiteCode, BodySiteDefinition, BodySiteSpatialRelation, FhirCoding, RouteCode } from "./types";
import {
  BODY_SITE_ADJECTIVE_SUFFIXES,
  BODY_SITE_BARE_NOMINAL_PREFIXES,
  BODY_SITE_DISPLAY_PENALTY_WORDS,
  BODY_SITE_LOCATIVE_RELATIONS,
  BODY_SITE_LOCATIVE_RENDER_PREPOSITIONS,
  BODY_SITE_PARTITIVE_CONNECTORS,
  BODY_SITE_PARTITIVE_HEADS,
  BODY_SITE_PARTITIVE_MODIFIERS,
  BODY_SITE_SPATIAL_RELATION_CODINGS,
  NASAL_SITE_WORDS,
  OPHTHALMIC_SITE_WORDS,
  OTIC_SITE_WORDS
} from "./hpsg/lexical-classes";

const SNOMED_SYSTEM = "http://snomed.info/sct";

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
  | "inside"
  | "between";

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
  relationKey?: string;
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
  resolutionCanonical: string;
  canonical: string;
  displayText: string;
  coding?: FhirCoding;
  spatialRelation?: BodySiteSpatialRelation;
  definition?: BodySiteDefinition;
  features: BodySiteFeatureStructure;
  englishObjectText: string;
  preferredPreposition?: "to" | "at" | "in" | "into";
}

export interface BodySitePhraseContext {
  bodySiteContext?: string;
}

const AMBIGUOUS_DIGIT_SITE_KEYS = new Set(["ระหว่างนิ้ว", "between digits"]);
const HAND_CONTEXT_KEYS = new Set(["hand", "hands", "finger", "fingers", "นิ้วมือ", "มือ"]);
const FOOT_CONTEXT_KEYS = new Set(["foot", "feet", "toe", "toes", "นิ้วเท้า", "เท้า"]);
const BODY_SITE_ALIAS_INDEXES = new WeakMap<
  Record<string, BodySiteDefinition>,
  Map<string, BodySiteDefinition>
>();

function buildOrGetBodySiteAliasIndex(
  map: Record<string, BodySiteDefinition>
): Map<string, BodySiteDefinition> {
  const existing = BODY_SITE_ALIAS_INDEXES.get(map);
  if (existing) {
    return existing;
  }
  const index = new Map<string, BodySiteDefinition>();
  for (const [key, definition] of objectEntries(map)) {
    const normalizedKey = normalizeBodySiteKey(key);
    if (normalizedKey) {
      index.set(normalizedKey, definition);
    }
    for (const alias of definition.aliases ?? []) {
      const normalizedAlias = normalizeBodySiteKey(alias);
      if (normalizedAlias) {
        index.set(normalizedAlias, definition);
      }
    }
  }
  BODY_SITE_ALIAS_INDEXES.set(map, index);
  return index;
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
  const indexed = buildOrGetBodySiteAliasIndex(map).get(canonical);
  if (indexed) {
    return indexed;
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

function contextContainsAny(context: string | undefined, keys: Set<string>): boolean {
  const normalized = normalizeBodySiteKey(context ?? "");
  if (!normalized) {
    return false;
  }
  for (const key of keys) {
    if (normalized === key || normalized.includes(key)) {
      return true;
    }
  }
  return false;
}

function resolveContextualBodySiteAlias(
  lookupCanonical: string,
  context?: BodySitePhraseContext
): string | undefined {
  if (!AMBIGUOUS_DIGIT_SITE_KEYS.has(lookupCanonical)) {
    return undefined;
  }
  if (contextContainsAny(context?.bodySiteContext, FOOT_CONTEXT_KEYS)) {
    return "between toes";
  }
  if (contextContainsAny(context?.bodySiteContext, HAND_CONTEXT_KEYS)) {
    return "between fingers";
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

function cloneBodySiteCode(
  coding: { code?: string; display?: string; system?: string; i18n?: Record<string, string> } | undefined
): BodySiteCode | undefined {
  if (!coding?.code) {
    return undefined;
  }
  return {
    code: coding.code,
    display: coding.display,
    system: coding.system ?? SNOMED_SYSTEM,
    i18n: coding.i18n
  };
}

function lookupDefinitionForCanonical(
  canonical: string,
  customSiteMap?: Record<string, BodySiteDefinition>
): BodySiteDefinition | undefined {
  return (
    lookupBodySiteDefinition(customSiteMap, canonical) ??
    DEFAULT_BODY_SITE_SNOMED[canonical]
  );
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
  if (!Array.from(BODY_SITE_DISPLAY_PENALTY_WORDS).some((word) => lower.includes(word))) {
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
  // Split words to detect adjectival variants where every prefix word resolves
  // via isAdjectivalSitePhrase/resolvePreferred to the same canonical site as
  // candidatePreferred; prefixMatches means the modifier is redundant anatomy wording.
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
  coding?: FhirCoding,
  customSiteMap?: Record<string, BodySiteDefinition>
): BodySiteNominalFeatures {
  const normalized = normalizeBodySiteKey(text);
  const firstWord = normalized.split(/\s+/)[0];
  const definition = lookupDefinitionForCanonical(canonical, customSiteMap);
  return {
    kind: "nominal",
    text,
    canonical,
    coding: coding ?? buildBodySiteCoding(definition),
    article: firstWord && BODY_SITE_BARE_NOMINAL_PREFIXES.has(firstWord) ? "bare" : "definite"
  };
}

function parseBodySiteFeatures(
  text: string,
  coding?: FhirCoding,
  customSiteMap?: Record<string, BodySiteDefinition>
): BodySiteFeatureStructure {
  const normalized = normalizeBodySiteKey(text);
  if (!normalized) {
    return buildNominalFeatures(text, normalized, coding, customSiteMap);
  }
  const words = normalized.split(/\s+/).filter((word) => word.length > 0);
  if (!words.length) {
    return buildNominalFeatures(text, normalized, coding, customSiteMap);
  }

  const firstWord = words[0];
  if (firstWord && BODY_SITE_LOCATIVE_RELATIONS.has(firstWord) && words.length > 1) {
    const targetText = words.slice(1).join(" ");
    const targetFeatures = parseBodySiteFeatures(targetText, undefined, customSiteMap);
    // Nested locatives are flattened to a nominal target to avoid recursive
    // relation stacks such as "inside below ear"; we preserve the outer relation.
    return {
      kind: "locative",
      relation: firstWord as BodySiteLocativeRelation,
      target: targetFeatures.kind === "locative"
        ? buildNominalFeatures(targetText, normalizeBodySiteKey(targetText), undefined, customSiteMap)
        : targetFeatures
    };
  }

  if (
    firstWord &&
    (firstWord === "area" || firstWord === "region") &&
    words[1] !== undefined &&
    BODY_SITE_LOCATIVE_RELATIONS.has(words[1]) &&
    words.length > 2
  ) {
    const targetText = words.slice(2).join(" ");
    const targetFeatures = parseBodySiteFeatures(targetText, undefined, customSiteMap);
    return {
      kind: "locative",
      relation: words[1] as BodySiteLocativeRelation,
      target: targetFeatures.kind === "locative"
        ? buildNominalFeatures(targetText, normalizeBodySiteKey(targetText), undefined, customSiteMap)
        : targetFeatures
    };
  }

  if (
    words.length > 2 &&
    words[1] !== undefined &&
    BODY_SITE_PARTITIVE_CONNECTORS.has(words[1]) &&
    firstWord &&
    BODY_SITE_PARTITIVE_HEADS.has(firstWord)
  ) {
    const wholeText = words.slice(2).join(" ");
    return {
      kind: "partitive",
      part: firstWord,
      relationKey: firstWord,
      whole: buildNominalFeatures(wholeText, normalizeBodySiteKey(wholeText), undefined, customSiteMap)
    };
  }

  if (
    words.length > 3 &&
    firstWord &&
    BODY_SITE_PARTITIVE_MODIFIERS.has(firstWord) &&
    words[1] !== undefined &&
    BODY_SITE_PARTITIVE_HEADS.has(words[1]) &&
    words[2] !== undefined &&
    BODY_SITE_PARTITIVE_CONNECTORS.has(words[2])
  ) {
    const head = words[1] === "sides" ? "side" : words[1];
    const wholeText = words.slice(3).join(" ");
    return {
      kind: "partitive",
      part: `${firstWord} ${words[1]}`,
      relationKey: head,
      whole: buildNominalFeatures(wholeText, normalizeBodySiteKey(wholeText), undefined, customSiteMap)
    };
  }

  return buildNominalFeatures(text, normalized, coding, customSiteMap);
}

function renderNominalObject(features: BodySiteNominalFeatures): string {
  return features.article === "bare" ? features.text : `the ${features.text}`;
}

function renderBodySiteObject(
  features: BodySiteFeatureStructure
): string {
  switch (features.kind) {
    case "locative":
      return `${BODY_SITE_LOCATIVE_RENDER_PREPOSITIONS.get(features.relation) ?? features.relation} ${renderBodySiteObject(features.target)}`;
    case "partitive":
      return `${
        features.part.startsWith("both") || features.part.startsWith("bilateral")
          ? features.part
          : `the ${features.part}`
      } of ${renderNominalObject(features.whole)}`;
    case "nominal":
      return renderNominalObject(features);
  }
}

function featureDisplayText(features: BodySiteFeatureStructure): string {
  switch (features.kind) {
    case "locative":
      return `${features.relation} ${featureDisplayText(features.target)}`;
    case "partitive":
      return `${features.part} of ${features.whole.text}`;
    case "nominal":
      return features.text;
  }
}

function resolveFeatureCoding(
  features: BodySiteFeatureStructure,
  customSiteMap?: Record<string, BodySiteDefinition>
): BodySiteCode | undefined {
  const direct = lookupDefinitionForCanonical(
    normalizeBodySiteKey(featureDisplayText(features)),
    customSiteMap
  );
  const directCoding = cloneBodySiteCode(direct?.coding);
  if (directCoding) {
    return directCoding;
  }
  switch (features.kind) {
    case "locative":
      return resolveFeatureCoding(features.target, customSiteMap);
    case "partitive":
      return cloneBodySiteCode(features.whole.coding);
    case "nominal":
      return cloneBodySiteCode(features.coding);
  }
}

function buildSpatialRelation(
  features: BodySiteFeatureStructure,
  sourceText: string,
  customSiteMap?: Record<string, BodySiteDefinition>
): BodySiteSpatialRelation | undefined {
  switch (features.kind) {
    case "locative": {
      const relationCoding = BODY_SITE_SPATIAL_RELATION_CODINGS.get(features.relation);
      return {
        relationText: features.relation,
        relationCoding,
        targetText: featureDisplayText(features.target),
        targetCoding: resolveFeatureCoding(features.target, customSiteMap),
        sourceText
      };
    }
    case "partitive": {
      const relationCoding = BODY_SITE_SPATIAL_RELATION_CODINGS.get(features.relationKey ?? features.part);
      if (!relationCoding) {
        return undefined;
      }
      return {
        relationText: features.part,
        relationCoding,
        targetText: features.whole.text,
        targetCoding: cloneBodySiteCode(features.whole.coding),
        sourceText
      };
    }
    case "nominal":
      return undefined;
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
  customSiteMap?: Record<string, BodySiteDefinition>,
  context?: BodySitePhraseContext
): ResolvedBodySitePhrase | undefined {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return undefined;
  }

  const lookupCanonical = normalizeBodySiteKey(trimmed);
  const contextualCanonical = resolveContextualBodySiteAlias(lookupCanonical, context);
  const displaySourceText = contextualCanonical ?? trimmed;
  const displayText = normalizeSiteDisplayText(displaySourceText, customSiteMap);
  const canonical = normalizeBodySiteKey(displayText);
  const definition =
    lookupBodySiteDefinition(customSiteMap, lookupCanonical) ??
    (contextualCanonical
      ? lookupBodySiteDefinition(customSiteMap, contextualCanonical)
      : undefined) ??
    (contextualCanonical ? DEFAULT_BODY_SITE_SNOMED[contextualCanonical] : undefined) ??
    DEFAULT_BODY_SITE_SNOMED[lookupCanonical] ??
    lookupBodySiteDefinition(customSiteMap, canonical) ??
    DEFAULT_BODY_SITE_SNOMED[canonical];
  const coding = buildBodySiteCoding(definition);
  const finalDisplayText = definition?.text ?? displayText;
  const features = parseBodySiteFeatures(finalDisplayText, coding, customSiteMap);
  const spatialRelation =
    definition?.spatialRelation ??
    buildSpatialRelation(features, finalDisplayText, customSiteMap);

  return {
    lookupCanonical,
    resolutionCanonical: contextualCanonical ?? lookupCanonical,
    canonical: normalizeBodySiteKey(finalDisplayText) || canonical,
    displayText: finalDisplayText,
    coding,
    spatialRelation,
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
