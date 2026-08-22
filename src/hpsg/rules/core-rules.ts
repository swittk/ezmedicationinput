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
import { AdviceArgumentRole, AdviceFrame, AdvicePolarity, AdviceRelation, RouteCode } from "../../types";
import { normalizeUnit } from "../../unit-lexicon";
import { buildTranslationPrimitiveElement } from "../../fhir-translations";
import { resolveMedicationInstructionAction } from "../../instruction-action-terminology";
import { getProceduralFrames, sourceRangeAttachmentClass } from "../procedural-context";
import { FREQUENCY_TIMES_WORDS, parseNumericRange } from "../timing-lexicon";
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
  POSITIVE_DIRECTIVE_MARKERS,
  MEDICATION_OBJECT_FILLERS,
  MILLION_DOSE_MULTIPLIER_TOKENS,
  PERCENT_BODY_AREA_UNITS,
  RANGE_CONNECTORS,
  PRODUCT_FORM_MODIFIERS,
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

function methodProcedureFrames(context: HpsgClauseContext): AdviceFrame[] {
  return getProceduralFrames(context);
}

function looksLikeThaiGiveAuxiliary(context: HpsgClauseContext, start: number, verb: string): boolean {
  if (verb !== "give") return false;
  const token = context.tokens.slice(start, start + 1)[0];
  if (!token || !/[\u0E00-\u0E7F]/.test(token.original)) return false;
  const next = context.tokens[start + 1];
  if (!next) return false;
  return Boolean(resolveMedicationInstructionAction(normalizeTokenLower(next), context.options));
}

function looksLikeCoordinatedNoun(context: HpsgClauseContext, start: number, verb: string): boolean {
  if (verb !== "drink" && verb !== "use") return false;
  const previous = context.tokens[start - 1];
  const next = context.tokens[start + 1];
  const previousLower = previous ? normalizeTokenLower(previous) : "";
  const nextLower = next ? normalizeTokenLower(next) : "";
  if (verb === "use" && new Set(["each", "first", "every", "after", "before"]).has(previousLower)) {
    return true;
  }
  return previous?.original === "," && (next?.original === "," || nextLower === "or" || nextLower === "and");
}

function methodTokenBelongsToNonGlobalDirective(
  context: HpsgClauseContext,
  token: Token
): boolean {
  return methodProcedureFrames(context).some((frame) => {
    if (frame.span.start > token.sourceStart || token.sourceEnd > frame.span.end) return false;
    return frame.polarity === AdvicePolarity.Negate ||
      frame.predicate.lemma === "consult" ||
      frame.predicate.lemma === "stop" ||
      frame.predicate.semanticClass === "medical_advice";
  });
}

export function directiveMarkerLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.directiveMarker", (context, start) => {
    const available = tokensAvailable(context, start, 1);
    const marker = available?.slice(0, 1).pop();
    if (!available || !marker || !POSITIVE_DIRECTIVE_MARKERS.has(normalizeTokenLower(marker))) return [];
    const target = context.tokens[start + 1];
    if (!target || context.state.consumed.has(target.index)) return [];
    const targetLower = normalizeTokenLower(target);
    const definition = resolveMedicationInstructionAction(targetLower, context.options);
    if (!definition || definition.procedural || !METHOD_ACTION_BY_VERB[targetLower]) return [];
    return [lexicalSign({
      type: "connector-sign",
      rule: "hpsg.lex.directiveMarker",
      tokens: available,
      synsem: { head: {}, valence: {}, cont: { clauseKind: "administration" } },
      score: 6
    })];
  });
}

