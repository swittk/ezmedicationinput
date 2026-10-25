import { courseContinuationDurationAt } from "../lexical-classes";
import { parseMedicationDateListAt, type MedicationDateListMatch } from "../../date-interpretation";
import { inferMedicationLocale } from "../../locale-detection";
import { lexInput } from "../../lexer/lex";
import {
  DAY_OF_WEEK_TOKENS,
  EVENT_TIMING_TOKENS,
  TIMING_ABBREVIATIONS,
  WORD_FREQUENCIES
} from "../../maps";
import { annotateLexTokens, getDayOfWeekMeaning, TokenWordClass } from "../../lexer/meaning";
import { LexKind } from "../../lexer/token-types";
import { Token } from "../../parser-state";
import { AdviceArgumentRole, AdvicePolarity, type AdviceFrame, AdviceRelation, EventTiming, FhirDayOfWeek, FhirPeriodUnit, type CanonicalCalendarEventExpr, type FhirQuantity, type ParseOptions } from "../../types";
import {
  MAX_EVENT_TIMING_EXPRESSION_PARTS,
  resolveEventTimingExpression
} from "../../event-timing-expression";
import {
  EVERY_INTERVAL_TOKENS,
  COUNT_MARKER_TOKENS,
  FREQUENCY_CONNECTOR_WORDS,
  FREQUENCY_NUMBER_WORDS,
  FREQUENCY_SIMPLE_WORDS,
  FREQUENCY_TIMES_WORDS,
  buildDurationScheduleFeature,
  buildPeriodScheduleFeature,
  mapFrequencyAdverb,
  mapIntervalUnit,
  normalizeMixedPeriodRange,
  normalizePeriodRange,
  normalizePeriodValue,
  parseNumericRange
} from "../timing-lexicon";
import {
  ADMINISTRATION_WINDOW_INSTRUCTIONS,
  ACTION_COORDINATION_CONNECTORS,
  coordinationConnectorKind,
  ACTION_SEQUENCE_MARKERS,
  OPEN_ENDED_WORDS,
  OPEN_ENDED_COURSE_END_CONDITIONS,
  ALTERNATE_EVENT_CADENCES,
  CLOCK_LEAD_TOKENS,
  COMPACT_LIST_SEPARATORS,
  DAY_RANGE_CONNECTORS,
  DOSE_TARGET_EVENT_MEMBERS,
  DURATION_LEAD_TOKENS,
  compactDurationParts,
  EVENT_ARTICLE_TOKENS,
  EVENT_OFFSET_ARTICLES,
  EVENT_OFFSET_FRACTIONS,
  EVENT_OFFSET_MAXIMUM_LEAD_SEQUENCES,
  EVENT_OFFSET_MINIMUM_LEAD_SEQUENCES,
  EVENT_PREPOSITIONS,
  TIMING_ANAPHORA_PHRASES,
  FOOD_EVENT_ALIASES,
  FREQUENCY_ALTERNATIVE_CONNECTORS,
  LIST_SEPARATORS,
  isThaiDaypartListSeparator,
  MEAL_RELATION_BY_TOKEN,
  MEAL_TIMING_BY_RELATION,
  MAXIMUM_COUNT_LEAD_SEQUENCES,
  OCCURRENCE_CAP_PERIOD_PHRASES,
  OCCURRENCE_COUNT_WORDS,
  OCCURRENCE_COUNT_MODIFIERS,
  MAXIMUM_PERIOD_PREPOSITIONS,
  MAXIMUM_PERIOD_MODIFIERS,
  RANGE_CONNECTORS,
  RELATIVE_INTERVAL_TRAILING_RELATIONS,
  SCHEDULE_UNIT_SEPARATOR_TOKENS,
  SINGLE_OCCURRENCE_PHRASES,
  SLEEP_EVENT_ALIASES,
  WAKE_EVENT_ALIASES,
  CYCLE_COUNT_HEADS,
  CYCLE_WORDS,
  sequenceConnectorEnd
} from "../lexical-classes";
import {
  HpsgClauseContext,
  isAmPmLower,
  isClockLikeLower,
  isPunctuation,
  lexicalRule,
  normalizeTokenLower,
  parseClockToken,
  splitByLexicalSeparators,
  tokensAvailable
} from "../rule-context";
import { HpsgLexicalRule, HpsgScheduleFeature, HpsgSign, lexicalSign } from "../signature";
import { getProceduralFrames, sourceRangeAttachmentClass } from "../procedural-context";
import { listMedicationInstructionActions, resolveMedicationInstructionAction } from "../../instruction-action-terminology";
import { combineSignFeatureStructures } from "../feature-structure";
import { medicationInstructionConceptCodings, resolveMedicationInstructionConcept } from "../../instruction-concept-terminology";
import { getDoseUnitKind, normalizeUnit } from "../../unit-lexicon";
import { resolveActionRelationSurface } from "../../relation-terminology";
import lexicalClasses from "../lexical-classes.json";

function timingCodeForDailyFrequency(value: number): string | undefined {
  switch (value) {
    case 1:
      return "QD";
    case 2:
      return "BID";
    case 3:
      return "TID";
    case 4:
      return "QID";
    default:
      return undefined;
  }
}

const MONTHLY_WEEKDAY_ORDINALS: Readonly<Record<string, 1 | 2 | 3 | 4 | -1>> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  last: -1
};

const COURSE_CONTINUATION_MODIFIERS = new Set(lexicalClasses.courseContinuationModifiers);

/** Bounded lexical constituent for a fronted following treatment course.
 * The planner reuses its source extent; duration semantics remain owned by
 * the ordinary duration lexical rule.
 * @param tokens Source lexical tokens.
 * @param start Candidate duration-lead index.
 */
export function followingCourseDurationHeaderAt(tokens: readonly Token[], start: number):
  { valueIndex: number; tokenEnd: number } | undefined {
  const lead = tokens[start];
  if (!lead || !DURATION_LEAD_TOKENS.has(normalizeTokenLower(lead))) return undefined;
  let cursor = start + 1;
  if (tokens[cursor] && normalizeTokenLower(tokens[cursor]) === 'the') cursor++;
  const modifier = tokens[cursor];
  if (!modifier || !COURSE_CONTINUATION_MODIFIERS.has(normalizeTokenLower(modifier))) return undefined;
  const valueIndex = cursor + 1;
  const value = tokens[valueIndex];
  if (!value || !(value.kind === LexKind.Number || value.kind === LexKind.NumberRange ||
      FREQUENCY_NUMBER_WORDS[normalizeTokenLower(value)] !== undefined)) return undefined;
  let unitIndex = valueIndex + 1;
  if (tokens[unitIndex] && OCCURRENCE_COUNT_MODIFIERS.has(normalizeTokenLower(tokens[unitIndex]))) unitIndex++;
  const unit = tokens[unitIndex];
  if (!unit || !mapIntervalUnit(normalizeTokenLower(unit))) return undefined;
  return { valueIndex, tokenEnd: unitIndex + 1 };
}

const ORDINAL_WEEK_STAGE_HEADERS = lexicalClasses.ordinalWeekStageHeaders;
const ORDINAL_WEEK_STAGE_UNITS = new Set(ORDINAL_WEEK_STAGE_HEADERS.unitTokens);
const ORDINAL_WEEK_STAGE_FILLERS = new Set(ORDINAL_WEEK_STAGE_HEADERS.ordinalFillers);
const ORDINAL_WEEK_STAGE_VALUES: Readonly<Record<string, number>> =
  ORDINAL_WEEK_STAGE_HEADERS.ordinalValues;

export interface OrdinalWeekStageHeader {
  tokenStart: number;
  tokenEnd: number;
  start: number;
  end: number;
  ordinal: number;
  openEnded: boolean;
}

/**
 * Recognize a bounded ordinal-week regimen header as a typed lexical shape.
 * The caller decides whether several headers form a treatment sequence; this
 * matcher does not split text or infer a regimen from a lone occurrence.
 */
export function ordinalWeekStageHeaderAt(
  tokens: readonly Token[],
  start: number
): OrdinalWeekStageHeader | undefined {
  const headerLexeme = (token: Token): string =>
    normalizeTokenLower(token).replace(/^[.:]+|[.:]+$/gu, "");
  const unit = tokens[start];
  if (!unit || !ORDINAL_WEEK_STAGE_UNITS.has(headerLexeme(unit))) return undefined;
  let cursor = start + 1;
  const filler = tokens[cursor];
  if (filler && ORDINAL_WEEK_STAGE_FILLERS.has(headerLexeme(filler))) cursor += 1;
  const ordinalToken = tokens[cursor];
  if (!ordinalToken) return undefined;
  const ordinalLexeme = headerLexeme(ordinalToken);
  const ordinal = ordinalToken.kind === LexKind.Number
    ? ordinalToken.value
    : /^\d+$/u.test(ordinalLexeme)
      ? Number(ordinalLexeme)
      : ORDINAL_WEEK_STAGE_VALUES[ordinalLexeme];
  if (ordinal === undefined || !Number.isInteger(ordinal) || ordinal <= 0) return undefined;
  cursor += 1;

  let openEnded = false;
  for (const sequence of ORDINAL_WEEK_STAGE_HEADERS.openEndedSequences) {
    const members = tokens.slice(cursor, cursor + sequence.length);
    if (members.length !== sequence.length ||
        !members.every((token, index) => headerLexeme(token) === sequence[index])) continue;
    cursor += sequence.length;
    openEnded = true;
    break;
  }
  const punctuation = tokens[cursor];
  if (punctuation?.original === ":") cursor += 1;
  const last = tokens[cursor - 1];
  return {
    tokenStart: start,
    tokenEnd: cursor,
    start: unit.sourceStart,
    end: last.sourceEnd,
    ordinal,
    openEnded
  };
}

export function ordinalWeekStageHeaders(tokens: readonly Token[]): OrdinalWeekStageHeader[] {
  const headers: OrdinalWeekStageHeader[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const header = ordinalWeekStageHeaderAt(tokens, index);
    if (!header) continue;
    headers.push(header);
    index = header.tokenEnd - 1;
  }
  return headers;
}

/** A regimen-stage construction requires at least Week 1 + Week 2. */
export function ordinalWeekStageSequence(tokens: readonly Token[]): OrdinalWeekStageHeader[] {
  const headers = ordinalWeekStageHeaders(tokens);
  if (headers.length < 2 || headers[0].tokenStart !== 0 || headers[0].ordinal !== 1 ||
      headers.some((header, index) => index > 0 &&
        header.ordinal !== headers[index - 1].ordinal + 1)) return [];
  return headers;
}

const UTC_DAY_BY_FHIR_WEEKDAY: Readonly<Record<FhirDayOfWeek, number>> = {
  [FhirDayOfWeek.Monday]: 1,
  [FhirDayOfWeek.Tuesday]: 2,
  [FhirDayOfWeek.Wednesday]: 3,
  [FhirDayOfWeek.Thursday]: 4,
  [FhirDayOfWeek.Friday]: 5,
  [FhirDayOfWeek.Saturday]: 6,
  [FhirDayOfWeek.Sunday]: 0
};

function validReferenceDate(value: string | undefined): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? date : undefined;
}

function monthlyOrdinalWeekdayDate(
  year: number,
  month: number,
  weekday: FhirDayOfWeek,
  ordinal: 1 | 2 | 3 | 4 | -1
): Date {
  const targetDay = UTC_DAY_BY_FHIR_WEEKDAY[weekday];
  if (ordinal === -1) {
    const last = new Date(Date.UTC(year, month + 1, 0));
    last.setUTCDate(last.getUTCDate() - ((last.getUTCDay() - targetDay + 7) % 7));
    return last;
  }
  const first = new Date(Date.UTC(year, month, 1));
  first.setUTCDate(1 + ((targetDay - first.getUTCDay() + 7) % 7) + (ordinal - 1) * 7);
  return first;
}

/** Resolve the next occurrence so the ordinary monthly recurrence has a
 * typed calendar anchor. The rare construction allocates only after its full
 * lexical shape has matched; ordinary timing tokens stay on the cheap path. */
function nextMonthlyOrdinalWeekday(
  context: HpsgClauseContext,
  weekday: FhirDayOfWeek,
  ordinal: 1 | 2 | 3 | 4 | -1
): string {
  const reference = validReferenceDate(context.options?.datePolicy?.referenceDate) ??
    new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  let year = reference.getUTCFullYear();
  let month = reference.getUTCMonth();
  let occurrence = monthlyOrdinalWeekdayDate(year, month, weekday, ordinal);
  if (occurrence < reference) {
    month += 1;
    if (month === 12) {
      year += 1;
      month = 0;
    }
    occurrence = monthlyOrdinalWeekdayDate(year, month, weekday, ordinal);
  }
  return occurrence.toISOString().slice(0, 10);
}

function monthlyOrdinalWeekdaySign(
  context: HpsgClauseContext,
  start: number
): HpsgSign | undefined {
  let cursor = start;
  const members: Token[] = [];
  const take = (expected?: string): Token | undefined => {
    const token = context.tokens[cursor];
    if (!token || context.state.consumed.has(token.index)) return undefined;
    if (expected !== undefined && normalizeTokenLower(token) !== expected) return undefined;
    members.push(token);
    cursor += 1;
    return token;
  };

  const lowerAt = (index: number): string => {
    const token = context.tokens[index];
    return token ? normalizeTokenLower(token) : "";
  };
  if (lowerAt(cursor) === "on") take("on");
  if (lowerAt(cursor) === "the") take("the");

  const ordinalToken = context.tokens[cursor];
  const ordinal = ordinalToken
    ? MONTHLY_WEEKDAY_ORDINALS[normalizeTokenLower(ordinalToken)]
    : undefined;
  if (ordinal === undefined || !take()) return undefined;

  const weekdayToken = context.tokens[cursor];
  const weekdays = weekdayToken ? getDayOfWeekMeaning(weekdayToken) : undefined;
  if (!weekdays || weekdays.length !== 1 || !take()) return undefined;
  if (!take("of")) return undefined;

  const recurrenceToken = context.tokens[cursor];
  const recurrence = recurrenceToken ? normalizeTokenLower(recurrenceToken) : "";
  if ((recurrence !== "each" && recurrence !== "every") || !take()) return undefined;
  const monthToken = context.tokens[cursor];
  if (!monthToken || !/^months?$/u.test(normalizeTokenLower(monthToken)) || !take()) {
    return undefined;
  }

  const weekday = weekdays[0];
  return lexicalSign({
    type: "schedule-sign",
    rule: `hpsg.lex.schedule.monthlyOrdinalWeekday.${ordinal === -1 ? "last" : ordinal}`,
    tokens: members,
    synsem: {
      head: {
        schedule: {
          timingCode: "MO",
          frequency: 1,
          period: 1,
          periodUnit: FhirPeriodUnit.Month,
          dayOfWeek: [weekday],
          weekdayOrdinal: ordinal,
          boundsStart: nextMonthlyOrdinalWeekday(context, weekday, ordinal)
        }
      },
      valence: {},
      cont: { clauseKind: "administration" }
    },
    score: 48 + members.length
  });
}

/** Recognize the separated operands of the existing dose-times-frequency SIG.
 * @param context Source tokens and availability shared by lexical constructions.
 * @param start First dose operand; this bounded lookahead creates no signs.
 */
function separatedDoseFrequencyAt(context: HpsgClauseContext, start: number): {
  dose: number; frequency: number; tokens: Token[];
} | undefined {
  const dose = context.tokens[start];
  if (dose?.kind !== LexKind.Number || dose.value === undefined || dose.value <= 0) return undefined;
  const marker = context.tokens[start + 1];
  if (!marker) return undefined;
  const surface = normalizeTokenLower(marker);
  if (surface !== "x" && surface !== "*") return undefined;
  const frequency = context.tokens[start + 2];
  if (frequency?.kind !== LexKind.Number || frequency.value === undefined ||
      !Number.isInteger(frequency.value) || frequency.value <= 0) return undefined;
  const tokens = tokensAvailable(context, start, 3);
  return tokens ? { dose: dose.value, frequency: frequency.value, tokens } : undefined;
}

export function multiplicativeDoseFrequencyRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.doseFrequency.multiplicative", (context, start) => {
    const first = tokensAvailable(context, start, 1)?.[0];
    if (!first) {
      return [];
    }
    const firstLower = normalizeTokenLower(first);
    let dose: number | undefined;
    let frequency: number | undefined;
    let tokens: Token[] = [first];

    const compact = firstLower.match(/^([0-9]+(?:\.[0-9]+)?)[x*]([0-9]+)$/);
    if (compact) {
      dose = parseFloat(compact[1]);
      frequency = parseFloat(compact[2]);
    } else if (first.kind === LexKind.Number && first.value !== undefined) {
      const second = context.tokens[start + 1];
      if (!second || context.state.consumed.has(second.index)) {
        return [];
      }
      const secondLower = normalizeTokenLower(second);
      const spaced = secondLower.match(/^[x*]([0-9]+)$/);
      if (spaced) {
        dose = first.value;
        frequency = parseFloat(spaced[1]);
        tokens = [first, second];
      } else if (secondLower === "x" || secondLower === "*") {
        const separated = separatedDoseFrequencyAt(context, start);
        if (!separated) return [];
        dose = separated.dose;
        frequency = separated.frequency;
        tokens = separated.tokens;
      }
    }

    if (
      dose === undefined ||
      frequency === undefined ||
      !Number.isFinite(dose) ||
      !Number.isFinite(frequency) ||
      dose <= 0 ||
      frequency <= 0
    ) {
      return [];
    }
    return [
      lexicalSign({
        type: "phrase-sign",
        rule: "hpsg.lex.doseFrequency.multiplicative",
        tokens,
        synsem: {
          head: {
            dose: { value: dose },
            schedule: {
              frequency,
              period: 1,
              periodUnit: FhirPeriodUnit.Day,
              timingCode: timingCodeForDailyFrequency(frequency)
            }
          },
          valence: {},
          cont: { clauseKind: "administration" }
        },
        score: 12
      })
    ];
  });
}

