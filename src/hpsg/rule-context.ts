import { Token, ParserState } from "../parser-state";
import { shouldJoinAdjacentSourceTokens } from "../locale-detection";
import { FhirPeriodUnit, ParseOptions } from "../types";
import { LexKind } from "../lexer/token-types";
import { normalizeUnit } from "../unit-lexicon";
import { FREQUENCY_NUMBER_WORDS, mapFrequencyAdverb, mapIntervalUnit } from "./timing-lexicon";
import type { MedicationDateListMatch } from "../date-interpretation";
import {
  parseMedicationGuard,
  type ParsedMedicationGuard
} from "./constructions";
import {
  ANTE_MERIDIEM_TOKENS,
  MERIDIEM_TOKENS,
  POST_MERIDIEM_TOKENS,
  normalizeTokenLower,
  attachedNumberUnitAt,
  DAYPART_INTERVAL_TOKENS,
  MAXIMUM_COUNT_LEAD_FIRST_TOKENS,
  MAXIMUM_COUNT_LEAD_SEQUENCES,
  MAXIMUM_PERIOD_PREPOSITIONS,
  MAXIMUM_PERIOD_MODIFIERS,
  OCCURRENCE_CAP_PERIOD_PHRASES,
  OCCURRENCE_COUNT_WORDS
} from "./lexical-classes";
export { normalizeTokenLower, parseClockToken } from "./lexical-classes";
import { HpsgLexicalRule, HpsgSign } from "./signature";
import { HpsgProjectionDeps } from "./projection";
import { HpsgUnificationContext } from "./unification";

export interface HpsgClauseContext {
  state: ParserState;
  tokens: Token[];
  options?: ParseOptions;
  dateSpans: MedicationDateListMatch[];
  limit: number;
  deps: HpsgProjectionDeps & HpsgUnificationContext;
  clinicalCache: {
    /** Existing lexical matches requested early by instruction body lookahead. */
    quantityLookahead?: Map<number, HpsgSign[]>;
    medicationGuardScanned?: true;
    medicationGuard?: ParsedMedicationGuard;
    /** Tokens already owned by a dimensional rate constituent. Site/advice
     * fallbacks reuse this fact instead of treating a qualified rate as prose. */
    rateTokenIndices?: Set<number>;
    /** A recognized per-time expression still owns its numeral when no rate
     * head licenses it. Scalar-dose fallback must not detach that numeral. */
    unlicensedRateTokenIndices?: Set<number>;
  };
  project?: boolean;
}

export function medicationGuardForContext(
  context: HpsgClauseContext
): ParsedMedicationGuard | undefined {
  if (!context.clinicalCache.medicationGuardScanned) {
    context.clinicalCache.medicationGuard = parseMedicationGuard(context.state.input, context.tokens);
    context.clinicalCache.medicationGuardScanned = true;
  }
  return context.clinicalCache.medicationGuard;
}

/** A marker phrase owns each of its lexical tokens, including IF inside
 * ONLY IF. Such a token cannot independently introduce a PRN phrase.
 * @param context Shared cached typed guard producer.
 * @param start Candidate lexical token index.
 */
export function isMedicationGuardMarker(context: HpsgClauseContext, start: number): boolean {
  const token = context.tokens[start];
  if (!token || !/(?:\bonly\b|\bunless\b|\bif\b|เฉพาะ|เว้นแต่|ยกเว้น|หาก|ถ้า|เมื่อ)/iu.test(token.sourceText ?? token.original)) return false;
  const guard = medicationGuardForContext(context);
  return Boolean(guard && guard.start <= token.sourceStart && token.sourceStart < guard.markerEnd);
}

export function startsMedicationGuard(
  context: HpsgClauseContext,
  start: number
): boolean {
  const token = context.tokens[start];
  if (!token ||
      !/(?:\bonly\b|\bunless\b|\bif\b|เฉพาะ|เว้นแต่|ยกเว้น|หาก|ถ้า|เมื่อ)/iu.test(token.sourceText ?? token.original)) {
    return false;
  }
  const guard = medicationGuardForContext(context);
  return Boolean(
    guard && token.sourceStart <= guard.start && guard.start < token.sourceEnd
  );
}

