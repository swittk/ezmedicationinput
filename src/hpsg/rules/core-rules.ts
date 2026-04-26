import {
  DEFAULT_BODY_SITE_SNOMED,
  DEFAULT_ROUTE_SYNONYMS,
  ROUTE_TEXT
} from "../../maps";
import {
  getRouteMeaning,
  hasTokenWordClass,
  isAdministrationVerbWord,
  TokenWordClass
} from "../../lexer/meaning";
import { LexKind } from "../../lexer/token-types";
import { Token } from "../../parser-state";
import { resolveBodySitePhrase } from "../../body-site-grammar";
import { RouteCode } from "../../types";
import { normalizeUnit } from "../../unit-lexicon";
import { buildTranslationPrimitiveElement } from "../../fhir-translations";
import { parseNumericRange } from "../timing-lexicon";
import {
  BODY_SITE_PARTITIVE_CONNECTORS,
  BODY_SITE_PARTITIVE_HEADS,
  CLOCK_LEAD_TOKENS,
  COMPOUND_DOSE_UNITS,
  CONNECTORS,
  LIST_SEPARATORS,
  MEDICATION_OBJECT_FILLERS,
  MILLION_DOSE_MULTIPLIER_TOKENS,
  PRODUCT_METHOD_TEXT,
  PRODUCT_METHOD_THAI,
  ROUTE_BLOCKED_BY_FOLLOWING_PARTITIVE_HEADS,
  ROUTE_SITE_PREPOSITIONS
} from "../lexical-classes";
import {
  cloneMethodCoding,
  METHOD_ACTION_BY_VERB,
  METHOD_CODING_BY_ACTION,
  MethodAction
} from "../method-lexicon";
import {
  HpsgClauseContext,
  isClockLikeLower,
  isPunctuation,
  joinTokenText,
  lexicalRule,
  normalizeTokenLower,
  tokensAvailable
} from "../rule-context";
import { HpsgLexicalRule, HpsgSign, emptySynsem, lexicalSign } from "../signature";
import { productRouteHint } from "./product-route";

export function methodLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.method", (context, start) => {
    const tokens = tokensAvailable(context, start, 1);
    const token = tokens?.[0];
    if (!tokens || !token) {
      return [];
    }
    const verb = normalizeTokenLower(token);
    if (
      !METHOD_ACTION_BY_VERB[verb] ||
      (
        !hasTokenWordClass(token, TokenWordClass.AdministrationVerb) &&
        !isAdministrationVerbWord(token.lower)
      )
    ) {
      return [];
    }
    const action = METHOD_ACTION_BY_VERB[verb];
    const route = getRouteMeaning(token) ?? (
      action === MethodAction.Apply
        ? { code: RouteCode["Topical route"], text: ROUTE_TEXT[RouteCode["Topical route"]] }
        : undefined
    );
    return [
      lexicalSign({
        type: "method-sign",
        rule: "hpsg.lex.method",
        tokens,
        synsem: {
          head: {
            method: {
              verb,
              coding: cloneMethodCoding(METHOD_CODING_BY_ACTION[action])
            },
            route: route ? { code: route.code, text: route.text } : undefined
          },
          valence: {},
          cont: { clauseKind: "administration" }
        },
        score: 10
      })
    ];
  });
}

export function routeLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.route", (context, start) => {
    const signs: HpsgSign[] = [];
    const maxSpan = Math.min(24, context.limit - start);
    for (let span = maxSpan; span >= 1; span -= 1) {
      const tokens = tokensAvailable(context, start, span);
      if (!tokens) {
        continue;
      }
      const phrase = tokens
        .map((token) => normalizeTokenLower(token))
        .filter((part) => !isPunctuation(part))
        .join(" ");
      if (!phrase) {
        continue;
      }
      if (routeTokenIsPartitiveSiteHead(context, start, span)) {
        continue;
      }
      const routeCandidates = routePhraseCandidates(phrase);
      const customCode = routeCandidates
        .map((candidate) => context.options?.routeMap?.[candidate])
        .find((code): code is RouteCode => Boolean(code));
      const tokenRoute = span === 1 ? getRouteMeaning(tokens[0]) : undefined;
      const routeFromSitePreposition = routeFromSitePrepositionPhrase(tokens, context);
      const synonym = routeCandidates
        .map((candidate) => DEFAULT_ROUTE_SYNONYMS[candidate])
        .find(Boolean);
      const route = customCode
        ? { code: customCode, text: ROUTE_TEXT[customCode] }
        : tokenRoute ?? synonym ?? routeFromSitePreposition;
      if (!route) {
        continue;
      }
      signs.push(
        lexicalSign({
          type: "route-sign",
          rule: "hpsg.lex.route",
          tokens,
          synsem: {
            head: {
              route: {
                code: route.code,
                text: route.text
              }
            },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: 8 + span
        })
      );
    }
    return signs;
  });
}