export function compactIntervalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.compactInterval", (context, start) => {
    const tokens = tokensAvailable(context, start, 1);
    const token = tokens?.[0];
    if (!tokens || !token) {
      return [];
    }
    const lower = normalizeTokenLower(token);
    const compactFrequencyRange = lower.match(/^([0-9]+(?:\.[0-9]+)?)-([0-9]+(?:\.[0-9]+)?)x\/(day|d|week|wk|w|month|mo|hour|h)$/);
    if (compactFrequencyRange) {
      const unit = mapIntervalUnit(compactFrequencyRange[3]);
      const low = parseFloat(compactFrequencyRange[1]);
      const high = parseFloat(compactFrequencyRange[2]);
      if (!unit || low < 0 || high <= 0 || high < low) return [];
      const normalizedPeriod = normalizePeriodValue(1, unit);
      return [lexicalSign({
        type: "schedule-sign",
        rule: "hpsg.lex.schedule.compactFrequencyRange",
        tokens,
        synsem: {
          head: { schedule: { frequency: low, frequencyMax: high, period: normalizedPeriod.value, periodUnit: normalizedPeriod.unit } },
          valence: {},
          cont: { clauseKind: "administration" }
        },
        score: 16
      })];
    }
    const compactFrequency = lower.match(/^([0-9]+(?:\.[0-9]+)?)x\/(day|d|week|wk|w|month|mo|hour|h)$/);
    if (compactFrequency) {
      const unit = mapIntervalUnit(compactFrequency[2]);
      const frequency = parseFloat(compactFrequency[1]);
      if (!unit || frequency <= 0) return [];
      const normalizedPeriod = normalizePeriodValue(1, unit);
      return [lexicalSign({
        type: "schedule-sign",
        rule: "hpsg.lex.schedule.compactFrequency",
        tokens,
        synsem: {
          head: { schedule: {
            frequency, period: normalizedPeriod.value, periodUnit: normalizedPeriod.unit,
            timingCode: normalizedPeriod.value === 1 && normalizedPeriod.unit === FhirPeriodUnit.Day
              ? timingCodeForDailyFrequency(frequency) : undefined
          } },
          valence: {},
          cont: { clauseKind: "administration" }
        },
        score: 15
      })];
    }
    const rangeMatch = lower.match(/^q([0-9]+(?:\.[0-9]+)?)-([0-9]+(?:\.[0-9]+)?)([a-z]+)$/);
    if (rangeMatch) {
      const unit = mapIntervalUnit(rangeMatch[3]);
      if (!unit) {
        return [];
      }
      const range = normalizePeriodRange(parseFloat(rangeMatch[1]), parseFloat(rangeMatch[2]), unit);
      return [
        lexicalSign({
          type: "schedule-sign",
          rule: "hpsg.lex.schedule.compactIntervalRange",
          tokens,
          synsem: {
            head: {
              schedule: {
                period: range.low,
                periodMax: range.high,
                periodUnit: range.unit
              }
            },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: 10
        })
      ];
    }

    const match = lower.match(/^q([0-9]+(?:\.[0-9]+)?)([a-z]+)$/);
    if (!match) {
      const splitQuantity = lower.match(/^q([0-9]+(?:\.[0-9]+)?)$/);
      const next = context.tokens[start + 1];
      const nextUnit = next && !context.state.consumed.has(next.index)
        ? mapIntervalUnit(normalizeTokenLower(next))
        : undefined;
      if (!splitQuantity || !nextUnit) {
        return [];
      }
      return [
        lexicalSign({
          type: "schedule-sign",
          rule: "hpsg.lex.schedule.compactIntervalSplitUnit",
          tokens: [token, next],
          synsem: {
            head: { schedule: buildPeriodScheduleFeature(parseFloat(splitQuantity[1]), nextUnit) },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: 9
        })
      ];
    }
    const unit = mapIntervalUnit(match[2]);
    if (!unit) {
      return [];
    }
    return [
      lexicalSign({
        type: "schedule-sign",
        rule: "hpsg.lex.schedule.compactInterval",
        tokens,
        synsem: {
          head: { schedule: buildPeriodScheduleFeature(parseFloat(match[1]), unit) },
          valence: {},
          cont: { clauseKind: "administration" }
        },
        score: 9
      })
    ];
  });
}

export function separatedIntervalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.separatedInterval", (context, start) => {
    const lead = tokensAvailable(context, start, 1)?.[0];
    if (!lead || !EVERY_INTERVAL_TOKENS.has(normalizeTokenLower(lead))) {
      return [];
    }
    const quantity = context.tokens[start + 1];
    if (!quantity || context.state.consumed.has(quantity.index)) {
      return [];
    }
    const quantityLower = normalizeTokenLower(quantity);
    const otherUnitToken = context.tokens[start + 2];
    const otherUnit = quantityLower === "other" && otherUnitToken && !context.state.consumed.has(otherUnitToken.index)
      ? mapIntervalUnit(normalizeTokenLower(otherUnitToken))
      : undefined;
    if (otherUnit) {
      return [lexicalSign({
        type: "schedule-sign",
        rule: "hpsg.lex.schedule.everyOtherInterval",
        tokens: [lead, quantity, otherUnitToken],
        synsem: {
          head: { schedule: buildPeriodScheduleFeature(2, otherUnit) },
          valence: {},
          cont: { clauseKind: "administration" }
        },
        score: 13
      })];
    }
    const directUnit = mapIntervalUnit(quantityLower);
    if (directUnit) {
      return [
        lexicalSign({
          type: "schedule-sign",
          rule: "hpsg.lex.schedule.separatedInterval",
          tokens: [lead, quantity],
          synsem: {
            head: { schedule: buildPeriodScheduleFeature(1, directUnit) },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          scheduleDefault: directUnit === FhirPeriodUnit.Day ? "daily-frequency" : undefined,
          score: 9
        })
      ];
    }
    const unitToken = context.tokens[start + 2];
    const explicitLowUnit = unitToken && !context.state.consumed.has(unitToken.index)
      ? mapIntervalUnit(normalizeTokenLower(unitToken))
      : undefined;
    const explicitRangeConnectorToken = context.tokens[start + 3];
    const explicitRangeConnector = explicitRangeConnectorToken &&
      !context.state.consumed.has(explicitRangeConnectorToken.index)
      ? normalizeTokenLower(explicitRangeConnectorToken)
      : undefined;
    const explicitHighToken = context.tokens[start + 4];
    const explicitHighLower = explicitHighToken && !context.state.consumed.has(explicitHighToken.index)
      ? normalizeTokenLower(explicitHighToken)
      : undefined;
    const explicitHighUnitToken = context.tokens[start + 5];
    const explicitHighUnit = explicitHighUnitToken &&
      !context.state.consumed.has(explicitHighUnitToken.index)
      ? mapIntervalUnit(normalizeTokenLower(explicitHighUnitToken))
      : undefined;
    if (
      explicitLowUnit && explicitRangeConnector && RANGE_CONNECTORS.has(explicitRangeConnector) &&
      explicitHighToken && explicitHighLower && explicitHighUnit && explicitHighUnitToken &&
      /^[0-9]+(?:\.[0-9]+)?$/.test(quantityLower) &&
      /^[0-9]+(?:\.[0-9]+)?$/.test(explicitHighLower)
    ) {
      const normalizedRange = normalizeMixedPeriodRange(
        parseFloat(quantityLower), explicitLowUnit, parseFloat(explicitHighLower), explicitHighUnit
      );
      if (normalizedRange) {
        return [lexicalSign({
          type: "schedule-sign",
          rule: "hpsg.lex.schedule.separatedMixedUnitIntervalRange",
          tokens: [lead, quantity, unitToken, explicitRangeConnectorToken, explicitHighToken, explicitHighUnitToken],
          synsem: {
            head: { schedule: {
              period: normalizedRange.low,
              periodMax: normalizedRange.high,
              periodUnit: normalizedRange.unit
            } },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: 14
        })];
      }
    }
    const rangeConnector = unitToken && !context.state.consumed.has(unitToken.index)
      ? normalizeTokenLower(unitToken)
      : undefined;
    const highToken = context.tokens[start + 3];
    const highLower = highToken && !context.state.consumed.has(highToken.index)
      ? normalizeTokenLower(highToken)
      : undefined;
    const rangeUnitToken = context.tokens[start + 4];
    const rangeUnit = rangeUnitToken && !context.state.consumed.has(rangeUnitToken.index)
      ? mapIntervalUnit(normalizeTokenLower(rangeUnitToken))
      : undefined;
    if (
      rangeConnector &&
      RANGE_CONNECTORS.has(rangeConnector) &&
      highToken &&
      highLower &&
      rangeUnitToken &&
      rangeUnit &&
      /^[0-9]+(?:\.[0-9]+)?$/.test(quantityLower) &&
      /^[0-9]+(?:\.[0-9]+)?$/.test(highLower)
    ) {
      const normalizedRange = normalizePeriodRange(
        parseFloat(quantityLower),
        parseFloat(highLower),
        rangeUnit
      );
      return [
        lexicalSign({
          type: "schedule-sign",
          rule: "hpsg.lex.schedule.separatedIntervalRangeSpelled",
          tokens: [lead, quantity, unitToken, highToken, rangeUnitToken],
          synsem: {
            head: {
              schedule: {
                period: normalizedRange.low,
                periodMax: normalizedRange.high,
                periodUnit: normalizedRange.unit
              }
            },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: 12
        })
      ];
    }
    const unit = unitToken && !context.state.consumed.has(unitToken.index)
      ? mapIntervalUnit(normalizeTokenLower(unitToken))
      : undefined;
    const range = parseNumericRange(quantityLower);
    if (unit && range) {
      const normalizedRange = normalizePeriodRange(range.low, range.high, unit);
      return [
        lexicalSign({
          type: "schedule-sign",
          rule: "hpsg.lex.schedule.separatedIntervalRange",
          tokens: [lead, quantity, unitToken],
          synsem: {
            head: {
              schedule: {
                period: normalizedRange.low,
                periodMax: normalizedRange.high,
                periodUnit: normalizedRange.unit
              }
            },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: 11
        })
      ];
    }
    const cardinal = quantity.kind === LexKind.Number
      ? quantity.value
      : FREQUENCY_NUMBER_WORDS[quantityLower];
    if (!unit || cardinal === undefined || !Number.isFinite(cardinal) || cardinal <= 0) {
      return [];
    }
    return [
      lexicalSign({
        type: "schedule-sign",
        rule: "hpsg.lex.schedule.separatedInterval",
        tokens: [lead, quantity, unitToken],
        synsem: {
          head: { schedule: buildPeriodScheduleFeature(cardinal, unit) },
          valence: {},
          cont: { clauseKind: "administration" }
        },
        score: 10
      })
    ];
  });
}

function frequencyCardinalValue(token: Token | undefined): number | undefined {
  if (!token) return undefined;
  const lower = normalizeTokenLower(token);
  const value =
    FREQUENCY_SIMPLE_WORDS[lower] ??
    FREQUENCY_NUMBER_WORDS[lower] ??
    (token.kind === LexKind.Number ? token.value : undefined);
  return value !== undefined && value >= 0 ? value : undefined;
}

/** Read the compact count marker used by total-dose and course-count nouns.
 * @param token Source lexical token; the following noun licenses its meaning.
 */
function compactMarkedCountValue(token: Token | undefined): number | undefined {
  if (!token) return undefined;
  const matched = normalizeTokenLower(token).match(/^[x*]([0-9]+(?:\.[0-9]+)?)$/u);
  return matched ? Number(matched[1]) : undefined;
}

/** Counts are exact positive integers; unlike durations and frequencies they cannot be ranges. */
function exactCountCardinalValue(token: Token | undefined): number | undefined {
  if (!token || token.kind === LexKind.NumberRange) return undefined;
  const value = token.kind === LexKind.Number
    ? token.value
    : FREQUENCY_NUMBER_WORDS[normalizeTokenLower(token)];
  return value !== undefined && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function frequencyRangeConnector(token: Token | undefined): boolean {
  if (!token) return false;
  const lower = normalizeTokenLower(token);
  return RANGE_CONNECTORS.has(lower) || FREQUENCY_ALTERNATIVE_CONNECTORS.has(lower);
}

export function separatedFrequencyRangeRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.separatedFrequencyRange", (context, start) => {
    const lowToken = tokensAvailable(context, start, 1)?.[0];
    const connector = context.tokens[start + 1];
    const highToken = context.tokens[start + 2];
    if (!lowToken || !connector || !highToken || !frequencyRangeConnector(connector)) return [];

    const low = frequencyCardinalValue(lowToken);
    const high = frequencyCardinalValue(highToken);
    if (low === undefined || high === undefined || high <= 0 || high < low) return [];

    let cursor = start + 3;
    const consumed = [lowToken, connector, highToken];
    const timesToken = context.tokens[cursor];
    if (
      timesToken &&
      !context.state.consumed.has(timesToken.index) &&
      FREQUENCY_TIMES_WORDS.has(normalizeTokenLower(timesToken))
    ) {
      consumed.push(timesToken);
      cursor += 1;
    } else if (
      !(normalizeTokenLower(lowToken) in FREQUENCY_SIMPLE_WORDS) ||
      !(normalizeTokenLower(highToken) in FREQUENCY_SIMPLE_WORDS)
    ) {
      return [];
    }

    let unit: FhirPeriodUnit | undefined;
    const next = context.tokens[cursor];
    const nextLower = next ? normalizeTokenLower(next) : "";
    if (next && SCHEDULE_UNIT_SEPARATOR_TOKENS.has(nextLower)) {
      const unitToken = context.tokens[cursor + 1];
      const mapped = unitToken
        ? mapIntervalUnit(normalizeTokenLower(unitToken)) ?? mapFrequencyAdverb(normalizeTokenLower(unitToken))
        : undefined;
      if (mapped && unitToken) {
        consumed.push(next, unitToken);
        unit = mapped;
      }
    } else if (next && FREQUENCY_CONNECTOR_WORDS.has(nextLower)) {
      const unitToken = context.tokens[cursor + 1];
      const mapped = unitToken
        ? mapIntervalUnit(normalizeTokenLower(unitToken)) ?? mapFrequencyAdverb(normalizeTokenLower(unitToken))
        : undefined;
      if (mapped && unitToken) {
        consumed.push(next, unitToken);
        unit = mapped;
      }
    } else if (next) {
      const mapped = mapFrequencyAdverb(nextLower) ?? mapIntervalUnit(nextLower);
      if (mapped) {
        consumed.push(next);
        unit = mapped;
      }
    }
    if (!unit) return [];

    const normalized = normalizePeriodValue(1, unit);
    return [lexicalSign({
      type: "schedule-sign",
      rule: "hpsg.lex.schedule.separatedFrequencyRange",
      tokens: consumed,
      synsem: {
        head: { schedule: {
          frequency: low,
          frequencyMax: high,
          period: normalized.value,
          periodUnit: normalized.unit
        } },
        valence: {},
        cont: { clauseKind: "administration" }
      },
      score: 22
    })];
  });
}

const DISTRIBUTIVE_SINGLE_DOSE_KINDS = new Set([
  "counted_presentation",
  "device_actuation",
  "product_specific_amount"
]);

/**
 * A distributive cadence followed directly by a discrete unit licenses an
 * elided cardinal one: Thai `วันละเม็ด` => one tablet daily. This is narrower
 * than globally treating every bare unit as one dose.
 */
export function cadenceFirstImplicitSingleDoseRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.cadenceFirstImplicitSingleDose", (context, start) => {
    const cadence = tokensAvailable(context, start, 1)?.[0];
    if (!cadence) return [];
    const periodUnit = mapFrequencyAdverb(normalizeTokenLower(cadence));
    if (!periodUnit) return [];
    const unitToken = context.tokens[start + 1];
    if (!unitToken || context.state.consumed.has(unitToken.index)) return [];
    const unit = normalizeUnit(normalizeTokenLower(unitToken), context.options);
    if (!unit || !DISTRIBUTIVE_SINGLE_DOSE_KINDS.has(getDoseUnitKind(unit) ?? "")) return [];
    const normalizedPeriod = normalizePeriodValue(1, periodUnit);
    return [lexicalSign({
      type: "schedule-sign",
      rule: "hpsg.lex.schedule.cadenceFirstImplicitSingleDose",
      tokens: [cadence, unitToken],
      synsem: {
        head: {
          dose: { value: 1, unit },
          schedule: {
            frequency: 1,
            period: normalizedPeriod.value,
            periodUnit: normalizedPeriod.unit
          }
        },
        valence: {},
        cont: { clauseKind: "administration" }
      },
      score: 20
    })];
  });
}

/**
 * Parses languages and clinical shorthand that place the cadence adverb before
 * the count, e.g. `daily 2 times`. Thai `วันละ 2 ครั้ง` is normalized by the
 * locale lexer to exactly this feature sequence, without pretending Thai has
 * English word order.
 */
export function cadenceFirstFrequencyRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.cadenceFirstFrequency", (context, start) => {
    const cadence = tokensAvailable(context, start, 1)?.[0];
    if (!cadence) {
      return [];
    }
    const periodUnit = mapFrequencyAdverb(normalizeTokenLower(cadence));
    if (!periodUnit) {
      return [];
    }
    const count = context.tokens[start + 1];
    const possibleConnector = context.tokens[start + 2];
    const possibleHigh = context.tokens[start + 3];
    const possibleTimes = context.tokens[start + 4];
    if (
      count && possibleConnector && possibleHigh && possibleTimes &&
      !context.state.consumed.has(count.index) &&
      !context.state.consumed.has(possibleConnector.index) &&
      !context.state.consumed.has(possibleHigh.index) &&
      !context.state.consumed.has(possibleTimes.index) &&
      frequencyRangeConnector(possibleConnector) &&
      FREQUENCY_TIMES_WORDS.has(normalizeTokenLower(possibleTimes))
    ) {
      const low = frequencyCardinalValue(count);
      const high = frequencyCardinalValue(possibleHigh);
      if (low !== undefined && high !== undefined && high > 0 && high >= low) {
        const normalizedPeriod = normalizePeriodValue(1, periodUnit);
        return [lexicalSign({
          type: "schedule-sign",
          rule: "hpsg.lex.schedule.cadenceFirstFrequencyRange",
          tokens: [cadence, count, possibleConnector, possibleHigh, possibleTimes],
          synsem: {
            head: {
              schedule: {
                frequency: low,
                frequencyMax: high,
                period: normalizedPeriod.value,
                periodUnit: normalizedPeriod.unit
              }
            },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: 22
        })];
      }
    }

    const times = context.tokens[start + 2];
    if (
      !count ||
      !times ||
      context.state.consumed.has(count.index) ||
      context.state.consumed.has(times.index) ||
      !FREQUENCY_TIMES_WORDS.has(normalizeTokenLower(times))
    ) {
      return [];
    }
    const normalizedPeriod = normalizePeriodValue(1, periodUnit);
    const range = count.kind === LexKind.NumberRange
      ? parseNumericRange(normalizeTokenLower(count))
      : undefined;
    if (range) {
      if (range.low < 0 || range.high <= 0 || range.high < range.low) return [];
      return [
        lexicalSign({
          type: "schedule-sign",
          rule: "hpsg.lex.schedule.cadenceFirstFrequencyRange",
          tokens: [cadence, count, times],
          synsem: {
            head: {
              schedule: {
                frequency: range.low,
                frequencyMax: range.high,
                period: normalizedPeriod.value,
                periodUnit: normalizedPeriod.unit,
                timingCode:
                  range.low === range.high &&
                  range.low > 0 &&
                  normalizedPeriod.value === 1 &&
                  normalizedPeriod.unit === FhirPeriodUnit.Day
                    ? timingCodeForDailyFrequency(range.low)
                    : undefined
              }
            },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: 15
        })
      ];
    }
    const countValue = exactCountCardinalValue(count);
    if (countValue === undefined) {
      return [];
    }
    return [
      lexicalSign({
        type: "schedule-sign",
        rule: "hpsg.lex.schedule.cadenceFirstFrequency",
        tokens: [cadence, count, times],
        synsem: {
          head: {
            schedule: {
              frequency: countValue,
              period: normalizedPeriod.value,
              periodUnit: normalizedPeriod.unit,
              timingCode:
                normalizedPeriod.value === 1 && normalizedPeriod.unit === FhirPeriodUnit.Day
                  ? timingCodeForDailyFrequency(countValue)
                  : undefined
            }
          },
          valence: {},
          cont: { clauseKind: "administration" }
        },
        score: 13
      })
    ];
  });
}

export function singleOccurrencePhraseRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.singleOccurrencePhrase", (context, start) => {
    for (const phrase of SINGLE_OCCURRENCE_PHRASES) {
      const tokens = tokensAvailable(context, start, phrase.length);
      if (!tokens) continue;
      let matches = true;
      for (let index = 0; index < phrase.length; index += 1) {
        if (normalizeTokenLower(tokens[index]) !== phrase[index]) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      return [lexicalSign({
        type: "schedule-sign",
        rule: "hpsg.lex.schedule.singleOccurrencePhrase",
        tokens,
        synsem: {
          head: { schedule: { count: 1 } },
          valence: {},
          cont: { clauseKind: "administration" }
        },
        score: 20 + tokens.length
      })];
    }
    return [];
  });
}

