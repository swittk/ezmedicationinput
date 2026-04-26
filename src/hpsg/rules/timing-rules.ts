import {
  DAY_OF_WEEK_TOKENS,
  EVENT_TIMING_TOKENS,
  TIMING_ABBREVIATIONS,
  WORD_FREQUENCIES
} from "../../maps";
import { getDayOfWeekMeaning, TokenWordClass } from "../../lexer/meaning";
import { LexKind } from "../../lexer/token-types";
import { Token } from "../../parser-state";
import { EventTiming, FhirDayOfWeek, FhirPeriodUnit } from "../../types";
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
  normalizePeriodRange,
  normalizePeriodValue,
  parseNumericRange
} from "../timing-lexicon";
import {
  CLOCK_LEAD_TOKENS,
  COMPACT_LIST_SEPARATORS,
  DAY_RANGE_CONNECTORS,
  DURATION_LEAD_TOKENS,
  EVENT_ARTICLE_TOKENS,
  EVENT_PREPOSITIONS,
  FIXED_EVENT_PHRASES,
  FOOD_EVENT_ALIASES,
  LIST_SEPARATORS,
  MEAL_RELATION_BY_TOKEN,
  MEAL_TIMING_BY_RELATION,
  RANGE_CONNECTORS,
  SCHEDULE_UNIT_SEPARATOR_TOKENS,
  SLEEP_EVENT_ALIASES,
  WAKE_EVENT_ALIASES
} from "../lexical-classes";
import {
  HpsgClauseContext,
  isAmPmLower,
  isClockLikeLower,
  lexicalRule,
  normalizeTokenLower,
  parseClockToken,
  splitByLexicalSeparators,
  tokensAvailable
} from "../rule-context";
import { HpsgLexicalRule, HpsgSign, lexicalSign } from "../signature";

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
          score: 9
        })
      ];
    }
    const unitToken = context.tokens[start + 2];
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
    if (!unit || !/^[0-9]+(?:\.[0-9]+)?$/.test(quantityLower)) {
      return [];
    }
    return [
      lexicalSign({
        type: "schedule-sign",
        rule: "hpsg.lex.schedule.separatedInterval",
        tokens: [lead, quantity, unitToken],
        synsem: {
          head: { schedule: buildPeriodScheduleFeature(parseFloat(quantity.original), unit) },
          valence: {},
          cont: { clauseKind: "administration" }
        },
        score: 10
      })
    ];
  });
}

