import { setUnresolvedDosage } from "../dosage-course";
import type { ParseResult } from '../types';

/** Preserve the original instruction and dose, but do not execute a known-invalid schedule. */
export function quarantineSchedule(item: ParseResult, text: string, reason: string): void {
  const warning = `Unresolved schedule (${reason}): ${text}`;
  if (item.warnings.indexOf(warning) < 0) item.warnings.push(warning);
  for (const clause of item.meta.canonical.clauses) {
    // Retain known parsed schedule facts separately from executable timing.
    // An unrecognized restriction must not erase what the grammar understood,
    // but this candidate must never be lowered as an executable FHIR Timing.
    if (clause.schedule) clause.provisionalSchedule = clause.provisionalSchedule ?? clause.schedule;
    clause.schedule = undefined;
    if (!clause.warnings?.some(value => value === warning)) {
      clause.warnings = [...(clause.warnings ?? []), warning];
    }
  }
  delete item.fhir.timing;
  setUnresolvedDosage(item.fhir, reason);
  item.meta.leftoverText = text;
  item.fhir.text = text;
  item.longText = text;
  item.shortText = text;
}