export function countFrequencyRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.frequency", (context, start) => {
    const token = tokensAvailable(context, start, 1)?.[0];
    if (!token) {
      return [];
    }
    // A numeric complement after the multiplication marker completes a
    // dose-frequency constituent, not a shorter "1 x" total-count phrase.
    if (token.kind === LexKind.Number && separatedDoseFrequencyAt(context, start)) return [];
    // A complete leading relation + interval sign owns its cardinal and unit.
    // The suffix must not also become a recurring frequency (for example,
    // `after twelve hours` must not mean twelve times per hour).
    if (precedingLeadingRelativeAdministrationInterval(context, start)) return [];
    const lower = normalizeTokenLower(token);
    // "Every four hours" is one occurrence per four-hour interval, not
    // four occurrences each hour. Only the interval construction may own it.
    const previous = context.tokens[start - 1];
    const following = context.tokens[start + 1];
    if (previous && EVERY_INTERVAL_TOKENS.has(normalizeTokenLower(previous)) &&
        following && mapIntervalUnit(normalizeTokenLower(following)) &&
        (FREQUENCY_NUMBER_WORDS[lower] !== undefined || token.kind === LexKind.Number)) {
      return [];
    }
    const frequencyRange = token.kind === LexKind.NumberRange ? parseNumericRange(lower) : undefined;
    const value =
      FREQUENCY_SIMPLE_WORDS[lower] ??
      FREQUENCY_NUMBER_WORDS[lower] ??
      (token.kind === LexKind.Number ? token.value : frequencyRange?.low);
    const valueMax = frequencyRange?.high;
    if (value === undefined || value < 0 || (value === 0 && valueMax === undefined)) {
      return [];
    }
    if (valueMax !== undefined && (valueMax <= 0 || valueMax < value)) return [];
    const consumed = [token];
    let cursor = start + 1;
    let sawCue = lower in FREQUENCY_SIMPLE_WORDS;
    let sawCadenceContinuation = false;
    let period = 1;
    let periodUnit: FhirPeriodUnit | undefined;
    let recurringEvent: EventTiming | undefined;
    while (cursor < context.limit) {
      const candidate = context.tokens[cursor];
      if (!candidate || context.state.consumed.has(candidate.index)) {
        break;
      }
      const candidateLower = normalizeTokenLower(candidate);
      if (SCHEDULE_UNIT_SEPARATOR_TOKENS.has(candidateLower)) {
        const unitToken = context.tokens[cursor + 1];
        const unitLower = unitToken && !context.state.consumed.has(unitToken.index)
          ? normalizeTokenLower(unitToken)
          : undefined;
        const unit = unitLower ? mapFrequencyAdverb(unitLower) ?? mapIntervalUnit(unitLower) : undefined;
        if (unit) {
          sawCue = true;
          sawCadenceContinuation = true;
          consumed.push(candidate, unitToken);
          periodUnit = unit;
          break;
        }
      }
      if (
        FREQUENCY_TIMES_WORDS.has(candidateLower) ||
        (
          FREQUENCY_CONNECTOR_WORDS.has(candidateLower) &&
          !EVERY_INTERVAL_TOKENS.has(candidateLower)
        )
      ) {
        sawCue = true;
        sawCadenceContinuation = true;
        consumed.push(candidate);
        cursor += 1;
        continue;
      }
      if (EVERY_INTERVAL_TOKENS.has(candidateLower)) {
        sawCue = true;
        sawCadenceContinuation = true;
        consumed.push(candidate);
        const quantity = context.tokens[cursor + 1];
        const quantityLower = quantity && !context.state.consumed.has(quantity.index)
          ? normalizeTokenLower(quantity)
          : undefined;
        const directUnit = quantityLower ? mapIntervalUnit(quantityLower) : undefined;
        if (quantity && directUnit) {
          consumed.push(quantity);
          period = 1;
          periodUnit = directUnit;
          break;
        }
        const unit = context.tokens[cursor + 2];
        const mappedUnit = unit && !context.state.consumed.has(unit.index)
          ? mapIntervalUnit(normalizeTokenLower(unit))
          : undefined;
        if (quantity && quantityLower && mappedUnit && /^[0-9]+(?:\.[0-9]+)?$/.test(quantityLower)) {
          consumed.push(quantity, unit);
          period = parseFloat(quantity.original);
          periodUnit = mappedUnit;
          break;
        }
        cursor += 1;
        continue;
      }
      const event = EVENT_TIMING_TOKENS[candidateLower];
      if (sawCue && event && event !== EventTiming.Immediate) {
        // A cardinality modifying a recurring daily event is frequency,
        // not the total number of administrations in the course.
        recurringEvent = event;
        periodUnit = FhirPeriodUnit.Day;
        consumed.push(candidate);
        break;
      }
      const adverbUnit = mapFrequencyAdverb(candidateLower);
      if (adverbUnit) {
        sawCadenceContinuation = true;
        consumed.push(candidate);
        periodUnit = adverbUnit;
        break;
      }
      const unit = mapIntervalUnit(candidateLower);
      if (unit) {
        if (!sawCue && (token.kind === LexKind.Number || token.kind === LexKind.NumberRange)) {
          return [];
        }
        sawCadenceContinuation = true;
        consumed.push(candidate);
        periodUnit = unit;
        break;
      }
      break;
    }
    if (!periodUnit) {
      if (valueMax !== undefined) return [];
      if (sawCue && sawCadenceContinuation && lower in FREQUENCY_SIMPLE_WORDS) {
        periodUnit = FhirPeriodUnit.Day;
      } else if (lower in FREQUENCY_SIMPLE_WORDS || sawCue) {
        return [
          lexicalSign({
            type: "schedule-sign",
            rule: "hpsg.lex.schedule.singleOccurrence",
            tokens: consumed,
            synsem: {
              head: { schedule: { count: value } },
              valence: {},
              cont: { clauseKind: "administration" }
            },
            score: 10
          })
        ];
      } else {
        return [];
      }
    }
    const normalizedPeriod = normalizePeriodValue(period, periodUnit);
    return [
      lexicalSign({
        type: "schedule-sign",
        rule: "hpsg.lex.schedule.frequency",
        tokens: consumed,
        synsem: {
          head: {
            schedule: {
              frequency: value,
              frequencyMax: valueMax,
              period: normalizedPeriod.value,
              periodUnit: normalizedPeriod.unit,
              when: recurringEvent ? [recurringEvent] : undefined,
              timingCode:
                valueMax === undefined &&
                value > 0 &&
                normalizedPeriod.value === 1 && normalizedPeriod.unit === FhirPeriodUnit.Day
                  ? timingCodeForDailyFrequency(value)
                  : undefined
            }
          },
          valence: {},
          cont: { clauseKind: "administration" }
        },
        score: 10
      })
    ];
  });
}

const ALTERNATE_EVENT_CADENCE_FIRST_TOKENS = new Set(
  ALTERNATE_EVENT_CADENCES.map((definition) => definition.parts[0]).filter(Boolean)
);

export function alternateEventCadenceRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.alternateEventCadence", (context, start) => {
    const first = context.tokens[start];
    if (!first || !ALTERNATE_EVENT_CADENCE_FIRST_TOKENS.has(first.canonical ?? first.lower)) return [];
    for (const definition of ALTERNATE_EVENT_CADENCES) {
      const tokens = tokensAvailable(context, start, definition.parts.length);
      if (!tokens) continue;
      if (!tokens.every((token, index) => normalizeTokenLower(token) === definition.parts[index])) continue;
      const periodUnit = mapIntervalUnit(definition.periodUnit);
      if (!periodUnit) continue;
      return [lexicalSign({
        type: "schedule-sign",
        rule: "hpsg.lex.schedule.alternateEventCadence",
        tokens,
        synsem: {
          head: {
            schedule: {
              period: definition.period,
              periodUnit,
              when: [definition.when]
            }
          },
          valence: {},
          cont: { clauseKind: "administration" }
        },
        score: 24 + tokens.length
      })];
    }
    return [];
  });
}

function shiftCalendarIsoDate(value: string, days: number): string | undefined {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return undefined;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return undefined;
  date.setUTCDate(date.getUTCDate() + days);
  const year = String(date.getUTCFullYear());
  const monthValue = String(date.getUTCMonth() + 1);
  const dayValue = String(date.getUTCDate());
  const month = monthValue.length < 2 ? `0${monthValue}` : monthValue;
  const day = dayValue.length < 2 ? `0${dayValue}` : dayValue;
  return `${year}-${month}-${day}`;
}

export function calendarDateListRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.calendarDateList", (context, start) => {
    const first = tokensAvailable(context, start, 1)?.[0];
    if (!first) return [];
    const match = context.dateSpans.find((span) => span.start === first.sourceStart);
    if (!match || match.unresolved || !match.events.length) return [];

    const members: Token[] = [];
    for (let cursor = start; cursor < context.limit; cursor += 1) {
      const token = context.tokens[cursor];
      if (!token || context.state.consumed.has(token.index)) break;
      if (token.sourceStart >= match.end) break;
      members.push(token);
    }
    if (!members.length || members[members.length - 1].sourceEnd > match.end) return [];

    let schedule: HpsgScheduleFeature | undefined;
    if (match.relation === "event") {
      schedule = { calendarEvents: match.events };
    } else {
      const event = match.events.length === 1 ? match.events[0] : undefined;
      if (!event) return [];
      if (match.relation === "start-inclusive") {
        schedule = { boundsStart: event.isoDate };
      } else if (match.relation === "start-exclusive") {
        const start = shiftCalendarIsoDate(event.isoDate, 1);
        if (!start) return [];
        schedule = { boundsStart: start };
      } else if (match.relation === "end-inclusive") {
        schedule = { boundsEnd: event.isoDate };
      } else if (match.relation === "end-exclusive") {
        const end = shiftCalendarIsoDate(event.isoDate, -1);
        if (!end) return [];
        schedule = { boundsEnd: end };
      }
    }
    if (!schedule) return [];
    // Calendar constituent itself owns the exact typed source span. Generic
    // HPSG projection can retain this provenance without a rule-name switch.
    schedule.sourceRanges = [{ start: match.start, end: match.end }];

    return [lexicalSign({
      type: "schedule-sign",
      rule: "hpsg.lex.schedule.calendarDateList",
      tokens: members,
      synsem: {
        head: { schedule },
        valence: {},
        cont: { clauseKind: "administration" }
      },
      score: 36 + members.length
    })];
  });
}