export function countFrequencyRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.frequency", (context, start) => {
    const token = tokensAvailable(context, start, 1)?.[0];
    if (!token) {
      return [];
    }
    const lower = normalizeTokenLower(token);
    const value =
      FREQUENCY_SIMPLE_WORDS[lower] ??
      FREQUENCY_NUMBER_WORDS[lower] ??
      (token.kind === LexKind.Number ? token.value : undefined);
    if (value === undefined || value <= 0) {
      return [];
    }
    const consumed = [token];
    let cursor = start + 1;
    let sawCue = lower in FREQUENCY_SIMPLE_WORDS;
    let sawCadenceContinuation = false;
    let period = 1;
    let periodUnit: FhirPeriodUnit | undefined;
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
      const adverbUnit = mapFrequencyAdverb(candidateLower);
      if (adverbUnit) {
        sawCadenceContinuation = true;
        consumed.push(candidate);
        periodUnit = adverbUnit;
        break;
      }
      const unit = mapIntervalUnit(candidateLower);
      if (unit) {
        if (!sawCue && token.kind === LexKind.Number) {
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
              period: normalizedPeriod.value,
              periodUnit: normalizedPeriod.unit,
              timingCode:
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

export function timingLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.timing", (context, start) => {
    const token = tokensAvailable(context, start, 1)?.[0];
    if (!token) {
      return [];
    }
    const lower = normalizeTokenLower(token);
    const abbreviationKey = lower.replace(/\./g, "");
    const descriptor = TIMING_ABBREVIATIONS[abbreviationKey];
    if (descriptor) {
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
    const wordFrequency = WORD_FREQUENCIES[lower];
    if (wordFrequency) {
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

    const fixedPhrase = secondLower ? FIXED_EVENT_PHRASES.get(`${firstLower} ${secondLower}`) : undefined;
    if (fixedPhrase) {
      signs.push(
        lexicalSign({
          type: "schedule-sign",
          rule: "hpsg.lex.schedule.eventPhrase.fixed",
          tokens: [first, second],
          synsem: {
            head: { schedule: { when: [fixedPhrase] } },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: 15
        })
      );
    }

    if (EVENT_PREPOSITIONS.has(firstLower) && secondLower) {
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
    if (relation && secondLower) {
      const meal = EVENT_TIMING_TOKENS[secondLower];
      const combined = meal ? mealTimingForRelation(relation, meal) : undefined;
      if (combined) {
        signs.push(
          lexicalSign({
            type: "schedule-sign",
            rule: "hpsg.lex.schedule.eventPhrase.mealRelation",
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

    if (relation && secondLower && FOOD_EVENT_ALIASES.has(secondLower)) {
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

    return signs;
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
    const slashParts = splitByLexicalSeparators(firstLower, COMPACT_LIST_SEPARATORS);
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
            score: 20
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

export function countAndDurationRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.limit", (context, start) => {
    const token = tokensAvailable(context, start, 1)?.[0];
    if (!token) {
      return [];
    }
    const lower = normalizeTokenLower(token);
    const signs: HpsgSign[] = [];
    const compactDuration = lower.match(/^[x*]([0-9]+(?:\.[0-9]+)?)(min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|wk|w|week|weeks|mo|month|months)$/);
    if (compactDuration) {
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
      signs.push(
        lexicalSign({
          type: "schedule-sign",
          rule: "hpsg.lex.schedule.count.compact",
          tokens: [token],
          synsem: {
            head: { schedule: { count: parseFloat(countMatch[1]) } },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: 6
        })
      );
    }
    if (COUNT_MARKER_TOKENS.has(lower)) {
      const valueToken = context.tokens[start + 1];
      if (valueToken && !context.state.consumed.has(valueToken.index) && valueToken.kind === LexKind.Number && valueToken.value !== undefined) {
        const unitToken = context.tokens[start + 2];
        const unit = unitToken && !context.state.consumed.has(unitToken.index)
          ? mapIntervalUnit(normalizeTokenLower(unitToken))
          : undefined;
        const tokens = unit ? [token, valueToken, unitToken] : [token, valueToken];
        const schedule = unit
          ? buildDurationScheduleFeature(valueToken.value, unit)
          : { count: valueToken.value };
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
      const valueToken = context.tokens[start + 1];
      const unitToken = context.tokens[start + 2];
      if (
        valueToken &&
        unitToken &&
        !context.state.consumed.has(valueToken.index) &&
        !context.state.consumed.has(unitToken.index) &&
        valueToken.kind === LexKind.Number &&
        valueToken.value !== undefined
      ) {
        const unit = mapIntervalUnit(normalizeTokenLower(unitToken));
        if (unit) {
          const schedule = buildDurationScheduleFeature(valueToken.value, unit);
          if (schedule) {
            signs.push(
              lexicalSign({
                type: "schedule-sign",
                rule: "hpsg.lex.schedule.duration.for",
                tokens: [token, valueToken, unitToken],
                synsem: { head: { schedule }, valence: {}, cont: { clauseKind: "administration" } },
                score: 8
              })
            );
          }
        } else if (
          Array.isArray(unitToken.annotations?.wordClasses) &&
          unitToken.annotations.wordClasses.indexOf(TokenWordClass.CountKeyword) !== -1
        ) {
          signs.push(
            lexicalSign({
              type: "schedule-sign",
              rule: "hpsg.lex.schedule.count.for",
              tokens: [token, valueToken, unitToken],
              synsem: {
                head: { schedule: { count: valueToken.value } },
                valence: {},
                cont: { clauseKind: "administration" }
              },
              score: 8
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
