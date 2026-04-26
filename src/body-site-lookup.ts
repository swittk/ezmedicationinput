import {
  ResolvedBodySitePhrase,
  resolveBodySitePhrase
} from "./body-site-grammar";
import {
  DEFAULT_BODY_SITE_SNOMED_SOURCE,
  normalizeBodySiteKey
} from "./maps";
import {
  SNOMED_CT_BILATERAL_QUALIFIER_CODE,
  SNOMED_CT_LEFT_QUALIFIER_CODE,
  SNOMED_CT_RIGHT_QUALIFIER_CODE,
  SNOMED_SYSTEM
} from "./snomed";
import {
  buildSnomedBodySiteTopographicalModifierPostcoordinationCode,
  parseSnomedBodySiteLateralityPostcoordinationCode,
  parseSnomedBodySiteTopographicalModifierPostcoordinationCode,
  parseSnomedFindingSitePostcoordinationCode
} from "./snomed-postcoordination";
import {
  BODY_SITE_LOCATIVE_RELATIONS,
  BODY_SITE_PARTITIVE_CONNECTORS,
  BODY_SITE_PARTITIVE_HEADS,
  BODY_SITE_PARTITIVE_MODIFIERS,
  BODY_SITE_SPATIAL_RELATION_CODINGS,
  SITE_ANCHORS,
  SITE_SELF_DISPLAY_ANCHORS
} from "./hpsg/lexical-classes";
import {
  BodySiteCode,
  BodySiteDefinition,
  BodySiteSpatialRelation,
  FhirCoding
} from "./types";
import { objectEntries } from "./utils/object";

export interface BodySiteLookupOptions {
  siteCodeMap?: Record<string, BodySiteDefinition>;
  siteCodeResolvers?: BodySiteResolver | BodySiteResolver[];
  bodySiteContext?: string;
  /**
   * Defaults to true. When true, phrase-to-code lookup can return a
   * SNOMED-coded topographical modifier expression for spatial body-site
   * phrases that do not have a direct pre-coordinated body-site code.
   */
  postcoordination?: boolean;
  limit?: number;
}

export interface BodySiteTextOptions {
  siteCodeMap?: Record<string, BodySiteDefinition>;
  siteTextResolvers?: BodySiteTextResolver | BodySiteTextResolver[];
  system?: string;
  /**
   * Defaults to true. When true, SNOMED finding-site postcoordination strings
   * such as "22253000:363698007=723979003" and topographical modifier
   * expressions such as "69536005:106233006=261183002" are resolved.
   */
  postcoordination?: boolean;
  parsePostcoordination?: boolean;
}

export interface BodySiteLookupResult {
  text: string;
  canonical: string;
  lookupCanonical: string;
  resolutionCanonical: string;
  matchedText: string;
  coding?: BodySiteCode;
  spatialRelation?: BodySiteSpatialRelation;
  definition?: BodySiteDefinition;
  score: number;
}

export interface BodySiteLookupRequest {
  originalText: string;
  text: string;
  normalized: string;
  canonical: string;
  bodySiteContext?: string;
  spatialRelation?: BodySiteSpatialRelation;
}

export interface BodySiteTextLookupRequest {
  coding: BodySiteCode;
  originalCoding: BodySiteCode;
  parsedPostcoordination?: {
    type: "topographicalModifier" | "laterality" | "findingSite";
    siteCode: string;
    modifierCode?: string;
    lateralityCode?: string;
    focusCode?: string;
  };
}

export type BodySiteResolver = (
  request: BodySiteLookupRequest
) => BodySiteDefinition | null | undefined | Promise<BodySiteDefinition | null | undefined>;

export type BodySiteTextResolver = (
  request: BodySiteTextLookupRequest
) => string | null | undefined | Promise<string | null | undefined>;

export interface BodySiteVocabularyOptions {
  siteCodeMap?: Record<string, BodySiteDefinition>;
  bodySiteContext?: string;
  limit?: number;
}