export function timingLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.timing", (context, start) => {
    const monthlyOrdinal = monthlyOrdinalWeekdaySign(context, start);
    if (monthlyOrdinal) return [monthlyOrdinal];
    const token = tokensAvailable(context, start, 1)?.[0];
    if (!token) {
      return [];
    }
    const lower = normalizeTokenLower(token);
    for (const parts of TIMING_ANAPHORA_PHRASES) {
      if (parts[0] !== lower) continue;
      const members = tokensAvailable(context, start, parts.length);
      if (!members || members.some((member, index) =>
        normalizeTokenLower(member) !== parts[index])) continue;
      const continuation = context.tokens[start + parts.length];
      const extended = continuation && !context.state.consumed.has(continuation.index) &&
        lexicalClasses.openEndedContinuationTokens.indexOf(normalizeTokenLower(continuation)) >= 0
        ? [...members, continuation] : members;
      return [lexicalSign({
        type: "schedule-sign",
        rule: "hpsg.lex.schedule.previousTimingReference",
        tokens: extended,
        synsem: {
          head: { schedule: { timingReference: "previous" } },
          valence: { instructions: [{
            text: context.state.input.slice(extended[0].sourceStart, extended[extended.length - 1].sourceEnd),
            evidence: [{ rule: "hpsg.lex.schedule.previousTimingReference",
              spans: [{ start: extended[0].sourceStart, end: extended[extended.length - 1].sourceEnd,
                text: context.state.input.slice(extended[0].sourceStart, extended[extended.length - 1].sourceEnd) }],
              scheduleFields: ["timingReference"] }]
          }] }, cont: { clauseKind: "administration" }
        },
        score: 32 + members.length
      })];
    }
    const abbreviationKey = lower.replace(/\./g, "");
    const descriptor = TIMING_ABBREVIATIONS[abbreviationKey];
    const followingCount = context.tokens[start + 1];
    const followingTimes = context.tokens[start + 2];
    const beginsCadenceFirstFrequency = Boolean(
      mapFrequencyAdverb(lower) &&
      exactCountCardinalValue(followingCount) !== undefined &&
      followingTimes &&
      FREQUENCY_TIMES_WORDS.has(normalizeTokenLower(followingTimes))
    );
    if (descriptor && !beginsCadenceFirstFrequency) {
      return [
        lexicalSign({
          type: "schedule-sign",
          rule: "hpsg.lex.schedule.timingAbbreviation",
          tokens: [token],
          synsem: {
            head: {
              schedule: {
                timingCode: descriptor.code,
                frequency: descriptor.frequency,
                frequencyMax: descriptor.frequencyMax,
                period: descriptor.period,
                periodMax: descriptor.periodMax,
                periodUnit: descriptor.periodUnit,
                when: descriptor.when ? descriptor.when.slice() : undefined
              }
            },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          warnings: descriptor.discouraged
            ? [`Avoid ambiguous timing abbreviation ${descriptor.discouraged}.`]
            : undefined,
          score: 8
        })
      ];
    }
    const weeklyWeekday = lower.match(/^weekly-(mon|tue|wed|thu|fri|sat|sun)$/u);
    if (weeklyWeekday) {
      return [
        lexicalSign({
          type: "schedule-sign",
          rule: "hpsg.lex.schedule.weekdayRecurrence",
          tokens: [token],
          synsem: {
            head: {
              schedule: {
                frequency: 1,
                period: 1,
                periodUnit: FhirPeriodUnit.Week,
                dayOfWeek: [weeklyWeekday[1] as FhirDayOfWeek]
              }
            },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: 18
        })
      ];
    }
    const wordFrequency = WORD_FREQUENCIES[lower];
    if (wordFrequency) {
      if (beginsCadenceFirstFrequency) {
        return [];
      }
      return [
        lexicalSign({
          type: "schedule-sign",
          rule: "hpsg.lex.schedule.wordFrequency",
          tokens: [token],
          synsem: {
            head: {
              schedule: {
                frequency: wordFrequency.frequency,
                period: 1,
                periodUnit: wordFrequency.periodUnit
              }
            },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: 7
        })
      ];
    }
    const when = EVENT_TIMING_TOKENS[lower];
    if (when) {
      // The same immediate lexeme cannot simultaneously schedule the whole
      // medication STAT and modify an explicit relative event. A typed
      // before/after + event daughter owns that atom compositionally.
      if (when === EventTiming.Immediate) {
        const relationToken = context.tokens[start + 1];
        if (relationToken &&
            mealRelationFromToken(normalizeTokenLower(relationToken)) &&
            resolveEventTimingExpression(eventExpressionPartsAt(context, start + 2).parts)) {
          return [];
        }
      }
      if (sourceRangeAttachmentClass(context, token.sourceStart, token.sourceEnd) === "procedure") {
        return [];
      }
      return [
        lexicalSign({
          type: "schedule-sign",
          rule: "hpsg.lex.schedule.eventTiming",
          tokens: [token],
          synsem: {
            head: { schedule: { when: [when] } },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: 6
        })
      ];
    }
    const days = getDayOfWeekMeaning(token);
    if (days) {
      return [
        lexicalSign({
          type: "schedule-sign",
          rule: "hpsg.lex.schedule.dayOfWeek",
          tokens: [token],
          synsem: {
            head: { schedule: { dayOfWeek: days } },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: 6
        })
      ];
    }
    return [];
  });
}

function mealTimingForRelation(
  relation: "before" | "after" | "with",
  meal: EventTiming
): EventTiming | undefined {
  return MEAL_TIMING_BY_RELATION.get(relation)?.get(meal);
}

function mealRelationFromToken(lower: string): "before" | "after" | "with" | undefined {
  return MEAL_RELATION_BY_TOKEN.get(lower);
}

const BASE_MEAL_EVENTS = new Set<EventTiming>([
  EventTiming.Breakfast,
  EventTiming.Lunch,
  EventTiming.Dinner
]);
const MEAL_ANCHOR_BY_DAYPART = new Map<EventTiming, EventTiming>();
for (const [daypart, members] of DOSE_TARGET_EVENT_MEMBERS) {
  const meal = members.find((member) => BASE_MEAL_EVENTS.has(member));
  if (!meal) continue;
  for (const member of members) {
    if (member === daypart || member.startsWith(`${daypart}.`)) {
      MEAL_ANCHOR_BY_DAYPART.set(member, meal);
    }
  }
}

function mealAnchorForDaypart(timing: EventTiming): EventTiming | undefined {
  return MEAL_ANCHOR_BY_DAYPART.get(timing);
}

/**
 * Thai commonly places a shared meal relation after its daypart daughters:
 * `เช้า เย็น หลังอาหาร`. The dayparts select breakfast/dinner and the shared
 * relation scopes over both, so they are two related meal events rather than
 * three independent administrations (MORN + EVE + PC).
 */
function daypartMealRelationSign(
  context: HpsgClauseContext,
  start: number
): HpsgSign | undefined {
  const previous = context.tokens[start - 1];
  const beforePrevious = context.tokens[start - 2];
  const previousEvent = previous && !context.state.consumed.has(previous.index)
    ? EVENT_TIMING_TOKENS[normalizeTokenLower(previous)]
    : undefined;
  const previousConnectorKind = previous
    ? coordinationConnectorKind(normalizeTokenLower(previous))
    : "unknown";
  const beforePreviousEvent = beforePrevious && !context.state.consumed.has(beforePrevious.index)
    ? EVENT_TIMING_TOKENS[normalizeTokenLower(beforePrevious)]
    : undefined;
  if (
    (previousEvent && mealAnchorForDaypart(previousEvent)) ||
    (
      previous &&
      (
        LIST_SEPARATORS.has(normalizeTokenLower(previous)) ||
        isThaiDaypartListSeparator(previous, beforePrevious, context.tokens[start]) ||
        previousConnectorKind !== "unknown"
      ) &&
      beforePreviousEvent && mealAnchorForDaypart(beforePreviousEvent)
    )
  ) return undefined;

  const tokens: Token[] = [];
  const mealAnchors: EventTiming[] = [];
  let cursor = start;

  while (cursor < context.limit) {
    const token = context.tokens[cursor];
    if (!token || context.state.consumed.has(token.index)) break;
    const event = EVENT_TIMING_TOKENS[normalizeTokenLower(token)];
    const mealAnchor = event ? mealAnchorForDaypart(event) : undefined;
    if (!mealAnchor || mealAnchors.indexOf(mealAnchor) !== -1) break;
    tokens.push(token);
    mealAnchors.push(mealAnchor);
    cursor += 1;

    const separator = context.tokens[cursor];
    const next = context.tokens[cursor + 1];
    const nextEvent = next && !context.state.consumed.has(next.index)
      ? EVENT_TIMING_TOKENS[normalizeTokenLower(next)]
      : undefined;
    const separatorKind = separator
      ? coordinationConnectorKind(normalizeTokenLower(separator))
      : "unknown";
    const joinsDayparts = Boolean(separator && (
      LIST_SEPARATORS.has(normalizeTokenLower(separator)) ||
      isThaiDaypartListSeparator(separator, token, next) ||
      separatorKind === "conjunction"
    ));
    if (
      separatorKind === "disjunction" && nextEvent && mealAnchorForDaypart(nextEvent)
    ) return undefined;
    if (
      separator && !context.state.consumed.has(separator.index) &&
      joinsDayparts &&
      nextEvent && mealAnchorForDaypart(nextEvent)
    ) {
      tokens.push(separator);
      cursor += 1;
    }
  }
  if (!mealAnchors.length) return undefined;

  const relationToken = context.tokens[cursor];
  if (!relationToken || context.state.consumed.has(relationToken.index)) return undefined;
  const relation = mealRelationFromToken(normalizeTokenLower(relationToken));
  if (!relation) return undefined;
  const relatedExpression = eventExpressionPartsAt(context, cursor + 1);
  const relatedEvent = resolveEventTimingExpression(relatedExpression.parts);
  if (!relatedEvent || relatedEvent.timing !== EventTiming.Meal) return undefined;

  const when: EventTiming[] = [];
  for (const meal of mealAnchors) {
    const timing = mealTimingForRelation(relation, meal);
    if (!timing) return undefined;
    when.push(timing);
  }
  const frequency = when.length;
  const matched = [
    ...tokens,
    relationToken,
    ...relatedExpression.members.slice(0, relatedEvent.length)
  ];
  return lexicalSign({
    type: "schedule-sign",
    rule: "hpsg.lex.schedule.eventPhrase.daypartMealRelation",
    tokens: matched,
    synsem: {
      head: {
        schedule: {
          frequency,
          period: 1,
          periodUnit: FhirPeriodUnit.Day,
          timingCode: timingCodeForDailyFrequency(frequency),
          when
        }
      },
      valence: {},
      cont: { clauseKind: "administration" }
    },
    // Prefer the maximal scoped construction over independent bare dayparts.
    score: 34 + matched.length
  });
}

function eventExpressionPartsAt(
  context: HpsgClauseContext,
  start: number
): { parts: string[]; members: Token[] } {
  const parts: string[] = [];
  const members: Token[] = [];
  for (let offset = 0; offset < MAX_EVENT_TIMING_EXPRESSION_PARTS; offset += 1) {
    const member = context.tokens[start + offset];
    if (!member || context.state.consumed.has(member.index)) break;
    members.push(member);
    parts.push(normalizeTokenLower(member));
  }
  return { parts, members };
}

interface CoordinatedRelatedEvents {
  timings: EventTiming[];
  members: Token[];
  next: number;
}

/**
 * Compose a relation-scoped list of event daughters. English commonly names
 * every meal (`breakfast, lunch and dinner`), while Thai commonly shares the
 * nominal head (`อาหารเช้า กลางวัน และเย็น`). Both are the same typed list;
 * disjunction remains outside this conjunctive construction.
 */
function coordinatedRelatedEventsAt(
  context: HpsgClauseContext,
  start: number,
  relation: "before" | "after" | "with"
): CoordinatedRelatedEvents | undefined {
  const firstExpression = eventExpressionPartsAt(context, start);
  const firstResolved = resolveEventTimingExpression(firstExpression.parts);
  const firstTiming = firstResolved
    ? mealTimingForRelation(relation, firstResolved.timing)
    : undefined;
  if (!firstResolved || !firstTiming) return undefined;

  const sharedHead = firstResolved.length > 1
    ? firstExpression.parts.slice(0, firstResolved.length - 1)
    : [];
  const timings: EventTiming[] = [firstTiming];
  const members = firstExpression.members.slice(0, firstResolved.length);
  let inheritedRelation = relation;
  let cursor = start + firstResolved.length;

  while (cursor < context.limit) {
    const connectors: Token[] = [];
    let tailStart = cursor;
    const separator = context.tokens[tailStart];
    const separatorLower = separator ? normalizeTokenLower(separator) : "";
    if (separator && !context.state.consumed.has(separator.index) &&
        (LIST_SEPARATORS.has(separatorLower) ||
         isThaiDaypartListSeparator(separator, members[members.length - 1], context.tokens[tailStart + 1]))) {
      if (coordinationConnectorKind(separatorLower) === "disjunction") break;
      connectors.push(separator);
      tailStart += 1;
      const followingConnector = context.tokens[tailStart];
      const followingLower = followingConnector
        ? normalizeTokenLower(followingConnector)
        : "";
      if (separator.original === "," && followingConnector &&
          !context.state.consumed.has(followingConnector.index) &&
          coordinationConnectorKind(followingLower) === "conjunction") {
        connectors.push(followingConnector);
        tailStart += 1;
      }
    }

    // Clinical lists may omit commas/conjunctions (pc breakfast lunch dinner).
    // The next daughter must still resolve as a meal event; another dosage
    // or unrelated advice therefore terminates this constituent naturally.
    const tailExpression = eventExpressionPartsAt(context, tailStart);
    const direct = resolveEventTimingExpression(tailExpression.parts);
    // An overt relation starts its own coordinated phrase. Only an omitted
    // relation inherits from the nearest source head (before breakfast,
    // after lunch and dinner), never from the first phrase unconditionally.
    const tailRelation = mealRelationFromToken(tailExpression.parts[0] ?? "") ?? inheritedRelation;
    let consumed = direct?.length ?? 0;
    let timing = direct ? mealTimingForRelation(tailRelation, direct.timing) : undefined;
    if (!timing && sharedHead.length && tailExpression.parts.length) {
      const synthetic = [...sharedHead, tailExpression.parts[0]];
      const resolved = resolveEventTimingExpression(synthetic);
      if (resolved?.length === synthetic.length) {
        timing = mealTimingForRelation(tailRelation, resolved.timing);
        consumed = 1;
      }
    }
    if (!timing || consumed < 1 || timings.indexOf(timing) !== -1) break;
    members.push(...connectors, ...tailExpression.members.slice(0, consumed));
    timings.push(timing);
    inheritedRelation = tailRelation;
    cursor = tailStart + consumed;
  }
  return timings.length > 1 ? { timings, members, next: cursor } : undefined;
}

function coordinatedRelatedEventSign(
  context: HpsgClauseContext,
  start: number,
  relation: "before" | "after" | "with"
): HpsgSign | undefined {
  const relationToken = context.tokens[start];
  if (!relationToken || context.state.consumed.has(relationToken.index)) return undefined;
  const list = coordinatedRelatedEventsAt(context, start + 1, relation);
  if (!list) return undefined;
  const members = [relationToken, ...list.members];
  return lexicalSign({
    type: "schedule-sign",
    rule: "hpsg.lex.schedule.eventPhrase.coordinatedHeadEllipsis",
    tokens: members,
    synsem: {
      head: { schedule: { when: list.timings } },
      valence: {},
      cont: { clauseKind: "administration" }
    },
    // Coordinated head ellipsis is a single, more specific construction than
    // independently attaching the first meal phrase and a bare daypart.
    score: 28 + members.length
  });
}

function eventOffsetLeadLength(
  context: HpsgClauseContext,
  start: number,
  sequences: readonly (readonly string[])[]
): number {
  for (const sequence of sequences) {
    let matches = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      const token = context.tokens[start + offset];
      if (
        !token ||
        context.state.consumed.has(token.index) ||
        normalizeTokenLower(token) !== sequence[offset]
      ) {
        matches = false;
        break;
      }
    }
    if (matches) return sequence.length;
  }
  return 0;
}

const EVENT_OFFSET_BOUND_LEADS = new Set([
  ...EVENT_OFFSET_MINIMUM_LEAD_SEQUENCES.map((sequence) => sequence[0]),
  ...EVENT_OFFSET_MAXIMUM_LEAD_SEQUENCES.map((sequence) => sequence[0])
].filter((value): value is string => Boolean(value)));

function eventOffsetMinutes(value: number, unit: FhirPeriodUnit): number | undefined {
  const minutes = unit === FhirPeriodUnit.Minute
    ? value
    : unit === FhirPeriodUnit.Hour
      ? value * 60
      : unit === FhirPeriodUnit.Day
        ? value * 24 * 60
        : unit === FhirPeriodUnit.Second
          ? value / 60
          : undefined;
  if (minutes === undefined || !Number.isFinite(minutes) || minutes < 0) return undefined;
  const seconds = minutes * 60;
  const roundedSeconds = Math.round(seconds);
  if (Math.abs(seconds - roundedSeconds) > 1e-9) return undefined;
  return roundedSeconds / 60;
}

function semanticActivityWindowAt(
  context: HpsgClauseContext,
  start: number
) {
  for (const definition of ADMINISTRATION_WINDOW_INSTRUCTIONS) {
    if (!definition.relation || !definition.activity) continue;
    const tokens = tokensAvailable(context, start, definition.parts.length);
    if (!tokens) continue;
    if (!tokens.every((token, index) => normalizeTokenLower(token) === definition.parts[index])) continue;
    return { definition, tokens };
  }
  return undefined;
}

export function quantityFirstActivityTimingRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.activityTiming.quantityFirst", (context, start) => {
    const first = context.tokens[start];
    if (!first || context.state.consumed.has(first.index)) return [];
    const firstLower = normalizeTokenLower(first);
    const canStartWithValue =
      (first.kind === LexKind.Number && first.value !== undefined) ||
      EVENT_OFFSET_FRACTIONS.has(firstLower);
    if (!canStartWithValue && !EVENT_OFFSET_BOUND_LEADS.has(firstLower)) return [];

    let cursor = start;
    const minimumLead = eventOffsetLeadLength(context, cursor, EVENT_OFFSET_MINIMUM_LEAD_SEQUENCES);
    const maximumLead = minimumLead ? 0 : eventOffsetLeadLength(context, cursor, EVENT_OFFSET_MAXIMUM_LEAD_SEQUENCES);
    cursor += minimumLead || maximumLead;
    const valueToken = context.tokens[cursor];
    if (!valueToken || context.state.consumed.has(valueToken.index)) return [];
    const value = valueToken.kind === LexKind.Number && valueToken.value !== undefined
      ? valueToken.value
      : EVENT_OFFSET_FRACTIONS.get(normalizeTokenLower(valueToken));
    if (value === undefined) return [];

    let unitIndex = cursor + 1;
    const article = context.tokens[unitIndex];
    if (article && EVENT_OFFSET_ARTICLES.has(normalizeTokenLower(article))) unitIndex += 1;
    const unitToken = context.tokens[unitIndex];
    if (!unitToken || context.state.consumed.has(unitToken.index)) return [];
    const unit = mapIntervalUnit(normalizeTokenLower(unitToken));
    if (!unit) return [];
    const minutes = eventOffsetMinutes(value, unit);
    if (minutes === undefined) return [];

    const window = semanticActivityWindowAt(context, unitIndex + 1);
    if (!window) return [];
    const activityKey = window.definition.activity;
    const relation = window.definition.relation;
    if (!activityKey || !relation) return [];
    const activity = resolveMedicationInstructionConcept(activityKey, context.options);
    if (!activity) return [];
    const activityTiming = {
      relation,
      activity: {
        text: activity.display,
        i18n: activity.i18n ? { ...activity.i18n } : undefined,
        coding: medicationInstructionConceptCodings(activity)[0]
      },
      ...(minimumLead ? { offsetMin: minutes } : maximumLead ? { offsetMax: minutes } : { offset: minutes })
    };
    const tokens = [
      ...context.tokens.slice(start, cursor),
      valueToken,
      ...(unitIndex > cursor + 1 && article ? [article] : []),
      unitToken,
      ...window.tokens
    ];
    return [lexicalSign({
      type: "schedule-sign",
      rule: "hpsg.lex.schedule.activityTiming.quantityFirst",
      tokens,
      synsem: {
        head: { schedule: { activityTiming: [activityTiming] } },
        valence: {},
        cont: { clauseKind: "administration" }
      },
      score: 52 + tokens.length
    })];
  });
}

/**
 * Quantity-first event offsets are the ordinary English inverse of
 * relation-first forms: `30 min before breakfast`, `half an hour after food`.
 * They project to the same canonical event-offset feature as `before meals
 * 30 minutes`, so ordering is grammar rather than a separate semantic model.
 */
/** Immediate modifies a RELATIVE event when it governs before/after + event.
 * It is zero distance from that event, not an additional stat administration.
 */
function zeroEventOffsetSign(context: HpsgClauseContext, start: number): HpsgSign | undefined {
  const immediate = context.tokens[start];
  const relationToken = context.tokens[start + 1];
  if (!immediate || !relationToken || context.state.consumed.has(immediate.index) ||
      context.state.consumed.has(relationToken.index) ||
      EVENT_TIMING_TOKENS[normalizeTokenLower(immediate)] !== EventTiming.Immediate) {
    return undefined;
  }
  const relation = mealRelationFromToken(normalizeTokenLower(relationToken));
  if (relation !== "before" && relation !== "after") return undefined;
  const expression = eventExpressionPartsAt(context, start + 2);
  const event = resolveEventTimingExpression(expression.parts);
  const timing = event && mealTimingForRelation(relation, event.timing);
  if (!event || !timing) return undefined;
  const tokens = [immediate, relationToken, ...expression.members.slice(0, event.length)];
  const events: EventTiming[] = [timing];
  let cursor = start + 2 + event.length;
  while (cursor + 1 < context.limit) {
    const connective = context.tokens[cursor];
    if (!connective || context.state.consumed.has(connective.index)) break;
    const connector = normalizeTokenLower(connective);
    if (!LIST_SEPARATORS.has(connector) ||
        coordinationConnectorKind(connector) === "disjunction") break;
    // Homogeneous coordinated event daughters inherit the leading exact
    // zero offset. Their event anchors remain individually typed; OR remains
    // a choice and is NOT flattened into multiple simultaneous events.
    let tailStart = cursor + 1;
    const firstTail = context.tokens[tailStart];
    if (!firstTail || context.state.consumed.has(firstTail.index)) break;
    const firstKey = normalizeTokenLower(firstTail);
    const explicitImmediacy = EVENT_TIMING_TOKENS[firstKey] === EventTiming.Immediate;
    if (explicitImmediacy) {
      const secondTail = context.tokens[tailStart + 1];
      if (!secondTail || context.state.consumed.has(secondTail.index) ||
          mealRelationFromToken(normalizeTokenLower(secondTail)) !== relation) break;
      tailStart += 2;
    } else if (mealRelationFromToken(firstKey) === relation) {
      tailStart += 1;
    }
    const tailExpression = eventExpressionPartsAt(context, tailStart);
    const tailEvent = resolveEventTimingExpression(tailExpression.parts);
    const tailTiming = tailEvent && mealTimingForRelation(relation, tailEvent.timing);
    if (!tailEvent || !tailTiming) break;
    const prefixes = context.tokens.slice(cursor + 1, tailStart);
    if (prefixes.some(token => context.state.consumed.has(token.index))) break;
    tokens.push(connective, ...prefixes, ...tailExpression.members.slice(0, tailEvent.length));
    events.push(tailTiming);
    cursor = tailStart + tailEvent.length;
  }
  return lexicalSign({
    type: "schedule-sign", rule: "hpsg.lex.schedule.eventOffset.immediate",
    tokens, synsem: { head: { schedule: { when: events, offset: 0 } },
      valence: {}, cont: { clauseKind: "administration" } },
    score: 42 + tokens.length
  });
}

export function quantityFirstEventOffsetRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.eventOffset.quantityFirst", (context, start) => {
    const zero = zeroEventOffsetSign(context, start);
    if (zero) return [zero];
    const first = context.tokens[start];
    if (!first || context.state.consumed.has(first.index)) return [];
    const firstLower = normalizeTokenLower(first);
    const canStartWithValue =
      (first.kind === LexKind.Number && first.value !== undefined) ||
      EVENT_OFFSET_FRACTIONS.has(firstLower);
    if (!canStartWithValue && !EVENT_OFFSET_BOUND_LEADS.has(firstLower)) return [];
    let cursor = start;
    const minimumLead = eventOffsetLeadLength(context, cursor, EVENT_OFFSET_MINIMUM_LEAD_SEQUENCES);
    const maximumLead = minimumLead
      ? 0
      : eventOffsetLeadLength(context, cursor, EVENT_OFFSET_MAXIMUM_LEAD_SEQUENCES);
    const qualifierLength = minimumLead || maximumLead;
    cursor += qualifierLength;

    const valueToken = context.tokens[cursor];
    if (!valueToken || context.state.consumed.has(valueToken.index)) return [];
    const value = valueToken.kind === LexKind.Number && valueToken.value !== undefined
      ? valueToken.value
      : EVENT_OFFSET_FRACTIONS.get(normalizeTokenLower(valueToken));
    if (value === undefined) return [];

    let unitIndex = cursor + 1;
    const possibleArticle = context.tokens[unitIndex];
    if (possibleArticle && EVENT_OFFSET_ARTICLES.has(normalizeTokenLower(possibleArticle))) {
      unitIndex += 1;
    }
    const unitToken = context.tokens[unitIndex];
    if (!unitToken || context.state.consumed.has(unitToken.index)) return [];
    const unit = mapIntervalUnit(normalizeTokenLower(unitToken));
    if (!unit) return [];
    const minutes = eventOffsetMinutes(value, unit);
    if (minutes === undefined) return [];

    const relationIndex = unitIndex + 1;
    const relationToken = context.tokens[relationIndex];
    if (!relationToken || context.state.consumed.has(relationToken.index)) return [];
    const relation = mealRelationFromToken(normalizeTokenLower(relationToken));
    if (relation !== "before" && relation !== "after") return [];

    const relatedExpression = eventExpressionPartsAt(context, relationIndex + 1);
    const resolvedEvent = resolveEventTimingExpression(relatedExpression.parts);
    const timing = resolvedEvent
      ? mealTimingForRelation(relation, resolvedEvent.timing)
      : undefined;
    if (!resolvedEvent || !timing) return [];
    const coordinated = coordinatedRelatedEventsAt(context, relationIndex + 1, relation);
    const timings = coordinated?.timings ?? [timing];
    const eventTokens = coordinated?.members ??
      relatedExpression.members.slice(0, resolvedEvent.length);

    const tokens = [
      ...context.tokens.slice(start, cursor),
      valueToken,
      ...(unitIndex > cursor + 1 ? [possibleArticle] : []),
      unitToken,
      relationToken,
      ...eventTokens
    ].filter((token): token is Token => Boolean(token));
    const schedule = minimumLead
      ? { when: timings, offsetMin: minutes }
      : maximumLead
        ? { when: timings, offsetMax: minutes }
        : { when: timings, offset: minutes };

    return [lexicalSign({
      type: "schedule-sign",
      rule: "hpsg.lex.schedule.eventOffset.quantityFirst",
      tokens,
      synsem: {
        head: { schedule },
        valence: {},
        cont: { clauseKind: "administration" }
      },
      // This maximal offset+event-list constituent must outrank the otherwise
      // compatible bare-duration plus relation-list analysis.
      score: 52 + tokens.length
    })];
  });
}

/**
 * Relative event offsets are timing semantics, not treatment duration.
 * `ก่อนอาหารอย่างน้อยครึ่งชั่วโมง` becomes Before Meal + offsetMin 30 min.
 */
