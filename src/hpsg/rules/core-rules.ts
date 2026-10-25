import lexicalClasses from "../lexical-classes.json";
import { timingLexicalRule, timeOfDayRule } from "./timing-rules";
import {
  DEFAULT_BODY_SITE_SNOMED,
  DEFAULT_ROUTE_SYNONYMS,
  EVENT_TIMING_TOKENS,
  DEFAULT_UNIT_BY_ROUTE,
  normalizeBodySiteKey,
  ROUTE_TEXT
} from "../../maps";
import { getRouteMeaning } from "../../lexer/meaning";
import { parseAdditionalInstructions } from "../../advice";
import { LexKind } from "../../lexer/token-types";
import { Token } from "../../parser-state";
import { resolveBodySiteLexeme } from "../../body-site-grammar";
import { AdviceArgumentRole, AdvicePolarity, AdviceRelation, RouteCode, type ParseOptions } from "../../types";
import { normalizeUnit } from "../../unit-lexicon";
import { buildTranslationPrimitiveElement } from "../../fhir-translations";
import { resolveMedicationInstructionAction } from "../../instruction-action-terminology";
import { resolveMedicationInstructionConcept } from "../../instruction-concept-terminology";
import { getProceduralFrames, sourceRangeAttachmentClass, actionEventRelationAt } from "../procedural-context";
import {
  FREQUENCY_NUMBER_WORDS,
  FREQUENCY_TIMES_WORDS,
  mapIntervalUnit,
  parseNumericRange
} from "../timing-lexicon";
import {
  ACTION_COORDINATION_CONNECTORS,
  ACTION_DIRECTIVE_PREFIXES,
  BODY_SITE_PARTITIVE_CONNECTORS,
  BODY_SITE_PARTITIVE_HEADS,
  CLOCK_LEAD_TOKENS,
  COMPOUND_DOSE_UNITS,
  CONNECTORS,
  COORDINATED_NOUN_METHOD_VERBS,
  COUNT_CONNECTOR_WORDS_DATA,
  SUPPLEMENTAL_DOSE_MODIFIERS,
  DOSE_ADDITIVE_QUANTITY_CONNECTORS,
  DOSE_FRACTION_ARTICLES,
  DOSE_FRACTION_DENOMINATOR_WORDS,
  DOSE_FRACTION_WORDS,
  DOSE_TARGET_SLOT_HEADS,
  DOSE_NUMBER_WORDS,
  DOSE_UNIT_CONNECTORS,
  IMPLICIT_SINGLE_DOSE_UNITS,
  QUALITATIVE_DOSE_MODIFIERS,
  QUALITATIVE_DOSE_UNITS,
  FREQUENCY_ALTERNATIVE_CONNECTORS,
  LIST_SEPARATORS,
  METHOD_NOUN_LEFT_CONTEXT,
  POSITIVE_DIRECTIVE_MARKERS,
  MEDICATION_OBJECT_FILLERS,
  PHASE_ADJUSTMENT_LEAD_SEQUENCES,
  PHASE_ADDITION_LEAD_SEQUENCES,
  MILLION_DOSE_MULTIPLIER_TOKENS,
  PERCENT_BODY_AREA_UNITS,
  RANGE_CONNECTORS,
  PRODUCT_EXTERNAL_MODIFIERS,
  PRODUCT_FORM_MODIFIERS,
  PRODUCT_SOURCE_PREPOSITIONS,
  methodAuxiliaryVerbsForLocale,
  productMethodRealizations,
  coordinationConnectorKind,
  ROUTE_BLOCKED_BY_FOLLOWING_PARTITIVE_HEADS,
  ROUTE_SITE_PREPOSITIONS,
  SITE_ANCHORS,
  SITE_FILLERS
} from "../lexical-classes";
import {
  cloneMethodCoding,
  isMedicationAdministrationMethod,
  resolveMedicationAdministrationMethod
} from "../method-lexicon";
import {
  HpsgClauseContext,
  sourceRangeOverlapsContextDate,
  isClockLikeLower,
  isPunctuation,
  joinTokenText,
  lexicalRule,
  normalizeTokenLower,
  rangeFromTokens,
  tokensAvailable
} from "../rule-context";
import { HpsgLexicalRule, HpsgSign, emptySynsem, lexicalSign } from "../signature";
import { clinicalQuantityLexicalRule } from "./clinical-quantity-rules";
import { productRouteHint } from "./product-route";
import { baseLanguageTag } from "../../localization";
import { inferMedicationLocale } from "../../locale-detection";

