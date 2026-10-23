import { temporalRelationStarts, coordinationLeadsToSchedule } from "../../regimen/temporal-site-boundary";
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
import { AdviceArgumentRole, RouteCode } from "../../types";
import { resolveBodySitePhrase } from "../../body-site-grammar";
import { resolveMedicationInstructionAction } from "../../instruction-action-terminology";
import { resolveMedicationInstructionConcept } from "../../instruction-concept-terminology";
import { resolveSymptomDefinition } from "../../symptom-terminology";
import {
  resolveActionRelationSurface,
  resolveActionRelationSurfaceCandidates
} from "../../relation-terminology";
import { inferRouteFromContext } from "../../context";
import { baseLanguageTag } from "../../localization";
import { inferMedicationLocale } from "../../locale-detection";
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
  ACTION_COORDINATION_CONNECTORS,
  ACTION_SEQUENCE_MARKERS,
  BODY_SITE_ATTRIBUTIVE_MODIFIERS,
  BODY_SITE_FEATURE_SCORE_BONUS,
  DURATION_LEAD_TOKENS,
  EXTERNAL_SITE_LOCATIVE_PREFIXES,
  EYE_SITE_ABBREVIATIONS,
  INSTRUCTION_START_WORDS,
  NON_OCULAR_DOSE_UNITS,
  NON_SITE_ANCHORED_PHRASES,
  OCULAR_ROUTE_CODES,
  PRN_LEADS,
  PRN_STANDALONE_REASON_LEADS,
  SITE_ANCHORS,
  SITE_DISPLAY_FILLERS,
  SITE_MULTIPLICITY_WORDS,
  SITE_RELATIVE_MARKERS,
  SITE_RESTRICTION_PREDICATE_INTRODUCERS,
  SITE_RESTRICTION_PREDICATES,
  SITE_ROUTE_HINTS_ALLOWED_IN_GRAMMAR,
  SITE_SELF_DISPLAY_ANCHORS,
  SITE_TRAILING_INSTRUCTION_WORDS,
  coordinationConnectorKind
} from "../lexical-classes";
import {
  HpsgClauseContext,
  sourceRangeOverlapsContextDate,
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
import {
  startsMaximumCountLead,
  tokenBelongsToContextualPrnReasonLead
} from "./prn-rules";

const SITE_SCOPE_BOUNDARY_WORDS = new Set(["during", "depending", "according", "not", "as"]);

function siteCoordinatorSpan(context: HpsgClauseContext, index: number): number {
  const token = context.tokens[index];
  if (!token) return 0;
  if (token.original === ",") {
    const next = context.tokens[index + 1];
    return next && coordinationConnectorKind(normalizeTokenLower(next)) !== "unknown" ? 2 : 1;
  }
  return coordinationConnectorKind(normalizeTokenLower(token)) === "unknown" ? 0 : 1;
}

function coordinatedRightSiteTokens(
  context: HpsgClauseContext,
  index: number
): Token[] | undefined {
  const connectorSpan = siteCoordinatorSpan(context, index);
  if (!connectorSpan) return undefined;
  const rightStart = index + connectorSpan;
  let rightTokens: Token[] | undefined;
  for (let span = 1; span <= 5 && rightStart + span <= context.limit; span += 1) {
    const tokens = tokensAvailable(context, rightStart, span);
    if (!tokens) break;
    const last = tokens[tokens.length - 1];
    const lower = normalizeTokenLower(last);
    if (span > 1 && (siteCoordinatorSpan(context, rightStart + span - 1) || siteBoundary(lower, context))) break;
    const resolved = resolveBodySitePhrase(joinTokenText(tokens), context.options?.siteCodeMap, {
      bodySiteContext: context.options?.context?.bodySiteContext
    });
    if (resolved?.coding || resolved?.definition) rightTokens = tokens;
  }
  return rightTokens;
}

/** A coordinator belongs to a site phrase only when it links two typed site atoms. */
function startsSiteCoordination(
  context: HpsgClauseContext,
  index: number,
  leftTokens: Token[]
): boolean {
  if (!leftTokens.length) return false;
  const connectorSpan = siteCoordinatorSpan(context, index);
  if (!connectorSpan) return false;
  const rightTokens = coordinatedRightSiteTokens(context, index);
  if (!rightTokens) return false;

  // A coded composite or explicitly counted bilateral site (for example
  // "left and right eyebrows") is one lexical target. A display-only alias
  // such as "groin and axilla" still licenses its two coded site daughters.
  const connectorTokens = context.tokens.slice(index, index + connectorSpan);
  const whole = resolveBodySitePhrase(
    joinTokenText([...leftTokens, ...connectorTokens, ...rightTokens]),
    context.options?.siteCodeMap,
    { bodySiteContext: context.options?.context?.bodySiteContext }
  );
  return !whole?.coding && !whole?.definition?.administrationTargetCount;
}

function anchoredModifierLeadsToResolvableSite(
  context: HpsgClauseContext,
  start: number
): boolean {
  const maxEnd = Math.min(context.limit, start + 5);
  for (let index = start + 1; index < maxEnd; index += 1) {
    const candidate = context.tokens.slice(index, index + 1)[0];
    if (!candidate || context.state.consumed.has(candidate.index) || isPunctuation(normalizeTokenLower(candidate))) break;
    const resolved = resolveBodySitePhrase(candidate.original, context.options?.siteCodeMap, {
      bodySiteContext: context.options?.context?.bodySiteContext
    });
    if (resolved?.coding || resolved?.definition) return true;
  }
  return false;
}

function relationIntroducesNonSiteComplement(
  context: HpsgClauseContext,
  index: number
): boolean {
  const token = context.tokens[index];
  if (!token) return false;
  const relations = resolveActionRelationSurfaceCandidates(normalizeTokenLower(token));
  if (!relations.length) return false;
  for (let cursor = index + 1; cursor < Math.min(context.limit, index + 4); cursor += 1) {
    const candidate = context.tokens[cursor];
    if (!candidate || context.state.consumed.has(candidate.index) || isPunctuation(normalizeTokenLower(candidate))) {
      break;
    }
    if (EVENT_TIMING_TOKENS[normalizeTokenLower(candidate)]) return true;
  }
  return false;
}

function coordinationStartsAction(context: HpsgClauseContext, index: number): boolean {
  const token = context.tokens[index];
  if (!token || !ACTION_COORDINATION_CONNECTORS.has(normalizeTokenLower(token))) return false;
  const next = context.tokens[index + 1];
  return Boolean(
    next &&
    !context.state.consumed.has(next.index) &&
    resolveMedicationInstructionAction(normalizeTokenLower(next), context.options)
  );
}

function siteBoundary(lower: string, context: HpsgClauseContext): boolean {
  if (SITE_MULTIPLICITY_WORDS.has(lower)) {
    return false;
  }
  const siteLike = Boolean(resolveBodySitePhrase(lower, context.options?.siteCodeMap, {
    bodySiteContext: context.options?.context?.bodySiteContext
  }));
  const actionLike = resolveMedicationInstructionAction(lower, context.options);
  return (
    isPunctuation(lower) ||
    PRN_LEADS.has(lower) ||
    PRN_STANDALONE_REASON_LEADS.has(lower) ||
    DURATION_LEAD_TOKENS.has(lower) ||
    SITE_TRAILING_INSTRUCTION_WORDS.has(lower) ||
    SITE_RELATIVE_MARKERS.has(lower) ||
    SITE_SCOPE_BOUNDARY_WORDS.has(lower) ||
    INSTRUCTION_START_WORDS.has(lower) ||
    Boolean(
      actionLike ||
      (DEFAULT_ROUTE_SYNONYMS[lower] && !siteLike) ||
      productRouteHint(lower) ||
      (normalizeUnit(lower, context.options) && !siteLike) ||
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

function siteI18nWithSourceText(
  sourceText: string,
  definitionI18n: Record<string, string> | undefined,
  context: HpsgClauseContext
): Record<string, string> | undefined {
  const sourceLocale = inferMedicationLocale(sourceText, "en");
  if (sourceLocale === "en") return definitionI18n;
  return { ...(definitionI18n ?? {}), [sourceLocale]: sourceText };
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
      const action = route.source === "verb"
        ? resolveMedicationInstructionAction(normalizeTokenLower(token), context.options)
        : undefined;
      // A suppressible administration-verb hint is a default, not explicit
      // route evidence. Let a typed ocular abbreviation refine generic verbs
      // such as "apply"; an explicit route or non-ocular dose still wins.
      if (action?.suppressMethodRouteHint) {
        continue;
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

function anchorTargetsTypedNonSiteConcept(
  context: HpsgClauseContext,
  start: number
): boolean {
  const current = tokensAvailable(context, start, 1)?.[0];
  if (!current || !resolveActionRelationSurface(normalizeTokenLower(current))) return false;
  for (let cursor = start + 1; cursor < Math.min(context.limit, start + 4); cursor += 1) {
    const candidate = context.tokens[cursor];
    if (!candidate || context.state.consumed.has(candidate.index)) break;
    const lower = normalizeTokenLower(candidate);
    if (isPunctuation(lower)) break;
    if (cursor > start + 1 && SITE_TRAILING_INSTRUCTION_WORDS.has(lower)) break;
    if (
      BODY_SITE_ATTRIBUTIVE_MODIFIERS.has(lower) &&
      anchoredModifierLeadsToResolvableSite(context, cursor)
    ) {
      continue;
    }
    const concept = resolveMedicationInstructionConcept(lower, context.options);
    if (!concept) continue;
    return concept.role !== AdviceArgumentRole.Site && concept.role !== AdviceArgumentRole.Destination;
  }
  return false;
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

function siteRelativeMarkerSign(
  token: Token,
  lower: string
): HpsgSign | undefined {
  const marker = SITE_RELATIVE_MARKERS.get(lower);
  if (!marker) return undefined;
  return lexicalSign({
    type: "site-relative-marker-sign",
    rule: "hpsg.lex.site.relative-marker",
    tokens: [token],
    synsem: {
      head: {},
      valence: {},
      cont: {
        siteRelativeMarker: {
          relation: marker.relation,
          range: { start: token.sourceStart, end: token.sourceEnd }
        }
      }
    }
  });
}

function sitePredicateEndsBefore(
  context: HpsgClauseContext,
  index: number,
  predicateStart: number
): boolean {
  const token = context.tokens[index];
  if (!token) return true;
  const lower = normalizeTokenLower(token);
  if (
    isPunctuation(lower) ||
    temporalRelationStarts(context, index) ||
    coordinationLeadsToSchedule(context, index) ||
    startsMaximumCountLead(context, index) ||
    coordinationStartsAction(context, index) ||
    Boolean(coordinatedRightSiteTokens(context, index)) ||
    ACTION_SEQUENCE_MARKERS.has(lower) ||
    (index > predicateStart && siteBoundary(lower, context))
  ) return true;

  if (!SITE_ANCHORS.has(lower)) return false;
  for (let cursor = index + 1; cursor < Math.min(context.limit, index + 4); cursor += 1) {
    const next = context.tokens[cursor];
    if (!next || context.state.consumed.has(next.index)) return false;
    const nextLower = normalizeTokenLower(next);
    if (SITE_DISPLAY_FILLERS.has(nextLower)) continue;
    return Boolean(
      isClockLikeLower(nextLower) ||
      getDayOfWeekMeaning(next) ||
      sourceRangeOverlapsContextDate(context, next.sourceStart, next.sourceEnd) ||
      EVENT_TIMING_TOKENS[nextLower] ||
      TIMING_ABBREVIATIONS[nextLower] ||
      WORD_FREQUENCIES[nextLower] ||
      FREQUENCY_SIMPLE_WORDS[nextLower] !== undefined
    );
  }
  return false;
}

function sitePredicateSign(
  context: HpsgClauseContext,
  start: number
): HpsgSign | undefined {
  const previous = context.tokens[start - 1];
  if (!previous || !SITE_RELATIVE_MARKERS.has(normalizeTokenLower(previous))) {
    return undefined;
  }
  const predicateTokens: Token[] = [];
  for (let cursor = start; cursor < context.limit; cursor += 1) {
    const token = context.tokens[cursor];
    if (!token || context.state.consumed.has(token.index)) break;
    if (sitePredicateEndsBefore(context, cursor, start)) break;
    predicateTokens.push(token);
  }
  if (!predicateTokens.length) return undefined;

  const text = joinTokenText(predicateTokens);
  const lowers = predicateTokens.map((token) => normalizeTokenLower(token));
  const normalized = lowers.join(" ");
  const lexicalPredicate = SITE_RESTRICTION_PREDICATES.get(normalized);
  const introducer = SITE_RESTRICTION_PREDICATE_INTRODUCERS.find((candidate) =>
    candidate.parts.length < predicateTokens.length &&
    candidate.parts.every((part, index) => lowers[index] === part)
  );
  const focusTokens = introducer
    ? predicateTokens.slice(introducer.parts.length)
    : undefined;
  const focusText = focusTokens?.length ? joinTokenText(focusTokens) : undefined;
  const symptom = resolveSymptomDefinition(focusText ?? normalized);
  const symptomLemma = symptom?.text?.trim().toLowerCase() ||
    symptom?.coding?.display?.trim().toLowerCase();
  const range = rangeFromTokens(predicateTokens);
  if (!range) return undefined;

  return lexicalSign({
    type: "site-predicate-sign",
    rule: "hpsg.lex.site.restriction-predicate",
    tokens: predicateTokens,
    synsem: {
      head: {},
      valence: {},
      cont: {
        sitePredicate: {
          text,
          lemma: lexicalPredicate?.lemma ?? symptomLemma,
          form: lexicalPredicate?.form ?? introducer?.form ?? "raw",
          focusText,
          range
        }
      }
    }
  });
}

export function siteLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.site", (context, start) => {
    const token = tokensAvailable(context, start, 1)?.[0];
    if (!token) {
      return [];
    }
    const signs: HpsgSign[] = [];
    const lower = normalizeTokenLower(token);
    const relativeMarker = siteRelativeMarkerSign(token, lower);
    if (relativeMarker) return [relativeMarker];
    const predicate = sitePredicateSign(context, start);
    if (predicate) return [predicate];
    if (
      tokenBelongsToContextualPrnReasonLead(context, start) ||
      anchorTargetsTypedNonSiteConcept(context, start)
    ) {
      return signs;
    }
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
      const resolvedCandidate = resolveBodySitePhrase(siteCandidate.text, context.options?.siteCodeMap, {
        bodySiteContext: context.options?.context?.bodySiteContext
      });
      signs.push(
        lexicalSign({
          type: "site-sign",
          rule: "hpsg.lex.site.abbreviation",
          tokens: [token],
          synsem: {
            head: { route: siteCandidate.route ? { code: siteCandidate.route } : undefined },
            valence: {
              site: {
                text: siteCandidate.text,
                i18n: resolvedCandidate?.definition?.i18n,
                source: "abbreviation",
                coding: resolvedCandidate?.coding,
                administrationTargetCount: resolvedCandidate?.definition?.administrationTargetCount,
                range: { start: token.sourceStart, end: token.sourceEnd }
              }
            },
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
    let ordinalCursor = start + 1;
    const article = context.tokens[ordinalCursor];
    if (article && normalizeTokenLower(article) === "the") ordinalCursor += 1;
    const ordinalToken = context.tokens[ordinalCursor];
    const weekdayToken = context.tokens[ordinalCursor + 1];
    const ofToken = context.tokens[ordinalCursor + 2];
    const recurrenceToken = context.tokens[ordinalCursor + 3];
    const monthToken = context.tokens[ordinalCursor + 4];
    if (ordinalToken && weekdayToken && ofToken && recurrenceToken && monthToken &&
        /^(?:first|second|third|fourth|last)$/u.test(normalizeTokenLower(ordinalToken)) &&
        getDayOfWeekMeaning(weekdayToken)?.length === 1 &&
        normalizeTokenLower(ofToken) === "of" &&
        /^(?:each|every)$/u.test(normalizeTokenLower(recurrenceToken)) &&
        /^months?$/u.test(normalizeTokenLower(monthToken))) {
      return signs;
    }
    const secondAfterAnchor = context.tokens[start + 2];
    const firstAfterAnchorLower = firstAfterAnchor && !context.state.consumed.has(firstAfterAnchor.index)
      ? normalizeTokenLower(firstAfterAnchor)
      : undefined;
    const secondAfterAnchorLower = secondAfterAnchor && !context.state.consumed.has(secondAfterAnchor.index)
      ? normalizeTokenLower(secondAfterAnchor)
      : undefined;
    if (
      firstAfterAnchor &&
      sourceRangeOverlapsContextDate(
        context,
        firstAfterAnchor.sourceStart,
        firstAfterAnchor.sourceEnd
      )
    ) {
      return signs;
    }
    if (
      firstAfterAnchorLower &&
      (
        isClockLikeLower(firstAfterAnchorLower) ||
        (
          SITE_ANCHORS.has(firstAfterAnchorLower) &&
          Boolean(secondAfterAnchorLower && isClockLikeLower(secondAfterAnchorLower))
        ) ||
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
      if (
        temporalRelationStarts(context, cursor) ||
        coordinationLeadsToSchedule(context, cursor) ||
        startsMaximumCountLead(context, cursor)
      ) break;
      if (startsSiteCoordination(context, cursor, displayTokens)) break;
      if (candidate.kind === LexKind.Number) {
        break;
      }
      if (getDayOfWeekMeaning(candidate) || ACTION_SEQUENCE_MARKERS.has(candidateLower)) {
        break;
      }
      if (coordinationStartsAction(context, cursor)) break;
      const siteModifierCanBridgeBoundary = (
        SITE_SELF_DISPLAY_ANCHORS.has(candidateLower) ||
        EXTERNAL_SITE_LOCATIVE_PREFIXES.has(candidateLower) ||
        BODY_SITE_ATTRIBUTIVE_MODIFIERS.has(candidateLower)
      ) && anchoredModifierLeadsToResolvableSite(context, cursor);
      if (
        (siteBoundary(candidateLower, context) || relationIntroducesNonSiteComplement(context, cursor)) &&
        (isPunctuation(candidateLower) || !siteModifierCanBridgeBoundary)
      ) {
        const next = context.tokens[cursor + 1];
        const nextLower = next && !context.state.consumed.has(next.index)
          ? normalizeTokenLower(next)
          : undefined;
        const continuedText = nextLower
          ? [...displayTokens, next].map((part) => part.original).join(" ")
          : "";
        const continuedSite = continuedText
          ? resolveBodySitePhrase(continuedText, context.options?.siteCodeMap, {
              bodySiteContext: context.options?.context?.bodySiteContext
            })
          : undefined;
        if (
          !isPunctuation(candidateLower) ||
          !nextLower ||
          !continuedSite ||
          (!continuedSite.coding && !continuedSite.definition)
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
      if (
        !SITE_DISPLAY_FILLERS.has(candidateLower) ||
        SITE_MULTIPLICITY_WORDS.has(candidateLower)
      ) {
        displayTokens.push(candidate);
      }
    }
    if (!displayTokens.length) {
      return signs;
    }
    const rawSourceText = joinTokenText(displayTokens);
    const isProbe = rawSourceText.includes("{") || rawSourceText.includes("}");
    const sourceText = rawSourceText
      .replace(/[{}]/g, "")
      .replace(/[.,;:!?]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (NON_SITE_ANCHORED_PHRASES.has(normalizeBodySiteKey(sourceText))) {
      return signs;
    }
    const resolved = resolveBodySitePhrase(sourceText, context.options?.siteCodeMap, {
      bodySiteContext: context.options?.context?.bodySiteContext,
      allowTerminalModifierInheritance: true
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
              i18n: !resolved?.coding && resolved?.definition?.text === "affected area"
                ? siteI18nWithSourceText(sourceText, resolved?.definition?.i18n, context)
                : resolved?.definition?.i18n,
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
              },
              administrationTargetCount: resolved?.definition?.administrationTargetCount,
              range
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
                i18n: !resolved.coding && resolved.definition?.text === "affected area"
                  ? siteI18nWithSourceText(sourceText, resolved.definition?.i18n, context)
                  : resolved.definition?.i18n,
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
                },
                administrationTargetCount: resolved.definition?.administrationTargetCount,
                range: trimmedRange ?? rawRange
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
