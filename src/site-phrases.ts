import {
  DEFAULT_BODY_SITE_SNOMED,
  EVENT_TIMING_TOKENS,
  MEAL_KEYWORDS,
  TIMING_ABBREVIATIONS,
  WORD_FREQUENCIES,
  normalizeBodySiteKey
} from "./maps";
import {
  isApplicationVerbWord,
  isCountKeywordWord,
  isSiteAnchorWord,
  isSiteListConnectorWord,
  isSiteSurfaceModifierWord,
  isWorkflowInstructionWord
} from "./lexer/meaning";
import { Token } from "./internal-types";
import { BodySiteDefinition, ParseOptions, RouteCode } from "./types";

export interface SitePhraseServices {
  customSiteHints?: Set<string>;
  siteConnectors: ReadonlySet<string>;
  siteFillerWords: ReadonlySet<string>;
  normalizeTokenLower: (token: Token) => string;
  isBodySiteHint: (word: string, customSiteHints?: Set<string>) => boolean;
  hasExplicitSiteIntroduction: (startIndex: number) => boolean;
  isNumericToken: (value: string) => boolean;
  isOrdinalToken: (value: string) => boolean;
  mapFrequencyAdverb: (value: string) => string | undefined;
  mapIntervalUnit: (value: string) => string | undefined;
  normalizeUnit: (value: string, options?: ParseOptions) => string | undefined;
  hasRouteLikeWord: (value: string, options?: ParseOptions) => boolean;
  hasFrequencyLikeWord: (value: string) => boolean;
  getNextActiveToken: (index: number) => Token | undefined;
  getPreviousActiveToken: (index: number) => Token | undefined;
  hasApplicationVerbBefore: (index: number) => boolean;
}

export interface SiteLookupServices {
  lookupBodySiteDefinition: (
    map: Record<string, BodySiteDefinition> | undefined,
    canonical: string
  ) => BodySiteDefinition | undefined;
}

function isExplicitSiteBoundaryToken(
  lower: string,
  options: ParseOptions | undefined,
  services: SitePhraseServices
): boolean {
  if (!lower) {
    return true;
  }
  if (isWorkflowInstructionWord(lower)) {
    return true;
  }
  if (
    EVENT_TIMING_TOKENS[lower] ||
    TIMING_ABBREVIATIONS[lower] ||
    WORD_FREQUENCIES[lower] ||
    services.hasFrequencyLikeWord(lower) ||
    isCountKeywordWord(lower) ||
    services.mapFrequencyAdverb(lower) ||
    services.mapIntervalUnit(lower) ||
    MEAL_KEYWORDS[lower]
  ) {
    return true;
  }
  if (services.hasRouteLikeWord(lower, options) || services.normalizeUnit(lower, options)) {
    return true;
  }
  if (isApplicationVerbWord(lower)) {
    return true;
  }
  if (lower === "prn" || lower === "as" || lower === "needed" || lower === "for") {
    return true;
  }
  if (services.isNumericToken(lower) && !services.isOrdinalToken(lower)) {
    return true;
  }
  return false;
}

export function isTimingOnlySitePhrase(words: string[]): boolean {
  if (!words.length) {
    return true;
  }
  let phrase = "";
  let allTimingWords = true;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (index > 0) {
      phrase += " ";
    }
    phrase += word;
    if (
      !EVENT_TIMING_TOKENS[word] &&
      !TIMING_ABBREVIATIONS[word] &&
      !MEAL_KEYWORDS[word]
    ) {
      allTimingWords = false;
    }
  }
  if (
    EVENT_TIMING_TOKENS[phrase] ||
    TIMING_ABBREVIATIONS[phrase] ||
    MEAL_KEYWORDS[phrase]
  ) {
    return true;
  }
  return allTimingWords;
}

export function hasExternalSurfaceModifier(siteText: string): boolean {
  const normalized = normalizeBodySiteKey(siteText);
  if (!normalized) {
    return false;
  }
  const words = normalized.split(/\s+/);
  for (const word of words) {
    if (word.length > 0 && isSiteSurfaceModifierWord(word)) {
      return true;
    }
  }
  return false;
}

