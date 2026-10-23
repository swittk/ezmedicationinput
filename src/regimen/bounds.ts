import type { FhirTimingRepeat } from '../types';

/** Make an implicit multi-clock cadence explicit without overriding a stated frequency. */
export function normalizeClockFrequency(repeat: FhirTimingRepeat): void {
  if (repeat.frequency !== undefined || !repeat.period || !repeat.periodUnit || (repeat.timeOfDay?.length ?? 0) < 2) return;
  const clocks = new Set(repeat.timeOfDay).size;
  if (repeat.periodUnit === 'd') {
    repeat.frequency = clocks;
    return;
  }
  const weekdays = new Set(repeat.dayOfWeek ?? []).size;
  if (repeat.periodUnit === 'wk' && repeat.period === 1 && weekdays > 0) {
    repeat.frequency = clocks * weekdays;
  }
}