function routeTokenIsPartitiveSiteHead(
  context: HpsgClauseContext,
  start: number,
  span: number
): boolean {
  if (span !== 1) {
    return false;
  }
  const head = context.tokens[start];
  const connector = context.tokens[start + 1];
  const target = context.tokens[start + 2];
  if (!head || !connector || !target) {
    return false;
  }
  const headLower = normalizeTokenLower(head);
  if (
    !ROUTE_BLOCKED_BY_FOLLOWING_PARTITIVE_HEADS.has(headLower) ||
    !BODY_SITE_PARTITIVE_HEADS.has(headLower) ||
    !BODY_SITE_PARTITIVE_CONNECTORS.has(normalizeTokenLower(connector)) ||
    context.state.consumed.has(connector.index) ||
    context.state.consumed.has(target.index)
  ) {
    return false;
  }
  const maxEnd = Math.min(context.limit, start + 6);
  for (let end = start + 3; end <= maxEnd; end += 1) {
    const tokens = context.tokens.slice(start, end);
    if (tokens.some((token) => context.state.consumed.has(token.index))) {
      return false;
    }
    const resolved = resolveBodySitePhrase(joinTokenText(tokens), context.options?.siteCodeMap, {
      bodySiteContext: context.options?.context?.bodySiteContext
    });
    if (resolved?.features.kind === "partitive") {
      return true;
    }
  }
  return false;
}

function routeFromSitePrepositionPhrase(
  tokens: Token[],
  context: HpsgClauseContext
): { code: RouteCode; text?: string } | undefined {
  if (tokens.length < 2 || !ROUTE_SITE_PREPOSITIONS.has(normalizeTokenLower(tokens[0]))) {
    return undefined;
  }
  const siteText = tokens.slice(1).map((token) => token.original).join(" ");
  const resolved = resolveBodySitePhrase(siteText, context.options?.siteCodeMap, {
    bodySiteContext: context.options?.context?.bodySiteContext
  });
  const routeHint = resolved?.definition?.routeHint ??
    DEFAULT_BODY_SITE_SNOMED[resolved?.canonical ?? ""]?.routeHint;
  return routeHint ? { code: routeHint, text: ROUTE_TEXT[routeHint] } : undefined;
}

function routePhraseCandidates(phrase: string): string[] {
  const normalized = phrase.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }
  const withoutHyphen = normalized.replace(/-/g, " ");
  return Array.from(new Set([
    normalized,
    `${normalized}.`,
    withoutHyphen,
    `${withoutHyphen}.`
  ]));
}

export function fillerLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.filler.medicationObject", (context, start) => {
    const token = tokensAvailable(context, start, 1)?.[0];
    if (!token || !MEDICATION_OBJECT_FILLERS.has(normalizeTokenLower(token))) {
      return [];
    }
    return [
      lexicalSign({
        type: "connector-sign",
        rule: "hpsg.lex.filler.medicationObject",
        tokens: [token],
        synsem: emptySynsem(),
        score: 0
      })
    ];
  });
}

export function productLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.product", (context, start) => {
    const signs: HpsgSign[] = [];
    const maxSpan = Math.min(4, context.limit - start);
    for (let span = maxSpan; span >= 1; span -= 1) {
      const tokens = tokensAvailable(context, start, span);
      if (!tokens) {
        continue;
      }
      const phrase = tokens
        .map((token) => normalizeTokenLower(token))
        .filter((part) => !isPunctuation(part))
        .join(" ");
      if (!phrase) {
        continue;
      }
      const route = productRouteHint(phrase);
      if (!route) {
        continue;
      }
      const previous = context.tokens[start - 1];
      const previousVerb = previous && METHOD_ACTION_BY_VERB[normalizeTokenLower(previous)]
        ? normalizeTokenLower(previous)
        : undefined;
      const methodText = previousVerb ? PRODUCT_METHOD_TEXT[previousVerb]?.[phrase] : undefined;
      signs.push(
        lexicalSign({
          type: "phrase-sign",
          rule: "hpsg.lex.product",
          tokens,
          synsem: {
            head: {
              route: { code: route, text: ROUTE_TEXT[route] },
              method: methodText && previousVerb
                ? {
                  verb: previousVerb,
                  text: methodText,
                  textElement: PRODUCT_METHOD_THAI[methodText]
                    ? buildTranslationPrimitiveElement({ th: PRODUCT_METHOD_THAI[methodText] })
                    : undefined
                }
                : undefined
            },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: 9 + span + (methodText ? 4 : 0)
        })
      );
    }
    return signs;
  });
}