function looksLikeLocaleMethodAuxiliary(context: HpsgClauseContext, start: number, verb: string): boolean {
  const token = context.tokens.slice(start, start + 1)[0];
  if (!token) return false;
  const locale = baseLanguageTag(context.options?.locale) ?? inferMedicationLocale(token.original, "en");
  if (!methodAuxiliaryVerbsForLocale(locale).has(verb)) return false;
  const next = context.tokens[start + 1];
  if (!next) return false;
  return Boolean(resolveMedicationInstructionAction(normalizeTokenLower(next), context.options));
}

function looksLikeCoordinatedNoun(context: HpsgClauseContext, start: number, verb: string): boolean {
  if (!COORDINATED_NOUN_METHOD_VERBS.has(verb)) return false;
  const previous = context.tokens[start - 1];
  const next = context.tokens[start + 1];
  const previousLower = previous ? normalizeTokenLower(previous) : "";
  const nextLower = next ? normalizeTokenLower(next) : "";
  if (METHOD_NOUN_LEFT_CONTEXT.get(verb)?.has(previousLower)) {
    return true;
  }
  return previous?.original === "," && (
    next?.original === "," || ACTION_COORDINATION_CONNECTORS.has(nextLower)
  );
}

function methodTokenBelongsToNegatedDirective(
  context: HpsgClauseContext,
  item: Token
): boolean {
  return getProceduralFrames(context).some((frame) =>
    frame.polarity === AdvicePolarity.Negate &&
    frame.span.start <= item.sourceStart &&
    item.sourceEnd <= frame.span.end
  );
}

const PHASE_ADJUSTMENTS_BY_FIRST = new Map<string, Array<{
  kind: "replace" | "add"; parts: readonly string[];
}>>();
for (const inventory of [
  { kind: "replace" as const, sequences: PHASE_ADJUSTMENT_LEAD_SEQUENCES },
  { kind: "add" as const, sequences: PHASE_ADDITION_LEAD_SEQUENCES }
]) {
  for (const parts of inventory.sequences) {
    const bucket = PHASE_ADJUSTMENTS_BY_FIRST.get(parts[0]) ?? [];
    bucket.push({ kind: inventory.kind, parts });
    PHASE_ADJUSTMENTS_BY_FIRST.set(parts[0], bucket);
  }
}

/** Bounded lexical recognition shared by chart and boundary candidacy.
 * @param tokens Source tokens with the existing locale normalization.
 * @param start Candidate head index; never searches arbitrary later text.
 * @param limit Exclusive end of the current constituent.
 */
export function phaseAdjustmentAt(tokens: readonly Token[], start: number, limit = tokens.length) {
  const first = tokens[start];
  if (!first || start >= limit) return undefined;
  const candidates = PHASE_ADJUSTMENTS_BY_FIRST.get(normalizeTokenLower(first));
  if (!candidates) return undefined;
  // A transitive adjustment may select a nominal dose or a temporal target,
  // with or without an explicit restrictor. Its clock and target amount must
  // still be independent typed daughters of the registered verb/linker.
  const negated = ACTION_DIRECTIVE_PREFIXES.some(prefix =>
    prefix.polarity === AdvicePolarity.Negate && start >= prefix.parts.length &&
    prefix.parts.every((part, index) =>
      normalizeTokenLower(tokens[start - prefix.parts.length + index]) === part));
  if (negated) return undefined;
  for (const candidate of candidates) {
    if (candidate.kind !== "replace" || candidate.parts.length < 2) continue;
    // The registered verb selects its own target-amount linker. Its target
    // can be a nominal dose (the 20:00 dose) or an explicit time (at 20:00).
    // Both are typed clock arguments; neither licenses arbitrary text targets.
    const headLength = candidate.parts.length - 1;
    if (!candidate.parts.every((part, index) => index === headLength ||
        tokens[start + index] && normalizeTokenLower(tokens[start + index]) === part)) continue;
    let targetIndex = start + headLength;
    if (tokens[targetIndex] && lexicalClasses.phaseTargetRestrictors.indexOf(
      normalizeTokenLower(tokens[targetIndex])) >= 0) targetIndex++;
    const lead = tokens[targetIndex] && normalizeTokenLower(tokens[targetIndex]);
    const nominal = lead && lexicalClasses.phaseTargetDeterminers.indexOf(lead) >= 0;
    const temporal = lead && CLOCK_LEAD_TOKENS.has(lead);
    const doseSlot = lead && DOSE_TARGET_SLOT_HEADS.has(lead);
    const prefixedTarget = nominal || temporal || doseSlot;
    const targetStart = targetIndex + (prefixedTarget ? 1 : 0);
    const event = tokens[targetStart] && EVENT_TIMING_TOKENS[normalizeTokenLower(tokens[targetStart])];
    if (tokens[targetStart]?.kind !== LexKind.TimeLike && !event) continue;
    let linkerIndex = targetStart + 1;
    const noun = tokens[linkerIndex] && lexicalClasses.phaseDoseNouns.indexOf(
      normalizeTokenLower(tokens[linkerIndex])) >= 0;
    if ((nominal || !prefixedTarget) && !noun) continue;
    if (noun) linkerIndex++;
    const linker = tokens[linkerIndex] && normalizeTokenLower(tokens[linkerIndex]);
    if (!linker || lexicalClasses.phaseTargetLinkers.indexOf(linker) < 0 ||
        linker !== candidate.parts[headLength] || linkerIndex + 1 >= limit ||
        explicitDoseLexicalEnd(tokens, linkerIndex + 1, undefined, limit) === undefined) continue;
    return { kind: "replace-target" as const, end: linkerIndex + 1, targetStart };
  }
  for (const { kind, parts } of candidates) {
    if (start + parts.length >= limit) continue;
    if (parts.every((part, index) => tokens[start + index] &&
      normalizeTokenLower(tokens[start + index]) === part)) {
      // A supplemental modifier belongs to the dose NP (another half tablet),
      // not to both the ADD operator and its amount daughter. The lexical head
      // may select that modifier without consuming overlapping source spans.
      const supplemental = kind === "add" && parts.length > 1 &&
        SUPPLEMENTAL_DOSE_MODIFIERS.has(parts[parts.length - 1]);
      return { kind, end: start + parts.length - (supplemental ? 1 : 0) };
    }
  }
  return undefined;
}

