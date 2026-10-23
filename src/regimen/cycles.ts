import { inferMedicationLocale } from '../locale-detection';
import { parseMedicationDateListAt } from '../date-interpretation';
import { lexicalRule } from '../hpsg/rule-context';
import type { HpsgClauseContext } from '../hpsg/rule-context';
import { lexicalSign } from '../hpsg/signature';
import { FhirPeriodUnit } from '../types';
import type {
  CanonicalCalendarEventExpr,
  CanonicalScheduleSemanticField,
  FhirQuantity,
  ParseOptions
} from '../types';
import { CYCLE_WORDS as W } from '../hpsg/lexical-classes';

declare module '../types' {
  interface CanonicalScheduleExpr {
    /** Typed whole-course interval for a recurring active/rest construction. */
    repeatCycle?: FhirQuantity;
    /** Explicit finite number of whole-course repetitions; absent means unbounded. */
    repeatCount?: number;
  }
}

declare module '../hpsg/signature' {
  interface HpsgScheduleFeature {
    /** Typed whole-course interval for a recurring active/rest construction. */
    repeatCycle?: FhirQuantity;
    /** Explicit finite number of whole-course repetitions; absent means unbounded. */
    repeatCount?: number;
  }
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
}
const LIST = `${W.dayPart}(?:${W.listSeparator}${W.dayPart})*`;
const FRAME = `${W.dayLead}(${LIST})(?:\\s+${W.periodLead}(\\d{1,3})\\s*${W.periodUnit})?`;
const ON_OFF_DURATION = String.raw`(\d+(?:\.\d+)?)\s*(days?|d\b|weeks?|wks?\b|wk\b|months?|mos?\b|mo\b)`;
const ON_OFF_FRAME = String.raw`\bfor\s+${ON_OFF_DURATION}\s+then\s+(?:stop|off)(?:\s+for)?\s+${ON_OFF_DURATION}\s+(?:and\s+)?repeat\b(?:\s+(?:for\s+)?(\d{1,3})\s+cycles?\b)?`;

const UCUM_SYSTEM = 'http://unitsofmeasure.org';

function cycleUnit(surface: string): FhirPeriodUnit | undefined {
  if (/^(?:d|days?)$/iu.test(surface)) return FhirPeriodUnit.Day;
  if (/^(?:w|wk|wks|weeks?)$/iu.test(surface)) return FhirPeriodUnit.Week;
  if (/^(?:mo|mos|months?)$/iu.test(surface)) return FhirPeriodUnit.Month;
  return undefined;
}

function cycleQuantity(value: number, unit: FhirPeriodUnit): FhirQuantity {
  return { value, unit, system: UCUM_SYSTEM, code: unit };
}

function fixedCycleDays(value: number, unit: FhirPeriodUnit): number | undefined {
  if (unit === FhirPeriodUnit.Day) return value;
  if (unit === FhirPeriodUnit.Week) return value * 7;
  return undefined;
}

function combinedCycleQuantity(
  onValue: number,
  onUnit: FhirPeriodUnit,
  offValue: number,
  offUnit: FhirPeriodUnit
): FhirQuantity | undefined {
  if (onUnit === offUnit) return cycleQuantity(onValue + offValue, onUnit);
  const onDays = fixedCycleDays(onValue, onUnit);
  const offDays = fixedCycleDays(offValue, offUnit);
  return onDays !== undefined && offDays !== undefined
    ? cycleQuantity(onDays + offDays, FhirPeriodUnit.Day)
    : undefined;
}

/** A recurring treatment-relative on/off cycle is structurally complete
 * without a calendar date: treatment start is its native R6 course anchor. */
function recognizeOnOffCycles(input: string): CycleSchedule[] {
  if (!/\b(?:stop|off)\b[\s\S]{0,40}\brepeat\b/iu.test(input)) return [];
  const pattern = new RegExp(ON_OFF_FRAME, 'giu');
  const result: CycleSchedule[] = [];
  for (let match = pattern.exec(input); match; match = pattern.exec(input)) {
    const onValue = Number(match[1]);
    const onUnit = cycleUnit(match[2]);
    const offValue = Number(match[3]);
    const offUnit = cycleUnit(match[4]);
    const repeatCount = match[5] === undefined ? undefined : Number(match[5]);
    if (!onUnit || !offUnit || !Number.isFinite(onValue) || onValue <= 0 ||
        !Number.isFinite(offValue) || offValue <= 0) continue;
    const onDays = fixedCycleDays(onValue, onUnit);
    const offDays = fixedCycleDays(offValue, offUnit);
    const wholeOnDays = onDays !== undefined && Number.isInteger(onDays) && onDays <= 366
      ? onDays : undefined;
    const days = wholeOnDays === undefined
      ? [] : Array.from({ length: wholeOnDays }, (_, index) => index + 1);
    const repeatCycle = combinedCycleQuantity(onValue, onUnit, offValue, offUnit);
    const sourceText = match[0];
    result.push({
      kind: 'recurring-on-off',
      start: match.index,
      end: match.index + sourceText.length,
      sourceText,
      days,
      cycles: repeatCount ?? 1,
      periodDays: onDays !== undefined && offDays !== undefined ? onDays + offDays : undefined,
      events: [],
      onDuration: cycleQuantity(onValue, onUnit),
      offDuration: cycleQuantity(offValue, offUnit),
      repeatCycle,
      repeatCount,
      unbounded: repeatCount === undefined || undefined,
      error: repeatCount !== undefined && (repeatCount < 1 || repeatCount > 100)
        ? 'invalid-cycle-size' : undefined
    });
  }
  return result;
}