export function methodLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.method", (context, start) => {
    const tokens = tokensAvailable(context, start, 1);
    const token = tokens?.[0];
    if (!tokens || !token) {
      return [];
    }
    const verb = normalizeTokenLower(token);
    if (looksLikeThaiGiveAuxiliary(context, start, verb) || looksLikeCoordinatedNoun(context, start, verb)) {
      return [];
    }
    if (methodTokenBelongsToNonGlobalDirective(context, token)) return [];
    if (
      !METHOD_ACTION_BY_VERB[verb] ||
      (
        !hasTokenWordClass(token, TokenWordClass.AdministrationVerb) &&
        !isAdministrationVerbWord(verb)
      )
    ) {
      return [];
    }
    const action = METHOD_ACTION_BY_VERB[verb];
    const headClass = sourceRangeAttachmentClass(context, token.sourceStart, token.sourceEnd);
    const route = verb === "apply_patch"
      ? { code: RouteCode["Transdermal route"], text: ROUTE_TEXT[RouteCode["Transdermal route"]] }
      : action === MethodAction.Apply
        ? undefined
        : getRouteMeaning(token);
    return [
      lexicalSign({
        type: "method-sign",
        rule: "hpsg.lex.method",
        tokens,
        synsem: {
          head: {
            method: {
              verb,
              headClass,
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
      if (span === 1 && METHOD_ACTION_BY_VERB[phrase]) continue;
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
    if (!token) return [];
    const lower = normalizeTokenLower(token);
    const next = context.tokens[start + 1];
    const externalProductModifier = lower === "external" && next &&
      Boolean(productRouteHint(normalizeTokenLower(next)));
    if (!MEDICATION_OBJECT_FILLERS.has(lower) && !externalProductModifier) {
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
      const parts = tokens
        .map((token) => normalizeTokenLower(token))
        .filter((part) => !isPunctuation(part));
      const phrase = parts.join(" ");
      if (!phrase) continue;
      const semanticParts = parts.slice();
      while (semanticParts.length > 1 && PRODUCT_FORM_MODIFIERS.has(semanticParts[0])) semanticParts.shift();
      const productPhrase = semanticParts.join(" ");
      const route = productRouteHint(productPhrase);
      if (!route) {
        continue;
      }
      const previous = context.tokens[start - 1];
      const previousVerb = previous && METHOD_ACTION_BY_VERB[normalizeTokenLower(previous)]
        ? normalizeTokenLower(previous)
        : undefined;
      const methodText = previousVerb ? PRODUCT_METHOD_TEXT[previousVerb]?.[productPhrase] : undefined;
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
                  headClass: "administration",
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
  const MAX_SITE_CONTEXT_TOKENS = 3;
  const hasSiteMeaning = (lowerValue: string | undefined): boolean => Boolean(
    lowerValue &&
    (
      DEFAULT_BODY_SITE_SNOMED[normalizeBodySiteKey(lowerValue)] ||
      resolveBodySitePhrase(lowerValue, context.options?.siteCodeMap, {
        bodySiteContext: context.options?.context?.bodySiteContext
      })
    )
  );
  const collectForwardSitePhrases = (phraseStart: number): string[] => {
    const parts: string[] = [];
    const phrases: string[] = [];
    for (
      let index = phraseStart;
      index < context.limit && parts.length < MAX_SITE_CONTEXT_TOKENS;
      index += 1
    ) {
      const token = context.tokens[index];
      if (!token || context.state.consumed.has(token.index)) {
        break;
      }
      const lowerValue = normalizeTokenLower(token);
      if (!lowerValue || isPunctuation(lowerValue)) {
        break;
      }
      parts.push(lowerValue);
      phrases.push(parts.join(" "));
    }
    return phrases;
  };
  const matchesSiteContext = (): boolean => {
    const next = context.tokens[start + 1];
    const nextLower = next && !context.state.consumed.has(next.index)
      ? normalizeTokenLower(next)
      : undefined;
    if (
      nextLower &&
      (ROUTE_SITE_PREPOSITIONS.has(nextLower) || SITE_ANCHORS.has(nextLower))
    ) {
      const followingSitePhrases = collectForwardSitePhrases(start + 2);
      if (followingSitePhrases.some((phrase) => hasSiteMeaning(phrase))) {
        return true;
      }
    }

    const previous = context.tokens[start - 1];
    const previousLower = previous && !context.state.consumed.has(previous.index)
      ? normalizeTokenLower(previous)
      : undefined;
    const trailingNumberBeforeUnit = Boolean(
      previousLower && /^[0-9]+(?:\.[0-9]+)?$/.test(previousLower)
    );
    const siteEnd = start - (trailingNumberBeforeUnit ? 2 : 1);
    for (let phraseLength = 1; phraseLength <= MAX_SITE_CONTEXT_TOKENS; phraseLength += 1) {
      const phraseStart = siteEnd - phraseLength + 1;
      if (phraseStart < 0) {
        break;
      }
      const precedingAnchor = context.tokens[phraseStart - 1];
      const precedingAnchorLower = precedingAnchor && !context.state.consumed.has(precedingAnchor.index)
        ? normalizeTokenLower(precedingAnchor)
        : undefined;
      if (
        !precedingAnchorLower ||
        (!ROUTE_SITE_PREPOSITIONS.has(precedingAnchorLower) && !SITE_ANCHORS.has(precedingAnchorLower))
      ) {
        continue;
      }
      const phrase = collectForwardSitePhrases(phraseStart)[phraseLength - 1];
      if (hasSiteMeaning(phrase)) {
        return true;
      }
    }
    return false;
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

function numericTokenIsProcedureLocalQuantity(
  context: HpsgClauseContext,
  token: Token
): boolean {
  for (const frame of getProceduralFrames(context)) {
    if (token.sourceStart < frame.span.start || token.sourceEnd > frame.span.end) continue;
    const definition = resolveMedicationInstructionAction(frame.predicate.lemma, context.options);
    for (const arg of frame.args) {
      if (!arg.span || token.sourceStart < arg.span.start || token.sourceEnd > arg.span.end) continue;
      if (arg.role === AdviceArgumentRole.Duration) return true;
      if (arg.role === AdviceArgumentRole.Amount && !definition?.definesDose) return true;
    }
  }
  return false;
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
    if (token.kind === LexKind.Number && token.value !== undefined) {
      const connector = context.tokens[start + 1];
      const high = context.tokens[start + 2];
      const connectorLower = connector ? normalizeTokenLower(connector) : "";
      if (
        connector && RANGE_CONNECTORS.has(connectorLower) &&
        high?.kind === LexKind.Number && high.value !== undefined &&
        high.value >= token.value
      ) {
        const separatedUnit = unitAfter(context, start + 3);
        if (separatedUnit) {
          return [
            lexicalSign({
              type: "dose-sign",
              rule: "hpsg.lex.dose.separatedRange",
              tokens: [token, connector, high, ...separatedUnit.tokens],
              synsem: {
                head: {
                  dose: {
                    range: { low: token.value, high: high.value },
                    unit: separatedUnit.unit
                  }
                },
                valence: {},
                cont: { clauseKind: "administration" }
              },
              score: 12
            })
          ];
        }
      }
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
    if (numerator !== undefined && token.kind !== LexKind.Number) {
      const unit = unitAfter(context, start + 1);
      if (unit) {
        return [
          lexicalSign({
            type: "dose-sign",
            rule: "hpsg.lex.dose.numberWord",
            tokens: [token, ...unit.tokens],
            synsem: {
              head: { dose: { value: numerator, unit: unit.unit } },
              valence: {},
              cont: { clauseKind: "administration" }
            },
            score: 10
          })
        ];
      }
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
    if (token.kind === LexKind.Number && token.value !== undefined && numericTokenIsProcedureLocalQuantity(context, token)) {
      return [];
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
    const rangeHigh = context.tokens[start + 2];
    const rangeTimes = context.tokens[start + 3];
    if (
      nextLower && RANGE_CONNECTORS.has(nextLower) &&
      rangeHigh?.kind === LexKind.Number && rangeHigh.value !== undefined &&
      rangeTimes && FREQUENCY_TIMES_WORDS.has(normalizeTokenLower(rangeTimes))
    ) {
      return [];
    }
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
    if (!CONNECTORS.has(lower) && lower !== "via" && !isPunctuation(lower)) {
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
