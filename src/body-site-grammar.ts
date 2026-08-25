import { DEFAULT_BODY_SITE_SNOMED, normalizeBodySiteKey } from "./maps";
import { mergeI18nRecords } from "./fhir-translations";
import { resolveSymptomDefinition } from "./symptom-terminology";
import { objectEntries } from "./utils/object";
import { BodySiteCode, BodySiteDefinition, BodySiteSpatialRelation, FhirCoding, RouteCode } from "./types";
import {
  BODY_SITE_LOCATIVE_RELATION_PHRASES,
  BODY_SITE_LOCATIVE_RELATIONS,
  BODY_SITE_SPATIAL_RELATION_CODINGS,
  getBodySiteRelationRealization,
  listBodySiteRelationDefinitions,
  normalizeBodySiteRelation
} from "./relation-terminology";
import type { BodySiteLocativeRelation } from "./relation-terminology";
import {
  BODY_SITE_ADJECTIVE_SUFFIXES,
  BODY_SITE_ATTRIBUTIVE_MODIFIERS,
  BODY_SITE_BARE_NOMINAL_PREFIXES,
  BODY_SITE_DISPLAY_PENALTY_WORDS,
  BODY_SITE_PARTITIVE_CONNECTORS,
  BODY_SITE_PARTITIVE_HEADS,
  BODY_SITE_PARTITIVE_MODIFIERS,
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
export type { BodySiteLocativeRelation };

export type BodySiteQualifierFeatures =
  | { kind: "symptom"; relation: string; text: string; canonical: string; coding?: FhirCoding; i18n?: Record<string, string> }
  | { kind: "site"; relation: string; text: string; targetText: string; targetCoding?: FhirCoding };

export interface BodySiteNominalFeatures {
  kind: "nominal";
  text: string;
  canonical: string;
  coding?: FhirCoding;
  article: "definite" | "bare";
  qualifier?: BodySiteQualifierFeatures;
}

export interface BodySitePartitiveFeatures {
  kind: "partitive";
  part: string;
  relationKey?: string;
  whole: BodySiteNominalFeatures;
  attributive?: boolean;
  qualifier?: BodySiteQualifierFeatures;
}

export interface BodySiteLocativeFeatures {
  kind: "locative";
  relation: BodySiteLocativeRelation;
  target: BodySiteNominalFeatures | BodySitePartitiveFeatures;
  qualifier?: BodySiteQualifierFeatures;
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
  allowTerminalModifierInheritance?: boolean;
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
    system: coding.system ?? SNOMED_SYSTEM,
    i18n: mergeI18nRecords(definition?.i18n, coding.i18n)
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
    i18n: mergeI18nRecords(coding.i18n)
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

function longestTerminalBodySiteDefinition(
  canonical: string,
  customSiteMap?: Record<string, BodySiteDefinition>
): { canonical: string; definition: BodySiteDefinition } | undefined {
  const words = canonical.split(/\s+/).filter(Boolean);
  for (let start = 1; start < words.length; start += 1) {
    const prefix = words.slice(0, start);
    if (!prefix.every((word) =>
      BODY_SITE_ATTRIBUTIVE_MODIFIERS.has(word) || BODY_SITE_BARE_NOMINAL_PREFIXES.has(word)
    )) continue;
    const suffix = words.slice(start).join(" ");
    const definition = lookupDefinitionForCanonical(suffix, customSiteMap);
    if (definition?.coding?.code || definition?.routeHint) return { canonical: suffix, definition };
  }
  return undefined;
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

function canonicalBodySiteLocativeRelation(
  value: string | undefined
): BodySiteLocativeRelation | undefined {
  if (!value) return undefined;
  const canonical = normalizeBodySiteRelation(value);
  return canonical && BODY_SITE_LOCATIVE_RELATIONS.has(canonical as BodySiteLocativeRelation)
    ? canonical as BodySiteLocativeRelation
    : undefined;
}

function matchBodySiteLocativeRelation(
  words: readonly string[],
  start = 0
): { relation: BodySiteLocativeRelation; length: number } | undefined {
  let best: { relation: BodySiteLocativeRelation; length: number } | undefined;
  for (const [phrase, canonical] of BODY_SITE_LOCATIVE_RELATION_PHRASES) {
    const parts = phrase.split(/\s+/u);
    if (parts.length <= (best?.length ?? 0) || start + parts.length > words.length) continue;
    if (!parts.every((part, offset) => words[start + offset] === part)) continue;
    const relation = canonicalBodySiteLocativeRelation(canonical);
    if (relation) best = { relation, length: parts.length };
  }
  if (best) return best;
  const relation = canonicalBodySiteLocativeRelation(words[start]);
  return relation ? { relation, length: 1 } : undefined;
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
  const firstRelation = matchBodySiteLocativeRelation(words);
  if (firstRelation && words.length > firstRelation.length) {
    const targetText = words.slice(firstRelation.length).join(" ");
    const targetFeatures = parseBodySiteFeatures(targetText, undefined, customSiteMap);
    // Nested locatives are flattened to a nominal target to avoid recursive
    // relation stacks such as "inside below ear"; we preserve the outer relation.
    return {
      kind: "locative",
      relation: firstRelation.relation,
      target: targetFeatures.kind === "locative"
        ? buildNominalFeatures(targetText, normalizeBodySiteKey(targetText), undefined, customSiteMap)
        : targetFeatures
    };
  }

  const areaRelation = firstWord && (firstWord === "area" || firstWord === "region")
    ? matchBodySiteLocativeRelation(words, 1)
    : undefined;
  if (areaRelation && words.length > 1 + areaRelation.length) {
    const targetText = words.slice(1 + areaRelation.length).join(" ");
    const targetFeatures = parseBodySiteFeatures(targetText, undefined, customSiteMap);
    return {
      kind: "locative",
      relation: areaRelation.relation,
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

  if (
    words.length > 1 &&
    (firstWord === "left" || firstWord === "right") &&
    !lookupDefinitionForCanonical(normalized, customSiteMap)
  ) {
    const wholeText = words.slice(1).join(" ");
    const wholeCanonical = normalizeBodySiteKey(wholeText);
    const wholeDefinition = lookupDefinitionForCanonical(wholeCanonical, customSiteMap);
    if (wholeDefinition?.coding?.code || wholeDefinition?.routeHint) {
      return {
        kind: "partitive",
        part: `${firstWord} side`,
        relationKey: "side",
        whole: buildNominalFeatures(wholeText, wholeCanonical, undefined, customSiteMap),
        attributive: true
      };
    }
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
    case "locative": {
      const surface = getBodySiteRelationRealization(features.relation, "en")?.surface ?? features.relation;
      return `${surface} ${renderBodySiteObject(features.target)}`;
    }
    case "partitive":
      if (features.attributive) {
        const side = features.part.split(/\s+/u)[0] ?? features.part;
        return features.whole.article === "bare"
          ? `${side} ${features.whole.text}`
          : `the ${side} ${features.whole.text}`;
      }
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
      return features.attributive
        ? `${features.part.split(/\s+/u)[0] ?? features.part} ${features.whole.text}`
        : `${features.part} of ${features.whole.text}`;
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

function withBodySiteQualifier(
  features: BodySiteFeatureStructure,
  qualifier: BodySiteQualifierFeatures
): BodySiteFeatureStructure {
  return { ...features, qualifier } as BodySiteFeatureStructure;
}

interface BodySiteQualifierMatch {
  relation: string;
  target: "symptom" | "site";
  start: number;
  end: number;
}

interface BodySiteQualifierMatcher {
  relation: string;
  target: "symptom" | "site";
  marker: string;
}

const BODY_SITE_QUALIFIER_MATCHERS: readonly BodySiteQualifierMatcher[] = (() => {
  const matchers: BodySiteQualifierMatcher[] = [];
  const seen = new Set<string>();
  for (const definition of listBodySiteRelationDefinitions()) {
    const target = definition.grammar.qualifierTarget;
    if (!target) continue;
    const surfaces = [
      definition.canonical,
      ...definition.aliases,
      definition.realization.en?.surface,
      definition.realization.th?.surface
    ];
    for (const surface of surfaces) {
      const normalizedSurface = surface ? normalizeBodySiteKey(surface) : "";
      if (!normalizedSurface) continue;
      const key = `${definition.canonical}|${target}|${normalizedSurface}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matchers.push({
        relation: definition.canonical,
        target,
        marker: ` ${normalizedSurface} `
      });
    }
  }
  return matchers.sort((left, right) => right.marker.length - left.marker.length);
})();

function matchBodySiteQualifier(lookupCanonical: string): BodySiteQualifierMatch | undefined {
  let best: BodySiteQualifierMatch | undefined;
  for (const matcher of BODY_SITE_QUALIFIER_MATCHERS) {
    const index = lookupCanonical.lastIndexOf(matcher.marker);
    if (index <= 0 || index + matcher.marker.length >= lookupCanonical.length) continue;
    const candidate: BodySiteQualifierMatch = {
      relation: matcher.relation,
      target: matcher.target,
      start: index,
      end: index + matcher.marker.length
    };
    if (!best || candidate.start > best.start ||
        candidate.start === best.start && candidate.end > best.end) best = candidate;
  }
  return best;
}

function qualifiedBodySitePhrase(
  lookupCanonical: string,
  customSiteMap?: Record<string, BodySiteDefinition>,
  context?: BodySitePhraseContext
): ResolvedBodySitePhrase | undefined {
  const match = matchBodySiteQualifier(lookupCanonical);
  if (!match) return undefined;
  const base = resolveBodySitePhrase(lookupCanonical.slice(0, match.start), customSiteMap, context);
  if (!base) return undefined;
  const targetText = lookupCanonical.slice(match.end);
  const realization = getBodySiteRelationRealization(match.relation, "en");
  if (!realization) return undefined;

  if (match.target === "symptom") {
    const symptom = resolveSymptomDefinition(targetText);
    if (!symptom) return undefined;
    const conditionText = symptom.conditionI18n?.en ?? symptom.text?.toLowerCase() ?? targetText;
    const qualifier: BodySiteQualifierFeatures = {
      kind: "symptom", relation: match.relation, text: targetText,
      canonical: symptom.text?.toLowerCase() ?? targetText,
      coding: symptom.coding ? { ...symptom.coding } : undefined,
      i18n: { en: conditionText, ...(symptom.i18n ?? {}), ...(symptom.conditionI18n ?? {}) }
    };
    return {
      ...base,
      lookupCanonical,
      resolutionCanonical: `${base.resolutionCanonical} ${match.relation} ${qualifier.canonical}`,
      canonical: `${base.canonical} ${match.relation} ${qualifier.canonical}`,
      displayText: `${base.displayText} ${realization.surface} ${conditionText}`,
      features: withBodySiteQualifier(base.features, qualifier),
      englishObjectText: `${base.englishObjectText} ${realization.surface} ${conditionText}`
    };
  }

  const target = resolveBodySitePhrase(targetText, customSiteMap, context);
  if (!target) return undefined;
  if (base.resolutionCanonical === target.resolutionCanonical) return base;
  if (!(base.coding || base.definition || base.spatialRelation)) return undefined;
  if (!(target.coding || target.definition || target.spatialRelation)) return undefined;
  const qualifier: BodySiteQualifierFeatures = {
    kind: "site", relation: match.relation, text: target.displayText,
    targetText: target.displayText,
    targetCoding: target.coding ? { ...target.coding } : undefined
  };
  return {
    ...base,
    lookupCanonical,
    resolutionCanonical: `${base.resolutionCanonical} ${match.relation} ${target.resolutionCanonical}`,
    canonical: `${base.canonical} ${match.relation} ${target.canonical}`,
    displayText: `${base.displayText} ${realization.surface} ${target.displayText}`,
    features: withBodySiteQualifier(base.features, qualifier),
    englishObjectText: `${base.englishObjectText} ${realization.surface} ${target.englishObjectText}`
  };
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
  const qualified = qualifiedBodySitePhrase(lookupCanonical, customSiteMap, context);
  if (qualified) return qualified;

  const contextualCanonical = resolveContextualBodySiteAlias(lookupCanonical, context);
  const displaySourceText = contextualCanonical ?? trimmed;
  const displayText = normalizeSiteDisplayText(displaySourceText, customSiteMap);
  const canonical = normalizeBodySiteKey(displayText);
  const directDefinition =
    lookupBodySiteDefinition(customSiteMap, lookupCanonical) ??
    (contextualCanonical
      ? lookupBodySiteDefinition(customSiteMap, contextualCanonical)
      : undefined) ??
    (contextualCanonical ? DEFAULT_BODY_SITE_SNOMED[contextualCanonical] : undefined) ??
    DEFAULT_BODY_SITE_SNOMED[lookupCanonical] ??
    lookupBodySiteDefinition(customSiteMap, canonical) ??
    DEFAULT_BODY_SITE_SNOMED[canonical];
  const preliminaryFeatures = parseBodySiteFeatures(displayText, undefined, customSiteMap);
  const terminal = directDefinition ||
    !context?.allowTerminalModifierInheritance ||
    preliminaryFeatures.kind !== "nominal"
    ? undefined
    : longestTerminalBodySiteDefinition(canonical, customSiteMap);
  const baseDefinition = directDefinition ?? terminal?.definition;
  const finalDisplayText = directDefinition?.text ?? displayText;
  let inheritedDefinition: BodySiteDefinition | undefined;
  if (!baseDefinition) {
    const candidateFeatures = parseBodySiteFeatures(finalDisplayText, undefined, customSiteMap);
    if (candidateFeatures.kind === "partitive" && candidateFeatures.attributive) {
      inheritedDefinition = lookupDefinitionForCanonical(candidateFeatures.whole.canonical, customSiteMap);
    }
  }
  const definition = baseDefinition ?? inheritedDefinition;
  const coding = buildBodySiteCoding(definition);
  const features = parseBodySiteFeatures(finalDisplayText, coding, customSiteMap);
  const spatialRelation =
    definition?.spatialRelation ??
    buildSpatialRelation(features, finalDisplayText, customSiteMap);

  return {
    lookupCanonical,
    resolutionCanonical: contextualCanonical ?? terminal?.canonical ?? lookupCanonical,
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