/** Recognize finite anchored cycle/day-offset expressions; never guess an absent anchor or cycle length. */
export function recognizeCycles(input: string, options?: ParseOptions): CycleSchedule[] {
  const result = recognizeOnOffCycles(input);
  if (!/(?:days?\b|\bD\d|วันที่ของรอบ)/iu.test(input)) return result;
  const pattern = new RegExp(FRAME, 'giu');
  for (let match = pattern.exec(input); match; match = pattern.exec(input)) {
    const [, list, periodValue] = match;
    let end = match.index + match[0].length;
    const lead = new RegExp(`^\\s+${W.startLead}\\s*`, 'iu').exec(input.slice(end));
    const anchorMatch = lead ? parseMedicationDateListAt(`on ${input.slice(end + lead[0].length)}`, 0,
      { ...options, locale: inferMedicationLocale(input, options?.locale ?? 'en') }) : undefined;
    if (lead) end += lead[0].length + (anchorMatch ? anchorMatch.end - 3 : 0);
    const countMatch = new RegExp(`^\\s+${W.repeatCount}`, 'iu').exec(input.slice(end));
    const count = countMatch?.[1];
    if (countMatch) end += countMatch[0].length;
    // Ordinary "on day 3" / "on days 1-5" is not an explicit cycle.
    // Require a cycle length, repeat count, or named start anchor before
    // grammar ownership may claim this text once the cycle is structurally recognized.
    if (!periodValue && !countMatch && !lead) continue;
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
      periodDays, anchor: anchor?.isoDate, events, error });
  }
  return result.sort((left, right) => left.start - right.start || right.end - left.end);
}
const BY_CONTEXT = new WeakMap<HpsgClauseContext, CycleSchedule[]>();
function contextCycles(context: HpsgClauseContext): CycleSchedule[] {
  let list = BY_CONTEXT.get(context);
  if (!list) { list = recognizeCycles(context.state.input, context.options); BY_CONTEXT.set(context, list); }
  return list;
}
/** Finite cycles emit exact events; recurring active/rest cycles emit their
 * typed active duration and whole-course repeat interval on the same sign. */
export function cycleScheduleRule() {
  return lexicalRule('hpsg.lex.schedule.finiteCycle', (context, start) => {
    const first = context.tokens[start];
    const cycle = contextCycles(context).find(c => c.start === first?.sourceStart);
    if (!cycle || cycle.error) return [];
    const tokens = context.tokens.slice(start).filter(t => t.sourceStart < cycle.end);
    if (!tokens.length || tokens[tokens.length - 1].sourceEnd > cycle.end) return [];
    const schedule = cycle.kind === 'recurring-on-off'
      ? cycle.onDuration?.value !== undefined && cycle.onDuration.code && cycle.repeatCycle
        ? {
          duration: cycle.onDuration.value,
          durationUnit: cycle.onDuration.code as FhirPeriodUnit,
          repeatCycle: { ...cycle.repeatCycle },
          repeatCount: cycle.repeatCount
        }
        : undefined
      : { calendarEvents: cycle.events };
    if (!schedule) return [];
    const scheduleFields: CanonicalScheduleSemanticField[] = cycle.kind === 'recurring-on-off'
      ? ['duration', 'durationUnit', 'repeatCycle']
      : ['calendarEvents'];
    if (cycle.kind === 'recurring-on-off' && cycle.repeatCount !== undefined) {
      scheduleFields.push('repeatCount');
    }
    return [lexicalSign({ type: 'schedule-sign', rule: 'hpsg.lex.schedule.finiteCycle', tokens,
      synsem: { head: { schedule }, valence: {}, cont: { clauseKind: 'administration' } },
      scheduleFields,
      score: 48 + tokens.length })];
  });
}