export function eventOffsetRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.eventOffset", (context, start) => {
    const relationToken = tokensAvailable(context, start, 1)?.[0];
    if (!relationToken) return [];
    const relation = mealRelationFromToken(normalizeTokenLower(relationToken));
    if (relation !== "before" && relation !== "after") return [];

    const relatedExpression = eventExpressionPartsAt(context, start + 1);
    const resolvedEvent = resolveEventTimingExpression(relatedExpression.parts);
    if (!resolvedEvent) return [];
    const timing = mealTimingForRelation(relation, resolvedEvent.timing);
    if (!timing) return [];
    const coordinated = coordinatedRelatedEventsAt(context, start + 1, relation);
    const timings = coordinated?.timings ?? [timing];
    const eventTokens = coordinated?.members ??
      relatedExpression.members.slice(0, resolvedEvent.length);
    let cursor = coordinated?.next ?? start + 1 + resolvedEvent.length;

    const minimumLead = eventOffsetLeadLength(context, cursor, EVENT_OFFSET_MINIMUM_LEAD_SEQUENCES);
    const maximumLead = minimumLead
      ? 0
      : eventOffsetLeadLength(context, cursor, EVENT_OFFSET_MAXIMUM_LEAD_SEQUENCES);
    const qualifierLength = minimumLead || maximumLead;
    cursor += qualifierLength;

    const valueToken = context.tokens[cursor];
    if (!valueToken || context.state.consumed.has(valueToken.index)) return [];
    if (!qualifierLength &&
        EVENT_TIMING_TOKENS[normalizeTokenLower(valueToken)] === EventTiming.Immediate) {
      const tokens = [relationToken, ...eventTokens, valueToken];
      return [lexicalSign({
        type: "schedule-sign", rule: "hpsg.lex.schedule.eventOffset.immediate",
        tokens, synsem: { head: { schedule: { when: timings, offset: 0 } },
          valence: {}, cont: { clauseKind: "administration" } },
        score: 42 + tokens.length
      })];
    }
    const value = valueToken.kind === LexKind.Number && valueToken.value !== undefined
      ? valueToken.value
      : EVENT_OFFSET_FRACTIONS.get(normalizeTokenLower(valueToken));
    if (value === undefined) return [];

    let unitIndex = cursor + 1;
    const possibleArticle = context.tokens[unitIndex];
    if (possibleArticle && EVENT_OFFSET_ARTICLES.has(normalizeTokenLower(possibleArticle))) {
      unitIndex += 1;
    }
    const unitToken = context.tokens[unitIndex];
    if (!unitToken || context.state.consumed.has(unitToken.index)) return [];
    const unit = mapIntervalUnit(normalizeTokenLower(unitToken));
    if (!unit) return [];
    // A whole-day constituent following a recurring meal anchor is an
    // ordinary course adjunct (`หลังอาหาร 7 วัน`), not a displacement from
    // every meal. Fractional-day meal offsets remain explicit offsets, and
    // quantity-first event/activity offsets retain day-scale support.
    if (!qualifierLength && unit === FhirPeriodUnit.Day && Number.isInteger(value) && value >= 1) {
      return [];
    }
    const minutes = eventOffsetMinutes(value, unit);
    if (minutes === undefined) return [];

    const tokens = [
      relationToken,
      ...eventTokens,
      ...context.tokens.slice(coordinated?.next ?? start + 1 + resolvedEvent.length, cursor),
      valueToken,
      ...(unitIndex > cursor + 1 ? [possibleArticle] : []),
      unitToken
    ].filter((token): token is Token => Boolean(token));
    const schedule = minimumLead
      ? { when: timings, offsetMin: minutes }
      : maximumLead
        ? { when: timings, offsetMax: minutes }
        : { when: timings, offset: minutes };

    return [lexicalSign({
      type: "schedule-sign",
      rule: "hpsg.lex.schedule.eventOffset",
      tokens,
      synsem: {
        head: { schedule },
        valence: {},
        cont: { clauseKind: "administration" }
      },
      // Prefer one exact event-offset constituent over an invented treatment
      // duration composed beside a relation-scoped event list.
      score: 52 + tokens.length
    })];
  });
}

export function eventTimingPhraseRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.eventPhrase", (context, start) => {
    const first = tokensAvailable(context, start, 1)?.[0];
    if (!first) {
      return [];
    }
    const firstLower = normalizeTokenLower(first);
    const signs: HpsgSign[] = [];

    const second = context.tokens[start + 1];
    const secondLower = second && !context.state.consumed.has(second.index)
      ? normalizeTokenLower(second)
      : undefined;

    const eventExpression = eventExpressionPartsAt(context, start);
    const fixedPhrase = resolveEventTimingExpression(eventExpression.parts);
    if (fixedPhrase && fixedPhrase.length > 1) {
      signs.push(
        lexicalSign({
          type: "schedule-sign",
          rule: "hpsg.lex.schedule.eventPhrase.fixed",
          tokens: eventExpression.members.slice(0, fixedPhrase.length),
          synsem: {
            head: { schedule: { when: [fixedPhrase.timing] } },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: 13 + fixedPhrase.length
        })
      );
    }
    if (fixedPhrase && mealAnchorForDaypart(fixedPhrase.timing)) {
      const daypartMealRelation = daypartMealRelationSign(context, start);
      if (daypartMealRelation) signs.push(daypartMealRelation);
    }

    if ((EVENT_PREPOSITIONS.has(firstLower) || EVERY_INTERVAL_TOKENS.has(firstLower)) && secondLower) {
      const third = context.tokens[start + 2];
      const thirdLower = third && !context.state.consumed.has(third.index)
        ? normalizeTokenLower(third)
        : undefined;
      const direct = EVENT_TIMING_TOKENS[secondLower];
      const withArticle = secondLower && EVENT_ARTICLE_TOKENS.has(secondLower) && thirdLower
        ? EVENT_TIMING_TOKENS[thirdLower]
        : undefined;
      const when = direct ?? withArticle;
      if (when) {
        const tokens = withArticle && third ? [first, second, third] : [first, second];
        signs.push(
          lexicalSign({
            type: "schedule-sign",
            rule: "hpsg.lex.schedule.eventPhrase.preposition",
            tokens,
            synsem: {
              head: { schedule: { when: [when] } },
              valence: {},
              cont: { clauseKind: "administration" }
            },
            score: 14 + tokens.length
          })
        );
      }
    }

    const relation = mealRelationFromToken(firstLower);
    if (relation) {
      const coordinated = coordinatedRelatedEventSign(context, start, relation);
      if (coordinated) signs.push(coordinated);
    }
    let combinedMealTiming: EventTiming | undefined;
    if (relation && secondLower) {
      const relatedExpression = eventExpressionPartsAt(context, start + 1);
      const resolvedEvent = resolveEventTimingExpression(relatedExpression.parts);
      combinedMealTiming = resolvedEvent
        ? mealTimingForRelation(relation, resolvedEvent.timing)
        : undefined;
      if (combinedMealTiming && resolvedEvent) {
        signs.push(
          lexicalSign({
            type: "schedule-sign",
            rule: "hpsg.lex.schedule.eventPhrase.mealRelation",
            tokens: [first, ...relatedExpression.members.slice(0, resolvedEvent.length)],
            synsem: {
              head: { schedule: { when: [combinedMealTiming] } },
              valence: {},
              cont: { clauseKind: "administration" }
            },
            score: 15 + resolvedEvent.length
          })
        );
      }
      if (SLEEP_EVENT_ALIASES.has(secondLower) && relation === MEAL_RELATION_BY_TOKEN.get("before")) {
        signs.push(
          lexicalSign({
            type: "schedule-sign",
            rule: "hpsg.lex.schedule.eventPhrase.beforeSleep",
            tokens: [first, second],
            synsem: {
              head: { schedule: { when: [EventTiming["Before Sleep"]] } },
              valence: {},
              cont: { clauseKind: "administration" }
            },
            score: 16
          })
        );
      }
      if (WAKE_EVENT_ALIASES.has(secondLower) && relation === MEAL_RELATION_BY_TOKEN.get("after")) {
        signs.push(
          lexicalSign({
            type: "schedule-sign",
            rule: "hpsg.lex.schedule.eventPhrase.afterWake",
            tokens: [first, second],
            synsem: {
              head: { schedule: { when: [EventTiming.Wake] } },
              valence: {},
              cont: { clauseKind: "administration" }
            },
            score: 16
          })
        );
      }
    }

    if (!combinedMealTiming && relation && secondLower && FOOD_EVENT_ALIASES.has(secondLower)) {
      const combined = relation === MEAL_RELATION_BY_TOKEN.get("before")
        ? EventTiming["Before Meal"]
        : relation === MEAL_RELATION_BY_TOKEN.get("after")
          ? EventTiming["After Meal"]
          : EventTiming.Meal;
      signs.push(
        lexicalSign({
          type: "schedule-sign",
          rule: "hpsg.lex.schedule.eventPhrase.foodRelation",
          tokens: [first, second],
          synsem: {
            head: { schedule: { when: [combined] } },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: 16
        })
      );
    }

    return signs.filter((sign) => {
      if (!sign.tokens.length) return true;
      const firstToken = sign.tokens[0];
      const lastToken = sign.tokens[sign.tokens.length - 1];
      return sourceRangeAttachmentClass(
        context, firstToken.sourceStart, lastToken.sourceEnd
      ) !== "procedure";
    });
  });
}

const DAY_ORDER = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun"
] as const;

function dayFromSurface(surface: string): FhirDayOfWeek | undefined {
  const normalized = surface.toLowerCase().replace(/[.]/g, "");
  const day = DAY_OF_WEEK_TOKENS[normalized];
  return day;
}

function expandDayRange(
  startDay: FhirDayOfWeek,
  endDay: FhirDayOfWeek
): FhirDayOfWeek[] {
  const startIndex = DAY_ORDER.indexOf(startDay as typeof DAY_ORDER[number]);
  const endIndex = DAY_ORDER.indexOf(endDay as typeof DAY_ORDER[number]);
  if (startIndex < 0 || endIndex < 0) {
    return [];
  }
  const result: FhirDayOfWeek[] = [];
  let cursor = startIndex;
  while (true) {
    result.push(DAY_ORDER[cursor] as FhirDayOfWeek);
    if (cursor === endIndex) {
      break;
    }
    cursor = (cursor + 1) % DAY_ORDER.length;
  }
  return result;
}

export function dayRangeLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.dayRange", (context, start) => {
    const first = tokensAvailable(context, start, 1)?.[0];
    if (!first) {
      return [];
    }
    const firstLower = normalizeTokenLower(first);
    const abbreviation = (lexicalClasses.clinicalWeekdayAbbreviations as Record<string, FhirDayOfWeek[]>)[firstLower];
    if (abbreviation) return [lexicalSign({
      type: "schedule-sign", rule: "hpsg.lex.schedule.clinicalWeekdayAbbreviation",
      tokens: [first],
      synsem: { head: { schedule: { dayOfWeek: [...abbreviation] } }, valence: {}, cont: { clauseKind: "administration" } },
      score: 13
    })];
    const next = context.tokens[start + 1];
    if (EVERY_INTERVAL_TOKENS.has(firstLower) && next && dayFromSurface(normalizeTokenLower(next))) {
      return [lexicalSign({
        type: "schedule-sign", rule: "hpsg.lex.schedule.distributiveWeekday",
        tokens: [first, next],
        synsem: { head: { schedule: { dayOfWeek: [dayFromSurface(normalizeTokenLower(next))!] } }, valence: {}, cont: {} },
        score: 16
      })];
    }
    const hyphenParts = firstLower.split("-");
    // Two endpoints designate a range; three or more named weekdays are
    // an enumeration (Mon-Wed-Fri), just like a slash-separated day list.
    const slashParts = hyphenParts.length > 2
      ? hyphenParts : splitByLexicalSeparators(firstLower, COMPACT_LIST_SEPARATORS);
    if (slashParts.length > 1) {
      const days = slashParts.map(dayFromSurface);
      if (days.every(Boolean)) {
        return [
          lexicalSign({
            type: "schedule-sign",
            rule: "hpsg.lex.schedule.dayList.compact",
            tokens: [first],
            synsem: {
              head: { schedule: { dayOfWeek: days as FhirDayOfWeek[] } },
              valence: {},
              cont: { clauseKind: "administration" }
            },
            score: 13
          })
        ];
      }
    }
    const compactRange = firstLower.match(/^(.+)-(.+)$/);
    if (compactRange) {
      const startDay = dayFromSurface(compactRange[1]);
      const endDay = dayFromSurface(compactRange[2]);
      if (startDay && endDay) {
        return [
          lexicalSign({
            type: "schedule-sign",
            rule: "hpsg.lex.schedule.dayRange.compact",
            tokens: [first],
            synsem: {
              head: { schedule: { dayOfWeek: expandDayRange(startDay, endDay) } },
              valence: {},
              cont: { clauseKind: "administration" }
            },
            score: 20
          })
        ];
      }
    }

    const firstDay = dayFromSurface(firstLower);
    const connector = context.tokens[start + 1];
    const second = context.tokens[start + 2];
    const connectorLower = connector && !context.state.consumed.has(connector.index)
      ? normalizeTokenLower(connector)
      : undefined;
    const secondDay = second && !context.state.consumed.has(second.index)
      ? dayFromSurface(normalizeTokenLower(second))
      : undefined;
    if (firstDay && secondDay && connectorLower && DAY_RANGE_CONNECTORS.has(connectorLower)) {
      return [
        lexicalSign({
          type: "schedule-sign",
          rule: "hpsg.lex.schedule.dayRange.spelled",
          tokens: [first, connector, second],
          synsem: {
            head: { schedule: { dayOfWeek: expandDayRange(firstDay, secondDay) } },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: 20
        })
      ];
    }
    return [];
  });
}

function timingRangeIsProcedureLocalDuration(
  context: HpsgClauseContext,
  start: number,
  end: number
): boolean {
  for (const frame of getProceduralFrames(context)) {
    const definition = resolveMedicationInstructionAction(frame.predicate.lemma, context.options);
    if (definition?.procedural) {
      for (const arg of frame.args) {
        if (arg.role !== AdviceArgumentRole.Duration || !arg.span) continue;
        if (arg.span.start <= start && end <= arg.span.end) return true;
      }
      continue;
    }
    if (
      definition?.administrationMethod?.code &&
      frame.span.start <= start && end <= frame.span.end
    ) {
      const earlierAdministration = context.tokens.some((candidate) => {
        if (candidate.sourceEnd > frame.span.start) return false;
        return Boolean(
          resolveMedicationInstructionAction(
            normalizeTokenLower(candidate), context.options
          )?.administrationMethod?.code
        );
      });
      if (earlierAdministration) return true;
    }
  }
  return false;
}

const MAXIMUM_COUNT_LEAD_FIRST_TOKENS = new Set(
  MAXIMUM_COUNT_LEAD_SEQUENCES.map((parts) => parts[0]).filter(Boolean)
);

function maximumCountLeadAt(context: HpsgClauseContext, start: number): Token[] | undefined {
  for (const parts of MAXIMUM_COUNT_LEAD_SEQUENCES) {
    const tokens = tokensAvailable(context, start, parts.length);
    if (!tokens) continue;
    if (tokens.every((candidate, offset) => normalizeTokenLower(candidate) === parts[offset])) {
      return tokens;
    }
  }
  return undefined;
}

function occurrenceCapPeriodAt(
  context: HpsgClauseContext,
  start: number
): { tokens: Token[]; period: number; periodUnit: FhirPeriodUnit } | undefined {
  const adverb = tokensAvailable(context, start, 1)?.[0];
  const adverbUnit = adverb ? mapFrequencyAdverb(normalizeTokenLower(adverb)) : undefined;
  if (adverb && adverbUnit) return { tokens: [adverb], period: 1, periodUnit: adverbUnit };
  for (const definition of OCCURRENCE_CAP_PERIOD_PHRASES) {
    const tokens = tokensAvailable(context, start, definition.parts.length);
    if (!tokens) continue;
    if (!tokens.every((candidate, offset) => normalizeTokenLower(candidate) === definition.parts[offset])) continue;
    const periodUnit = mapIntervalUnit(definition.periodUnit);
    if (!periodUnit) continue;
    return { tokens, period: definition.period, periodUnit };
  }
  return undefined;
}

function maximumDosePeriodAt(
  context: HpsgClauseContext,
  start: number
): { tokens: Token[]; period: number; periodUnit: FhirPeriodUnit } | undefined {
  const defined = occurrenceCapPeriodAt(context, start);
  if (defined) return defined;

  const connector = context.tokens[start];
  const unitToken = context.tokens[start + 1];
  if (!connector || !unitToken ||
      context.state.consumed.has(connector.index) ||
      context.state.consumed.has(unitToken.index)) return undefined;
  const connectorLower = normalizeTokenLower(connector);
  if (MAXIMUM_PERIOD_PREPOSITIONS.has(connectorLower)) {
    let cursor = start + 1;
    const article = context.tokens[cursor];
    if (article && !context.state.consumed.has(article.index) &&
        ["a", "an", "the"].indexOf(normalizeTokenLower(article)) >= 0) cursor++;
    const modifier = context.tokens[cursor];
    if (modifier && !context.state.consumed.has(modifier.index) &&
        MAXIMUM_PERIOD_MODIFIERS.has(normalizeTokenLower(modifier))) cursor++;
    const value = context.tokens[cursor];
    const unit = context.tokens[cursor + 1];
    const amount = value?.kind === LexKind.Number ? value.value
      : value ? FREQUENCY_NUMBER_WORDS[normalizeTokenLower(value)] : undefined;
    const periodUnit = unit && mapIntervalUnit(normalizeTokenLower(unit));
    if (amount !== undefined && amount > 0 && periodUnit &&
        value && unit && !context.state.consumed.has(value.index) && !context.state.consumed.has(unit.index)) {
      return { tokens: context.tokens.slice(start, cursor + 2), period: amount, periodUnit };
    }
  }
  if (connectorLower !== "/" && connectorLower !== "per" && connectorLower !== "a") {
    return undefined;
  }
  const unitLower = normalizeTokenLower(unitToken);
  if (/^(?:day|d)$/u.test(unitLower)) {
    return { tokens: [connector, unitToken], period: 1, periodUnit: FhirPeriodUnit.Day };
  }
  if (/^(?:week|wk)$/u.test(unitLower)) {
    return { tokens: [connector, unitToken], period: 1, periodUnit: FhirPeriodUnit.Week };
  }
  if (unitLower !== "24") return undefined;
  const hourToken = context.tokens[start + 2];
  if (!hourToken || context.state.consumed.has(hourToken.index) ||
      !/^(?:h|hr|hrs|hour|hours)$/u.test(normalizeTokenLower(hourToken))) return undefined;
  return {
    tokens: [connector, unitToken, hourToken],
    period: 1,
    periodUnit: FhirPeriodUnit.Day
  };
}

/**
 * A maximum medication quantity is a typed schedule adjunct, not another
 * administration dose. The full lexical sign owns its source span so a
 * trailing cap cannot be reparsed from Dosage.text after FHIR projection.
 */
