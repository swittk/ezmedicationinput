import {
  DEFAULT_PRN_REASON_DEFINITIONS,
  EVENT_TIMING_TOKENS,
  TIMING_ABBREVIATIONS,
  WORD_FREQUENCIES,
  normalizeBodySiteKey,
  normalizePrnReasonKey
} from "../../maps";
import { resolveBodySitePhrase } from "../../body-site-grammar";
import { LexKind } from "../../lexer/token-types";
import { Token } from "../../parser-state";
import { PrnReasonLookupRequest } from "../../types";
import { normalizeUnit } from "../../unit-lexicon";
import {
  EVERY_INTERVAL_TOKENS,
  mapFrequencyAdverb,
  mapIntervalUnit
} from "../timing-lexicon";
import {
  AS_NEEDED_LEAD_PHRASES,
  DURATION_LEAD_TOKENS,
  INSTRUCTION_START_WORDS,
  PRN_BREAKING_COORDINATORS,
  PRN_COMPACT_REASON_SEPARATORS,
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
  SITE_DISPLAY_FILLERS
} from "../lexical-classes";
import { METHOD_ACTION_BY_VERB } from "../method-lexicon";
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

function prnReasonBoundary(lower: string, context: HpsgClauseContext): boolean {
  return (
    /^x[0-9]+(?:\.[0-9]+)?$/.test(lower) ||
    DURATION_LEAD_TOKENS.has(lower) ||
    (isPunctuation(lower) && !PRN_REASON_COORDINATORS.has(lower)) ||
    Boolean(
      METHOD_ACTION_BY_VERB[lower] ||
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

function isKnownPrnReasonText(text: string): boolean {
  const canonical = normalizePrnReasonKey(text);
  return Boolean(canonical && DEFAULT_PRN_REASON_DEFINITIONS[canonical]);
}

function normalizeLocatedReasonHead(text: string): string | undefined {
  const canonical = normalizePrnReasonKey(text);
  if (!canonical) {
    return undefined;
  }
  return PRN_GENERIC_LOCATED_HEADS.get(canonical) ?? canonical;
}

function isLocatedReasonHead(text: string): boolean {
  const canonical = normalizeLocatedReasonHead(text);
  return Boolean(canonical && (DEFAULT_PRN_REASON_DEFINITIONS[canonical] || PRN_GENERIC_LOCATED_HEADS.has(canonical)));
}

function normalizePredicativeReasonText(text: string): string {
  return PRN_PREDICATE_REASON_NORMALIZATIONS.get(normalizePrnReasonKey(text) ?? "") ?? text;
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
    if (isKnownPrnReasonText(joinTokenText(parts)) || isLocatedReasonHead(joinTokenText(parts))) {
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
  const canonical = normalizePrnReasonKey(text);
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
    isKnownPrnReasonText(cleanDirectText) ||
    (predicativeText !== cleanDirectText && isKnownPrnReasonText(predicativeText))
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
      isLocatedReasonHead(normalizedHead) &&
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
      isLocatedReasonHead(normalizedHead) &&
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
    if (hasLexicalSeparator(text, PRN_COMPACT_REASON_SEPARATORS) && !isKnownPrnReasonText(text)) {
      const parts = splitByLexicalSeparators(text, PRN_COMPACT_REASON_SEPARATORS)
        .map((part) => part.trim())
        .filter(Boolean);
      if (parts.length > 1 && parts.every((part) => isKnownPrnReasonText(part) || isLocatedReasonHead(part))) {
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

export function prnLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.prn", (context, start) => {
    const lead = tokensAvailable(context, start, 1)?.[0];
    if (!lead) {
      return [];
    }
    const leadLower = normalizeTokenLower(lead);
    let cursor = start + 1;
    const tokens = [lead];
    const nextLead = context.tokens[start + 1];
    const nextLeadLower = nextLead && !context.state.consumed.has(nextLead.index)
      ? normalizeTokenLower(nextLead)
      : undefined;
    if (nextLeadLower && AS_NEEDED_LEAD_PHRASES.has(`${leadLower} ${nextLeadLower}`)) {
      tokens.push(nextLead);
      cursor = start + 2;
    } else if (PRN_STANDALONE_REASON_LEADS.has(leadLower)) {
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
    const isStandaloneConditionalLead = PRN_STANDALONE_REASON_LEADS.has(leadLower);
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
        (prnReasonBoundary(lower, context) || (reasonTokens.length > 0 && isScheduleLead(context, cursor))) &&
        !isKnownPrnReasonText(lower)
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
    const canonical = normalizePrnReasonKey(reasonText);
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
