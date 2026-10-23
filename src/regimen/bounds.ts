import type { CanonicalSigClause, FhirTimingRepeat } from '../types';

/** One FHIR bounds[x] choice: an anchored exact day/week duration becomes concrete inclusive dates. */
export function normalizeAnchoredBounds(repeat: FhirTimingRepeat, schedule?: CanonicalSigClause['schedule']): void {
  const start = repeat.boundsPeriod?.start;
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !schedule || schedule.duration === undefined) return;
  if (schedule.durationMax !== undefined && schedule.durationMax !== schedule.duration) return;
  const factor = schedule.durationUnit === 'd' ? 1 : schedule.durationUnit === 'wk' ? 7 : undefined;
  if (factor === undefined || !Number.isInteger(schedule.duration * factor) || schedule.duration <= 0) return;
  const date = new Date(`${start}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return;
  date.setUTCDate(date.getUTCDate() + schedule.duration * factor - 1);
  const durationEnd = date.toISOString().slice(0, 10);
  const explicitEnd = repeat.boundsPeriod?.end;
  repeat.boundsPeriod = { start, end: explicitEnd && explicitEnd < durationEnd ? explicitEnd : durationEnd };
  delete repeat.boundsDuration;
  delete repeat.boundsRange;
}

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
