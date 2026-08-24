import {
  EVENT_TIMING_TOKENS,
  TIMING_ABBREVIATIONS,
  WORD_FREQUENCIES,
  normalizeBodySiteKey
} from "../../maps";
import { resolveBodySitePhrase } from "../../body-site-grammar";
import {
  normalizeSymptomKey,
  resolveSymptomDefinition
} from "../../symptom-terminology";
import { LexKind } from "../../lexer/token-types";
import { medicationInstructionActionIsSafetyScopeTarget, resolveMedicationInstructionAction } from "../../instruction-action-terminology";
import { getProceduralFrames } from "../procedural-context";
import { Token } from "../../parser-state";
import { AdvicePolarity, PrnReasonLookupRequest } from "../../types";
import { normalizeUnit } from "../../unit-lexicon";
import {
  EVERY_INTERVAL_TOKENS,
  mapFrequencyAdverb,
  mapIntervalUnit
} from "../timing-lexicon";
import {
  ACTION_DIRECTIVE_PREFIXES,
  AS_NEEDED_LEAD_PHRASES,
  DURATION_LEAD_TOKENS,
  INSTRUCTION_START_WORDS,
  PRN_BREAKING_COORDINATORS,
  PRN_COMPACT_REASON_SEPARATORS,
  PRN_CONTEXTUAL_REASON_LEADS,
  PRN_CONDITIONAL_SITE_BOUNDARY_ANCHORS,
  PRN_DEFAULT_SITE_CONNECTOR,
  PRN_GENERIC_LOCATED_HEADS,
  PRN_LEADS,
  PRN_PREDICATE_REASON_NORMALIZATIONS,
  PRN_REASON_COORDINATORS,
  PRN_REASON_LEAD_INS,
  PRN_REASON_MULTIWORD_LEAD_INS,
  PRN_REASON_SITE_CONNECTORS,
  PRN_STANDALONE_REASON_LEADS,
  SITE_DISPLAY_FILLERS,
  SYMPTOM_ADJUSTMENT_CONNECTORS,
  SYMPTOM_ADJUSTMENT_LEADS,
  SYMPTOM_ADJUSTMENT_PATIENT_INSTRUCTION_LEADS
} from "../lexical-classes";
import { isMedicationAdministrationMethod } from "../method-lexicon";
import {
  HpsgClauseContext,
  hasLexicalSeparator,
  isPunctuation,
  joinTokenText,
  lexicalRule,
  normalizeTokenLower,
  rangeFromTokens,
  splitByLexicalSeparators,
  tokensAvailable
} from "../rule-context";
import { HpsgLexicalRule, lexicalSign } from "../signature";
import { isScheduleLead } from "./timing-rules";
import { productRouteHint } from "./product-route";

function startsDoseComplement(context: HpsgClauseContext, start: number): boolean {
  const amount = context.tokens[start];
  const unit = context.tokens[start + 1];
  if (!amount || amount.kind !== LexKind.Number || !unit || context.state.consumed.has(unit.index)) {
    return false;
  }
  return Boolean(normalizeUnit(normalizeTokenLower(unit), context.options));
}

function prnReasonBoundary(lower: string, context: HpsgClauseContext): boolean {
  return (
    /^x[0-9]+(?:\.[0-9]+)?$/.test(lower) ||
    DURATION_LEAD_TOKENS.has(lower) ||
    (isPunctuation(lower) && !PRN_REASON_COORDINATORS.has(lower)) ||
    Boolean(
      isMedicationAdministrationMethod(lower, context.options) ||
      INSTRUCTION_START_WORDS.has(lower) ||
      productRouteHint(lower) ||
      normalizeUnit(lower, context.options) ||
      TIMING_ABBREVIATIONS[lower] ||
      WORD_FREQUENCIES[lower] ||
      EVERY_INTERVAL_TOKENS.has(lower) ||
      mapFrequencyAdverb(lower) ||
      mapIntervalUnit(lower)
    )
  );
}