export function sourceRangeOverlapsContextDate(
  context: HpsgClauseContext,
  start: number,
  end: number
): boolean {
  for (const span of context.dateSpans) {
    if (start < span.end && span.start < end) return true;
  }
  return false;
}

export function isPunctuation(lower: string): boolean {
  return !lower || /^[;:(),.]+$/.test(lower) || lower === "!" || lower === "?";
}

export function isClockLikeLower(lower: string): boolean {
  return /^[0-9]{1,2}[:.][0-9]{2}$/.test(lower);
}

export function isAmPmLower(lower: string): boolean {
  return MERIDIEM_TOKENS.has(lower);
}

export function isAnteMeridiemLower(lower: string): boolean {
  return ANTE_MERIDIEM_TOKENS.has(lower);
}

export function isPostMeridiemLower(lower: string): boolean {
  return POST_MERIDIEM_TOKENS.has(lower);
}

export function tokensAvailable(
  context: HpsgClauseContext,
  start: number,
  span: number
): Token[] | undefined {
  if (start + span > context.limit) {
    return undefined;
  }
  const tokens: Token[] = [];
  for (let offset = 0; offset < span; offset += 1) {
    const token = context.tokens[start + offset];
    if (!token || context.state.consumed.has(token.index)) {
      return undefined;
    }
    tokens.push(token);
  }
  return tokens;
}

