import {
  DEFAULT_BODY_SITE_SNOMED,
  DEFAULT_ROUTE_SYNONYMS,
  normalizeBodySiteKey,
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
  DOSE_FRACTION_DENOMINATOR_WORDS,
  DOSE_FRACTION_WORDS,
  DOSE_NUMBER_WORDS,
  DOSE_UNIT_CONNECTORS,
  IMPLICIT_SINGLE_DOSE_UNITS,
  LIST_SEPARATORS,
  MEDICATION_OBJECT_FILLERS,
  MILLION_DOSE_MULTIPLIER_TOKENS,
  PERCENT_BODY_AREA_UNITS,
  PRODUCT_METHOD_TEXT,
  PRODUCT_METHOD_THAI,
  ROUTE_BLOCKED_BY_FOLLOWING_PARTITIVE_HEADS,
  ROUTE_SITE_PREPOSITIONS,
  SITE_ANCHORS
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

type UnitMatch = {
  unit: string;
  tokens: Token[];
};

function matchCompoundDoseUnit(
  context: HpsgClauseContext,
  start: number,
  lower: string
): UnitMatch | undefined {
  const hasSiteMeaning = (lowerValue: string | undefined): boolean => Boolean(
    lowerValue &&
    (
      DEFAULT_BODY_SITE_SNOMED[normalizeBodySiteKey(lowerValue)] ||
      resolveBodySitePhrase(lowerValue, context.options?.siteCodeMap, {
        bodySiteContext: context.options?.context?.bodySiteContext
      })
    )
  );
  const matchesSiteContext = (): boolean => {
    const next = context.tokens[start + 1];
    const followingSiteHead = context.tokens[start + 2];
    const nextLower = next && !context.state.consumed.has(next.index)
      ? normalizeTokenLower(next)
      : undefined;
    const followingSiteHeadLower = followingSiteHead && !context.state.consumed.has(followingSiteHead.index)
      ? normalizeTokenLower(followingSiteHead)
      : undefined;
    if (
      nextLower &&
      (ROUTE_SITE_PREPOSITIONS.has(nextLower) || SITE_ANCHORS.has(nextLower)) &&
      hasSiteMeaning(followingSiteHeadLower)
    ) {
      return true;
    }

    const previous = context.tokens[start - 1];
    const previousLower = previous && !context.state.consumed.has(previous.index)
      ? normalizeTokenLower(previous)
      : undefined;
    const precedingSiteHead = previousLower && /^[0-9]+(?:\.[0-9]+)?$/.test(previousLower)
      ? context.tokens[start - 2]
      : previous;
    const precedingAnchor = previousLower && /^[0-9]+(?:\.[0-9]+)?$/.test(previousLower)
      ? context.tokens[start - 3]
      : context.tokens[start - 2];
    const precedingSiteHeadLower = precedingSiteHead && !context.state.consumed.has(precedingSiteHead.index)
      ? normalizeTokenLower(precedingSiteHead)
      : undefined;
    const precedingAnchorLower = precedingAnchor && !context.state.consumed.has(precedingAnchor.index)
      ? normalizeTokenLower(precedingAnchor)
      : undefined;
    return Boolean(
      precedingAnchorLower &&
      (ROUTE_SITE_PREPOSITIONS.has(precedingAnchorLower) || SITE_ANCHORS.has(precedingAnchorLower)) &&
      hasSiteMeaning(precedingSiteHeadLower)
    );
  };
  for (const compound of COMPOUND_DOSE_UNITS) {
    if (compound.head !== lower) {
      continue;
    }
    const sequences = compound.tailSequences ?? [];
    for (const sequence of sequences) {
      const matchedTokens: Token[] = [];
      let matched = true;
      for (let offset = 0; offset < sequence.length; offset += 1) {
        const candidate = context.tokens[start + 1 + offset];
        if (
          !candidate ||
          context.state.consumed.has(candidate.index) ||
          normalizeTokenLower(candidate) !== sequence[offset]
        ) {
          matched = false;
          break;
        }
        matchedTokens.push(candidate);
      }
      if (matched) {
        const head = context.tokens[start];
        return head ? { unit: compound.unit, tokens: [head, ...matchedTokens] } : undefined;
      }
    }

    const next = context.tokens[start + 1];
    if (next && !context.state.consumed.has(next.index)) {
      const nextLower = normalizeTokenLower(next);
      if (compound.tails.indexOf(nextLower) !== -1) {
        const head = context.tokens[start];
        return head ? { unit: compound.unit, tokens: [head, next] } : undefined;
      }
    }

    if (compound.requiresSiteContext && matchesSiteContext()) {
      const head = context.tokens[start];
      return head ? { unit: compound.unit, tokens: [head] } : undefined;
    }
  }
  return undefined;
}

function unitAfter(context: HpsgClauseContext, start: number): UnitMatch | undefined {
  const token = context.tokens[start];
  if (!token || context.state.consumed.has(token.index)) {
    return undefined;
  }
  const lower = normalizeTokenLower(token);
  if (DOSE_UNIT_CONNECTORS.has(lower)) {
    const nested = unitAfter(context, start + 1);
    return nested ? { unit: nested.unit, tokens: [token, ...nested.tokens] } : undefined;
  }
  const compound = matchCompoundDoseUnit(context, start, lower);
  if (compound) {
    return compound;
  }
  const direct = normalizeUnit(lower, context.options);
  if (direct) {
    return { unit: direct, tokens: [token] };
  }
  return undefined;
}

function doseNumeratorValue(token: Token, lower: string): number | undefined {
  if (token.kind === LexKind.Number && token.value !== undefined) {
    return token.value;
  }
  return DOSE_NUMBER_WORDS.get(lower);
}

function percentBodyAreaDoseAfter(
  context: HpsgClauseContext,
  start: number,
  lower: string
): HpsgSign[] | undefined {
  const percentMatch = lower.match(/^([0-9]+(?:\.[0-9]+)?)%$/);
  if (!percentMatch) {
    return undefined;
  }
  const unitToken = context.tokens[start + 1];
  if (!unitToken || context.state.consumed.has(unitToken.index)) {
    return undefined;
  }
  const unit = PERCENT_BODY_AREA_UNITS.get(normalizeTokenLower(unitToken));
  if (!unit) {
    return undefined;
  }
  const token = context.tokens[start];
  if (!token) {
    return undefined;
  }
  return [
    lexicalSign({
      type: "dose-sign",
      rule: "hpsg.lex.dose.percentBodyArea",
      tokens: [token, unitToken],
      synsem: {
        head: {
          dose: {
            value: parseFloat(percentMatch[1]),
            unit
          }
        },
        valence: {},
        cont: { clauseKind: "administration" }
      },
      score: 10
    })
  ];
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
    const percentBodyAreaDose = percentBodyAreaDoseAfter(context, start, lower);
    if (percentBodyAreaDose) {
      return percentBodyAreaDose;
    }
    const numerator = doseNumeratorValue(token, lower);
    const denominatorToken = context.tokens[start + 1];
    const denominatorLower = denominatorToken && !context.state.consumed.has(denominatorToken.index)
      ? normalizeTokenLower(denominatorToken)
      : undefined;
    const denominator = denominatorLower
      ? DOSE_FRACTION_DENOMINATOR_WORDS.get(denominatorLower)
      : undefined;
    if (numerator !== undefined && denominatorToken && denominator !== undefined) {
      const unit = unitAfter(context, start + 2);
      return [
        lexicalSign({
          type: "dose-sign",
          rule: "hpsg.lex.dose.wordFractionNumerator",
          tokens: unit ? [token, denominatorToken, ...unit.tokens] : [token, denominatorToken],
          synsem: {
            head: {
              dose: {
                value: numerator * denominator,
                unit: unit?.unit
              }
            },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: unit ? 10 : 5
        })
      ];
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
    const wordFraction = DOSE_FRACTION_WORDS.get(lower);
    if (wordFraction !== undefined) {
      const unit = unitAfter(context, start + 1);
      return [
        lexicalSign({
          type: "dose-sign",
          rule: "hpsg.lex.dose.wordFraction",
          tokens: unit ? [...tokens, ...unit.tokens] : tokens,
          synsem: {
            head: {
              dose: {
                value: wordFraction,
                unit: unit?.unit
              }
            },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: unit ? 9 : 4
        })
      ];
    }
    const implicitUnit = unitAfter(context, start);
    if (implicitUnit && IMPLICIT_SINGLE_DOSE_UNITS.has(implicitUnit.unit)) {
      return [
        lexicalSign({
          type: "dose-sign",
          rule: "hpsg.lex.dose.implicitSingleUnit",
          tokens: implicitUnit.tokens,
          synsem: {
            head: {
              dose: {
                value: 1,
                unit: implicitUnit.unit
              }
            },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: 9
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
