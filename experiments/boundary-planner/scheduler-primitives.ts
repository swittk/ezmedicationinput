import type { FhirTimingRepeat, NextDueDoseConfig } from '../../src/types';
interface ClockEntry { time: string; dayShift: number }
export interface TimingPrimitives {
  expandWhenCodes(codes: string[], config: NextDueDoseConfig, repeat: FhirTimingRepeat): ClockEntry[];
  normalizeClock(clock: string): string;
  inferWhenFallbackEntries(codes: string[], repeat: FhirTimingRepeat): ClockEntry[];
  getLocalDayNumber(date: Date, timeZone: string): number;
  getLocalMonthIndex(date: Date, timeZone: string): number;
  getTimeParts(date: Date, timeZone: string): { day: number };
  addCalendarMonths(date: Date, months: number, timeZone: string): Date;
  isDateAlignedToPeriodCycle(day: Date, anchor: Date, repeat: FhirTimingRepeat, timeZone: string): boolean;
}

/** Shared scheduling semantics built from the existing timezone/calendar primitives. */
export function createTimingPrimitives(p: TimingPrimitives) {
  /** Occurrence enumeration, historical caps and totals use exactly the same clock defaults. */
  function resolveExplicitClockEntries(repeat: FhirTimingRepeat, config: NextDueDoseConfig, dayFiltered: boolean): ClockEntry[] {
    const when = repeat.when ?? [], clocks = repeat.timeOfDay ?? [];
    const entries = p.expandWhenCodes(when, config, repeat);
    for (const clock of clocks) entries.push({ time: p.normalizeClock(clock), dayShift: 0 });
    if (clocks.length) entries.sort((a,b)=>a.dayShift-b.dayShift || a.time.localeCompare(b.time));
    if (!entries.length && !clocks.length && (dayFiltered || !repeat.frequency || !repeat.period || !repeat.periodUnit))
      entries.push(...p.inferWhenFallbackEntries(when, repeat));
    return entries;
  }
  /** Clock anchors restrict time within an eligible period; they do not erase its cadence. */
  function clockCadenceEligible(day: Date, anchor: Date, repeat: FhirTimingRepeat, timeZone: string, dayFiltered: boolean): boolean {
    if (!repeat.period || !repeat.periodUnit || repeat.periodUnit === 'd' && repeat.period <= 1) return true;
    if (repeat.periodUnit === 'wk' && !dayFiltered) {
      const delta = p.getLocalDayNumber(day,timeZone)-p.getLocalDayNumber(anchor,timeZone);
      return delta >= 0 && delta % (7*repeat.period) === 0;
    }
    if ((repeat.periodUnit === 'mo' || repeat.periodUnit === 'a') && !dayFiltered) {
      const months=p.getLocalMonthIndex(day,timeZone)-p.getLocalMonthIndex(anchor,timeZone);
      const period=repeat.period*(repeat.periodUnit === 'a' ? 12 : 1);
      if (months<0 || months%period !== 0) return false;
      return p.getTimeParts(day,timeZone).day === p.getTimeParts(p.addCalendarMonths(anchor,months,timeZone),timeZone).day;
    }
    return p.isDateAlignedToPeriodCycle(day,anchor,repeat,timeZone);
  }
  return {resolveExplicitClockEntries,clockCadenceEligible};
}