export interface BodySiteGrammarVocabulary {
  siteAnchors: string[];
  siteSelfDisplayAnchors: string[];
  locativeRelations: string[];
  partitiveHeads: string[];
  partitiveModifiers: string[];
  partitiveConnectors: string[];
  spatialRelationCodings: Record<string, FhirCoding>;
}

interface BodySiteCandidate {
  phrase: string;
  definition?: BodySiteDefinition;
}

type BodySiteCodeInput = string | BodySiteCode | FhirCoding;

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function isPromise<T>(value: unknown): value is Promise<T> {
  return !!value && typeof (value as { then?: unknown }).then === "function";
}

const POSTCOORDINATABLE_RELATION_TEXTS = new Set([
  "above",
  "back",
  "behind",
  "below",
  "beneath",
  "lower",
  "side",
  "top",
  "under",
  "upper"
]);

const RELATION_TEXT_BY_TOPOGRAPHICAL_MODIFIER_CODE: Record<string, string> = {
  "255551008": "back",
  "261122009": "lower",
  "261183002": "top",
  "351726001": "below",
  "352730000": "above",
  "49370004": "side"
};
const POSTCOORDINATABLE_RELATION_CODES = new Set(
  Object.keys(RELATION_TEXT_BY_TOPOGRAPHICAL_MODIFIER_CODE)
);

const LATERALITY_TEXT_BY_CODE: Record<string, string> = {
  [SNOMED_CT_LEFT_QUALIFIER_CODE]: "left",
  [SNOMED_CT_RIGHT_QUALIFIER_CODE]: "right",
  [SNOMED_CT_BILATERAL_QUALIFIER_CODE]: "both"
};

const BODY_SITE_PLURALS: Record<string, string> = {
  foot: "feet",
  goosefoot: "goosefeet",
  index: "indices",
  tooth: "teeth"
};

function pluralizeBodySiteText(text: string): string {
  const normalized = text.trim();
  const irregular = BODY_SITE_PLURALS[normalized];
  if (irregular) {
    return irregular;
  }
  if (/[^aeiou]y$/i.test(normalized)) {
    return `${normalized.slice(0, -1)}ies`;
  }
  if (/(s|x|z|ch|sh)$/i.test(normalized)) {
    return `${normalized}es`;
  }
  return `${normalized}s`;
}

function toBodySiteCode(coding: FhirCoding | BodySiteCode | undefined): BodySiteCode | undefined {
  if (!coding?.code) {
    return undefined;
  }
  return {
    system: coding.system ?? SNOMED_SYSTEM,
    code: coding.code,
    display: coding.display,
    i18n: "i18n" in coding ? coding.i18n : undefined
  };
}

function resultFromResolved(
  resolved: ResolvedBodySitePhrase,
  matchedText: string,
  score: number
): BodySiteLookupResult {
  return {
    text: resolved.displayText,
    canonical: resolved.canonical,
    lookupCanonical: resolved.lookupCanonical,
    resolutionCanonical: resolved.resolutionCanonical,
    matchedText,
    coding: toBodySiteCode(resolved.coding),
    spatialRelation: resolved.spatialRelation,
    definition: resolved.definition,
    score
  };
}

function bodySiteLookupRequest(
  input: string,
  resolved: ResolvedBodySitePhrase | undefined,
  options?: BodySiteLookupOptions
): BodySiteLookupRequest {
  const normalized = normalizeBodySiteKey(input);
  return {
    originalText: input,
    text: resolved?.displayText ?? input.trim(),
    normalized,
    canonical: resolved?.canonical ?? normalized,
    bodySiteContext: options?.bodySiteContext,
    spatialRelation: resolved?.spatialRelation
  };
}

function applyResolverDefinition(
  result: BodySiteLookupResult,
  definition: BodySiteDefinition
): BodySiteLookupResult {
  return {
    ...result,
    text: definition.text ?? result.text,
    coding: toBodySiteCode(definition.coding),
    spatialRelation: definition.spatialRelation ?? result.spatialRelation,
    definition
  };
}