/** A typed ADD/REPLACE operator composes with ordinary dose/time daughters. */
export function phaseAdjustmentLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.regimen.phaseAdjustment", (context, start) => {
    const match = phaseAdjustmentAt(context.tokens, start, context.limit);
    if (!match) return [];
    const tokens = tokensAvailable(context, start, match.end - start);
    if (!tokens) return [];
    if (match.kind === "replace-target") {
      const targetRule = context.tokens[match.targetStart].kind === LexKind.TimeLike
        ? timeOfDayRule() : timingLexicalRule();
      const target = targetRule.match(context, match.targetStart).find(item =>
        (item.synsem.head.schedule?.timeOfDay?.length ?? 0) +
        (item.synsem.head.schedule?.when?.length ?? 0) === 1);
      if (!target) return [];
      return [lexicalSign({
        type: "adjustment-sign",
        rule: "hpsg.lex.regimen.targeted-phase-adjustment",
        tokens,
        synsem: { head: { schedule: target.synsem.head.schedule }, valence: {},
          cont: { regimenAdjustment: "replace-target" } },
        score: 25 + tokens.length
      })];
    }
    if (match.kind === "add") {
      let cursor = match.end;
      if (context.tokens[cursor] && DOSE_FRACTION_ARTICLES.has(normalizeTokenLower(context.tokens[cursor]))) cursor++;
      const time = context.tokens[cursor];
      if (time) {
        const rule = time.kind === LexKind.TimeLike ? timeOfDayRule() : timingLexicalRule();
        for (const timing of rule.match(context, cursor)) {
          const noun = context.tokens[cursor + timing.tokens.length];
          if (!noun || lexicalClasses.phaseDoseNouns.indexOf(normalizeTokenLower(noun)) < 0) continue;
          const members = tokensAvailable(context, start, cursor + timing.tokens.length + 1 - start);
          if (!members) continue;
          return [lexicalSign({
            type: "adjustment-sign", rule: "hpsg.lex.regimen.ellipticDoseAddition", tokens: members,
            synsem: { head: { schedule: timing.synsem.head.schedule }, valence: {},
              cont: { regimenAdjustment: "add" } },
            score: 25 + members.length
          })];
        }
      }
    }
    return [lexicalSign({
      type: "adjustment-sign",
      rule: "hpsg.lex.regimen.phaseAdjustment",
      tokens,
      synsem: {
        head: {}, valence: {},
        cont: { regimenAdjustment: match.kind }
      },
      score: 8 + tokens.length
    })];
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
    if (!definition || definition.procedural || !definition.administrationMethod?.code) return [];
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
    if (methodTokenBelongsToNegatedDirective(context, token)) return [];
    if (looksLikeLocaleMethodAuxiliary(context, start, verb) || looksLikeCoordinatedNoun(context, start, verb)) {
      return [];
    }
    const methodDefinition = resolveMedicationAdministrationMethod(verb, context.options);
    if (!methodDefinition) return [];
    const headClass = sourceRangeAttachmentClass(context, token.sourceStart, token.sourceEnd);
    const routeOverride = methodDefinition.methodRouteOverride;
    const verbRouteHint = methodDefinition.verbRouteHint;
    const route = routeOverride
      ? { code: routeOverride, text: ROUTE_TEXT[routeOverride] }
      : methodDefinition.suppressMethodRouteHint
        ? undefined
        : verbRouteHint
          ? { code: verbRouteHint, text: ROUTE_TEXT[verbRouteHint] }
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
              coding: cloneMethodCoding(methodDefinition.administrationMethod)
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

