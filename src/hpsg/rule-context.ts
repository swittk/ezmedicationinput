import { resolveMedicationInstructionAction } from "../instruction-action-terminology";
import { Token, ParserState } from "../parser-state";
import { shouldJoinAdjacentSourceTokens } from "../locale-detection";
import { FhirPeriodUnit, ParseOptions } from "../types";
import { LexKind } from "../lexer/token-types";
import { normalizeUnit } from "../unit-lexicon";
import { isMedicationAdministrationMethod } from "./method-lexicon";
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
  doseComparatorNumberAt,
  ACTION_SEQUENCE_MARKERS,
  HARD_SEGMENT_BOUNDARY_TOKENS,
  INSTRUCTION_LEADING_SEPARATORS,
  coordinationConnectorKind,
  additiveDoseNumberAt,
  fractionalDoseNumberAt,
  millionDoseNumberAt,
  DOSE_NUMBER_WORDS,
  DOSE_FRACTION_WORDS,
  DOSE_FRACTION_DENOMINATOR_WORDS,
  DOSE_UNIT_CONNECTORS,
  DAYPART_INTERVAL_TOKENS,
  DOSE_FRACTION_ARTICLES,
  EVENT_ARTICLE_TOKENS,
  MAXIMUM_COUNT_LEAD_FIRST_TOKENS,
  DOSE_COMPARATOR_PREFIXES,
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
    /** PRN daughters requested early by conditional target ownership. */
    prnLookahead?: Map<number, HpsgSign[]>;
    medicationGuardScanned?: true;
    medicationGuard?: ParsedMedicationGuard;
    /** Tokens owned by a complete dimensional quantity or cumulative limit.
     * Numeric, site and advice fallbacks must not detach its daughters. */
    quantityTokenIndices?: Set<number>;
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
    context.clinicalCache.medicationGuard = parseMedicationGuard(context.state.input, context.tokens, undefined, context.options);
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