function resultFromResolverDefinition(
  input: string,
  definition: BodySiteDefinition
): BodySiteLookupResult {
  const normalized = normalizeBodySiteKey(input);
  const text = definition.text ?? normalized;
  return {
    text,
    canonical: normalizeBodySiteKey(text),
    lookupCanonical: normalized,
    resolutionCanonical: normalized,
    matchedText: normalized,
    coding: toBodySiteCode(definition.coding),
    spatialRelation: definition.spatialRelation,
    definition,
    score: 100
  };
}

function applySyncResolvers(
  result: BodySiteLookupResult | undefined,
  input: string,
  resolved: ResolvedBodySitePhrase | undefined,
  options?: BodySiteLookupOptions
): BodySiteLookupResult | undefined {
  const resolvers = toArray(options?.siteCodeResolvers);
  if (!resolvers.length) {
    return result;
  }
  for (const resolver of resolvers) {
    const resolution = resolver(bodySiteLookupRequest(input, resolved, options));
    if (isPromise(resolution)) {
      throw new Error(
        "Body site resolver returned a Promise; use lookupBodySiteAsync/getBodySiteCodeAsync for asynchronous site lookup."
      );
    }
    if (!resolution) {
      continue;
    }
    return result
      ? applyResolverDefinition(result, resolution)
      : resultFromResolverDefinition(input, resolution);
  }
  return result;
}

async function applyAsyncResolvers(
  result: BodySiteLookupResult | undefined,
  input: string,
  resolved: ResolvedBodySitePhrase | undefined,
  options?: BodySiteLookupOptions
): Promise<BodySiteLookupResult | undefined> {
  const resolvers = toArray(options?.siteCodeResolvers);
  if (!resolvers.length) {
    return result;
  }
  for (const resolver of resolvers) {
    const resolution = await resolver(bodySiteLookupRequest(input, resolved, options));
    if (!resolution) {
      continue;
    }
    return result
      ? applyResolverDefinition(result, resolution)
      : resultFromResolverDefinition(input, resolution);
  }
  return result;
}

function addCandidate(
  candidates: BodySiteCandidate[],
  phrase: string | undefined,
  definition?: BodySiteDefinition
): void {
  const normalized = normalizeBodySiteKey(phrase ?? "");
  if (!normalized) {
    return;
  }
  candidates.push({ phrase: normalized, definition });
}

function addDefinitionCandidates(
  candidates: BodySiteCandidate[],
  definition: BodySiteDefinition | undefined
): void {
  if (!definition) {
    return;
  }
  addCandidate(candidates, definition.text, definition);
  for (const alias of definition.aliases ?? []) {
    addCandidate(candidates, alias, definition);
  }
}

function collectBodySiteCandidates(
  siteCodeMap: Record<string, BodySiteDefinition> | undefined
): BodySiteCandidate[] {
  const candidates: BodySiteCandidate[] = [];
  for (const source of DEFAULT_BODY_SITE_SNOMED_SOURCE) {
    for (const name of source.names) {
      addCandidate(candidates, name, source.definition);
    }
    addDefinitionCandidates(candidates, source.definition);
  }
  if (siteCodeMap) {
    for (const [key, definition] of objectEntries(siteCodeMap)) {
      addCandidate(candidates, String(key), definition);
      addDefinitionCandidates(candidates, definition);
    }
  }
  return candidates;
}

function codeFromInput(input: BodySiteCodeInput, options?: BodySiteTextOptions): BodySiteCode | undefined {
  if (typeof input === "string") {
    const normalized = input.trim();
    return normalized ? { code: normalized, system: options?.system ?? SNOMED_SYSTEM } : undefined;
  }
  return toBodySiteCode(input);
}

function bodySiteCodeFromInput(
  input: BodySiteCodeInput,
  options?: BodySiteTextOptions
): BodySiteCode | undefined {
  const coding = codeFromInput(input, options);
  const shouldParsePostcoordination =
    options?.postcoordination !== false &&
    options?.parsePostcoordination !== false;
  const parsedTopographicalModifier = shouldParsePostcoordination
    ? parseSnomedBodySiteTopographicalModifierPostcoordinationCode(coding?.code)
    : undefined;
  if (parsedTopographicalModifier) {
    return {
      system: coding?.system ?? SNOMED_SYSTEM,
      code: parsedTopographicalModifier.siteCode
    };
  }
  const parsedPostcoordination =
    !shouldParsePostcoordination
      ? undefined
      : parseSnomedFindingSitePostcoordinationCode(coding?.code);
  if (parsedPostcoordination) {
    return {
      system: coding?.system ?? SNOMED_SYSTEM,
      code: parsedPostcoordination.siteCode
    };
  }
  return coding;
}

