import {
  DEFAULT_BODY_SITE_SNOMED,
  DEFAULT_ROUTE_SYNONYMS,
  EVENT_TIMING_TOKENS,
  TIMING_ABBREVIATIONS,
  WORD_FREQUENCIES,
  normalizeBodySiteKey
} from "../../maps";
import { getDayOfWeekMeaning, getPrimarySiteMeaningCandidate, getRouteMeaning } from "../../lexer/meaning";
import { LexKind } from "../../lexer/token-types";
import { Token } from "../../parser-state";
import { RouteCode } from "../../types";
import { resolveBodySitePhrase } from "../../body-site-grammar";
import { inferRouteFromContext } from "../../context";
import { normalizeUnit } from "../../unit-lexicon";
import {
  EVERY_INTERVAL_TOKENS,
  FREQUENCY_NUMBER_WORDS,
  FREQUENCY_SIMPLE_WORDS,
  FREQUENCY_TIMES_WORDS,
  mapFrequencyAdverb,
  mapIntervalUnit
} from "../timing-lexicon";
import {
  BODY_SITE_FEATURE_SCORE_BONUS,
  DURATION_LEAD_TOKENS,
  EXTERNAL_SITE_LOCATIVE_PREFIXES,
  EYE_SITE_ABBREVIATIONS,
  NON_OCULAR_DOSE_UNITS,
  NON_SITE_ANCHORED_PHRASES,
  OCULAR_ROUTE_CODES,
  PRN_LEADS,
  PRN_STANDALONE_REASON_LEADS,
  SITE_ANCHORS,
  SITE_DISPLAY_FILLERS,
  SITE_ROUTE_HINTS_ALLOWED_IN_GRAMMAR,
  SITE_SELF_DISPLAY_ANCHORS
} from "../lexical-classes";
import { METHOD_ACTION_BY_VERB } from "../method-lexicon";
import {
  HpsgClauseContext,
  isAmPmLower,
  isClockLikeLower,
  isPunctuation,
  joinTokenText,
  lexicalRule,
  normalizeTokenLower,
  rangeFromTokens,
  tokensAvailable
} from "../rule-context";
import { HpsgLexicalRule, HpsgSign, lexicalSign } from "../signature";
import { productRouteHint } from "./product-route";

function siteBoundary(lower: string, context: HpsgClauseContext): boolean {
  const siteLike = Boolean(resolveBodySitePhrase(lower, context.options?.siteCodeMap, {
    bodySiteContext: context.options?.context?.bodySiteContext
  }));
  return (
    isPunctuation(lower) ||
    PRN_LEADS.has(lower) ||
    PRN_STANDALONE_REASON_LEADS.has(lower) ||
    DURATION_LEAD_TOKENS.has(lower) ||
    Boolean(
      METHOD_ACTION_BY_VERB[lower] ||
      (DEFAULT_ROUTE_SYNONYMS[lower] && !siteLike) ||
      productRouteHint(lower) ||
      normalizeUnit(lower, context.options) ||
      TIMING_ABBREVIATIONS[lower] ||
      WORD_FREQUENCIES[lower] ||
      FREQUENCY_SIMPLE_WORDS[lower] !== undefined ||
      FREQUENCY_NUMBER_WORDS[lower] !== undefined ||
      FREQUENCY_TIMES_WORDS.has(lower) ||
      EVENT_TIMING_TOKENS[lower] ||
      isClockLikeLower(lower) ||
      isAmPmLower(lower) ||
      EVERY_INTERVAL_TOKENS.has(lower) ||
      mapFrequencyAdverb(lower) ||
      mapIntervalUnit(lower)
    )
  );
}

function trimBraceRange(
  input: string,
  range: { start: number; end: number } | undefined
): { start: number; end: number } | undefined {
  if (!range) {
    return undefined;
  }
  let start = range.start;
  let end = range.end;
  while (start < end && /[\s{}]/.test(input[start] ?? "")) {
    start += 1;
  }
  while (end > start && /[\s{}]/.test(input[end - 1] ?? "")) {
    end -= 1;
  }
  return { start, end };
}

function shouldUseSiteRouteHint(sourceText: string, routeHint: RouteCode | undefined): routeHint is RouteCode {
  if (!routeHint || !SITE_ROUTE_HINTS_ALLOWED_IN_GRAMMAR.has(routeHint)) {
    return false;
  }
  const first = normalizeBodySiteKey(sourceText).split(" ")[0];
  return !EXTERNAL_SITE_LOCATIVE_PREFIXES.has(first);
}

function hasSystemicCueBeforeSiteAbbreviation(context: HpsgClauseContext, start: number): boolean {
  let sawNonOcularDose = false;
  for (let index = 0; index < start; index += 1) {
    const token = context.tokens[index];
    if (!token) {
      continue;
    }
    const route = getRouteMeaning(token);
    if (route) {
      if (OCULAR_ROUTE_CODES.has(route.code)) {
        return false;
      }
      return true;
    }
    const unit = normalizeUnit(normalizeTokenLower(token), context.options);
    if (unit && NON_OCULAR_DOSE_UNITS.has(unit)) {
      sawNonOcularDose = true;
    }
  }
  return sawNonOcularDose;
}