export function maximumDosePerPeriodRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.maximumDosePerPeriod", (context, start) => {
    const first = context.tokens[start];
    if (!first || !MAXIMUM_COUNT_LEAD_FIRST_TOKENS.has(normalizeTokenLower(first))) return [];
    const lead = maximumCountLeadAt(context, start);
    if (!lead) return [];

    let cursor = start + lead.length;
    const matched = [...lead];
    const punctuation = context.tokens[cursor];
    if (punctuation && !context.state.consumed.has(punctuation.index) &&
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
        context.state.consumed.has(valueToken.index) ||
        context.state.consumed.has(unitToken.index)) return [];
    const unitSurface = normalizeTokenLower(unitToken);
    // `tablets/day` remains one lossless lexical token; split only this
    // explicitly bounded dimensional suffix inside the maximum construction.
    const compactUnitPeriod = unitSurface.match(
      /^(.+?)\/(day|d|week|wk|24h|24hr|24hrs|24hour|24hours)$/u
    );
    if (OCCURRENCE_COUNT_WORDS.has(unitSurface)) return [];
    const unit = normalizeUnit(compactUnitPeriod?.[1] ?? unitSurface, context.options);
    if (!unit) return [];
    matched.push(valueToken, unitToken);
    cursor += 2;

    const compactPeriod = compactUnitPeriod
      ? {
          tokens: [] as Token[],
          period: 1,
          periodUnit: /^(?:week|wk)$/u.test(compactUnitPeriod[2])
            ? FhirPeriodUnit.Week
            : FhirPeriodUnit.Day
        }
      : undefined;
    const period = periodFirst ?? compactPeriod ?? maximumDosePeriodAt(context, cursor);
    if (!period) return [];
    if (!periodFirst) matched.push(...period.tokens);

    return [lexicalSign({
      type: "schedule-sign",
      rule: "hpsg.lex.schedule.maximumDosePerPeriod",
      tokens: matched,
      synsem: {
        head: {
          schedule: {
            maxDosePerPeriod: [{
              amount,
              unit,
              period: period.period,
              periodUnit: period.periodUnit
            }]
          }
        },
        valence: {},
        cont: { clauseKind: "administration" }
      },
      score: 35 + matched.length
    })];
  });
}

function fixedIntervalMinutes(value: number, unit: FhirPeriodUnit): number | undefined {
  const factor = unit === FhirPeriodUnit.Second ? 1 / 60
    : unit === FhirPeriodUnit.Minute ? 1
    : unit === FhirPeriodUnit.Hour ? 60
    : unit === FhirPeriodUnit.Day ? 24 * 60
    : unit === FhirPeriodUnit.Week ? 7 * 24 * 60
    : undefined;
  if (factor === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value * factor * 1_000_000) / 1_000_000;
}

function precedingMethodOwnsAdministrationDuration(
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

/** A relation plus a fixed interval denotes a delayed administration, not
 * the length of treatment. The lexical sign owns the complete constituent so
 * generic connector, site and bare-duration analyses cannot split it apart. */
function relativeAdministrationIntervalSign(
  context: HpsgClauseContext,
  start: number,
  first: Token,
  firstLower: string
): HpsgSign | undefined {
  const isPossibleLeadingRelation = firstLower === AdviceRelation.After ||
    firstLower === AdviceRelation.In;
  const relation = isPossibleLeadingRelation
    ? resolveActionRelationSurface(firstLower, ["temporal"])
    : undefined;
  const hasLeadingRelation = relation === AdviceRelation.After || relation === AdviceRelation.In;
  if (hasLeadingRelation && precedingMethodOwnsAdministrationDuration(
    context, start, firstLower
  )) return undefined;
  const trailing = hasLeadingRelation ? undefined : context.tokens[start + 2];
  const trailingRelation = trailing
    ? RELATIVE_INTERVAL_TRAILING_RELATIONS.get(normalizeTokenLower(trailing))
    : undefined;
  if (!hasLeadingRelation && (!trailing || context.state.consumed.has(trailing.index) ||
      trailingRelation !== AdviceRelation.After)) {
    return undefined;
  }
  const valueToken = hasLeadingRelation ? context.tokens[start + 1] : first;
  const unitToken = context.tokens[start + (hasLeadingRelation ? 2 : 1)];
  if (!valueToken || !unitToken || context.state.consumed.has(valueToken.index) ||
      context.state.consumed.has(unitToken.index)) return undefined;
  const value = frequencyCardinalValue(valueToken);
  const unit = mapIntervalUnit(normalizeTokenLower(unitToken));
  const minutes = value !== undefined && unit ? fixedIntervalMinutes(value, unit) : undefined;
  if (minutes === undefined) return undefined;
  if (timingRangeIsProcedureLocalDuration(
    context,
    valueToken.sourceStart,
    unitToken.sourceEnd
  )) return undefined;
  const tokens = hasLeadingRelation
    ? [first, valueToken, unitToken]
    : [valueToken, unitToken, trailing!];
  const schedule: HpsgScheduleFeature = { administrationOffsetMinutes: minutes };
  return lexicalSign({
    type: "schedule-sign",
    rule: "hpsg.lex.schedule.administrationOffset.relativeInterval",
    tokens,
    synsem: {
      head: { schedule },
      valence: {},
      cont: { clauseKind: "administration" }
    },
    score: 32 + tokens.length
  });
}

function precedingLeadingRelativeAdministrationInterval(
  context: HpsgClauseContext,
  start: number
): boolean {
  const relationToken = context.tokens[start - 1];
  if (!relationToken || context.state.consumed.has(relationToken.index)) return false;
  const lower = normalizeTokenLower(relationToken);
  if (lower !== AdviceRelation.After && lower !== AdviceRelation.In) return false;
  return Boolean(relativeAdministrationIntervalSign(context, start - 1, relationToken, lower));
}

/** The same bounded lexical treatment-period daughter is consumed by the
 * HPSG schedule chart and the regimen seam proposer. A source "for week 1"
 * supplies its finite duration; "from week 2" / "ในสัปดาห์ที่ 2"
 * supplies its onset. Cardinal-first "for 2 weeks" is ordinary duration.
 * This is a lexical constituent, not a separate source-string parser.
 */
const TREATMENT_PERIOD_LEAD_TOKENS = new Set([
  ...lexicalClasses.treatmentPeriodRestrictors,
  ...lexicalClasses.treatmentPeriodBoundLeads,
  ...lexicalClasses.treatmentPeriodStartLeads
]);
function treatmentRelativePeriodHeaderAt(tokens: readonly Token[], start: number):
  { tokenEnd: number; offsetDays: number; unit: FhirPeriodUnit.Week | FhirPeriodUnit.Day; bounded: boolean } | undefined {
  // Cheap gate before creating any per-candidate grammar closures; normal
  // medication doses have no treatment-relative week/day introducer.
  const first = tokens[start];
  if (!first || !TREATMENT_PERIOD_LEAD_TOKENS.has(normalizeTokenLower(first))) return undefined;
  let cursor = start;
  const text = (index: number) => tokens[index] ? normalizeTokenLower(tokens[index]) : "";
  if (lexicalClasses.treatmentPeriodRestrictors.indexOf(text(cursor)) >= 0) cursor++;
  const bounded = lexicalClasses.treatmentPeriodBoundLeads.indexOf(text(cursor)) >= 0;
  const starts = lexicalClasses.treatmentPeriodStartLeads.indexOf(text(cursor)) >= 0;
  if (!bounded && !starts) return undefined;
  cursor++;
  if (lexicalClasses.treatmentPeriodArticles.indexOf(text(cursor)) >= 0) cursor++;
  let unit = mapIntervalUnit(text(cursor));
  let ordinalToken: Token | undefined;
  let tokenEnd: number;
  if (unit === "wk" || unit === "d") {
    cursor++;
    // A headed ordinal in Thai may have the grammatical particle "ที่",
    // normalized to the same filler class as English "at/the".
    if (tokens[cursor] && ORDINAL_WEEK_STAGE_FILLERS.has(text(cursor))) cursor++;
    ordinalToken = tokens[cursor];
    tokenEnd = cursor + 1;
  } else {
    ordinalToken = tokens[cursor];
    unit = mapIntervalUnit(text(cursor + 1));
    // Cardinal-before-unit denotes a quantity of periods, whether written
    // with digits or number words. Only an actual ordinal can precede the
    // unit in an indexed period; unit-first "week two" remains licensed.
    if (!ordinalToken || ordinalToken.kind === LexKind.Number ||
        FREQUENCY_NUMBER_WORDS[text(cursor)] !== undefined ||
        ORDINAL_WEEK_STAGE_VALUES[text(cursor)] === undefined) return undefined;
    tokenEnd = cursor + 2;
  }
  if (!ordinalToken || (unit !== "wk" && unit !== "d")) return undefined;
  const ordinal = ordinalToken.kind === LexKind.Number ? ordinalToken.value :
    ORDINAL_WEEK_STAGE_VALUES[normalizeTokenLower(ordinalToken)];
  if (!ordinal || !Number.isInteger(ordinal) || ordinal < 1) return undefined;
  return { tokenEnd, offsetDays: (ordinal - 1) * (unit === "wk" ? 7 : 1),
    unit, bounded };
}

/** Does a source lead license a new treatment-relative phase onset? No
 * arbitrary numeric quantity or isolated "in/from" qualifies.
 */
export function treatmentRelativePeriodStartAt(tokens: readonly Token[], start: number):
  { tokenEnd: number; offsetDays: number } | undefined {
  const header = treatmentRelativePeriodHeaderAt(tokens, start);
  return header && !header.bounded
    ? { tokenEnd: header.tokenEnd, offsetDays: header.offsetDays } : undefined;
}

function treatmentRelativePeriodSign(context: HpsgClauseContext, start: number): HpsgSign | undefined {
  const header = treatmentRelativePeriodHeaderAt(context.tokens, start);
  if (!header) return undefined;
  const members = tokensAvailable(context, start, header.tokenEnd - start);
  if (!members) return undefined;
  return lexicalSign({
    type: "schedule-sign", rule: "hpsg.lex.schedule.treatmentRelativePeriod", tokens: members,
    synsem: { head: { schedule: {
      treatmentStartOffsetDays: header.offsetDays,
      ...(header.bounded ? { duration: 1, durationUnit: header.unit } : {})
    } }, valence: {}, cont: { clauseKind: "administration" } },
    score: 52 + members.length
  });
}

/**
 * A duration noun phrase contributes a quantity and a time dimension. Its
 * governing construction decides whether it is an active course, a rest
 * interval, or a local procedural duration; the lexical daughter does not.
 * @param tokens Existing normalized source tokens, never retokenized text.
 * @param start First token of the duration daughter.
 * @param limit Exclusive end of the containing constituent.
 */
export function durationNominalAt(
  tokens: readonly Token[],
  start: number,
  limit = tokens.length
): HpsgSign | undefined {
  const first = tokens[start];
  if (!first || start >= limit) return undefined;
  const lower = normalizeTokenLower(first);
  const headed = DURATION_LEAD_TOKENS.has(lower);
  const marked = COUNT_MARKER_TOKENS.has(lower);
  const make = (
    end: number, value: number | undefined, unit: FhirPeriodUnit | undefined,
    rule: string, score: number, maximum?: number
  ): HpsgSign | undefined => {
    if (end > limit) return undefined;
    const schedule = buildDurationScheduleFeature(value, unit, maximum);
    if (!schedule) return undefined;
    return lexicalSign({
      type: "schedule-sign", rule, tokens: tokens.slice(start, end),
      synsem: { head: { schedule: {
        ...schedule,
        // An overt course head owns its quantity complement. Bare temporal
        // quantities remain available to relative-event offset constructions.
        ...(headed || marked ? {
          sourceRanges: [{ start: first.sourceStart, end: tokens[end - 1].sourceEnd }]
        } : {})
      } }, valence: {}, cont: { clauseKind: "administration" } },
      score
    });
  };
  const compactPrefixed = compactDurationParts(lower);
  if (compactPrefixed) return make(
    start + 1, compactPrefixed.value, mapIntervalUnit(compactPrefixed.unitSurface),
    "hpsg.lex.schedule.duration.compactQuantity", 20
  );
  const compact = lower.match(/^[x*]([0-9]+(?:\.[0-9]+)?)(min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|wk|w|week|weeks|mo|month|months)$/);
  if (compact) return make(
    start + 1, Number(compact[1]), mapIntervalUnit(compact[2]),
    "hpsg.lex.schedule.duration.compact", 8
  );
  const splitCompact = lower.match(/^[x*]([0-9]+(?:\.[0-9]+)?)$/);
  if (splitCompact) return make(
    start + 2, Number(splitCompact[1]),
    tokens[start + 1] && mapIntervalUnit(normalizeTokenLower(tokens[start + 1])),
    "hpsg.lex.schedule.duration.splitCompact", 9
  );
  const continuation = courseContinuationDurationAt(tokens, start, limit);
  if (continuation) return make(
    continuation.end, continuation.value, continuation.unit,
    "hpsg.lex.schedule.duration.continuation", 18 + continuation.end - start
  );
  let cursor = start + (headed || marked ? 1 : 0);
  const article = tokens[cursor];
  const hasArticle = Boolean(article && EVENT_OFFSET_ARTICLES.has(normalizeTokenLower(article)));
  const articleModifiesCount = Boolean(hasArticle &&
    OCCURRENCE_COUNT_MODIFIERS.has(normalizeTokenLower(article)));
  if (hasArticle) cursor += 1;
  const modifier = tokens[cursor];
  const hasFollowingModifier = Boolean(modifier &&
    OCCURRENCE_COUNT_MODIFIERS.has(normalizeTokenLower(modifier)));
  const hasModifier = articleModifiesCount || hasFollowingModifier;
  if (hasFollowingModifier) cursor += 1;
  // An indefinite determiner contributes one across its count modifier;
  // an explicit cardinal below supplies its own value instead.
  if (headed && hasArticle) {
    const unitToken = tokens[cursor];
    const unit = unitToken ? mapIntervalUnit(normalizeTokenLower(unitToken)) : undefined;
    if (unit) return make(cursor + 1, 1, unit,
      "hpsg.lex.schedule.duration.indefiniteQuantity", 21);
  }
  if (headed && tokens[cursor] && normalizeTokenLower(tokens[cursor]) === "the") cursor += 1;
  const following = headed ? followingCourseDurationHeaderAt(tokens, start) : undefined;
  if (following) cursor = following.valueIndex;
  const valueToken = tokens[cursor];
  if (!valueToken || cursor >= limit) return undefined;
  const valueWord = normalizeTokenLower(valueToken);
  const range = valueToken.kind === LexKind.NumberRange ? parseNumericRange(valueWord) : undefined;
  const value = range?.low ?? (valueToken.kind === LexKind.Number ? valueToken.value :
    headed && valueWord === "first" ? 1 : FREQUENCY_NUMBER_WORDS[valueWord]);
  // Unheaded cardinal words are ambiguous dose modifiers. They need the same
  // duration/continuation license as in the ordinary course grammar.
  if (!headed && !marked && !hasModifier && valueToken.kind !== LexKind.Number) return undefined;
  if (range && range.high < range.low) return undefined;
  cursor += 1;
  const trailingModifier = tokens[cursor];
  const hasTrailingModifier = headed && trailingModifier &&
    OCCURRENCE_COUNT_MODIFIERS.has(normalizeTokenLower(trailingModifier));
  if (hasTrailingModifier) cursor += 1;
  const unitToken = tokens[cursor];
  const unit = unitToken && mapIntervalUnit(normalizeTokenLower(unitToken));
  const rule = hasModifier ? "hpsg.lex.schedule.duration.quantityModified" :
    headed ? hasTrailingModifier ? "hpsg.lex.schedule.duration.postQuantityModified" :
      "hpsg.lex.schedule.duration.for" :
    marked ? "hpsg.lex.schedule.duration.marked" : "hpsg.lex.schedule.duration.bare";
  const score = hasModifier ? 18 + cursor + 1 - start : headed || marked ? 8 : 7;
  return make(cursor + 1, value, unit, rule, score, range?.high);
}

export function countAndDurationRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.limit", (context, start) => {
    const token = tokensAvailable(context, start, 1)?.[0];
    if (!token) {
      return [];
    }
    const lower = normalizeTokenLower(token);
    const signs: HpsgSign[] = [];
    const relativePeriod = treatmentRelativePeriodSign(context, start);
    if (relativePeriod) return [relativePeriod];
    const ordinalWeekStage = ordinalWeekStageHeaderAt(context.tokens, start);
    // A prefixed relative period is one larger licensed schedule daughter:
    // "from week 2" / "ในสัปดาห์ที่ 2" must not be reduced to the
    // unanchored "week 2" header with its treatment onset discarded.
    const prefixedRelativePeriod = ordinalWeekStage && (
      start > 0 && treatmentRelativePeriodStartAt(context.tokens, start - 1)
        ?.tokenEnd === ordinalWeekStage.tokenEnd ||
      start > 1 && treatmentRelativePeriodStartAt(context.tokens, start - 2)
        ?.tokenEnd === ordinalWeekStage.tokenEnd
    );
    if (ordinalWeekStage && !prefixedRelativePeriod &&
        ordinalWeekStage.tokenEnd <= context.limit) {
      const members = context.tokens.slice(start, ordinalWeekStage.tokenEnd);
      if (members.every(member => !context.state.consumed.has(member.index))) {
        const schedule: HpsgScheduleFeature = {
          sourceRanges: [{ start: ordinalWeekStage.start, end: ordinalWeekStage.end }]
        };
        return [lexicalSign({
          type: "schedule-sign",
          rule: "hpsg.lex.schedule.ordinalWeekStage.header",
          tokens: members,
          synsem: { head: { schedule }, valence: {}, cont: { clauseKind: "administration" } },
          score: 54 + members.length
        })];
      }
    }
    const relativeInterval = relativeAdministrationIntervalSign(context, start, token, lower);
    if (relativeInterval) return [relativeInterval];
    // The shared duration NP supplies one lexical meaning. Clinical scope is
    // decided here for an administration and by the cycle construction for a
    // rest interval; neither consumer maintains its own duration interpreter.
    if (precedingLeadingRelativeAdministrationInterval(context, start)) return signs;
    const duration = durationNominalAt(context.tokens, start, context.limit);
    if (duration) {
      const previous = context.tokens[start - 1];
      const bare = token.kind === LexKind.Number;
      const intervalOwned = bare && previous &&
        (EVERY_INTERVAL_TOKENS.has(normalizeTokenLower(previous)) ||
         RANGE_CONNECTORS.has(normalizeTokenLower(previous)));
      const activityOwned = bare && semanticActivityWindowAt(context, duration.span.end);
      if (!intervalOwned && !activityOwned &&
          duration.tokens.every(member => !context.state.consumed.has(member.index)) &&
          !timingRangeIsProcedureLocalDuration(
            context, token.sourceStart, duration.tokens[duration.tokens.length - 1].sourceEnd
          )) return [duration];
    }
    const maximumLead = MAXIMUM_COUNT_LEAD_FIRST_TOKENS.has(lower)
      ? maximumCountLeadAt(context, start)
      : undefined;
    if (maximumLead) {
      const valueIndex = start + maximumLead.length;
      const valueToken = context.tokens.slice(valueIndex, valueIndex + 1).shift();
      const occurrenceToken = context.tokens.slice(valueIndex + 1, valueIndex + 2).shift();
      // Once/twice/thrice lexicalize both the cardinal and occurrence noun.
      // They compose with the same maximum head as "two times", not a new
      // recurring cadence and never an opaque argument of the PRN phrase.
      const fusedCount = valueToken ? FREQUENCY_SIMPLE_WORDS[normalizeTokenLower(valueToken)] : undefined;
      const countValue = fusedCount ?? exactCountCardinalValue(valueToken);
      const explicitOccurrence = occurrenceToken && !context.state.consumed.has(occurrenceToken.index) &&
        OCCURRENCE_COUNT_WORDS.has(normalizeTokenLower(occurrenceToken));
      if (
        valueToken && !context.state.consumed.has(valueToken.index) &&
        countValue !== undefined && (explicitOccurrence || fusedCount !== undefined)
      ) {
        const countTokens = explicitOccurrence ? [valueToken, occurrenceToken] : [valueToken];
        const period = occurrenceCapPeriodAt(context, valueIndex + countTokens.length);
        if (period) {
          const matched = [...maximumLead, ...countTokens, ...period.tokens];
          signs.push(lexicalSign({
            type: "schedule-sign",
            rule: "hpsg.lex.schedule.occurrenceCap.maximum",
            tokens: matched,
            synsem: {
              head: {
                schedule: {
                  sourceRanges: [{ start: matched[0].sourceStart, end: matched[matched.length - 1].sourceEnd }],
                  occurrenceCap: {
                    max: countValue,
                    period: period.period,
                    periodUnit: period.periodUnit
                  }
                }
              },
              valence: {},
              cont: { clauseKind: "administration" }
            },
            score: 25 + matched.length
          }));
          return signs;
        }
        const matched = [...maximumLead, ...countTokens];
        signs.push(lexicalSign({
          type: "schedule-sign",
          rule: "hpsg.lex.schedule.count.maximum",
          tokens: matched,
          synsem: {
            head: { schedule: { count: 1, countMax: countValue,
              sourceRanges: [{ start: matched[0].sourceStart, end: matched[matched.length - 1].sourceEnd }] } },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: 18 + matched.length
        }));
        return signs;
      }
    }
    const trailingOccurrenceToken = context.tokens[start + 1];
    const trailingTotalToken = context.tokens[start + 2];
    const trailingCountValue = exactCountCardinalValue(token);
    if (
      trailingCountValue !== undefined &&
      trailingOccurrenceToken && !context.state.consumed.has(trailingOccurrenceToken.index) &&
      OCCURRENCE_COUNT_WORDS.has(normalizeTokenLower(trailingOccurrenceToken)) &&
      trailingTotalToken && !context.state.consumed.has(trailingTotalToken.index) &&
      normalizeTokenLower(trailingTotalToken) === "total"
    ) {
      const matched = [token, trailingOccurrenceToken, trailingTotalToken];
      return [lexicalSign({
        type: "schedule-sign",
        rule: "hpsg.lex.schedule.count.trailingTotal",
        tokens: matched,
        synsem: {
          head: { schedule: { count: trailingCountValue } },
          valence: {},
          cont: { clauseKind: "administration" }
        },
        score: 18 + matched.length
      })];
    }
    // Remaining count constructions select an occurrence noun or omit it.
    // A following time unit belongs exclusively to durationNominalAt above.
    const compactCount = compactMarkedCountValue(token);
    if (compactCount !== undefined) {
      const next = context.tokens[start + 1];
      if (next && mapIntervalUnit(normalizeTokenLower(next))) return signs;
      const occurrence = next && !context.state.consumed.has(next.index) &&
        OCCURRENCE_COUNT_WORDS.has(normalizeTokenLower(next)) ? next : undefined;
      const matched = occurrence ? [token, occurrence] : [token];
      return [lexicalSign({
        type: "schedule-sign", rule: "hpsg.lex.schedule.count.compact", tokens: matched,
        synsem: { head: { schedule: { count: compactCount } },
          valence: {}, cont: { clauseKind: "administration" } },
        score: occurrence ? 7 : 6
      })];
    }
    if (COUNT_MARKER_TOKENS.has(lower) || DURATION_LEAD_TOKENS.has(lower)) {
      const headed = DURATION_LEAD_TOKENS.has(lower);
      const article = headed && context.tokens[start + 1] &&
        normalizeTokenLower(context.tokens[start + 1]) === "the";
      const valueIndex = start + (article ? 2 : 1);
      const valueToken = context.tokens[valueIndex];
      const value = frequencyCardinalValue(valueToken);
      const possibleModifier = context.tokens[valueIndex + 1];
      const hasModifier = headed && possibleModifier &&
        OCCURRENCE_COUNT_MODIFIERS.has(normalizeTokenLower(possibleModifier));
      const noun = context.tokens[valueIndex + (hasModifier ? 2 : 1)];
      if (noun && mapIntervalUnit(normalizeTokenLower(noun))) return signs;
      const occurrence = noun && !context.state.consumed.has(noun.index) &&
        (OCCURRENCE_COUNT_WORDS.has(normalizeTokenLower(noun)) ||
         (noun.annotations?.wordClasses?.indexOf(TokenWordClass.CountKeyword) ?? -1) >= 0);
      if (valueToken && !context.state.consumed.has(valueToken.index) &&
          value !== undefined && value > 0 && Number.isInteger(value) &&
          (!headed || occurrence)) {
        const end = occurrence ? valueIndex + (hasModifier ? 3 : 2) : valueIndex + 1;
        const matched = tokensAvailable(context, start, end - start);
        if (matched) signs.push(lexicalSign({
          type: "schedule-sign",
          rule: headed ? "hpsg.lex.schedule.count.for" : "hpsg.lex.schedule.count.marked",
          tokens: matched,
          synsem: { head: { schedule: { count: value } }, valence: {},
            cont: { clauseKind: "administration" } },
          score: headed ? 22 : 8
        }));
      }
    }
    return signs;
  });
}