function parsedPostcoordinationForInput(
  input: BodySiteCodeInput,
  options?: BodySiteTextOptions
): {
  topographicalModifier?: ReturnType<typeof parseSnomedBodySiteTopographicalModifierPostcoordinationCode>;
  laterality?: ReturnType<typeof parseSnomedBodySiteLateralityPostcoordinationCode>;
  findingSite?: ReturnType<typeof parseSnomedFindingSitePostcoordinationCode>;
} {
  const originalCoding = codeFromInput(input, options);
  const shouldParse =
    options?.postcoordination !== false &&
    options?.parsePostcoordination !== false;
  if (!shouldParse) {
    return {};
  }
  return {
    topographicalModifier: parseSnomedBodySiteTopographicalModifierPostcoordinationCode(
      originalCoding?.code
    ),
    laterality: parseSnomedBodySiteLateralityPostcoordinationCode(originalCoding?.code),
    findingSite: parseSnomedFindingSitePostcoordinationCode(originalCoding?.code)
  };
}

function findBodySiteTextByCode(
  coding: BodySiteCode,
  siteCodeMap?: Record<string, BodySiteDefinition>
): string | undefined {
  for (const candidate of collectBodySiteCandidates(siteCodeMap)) {
    if (codeMatches(coding, candidate.definition?.coding)) {
      return definitionText(candidate.phrase, candidate.definition);
    }
  }
  return undefined;
}

function definitionText(
  phrase: string,
  definition: BodySiteDefinition | undefined
): string {
  return definition?.text ?? normalizeBodySiteKey(phrase);
}

function codeMatches(
  left: BodySiteCode,
  right: BodySiteCode | undefined
): boolean {
  if (!right?.code) {
    return false;
  }
  const leftSystem = left.system ?? SNOMED_SYSTEM;
  const rightSystem = right.system ?? SNOMED_SYSTEM;
  return left.code === right.code && leftSystem === rightSystem;
}

function buildBodySiteTextLookupRequest(
  coding: BodySiteCode,
  originalCoding: BodySiteCode,
  parsedTopographicalModifier:
    | ReturnType<typeof parseSnomedBodySiteTopographicalModifierPostcoordinationCode>
    | undefined,
  parsedLaterality:
    | ReturnType<typeof parseSnomedBodySiteLateralityPostcoordinationCode>
    | undefined,
  parsedFindingSite:
    | ReturnType<typeof parseSnomedFindingSitePostcoordinationCode>
    | undefined
): BodySiteTextLookupRequest {
  const parsedPostcoordination = parsedTopographicalModifier
    ? {
      type: "topographicalModifier" as const,
      siteCode: parsedTopographicalModifier.siteCode,
      modifierCode: parsedTopographicalModifier.modifierCode
    }
    : parsedLaterality
      ? {
        type: "laterality" as const,
        siteCode: parsedLaterality.siteCode,
        lateralityCode: parsedLaterality.lateralityCode
      }
      : parsedFindingSite
        ? {
          type: "findingSite" as const,
          siteCode: parsedFindingSite.siteCode,
          focusCode: parsedFindingSite.focusCode
        }
        : undefined;
  return {
    coding,
    originalCoding,
    parsedPostcoordination
  };
}

function applySyncTextResolvers(
  text: string | undefined,
  request: BodySiteTextLookupRequest,
  options?: BodySiteTextOptions
): string | undefined {
  if (text) {
    return text;
  }
  for (const resolver of toArray(options?.siteTextResolvers)) {
    const result = resolver(request);
    if (isPromise(result)) {
      throw new Error(
        "Body site text resolver returned a Promise; use getBodySiteTextAsync for asynchronous site text lookup."
      );
    }
    if (result) {
      return result;
    }
  }
  return undefined;
}