function contextSuggestsNonOcularSite(context: HpsgClauseContext): boolean {
  const dosageForm = context.options?.context?.dosageForm?.trim().toLowerCase().replace(/\s+/g, " ");
  const route = inferRouteFromContext(context.options?.context ?? undefined) ??
    (dosageForm ? productRouteHint(dosageForm) : undefined);
  return Boolean(route && !OCULAR_ROUTE_CODES.has(route));
}

function shouldSuppressEyeSiteAbbreviation(
  context: HpsgClauseContext,
  start: number,
  lower: string
): boolean {
  return EYE_SITE_ABBREVIATIONS.has(lower) && (
    hasSystemicCueBeforeSiteAbbreviation(context, start) ||
    contextSuggestsNonOcularSite(context)
  );
}

export function siteLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.site", (context, start) => {
    const token = tokensAvailable(context, start, 1)?.[0];
    if (!token) {
      return [];
    }
    const signs: HpsgSign[] = [];
    const lower = normalizeTokenLower(token);
    const siteCandidate = getPrimarySiteMeaningCandidate(token);
    const previous = context.tokens[start - 1];
    const previousRoutePhrase = previous && !context.state.consumed.has(previous.index)
      ? `${normalizeTokenLower(previous)} ${normalizeTokenLower(token)}`
      : undefined;
    if (
      siteCandidate &&
      !(previousRoutePhrase && DEFAULT_ROUTE_SYNONYMS[previousRoutePhrase]) &&
      !shouldSuppressEyeSiteAbbreviation(context, start, lower)
    ) {
      signs.push(
        lexicalSign({
          type: "site-sign",
          rule: "hpsg.lex.site.abbreviation",
          tokens: [token],
          synsem: {
            head: { route: siteCandidate.route ? { code: siteCandidate.route } : undefined },
            valence: { site: { text: siteCandidate.text, source: "abbreviation" } },
            cont: { clauseKind: "administration" }
          },
          siteTokenIndices: [token.index],
          score: 8
        })
      );
    }
    if (!SITE_ANCHORS.has(lower)) {
      return signs;
    }
    const firstAfterAnchor = context.tokens[start + 1];
    const secondAfterAnchor = context.tokens[start + 2];
    const firstAfterAnchorLower = firstAfterAnchor && !context.state.consumed.has(firstAfterAnchor.index)
      ? normalizeTokenLower(firstAfterAnchor)
      : undefined;
    const secondAfterAnchorLower = secondAfterAnchor && !context.state.consumed.has(secondAfterAnchor.index)
      ? normalizeTokenLower(secondAfterAnchor)
      : undefined;
    if (
      firstAfterAnchorLower &&
      (
        isClockLikeLower(firstAfterAnchorLower) ||
        (
          /^[0-9]{1,2}$/.test(firstAfterAnchorLower) &&
          Boolean(secondAfterAnchorLower && isAmPmLower(secondAfterAnchorLower))
        )
      )
    ) {
      return signs;
    }
    const phraseTokens: Token[] = [token];
    const displayTokens: Token[] = SITE_SELF_DISPLAY_ANCHORS.has(lower) ? [token] : [];
    for (let cursor = start + 1; cursor < context.limit; cursor += 1) {
      const candidate = context.tokens[cursor];
      if (!candidate || context.state.consumed.has(candidate.index)) {
        break;
      }
      const candidateLower = normalizeTokenLower(candidate);
      if (candidate.kind === LexKind.Number) {
        break;
      }
      if (getDayOfWeekMeaning(candidate)) {
        break;
      }
      if (siteBoundary(candidateLower, context)) {
        const next = context.tokens[cursor + 1];
        const nextLower = next && !context.state.consumed.has(next.index)
          ? normalizeTokenLower(next)
          : undefined;
        const continuedText = nextLower
          ? [...displayTokens, next].map((part) => part.original).join(" ")
          : "";
        if (
          !isPunctuation(candidateLower) ||
          !nextLower ||
          !resolveBodySitePhrase(continuedText, context.options?.siteCodeMap, {
            bodySiteContext: context.options?.context?.bodySiteContext
          })
        ) {
          break;
        }
        phraseTokens.push(candidate);
        cursor += 1;
        phraseTokens.push(next);
        displayTokens.push(next);
        continue;
      }
      phraseTokens.push(candidate);
      if (!SITE_DISPLAY_FILLERS.has(candidateLower)) {
        displayTokens.push(candidate);
      }
    }
    if (!displayTokens.length) {
      return signs;
    }
    const rawSourceText = displayTokens.map((part) => part.original).join(" ").replace(/\s+/g, " ").trim();
    const isProbe = rawSourceText.includes("{") || rawSourceText.includes("}");
    const sourceText = rawSourceText.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
    if (NON_SITE_ANCHORED_PHRASES.has(normalizeBodySiteKey(sourceText))) {
      return signs;
    }
    const resolved = resolveBodySitePhrase(sourceText, context.options?.siteCodeMap, {
      bodySiteContext: context.options?.context?.bodySiteContext
    });
    const abbreviationCandidate = displayTokens.length === 1
      ? getPrimarySiteMeaningCandidate(displayTokens[0])
      : undefined;
    const displayText = abbreviationCandidate?.text ?? resolved?.displayText ?? sourceText;
    const canonical = resolved?.resolutionCanonical ?? normalizeBodySiteKey(displayText);
    const rawRange = rangeFromTokens(displayTokens);
    let range = rawRange;
    if (isProbe && rawRange) {
      let start = rawRange.start;
      let end = rawRange.end;
      while (start < end && /[\s{]/.test(context.state.input[start] ?? "")) {
        start += 1;
      }
      while (end > start && /[\s}]/.test(context.state.input[end - 1] ?? "")) {
        end -= 1;
      }
      range = { start, end };
    }
    const routeHint = resolved?.definition?.routeHint ??
      DEFAULT_BODY_SITE_SNOMED[resolved?.canonical ?? ""]?.routeHint;
    const featureScore = resolved
      ? BODY_SITE_FEATURE_SCORE_BONUS.get(resolved.features.kind) ?? 0
      : 0;
    signs.push(
      lexicalSign({
        type: "site-sign",
        rule: "hpsg.lex.site.anchor",
        tokens: phraseTokens,
        synsem: {
          head: {
            route: abbreviationCandidate?.route
              ? { code: abbreviationCandidate.route }
              : shouldUseSiteRouteHint(sourceText, routeHint)
              ? { code: routeHint }
              : undefined
          },
          valence: {
            site: {
              text: displayText,
              source: "text",
              coding: resolved?.coding,
              spatialRelation: resolved?.spatialRelation,
              lookupRequest: {
                originalText: sourceText,
                text: sourceText,
                normalized: sourceText.toLowerCase(),
                canonical,
                isProbe,
                inputText: context.state.input,
                sourceText: range ? context.state.input.slice(range.start, range.end) : sourceText,
                range,
                spatialRelation: resolved?.spatialRelation
              }
            }
          },
          cont: { clauseKind: "administration" }
        },
        siteTokenIndices: displayTokens.map((part) => part.index),
        score: 10 + displayTokens.length + featureScore
      })
    );
    return signs;
  });
}