const CLOCK_WINDOW_HEADS = new Set(lexicalClasses.clockWindowFrames.map(frame => frame[0]));

export function timeOfDayRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.timeOfDay", (context, start) => {
    const windowHead = context.tokens[start];
    const windowHeadLower = windowHead ? normalizeTokenLower(windowHead) : "";
    if (windowHead && CLOCK_WINDOW_HEADS.has(windowHeadLower)) for (const [head, join] of lexicalClasses.clockWindowFrames) {
      if (windowHeadLower !== head) continue;
      const clockLead = context.tokens[start + 1];
      const clockStart = start + 1 + (clockLead && CLOCK_LEAD_TOKENS.has(normalizeTokenLower(clockLead)) ? 1 : 0);
      const left = context.tokens[clockStart] && parseClockToken(context.tokens[clockStart], context.tokens[clockStart + 1]);
      if (!left) continue;
      const seam = clockStart + left.tokens.length;
      if (!context.tokens[seam] || normalizeTokenLower(context.tokens[seam]) !== join) continue;
      const right = context.tokens[seam + 1] && parseClockToken(context.tokens[seam + 1], context.tokens[seam + 2]);
      if (!right || seam + 1 + right.tokens.length > context.limit) continue;
      return [lexicalSign({
        type: "schedule-sign", rule: "hpsg.lex.schedule.clockWindow",
        tokens: context.tokens.slice(start, seam + 1 + right.tokens.length),
        synsem: {
          head: { schedule: { clockWindow: { start: left.value, end: right.value, endInclusive: true } } },
          valence: {}, cont: { clauseKind: "administration" }
        }, score: 26 + left.tokens.length + right.tokens.length
      })];
    }
    let cursor = start;
    const consumed: Token[] = [];
    while (cursor < context.limit) {
      const connector = context.tokens[cursor];
      const lower = connector ? normalizeTokenLower(connector) : "";
      if (!connector || context.state.consumed.has(connector.index) || !LIST_SEPARATORS.has(lower)) {
        break;
      }
      consumed.push(connector);
      cursor += 1;
    }
    const lead = context.tokens[cursor];
    if (!lead || context.state.consumed.has(lead.index)) {
      return [];
    }
    const leadLower = normalizeTokenLower(lead);
    if (CLOCK_LEAD_TOKENS.has(leadLower)) {
      consumed.push(lead);
      cursor += 1;
    }

    const timeOfDay: string[] = [];
    while (cursor < context.limit) {
      const token = context.tokens[cursor];
      if (!token || context.state.consumed.has(token.index)) {
        break;
      }
      const parsed = parseClockToken(token, context.tokens[cursor + 1]);
      if (!parsed) {
        break;
      }
      for (const parsedToken of parsed.tokens) {
        consumed.push(parsedToken);
      }
      timeOfDay.push(parsed.value);
      cursor += parsed.tokens.length;
      // A declared clock-unit abbreviation owns its punctuation as part of
      // this time constituent; the following course remains a separate NP.
      for (const suffix of lexicalClasses.clockSuffixSequences) {
        const members = context.tokens.slice(cursor, cursor + suffix.length);
        if (members.length !== suffix.length || cursor + suffix.length > context.limit ||
            !members.every((member, index) => !context.state.consumed.has(member.index) &&
              (member.original.toLowerCase() === suffix[index] || normalizeTokenLower(member) === suffix[index]))) continue;
        consumed.push(...members);
        cursor += suffix.length;
        break;
      }
      const separator = context.tokens[cursor];
      if (!separator || context.state.consumed.has(separator.index)) {
        break;
      }
      const separatorLower = normalizeTokenLower(separator);
      if (!LIST_SEPARATORS.has(separatorLower)) {
        break;
      }
      consumed.push(separator);
      cursor += 1;
    }

    if (!timeOfDay.length) {
      return [];
    }
    return [
      lexicalSign({
        type: "schedule-sign",
        rule: "hpsg.lex.schedule.timeOfDay",
        tokens: consumed,
        synsem: {
          head: { schedule: { timeOfDay } },
          valence: {},
          cont: { clauseKind: "administration" }
        },
        score: 10 + timeOfDay.length
      })
    ];
  });
}

export function isScheduleLead(context: HpsgClauseContext, index: number): boolean {
  const token = context.tokens[index];
  if (!token || context.state.consumed.has(token.index)) {
    return false;
  }
  const lower = normalizeTokenLower(token);
  if (monthlyOrdinalWeekdaySign(context, index)) return true;
  // Reuse the same typed duration constituent as the clause chart. Generic
  // administration advice must not consume its FOR + amount prefix and leave
  // only the unit behind, while procedure-owned durations stay procedural.
  if (DURATION_LEAD_TOKENS.has(lower) && countAndDurationRule().match(context, index).some(sign =>
    sign.synsem.head.schedule?.duration !== undefined &&
    sign.synsem.head.schedule.attachmentClass !== "procedure"
  )) return true;
  if (token.kind === LexKind.Number && token.value !== undefined) {
    const unitToken = context.tokens[index + 1];
    const unit = unitToken ? mapIntervalUnit(normalizeTokenLower(unitToken)) : undefined;
    if (unit) {
      const window = semanticActivityWindowAt(context, index + 2);
      if (window) return true;
      const relationToken = context.tokens[index + 2];
      const relation = relationToken ? mealRelationFromToken(normalizeTokenLower(relationToken)) : undefined;
      if (relation === "before" || relation === "after") {
        const expression = eventExpressionPartsAt(context, index + 3);
        if (resolveEventTimingExpression(expression.parts)) return true;
      }
    }
  }
  if (
    /^\d+(?:\.\d+)?x\/(?:day|d|week|wk|w|month|mo|hour|h)$/.test(lower) ||
    /^\d+(?:\.\d+)?-\d+(?:\.\d+)?x\/(?:day|d|week|wk|w|month|mo|hour|h)$/.test(lower)
  ) {
    return true;
  }
  if (
    TIMING_ABBREVIATIONS[lower] ||
    WORD_FREQUENCIES[lower] ||
    EVENT_TIMING_TOKENS[lower] ||
    EVERY_INTERVAL_TOKENS.has(lower) ||
    FREQUENCY_SIMPLE_WORDS[lower] !== undefined ||
    FREQUENCY_NUMBER_WORDS[lower] !== undefined ||
    mapFrequencyAdverb(lower) ||
    mapIntervalUnit(lower) ||
    getDayOfWeekMeaning(token) ||
    isClockLikeLower(lower)
  ) {
    return true;
  }
  if (CLOCK_LEAD_TOKENS.has(lower)) {
    const next = context.tokens[index + 1];
    const nextLower = next ? normalizeTokenLower(next) : "";
    const following = context.tokens[index + 2];
    const followingLower = following ? normalizeTokenLower(following) : "";
    return (
      isClockLikeLower(nextLower) ||
      (/^[0-9]{1,2}$/.test(nextLower) && isAmPmLower(followingLower)) ||
      EVENT_TIMING_TOKENS[nextLower] !== undefined
    );
  }
  if (MEAL_RELATION_BY_TOKEN.has(lower)) {
    const next = context.tokens[index + 1];
    const nextLower = next ? normalizeTokenLower(next) : "";
    return (
      EVENT_TIMING_TOKENS[nextLower] !== undefined ||
      FOOD_EVENT_ALIASES.has(nextLower) ||
      SLEEP_EVENT_ALIASES.has(nextLower) ||
      WAKE_EVENT_ALIASES.has(nextLower)
    );
  }
  if (LIST_SEPARATORS.has(lower)) {
    return isScheduleLead(context, index + 1);
  }
  return false;
}


interface OpenEndedMarkerMatch {
  start: number;
  markerStart: number;
  end: number;
  date: MedicationDateListMatch;
}

function openEndedMarkerEnd(tokens: readonly Token[], index: number): number | undefined {
  const first = tokens[index];
  if (!first) return undefined;
  const surface = first.lower.replace(/^[.,;:]+|[.,;:]+$/gu, '');
  if (OPEN_ENDED_WORDS.has(surface)) return first.sourceEnd;
  const second = tokens[index + 1];
  const secondSurface = second?.lower.replace(/^[.,;:]+|[.,;:]+$/gu, '');
  if ((surface === 'เป็นต้น' || surface === 'ต่อ') && second && secondSurface === 'ไป') return second.sourceEnd;
  const previous = tokens[index - 1];
  const previousSurface = previous?.lower.replace(/^[.,;:]+|[.,;:]+$/gu, '');
  if (surface === 'ไป' && previousSurface !== 'ต่อ' && previousSurface !== 'เป็นต้น') return first.sourceEnd;
  return undefined;
}

function openEndedHasBlockingBoundary(tokens: readonly Token[], start: number, end: number): boolean {
  return tokens.some(token => token.sourceStart >= start && token.sourceEnd <= end && (
    ACTION_COORDINATION_CONNECTORS.has(normalizeTokenLower(token)) ||
    ACTION_SEQUENCE_MARKERS.has(normalizeTokenLower(token)) ||
    /[;!?]/u.test(token.original)
  ));
}

function resolveOpenEndedMarkers(
  tokens: readonly Token[],
  spans: readonly MedicationDateListMatch[]
): OpenEndedMarkerMatch[] {
  const output: OpenEndedMarkerMatch[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const end = openEndedMarkerEnd(tokens, index);
    if (end === undefined) continue;
    const markerStart = tokens[index].sourceStart;
    const date = [...spans]
      .filter(span => span.end <= markerStart && !openEndedHasBlockingBoundary(tokens, span.end, markerStart))
      .sort((left, right) => right.end - left.end)[0];
    if (!date) continue;
    const surface = tokens[index].lower.replace(/^[.,;:]+|[.,;:]+$/gu, '');
    if (surface === 'ไป' && date.relation !== 'start-inclusive' && date.relation !== 'start-exclusive') continue;
    const event = date.events.length === 1 && !date.unresolved ? date.events[0] : undefined;
    if (!event || (date.relation !== 'event' && date.relation !== 'start-inclusive')) continue;
    output.push({ start: date.start, markerStart, end, date });
  }
  return output;
}

const OPEN_ENDED_CONTEXT_MARKERS = new WeakMap<HpsgClauseContext, OpenEndedMarkerMatch[]>();
function openEndedContextMarkers(context: HpsgClauseContext): OpenEndedMarkerMatch[] {
  const cached = OPEN_ENDED_CONTEXT_MARKERS.get(context);
  if (cached) return cached;
  const markers = resolveOpenEndedMarkers(context.tokens, context.dateSpans);
  OPEN_ENDED_CONTEXT_MARKERS.set(context, markers);
  return markers;
}

function codedCourseEndCondition(context: HpsgClauseContext, start: number): HpsgSign | undefined {
  const lead = context.tokens[start];
  if (!lead || normalizeTokenLower(lead) !== 'until') return undefined;
  // A dated bound has executable calendar semantics and owns this span.
  if (context.dateSpans.some(span => span.start <= lead.sourceStart && span.end > lead.sourceStart)) {
    return undefined;
  }
  const article = context.tokens[start + 1];
  let next = start + 1;
  if (article && normalizeTokenLower(article) === 'the') next += 1;
  for (const definition of OPEN_ENDED_COURSE_END_CONDITIONS) {
    const first = context.tokens[next];
    const second = context.tokens[next + 1];
    if (!first || !second) continue;
    const left = normalizeTokenLower(first), right = normalizeTokenLower(second);
    const matches = definition.kind === 'next-event'
      ? definition.modifiers?.indexOf(left) !== -1 && definition.heads?.indexOf(right) !== -1
      : definition.subjects?.indexOf(left) !== -1 && definition.predicates?.indexOf(right) !== -1;
    if (!matches) continue;
    const tokens = tokensAvailable(context, start, next + 2 - start);
    if (!tokens) continue;
    return lexicalSign({
      type: 'instruction-sign',
      rule: 'hpsg.lex.instruction.openEndedCourseCondition',
      tokens,
      synsem: {
        head: {},
        // R5 has no executable end-date when the patient visit/clinical
        // outcome is unknown. This is a typed, coded NON-calendar directive,
        // never a fabricated boundsPeriod or asNeeded trigger.
        valence: { instructions: [{
          text: definition.display,
          i18n: { ...definition.i18n },
          evidence: [{
            rule: 'hpsg.lex.instruction.openEndedCourseCondition',
            spans: [{
              start: lead.sourceStart,
              end: tokens[tokens.length - 1].sourceEnd,
              text: context.state.input.slice(lead.sourceStart, tokens[tokens.length - 1].sourceEnd)
            }]
          }],
          // Clinical state changes without an independently established
          // terminology identity remain typed, editable, and source-backed.
          // Never borrow a code for a different clinical improvement concept.
          ...(definition.code ? { coding: {
            system: 'http://snomed.info/sct',
            code: definition.code,
            display: definition.display
          } } : {})
        }] },
        cont: { clauseKind: 'administration' }
      },
      score: 58 + tokens.length
    });
  }
  return undefined;
}

export function openEndedScheduleRule() {
  return lexicalRule('hpsg.lex.schedule.openEndedDate', (context: HpsgClauseContext, start: number) => {
    const first = context.tokens[start];
    if (!first) return [];
    const match = openEndedContextMarkers(context).find(value => value.start === first.sourceStart);
    if (!match) {
      const condition = codedCourseEndCondition(context, start);
      return condition ? [condition] : [];
    }
    const members = context.tokens
      .slice(start, context.limit)
      .filter(token => token.sourceStart >= match.start && token.sourceEnd <= match.end);
    const event = match.date.events[0];
    if (!members.length || !members.some(token => token.sourceStart >= match.markerStart)) return [];
    return [lexicalSign({
      type: 'schedule-sign',
      rule: 'hpsg.lex.schedule.openEndedDate',
      tokens: members,
      synsem: {
        head: {
          schedule: {
            boundsStart: event.isoDate,
            sourceRanges: [{ start: match.start, end: match.end }]
          }
        },
        valence: {},
        cont: { clauseKind: 'administration' }
      },
      score: 42 + members.length
    })];
  });
}


/** A licensed active/rest/repeat phrase, with both duration daughters retained. */
export interface HpsgRecurringCourseConstituent {
  sign: HpsgSign;
  onDuration: FhirQuantity;
  offDuration: FhirQuantity;
  repeatCycle: FhirQuantity;
  repeatCount?: number;
}

const COURSE_REPEAT_HEADS = new Set(
  listMedicationInstructionActions()
    .filter(action => action.semanticClass === "repeat")
    .reduce<string[]>((aliases, action) => aliases.concat(action.aliases ?? []), [])
    .map(alias => alias.toLowerCase().split(/\s+/u)[0])
);

