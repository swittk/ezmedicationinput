import { matchCalendarExclusion } from "../clinical-safety";
import { parseMedicationGuard } from "../medication-condition";
import { planBoundaries, takeBoundaryParsedState } from './planner';
import { stats } from './stats';
import type { ParseOptions } from '../types';
export function createBoundaryPlan(input: string, options?: ParseOptions) {
  const plan = planBoundaries(input, options);
  const exclusion = matchCalendarExclusion(input, options);
  // An exclusion list is one semantic unit even if it contains commas and
  // coordinators. Only merge a boundary actually inside that claimed range.
  if (exclusion && plan.segments.length > 1) {
    const oldToNew: number[] = [];
    const joined: typeof plan.segments = [];
    for (let index = 0; index < plan.segments.length; index++) {
      const segment = plan.segments[index];
      const previous = joined[joined.length - 1];
      if (previous && segment.start > exclusion.start && segment.start < exclusion.end) {
        previous.end = segment.end;
        previous.text = input.slice(previous.start, previous.end);
        oldToNew[index] = joined.length - 1;
      } else {
        oldToNew[index] = joined.length;
        joined.push({ ...segment });
      }
    }
    if (joined.length < plan.segments.length) {
      plan.segments = joined;
      plan.relations = plan.relations
        .filter(edge => oldToNew[edge.from] !== oldToNew[edge.to])
        .map(edge => ({
          ...edge, from: oldToNew[edge.from], to: oldToNew[edge.to]
        }));
    }
  }
  // A leading conditional and its comma-delimited administration form ONE
  // medication order, not two independent tracks. The boundary planner may
  // otherwise split "Only if SBP >100, take 2 tabs BID, otherwise hold",
  // leaving an unrelated guard-only row and an unguarded dose. Keep the
  // entire action with the guard so the clinical resolver can attach it.
  // The cheap prefix check avoids an extra grammar scan on routine SIGs.
  if (plan.segments.length > 1 &&
      /^(?:\s*only\s+if\b|\s*unless\b|\s*เฉพาะ(?:เมื่อ|หาก)|\s*เว้นแต่|\s*ยกเว้นกรณี)/iu.test(input)) {
    const guard = parseMedicationGuard(input);
    const first = plan.segments[0];
    const second = plan.segments[1];
    const firstContent = input.search(/\S/u);
    if (guard?.start === firstContent && guard.end <= first.end &&
        /^\s*,\s*$/u.test(input.slice(first.end, second.start))) {
      let last = 1;
      // The optional trailing hold may have been segmented separately.
      // Consume only comma-separated pieces that belong to that same
      // no-dose alternative; never swallow a subsequent ';' prescription.
      while (guard.otherwise && last + 1 < plan.segments.length &&
             plan.segments[last + 1].start < guard.otherwise.end &&
             /^\s*,\s*$/u.test(input.slice(
               plan.segments[last].end, plan.segments[last + 1].start))) {
        last++;
      }
      const joined = {
        ...first,
        end: plan.segments[last].end,
        text: input.slice(first.start, plan.segments[last].end),
      };
      plan.segments = [joined, ...plan.segments.slice(last + 1)];
      plan.relations = plan.relations
        .map(edge => ({
          ...edge,
          from: edge.from <= last ? 0 : edge.from - last,
          to: edge.to <= last ? 0 : edge.to - last,
        }))
        .filter(edge => edge.from !== edge.to);
    }
  }
  stats.speculativeProbes += plan.metrics.clauseProbes;
  stats.cacheHits += plan.metrics.probeCacheHits;
  return plan;
}
export function parseSigSegments(input: string, options?: ParseOptions) {
  return createBoundaryPlan(input, options).segments;
}

export { takeBoundaryParsedState };