/** The selected action lexicon licenses its elapsed-duration complement. */
export function precedingMethodOwnsAdministrationDuration(
  context: HpsgClauseContext,
  start: number,
  relation: string
): boolean {
  for (let index = start - 1; index >= 0 && index >= start - 6; index -= 1) {
    const candidate = context.tokens[index];
    if (!candidate) break;
    const lower = normalizeTokenLower(candidate);
    if (isPunctuation(lower) || ACTION_SEQUENCE_MARKERS.has(lower)) break;
    const definition = resolveMedicationInstructionAction(lower, context.options);
    const introducers = definition?.administrationDurationIntroducers;
    if (introducers && introducers.indexOf(relation) !== -1) return true;
  }
  return false;
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


interface QuantityLexicalContext {
  tokens: Token[];
  options?: ParseOptions;
  limit?: number;
  state?: Pick<ParserState, "consumed">;
}

export function quantityTokenAvailable(context: QuantityLexicalContext, index: number): boolean {
  const token = context.tokens[index];
  return Boolean(token && index < (context.limit ?? context.tokens.length) &&
    !context.state?.consumed.has(token.index));
}

export function doseNumberValue(token: Token | undefined): number | undefined {
  if (!token) return undefined;
  return token.kind === LexKind.Number && token.value !== undefined
    ? token.value
    : DOSE_NUMBER_WORDS.get(normalizeTokenLower(token));
}

/** Shared numeric-word inventory: clinical quantities and ordinary timing
 * interpret the same lexical number daughters, without string special cases. */
export function clinicalDurationNumber(token: Token | undefined): number | undefined {
  if (!token) return undefined;
  if (token.kind === LexKind.Number) return token.value !== undefined && token.value > 0 ? token.value : undefined;
  const word = normalizeTokenLower(token);
  const value = DOSE_NUMBER_WORDS.get(word) ?? FREQUENCY_NUMBER_WORDS[word] ?? DOSE_FRACTION_WORDS.get(word);
  return value !== undefined && value > 0 ? value : undefined;
}

/** One elapsed-duration daughter shared by infusion amounts and dose-limit periods. */
export function clinicalDurationAt(context: QuantityLexicalContext, start: number) {
  const token = context.tokens[start];
  if (!token || !quantityTokenAvailable(context, start)) return undefined;
  const qualified = token.kind === LexKind.Number ? undefined :
    doseComparatorNumberAt(context.tokens, start, context.limit ?? context.tokens.length, normalizeTokenLower(token), false);
  const articleFraction = !qualified && DOSE_FRACTION_ARTICLES.has(normalizeTokenLower(token)) &&
    quantityTokenAvailable(context, start + 1)
    ? DOSE_FRACTION_WORDS.get(normalizeTokenLower(context.tokens[start + 1])) : undefined;
  const attached = !qualified && token.kind !== LexKind.Number
    ? attachedNumberUnitAt(token.lower.replace(/[{};]+|\.+$/gu, "")) : undefined;
  const cardinal = articleFraction ?? attached?.value ?? (qualified ? undefined : clinicalDurationNumber(token));
  const denominator = articleFraction === undefined && cardinal !== undefined && quantityTokenAvailable(context, start + 1)
    ? DOSE_FRACTION_DENOMINATOR_WORDS.get(normalizeTokenLower(context.tokens[start + 1])) : undefined;
  const exact = cardinal === undefined ? undefined : denominator === undefined ? cardinal : cardinal * denominator;
  const mixed = exact === undefined || denominator !== undefined ? undefined :
    additiveDoseNumberAt(context.tokens, start, context.limit ?? context.tokens.length, exact, false);
  let unitIndex = (qualified?.numericIndex ?? mixed?.numericIndex ??
    (articleFraction === undefined && denominator === undefined ? start : start + 1)) + 1;
  const value = qualified?.value ?? mixed?.value ?? exact;
  const rawUnit = qualified?.rawUnit ?? attached?.rawUnit;
  // The fraction selects its unit complement, including "of an hour".
  // Whole duration numbers retain their direct unit boundary.
  if (!rawUnit && value !== undefined && value > 0 &&
      (value < 1 || denominator !== undefined || qualified &&
        DOSE_FRACTION_DENOMINATOR_WORDS.has(normalizeTokenLower(context.tokens[qualified.numericIndex])))) {
    while (quantityTokenAvailable(context, unitIndex) &&
        DOSE_UNIT_CONNECTORS.has(normalizeTokenLower(context.tokens[unitIndex]))) unitIndex++;
  }
  const unitToken = context.tokens[unitIndex];
  const unitSurface = rawUnit ?? (unitToken && quantityTokenAvailable(context, unitIndex) ? normalizeTokenLower(unitToken) : undefined);
  const unit = unitSurface && mapIntervalUnit(unitSurface);
  if (value === undefined || !unit) return undefined;
  return { value, unit, unitSurface, comparator: qualified?.comparator,
    end: unitIndex + (rawUnit ? 0 : 1) };
}

/** One plain numeric daughter shared by active amounts, carrier volumes and limits. */
export function plainClinicalNumberAt(context: QuantityLexicalContext, start: number, initial?: number) {
  const token = context.tokens[start];
  if (!token || !quantityTokenAvailable(context, start)) return undefined;
  const limit = context.limit ?? context.tokens.length;
  const value = initial ?? doseNumberValue(token) ?? DOSE_FRACTION_WORDS.get(normalizeTokenLower(token));
  if (value === undefined) return undefined;
  const mixed = additiveDoseNumberAt(context.tokens, start, limit, value);
  const fraction = mixed ? undefined : fractionalDoseNumberAt(context.tokens, start, limit, value);
  const complete = mixed ?? fraction ?? millionDoseNumberAt(context.tokens, start, limit, value);
  const numericIndex = complete?.numericIndex ?? start;
  for (let index = start + 1; index <= numericIndex; index++)
    if (!quantityTokenAvailable(context, index)) return undefined;
  return { value: complete?.value ?? value, numericIndex, mixed: Boolean(mixed), fractional: Boolean(mixed || fraction) };
}

/** The optional article or partitive belongs to the following medication unit. */
export function doseUnitIndexAfter(context: QuantityLexicalContext, start: number): number | undefined {
  let cursor = start;
  while (quantityTokenAvailable(context, cursor) &&
      DOSE_UNIT_CONNECTORS.has(normalizeTokenLower(context.tokens[cursor]))) cursor++;
  return quantityTokenAvailable(context, cursor) ? cursor : undefined;
}

export function directDoseUnitAfter(
  context: QuantityLexicalContext, start: number
): { unit: string; end: number } | undefined {
  const cursor = doseUnitIndexAfter(context, start);
  if (cursor === undefined) return undefined;
  const unit = normalizeUnit(normalizeTokenLower(context.tokens[cursor]), context.options);
  return unit ? { unit, end: cursor + 1 } : undefined;
}

/** The same lexical medication amount owns administration heads and dose caps. */
export function medicationAmountAt(context: QuantityLexicalContext, index: number): boolean {
  const token = context.tokens[index];
  if (!token) return false;
  const lower = normalizeTokenLower(token);
  if ((token.kind === LexKind.Number || token.kind === LexKind.NumberRange ||
      DOSE_NUMBER_WORDS.has(lower) || DOSE_FRACTION_WORDS.has(lower)) &&
      directDoseUnitAfter(context, index + 1)) return true;
  if (token.kind !== LexKind.Word) return false;
  const rawUnit = attachedNumberUnitAt(lower)?.rawUnit ??
    doseComparatorNumberAt(context.tokens, index, context.limit ?? context.tokens.length, lower)?.rawUnit;
  return Boolean(rawUnit && normalizeUnit(rawUnit, context.options));
}

function hasPrecedingMedicationAmount(context: QuantityLexicalContext, before: number): boolean {
  for (let index = before - 1; index >= 0; index--) {
    const lower = normalizeTokenLower(context.tokens[index]);
    if (ACTION_SEQUENCE_MARKERS.has(lower) || HARD_SEGMENT_BOUNDARY_TOKENS.has(lower) ||
        coordinationConnectorKind(lower) === "disjunction" ||
        isMedicationAdministrationMethod(lower, context.options)) return false;
    if (medicationAmountAt(context, index)) return true;
  }
  return false;
}

function maximumTokensAvailable(context: QuantityLexicalContext, start: number, span: number): Token[] | undefined {
  if (start + span > (context.limit ?? context.tokens.length)) return undefined;
  const tokens: Token[] = [];
  for (let offset = 0; offset < span; offset += 1) {
    const token = context.tokens[start + offset];
    if (!quantityTokenAvailable(context, start + offset)) return undefined;
    tokens.push(token);
  }
  return tokens;
}

/** A maximum head owns its leading separators and coordinated attachment. */
export function maximumCountLeadAt(
  context: QuantityLexicalContext, start: number, firstLower?: string
): { tokens: Token[]; headStart: number } | undefined {
  let headStart = start;
  while (context.tokens[headStart]) {
    const token = context.tokens[headStart], following = context.tokens[headStart + 1];
    if (!INSTRUCTION_LEADING_SEPARATORS.has(token.original) && !(following &&
        MAXIMUM_COUNT_LEAD_FIRST_TOKENS.has(normalizeTokenLower(following)) &&
        coordinationConnectorKind(token.original) === "conjunction")) break;
    headStart++;
  }
  const first = context.tokens[headStart];
  const lower = headStart === start && firstLower !== undefined ? firstLower
    : first && normalizeTokenLower(first);
  if (!lower || !MAXIMUM_COUNT_LEAD_FIRST_TOKENS.has(lower)) return undefined;
  for (const parts of MAXIMUM_COUNT_LEAD_SEQUENCES) {
    if (parts[0] !== lower) continue;
    const tokens = maximumTokensAvailable(context, headStart, parts.length);
    if (!tokens) continue;
    if (tokens.every((candidate, offset) => offset === 0 || normalizeTokenLower(candidate) === parts[offset])) {
      return { tokens, headStart };
    }
  }
  return undefined;
}

export function occurrenceCapPeriodAt(
  context: QuantityLexicalContext,
  start: number
): { tokens: Token[]; period: number; periodUnit: FhirPeriodUnit } | undefined {
  const adverb = maximumTokensAvailable(context, start, 1)?.[0];
  const lower = adverb ? normalizeTokenLower(adverb) : undefined;
  const adverbUnit = lower !== undefined ? mapFrequencyAdverb(lower) : undefined;
  if (adverb && adverbUnit) return { tokens: [adverb], period: 1, periodUnit: adverbUnit };
  for (const definition of OCCURRENCE_CAP_PERIOD_PHRASES) {
    if (definition.parts[0] !== lower) continue;
    const tokens = maximumTokensAvailable(context, start, definition.parts.length);
    if (!tokens) continue;
    if (!tokens.every((candidate, offset) => offset === 0 || normalizeTokenLower(candidate) === definition.parts[offset])) continue;
    const periodUnit = mapIntervalUnit(definition.periodUnit);
    if (!periodUnit) continue;
    return { tokens, period: definition.period, periodUnit };
  }
  return undefined;
}

type MaximumDosePeriod = (
  | { tokens: Token[]; period: number; periodUnit: FhirPeriodUnit }
  | { tokens: Token[]; daypart: true }
) & { unitDenominator?: boolean };

/** The existing compact maximum denominator is shared by quantity and count nouns. */
export function compactMaximumPeriodAt(
  context: QuantityLexicalContext, unitIndex: number, unitSurface: string
): { unitSurface: string; period: MaximumDosePeriod } | undefined {
  const compactUnitPeriod = unitSurface.match(/^(.+?)\/([^/]+)$/u);
  const compactAmount = compactUnitPeriod ? attachedNumberUnitAt(compactUnitPeriod[2]) : undefined;
  const hybridValue = compactUnitPeriod && /^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(compactUnitPeriod[2])
    ? Number(compactUnitPeriod[2]) : undefined;
  const followingUnit = hybridValue !== undefined && hybridValue > 0 ? context.tokens[unitIndex + 1] : undefined;
  const hybridUnit = followingUnit && !context.state?.consumed.has(followingUnit.index)
    ? mapIntervalUnit(normalizeTokenLower(followingUnit)) : undefined;
  const compactPeriodSurface = compactAmount?.rawUnit ?? (hybridUnit ? normalizeTokenLower(followingUnit!) : compactUnitPeriod?.[2]);
  const compactPeriodUnit = compactPeriodSurface ? mapIntervalUnit(compactPeriodSurface) : undefined;
  const compactPeriod: MaximumDosePeriod | undefined = compactPeriodUnit
    ? DAYPART_INTERVAL_TOKENS.has(compactPeriodSurface!)
      ? { tokens: hybridUnit ? [followingUnit!] : [], daypart: true, unitDenominator: true }
      : { tokens: hybridUnit ? [followingUnit!] : [], period: compactAmount?.value ?? (hybridUnit ? hybridValue! : 1), periodUnit: compactPeriodUnit, unitDenominator: true }
    : undefined;
  return compactPeriod ? { unitSurface: compactUnitPeriod![1], period: compactPeriod } : undefined;
}

export function maximumDosePeriodAt(
  context: QuantityLexicalContext,
  start: number
): MaximumDosePeriod | undefined {
  const defined = occurrenceCapPeriodAt(context, start);
  if (defined) return defined;

  const connector = context.tokens[start];
  const first = context.tokens[start + 1];
  if (!connector || !first || context.state?.consumed.has(connector.index) ||
      context.state?.consumed.has(first.index)) return undefined;
  const connectorLower = normalizeTokenLower(connector);
  if (!MAXIMUM_PERIOD_PREPOSITIONS.has(connectorLower)) return undefined;

  let cursor = start + 1;
  const articleLower = normalizeTokenLower(first);
  const article = DOSE_FRACTION_ARTICLES.has(articleLower) || EVENT_ARTICLE_TOKENS.has(articleLower);
  if (article) cursor++;
  const modifier = context.tokens[cursor];
  if (modifier && !context.state?.consumed.has(modifier.index) &&
      MAXIMUM_PERIOD_MODIFIERS.has(normalizeTokenLower(modifier))) cursor++;
  const value = context.tokens[cursor];
  if (!value || context.state?.consumed.has(value.index)) return undefined;
  const lower = normalizeTokenLower(value);
  const bareUnit = mapIntervalUnit(lower);
  const unitDenominator = connectorLower === "/" || connectorLower === "per" || connectorLower === "a";
  // An article supplies the same one-unit interval as PER, A or /.
  // Explicit numeric periods use the single number/unit reader below.
  if (bareUnit && (article || unitDenominator)) {
    const tokens = context.tokens.slice(start, cursor + 1);
    return DAYPART_INTERVAL_TOKENS.has(lower)
      ? { tokens, daypart: true, unitDenominator } : { tokens, period: 1, periodUnit: bareUnit, unitDenominator };
  }
  const duration = clinicalDurationAt(context, cursor);
  if (!duration || duration.value <= 0 || duration.comparator) return undefined;
  const tokens = context.tokens.slice(start, duration.end);
  return DAYPART_INTERVAL_TOKENS.has(duration.unitSurface!)
    ? { tokens, daypart: true, unitDenominator }
    : { tokens, period: duration.value, periodUnit: duration.unit, unitDenominator };

}

/** Shared lexical constituent: a dose limit owns both its amount and period. */
export function maximumDosePerPeriodAt(context: QuantityLexicalContext, start: number): {
  tokens: Token[];
  amount: number;
  unit: string;
  period: MaximumDosePeriod;
  headStart: number;
  comparative: boolean;
} | undefined {
  const maximumHead = maximumCountLeadAt(context, start);
  if (!maximumHead) return undefined;
  const { tokens: lead, headStart } = maximumHead;
  const comparative = (DOSE_COMPARATOR_PREFIXES.get(normalizeTokenLower(lead[0])) ?? []).some(candidate =>
    candidate.comparator === "<=" && candidate.words.length === lead.length &&
    candidate.words.every((word, index) => normalizeTokenLower(lead[index]) === word));

  let cursor = headStart + lead.length;
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
  const initial = valueToken?.kind === LexKind.Number ? valueToken.value
    : valueToken ? FREQUENCY_NUMBER_WORDS[normalizeTokenLower(valueToken)] : undefined;
  const number = plainClinicalNumberAt(context, cursor, initial);
  const amount = number?.value;
  const unitIndex = number ? doseUnitIndexAfter(context, number.numericIndex + 1) : undefined;
  const unitToken = unitIndex === undefined ? undefined : context.tokens[unitIndex];
  if (amount === undefined || !Number.isFinite(amount) || amount <= 0 ||
      unitIndex === undefined || !unitToken) return undefined;
  const quantityTokens = maximumTokensAvailable(context, cursor, unitIndex + 1 - cursor);
  if (!quantityTokens) return undefined;
  const unitSurface = normalizeTokenLower(unitToken);
  const compact = compactMaximumPeriodAt(context, unitIndex, unitSurface);
  // Quantitative count denominators belong to the occurrence-cap constituent.
  // Daypart maxima retain their existing authored-only instruction owner.
  if (OCCURRENCE_COUNT_WORDS.has(unitSurface) || compact && !("daypart" in compact.period) &&
      OCCURRENCE_COUNT_WORDS.has(compact.unitSurface)) return undefined;
  const unit = normalizeUnit(compact?.unitSurface ?? unitSurface, context.options);
  if (!unit) return undefined;
  matched.push(...quantityTokens);
  cursor = unitIndex + 1;

  const period: MaximumDosePeriod | undefined = periodFirst ?? compact?.period ?? maximumDosePeriodAt(context, cursor);
  if (!period) return undefined;
  // A comparative quantity followed by a bare cadence is an administered dose
  // ("at most 2 tablets daily"). A preceding medication amount makes that
  // same phrase a cumulative adjunct; a new administration head or sequence
  // stops that attachment. Explicit maxima/periods need no omitted head.
  if (comparative && !periodFirst && !period.unitDenominator && period.tokens.length <= 1 &&
      !hasPrecedingMedicationAmount(context, headStart)) return undefined;
  if (!periodFirst) matched.push(...period.tokens);
  return { tokens: matched, amount, unit, period, headStart, comparative };
}