async function applyAsyncTextResolvers(
  text: string | undefined,
  request: BodySiteTextLookupRequest,
  options?: BodySiteTextOptions
): Promise<string | undefined> {
  if (text) {
    return text;
  }
  for (const resolver of toArray(options?.siteTextResolvers)) {
    const result = await resolver(request);
    if (result) {
      return result;
    }
  }
  return undefined;
}

function scoreCandidate(query: string, candidate: string): number {
  const stableScore = (score: number) => Math.round(score * 10) / 10;
  if (!query || !candidate) {
    return 0;
  }
  if (candidate === query) {
    return stableScore(100);
  }
  if (candidate.startsWith(query)) {
    return stableScore(90 - Math.min(candidate.length - query.length, 20) * 0.2);
  }
  const candidateTokens = candidate.split(/\s+/).filter((token) => token.length > 0);
  for (const token of candidateTokens) {
    if (token.startsWith(query)) {
      return stableScore(82 - Math.min(candidate.length - query.length, 20) * 0.2);
    }
  }
  if (candidate.includes(query)) {
    return stableScore(72 - Math.min(candidate.length - query.length, 20) * 0.2);
  }
  const queryTokens = query.split(/\s+/).filter((token) => token.length > 0);
  if (queryTokens.length > 1 && queryTokens.every((token) => candidate.includes(token))) {
    return stableScore(60 - Math.min(candidate.length - query.length, 20) * 0.2);
  }
  return 0;
}

function spatialRelationKey(relation: BodySiteSpatialRelation | undefined): string {
  if (!relation) {
    return "";
  }
  const relationCode = relation.relationCoding?.code ?? "";
  const targetCode = relation.targetCoding?.code ?? "";
  return [
    relation.relationText,
    relationCode,
    relation.targetText ?? "",
    targetCode
  ].join("|");
}

function resultKey(result: BodySiteLookupResult): string {
  const relation = spatialRelationKey(result.spatialRelation);
  if (result.coding?.code) {
    return `${result.coding.system ?? SNOMED_SYSTEM}|${result.coding.code}|${relation}`;
  }
  return `${result.canonical}|${relation}`;
}

function sortBodySiteResults(results: BodySiteLookupResult[]): BodySiteLookupResult[] {
  return results.sort((left, right) => {
    const scoreDelta = right.score - left.score;
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    return left.text.localeCompare(right.text);
  });
}

function uniqueText(results: BodySiteLookupResult[]): string[] {
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const result of results) {
    const text = result.text.trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    texts.push(text);
  }
  return texts;
}

function sortedSetValues(values: Set<string>): string[] {
  return Array.from(values).sort((left, right) => left.localeCompare(right));
}

function canBuildTopographicalModifierPostcoordination(
  relation: BodySiteSpatialRelation | undefined
): relation is BodySiteSpatialRelation & {
  relationCoding: FhirCoding & { code: string };
  targetCoding: BodySiteCode & { code: string };
} {
  if (!relation?.relationCoding?.code || !relation.targetCoding?.code) {
    return false;
  }
  return (
    POSTCOORDINATABLE_RELATION_TEXTS.has(normalizeBodySiteKey(relation.relationText)) ||
    POSTCOORDINATABLE_RELATION_CODES.has(relation.relationCoding.code)
  );
}

function buildSpatialRelationDisplayText(
  relation: BodySiteSpatialRelation
): string | undefined {
  const relationText = normalizeBodySiteKey(relation.relationText);
  const targetText = normalizeBodySiteKey(relation.targetText ?? "");
  if (!relationText || !targetText) {
    return undefined;
  }
  switch (relationText) {
    case "above":
    case "around":
    case "behind":
    case "below":
    case "beneath":
    case "between":
    case "inside":
    case "near":
    case "outside":
    case "under":
      return `${relationText} ${targetText}`;
    default:
      return `${relationText} of ${targetText}`;
  }
}

