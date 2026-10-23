import type { ParseResult } from '../types';

/**
 * Preserve a best-effort suggestion while surfacing unresolved interpretation.
 * The parser is clinician-reviewed: uncertainty must not erase dose/timing/site.
 */
export function preserveSuggestionWarning(item: ParseResult, text: string, reason: string): void {
  const warning = `Unresolved interpretation (${reason}): ${text}`;
  if (item.warnings.indexOf(warning) < 0) item.warnings.push(warning);
  for (const clause of item.meta.canonical.clauses) {
    if (clause.schedule) clause.provisionalSchedule = clause.provisionalSchedule ?? clause.schedule;
    if (!clause.warnings?.some(value => value === warning)) {
      clause.warnings = [...(clause.warnings ?? []), warning];
    }
  }
  item.meta.leftoverText = text;
  item.fhir.text = text;
  item.longText = text;
  item.shortText = text;
}
