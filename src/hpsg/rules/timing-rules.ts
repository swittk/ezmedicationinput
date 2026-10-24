import type { MedicationDateListMatch } from "../../date-interpretation";
import {
  DAY_OF_WEEK_TOKENS,
  EVENT_TIMING_TOKENS,
  TIMING_ABBREVIATIONS,
  WORD_FREQUENCIES
} from "../../maps";
import { getDayOfWeekMeaning, TokenWordClass } from "../../lexer/meaning";
import { LexKind } from "../../lexer/token-types";
import { Token } from "../../parser-state";
import { AdviceArgumentRole, AdviceRelation, EventTiming, FhirDayOfWeek, FhirPeriodUnit } from "../../types";
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
  FOOD_EVENT_ALIASES,
  FREQUENCY_ALTERNATIVE_CONNECTORS,
  LIST_SEPARATORS,
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
  WAKE_EVENT_ALIASES
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
import { resolveMedicationInstructionAction } from "../../instruction-action-terminology";
import { medicationInstructionConceptCodings, resolveMedicationInstructionConcept } from "../../instruction-concept-terminology";
import { getDoseUnitKind, normalizeUnit } from "../../unit-lexicon";
import { resolveActionRelationSurface } from "../../relation-terminology";

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
          boundsStart: nextMonthlyOrdinalWeekday(context, weekday, ordinal)
        }
      },
      valence: {},
      cont: { clauseKind: "administration" }
    },
    score: 48 + members.length
  });
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
      if (!spaced) {
        return [];
      }
      dose = first.value;
      frequency = parseFloat(spaced[1]);
      tokens = [first, second];
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