function routeTokenIsTemporalPrepositionBeforeTiming(
  context: HpsgClauseContext,
  start: number,
  span: number
): boolean {
  if (span !== 1) return false;
  const token = context.tokens[start];
  if (!token || !SITE_ANCHORS.has(normalizeTokenLower(token))) return false;
  const intervalValue = context.tokens[start + 1];
  const intervalUnit = context.tokens[start + 2];
  const intervalCardinal = intervalValue?.kind === LexKind.Number
    ? intervalValue.value
    : intervalValue ? FREQUENCY_NUMBER_WORDS[normalizeTokenLower(intervalValue)] : undefined;
  if (intervalCardinal !== undefined && intervalCardinal >= 0 &&
      intervalUnit && mapIntervalUnit(normalizeTokenLower(intervalUnit))) {
    return true;
  }
  let cursor = start + 1;
  while (cursor < context.limit) {
    const candidate = context.tokens[cursor];
    if (!candidate || context.state.consumed.has(candidate.index)) return false;
    const lower = normalizeTokenLower(candidate);
    if (SITE_FILLERS.has(lower)) {
      cursor += 1;
      continue;
    }
    return Boolean(EVENT_TIMING_TOKENS[lower]);
  }
  return false;
}

function routeTokenIsSitePrepositionBeforeResolvableSite(
  context: HpsgClauseContext,
  start: number,
  span: number
): boolean {
  if (span !== 1) return false;
  const token = context.tokens[start];
  if (!token || !SITE_ANCHORS.has(normalizeTokenLower(token))) return false;
  const maxEnd = Math.min(context.limit, start + 7);
  for (let end = start + 2; end <= maxEnd; end += 1) {
    const following = context.tokens.slice(start + 1, end);
    if (!following.length || following.some((candidate) => context.state.consumed.has(candidate.index))) {
      continue;
    }
    const siteText = following
      .filter((candidate) => !SITE_FILLERS.has(normalizeTokenLower(candidate)))
      .map((candidate) => candidate.original)
      .join(" ")
      .trim();
    if (!siteText) continue;
    const resolved = resolveBodySiteLexeme(siteText, context.options?.siteCodeMap, {
      bodySiteContext: context.options?.context?.bodySiteContext
    });
    if (resolved?.coding || resolved?.definition) return true;
  }
  return false;
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
      if (span === 1 && isMedicationAdministrationMethod(phrase, context.options)) continue;
      if (
        routeTokenIsPartitiveSiteHead(context, start, span) ||
        routeTokenIsSitePrepositionBeforeResolvableSite(context, start, span) ||
        routeTokenIsTemporalPrepositionBeforeTiming(context, start, span)
      ) {
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
    const resolved = resolveBodySiteLexeme(joinTokenText(tokens), context.options?.siteCodeMap, {
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
  const resolved = resolveBodySiteLexeme(siteText, context.options?.siteCodeMap, {
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
    const externalProductModifier = PRODUCT_EXTERNAL_MODIFIERS.has(lower) && next &&
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
    // Nullable complements at an instruction boundary are not lexical signs.
    // Matchers must be total when a preceding determiner consumed the last
    // token; never dereference a hypothetical product beyond the chart limit.
    if (start < 0 || start >= context.limit || !context.tokens[start]) return signs;
    const maxSpan = Math.min(4, context.limit - start);
    // Only a product-like leading word needs nominal-compound arbitration.
    // The exact registered constituent (e.g. an administration-site noun)
    // owns its words before a shorter product reading can infer a route.
    const leadingProduct = productRouteHint(normalizeTokenLower(context.tokens[start]));
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
        if (leadingProduct && span > 1 &&
            resolveMedicationInstructionConcept(phrase, context.options)) return signs;
        continue;
      }
      const previous = context.tokens[start - 1];
      const previousVerb = previous && isMedicationAdministrationMethod(
        normalizeTokenLower(previous), context.options
      ) ? normalizeTokenLower(previous) : undefined;
      const methodRealizations = previousVerb ? productMethodRealizations(previousVerb, productPhrase) : undefined;
      const methodText = methodRealizations?.en;
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
                  textElement: methodRealizations
                    ? (() => {
                        const translations: Record<string, string> = {};
                        for (const locale of Object.keys(methodRealizations)) {
                          const value = methodRealizations[locale];
                          if (locale !== "en" && value) translations[locale] = value;
                        }
                        return Object.keys(translations).length
                          ? buildTranslationPrimitiveElement(translations)
                          : undefined;
                      })()
                    : undefined
                }
                : undefined
            },
            // A source-device/product PP is not merely a route hint. Keep
            // its source-backed qualifier in the existing patient direction
            // feature so strict FHIR and human realization cannot erase it.
            valence: previous && PRODUCT_SOURCE_PREPOSITIONS.has(normalizeTokenLower(previous))
              ? { patientInstruction: { text: joinTokenText([previous, ...tokens]) } }
              : {},
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
      resolveBodySiteLexeme(lowerValue, context.options?.siteCodeMap, {
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
  const matchesProductContext = (): boolean => {
    let cursor = start + 1;
    while (cursor < context.limit) {
      const candidate = context.tokens[cursor];
      if (!candidate || context.state.consumed.has(candidate.index)) return false;
      const candidateLower = normalizeTokenLower(candidate);
      if (DOSE_UNIT_CONNECTORS.has(candidateLower)) {
        cursor += 1;
        continue;
      }
      return Boolean(productRouteHint(candidateLower));
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

    if (
      (compound.requiresSiteContext && matchesSiteContext()) ||
      (compound.requiresProductContext && matchesProductContext())
    ) {
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

interface SupplementalDosePrefix {
  quantityStart: number;
  unitStart?: number;
}

/** Maximal source prefix for a supplemental scalar dose NP. */
function supplementalDosePrefixAt(
  tokens: readonly Token[],
  start: number,
  limit: number
): SupplementalDosePrefix | undefined {
  const first = tokens[start];
  if (!first || start < 0 || start >= limit) return undefined;
  const afterQuantity = tokens[start + 1];
  if (!DOSE_FRACTION_ARTICLES.has(normalizeTokenLower(first)) &&
      doseNumeratorValue(first, normalizeTokenLower(first)) !== undefined &&
      start + 1 < limit && afterQuantity &&
      SUPPLEMENTAL_DOSE_MODIFIERS.has(normalizeTokenLower(afterQuantity))) {
    return { quantityStart: start, unitStart: start + 2 };
  }
  let modifierIndex = start;
  if (DOSE_FRACTION_ARTICLES.has(normalizeTokenLower(first))) modifierIndex += 1;
  const modifier = tokens[modifierIndex];
  if (!modifier || modifierIndex >= limit ||
      !SUPPLEMENTAL_DOSE_MODIFIERS.has(normalizeTokenLower(modifier))) return undefined;
  // `an extra ...` is one maximal daughter; do not also license a shorter
  // daughter beginning at `extra`, which would strand its article.
  if (modifierIndex === start) {
    const previous = tokens[start - 1];
    if (previous && DOSE_FRACTION_ARTICLES.has(normalizeTokenLower(previous))) return undefined;
  }
  return { quantityStart: modifierIndex + 1 };
}

function quantityHasSupplementalPrefix(tokens: readonly Token[], start: number): boolean {
  const modifier = tokens[start - 1];
  return Boolean(modifier && SUPPLEMENTAL_DOSE_MODIFIERS.has(normalizeTokenLower(modifier)));
}

function supplementalDoseAfter(
  context: HpsgClauseContext,
  start: number
): HpsgSign | undefined {
  const prefix = supplementalDosePrefixAt(context.tokens, start, context.limit);
  if (!prefix) return undefined;
  const quantityToken = context.tokens[prefix.quantityStart];
  if (!quantityToken || context.state.consumed.has(quantityToken.index)) return undefined;
  const quantityLower = normalizeTokenLower(quantityToken);
  if (isClockDoseContext(context, prefix.quantityStart, quantityLower) ||
      numericTokenIsProcedureLocalQuantity(context, quantityToken) ||
      sourceRangeOverlapsContextDate(context, quantityToken.sourceStart, quantityToken.sourceEnd)) {
    return undefined;
  }

  let value = DOSE_FRACTION_WORDS.get(quantityLower);
  let unitStart = prefix.unitStart ?? prefix.quantityStart + 1;
  if (value === undefined) {
    const numerator = doseNumeratorValue(quantityToken, quantityLower);
    if (numerator === undefined) return undefined;
    const denominatorToken = context.tokens[unitStart];
    const denominator = denominatorToken && !context.state.consumed.has(denominatorToken.index)
      ? DOSE_FRACTION_DENOMINATOR_WORDS.get(normalizeTokenLower(denominatorToken))
      : undefined;
    value = denominator === undefined ? numerator : numerator * denominator;
    if (denominator !== undefined) unitStart += 1;
  }
  const unit = unitAfter(context, unitStart);
  if (!unit) return undefined;
  const end = unitStart + unit.tokens.length;
  const tokens = tokensAvailable(context, start, end - start);
  if (!tokens) return undefined;
  return lexicalSign({
    type: "dose-sign",
    rule: "hpsg.lex.dose.supplementalQuantity",
    tokens,
    synsem: {
      head: { dose: { value, unit: unit.unit } },
      valence: {},
      cont: { clauseKind: "administration" }
    },
    score: 14 + tokens.length
  });
}

function explicitScalarDoseLexicalEnd(
  tokens: readonly Token[],
  start: number,
  options: ParseOptions | undefined,
  limit: number
): number | undefined {
  const token = tokens[start];
  if (!token || start < 0 || start >= limit) return undefined;
  const lower = normalizeTokenLower(token).replace(/^[.,;:]+|[.,;:]+$/gu, "");
  const fraction = DOSE_FRACTION_WORDS.has(lower);
  const numeratorValue = doseNumeratorValue(token, lower);
  const numerator = numeratorValue !== undefined;
  if (!fraction && !numerator && token.kind !== LexKind.NumberRange) return undefined;

  for (let wholeIndex = Math.max(0, start - 4); wholeIndex + 1 < start; wholeIndex += 1) {
    const whole = tokens[wholeIndex];
    const connector = tokens[wholeIndex + 1];
    const wholeValue = doseNumeratorValue(whole, normalizeTokenLower(whole));
    if (wholeValue === undefined || !Number.isInteger(wholeValue) || wholeValue <= 0 ||
        !DOSE_ADDITIVE_QUANTITY_CONNECTORS.has(normalizeTokenLower(connector))) continue;
    let withinAdditiveFraction = true;
    for (let index = wholeIndex + 2; index < start; index += 1) {
      const candidate = tokens[index];
      const candidateLower = normalizeTokenLower(candidate);
      if (!DOSE_FRACTION_ARTICLES.has(candidateLower) &&
          !DOSE_FRACTION_WORDS.has(candidateLower) &&
          !DOSE_FRACTION_DENOMINATOR_WORDS.has(candidateLower) &&
          doseNumeratorValue(candidate, candidateLower) === undefined) {
        withinAdditiveFraction = false;
        break;
      }
    }
    if (withinAdditiveFraction) return undefined;
  }
  const previous = tokens[start - 1];
  const previousLower = previous
    ? normalizeTokenLower(previous).replace(/^[.,;:]+|[.,;:]+$/gu, "")
    : "";
  if (DOSE_FRACTION_ARTICLES.has(lower) && DOSE_FRACTION_WORDS.has(previousLower)) {
    return undefined;
  }

  let cursor = start + 1;
  if (tokens[cursor] && cursor < limit &&
      SUPPLEMENTAL_DOSE_MODIFIERS.has(normalizeTokenLower(tokens[cursor]))) cursor++;
  const additiveConnector = tokens[cursor];
  if (numeratorValue !== undefined && Number.isInteger(numeratorValue) && numeratorValue > 0 &&
      additiveConnector && DOSE_ADDITIVE_QUANTITY_CONNECTORS.has(
        normalizeTokenLower(additiveConnector)
      )) {
    cursor += 1;
    if (cursor < limit && DOSE_FRACTION_ARTICLES.has(normalizeTokenLower(tokens[cursor]))) {
      cursor += 1;
    }
    const additiveFraction = tokens[cursor];
    const additiveLower = additiveFraction ? normalizeTokenLower(additiveFraction) : "";
    if (DOSE_FRACTION_WORDS.has(additiveLower)) {
      cursor += 1;
    } else {
      const denominator = tokens[cursor + 1];
      if (!additiveFraction || doseNumeratorValue(additiveFraction, additiveLower) === undefined ||
          !denominator || !DOSE_FRACTION_DENOMINATOR_WORDS.has(normalizeTokenLower(denominator))) {
        return undefined;
      }
      cursor += 2;
    }
  } else if (numerator && cursor < limit) {
    const denominator = tokens[cursor];
    const denominatorLower = denominator
      ? normalizeTokenLower(denominator).replace(/^[.,;:]+|[.,;:]+$/gu, "")
      : "";
    if (DOSE_FRACTION_DENOMINATOR_WORDS.has(denominatorLower)) cursor += 1;
  }
  while (cursor < limit) {
    const connector = tokens[cursor];
    const connectorLower = connector
      ? normalizeTokenLower(connector).replace(/^[.,;:]+|[.,;:]+$/gu, "")
      : "";
    if (!DOSE_UNIT_CONNECTORS.has(connectorLower)) break;
    cursor += 1;
  }
  if (cursor >= limit) return undefined;
  const unitToken = tokens[cursor];
  const unitLower = normalizeTokenLower(unitToken).replace(/^[.,;:]+|[.,;:]+$/gu, "");
  return normalizeUnit(unitLower, options) ? cursor + 1 : undefined;
}

/**
 * Return the end of a bounded, explicit scalar-dose head for regimen boundary
 * candidacy. This uses the same HPSG quantity lexemes as `doseLexicalRule`;
 * it does not assign a dose or authorize a split. The boundary grammar still
 * has to parse complete typed daughters before accepting the candidate.
 *
 * Keeping the optional fraction article inside this constituent is important:
 * in `half a tablet`, `a` is a determiner of the unit, not a second one-tablet
 * dose head.
 */
export function explicitDoseLexicalEnd(
  tokens: readonly Token[],
  start: number,
  options?: ParseOptions,
  limit = tokens.length
): number | undefined {
  const prefix = supplementalDosePrefixAt(tokens, start, limit);
  if (prefix) return explicitScalarDoseLexicalEnd(tokens, prefix.quantityStart, options, limit);
  if (quantityHasSupplementalPrefix(tokens, start)) return undefined;
  return explicitScalarDoseLexicalEnd(tokens, start, options, limit);
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
      if (arg.role === AdviceArgumentRole.Amount && (!definition?.definesDose ||
          frame.args.some(complement => complement.role === AdviceArgumentRole.Time &&
            complement.conceptId === "after-first-administration"))) return true;
    }
  }
  return false;
}

export function perTargetCountDoseRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.dose.perTargetCount", (context, start) => {
    const valueToken = context.tokens[start];
    const countToken = context.tokens[start + 1];
    if (
      !valueToken || valueToken.kind !== LexKind.Number || valueToken.value === undefined ||
      !countToken || context.state.consumed.has(valueToken.index) || context.state.consumed.has(countToken.index) ||
      normalizeTokenLower(countToken) !== "times"
    ) return [];
    const siteToken = context.tokens[start - 1];
    if (!siteToken) return [];
    const site = resolveBodySiteLexeme(siteToken.original, context.options?.siteCodeMap, {
      bodySiteContext: context.options?.context?.bodySiteContext
    });
    const definition = site?.definition;
    if (!definition?.perTargetText && !definition?.perTargetI18n) return [];
    const unit = definition.routeHint ? DEFAULT_UNIT_BY_ROUTE[definition.routeHint] : undefined;
    if (!unit) return [];
    return [lexicalSign({
      type: "dose-sign",
      rule: "hpsg.lex.dose.perTargetCount",
      tokens: [valueToken, countToken],
      synsem: {
        head: { dose: { value: valueToken.value, unit } },
        valence: {},
        cont: { clauseKind: "administration" }
      },
      score: 30
    })];
  });
}

export function doseLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.dose", (context, start) => {
    const tokens = tokensAvailable(context, start, 1);
    const token = tokens?.[0];
    if (!tokens || !token) {
      return [];
    }
    const supplementalDose = supplementalDoseAfter(context, start);
    if (supplementalDose) return [supplementalDose];
    if (quantityHasSupplementalPrefix(context.tokens, start)) return [];
    const lower = normalizeTokenLower(token);
    if (isClockDoseContext(context, start, lower)) {
      return [];
    }
    if (numericTokenIsProcedureLocalQuantity(context, token)) {
      return [];
    }
    if (sourceRangeOverlapsContextDate(
      context,
      token.sourceStart,
      token.sourceEnd
    )) {
      return [];
    }
    // A qualitative presentation cannot be converted into a fabricated
    // measured length. Preserve its typed product amount as source-backed
    // nonnumeric administration advice and let ordinary site/time signs
    // compose beside it. Measured "1 cm ribbon" still uses dose-sign.
    const following = context.tokens[start + 1];
    const followingLower = following && !context.state.consumed.has(following.index)
      ? normalizeTokenLower(following) : undefined;
    const followingUnit = followingLower
      ? normalizeUnit(followingLower, context.options) ??
        (QUALITATIVE_DOSE_UNITS.has(followingLower) ? followingLower : undefined)
      : undefined;
    if (QUALITATIVE_DOSE_MODIFIERS.has(lower) && following &&
        followingUnit && QUALITATIVE_DOSE_UNITS.has(followingUnit)) {
      const phrase = joinTokenText([token, following]);
      const source = rangeFromTokens([token, following]);
      // The existing structural advice matcher already licenses certain
      // qualitative amount styles (e.g. topical thin-film application).
      // Preserve that SNOMED-coded meaning rather than demoting it to
      // uncoded free text. Unrecognized shapes remain editable directions:
      // a thin ribbon is NOT an invented one-centimetre ribbon.
      const coded = source
        ? parseAdditionalInstructions(phrase, source, {
            defaultPredicate: "apply", allowFreeTextFallback: false
          }).find((instruction) => Boolean(instruction.coding?.code))
        : undefined;
      return [lexicalSign({
        type: "instruction-sign",
        rule: "hpsg.lex.dose.qualitativePresentation",
        tokens: [token, following],
        synsem: {
          head: {},
          valence: coded
            ? { instructions: [coded] }
            : { patientInstruction: { text: phrase } },
          cont: { clauseKind: "administration" }
        },
        score: 11
      })];
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
      if (!unit) {
        const modifier = context.tokens[start + 1];
        const modifierLower = modifier && !context.state.consumed.has(modifier.index)
          ? normalizeTokenLower(modifier) : undefined;
        const modifiedUnit = modifierLower && (
          DEFAULT_ROUTE_SYNONYMS[modifierLower] || getRouteMeaning(modifier!)
        ) ? unitAfter(context, start + 2) : undefined;
        const previous = context.tokens[start - 1];
        if (!modifiedUnit && previous &&
            isMedicationAdministrationMethod(normalizeTokenLower(previous), context.options) &&
            modifierLower && SITE_ANCHORS.has(modifierLower)) {
          // A counted ellipsis ("put one in the other eye") supplies a REAL
          // cardinal, but no new unit. The ordinary typed antecedent/carry
          // supplies the unit when one exists; no tablet/drop is fabricated.
          for (let length = 1; length <= 4 && start + 2 + length <= context.limit; length++) {
            const siteTokens = tokensAvailable(context, start + 2, length);
            if (!siteTokens) break;
            const site = resolveBodySiteLexeme(joinTokenText(siteTokens), context.options?.siteCodeMap, {
              bodySiteContext: context.options?.context?.bodySiteContext
            });
            if (!site?.coding && !site?.definition) continue;
            return [lexicalSign({
              type: "dose-sign", rule: "hpsg.lex.dose.cardinalSiteEllipsis",
              tokens: [token], synsem: { head: { dose: { value: numerator } },
                valence: {}, cont: { clauseKind: "administration" } }, score: 12
            })];
          }
        }
        if (modifiedUnit) {
          // Leave the registered product/site adjective phrase in its own
          // daughter sign. The quantity's unit is licensed by that phrase,
          // but the numeral remains independently composable with its route.
          return [lexicalSign({
            type: "dose-sign", rule: "hpsg.lex.dose.numberBeforeRouteQualifiedForm",
            tokens: [token],
            synsem: {
              head: { dose: { value: numerator, unit: modifiedUnit.unit } },
              valence: {}, cont: { clauseKind: "administration" }
            },
            score: 10
          })];
        }
      }
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
      nextLower && (RANGE_CONNECTORS.has(nextLower) || FREQUENCY_ALTERNATIVE_CONNECTORS.has(nextLower)) &&
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

// Reuse the same typed lexical quantity construction as the production chart.
// A unit-bearing volume-over-time phrase is a single clinical quantity sign:
// treating "over" as a generic gap connector competes with that sign and
// destroys its rateRatio. When no such sign owns it, "over" can introduce
// an ordinary HPSG temporal/locative phrase without losing source coverage.
const TYPED_CLINICAL_QUANTITY = clinicalQuantityLexicalRule();

function overBelongsToTypedClinicalQuantity(context: HpsgClauseContext, position: number): boolean {
  const token = context.tokens[position];
  if (!token) return false;
  for (let start = Math.max(0, position - 7); start < position; start += 1) {
    if (TYPED_CLINICAL_QUANTITY.match(context, start).some(sign =>
      sign.synsem.head.dose?.clinicalQuantity?.status === "resolved" &&
      sign.consumedTokenIndices.indexOf(token.index) >= 0
    )) return true;
  }
  return false;
}

export function connectorLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.connector", (context, start) => {
    const token = tokensAvailable(context, start, 1)?.[0];
    if (!token) {
      return [];
    }
    const lower = normalizeTokenLower(token);
    if (lower === "over" && overBelongsToTypedClinicalQuantity(context, start)) return [];
    const eventRelation = actionEventRelationAt(context, start);
    if (!CONNECTORS.has(lower) && !isPunctuation(lower) && !eventRelation) {
      return [];
    }
    const following = token.original === "," ? context.tokens[start + 1] : undefined;
    const followingCoordination = following
      ? coordinationConnectorKind(normalizeTokenLower(following))
      : "unknown";
    const tokens = following && followingCoordination !== "unknown"
      ? [token, following]
      : [token];
    const coordination = followingCoordination !== "unknown"
      ? followingCoordination
      : token.original === ","
        ? "conjunction"
        : coordinationConnectorKind(lower);
    return [
      lexicalSign({
        type: "connector-sign",
        rule: "hpsg.lex.connector",
        tokens,
        synsem: coordination === "unknown"
          ? emptySynsem()
          : {
            head: {},
            valence: {},
            cont: { coordinationMarker: { coordination } },
            nonlocal: {}
          },
        score: 0
      })
    ];
  });
}