export function buildBodySiteTopographicalModifierCoding(
  relation: BodySiteSpatialRelation | undefined,
  display?: string,
  options?: Pick<BodySiteLookupOptions, "postcoordination">
): BodySiteCode | undefined {
  if (options?.postcoordination === false) {
    return undefined;
  }
  if (!canBuildTopographicalModifierPostcoordination(relation)) {
    return undefined;
  }
  const targetSystem = relation.targetCoding.system ?? SNOMED_SYSTEM;
  const relationSystem = relation.relationCoding.system ?? SNOMED_SYSTEM;
  if (targetSystem !== SNOMED_SYSTEM || relationSystem !== SNOMED_SYSTEM) {
    return undefined;
  }
  return {
    system: SNOMED_SYSTEM,
    code: buildSnomedBodySiteTopographicalModifierPostcoordinationCode(
      relation.targetCoding.code,
      relation.relationCoding.code
    ),
    display: display ?? buildSpatialRelationDisplayText(relation)
  };
}

export function lookupBodySite(
  input: string,
  options?: BodySiteLookupOptions
): BodySiteLookupResult | undefined {
  const normalized = normalizeBodySiteKey(input);
  const resolved = resolveBodySitePhrase(input, options?.siteCodeMap, {
    bodySiteContext: options?.bodySiteContext
  });
  const result = resolved ? resultFromResolved(resolved, normalized, 100) : undefined;
  return applySyncResolvers(result, input, resolved, options);
}

export async function lookupBodySiteAsync(
  input: string,
  options?: BodySiteLookupOptions
): Promise<BodySiteLookupResult | undefined> {
  const normalized = normalizeBodySiteKey(input);
  const resolved = resolveBodySitePhrase(input, options?.siteCodeMap, {
    bodySiteContext: options?.bodySiteContext
  });
  const result = resolved ? resultFromResolved(resolved, normalized, 100) : undefined;
  return applyAsyncResolvers(result, input, resolved, options);
}

export function getBodySiteCode(
  input: string,
  options?: BodySiteLookupOptions
): BodySiteCode | undefined {
  const resolved = lookupBodySite(input, options);
  if (!resolved) {
    return undefined;
  }
  return resolved.coding ?? buildBodySiteTopographicalModifierCoding(
    resolved.spatialRelation,
    resolved.text,
    options
  );
}

export async function getBodySiteCodeAsync(
  input: string,
  options?: BodySiteLookupOptions
): Promise<BodySiteCode | undefined> {
  const resolved = await lookupBodySiteAsync(input, options);
  if (!resolved) {
    return undefined;
  }
  return resolved.coding ?? buildBodySiteTopographicalModifierCoding(
    resolved.spatialRelation,
    resolved.text,
    options
  );
}

export function getBodySiteText(
  input: BodySiteCodeInput,
  options?: BodySiteTextOptions
): string | undefined {
  const originalCoding = codeFromInput(input, options);
  const coding = bodySiteCodeFromInput(input, options);
  if (!coding) {
    return undefined;
  }

  const parsed = parsedPostcoordinationForInput(input, options);
  const siteText = findBodySiteTextByCode(coding, options?.siteCodeMap);
  let text = siteText;
  if (parsed.topographicalModifier) {
    const relationText =
      RELATION_TEXT_BY_TOPOGRAPHICAL_MODIFIER_CODE[parsed.topographicalModifier.modifierCode];
    if (siteText && relationText) {
      switch (relationText) {
        case "above":
        case "below":
          text = `${relationText} ${siteText}`;
          break;
        default:
          text = `${relationText} of ${siteText}`;
          break;
      }
    }
  }
  if (!text && parsed.laterality) {
    const baseText = findBodySiteTextByCode(
      {
        system: originalCoding?.system ?? SNOMED_SYSTEM,
        code: parsed.laterality.siteCode
      },
      options?.siteCodeMap
    );
    const lateralityText = LATERALITY_TEXT_BY_CODE[parsed.laterality.lateralityCode];
    if (baseText && lateralityText) {
      text = lateralityText === "both" ? `both ${pluralizeBodySiteText(baseText)}` : `${lateralityText} ${baseText}`;
    }
  }
  return applySyncTextResolvers(
    text,
    buildBodySiteTextLookupRequest(
      coding,
      originalCoding ?? coding,
      parsed.topographicalModifier,
      parsed.laterality,
      parsed.findingSite
    ),
    options
  );
}