interface ParsedPrnReasonAtom {
  text: string;
  tokens: Token[];
  request: PrnReasonLookupRequest;
  locatedHead?: {
    text: string;
    canonical?: string;
  };
}

interface PrnReasonParseOptions {
  predicative?: boolean;
}

function isKnownPrnReasonText(context: HpsgClauseContext, text: string): boolean {
  return Boolean(resolveSymptomDefinition(
    text,
    context.options?.prnReasonMap,
    context.options?.symptomMap
  ));
}

function normalizeLocatedReasonHead(text: string): string | undefined {
  const canonical = normalizeSymptomKey(text);
  if (!canonical) {
    return undefined;
  }
  return PRN_GENERIC_LOCATED_HEADS.get(canonical) ?? canonical;
}

function isLocatedReasonHead(context: HpsgClauseContext, text: string): boolean {
  const canonical = normalizeLocatedReasonHead(text);
  return Boolean(canonical && (
    resolveSymptomDefinition(
      canonical,
      context.options?.prnReasonMap,
      context.options?.symptomMap
    ) ||
    PRN_GENERIC_LOCATED_HEADS.has(canonical)
  ));
}

function normalizePredicativeReasonText(text: string): string {
  return PRN_PREDICATE_REASON_NORMALIZATIONS.get(normalizeSymptomKey(text) ?? "") ?? text;
}

function canStartPrnReasonAtom(context: HpsgClauseContext, start: number): boolean {
  const first = context.tokens[start];
  if (!first || context.state.consumed.has(first.index)) {
    return false;
  }
  const firstLower = normalizeTokenLower(first);
  if (!firstLower || PRN_REASON_COORDINATORS.has(firstLower) || prnReasonBoundary(firstLower, context)) {
    return false;
  }

  const parts: Token[] = [];
  for (let cursor = start; cursor < Math.min(context.limit, start + 5); cursor += 1) {
    const token = context.tokens[cursor];
    if (!token || context.state.consumed.has(token.index)) {
      break;
    }
    const lower = normalizeTokenLower(token);
    if (!lower || PRN_REASON_COORDINATORS.has(lower) || prnReasonBoundary(lower, context)) {
      break;
    }
    parts.push(token);
    if (isKnownPrnReasonText(context, joinTokenText(parts)) || isLocatedReasonHead(context, joinTokenText(parts))) {
      return true;
    }
  }

  const resolvedSite = resolveBodySitePhrase(first.original, context.options?.siteCodeMap, {
    bodySiteContext: context.options?.context?.bodySiteContext
  });
  return Boolean(resolvedSite?.coding || resolvedSite?.definition);
}

function canContinuePrnReasonAfterSeparator(context: HpsgClauseContext, index: number): boolean {
  for (let cursor = index + 1; cursor < context.limit; cursor += 1) {
    const token = context.tokens[cursor];
    if (!token || context.state.consumed.has(token.index)) {
      return false;
    }
    const lower = normalizeTokenLower(token);
    if (!lower) {
      continue;
    }
    if (PRN_REASON_COORDINATORS.has(lower)) {
      continue;
    }
    return canStartPrnReasonAtom(context, cursor);
  }
  return false;
}

function startsDosageSiteComplement(context: HpsgClauseContext, start: number): boolean {
  const anchor = context.tokens[start];
  if (!anchor || !PRN_CONDITIONAL_SITE_BOUNDARY_ANCHORS.has(normalizeTokenLower(anchor))) {
    return false;
  }
  const displayTokens: Token[] = [];
  for (let cursor = start + 1; cursor < context.limit; cursor += 1) {
    const token = context.tokens[cursor];
    if (!token || context.state.consumed.has(token.index)) {
      break;
    }
    const lower = normalizeTokenLower(token);
    if (
      !lower ||
      PRN_REASON_COORDINATORS.has(lower) ||
      prnReasonBoundary(lower, context)
    ) {
      break;
    }
    if (!SITE_DISPLAY_FILLERS.has(lower)) {
      displayTokens.push(token);
    }
    const sourceText = joinTokenText(displayTokens).replace(/[{}]/g, "").trim();
    if (
      sourceText &&
      resolveBodySitePhrase(sourceText, context.options?.siteCodeMap, {
        bodySiteContext: context.options?.context?.bodySiteContext
      })
    ) {
      return true;
    }
  }
  return false;
}