function coordinatedRelatedEventSign(
  context: HpsgClauseContext,
  start: number,
  relation: "before" | "after" | "with"
): HpsgSign | undefined {
  const relationToken = context.tokens[start];
  if (!relationToken || context.state.consumed.has(relationToken.index)) return undefined;
  const firstExpression = eventExpressionPartsAt(context, start + 1);
  const firstResolved = resolveEventTimingExpression(firstExpression.parts);
  if (!firstResolved || firstResolved.length < 2) return undefined;
  const sharedHead = firstExpression.parts.slice(0, firstResolved.length - 1);
  if (!sharedHead.length) return undefined;
  const firstTiming = mealTimingForRelation(relation, firstResolved.timing);
  if (!firstTiming) return undefined;

  const timings: EventTiming[] = [firstTiming];
  const members: Token[] = [
    relationToken,
    ...firstExpression.members.slice(0, firstResolved.length)
  ];
  let cursor = start + 1 + firstResolved.length;
  while (cursor + 1 < context.limit) {
    const separator = context.tokens[cursor];
    const tail = context.tokens[cursor + 1];
    if (
      !separator || !tail ||
      context.state.consumed.has(separator.index) ||
      context.state.consumed.has(tail.index) ||
      !LIST_SEPARATORS.has(normalizeTokenLower(separator))
    ) break;
    const synthetic = [...sharedHead, normalizeTokenLower(tail)];
    const resolvedTail = resolveEventTimingExpression(synthetic);
    if (!resolvedTail || resolvedTail.length !== synthetic.length) break;
    const relatedTail = mealTimingForRelation(relation, resolvedTail.timing);
    if (!relatedTail) break;
    members.push(separator, tail);
    timings.push(relatedTail);
    cursor += 2;
  }
  if (timings.length < 2) return undefined;
  return lexicalSign({
    type: "schedule-sign",
    rule: "hpsg.lex.schedule.eventPhrase.coordinatedHeadEllipsis",
    tokens: members,
    synsem: {
      head: { schedule: { when: timings } },
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
    if (!resolvedEvent) return [];
    const timing = mealTimingForRelation(relation, resolvedEvent.timing);
    if (!timing) return [];
    const eventTokens = relatedExpression.members.slice(0, resolvedEvent.length);

    const tokens = [
      ...context.tokens.slice(start, cursor),
      valueToken,
      ...(unitIndex > cursor + 1 ? [possibleArticle] : []),
      unitToken,
      relationToken,
      ...eventTokens
    ].filter((token): token is Token => Boolean(token));
    const schedule = minimumLead
      ? { when: [timing], offsetMin: minutes }
      : maximumLead
        ? { when: [timing], offsetMax: minutes }
        : { when: [timing], offset: minutes };

    return [lexicalSign({
      type: "schedule-sign",
      rule: "hpsg.lex.schedule.eventOffset.quantityFirst",
      tokens,
      synsem: {
        head: { schedule },
        valence: {},
        cont: { clauseKind: "administration" }
      },
      score: 29 + tokens.length
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
    const eventTokens = relatedExpression.members.slice(0, resolvedEvent.length);
    let cursor = start + 1 + resolvedEvent.length;

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
        tokens, synsem: { head: { schedule: { when: [timing], offset: 0 } },
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
      ...context.tokens.slice(start + 1 + resolvedEvent.length, cursor),
      valueToken,
      ...(unitIndex > cursor + 1 ? [possibleArticle] : []),
      unitToken
    ].filter((token): token is Token => Boolean(token));
    const schedule = minimumLead
      ? { when: [timing], offsetMin: minutes }
      : maximumLead
        ? { when: [timing], offsetMax: minutes }
        : { when: [timing], offset: minutes };

    return [lexicalSign({
      type: "schedule-sign",
      rule: "hpsg.lex.schedule.eventOffset",
      tokens,
      synsem: {
        head: { schedule },
        valence: {},
        cont: { clauseKind: "administration" }
      },
      score: 28 + tokens.length
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

export function countAndDurationRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.limit", (context, start) => {
    const token = tokensAvailable(context, start, 1)?.[0];
    if (!token) {
      return [];
    }
    const lower = normalizeTokenLower(token);
    const signs: HpsgSign[] = [];
    const relativeInterval = relativeAdministrationIntervalSign(context, start, token, lower);
    if (relativeInterval) return [relativeInterval];
    // A common zero-space duration NP is still one source-backed lexical
    // constituent: declared duration lead + positive number + known time unit.
    // This grammar sign owns the original contiguous span; neither a generic
    // scanner rewrite nor an additional parser pass is required.
    const compactPrefixedDuration = compactDurationParts(lower);
    if (compactPrefixedDuration) {
      const unit = mapIntervalUnit(compactPrefixedDuration.unitSurface);
      const schedule = unit
        ? buildDurationScheduleFeature(compactPrefixedDuration.value, unit)
        : undefined;
      if (schedule && !timingRangeIsProcedureLocalDuration(
        context, token.sourceStart, token.sourceEnd
      )) {
        return [lexicalSign({
          type: "schedule-sign",
          rule: "hpsg.lex.schedule.duration.compactQuantity",
          tokens: [token],
          synsem: { head: { schedule }, valence: {}, cont: { clauseKind: "administration" } },
          score: 20
        })];
      }
    }
    // The relation-led construction owns this suffix when it is valid. An
    // infusion method such as `drip in 30 minutes` rejects that construction,
    // so its ordinary administration-duration daughter remains available.
    if (precedingLeadingRelativeAdministrationInterval(context, start)) return signs;
    const maximumLead = MAXIMUM_COUNT_LEAD_FIRST_TOKENS.has(lower)
      ? maximumCountLeadAt(context, start)
      : undefined;
    if (maximumLead) {
      const valueIndex = start + maximumLead.length;
      const valueToken = context.tokens.slice(valueIndex, valueIndex + 1).shift();
      const occurrenceToken = context.tokens.slice(valueIndex + 1, valueIndex + 2).shift();
      const countValue = exactCountCardinalValue(valueToken);
      if (
        valueToken && !context.state.consumed.has(valueToken.index) &&
        countValue !== undefined &&
        occurrenceToken && !context.state.consumed.has(occurrenceToken.index) &&
        OCCURRENCE_COUNT_WORDS.has(normalizeTokenLower(occurrenceToken))
      ) {
        const period = occurrenceCapPeriodAt(context, valueIndex + 2);
        if (period) {
          const matched = [...maximumLead, valueToken, occurrenceToken, ...period.tokens];
          signs.push(lexicalSign({
            type: "schedule-sign",
            rule: "hpsg.lex.schedule.occurrenceCap.maximum",
            tokens: matched,
            synsem: {
              head: {
                schedule: {
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
        const matched = [...maximumLead, valueToken, occurrenceToken];
        signs.push(lexicalSign({
          type: "schedule-sign",
          rule: "hpsg.lex.schedule.count.maximum",
          tokens: matched,
          synsem: {
            head: { schedule: { count: 1, countMax: countValue } },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: 18 + matched.length
        }));
        return signs;
      }
    }
    // Quantity modifiers head an ordinary duration NP in forms such as
    // `for an additional 7 days` and Thai `อีก 7 วัน`.
    // The modifier belongs to the course-duration constituent; leaving it as
    // opaque text would make an otherwise complete subsequent phase fail.
    let modifierCursor = start;
    const durationLead = DURATION_LEAD_TOKENS.has(lower) ? token : undefined;
    if (durationLead) modifierCursor += 1;
    const possibleArticle = context.tokens[modifierCursor];
    const article = possibleArticle && !context.state.consumed.has(possibleArticle.index) &&
      EVENT_OFFSET_ARTICLES.has(normalizeTokenLower(possibleArticle))
      ? possibleArticle
      : undefined;
    if (article) modifierCursor += 1;
    const durationModifier = context.tokens[modifierCursor];
    // An indefinite article is the singular quantity of a headed duration
    // phrase (for a week / for an hour), not a free-standing numeric dose.
    const singularUnit = durationLead && article && durationModifier &&
      !context.state.consumed.has(durationModifier.index)
      ? mapIntervalUnit(normalizeTokenLower(durationModifier)) : undefined;
    if (singularUnit && durationLead && article && durationModifier &&
        !timingRangeIsProcedureLocalDuration(
          context, durationLead.sourceStart, durationModifier.sourceEnd
        )) {
      const schedule = buildDurationScheduleFeature(1, singularUnit);
      if (schedule) return [lexicalSign({
        type: "schedule-sign",
        rule: "hpsg.lex.schedule.duration.indefiniteQuantity",
        tokens: [durationLead, article, durationModifier],
        synsem: { head: { schedule }, valence: {}, cont: { clauseKind: "administration" } },
        score: 21
      })];
    }
    if (
      durationModifier && !context.state.consumed.has(durationModifier.index) &&
      OCCURRENCE_COUNT_MODIFIERS.has(normalizeTokenLower(durationModifier))
    ) {
      const valueToken = context.tokens[modifierCursor + 1];
      const unitToken = context.tokens[modifierCursor + 2];
      const value = frequencyCardinalValue(valueToken);
      const unit = unitToken && !context.state.consumed.has(unitToken.index)
        ? mapIntervalUnit(normalizeTokenLower(unitToken))
        : undefined;
      if (
        valueToken && !context.state.consumed.has(valueToken.index) &&
        value !== undefined && value > 0 && unitToken && unit &&
        !timingRangeIsProcedureLocalDuration(
          context, durationModifier.sourceStart, unitToken.sourceEnd
        )
      ) {
        const schedule = buildDurationScheduleFeature(value, unit);
        if (schedule) {
          const matched = [
            ...(durationLead ? [durationLead] : []),
            ...(article ? [article] : []),
            durationModifier,
            valueToken,
            unitToken
          ];
          return [lexicalSign({
            type: "schedule-sign",
            rule: "hpsg.lex.schedule.duration.quantityModified",
            tokens: matched,
            synsem: {
              head: { schedule },
              valence: {},
              cont: { clauseKind: "administration" }
            },
            score: 18 + matched.length
          })];
        }
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
    if (token.kind === LexKind.Number && token.value !== undefined) {
      const unitToken = context.tokens[start + 1];
      const previousToken = context.tokens[start - 1];
      const unit = unitToken && !context.state.consumed.has(unitToken.index)
        ? mapIntervalUnit(normalizeTokenLower(unitToken))
        : undefined;
      const governedByIntervalLead = Boolean(
        previousToken && EVERY_INTERVAL_TOKENS.has(normalizeTokenLower(previousToken))
      );
      const governedByRangeConnector = Boolean(
        previousToken && RANGE_CONNECTORS.has(normalizeTokenLower(previousToken))
      );
      const governedByActivityWindow = Boolean(
        unit && semanticActivityWindowAt(context, start + 2)
      );
      if (unit && !governedByIntervalLead && !governedByRangeConnector && !governedByActivityWindow &&
        !timingRangeIsProcedureLocalDuration(context, token.sourceStart, unitToken.sourceEnd)) {
        const schedule = buildDurationScheduleFeature(token.value, unit);
        if (schedule) {
          signs.push(
            lexicalSign({
              type: "schedule-sign",
              rule: "hpsg.lex.schedule.duration.bare",
              tokens: [token, unitToken],
              synsem: { head: { schedule }, valence: {}, cont: { clauseKind: "administration" } },
              score: 7
            })
          );
        }
      }
    }
    const compactDuration = lower.match(/^[x*]([0-9]+(?:\.[0-9]+)?)(min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|wk|w|week|weeks|mo|month|months)$/);
    if (compactDuration) {
      if (timingRangeIsProcedureLocalDuration(context, token.sourceStart, token.sourceEnd)) return signs;
      const schedule = buildDurationScheduleFeature(
        parseFloat(compactDuration[1]),
        mapIntervalUnit(compactDuration[2])
      );
      if (schedule) {
        signs.push(
          lexicalSign({
            type: "schedule-sign",
            rule: "hpsg.lex.schedule.duration.compact",
            tokens: [token],
            synsem: { head: { schedule }, valence: {}, cont: { clauseKind: "administration" } },
            score: 8
          })
        );
      }
    }
    const countMatch = lower.match(/^[x*]([0-9]+(?:\.[0-9]+)?)$/);
    if (countMatch) {
      const unitToken = context.tokens[start + 1];
      const unit = unitToken && !context.state.consumed.has(unitToken.index)
        ? mapIntervalUnit(normalizeTokenLower(unitToken))
        : undefined;
      if (unit) {
        if (timingRangeIsProcedureLocalDuration(context, token.sourceStart, unitToken.sourceEnd)) return signs;
        const schedule = buildDurationScheduleFeature(parseFloat(countMatch[1]), unit);
        if (schedule) {
          signs.push(
            lexicalSign({
              type: "schedule-sign",
              rule: "hpsg.lex.schedule.duration.splitCompact",
              tokens: [token, unitToken],
              synsem: { head: { schedule }, valence: {}, cont: { clauseKind: "administration" } },
              score: 9
            })
          );
        }
        return signs;
      }
      const occurrence = unitToken && !context.state.consumed.has(unitToken.index) &&
        OCCURRENCE_COUNT_WORDS.has(normalizeTokenLower(unitToken))
          ? unitToken : undefined;
      // "*10 doses" is one typed count constituent, not a count followed by
      // uninterpreted clinical text. This also avoids pinning source wording
      // merely because the occurrence noun was left over after parsing.
      signs.push(
        lexicalSign({
          type: "schedule-sign",
          rule: "hpsg.lex.schedule.count.compact",
          tokens: occurrence ? [token, occurrence] : [token],
          synsem: {
            head: { schedule: { count: parseFloat(countMatch[1]) } },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: occurrence ? 7 : 6
        })
      );
    }
    if (COUNT_MARKER_TOKENS.has(lower)) {
      const valueToken = context.tokens[start + 1];
      const value = valueToken?.kind === LexKind.Number
        ? valueToken.value
        : valueToken
          ? FREQUENCY_NUMBER_WORDS[normalizeTokenLower(valueToken)]
          : undefined;
      if (valueToken && !context.state.consumed.has(valueToken.index) &&
          value !== undefined && Number.isFinite(value) && value > 0) {
        const unitToken = context.tokens[start + 2];
        const unit = unitToken && !context.state.consumed.has(unitToken.index)
          ? mapIntervalUnit(normalizeTokenLower(unitToken))
          : undefined;
        const occurrenceToken = !unit && unitToken && !context.state.consumed.has(unitToken.index) &&
          OCCURRENCE_COUNT_WORDS.has(normalizeTokenLower(unitToken))
          ? unitToken
          : undefined;
        const tokens = unit
          ? [token, valueToken, unitToken]
          : occurrenceToken
            ? [token, valueToken, occurrenceToken]
            : [token, valueToken];
        if (unit && timingRangeIsProcedureLocalDuration(context, valueToken.sourceStart, unitToken?.sourceEnd ?? valueToken.sourceEnd)) {
          return signs;
        }
        const schedule = unit
          ? buildDurationScheduleFeature(value, unit)
          : Number.isInteger(value)
            ? { count: value }
            : undefined;
        if (schedule) {
          signs.push(
            lexicalSign({
              type: "schedule-sign",
              rule: unit
                ? "hpsg.lex.schedule.duration.marked"
                : "hpsg.lex.schedule.count.marked",
              tokens,
              synsem: { head: { schedule }, valence: {}, cont: { clauseKind: "administration" } },
              score: 8
            })
          );
        }
      }
    }
    if (DURATION_LEAD_TOKENS.has(lower)) {
      const article = context.tokens[start + 1];
      const hasArticle = article && normalizeTokenLower(article) === "the";
      const valueToken = context.tokens[start + (hasArticle ? 2 : 1)];
      const modifierIndex = start + (hasArticle ? 3 : 2);
      const modifier = context.tokens[modifierIndex];
      const hasCountModifier = Boolean(modifier && !context.state.consumed.has(modifier.index) &&
        OCCURRENCE_COUNT_MODIFIERS.has(normalizeTokenLower(modifier)));
      const unitToken = context.tokens[modifierIndex + (hasCountModifier ? 1 : 0)];
      const initialInterval = valueToken && normalizeTokenLower(valueToken) === "first" ? 1 : undefined;
      if (
        valueToken &&
        unitToken &&
        !context.state.consumed.has(valueToken.index) &&
        !context.state.consumed.has(unitToken.index) &&
        (valueToken.kind === LexKind.Number ||
          valueToken.kind === LexKind.NumberRange ||
          FREQUENCY_NUMBER_WORDS[normalizeTokenLower(valueToken)] !== undefined || initialInterval !== undefined)
      ) {
        const durationRange = valueToken.kind === LexKind.NumberRange
          ? parseNumericRange(normalizeTokenLower(valueToken)) : undefined;
        const durationValue = durationRange?.low ??
          (valueToken.kind === LexKind.Number
            ? valueToken.value
            : initialInterval ?? FREQUENCY_NUMBER_WORDS[normalizeTokenLower(valueToken)]);
        if (durationValue === undefined || !Number.isFinite(durationValue) || durationValue <= 0)
          return signs;
        const unit = mapIntervalUnit(normalizeTokenLower(unitToken));
        if (unit) {
          if (timingRangeIsProcedureLocalDuration(context, valueToken.sourceStart, unitToken.sourceEnd)) return signs;
          const schedule = durationRange && durationRange.high >= durationRange.low
            ? { duration: durationRange.low, durationMax: durationRange.high, durationUnit: unit }
            : buildDurationScheduleFeature(durationValue, unit);
          if (schedule) {
            const tokens = [
              token,
              ...(hasArticle ? [article] : []),
              valueToken,
              ...(hasCountModifier ? [modifier] : []),
              unitToken
            ];
            signs.push(
              lexicalSign({
                type: "schedule-sign",
                rule: hasCountModifier
                  ? "hpsg.lex.schedule.duration.postQuantityModified"
                  : "hpsg.lex.schedule.duration.for",
                tokens,
                synsem: { head: { schedule }, valence: {}, cont: { clauseKind: "administration" } },
                score: 8
              })
            );
          }
        } else if (
          Array.isArray(unitToken.annotations?.wordClasses) &&
          unitToken.annotations.wordClasses.indexOf(TokenWordClass.CountKeyword) !== -1 &&
          !durationRange && Number.isInteger(durationValue)
        ) {
          signs.push(
            lexicalSign({
              type: "schedule-sign",
              rule: "hpsg.lex.schedule.count.for",
              tokens: [token, ...(hasArticle ? [article] : []), valueToken,
                ...(hasCountModifier ? [modifier] : []), unitToken],
              synsem: {
                head: { schedule: { count: durationValue } },
                valence: {},
                cont: { clauseKind: "administration" }
              },
              score: 22
            })
          );
        }
      }
    }
    return signs;
  });
}

export function timeOfDayRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.timeOfDay", (context, start) => {
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