export async function getBodySiteTextAsync(
  input: BodySiteCodeInput,
  options?: BodySiteTextOptions
): Promise<string | undefined> {
  const originalCoding = codeFromInput(input, options);
  const coding = bodySiteCodeFromInput(input, options);
  if (!coding) {
    return undefined;
  }

  const parsed = parsedPostcoordinationForInput(input, options);
  const text = getBodySiteText(input, {
    ...options,
    siteTextResolvers: undefined
  });
  return applyAsyncTextResolvers(
    text,
    buildBodySiteTextLookupRequest(
      coding,
      originalCoding ?? coding,
      parsed.topographicalModifier,
      parsed.laterality,
      parsed.findingSite
    ),
    options
  );
}

export function suggestBodySites(
  input: string,
  options?: BodySiteLookupOptions
): BodySiteLookupResult[] {
  const query = normalizeBodySiteKey(input);
  if (!query) {
    return [];
  }
  const limit = options?.limit ?? 10;
  if (limit <= 0) {
    return [];
  }

  const ranked = new Map<string, BodySiteLookupResult>();
  for (const candidate of collectBodySiteCandidates(options?.siteCodeMap)) {
    const score = scoreCandidate(query, candidate.phrase);
    if (score <= 0) {
      continue;
    }
    const resolved = resolveBodySitePhrase(candidate.phrase, options?.siteCodeMap, {
      bodySiteContext: options?.bodySiteContext
    });
    if (!resolved) {
      continue;
    }
    const result = resultFromResolved(resolved, candidate.phrase, score);
    const key = resultKey(result);
    const existing = ranked.get(key);
    if (!existing || existing.score < result.score) {
      ranked.set(key, result);
    }
  }

  return sortBodySiteResults(Array.from(ranked.values())).slice(0, limit);
}

export function suggestBodySiteText(
  input: string,
  options?: BodySiteLookupOptions
): string[] {
  return uniqueText(suggestBodySites(input, options));
}

export function listSupportedBodySiteText(
  options?: BodySiteVocabularyOptions
): string[] {
  const limit = options?.limit ?? Number.POSITIVE_INFINITY;
  if (limit <= 0) {
    return [];
  }
  const ranked = new Map<string, BodySiteLookupResult>();
  for (const candidate of collectBodySiteCandidates(options?.siteCodeMap)) {
    const resolved = resolveBodySitePhrase(candidate.phrase, options?.siteCodeMap, {
      bodySiteContext: options?.bodySiteContext
    });
    if (!resolved) {
      continue;
    }
    const result = resultFromResolved(resolved, candidate.phrase, 100);
    const key = resultKey(result);
    if (!ranked.has(key)) {
      ranked.set(key, result);
    }
  }
  return uniqueText(sortBodySiteResults(Array.from(ranked.values()))).slice(0, limit);
}

export function listSupportedBodySiteGrammar(): BodySiteGrammarVocabulary {
  const spatialRelationCodings: Record<string, FhirCoding> = {};
  for (const [key, coding] of BODY_SITE_SPATIAL_RELATION_CODINGS) {
    spatialRelationCodings[key] = { ...coding };
  }
  return {
    siteAnchors: sortedSetValues(SITE_ANCHORS),
    siteSelfDisplayAnchors: sortedSetValues(SITE_SELF_DISPLAY_ANCHORS),
    locativeRelations: sortedSetValues(BODY_SITE_LOCATIVE_RELATIONS),
    partitiveHeads: sortedSetValues(BODY_SITE_PARTITIVE_HEADS),
    partitiveModifiers: sortedSetValues(BODY_SITE_PARTITIVE_MODIFIERS),
    partitiveConnectors: sortedSetValues(BODY_SITE_PARTITIVE_CONNECTORS),
    spatialRelationCodings
  };
}
