import { inferMedicationLocale } from '../../src/locale-detection';
import { parseMedicationDateListAt } from '../../src/date-interpretation';
import { lexicalRule } from '../../src/hpsg/rule-context';
import type { HpsgClauseContext } from '../../src/hpsg/rule-context';
import { lexicalSign } from '../../src/hpsg/signature';
import type { CanonicalCalendarEventExpr, ParseOptions } from '../../src/types';
import { CYCLE_WORDS as W } from './cycle-lexicon';

export interface CycleSchedule {
  start: number; end: number; sourceText: string; days: number[]; cycles: number; periodDays?: number;
  anchor?: string; events: CanonicalCalendarEventExpr[]; error?: string;
}
const LIST = `${W.dayPart}(?:${W.listSeparator}${W.dayPart})*`;
const FRAME = `${W.dayLead}(${LIST})(?:\\s+${W.periodLead}(\\d{1,3})\\s*${W.periodUnit})?`;

/** Recognize finite anchored cycle/day-offset expressions; never guess an absent anchor or cycle length. */
export function recognizeCycles(input: string, options?: ParseOptions): CycleSchedule[] {
  if (!/(?:days?\b|\bD\d|วันที่ของรอบ)/iu.test(input)) return [];
  const pattern = new RegExp(FRAME, 'giu'), result: CycleSchedule[] = [];
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
    result.push({ start: match.index, end, sourceText, days, cycles,
      periodDays, anchor: anchor?.isoDate, events, error });
  }
  return result;
}
const BY_CONTEXT = new WeakMap<HpsgClauseContext, CycleSchedule[]>();
function contextCycles(context: HpsgClauseContext): CycleSchedule[] {
  let list = BY_CONTEXT.get(context);
  if (!list) { list = recognizeCycles(context.state.input, context.options); BY_CONTEXT.set(context, list); }
  return list;
}
export function insideCycle(context: HpsgClauseContext, tokenIndex: number): boolean {
  const token = context.tokens[tokenIndex];
  return !!token && contextCycles(context).some(c => c.start <= token.sourceStart && token.sourceStart < c.end);
}
/** A bounded cycle is lowered to native exact FHIR events; no executable cycle rule is hidden in free text. */
export function cycleScheduleRule() {
  return lexicalRule('hpsg.lex.schedule.finiteCycle', (context, start) => {
    const first = context.tokens[start];
    const cycle = contextCycles(context).find(c => c.start === first?.sourceStart);
    if (!cycle || cycle.error) return [];
    const tokens = context.tokens.slice(start).filter(t => t.sourceStart < cycle.end);
    if (!tokens.length || tokens[tokens.length - 1].sourceEnd > cycle.end) return [];
    return [lexicalSign({ type: 'schedule-sign', rule: 'hpsg.lex.schedule.finiteCycle', tokens,
      synsem: { head: { schedule: { calendarEvents: cycle.events } }, valence: {}, cont: { clauseKind: 'administration' } },
      score: 40 + tokens.length })];
  });
}