function unitAfter(context: HpsgClauseContext, start: number): { unit: string; tokens: Token[] } | undefined {
  const token = context.tokens[start];
  if (!token || context.state.consumed.has(token.index)) {
    return undefined;
  }
  const lower = normalizeTokenLower(token);
  const compound = COMPOUND_DOSE_UNITS.find((entry) => entry.head === lower);
  if (compound) {
    const next = context.tokens[start + 1];
    if (next && !context.state.consumed.has(next.index)) {
      const nextLower = normalizeTokenLower(next);
      if (compound.tails.indexOf(nextLower) !== -1) {
        return { unit: compound.unit, tokens: [token, next] };
      }
    }
  }
  const direct = normalizeUnit(lower, context.options);
  if (direct) {
    return { unit: direct, tokens: [token] };
  }
  return undefined;
}

export function doseLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.dose", (context, start) => {
    const tokens = tokensAvailable(context, start, 1);
    const token = tokens?.[0];
    if (!tokens || !token) {
      return [];
    }
    const lower = normalizeTokenLower(token);
    if (isClockDoseContext(context, start, lower)) {
      return [];
    }
    const range = parseNumericRange(lower);
    if (range) {
      const unit = unitAfter(context, start + 1);
      return [
        lexicalSign({
          type: "dose-sign",
          rule: "hpsg.lex.dose.range",
          tokens: unit ? [...tokens, ...unit.tokens] : tokens,
          synsem: {
            head: {
              dose: {
                range,
                unit: unit?.unit
              }
            },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: 8
        })
      ];
    }
    const millionMatch = lower.match(/^([0-9]+(?:\.[0-9]+)?)m$/);
    if (millionMatch) {
      const unit = unitAfter(context, start + 1);
      return [
        lexicalSign({
          type: "dose-sign",
          rule: "hpsg.lex.dose.million",
          tokens: unit ? [...tokens, ...unit.tokens] : tokens,
          synsem: {
            head: {
              dose: {
                value: parseFloat(millionMatch[1]) * 1_000_000,
                unit: unit?.unit
              }
            },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: unit ? 10 : 6
        })
      ];
    }
    if (token.kind !== LexKind.Number || token.value === undefined) {
      const timesMatch = lower.match(/^([0-9]+(?:\.[0-9]+)?)[x*]$/);
      if (!timesMatch) {
        return [];
      }
      return [
        lexicalSign({
          type: "dose-sign",
          rule: "hpsg.lex.dose.times",
          tokens,
          synsem: {
            head: { dose: { value: parseFloat(timesMatch[1]) } },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: 5
        })
      ];
    }
    const nextToken = context.tokens[start + 1];
    const nextLower = nextToken && !context.state.consumed.has(nextToken.index)
      ? normalizeTokenLower(nextToken)
      : undefined;
    if (nextLower && MILLION_DOSE_MULTIPLIER_TOKENS.has(nextLower)) {
      const unit = unitAfter(context, start + 2);
      return [
        lexicalSign({
          type: "dose-sign",
          rule: "hpsg.lex.dose.numericMillion",
          tokens: unit ? [token, nextToken, ...unit.tokens] : [token, nextToken],
          synsem: {
            head: {
              dose: {
                value: token.value * 1_000_000,
                unit: unit?.unit
              }
            },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: unit ? 10 : 6
        })
      ];
    }
    const unit = unitAfter(context, start + 1);
    return [
      lexicalSign({
        type: "dose-sign",
        rule: "hpsg.lex.dose.numeric",
        tokens: unit ? [...tokens, ...unit.tokens] : tokens,
        synsem: {
          head: {
            dose: {
              value: token.value,
              unit: unit?.unit
            }
          },
          valence: {},
          cont: { clauseKind: "administration" }
        },
        score: unit ? 8 : 3
      })
    ];
  });
}

function isClockDoseContext(context: HpsgClauseContext, start: number, lower: string): boolean {
  if (!isClockLikeLower(lower)) {
    return false;
  }
  const previous = context.tokens[start - 1];
  const previousLower = previous ? normalizeTokenLower(previous) : "";
  if (CLOCK_LEAD_TOKENS.has(previousLower)) {
    return true;
  }
  const separator = context.tokens[start + 1];
  const nextClock = context.tokens[start + 2];
  const separatorLower = separator ? normalizeTokenLower(separator) : "";
  const nextClockLower = nextClock ? normalizeTokenLower(nextClock) : "";
  return LIST_SEPARATORS.has(separatorLower) && isClockLikeLower(nextClockLower);
}

export function connectorLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.connector", (context, start) => {
    const token = tokensAvailable(context, start, 1)?.[0];
    if (!token) {
      return [];
    }
    const lower = normalizeTokenLower(token);
    if (!CONNECTORS.has(lower) && !isPunctuation(lower)) {
      return [];
    }
    return [
      lexicalSign({
        type: "connector-sign",
        rule: "hpsg.lex.connector",
        tokens: [token],
        synsem: emptySynsem(),
        score: 0
      })
    ];
  });
}