function splitPrnReasonParts(tokens: Token[]): Token[][] {
  const parts: Token[][] = [];
  let current: Token[] = [];
  const flush = () => {
    if (current.length) {
      parts.push(current);
      current = [];
    }
  };
  for (const token of tokens) {
    const lower = normalizeTokenLower(token);
    if (PRN_REASON_COORDINATORS.has(lower)) {
      flush();
      continue;
    }
    current.push(token);
  }
  flush();
  return parts;
}

function createPrnReasonRequest(
  context: HpsgClauseContext,
  text: string,
  tokens: Token[],
  headText?: string,
  siteText?: string
): ParsedPrnReasonAtom {
  text = text.replace(/[.,;:!?]+$/g, "").trim();
  if (siteText) siteText = siteText.replace(/[.,;:!?]+$/g, "").trim();
  const range = rangeFromTokens(tokens);
  const rawText = joinTokenText(tokens);
  const isProbe = rawText.includes("{") || rawText.includes("}");
  let effectiveRange = range;
  if (isProbe && range) {
    let start = range.start;
    let end = range.end;
    while (start < end && /[\s{]/.test(context.state.input[start] ?? "")) {
      start += 1;
    }
    while (end > start && /[\s}]/.test(context.state.input[end - 1] ?? "")) {
      end -= 1;
    }
    effectiveRange = { start, end };
  }
  const site = siteText
    ? resolveBodySitePhrase(siteText, context.options?.siteCodeMap, {
      bodySiteContext: context.options?.context?.bodySiteContext
    })
    : undefined;
  const spatialTargetCoding = site?.spatialRelation?.targetCoding;
  const canonical = normalizeSymptomKey(text);
  const headCanonical = headText ? normalizeLocatedReasonHead(headText) : undefined;
  return {
    text,
    tokens,
    request: {
      originalText: text,
      text,
      normalized: text.toLowerCase(),
      canonical: canonical ?? "",
      headCanonical,
      locativeSiteCanonical: siteText
        ? site?.canonical ?? normalizeBodySiteKey(siteText)
        : undefined,
      locativeSiteCoding: site?.coding ?? (spatialTargetCoding?.code
        ? {
          code: spatialTargetCoding.code,
          display: spatialTargetCoding.display,
          system: spatialTargetCoding.system
        }
        : undefined),
      locativeSiteSpatialRelation: site?.spatialRelation,
      isProbe,
      inputText: context.state.input,
      sourceText: effectiveRange ? context.state.input.slice(effectiveRange.start, effectiveRange.end) : text,
      range: effectiveRange
    },
    locatedHead: headText
      ? {
        text: headText,
        canonical: headCanonical
      }
      : undefined
  };
}

