import {
  ResolvedBodySitePhrase,
  resolveBodySitePhrase
} from "./body-site-grammar";
import {
  DEFAULT_BODY_SITE_SNOMED_SOURCE,
  normalizeBodySiteKey
} from "./maps";
import { SNOMED_SYSTEM } from "./snomed";
import {
  buildSnomedBodySiteTopographicalModifierPostcoordinationCode,
  parseSnomedBodySiteTopographicalModifierPostcoordinationCode,
  parseSnomedFindingSitePostcoordinationCode
} from "./snomed-postcoordination";
import {
  BodySiteCode,
  BodySiteDefinition,
  BodySiteSpatialRelation,
  FhirCoding
} from "./types";
import { objectEntries } from "./utils/object";

export interface BodySiteLookupOptions {
  siteCodeMap?: Record<string, BodySiteDefinition>;
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

interface BodySiteCandidate {
  phrase: string;
  definition?: BodySiteDefinition;
}

type BodySiteCodeInput = string | BodySiteCode | FhirCoding;

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

function scoreCandidate(query: string, candidate: string): number {
  if (!query || !candidate) {
    return 0;
  }
  if (candidate === query) {
    return 100;
  }
  if (candidate.startsWith(query)) {
    return 90 - Math.min(candidate.length - query.length, 20) * 0.2;
  }
  const candidateTokens = candidate.split(/\s+/).filter((token) => token.length > 0);
  for (const token of candidateTokens) {
    if (token.startsWith(query)) {
      return 82 - Math.min(candidate.length - query.length, 20) * 0.2;
    }
  }
  if (candidate.includes(query)) {
    return 72 - Math.min(candidate.length - query.length, 20) * 0.2;
  }
  const queryTokens = query.split(/\s+/).filter((token) => token.length > 0);
  if (queryTokens.length > 1 && queryTokens.every((token) => candidate.includes(token))) {
    return 60 - Math.min(candidate.length - query.length, 20) * 0.2;
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
  return resolved ? resultFromResolved(resolved, normalized, 100) : undefined;
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

export function getBodySiteText(
  input: BodySiteCodeInput,
  options?: BodySiteTextOptions
): string | undefined {
  const coding = bodySiteCodeFromInput(input, options);
  if (!coding) {
    return undefined;
  }

  const parsedTopographicalModifier =
    options?.postcoordination === false || options?.parsePostcoordination === false
      ? undefined
      : parseSnomedBodySiteTopographicalModifierPostcoordinationCode(
        codeFromInput(input, options)?.code
      );
  const siteText = findBodySiteTextByCode(coding, options?.siteCodeMap);
  if (parsedTopographicalModifier) {
    const relationText =
      RELATION_TEXT_BY_TOPOGRAPHICAL_MODIFIER_CODE[parsedTopographicalModifier.modifierCode];
    if (siteText && relationText) {
      switch (relationText) {
        case "above":
        case "below":
          return `${relationText} ${siteText}`;
        default:
          return `${relationText} of ${siteText}`;
      }
    }
  }
  return siteText;
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

  return Array.from(ranked.values())
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return left.text.localeCompare(right.text);
    })
    .slice(0, limit);
}