export function extractExplicitSiteCandidate(
  tokens: Token[],
  consumed: Set<number>,
  startIndex: number,
  options: ParseOptions | undefined,
  services: SitePhraseServices
): number[] | undefined {
  const anchor = tokens[startIndex];
  if (!anchor || consumed.has(anchor.index)) {
    return undefined;
  }
  const anchorLower = services.normalizeTokenLower(anchor);
  if (!isSiteAnchorWord(anchorLower)) {
    return undefined;
  }
  if (!services.hasExplicitSiteIntroduction(startIndex)) {
    return undefined;
  }

  const collected: number[] = [anchor.index];
  const contentWords: string[] = [];
  let hasSiteHint = false;

  for (let cursor = startIndex + 1; cursor < tokens.length; cursor += 1) {
    const candidate = tokens[cursor];
    if (!candidate || consumed.has(candidate.index)) {
      break;
    }
    const lower = services.normalizeTokenLower(candidate);
    if (/^[;:(),]+$/.test(lower)) {
      break;
    }
    if (services.siteFillerWords.has(lower) && contentWords.length === 0) {
      collected.push(candidate.index);
      continue;
    }
    if (isSiteListConnectorWord(lower) || lower === ",") {
      let hasFollowingContent = false;
      for (let lookahead = cursor + 1; lookahead < tokens.length; lookahead += 1) {
        const lookaheadToken = tokens[lookahead];
        if (!lookaheadToken || consumed.has(lookaheadToken.index)) {
          break;
        }
        const lookaheadLower = services.normalizeTokenLower(lookaheadToken);
        if (services.siteFillerWords.has(lookaheadLower)) {
          continue;
        }
        hasFollowingContent = !isExplicitSiteBoundaryToken(lookaheadLower, options, services);
        break;
      }
      if (!hasFollowingContent) {
        break;
      }
      collected.push(candidate.index);
      continue;
    }
    if (isExplicitSiteBoundaryToken(lower, options, services)) {
      if (lower === "top") {
        const nextToken = services.getNextActiveToken(cursor);
        if (nextToken && services.normalizeTokenLower(nextToken) === "of") {
          collected.push(candidate.index);
          contentWords.push(lower);
          hasSiteHint = true;
          continue;
        }
      }
      break;
    }
    collected.push(candidate.index);
    if (!services.siteConnectors.has(lower) && !services.siteFillerWords.has(lower)) {
      contentWords.push(lower);
      if (
        services.isBodySiteHint(lower, services.customSiteHints) ||
        isSiteSurfaceModifierWord(lower) ||
        services.isOrdinalToken(lower)
      ) {
        hasSiteHint = true;
      }
    }
  }

  if (!contentWords.length || isTimingOnlySitePhrase(contentWords)) {
    return undefined;
  }
  if (
    !hasSiteHint &&
    contentWords.length === 1 &&
    contentWords[0] !== "area" &&
    anchorLower === "in"
  ) {
    return undefined;
  }
  return collected;
}

export function selectBestResidualSiteGroup(
  groups: Array<{ tokens: Token[] }>,
  prnSiteSuffixIndices: Set<number>,
  services: SitePhraseServices
): Token[] | undefined {
  let bestGroup: Token[] | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const group of groups) {
    const filteredTokens: Token[] = [];
    const contentWords: string[] = [];
    let hasWorkflowWord = false;
    let knownWordCount = 0;
    let modifierCount = 0;

    for (const token of group.tokens) {
      if (prnSiteSuffixIndices.has(token.index)) {
        continue;
      }
      filteredTokens.push(token);
      const lower = services.normalizeTokenLower(token);
      if (
        lower.length === 0 ||
        services.siteConnectors.has(lower) ||
        services.siteFillerWords.has(lower) ||
        isSiteListConnectorWord(lower) ||
        lower === ","
      ) {
        continue;
      }
      contentWords.push(lower);
      if (isWorkflowInstructionWord(lower)) {
        hasWorkflowWord = true;
      }
      if (services.isBodySiteHint(lower, services.customSiteHints)) {
        knownWordCount += 1;
      }
      if (isSiteSurfaceModifierWord(lower) || services.isOrdinalToken(lower)) {
        modifierCount += 1;
      }
    }

    if (!filteredTokens.length) {
      continue;
    }
    if (!contentWords.length || isTimingOnlySitePhrase(contentWords)) {
      continue;
    }
    if (hasWorkflowWord) {
      continue;
    }
    const startsWithApplicationContext = services.hasApplicationVerbBefore(
      filteredTokens[0].index
    );
    const previous = services.getPreviousActiveToken(filteredTokens[0].index);
    const anchoredBySiteConnector = previous
      ? isSiteAnchorWord(services.normalizeTokenLower(previous))
      : false;
    if (
      knownWordCount === 0 &&
      modifierCount === 0 &&
      !anchoredBySiteConnector
    ) {
      continue;
    }
    const score =
      knownWordCount * 5 +
      modifierCount * 2 +
      (startsWithApplicationContext ? 2 : 0) +
      (anchoredBySiteConnector ? 2 : 0) -
      filteredTokens.length * 0.2 +
      filteredTokens[0].index * 0.001;
    if (score > bestScore) {
      bestScore = score;
      bestGroup = filteredTokens;
    }
  }

  return bestGroup;
}

export function inferRouteHintFromSitePhrase(
  siteText: string,
  options: ParseOptions | undefined,
  services: SiteLookupServices
): RouteCode | undefined {
  const canonical = normalizeBodySiteKey(siteText);
  if (!canonical) {
    return undefined;
  }

  const exact =
    services.lookupBodySiteDefinition(options?.siteCodeMap, canonical) ??
    DEFAULT_BODY_SITE_SNOMED[canonical];
  if (exact?.routeHint) {
    return exact.routeHint;
  }

  if (hasExternalSurfaceModifier(siteText)) {
    return undefined;
  }

  const words: string[] = [];
  for (const word of canonical.split(/\s+/)) {
    if (word.length > 0) {
      words.push(word);
    }
  }
  for (let length = words.length; length >= 1; length -= 1) {
    for (let start = 0; start + length <= words.length; start += 1) {
      let candidate = "";
      for (let offset = 0; offset < length; offset += 1) {
        if (offset > 0) {
          candidate += " ";
        }
        candidate += words[start + offset];
      }
      const definition =
        services.lookupBodySiteDefinition(options?.siteCodeMap, candidate) ??
        DEFAULT_BODY_SITE_SNOMED[candidate];
      if (definition?.routeHint) {
        return definition.routeHint;
      }
    }
  }

  return undefined;
}