function parseLocatedPrnAtom(
  context: HpsgClauseContext,
  tokens: Token[],
  previousLocatedHead?: ParsedPrnReasonAtom["locatedHead"],
  options?: PrnReasonParseOptions
): ParsedPrnReasonAtom | undefined {
  const directText = joinTokenText(tokens);
  const cleanDirectText = directText.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
  if (!cleanDirectText) {
    return undefined;
  }
  const predicativeText = options?.predicative
    ? normalizePredicativeReasonText(cleanDirectText)
    : cleanDirectText;
  if (
    isKnownPrnReasonText(context, cleanDirectText) ||
    (predicativeText !== cleanDirectText && isKnownPrnReasonText(context, predicativeText))
  ) {
    return createPrnReasonRequest(context, predicativeText, tokens);
  }

  const connectorIndex = tokens.findIndex((token) =>
    PRN_REASON_SITE_CONNECTORS.has(normalizeTokenLower(token))
  );
  if (connectorIndex > 0 && connectorIndex < tokens.length - 1) {
    const headText = joinTokenText(tokens.slice(0, connectorIndex));
    const normalizedHead = normalizePredicativeReasonText(headText);
    const siteText = joinTokenText(tokens.slice(connectorIndex + 1));
    if (headText && siteText) {
      return createPrnReasonRequest(context, cleanDirectText, tokens, normalizedHead, siteText);
    }
  }

  for (let index = 1; index < tokens.length; index += 1) {
    const headText = joinTokenText(tokens.slice(0, index));
    const normalizedHead = normalizePredicativeReasonText(headText);
    const siteText = joinTokenText(tokens.slice(index));
    if (
      isLocatedReasonHead(context, normalizedHead) &&
      resolveBodySitePhrase(siteText, context.options?.siteCodeMap, {
        bodySiteContext: context.options?.context?.bodySiteContext
      })
    ) {
      return createPrnReasonRequest(context, cleanDirectText, tokens, normalizedHead, siteText);
    }
  }

  for (let index = tokens.length - 1; index > 0; index -= 1) {
    const siteText = joinTokenText(tokens.slice(0, index));
    const headText = joinTokenText(tokens.slice(index));
    const normalizedHead = normalizePredicativeReasonText(headText);
    if (
      isLocatedReasonHead(context, normalizedHead) &&
      resolveBodySitePhrase(siteText, context.options?.siteCodeMap, {
        bodySiteContext: context.options?.context?.bodySiteContext
      })
    ) {
      return createPrnReasonRequest(context, cleanDirectText, tokens, normalizedHead, siteText);
    }
  }

  if (
    previousLocatedHead &&
    resolveBodySitePhrase(cleanDirectText, context.options?.siteCodeMap, {
      bodySiteContext: context.options?.context?.bodySiteContext
    })
  ) {
    const normalizedHead = normalizePredicativeReasonText(previousLocatedHead.text);
    const text = `${normalizedHead} ${PRN_DEFAULT_SITE_CONNECTOR} ${cleanDirectText}`;
    return createPrnReasonRequest(context, text, tokens, normalizedHead, cleanDirectText);
  }

  return createPrnReasonRequest(context, cleanDirectText, tokens);
}

function parsePrnReasonAtoms(
  context: HpsgClauseContext,
  reasonTokens: Token[],
  options?: PrnReasonParseOptions
): ParsedPrnReasonAtom[] {
  if (reasonTokens.length === 1) {
    const token = reasonTokens[0];
    const text = token.original.trim();
    if (hasLexicalSeparator(text, PRN_COMPACT_REASON_SEPARATORS) && !isKnownPrnReasonText(context, text)) {
      const parts = splitByLexicalSeparators(text, PRN_COMPACT_REASON_SEPARATORS)
        .map((part) => part.trim())
        .filter(Boolean);
      if (parts.length > 1 && parts.every((part) => isKnownPrnReasonText(context, part) || isLocatedReasonHead(context, part))) {
        return parts.map((part) => createPrnReasonRequest(context, part, [token]));
      }
    }
  }

  const atoms: ParsedPrnReasonAtom[] = [];
  let previousLocatedHead: ParsedPrnReasonAtom["locatedHead"];
  for (const part of splitPrnReasonParts(reasonTokens)) {
    const atom = parseLocatedPrnAtom(context, part, previousLocatedHead, options);
    if (!atom) {
      continue;
    }
    atoms.push(atom);
    if (atom.locatedHead) {
      previousLocatedHead = atom.locatedHead;
    }
  }
  return atoms;
}

function hasSafetyConditionalActionAfter(
  context: HpsgClauseContext,
  start: number
): boolean {
  const lead = context.tokens[start];
  if (!lead) return false;
  return getProceduralFrames(context).some((frame) =>
    frame.span.start >= lead.sourceEnd &&
    medicationInstructionActionIsSafetyScopeTarget(frame.predicate.lemma, context.options)
  );
}

