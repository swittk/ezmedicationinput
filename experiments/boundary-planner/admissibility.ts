import type { ParseResult } from '../../src/types';

/** Preserve the original instruction and dose, but do not execute a known-invalid schedule. */
export function quarantineSchedule(item: ParseResult, text: string, reason: string): void {
  const warning = `Unresolved schedule (${reason}): ${text}`;
  if (item.warnings.indexOf(warning) < 0) item.warnings.push(warning);
  for (const clause of item.meta.canonical.clauses) {
    clause.schedule = undefined;
    clause.warnings = [...(clause.warnings ?? []), warning];
  }
  delete item.fhir.timing;
  item.meta.leftoverText = text;
  item.fhir.text = text;
  item.longText = text;
  item.shortText = text;
}