/** Cheap lexical activation only; the course construction must still compose. */
export function hasRecurringCourseCue(tokens: readonly Token[], options?: ParseOptions): boolean {
  return tokens.some(token =>
    COURSE_REPEAT_HEADS.has(token.lower) ||
    COURSE_REPEAT_HEADS.has(normalizeTokenLower(token)) ||
    Boolean(options?.instructionActionMap &&
      resolveMedicationInstructionAction(token.sourceText ?? token.original, options)?.semanticClass === "repeat")
  );
}

function cycleSeamEnd(tokens: readonly Token[], start: number): number {
  let cursor = start;
  while (tokens[cursor] && /^[,;.]$/u.test(tokens[cursor].original)) cursor++;
  const sequence = sequenceConnectorEnd(tokens, cursor);
  if (sequence !== undefined) cursor = sequence;
  else if (tokens[cursor] && coordinationConnectorKind(normalizeTokenLower(tokens[cursor])) === "conjunction") {
    cursor++;
    cursor = sequenceConnectorEnd(tokens, cursor) ?? cursor;
  }
  while (tokens[cursor] && /^[,;.]$/u.test(tokens[cursor].original)) cursor++;
  return cursor;
}

/** Select the registered action head; an object such as 'hold your breath'
 * cannot satisfy the rest-duration complement that follows this constituent. */
function courseActionEnd(
  input: string, tokens: readonly Token[], start: number,
  role: "stop" | "repeat", options?: ParseOptions
): number | undefined {
  const first = tokens[start];
  if (!first) return undefined;
  let matched: number | undefined;
  let canonical = "";
  for (let end = start + 1; end <= tokens.length; end++) {
    const token = tokens[end - 1];
    if (end > start + 1 && (isPunctuation(token.original) ||
        token.kind === LexKind.Number || token.kind === LexKind.NumberRange ||
        DURATION_LEAD_TOKENS.has(normalizeTokenLower(token)))) break;
    canonical += (canonical ? " " : "") + normalizeTokenLower(token);
    const surface = input.slice(first.sourceStart, token.sourceEnd);
    const action = resolveMedicationInstructionAction(surface, options) ??
      resolveMedicationInstructionAction(canonical, options);
    if (action && (action.semanticClass === role || role === "stop" &&
        action.argumentParserConfig?.medicationConditionEffect === "withhold")) matched = end;
    // Once a known action is followed by an independently licensed connective,
    // its lexical span is closed. Unknown object text stays outside its valence.
    if (end > start + 1 && (sequenceConnectorEnd(tokens, end - 1) !== undefined ||
        coordinationConnectorKind(normalizeTokenLower(token)) !== "unknown")) break;
  }
  return matched;
}

/** A registered withholding head selects one complete finite duration NP.
 * Objects such as breath, conditional tails, and negative directives cannot
 * satisfy this medication-pause valence. Both daughters remain in the chart. */
export function finiteTreatmentPauseAt(
  context: HpsgClauseContext, frame: AdviceFrame, start: number
): { actionEnd: number; duration: HpsgSign; pause: { durationDays: number; range: { start: number; end: number } } } | undefined {
  if (frame.polarity === AdvicePolarity.Negate) return undefined;
  const definition = resolveMedicationInstructionAction(frame.predicate.lemma, context.options);
  if (definition?.semanticClass !== "stop" &&
      definition?.argumentParserConfig?.medicationConditionEffect !== "withhold") return undefined;
  const actionEnd = courseActionEnd(context.state.input, context.tokens, start, "stop", context.options);
  if (actionEnd === undefined || actionEnd >= context.limit) return undefined;
  const duration = durationNominalAt(context.tokens, actionEnd, context.limit);
  if (!duration) return undefined;
  const last = duration.tokens[duration.tokens.length - 1];
  if (!last || last.sourceEnd > frame.span.end ||
      !/^[\s,;.]*$/u.test(context.state.input.slice(last.sourceEnd, frame.span.end))) return undefined;
  const quantity = durationQuantity(duration);
  const days = quantity?.value === undefined ? undefined :
    quantity.code === FhirPeriodUnit.Day ? quantity.value :
    quantity.code === FhirPeriodUnit.Week ? quantity.value * 7 : undefined;
  if (days === undefined || !Number.isInteger(days) || days <= 0) return undefined;
  return { actionEnd, duration, pause: { durationDays: days, range: { ...frame.span } } };
}

function durationQuantity(sign: HpsgSign): FhirQuantity | undefined {
  const duration = sign.synsem.head.schedule;
  if (duration?.duration === undefined || !duration.durationUnit ||
      duration.durationMax !== undefined) return undefined;
  return { value: duration.duration, unit: duration.durationUnit,
    code: duration.durationUnit, system: "http://unitsofmeasure.org" };
}

function sumCourseDurations(on: FhirQuantity, off: FhirQuantity): FhirQuantity | undefined {
  if (on.value === undefined || off.value === undefined) return undefined;
  if (on.code === off.code) return { ...on, value: on.value + off.value };
  const fixedDays = (quantity: FhirQuantity) => quantity.value === undefined ? undefined :
    quantity.code === FhirPeriodUnit.Day ? quantity.value :
    quantity.code === FhirPeriodUnit.Week ? quantity.value * 7 : undefined;
  const onDays = fixedDays(on), offDays = fixedDays(off);
  return onDays !== undefined && offDays !== undefined
    ? { value: onDays + offDays, unit: FhirPeriodUnit.Day,
        code: FhirPeriodUnit.Day, system: "http://unitsofmeasure.org" }
    : undefined;
}

/**
 * Compose duration + stopped-duration + repetition as one headed course
 * phrase. Ordinary duration morphology, registered action meaning and shared
 * discourse markers are the only language authorities; no whole-SIG regex.
 * @param input Unchanged source for lexical action aliases and provenance.
 * @param tokens Existing normalized source tokens.
 * @param start Candidate active-duration daughter.
 * @param options Caller terminology, including registered action synonyms.
 */
export function recurringCourseAt(
  input: string, tokens: readonly Token[], start: number, options?: ParseOptions
): HpsgRecurringCourseConstituent | undefined {
  const active = durationNominalAt(tokens, start);
  if (!active) return undefined;
  const onDuration = durationQuantity(active);
  if (!onDuration) return undefined;
  const stopStart = cycleSeamEnd(tokens, active.span.end);
  const stopEnd = courseActionEnd(input, tokens, stopStart, "stop", options);
  if (stopEnd === undefined) return undefined;
  const rest = durationNominalAt(tokens, stopEnd);
  if (!rest) return undefined;
  const offDuration = durationQuantity(rest);
  if (!offDuration) return undefined;
  const repeatStart = cycleSeamEnd(tokens, rest.span.end);
  const repeatEnd = courseActionEnd(input, tokens, repeatStart, "repeat", options);
  if (repeatEnd === undefined) return undefined;
  const repeatCycle = sumCourseDurations(onDuration, offDuration);
  if (!repeatCycle) return undefined;
  let end = repeatEnd;
  const countLead = tokens[end];
  const headedCount = countLead && (DURATION_LEAD_TOKENS.has(normalizeTokenLower(countLead)) ||
    COUNT_MARKER_TOKENS.has(normalizeTokenLower(countLead)));
  const compactCount = compactMarkedCountValue(countLead);
  const countIndex = end + (headedCount ? 1 : 0);
  const count = compactCount ?? frequencyCardinalValue(tokens[countIndex]);
  const countNounIndex = compactCount !== undefined ? end + 1 : countIndex + 1;
  const countNoun = tokens[countNounIndex];
  let repeatCount: number | undefined;
  if (count !== undefined && countNoun &&
      CYCLE_COUNT_HEADS.has(normalizeTokenLower(countNoun))) {
    repeatCount = count;
    end = countNounIndex + 1;
  }
  const members = tokens.slice(start, end);
  const schedule: HpsgScheduleFeature = {
    duration: onDuration.value, durationUnit: active.synsem.head.schedule!.durationUnit,
    repeatCycle, ...(repeatCount !== undefined ? { repeatCount } : {}),
    sourceRanges: [{ start: members[0].sourceStart, end: members[members.length - 1].sourceEnd }]
  };
  const synsem = { head: { schedule }, valence: {}, cont: { clauseKind: "administration" as const } };
  const fs = combineSignFeatureStructures(
    active.fs, rest.fs, "recurring-course-phrase", "left", synsem
  );
  if (!fs) return undefined;
  const scheduleFields: NonNullable<HpsgSign["evidence"][number]["scheduleFields"]> =
    ["duration", "durationUnit", "repeatCycle"];
  if (repeatCount !== undefined) scheduleFields.push("repeatCount");
  const sign: HpsgSign = {
    type: "recurring-course-phrase", span: { start: active.span.start, end },
    tokens: members, synsem, fs,
    construction: { kind: "head-adjunct", operation: "repeat-course",
      headSide: "left", leftType: active.type, rightType: rest.type },
    consumedTokenIndices: members.map(token => token.index),
    evidence: [{
      rule: "hpsg.cx.course.active-rest-repeat",
      tokenIndices: members.map(token => token.index), scheduleFields
    }],
    score: 48 + members.length
  };
  return { sign, onDuration, offDuration, repeatCycle, repeatCount };
}

/** Share the same selected cycle constituents with segmentation and the chart. */
export function recurringCourseConstituents(
  input: string, tokens: readonly Token[], options?: ParseOptions
): HpsgRecurringCourseConstituent[] {
  if (!hasRecurringCourseCue(tokens, options)) return [];
  const result: HpsgRecurringCourseConstituent[] = [];
  for (let start = 0; start < tokens.length; start++) {
    const constituent = recurringCourseAt(input, tokens, start, options);
    if (!constituent) continue;
    result.push(constituent);
    start = constituent.sign.span.end - 1;
  }
  return result;
}

export interface CycleSchedule {
  start: number; end: number; sourceText: string; days: number[]; cycles: number; periodDays?: number;
  anchor?: string; events: CanonicalCalendarEventExpr[]; error?: string;
  kind?: 'calendar-days' | 'recurring-on-off';
  onDuration?: FhirQuantity;
  offDuration?: FhirQuantity;
  repeatCycle?: FhirQuantity;
  repeatCount?: number;
  unbounded?: boolean;
  /** Selected HPSG phrase reused by chart ownership and schedule projection. */
  sign?: HpsgSign;
}
const CYCLE_DAY_LIST = `${CYCLE_WORDS.dayPart}(?:${CYCLE_WORDS.listSeparator}${CYCLE_WORDS.dayPart})*`;
const CYCLE_NAMED_DAY_LEAD = `(?:${CYCLE_WORDS.startLead}\\s+)?(?:\\bon\\s+)?${CYCLE_WORDS.name}\\s+days?\\s+`;
const CYCLE_DAY_FRAME = `(?:(${CYCLE_NAMED_DAY_LEAD})|${CYCLE_WORDS.dayLead})(${CYCLE_DAY_LIST})(?:\\s+(?:of\\s+)?${CYCLE_WORDS.periodLead}(\\d{1,3})\\s*[-–]?\\s*${CYCLE_WORDS.periodUnit}(?:\\s+cycles?\\b)?)?(?:\\s+(of\\s+(?:the\\s+)?${CYCLE_WORDS.name}))?`;
/** Project the already-composed HPSG course phrase into the shared cycle
 * inventory. This adapter assigns no grammatical meaning from source text. */
function recurringCycles(
  input: string, tokens: readonly Token[], options?: ParseOptions
): CycleSchedule[] {
  return recurringCourseConstituents(input, tokens, options).map(constituent => {
    const { sign, onDuration, offDuration, repeatCycle, repeatCount } = constituent;
    const members = sign.tokens;
    const start = members[0].sourceStart, end = members[members.length - 1].sourceEnd;
    const onDays = onDuration.code === FhirPeriodUnit.Day ? onDuration.value :
      onDuration.code === FhirPeriodUnit.Week && onDuration.value !== undefined
        ? onDuration.value * 7 : undefined;
    const periodDays = repeatCycle.code === FhirPeriodUnit.Day ? repeatCycle.value :
      repeatCycle.code === FhirPeriodUnit.Week && repeatCycle.value !== undefined
        ? repeatCycle.value * 7 : undefined;
    return {
      kind: 'recurring-on-off', start, end, sourceText: input.slice(start, end),
      days: onDays !== undefined && Number.isInteger(onDays) && onDays <= 366
        ? Array.from({ length: onDays }, (_, index) => index + 1) : [],
      cycles: repeatCount ?? 1, periodDays, events: [],
      onDuration, offDuration, repeatCycle, repeatCount,
      unbounded: repeatCount === undefined || undefined, sign,
      error: repeatCount !== undefined &&
        (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 100)
        ? 'invalid-cycle-size' : undefined
    };
  });
}

/** Recognize finite anchored cycle/day-offset expressions; never guess an absent anchor or cycle length. */
export function recognizeCycles(
  input: string, options?: ParseOptions, sourceTokens?: readonly Token[]
): CycleSchedule[] {
  const tokens = sourceTokens ?? annotateLexTokens(lexInput(input));
  const result = recurringCycles(input, tokens, options);
  if (!/(?:days?\b|\bD\d|วันที่ของรอบ)/iu.test(input)) return result;
  const pattern = new RegExp(CYCLE_DAY_FRAME, 'giu');
  for (let match = pattern.exec(input); match; match = pattern.exec(input)) {
    const [, namedLead, list, periodValue, namedTail] = match;
    let end = match.index + match[0].length;
    const lead = new RegExp(`^\\s+${CYCLE_WORDS.startLead}\\s*`, 'iu').exec(input.slice(end));
    const anchorMatch = lead ? parseMedicationDateListAt(`on ${input.slice(end + lead[0].length)}`, 0,
      { ...options, locale: inferMedicationLocale(input, options?.locale ?? 'en') }) : undefined;
    if (lead) end += lead[0].length + (anchorMatch ? anchorMatch.end - 3 : 0);
    const countMatch = new RegExp(`^\\s+${CYCLE_WORDS.repeatCount}`, 'iu').exec(input.slice(end));
    const count = countMatch?.[1];
    if (countMatch) end += countMatch[0].length;
    // A named cycle head licenses its complete day-ordinal constituent even
    // when the calendar anchor is still unknown. Ordinary unqualified day
    // references require the existing cycle length, count or anchor daughter.
    if (!periodValue && !countMatch && !lead && !namedLead && !namedTail) continue;
    const sourceText = input.slice(match.index, end);
    pattern.lastIndex = Math.max(pattern.lastIndex, end);
    const days: number[] = [], seen = new Set<number>();
    let error: string | undefined;
    for (const part of list.match(/\d{1,3}(?:\s*[-–]\s*\d{1,3})?/gu) ?? []) {
      const [first, last = first] = part.split(/\s*[-–]\s*/u).map(Number);
      if (first < 1 || last < first || last > 366) { error = 'invalid-cycle-day-range'; break; }
      for (let d = first; d <= last; d++) if (!seen.has(d)) { seen.add(d); days.push(d); }
    }
    const cycles = count ? Number(count) : 1, periodDays = periodValue ? Number(periodValue) : undefined;
    if (!days.length || cycles < 1 || cycles > 100 || cycles * days.length > 10000) error ??= 'invalid-cycle-size';
    if (periodDays !== undefined && (periodDays < 1 || days.some(d => d > periodDays))) error ??= 'day-outside-cycle';
    if (cycles > 1 && !periodDays) error ??= 'missing-cycle-length';
    if (periodDays && !count) error ??= 'unbounded-cycle-count';
    const anchor = anchorMatch?.events.length === 1 && !anchorMatch.unresolved ? anchorMatch.events[0] : undefined;
    if (!anchor) error ??= 'missing-or-unresolved-cycle-anchor';
    const events: CanonicalCalendarEventExpr[] = [];
    if (!error && anchor) for (let cycle = 0; cycle < cycles; cycle++) for (const day of days) {
      const date = new Date(`${anchor.isoDate}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + cycle * (periodDays ?? 0) + day - 1);
      const isoDate = date.toISOString().slice(0, 10);
      events.push({ isoDate, calendar: 'gregory', calendarYear: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1, day: date.getUTCDate(), sourceText, inferredYear: anchor.inferredYear });
    }
    result.push({ kind: 'calendar-days', start: match.index, end, sourceText, days, cycles,
      ...(count ? { repeatCount: cycles } : {}),
      periodDays, anchor: anchor?.isoDate, events, error });
  }
  return result.sort((left, right) => left.start - right.start || right.end - left.end);
}
const CYCLES_BY_CONTEXT = new WeakMap<HpsgClauseContext, CycleSchedule[]>();
function contextCycles(context: HpsgClauseContext): CycleSchedule[] {
  let list = CYCLES_BY_CONTEXT.get(context);
  if (!list) { list = recognizeCycles(context.state.input, context.options, context.tokens); CYCLES_BY_CONTEXT.set(context, list); }
  return list;
}
/** Finite cycles emit exact events; recurring active/rest cycles emit their
 * typed active duration and whole-course repeat interval on the same sign. */
export function cycleScheduleRule() {
  return lexicalRule('hpsg.lex.schedule.finiteCycle', (context, start) => {
    const first = context.tokens[start];
    const cycle = contextCycles(context).find(c => c.start === first?.sourceStart);
    if (!cycle) return [];
    const tokens = context.tokens.slice(start).filter(t => t.sourceStart < cycle.end);
    if (!tokens.length || tokens[tokens.length - 1].sourceEnd > cycle.end) return [];
    // Every recognizable but non-executable cycle is a SINGLE typed
    // calendar-ordinal constituent, even if its anchor/count is invalid.
    // Its day ordinals are NEVER medication doses; preserve the source
    // for correction while retaining the independent prescribed quantity.
    // Executable cycles still produce real calendar events below.
    if (cycle.error) {
      return [lexicalSign({
        type: 'instruction-sign',
        rule: 'hpsg.lex.instruction.unanchoredCycle',
        tokens,
        synsem: {
          head: { schedule: { cycleDayConstraint: {
            days: cycle.days,
            ...(cycle.periodDays !== undefined ? { periodDays: cycle.periodDays } : {}),
            ...(cycle.repeatCount !== undefined ? { cycles: cycle.repeatCount } : {}),
            ...(cycle.anchor ? { anchor: cycle.anchor } : {}),
            reason: cycle.error,
            sourceText: cycle.sourceText
          }, sourceRanges: [{ start: cycle.start, end: cycle.end }] } },
          // Multiple independent counseling actions can follow this cycle.
          // Use the repeatable typed instruction valence, not the singular
          // patientInstruction slot that a subsequent HOLD could overwrite.
          valence: { instructions: [{ text: cycle.sourceText }] },
          cont: { clauseKind: 'administration' }
        },
        scheduleFields: ['cycleDayConstraint'],
        warnings: [
`Unresolved schedule: cycle day offsets cannot execute (${cycle.error}); confirm or correct the cycle while retaining the prescribed dose.`
        ],
        score: 30 + tokens.length
      })];
    }
    if (cycle.sign) return [cycle.sign];
    const schedule = { calendarEvents: cycle.events };
    return [lexicalSign({ type: 'schedule-sign', rule: 'hpsg.lex.schedule.finiteCycle', tokens,
      synsem: { head: { schedule: {
        ...schedule,
        // Calendar day-list ownership retains its exact lexical source.
        sourceRanges: [{ start: cycle.start, end: cycle.end }]
      } }, valence: {}, cont: { clauseKind: 'administration' } },
      scheduleFields: ['calendarEvents'],
      score: 48 + tokens.length })];
  });
}