function conditionalLeadBelongsToSafetyActionBefore(
  context: HpsgClauseContext,
  start: number
): boolean {
  const action = context.tokens[start - 1];
  if (!action) return false;
  const actionLower = normalizeTokenLower(action);
  if (!isMedicationAdministrationMethod(actionLower, context.options) &&
      !resolveMedicationInstructionAction(actionLower, context.options)) {
    return false;
  }
  const actionIndex = start - 1;
  return ACTION_DIRECTIVE_PREFIXES.some((prefix) => {
    if (prefix.polarity !== AdvicePolarity.Negate) return false;
    const prefixStart = actionIndex - prefix.parts.length;
    if (prefixStart < 0) return false;
    return prefix.parts.every((part, offset) => {
      const token = context.tokens[prefixStart + offset];
      return Boolean(token && normalizeTokenLower(token) === part);
    });
  });
}

function hasProceduralInstructionActionAfter(
  context: HpsgClauseContext,
  start: number
): boolean {
  const lead = context.tokens[start];
  if (!lead) return false;
  return getProceduralFrames(context).some((frame) => {
    if (frame.span.start < lead.sourceEnd) return false;
    const definition = resolveMedicationInstructionAction(frame.predicate.lemma, context.options);
    return definition?.procedural === true;
  });
}

export function symptomAdjustmentLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.symptomAdjustment", (context, start) => {
    const lead = tokensAvailable(context, start, 1)?.[0];
    if (!lead || !SYMPTOM_ADJUSTMENT_LEADS.has(normalizeTokenLower(lead))) return [];

    const body: Token[] = [];
    for (let cursor = start; cursor < context.limit; cursor += 1) {
      const item = context.tokens[cursor];
      if (!item || context.state.consumed.has(item.index)) break;
      const lower = normalizeTokenLower(item);
      const adjustmentConnector = body.length <= 2 && SYMPTOM_ADJUSTMENT_CONNECTORS.has(lower);
      if (cursor > start && !adjustmentConnector && (
        prnReasonBoundary(lower, context) ||
        startsDoseComplement(context, cursor) ||
        isScheduleLead(context, cursor)
      ) && !isKnownPrnReasonText(context, lower)) {
        break;
      }
      body.push(item);
    }
    if (body.length < 2) return [];

    let reasonTokens: Token[] | undefined;
    for (let index = 1; index < body.length; index += 1) {
      const candidate = body.slice(index);
      if (isKnownPrnReasonText(context, joinTokenText(candidate))) {
        reasonTokens = candidate;
        break;
      }
    }
    if (!reasonTokens) {
      for (let index = 1; index < body.length; index += 1) {
        const candidate = [body[index]];
        if (isKnownPrnReasonText(context, joinTokenText(candidate))) {
          reasonTokens = candidate;
          break;
        }
      }
    }
    if (!reasonTokens) return [];
    const atoms = parsePrnReasonAtoms(context, reasonTokens, { predicative: true });
    if (!atoms.length) return [];
    const range = rangeFromTokens(body);
    if (!range) return [];
    const text = context.state.input.slice(range.start, range.end).trim();
    const reasonText = joinTokenText(reasonTokens);
    const canonical = normalizeSymptomKey(reasonText);

    return [
      lexicalSign({
        type: "adjustment-sign",
        rule: "hpsg.lex.symptomAdjustment",
        tokens: body,
        synsem: {
          head: {},
          valence: {
            prn: {
              enabled: true,
              reasonText,
              lookupRequest: atoms.length === 1 ? atoms[0].request : undefined,
              reasons: atoms.map((atom) => ({ text: atom.text, lookupRequest: atom.request })),
              lookupRequests: atoms.map((atom) => atom.request)
            },
            patientInstruction: SYMPTOM_ADJUSTMENT_PATIENT_INSTRUCTION_LEADS.has(normalizeTokenLower(lead))
              ? { text }
              : undefined
          },
          cont: { clauseKind: "administration" }
        },
        score: 24 + body.length + (canonical ? 4 : 0)
      })
    ];
  });
}