export function bareSiteLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.site.bare", (context, start) => {
    const signs: HpsgSign[] = [];
    const first = tokensAvailable(context, start, 1)?.[0];
    if (!first) {
      return [];
    }
    const firstLower = normalizeTokenLower(first);
    if (
      SITE_ANCHORS.has(firstLower) ||
      isPunctuation(firstLower) ||
      siteBoundary(firstLower, context)
    ) {
      return [];
    }
    const maxSpan = Math.min(5, context.limit - start);
    for (let span = maxSpan; span >= 1; span -= 1) {
      const tokens = tokensAvailable(context, start, span);
      if (!tokens) {
        continue;
      }
      const lowers = tokens.map((token) => normalizeTokenLower(token));
      if (lowers.some((lower) => !lower || siteBoundary(lower, context))) {
        continue;
      }
      const originalText = joinTokenText(tokens);
      const isProbe = originalText.includes("{") || originalText.includes("}");
      const rawRange = rangeFromTokens(tokens);
      const trimmedRange = trimBraceRange(context.state.input, rawRange);
      const sourceText = (
        trimmedRange
          ? context.state.input.slice(trimmedRange.start, trimmedRange.end)
          : originalText
      ).replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
      const resolved = resolveBodySitePhrase(sourceText, context.options?.siteCodeMap, {
        bodySiteContext: context.options?.context?.bodySiteContext
      });
      if (!resolved?.coding && !resolved?.definition) {
        continue;
      }
      const displayText = resolved.displayText ?? sourceText;
      const routeHint = resolved.definition?.routeHint;
      const featureScore = BODY_SITE_FEATURE_SCORE_BONUS.get(resolved.features.kind) ?? 0;
      signs.push(
        lexicalSign({
          type: "site-sign",
          rule: "hpsg.lex.site.bare",
          tokens,
          synsem: {
            head: {
              route: shouldUseSiteRouteHint(sourceText, routeHint)
                ? { code: routeHint }
                : undefined
            },
            valence: {
              site: {
                text: displayText,
                source: "text",
                coding: resolved.coding,
                spatialRelation: resolved.spatialRelation,
                lookupRequest: {
                  originalText,
                  text: sourceText,
                  normalized: sourceText.toLowerCase(),
                  canonical: resolved.resolutionCanonical ?? normalizeBodySiteKey(displayText),
                  isProbe,
                  inputText: context.state.input,
                  sourceText,
                  range: trimmedRange ?? rawRange,
                  spatialRelation: resolved.spatialRelation
                }
              }
            },
            cont: { clauseKind: "administration" }
          },
          siteTokenIndices: tokens.map((token) => token.index),
          score: 8 + span + featureScore
        })
      );
      break;
    }
    return signs;
  });
}