export function rangeFromTokens(tokens: Token[]): { start: number; end: number } | undefined {
  if (!tokens.length) {
    return undefined;
  }
  return {
    start: tokens[0].sourceStart,
    end: tokens[tokens.length - 1].sourceEnd
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function splitByLexicalSeparators(text: string, separators: ReadonlySet<string>): string[] {
  const activeSeparators = Array.from(separators).filter((separator) => separator.length > 0);
  if (!activeSeparators.length) {
    return [text];
  }
  const separatorPattern = new RegExp(activeSeparators.map(escapeRegExp).join("|"), "g");
  return text.split(separatorPattern);
}

export function hasLexicalSeparator(text: string, separators: ReadonlySet<string>): boolean {
  return splitByLexicalSeparators(text, separators).length > 1;
}

export function joinTokenText(tokens: Token[]): string {
  let text = "";
  let previous: Token | undefined;
  for (const current of tokens) {
    if (previous) {
      const sourceAdjacent = previous.sourceEnd === current.sourceStart;
      const unspacedBoundary = shouldJoinAdjacentSourceTokens(previous.original, current.original);
      if (!(sourceAdjacent && unspacedBoundary)) {
        text += " ";
      }
    }
    text += current.original;
    previous = current;
  }
  return text.replace(/\s+/g, " ").trim();
}

export function lexicalRule(
  id: string,
  match: HpsgLexicalRule<HpsgClauseContext>["match"]
): HpsgLexicalRule<HpsgClauseContext> {
  return { id, type: "word-sign", match };
}


interface MaximumDoseLexicalContext {
  tokens: Token[];
  options?: ParseOptions;
  limit?: number;
  state?: Pick<ParserState, "consumed">;
}

function maximumTokensAvailable(context: MaximumDoseLexicalContext, start: number, span: number): Token[] | undefined {
  if (start + span > (context.limit ?? context.tokens.length)) return undefined;
  const tokens: Token[] = [];
  for (let offset = 0; offset < span; offset += 1) {
    const token = context.tokens[start + offset];
    if (!token || context.state?.consumed.has(token.index)) return undefined;
    tokens.push(token);
  }
  return tokens;
}

export function maximumCountLeadAt(context: MaximumDoseLexicalContext, start: number): Token[] | undefined {
  const first = context.tokens[start];
  if (!first || !MAXIMUM_COUNT_LEAD_FIRST_TOKENS.has(normalizeTokenLower(first))) return undefined;
  for (const parts of MAXIMUM_COUNT_LEAD_SEQUENCES) {
    const tokens = maximumTokensAvailable(context, start, parts.length);
    if (!tokens) continue;
    if (tokens.every((candidate, offset) => normalizeTokenLower(candidate) === parts[offset])) {
      return tokens;
    }
  }
  return undefined;
}

export function occurrenceCapPeriodAt(
  context: MaximumDoseLexicalContext,
  start: number
): { tokens: Token[]; period: number; periodUnit: FhirPeriodUnit } | undefined {
  const adverb = maximumTokensAvailable(context, start, 1)?.[0];
  const adverbUnit = adverb ? mapFrequencyAdverb(normalizeTokenLower(adverb)) : undefined;
  if (adverb && adverbUnit) return { tokens: [adverb], period: 1, periodUnit: adverbUnit };
  for (const definition of OCCURRENCE_CAP_PERIOD_PHRASES) {
    const tokens = maximumTokensAvailable(context, start, definition.parts.length);
    if (!tokens) continue;
    if (!tokens.every((candidate, offset) => normalizeTokenLower(candidate) === definition.parts[offset])) continue;
    const periodUnit = mapIntervalUnit(definition.periodUnit);
    if (!periodUnit) continue;
    return { tokens, period: definition.period, periodUnit };
  }
  return undefined;
}

type MaximumDosePeriod =
  | { tokens: Token[]; period: number; periodUnit: FhirPeriodUnit }
  | { tokens: Token[]; daypart: true };

function maximumDosePeriodAt(
  context: MaximumDoseLexicalContext,
  start: number
): MaximumDosePeriod | undefined {
  const defined = occurrenceCapPeriodAt(context, start);
  if (defined) return defined;

  const connector = context.tokens[start];
  const unitToken = context.tokens[start + 1];
  if (!connector || !unitToken ||
      context.state?.consumed.has(connector.index) ||
      context.state?.consumed.has(unitToken.index)) return undefined;
  const connectorLower = normalizeTokenLower(connector);
  if (MAXIMUM_PERIOD_PREPOSITIONS.has(connectorLower)) {
    let cursor = start + 1;
    const article = context.tokens[cursor];
    if (article && !context.state?.consumed.has(article.index) &&
        ["a", "an", "the"].indexOf(normalizeTokenLower(article)) >= 0) cursor++;
    const modifier = context.tokens[cursor];
    if (modifier && !context.state?.consumed.has(modifier.index) &&
        MAXIMUM_PERIOD_MODIFIERS.has(normalizeTokenLower(modifier))) cursor++;
    const value = context.tokens[cursor];
    const attached = value?.kind !== LexKind.Number && value
      ? attachedNumberUnitAt(value.lower.replace(/[{};]+|\.+$/gu, "")) : undefined;
    const unit = attached ? undefined : context.tokens[cursor + 1];
    const amount = attached?.value ?? (value?.kind === LexKind.Number ? value.value
      : value ? FREQUENCY_NUMBER_WORDS[normalizeTokenLower(value)] : undefined);
    const unitLower = attached?.rawUnit ?? (unit && normalizeTokenLower(unit));
    const periodUnit = unitLower && mapIntervalUnit(unitLower);
    if (amount !== undefined && amount > 0 && periodUnit && value &&
        !context.state?.consumed.has(value.index) && (!unit || !context.state?.consumed.has(unit.index))) {
      const tokens = context.tokens.slice(start, cursor + (attached ? 1 : 2));
      return DAYPART_INTERVAL_TOKENS.has(unitLower!)
        ? { tokens, daypart: true } : { tokens, period: amount, periodUnit };
    }
  }
  if (connectorLower !== "/" && connectorLower !== "per" && connectorLower !== "a") {
    return undefined;
  }
  const unitLower = normalizeTokenLower(unitToken);
  const periodUnit = mapIntervalUnit(unitLower);
  if (periodUnit) {
    const tokens = [connector, unitToken];
    return DAYPART_INTERVAL_TOKENS.has(unitLower)
      ? { tokens, daypart: true } : { tokens, period: 1, periodUnit };
  }
  const attached = attachedNumberUnitAt(unitToken.lower.replace(/[{};]+|\.+$/gu, ""));
  const amount = attached?.value ?? (unitToken.kind === LexKind.Number
    ? unitToken.value : FREQUENCY_NUMBER_WORDS[unitLower]);
  const elapsedUnit = attached ? undefined : context.tokens[start + 2];
  if (elapsedUnit && context.state?.consumed.has(elapsedUnit.index)) return undefined;
  const elapsedSurface = attached?.rawUnit ?? (elapsedUnit && normalizeTokenLower(elapsedUnit));
  const elapsedPeriodUnit = elapsedSurface && mapIntervalUnit(elapsedSurface);
  if (amount === undefined || amount <= 0 || !elapsedPeriodUnit) return undefined;
  const tokens = attached ? [connector, unitToken] : [connector, unitToken, elapsedUnit!];
  return DAYPART_INTERVAL_TOKENS.has(elapsedSurface!)
    ? { tokens, daypart: true } : { tokens, period: amount, periodUnit: elapsedPeriodUnit };
}

/** Shared lexical constituent: a dose limit owns both its amount and period. */
export function maximumDosePerPeriodAt(context: MaximumDoseLexicalContext, start: number): {
  tokens: Token[];
  amount: number;
  unit: string;
  period: MaximumDosePeriod;
} | undefined {
  const first = context.tokens[start];
  if (!first || !MAXIMUM_COUNT_LEAD_FIRST_TOKENS.has(normalizeTokenLower(first))) return undefined;
  const lead = maximumCountLeadAt(context, start);
  if (!lead) return undefined;

  let cursor = start + lead.length;
  const matched = [...lead];
  const punctuation = context.tokens[cursor];
  if (punctuation && !context.state?.consumed.has(punctuation.index) &&
      punctuation.original === ".") {
    matched.push(punctuation);
    cursor += 1;
  }

  const leadingPeriod = occurrenceCapPeriodAt(context, cursor);
  const periodFirst = leadingPeriod?.tokens.length === 1
    ? leadingPeriod
    : undefined;
  if (periodFirst) {
    matched.push(...periodFirst.tokens);
    cursor += periodFirst.tokens.length;
  }

  const valueToken = context.tokens[cursor];
  const unitToken = context.tokens[cursor + 1];
  const amount = valueToken?.kind === LexKind.Number ? valueToken.value
    : valueToken ? FREQUENCY_NUMBER_WORDS[normalizeTokenLower(valueToken)] : undefined;
  if (!valueToken || amount === undefined || !Number.isFinite(amount) ||
      amount <= 0 || !unitToken ||
      context.state?.consumed.has(valueToken.index) ||
      context.state?.consumed.has(unitToken.index)) return undefined;
  const unitSurface = normalizeTokenLower(unitToken);
  // `tablets/day` remains one lossless lexical token; split only this
  // explicitly bounded dimensional suffix inside the maximum construction.
  const compactUnitPeriod = unitSurface.match(/^(.+?)\/([^/]+)$/u);
  const compactAmount = compactUnitPeriod ? attachedNumberUnitAt(compactUnitPeriod[2]) : undefined;
  const hybridValue = compactUnitPeriod && /^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(compactUnitPeriod[2])
    ? Number(compactUnitPeriod[2]) : undefined;
  const followingUnit = hybridValue !== undefined && hybridValue > 0 ? context.tokens[cursor + 2] : undefined;
  const hybridUnit = followingUnit && !context.state?.consumed.has(followingUnit.index)
    ? mapIntervalUnit(normalizeTokenLower(followingUnit)) : undefined;
  const compactPeriodSurface = compactAmount?.rawUnit ?? (hybridUnit ? normalizeTokenLower(followingUnit!) : compactUnitPeriod?.[2]);
  const compactPeriodUnit = compactPeriodSurface ? mapIntervalUnit(compactPeriodSurface) : undefined;
  if (OCCURRENCE_COUNT_WORDS.has(unitSurface)) return undefined;
  const unit = normalizeUnit(compactPeriodUnit ? compactUnitPeriod![1] : unitSurface, context.options);
  if (!unit) return undefined;
  matched.push(valueToken, unitToken);
  cursor += 2;

  const compactPeriod: MaximumDosePeriod | undefined = compactPeriodUnit
    ? DAYPART_INTERVAL_TOKENS.has(compactPeriodSurface!)
      ? { tokens: hybridUnit ? [followingUnit!] : [], daypart: true }
      : { tokens: hybridUnit ? [followingUnit!] : [], period: compactAmount?.value ?? (hybridUnit ? hybridValue! : 1), periodUnit: compactPeriodUnit }
    : undefined;
  const period = periodFirst ?? compactPeriod ?? maximumDosePeriodAt(context, cursor);
  if (!period) return undefined;
  if (!periodFirst) matched.push(...period.tokens);
  return { tokens: matched, amount, unit, period };
}
