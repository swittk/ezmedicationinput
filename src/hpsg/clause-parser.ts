import {
  DEFAULT_PRN_REASON_DEFINITIONS,
  DEFAULT_ROUTE_SYNONYMS,
  EVENT_TIMING_TOKENS,
  ROUTE_TEXT,
  TIMING_ABBREVIATIONS,
  WORD_FREQUENCIES,
  normalizeBodySiteKey,
  normalizePrnReasonKey
} from "../maps";
import { getDayOfWeekMeaning, getPrimarySiteMeaningCandidate, getRouteMeaning, hasTokenWordClass, isAdministrationVerbWord, TokenWordClass } from "../lexer/meaning";
import { LexKind } from "../lexer/token-types";
import { ParserState, Token } from "../parser-state";
import { resolveBodySitePhrase } from "../body-site-grammar";
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
  normalizePeriodValue,
  parseNumericRange
} from "./timing-lexicon";
import { FhirPeriodUnit, ParseOptions, PrnReasonLookupRequest, RouteCode } from "../types";
import { normalizeUnit } from "../unit-lexicon";
import { parseHpsgChart } from "./chart";
import { cloneMethodCoding, METHOD_ACTION_BY_VERB, METHOD_CODING_BY_ACTION } from "./method-lexicon";
import { projectHpsgSignToState, HpsgProjectionDeps } from "./projection";
import { HpsgGrammar, HpsgLexicalRule, HpsgPhraseRule, HpsgSign, emptySynsem, lexicalSign } from "./signature";
import { combineSigns, HpsgUnificationContext } from "./unification";

const SITE_ANCHORS = new Set([
  "to",
  "in",
  "into",
  "on",
  "onto",
  "at",
  "inside",
  "within"
]);

const SITE_FILLERS = new Set(["the", "a", "an", "your", "his", "her", "their", "my"]);
const CONNECTORS = new Set(["per", "a", "an", "the", "of", "and", "or", ","]);
const PRN_LEADS = new Set(["prn"]);
const PRN_REASON_LEAD_INS = new Set(["for"]);
const PRN_REASON_SITE_CONNECTORS = new Set(["at", "in", "on", "to"]);
const PRN_REASON_COORDINATORS = new Set([
  ",",
  "/",
  "and",
  "or",
  "and/or",
  "หรือ",
  "และ"
]);
const PRN_GENERIC_LOCATED_HEADS = new Map<string, string>([
  ["ache", "pain"],
  ["aches", "pain"],
  ["itchiness", "itch"],
  ["itching", "itch"],
  ["itchy", "itch"],
  ["pains", "pain"]
]);

export interface HpsgClauseContext {
  state: ParserState;
  tokens: Token[];
  options?: ParseOptions;
  limit: number;
  deps: HpsgProjectionDeps & HpsgUnificationContext;
  project?: boolean;
}

function normalizeTokenLower(token: Token): string {
  return token.lower.replace(/[{};]/g, "").replace(/^\.+|\.+$/g, "");
}

function isPunctuation(lower: string): boolean {
  return !lower || /^[;:(),]+$/.test(lower);
}

function isClockLikeLower(lower: string): boolean {
  return /^[0-9]{1,2}[:.][0-9]{2}$/.test(lower);
}

function isAmPmLower(lower: string): boolean {
  return lower === "am" || lower === "pm";
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function parseClockToken(
  token: Token | undefined,
  meridiemToken?: Token | undefined
): { value: string; tokens: Token[] } | undefined {
  if (!token) {
    return undefined;
  }
  const lower = normalizeTokenLower(token);
  const meridiem = meridiemToken ? normalizeTokenLower(meridiemToken) : undefined;
  let hour: number;
  let minute = 0;
  const clock = lower.match(/^([0-9]{1,2})[:.]([0-9]{2})$/);
  if (clock) {
    hour = parseInt(clock[1], 10);
    minute = parseInt(clock[2], 10);
  } else if (/^[0-9]{1,2}$/.test(lower) && meridiem && isAmPmLower(meridiem)) {
    hour = parseInt(lower, 10);
  } else {
    return undefined;
  }
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) {
    return undefined;
  }
  if (meridiem && isAmPmLower(meridiem)) {
    if (hour < 1 || hour > 12) {
      return undefined;
    }
    if (meridiem === "pm" && hour !== 12) {
      hour += 12;
    }
    if (meridiem === "am" && hour === 12) {
      hour = 0;
    }
    return {
      value: `${pad2(hour)}:${pad2(minute)}:00`,
      tokens: [token, meridiemToken as Token]
    };
  }
  if (hour < 0 || hour > 23) {
    return undefined;
  }
  return {
    value: `${pad2(hour)}:${pad2(minute)}:00`,
    tokens: [token]
  };
}

