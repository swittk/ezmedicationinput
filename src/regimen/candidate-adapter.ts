import { matchCalendarExclusion } from "../clinical-safety";
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
  stats.speculativeProbes += plan.metrics.clauseProbes;
  stats.cacheHits += plan.metrics.probeCacheHits;
  return plan;
}
export function parseSigSegments(input: string, options?: ParseOptions) {
  return createBoundaryPlan(input, options).segments;
}

export { takeBoundaryParsedState };