function previousTokensEndNegatedDirectivePrefix(
  context: HpsgClauseContext,
  endExclusive: number
): boolean {
  return ACTION_DIRECTIVE_PREFIXES.some((prefix) => {
    if (prefix.polarity !== AdvicePolarity.Negate || prefix.parts.length < 2) return false;
    const prefixStart = endExclusive - prefix.parts.length;
    if (prefixStart < 0) return false;
    return prefix.parts.every((part, offset) => {
      const token = context.tokens[prefixStart + offset];
      return Boolean(token && normalizeTokenLower(token) === part);
    });
  });
}

function previousTokensEndDirectivePrefix(
  context: HpsgClauseContext,
  endExclusive: number
): boolean {
  return ACTION_DIRECTIVE_PREFIXES.some((prefix) => {
    const prefixStart = endExclusive - prefix.parts.length;
    if (prefixStart < 0) return false;
    return prefix.parts.every((part, offset) => {
      const token = context.tokens[prefixStart + offset];
      return Boolean(token && normalizeTokenLower(token) === part);
    });
  });
}


export function matchContextualPrnReasonLead(
  context: HpsgClauseContext,
  start: number
): { tokens: Token[]; canonical: string; next: number } | undefined {
  for (const lead of PRN_CONTEXTUAL_REASON_LEADS) {
    const tokens: Token[] = [];
    let matched = true;
    for (let offset = 0; offset < lead.parts.length; offset += 1) {
      const token = context.tokens[start + offset];
      if (
        !token ||
        context.state.consumed.has(token.index) ||
        token.original.trim().toLowerCase() !== lead.parts[offset].toLowerCase()
      ) {
        matched = false;
        break;
      }
      tokens.push(token);
    }
    if (!matched) continue;
    const next = start + lead.parts.length;
    if (lead.requiresKnownReason && !canStartPrnReasonAtom(context, next)) continue;
    return { tokens, canonical: lead.canonical, next };
  }
  return undefined;
}

export function tokenBelongsToContextualPrnReasonLead(
  context: HpsgClauseContext,
  tokenIndex: number
): boolean {
  const maxLength = PRN_CONTEXTUAL_REASON_LEADS.reduce(
    (maximum, lead) => Math.max(maximum, lead.parts.length),
    0
  );
  for (let start = Math.max(0, tokenIndex - maxLength + 1); start <= tokenIndex; start += 1) {
    const match = matchContextualPrnReasonLead(context, start);
    if (match?.tokens.some((token) => token.index === tokenIndex)) return true;
  }
  return false;
}