function tokensAvailable(context: HpsgClauseContext, start: number, span: number): Token[] | undefined {
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

function rangeFromTokens(tokens: Token[]): { start: number; end: number } | undefined {
  if (!tokens.length) {
    return undefined;
  }
  return {
    start: tokens[0].sourceStart,
    end: tokens[tokens.length - 1].sourceEnd
  };
}

function lexicalRule(id: string, match: HpsgLexicalRule<HpsgClauseContext>["match"]): HpsgLexicalRule<HpsgClauseContext> {
  return { id, type: "word-sign", match };
}

function methodLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.method", (context, start) => {
    const tokens = tokensAvailable(context, start, 1);
    const token = tokens?.[0];
    if (!tokens || !token) {
      return [];
    }
    const verb = normalizeTokenLower(token);
    if (
      !METHOD_ACTION_BY_VERB[verb] ||
      (
        !hasTokenWordClass(token, TokenWordClass.AdministrationVerb) &&
        !isAdministrationVerbWord(token.lower)
      )
    ) {
      return [];
    }
    const action = METHOD_ACTION_BY_VERB[verb];
    const route = getRouteMeaning(token);
    return [
      lexicalSign({
        type: "method-sign",
        rule: "hpsg.lex.method",
        tokens,
        synsem: {
          head: {
            method: {
              verb,
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

function routeLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.route", (context, start) => {
    const signs: HpsgSign[] = [];
    const maxSpan = Math.min(6, context.limit - start);
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
      const customCode = context.options?.routeMap?.[phrase];
      const tokenRoute = span === 1 ? getRouteMeaning(tokens[0]) : undefined;
      const route = customCode
        ? { code: customCode, text: ROUTE_TEXT[customCode] }
        : tokenRoute ?? DEFAULT_ROUTE_SYNONYMS[phrase];
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

function unitAfter(context: HpsgClauseContext, start: number): { unit: string; tokens: Token[] } | undefined {
  const token = context.tokens[start];
  if (!token || context.state.consumed.has(token.index)) {
    return undefined;
  }
  const lower = normalizeTokenLower(token);
  const direct = normalizeUnit(lower, context.options);
  if (direct) {
    return { unit: direct, tokens: [token] };
  }
  if (lower === "fingertip") {
    const next = context.tokens[start + 1];
    if (next && !context.state.consumed.has(next.index)) {
      const nextLower = normalizeTokenLower(next);
      if (nextLower === "unit" || nextLower === "units") {
        return { unit: "fingertip unit", tokens: [token, next] };
      }
    }
  }
  return undefined;
}

function doseLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.dose", (context, start) => {
    const tokens = tokensAvailable(context, start, 1);
    const token = tokens?.[0];
    if (!tokens || !token) {
      return [];
    }
    const lower = normalizeTokenLower(token);
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

function multiplicativeDoseFrequencyRule(): HpsgLexicalRule<HpsgClauseContext> {
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

function compactIntervalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.compactInterval", (context, start) => {
    const tokens = tokensAvailable(context, start, 1);
    const token = tokens?.[0];
    if (!tokens || !token) {
      return [];
    }
    const match = normalizeTokenLower(token).match(/^q([0-9]+(?:\.[0-9]+)?)([a-z]+)$/);
    if (!match) {
      return [];
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

function separatedIntervalRule(): HpsgLexicalRule<HpsgClauseContext> {
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
    const unit = unitToken && !context.state.consumed.has(unitToken.index)
      ? mapIntervalUnit(normalizeTokenLower(unitToken))
      : undefined;
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

function countFrequencyRule(): HpsgLexicalRule<HpsgClauseContext> {
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
                value === 1 && normalizedPeriod.value === 1 && normalizedPeriod.unit === FhirPeriodUnit.Day
                  ? "QD"
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

function timingLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.timing", (context, start) => {
    const token = tokensAvailable(context, start, 1)?.[0];
    if (!token) {
      return [];
    }
    const lower = normalizeTokenLower(token);
    const descriptor = TIMING_ABBREVIATIONS[lower];
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

function countAndDurationRule(): HpsgLexicalRule<HpsgClauseContext> {
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
    if (lower === "for") {
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
        } else if (unitToken.annotations?.wordClasses?.indexOf(TokenWordClass.CountKeyword) !== -1) {
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

function timeOfDayRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.timeOfDay", (context, start) => {
    let cursor = start;
    const consumed: Token[] = [];
    const lead = context.tokens[cursor];
    if (!lead || context.state.consumed.has(lead.index)) {
      return [];
    }
    const leadLower = normalizeTokenLower(lead);
    if (leadLower === "@" || leadLower === "at") {
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
      if (separatorLower !== "," && separatorLower !== "and") {
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

function siteBoundary(lower: string, context: HpsgClauseContext): boolean {
  return (
    isPunctuation(lower) ||
    lower === "prn" ||
    Boolean(
      METHOD_ACTION_BY_VERB[lower] ||
      DEFAULT_ROUTE_SYNONYMS[lower] ||
      normalizeUnit(lower, context.options) ||
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

function prnReasonBoundary(lower: string, context: HpsgClauseContext): boolean {
  return (
    (isPunctuation(lower) && !PRN_REASON_COORDINATORS.has(lower)) ||
    Boolean(
      METHOD_ACTION_BY_VERB[lower] ||
      DEFAULT_ROUTE_SYNONYMS[lower] ||
      normalizeUnit(lower, context.options) ||
      TIMING_ABBREVIATIONS[lower] ||
      WORD_FREQUENCIES[lower] ||
      EVENT_TIMING_TOKENS[lower] ||
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

function joinTokenText(tokens: Token[]): string {
  return tokens
    .map((token) => token.original)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
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

  const resolvedSite = resolveBodySitePhrase(first.original, context.options?.siteCodeMap);
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
  const site = siteText ? resolveBodySitePhrase(siteText, context.options?.siteCodeMap) : undefined;
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
      locativeSiteCoding: site?.coding,
      isProbe: false,
      inputText: context.state.input,
      sourceText: range ? context.state.input.slice(range.start, range.end) : text,
      range
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
  previousLocatedHead?: ParsedPrnReasonAtom["locatedHead"]
): ParsedPrnReasonAtom | undefined {
  const directText = joinTokenText(tokens);
  if (!directText) {
    return undefined;
  }
  if (isKnownPrnReasonText(directText)) {
    return createPrnReasonRequest(context, directText, tokens);
  }

  const connectorIndex = tokens.findIndex((token) =>
    PRN_REASON_SITE_CONNECTORS.has(normalizeTokenLower(token))
  );
  if (connectorIndex > 0 && connectorIndex < tokens.length - 1) {
    const headText = joinTokenText(tokens.slice(0, connectorIndex));
    const siteText = joinTokenText(tokens.slice(connectorIndex + 1));
    if (headText && siteText) {
      return createPrnReasonRequest(context, directText, tokens, headText, siteText);
    }
  }

  for (let index = 1; index < tokens.length; index += 1) {
    const headText = joinTokenText(tokens.slice(0, index));
    const siteText = joinTokenText(tokens.slice(index));
    if (isLocatedReasonHead(headText) && resolveBodySitePhrase(siteText, context.options?.siteCodeMap)) {
      return createPrnReasonRequest(context, directText, tokens, headText, siteText);
    }
  }

  for (let index = tokens.length - 1; index > 0; index -= 1) {
    const siteText = joinTokenText(tokens.slice(0, index));
    const headText = joinTokenText(tokens.slice(index));
    if (isLocatedReasonHead(headText) && resolveBodySitePhrase(siteText, context.options?.siteCodeMap)) {
      return createPrnReasonRequest(context, directText, tokens, headText, siteText);
    }
  }

  if (previousLocatedHead && resolveBodySitePhrase(directText, context.options?.siteCodeMap)) {
    const text = `${previousLocatedHead.text} at ${directText}`;
    return createPrnReasonRequest(context, text, tokens, previousLocatedHead.text, directText);
  }

  return createPrnReasonRequest(context, directText, tokens);
}

function parsePrnReasonAtoms(
  context: HpsgClauseContext,
  reasonTokens: Token[]
): ParsedPrnReasonAtom[] {
  if (reasonTokens.length === 1) {
    const token = reasonTokens[0];
    const text = token.original.trim();
    if (text.includes("/") && !isKnownPrnReasonText(text)) {
      const parts = text.split("/").map((part) => part.trim()).filter(Boolean);
      if (parts.length > 1 && parts.every((part) => isKnownPrnReasonText(part) || isLocatedReasonHead(part))) {
        return parts.map((part) => createPrnReasonRequest(context, part, [token]));
      }
    }
  }

  const atoms: ParsedPrnReasonAtom[] = [];
  let previousLocatedHead: ParsedPrnReasonAtom["locatedHead"];
  for (const part of splitPrnReasonParts(reasonTokens)) {
    const atom = parseLocatedPrnAtom(context, part, previousLocatedHead);
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

function prnLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.prn", (context, start) => {
    const lead = tokensAvailable(context, start, 1)?.[0];
    if (!lead) {
      return [];
    }
    const leadLower = normalizeTokenLower(lead);
    let cursor = start + 1;
    const tokens = [lead];
    if (leadLower === "as") {
      const needed = context.tokens[start + 1];
      if (!needed || normalizeTokenLower(needed) !== "needed") {
        return [];
      }
      tokens.push(needed);
      cursor = start + 2;
    } else if (!PRN_LEADS.has(leadLower)) {
      return [];
    }
    const maybeFor = context.tokens[cursor];
    if (
      maybeFor &&
      !context.state.consumed.has(maybeFor.index) &&
      PRN_REASON_LEAD_INS.has(normalizeTokenLower(maybeFor))
    ) {
      tokens.push(maybeFor);
      cursor += 1;
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
        !canContinuePrnReasonAfterSeparator(context, cursor)
      ) {
        break;
      }
      if (!PRN_REASON_COORDINATORS.has(lower) && prnReasonBoundary(lower, context)) {
        break;
      }
      tokens.push(candidate);
      reasonTokens.push(candidate);
    }

    const reasonText = reasonTokens
      .map((token) => token.original)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const range = rangeFromTokens(reasonTokens);
    const reasonAtoms = parsePrnReasonAtoms(context, reasonTokens);
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

function siteLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.site", (context, start) => {
    const token = tokensAvailable(context, start, 1)?.[0];
    if (!token) {
      return [];
    }
    const signs: HpsgSign[] = [];
    const siteCandidate = getPrimarySiteMeaningCandidate(token);
    if (siteCandidate) {
      signs.push(
        lexicalSign({
          type: "site-sign",
          rule: "hpsg.lex.site.abbreviation",
          tokens: [token],
          synsem: {
            head: { route: siteCandidate.route ? { code: siteCandidate.route } : undefined },
            valence: { site: { text: siteCandidate.text, source: "abbreviation" } },
            cont: { clauseKind: "administration" }
          },
          siteTokenIndices: [token.index],
          score: 8
        })
      );
    }
    const lower = normalizeTokenLower(token);
    if (!SITE_ANCHORS.has(lower)) {
      return signs;
    }
    const firstAfterAnchor = context.tokens[start + 1];
    const secondAfterAnchor = context.tokens[start + 2];
    const firstAfterAnchorLower = firstAfterAnchor && !context.state.consumed.has(firstAfterAnchor.index)
      ? normalizeTokenLower(firstAfterAnchor)
      : undefined;
    const secondAfterAnchorLower = secondAfterAnchor && !context.state.consumed.has(secondAfterAnchor.index)
      ? normalizeTokenLower(secondAfterAnchor)
      : undefined;
    if (
      firstAfterAnchorLower &&
      (
        isClockLikeLower(firstAfterAnchorLower) ||
        (
          /^[0-9]{1,2}$/.test(firstAfterAnchorLower) &&
          Boolean(secondAfterAnchorLower && isAmPmLower(secondAfterAnchorLower))
        )
      )
    ) {
      return signs;
    }
    const phraseTokens: Token[] = [token];
    const displayTokens: Token[] = [];
    for (let cursor = start + 1; cursor < context.limit; cursor += 1) {
      const candidate = context.tokens[cursor];
      if (!candidate || context.state.consumed.has(candidate.index)) {
        break;
      }
      const candidateLower = normalizeTokenLower(candidate);
      if (siteBoundary(candidateLower, context)) {
        break;
      }
      phraseTokens.push(candidate);
      if (!SITE_FILLERS.has(candidateLower) && !CONNECTORS.has(candidateLower)) {
        displayTokens.push(candidate);
      }
    }
    if (!displayTokens.length) {
      return signs;
    }
    const sourceText = displayTokens.map((part) => part.original).join(" ").replace(/\s+/g, " ").trim();
    const resolved = resolveBodySitePhrase(sourceText, context.options?.siteCodeMap);
    const abbreviationCandidate = displayTokens.length === 1
      ? getPrimarySiteMeaningCandidate(displayTokens[0])
      : undefined;
    const displayText = abbreviationCandidate?.text ?? resolved?.displayText ?? sourceText;
    const canonical = resolved?.lookupCanonical ?? normalizeBodySiteKey(displayText);
    const range = rangeFromTokens(displayTokens);
    signs.push(
      lexicalSign({
        type: "site-sign",
        rule: "hpsg.lex.site.anchor",
        tokens: phraseTokens,
        synsem: {
          head: {
            route: abbreviationCandidate?.route
              ? { code: abbreviationCandidate.route }
              : resolved?.definition?.routeHint
              ? { code: resolved.definition.routeHint }
              : undefined
          },
          valence: {
            site: {
              text: displayText,
              source: "text",
              coding: resolved?.coding,
              lookupRequest: {
                originalText: sourceText,
                text: displayText,
                normalized: displayText.toLowerCase(),
                canonical,
                isProbe: false,
                inputText: context.state.input,
                sourceText: range ? context.state.input.slice(range.start, range.end) : sourceText,
                range
              }
            }
          },
          cont: { clauseKind: "administration" }
        },
        siteTokenIndices: displayTokens.map((part) => part.index),
        score: 10 + displayTokens.length
      })
    );
    return signs;
  });
}

function connectorLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.connector", (context, start) => {
    const token = tokensAvailable(context, start, 1)?.[0];
    if (!token) {
      return [];
    }
    const lower = normalizeTokenLower(token);
    if (!CONNECTORS.has(lower) && !isPunctuation(lower)) {
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

function buildGrammar(context: HpsgClauseContext): HpsgGrammar<HpsgClauseContext> {
  const combineRule: HpsgPhraseRule<HpsgClauseContext> = {
    id: "hpsg.phrase.unify-adjacent",
    combine: (_context, left, right) =>
      combineSigns(left, right, context.deps, "hpsg.phrase.unify-adjacent")
  };
  return {
    lexicalRules: [
      methodLexicalRule(),
      routeLexicalRule(),
      multiplicativeDoseFrequencyRule(),
      doseLexicalRule(),
      compactIntervalRule(),
      separatedIntervalRule(),
      countFrequencyRule(),
      timingLexicalRule(),
      countAndDurationRule(),
      timeOfDayRule(),
      prnLexicalRule(),
      siteLexicalRule(),
      connectorLexicalRule()
    ],
    phraseRules: [combineRule]
  };
}

function hasUsefulAnalysis(sign: HpsgSign | undefined): sign is HpsgSign {
  if (!sign) {
    return false;
  }
  const { head, valence } = sign.synsem;
  return Boolean(
    head.method ||
    head.route ||
    head.dose ||
    head.schedule ||
    valence.site ||
    valence.prn ||
    valence.instructions?.length
  );
}

export function parseHpsgClause(context: HpsgClauseContext): HpsgSign | undefined {
  const result = parseHpsgChart(context, buildGrammar(context), {
    limit: context.limit
  });
  if (!hasUsefulAnalysis(result.best)) {
    return undefined;
  }
  if (context.project) {
    projectHpsgSignToState(result.best, context.state, context.tokens, context.deps);
  }
  return result.best;
}