export function prnLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.prn", (context, start) => {
    const lead = tokensAvailable(context, start, 1)?.[0];
    if (!lead) {
      return [];
    }
    const contextualLead = matchContextualPrnReasonLead(context, start);
    const leadLower = contextualLead?.canonical ?? normalizeTokenLower(lead);
    let cursor = contextualLead?.next ?? start + 1;
    const tokens = contextualLead ? [...contextualLead.tokens] : [lead];
    const nextLead = context.tokens[start + 1];
    const nextLeadLower = nextLead && !context.state.consumed.has(nextLead.index)
      ? normalizeTokenLower(nextLead)
      : undefined;
    if (contextualLead) {
      if (
        previousTokensEndNegatedDirectivePrefix(context, start) ||
        hasSafetyConditionalActionAfter(context, start) ||
        (start === 0 && hasProceduralInstructionActionAfter(context, start))
      ) {
        return [];
      }
    } else if (nextLeadLower && AS_NEEDED_LEAD_PHRASES.has(`${leadLower} ${nextLeadLower}`)) {
      // Surface "use if/when ..." is a PRN construction only when `use` is
      // not itself governed by a preceding negative/modal safety directive.
      // `should not use if ...` must remain a scoped safety action.
      if (previousTokensEndDirectivePrefix(context, start)) return [];
      tokens.push(nextLead);
      cursor = start + 2;
    } else if (PRN_STANDALONE_REASON_LEADS.has(leadLower)) {
      if (
        previousTokensEndNegatedDirectivePrefix(context, start) ||
        hasSafetyConditionalActionAfter(context, start) ||
        conditionalLeadBelongsToSafetyActionBefore(context, start) ||
        (start === 0 && hasProceduralInstructionActionAfter(context, start))
      ) {
        return [];
      }
      const next = context.tokens[start + 1];
      const nextLower = next && !context.state.consumed.has(next.index)
        ? normalizeTokenLower(next)
        : undefined;
      if (!nextLower || next?.kind === LexKind.Number || prnReasonBoundary(nextLower, context)) {
        return [];
      }
      cursor = start + 1;
    } else if (!PRN_LEADS.has(leadLower)) {
      return [];
    }
    const isStandaloneConditionalLead = Boolean(contextualLead) || PRN_STANDALONE_REASON_LEADS.has(leadLower);
    while (cursor < context.limit) {
      const leadIn = context.tokens[cursor];
      if (!leadIn || context.state.consumed.has(leadIn.index)) {
        break;
      }
      const lower = normalizeTokenLower(leadIn);
      const next = context.tokens[cursor + 1];
      const multiword = next ? `${lower} ${normalizeTokenLower(next)}` : lower;
      if (PRN_REASON_MULTIWORD_LEAD_INS.has(multiword)) {
        tokens.push(leadIn, next);
        cursor += 2;
        continue;
      }
      if (PRN_REASON_LEAD_INS.has(lower)) {
        tokens.push(leadIn);
        cursor += 1;
        continue;
      }
      break;
    }

    const reasonTokens: Token[] = [];
    for (; cursor < context.limit; cursor += 1) {
      const candidate = context.tokens[cursor];
      if (!candidate || context.state.consumed.has(candidate.index)) {
        break;
      }
      const lower = normalizeTokenLower(candidate);
      if (
        PRN_REASON_COORDINATORS.has(lower) &&
        PRN_BREAKING_COORDINATORS.has(lower) &&
        !canContinuePrnReasonAfterSeparator(context, cursor)
      ) {
        break;
      }
      if (
        !PRN_REASON_COORDINATORS.has(lower) &&
        (
          prnReasonBoundary(lower, context) ||
          startsDoseComplement(context, cursor) ||
          (reasonTokens.length > 0 && isScheduleLead(context, cursor))
        ) &&
        !isKnownPrnReasonText(context, lower)
      ) {
        break;
      }
      if (
        isStandaloneConditionalLead &&
        reasonTokens.length > 0 &&
        startsDosageSiteComplement(context, cursor)
      ) {
        break;
      }
      tokens.push(candidate);
      reasonTokens.push(candidate);
    }

    const rawReasonText = reasonTokens
      .map((token) => token.original)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const reasonText = rawReasonText.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
    const range = rangeFromTokens(reasonTokens);
    const reasonAtoms = parsePrnReasonAtoms(context, reasonTokens, {
      predicative: isStandaloneConditionalLead
    });
    const primaryRequest = reasonAtoms[0]?.request;
    const canonical = normalizeSymptomKey(reasonText);
    return [
      lexicalSign({
        type: "prn-sign",
        rule: "hpsg.lex.prn",
        tokens,
        synsem: {
          head: {},
          valence: {
            prn: {
              enabled: true,
              reasonText: reasonText || undefined,
              lookupRequest: reasonAtoms.length === 1
                ? primaryRequest
                : reasonText
                ? {
                    originalText: reasonText,
                    text: reasonText,
                    normalized: reasonText.toLowerCase(),
                    canonical: canonical ?? "",
                    headCanonical: undefined,
                    locativeSiteCanonical: undefined,
                    locativeSiteCoding: undefined,
                    locativeSiteSpatialRelation: undefined,
                    isProbe: false,
                    inputText: context.state.input,
                    sourceText: range ? context.state.input.slice(range.start, range.end) : reasonText,
                    range
                  }
                : undefined,
              reasons: reasonAtoms.length
                ? reasonAtoms.map((atom) => ({
                  text: atom.text,
                  lookupRequest: atom.request
                }))
                : undefined,
              lookupRequests: reasonAtoms.length
                ? reasonAtoms.map((atom) => atom.request)
                : undefined
            }
          },
          cont: { clauseKind: "administration" }
        },
        score: reasonTokens.length ? 10 + reasonTokens.length : 6
      })
    ];
  });
}
