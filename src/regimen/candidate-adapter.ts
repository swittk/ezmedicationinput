import { planBoundaries, takeBoundaryParsedState } from './planner';
import { stats } from './stats';
import type { ParseOptions } from '../types';
export function createBoundaryPlan(input: string, options?: ParseOptions) {
  const plan = planBoundaries(input, options);
  // Semantic ownership and boundary decisions now both occur inside the
  // typed HPSG boundary planner. Do not stitch decided segments together
  // afterward: doing so loses relation provenance and may invalidate caches.
  stats.speculativeProbes += plan.metrics.clauseProbes;
  stats.cacheHits += plan.metrics.probeCacheHits;
  return plan;
}
export function parseSigSegments(input: string, options?: ParseOptions) {
  return createBoundaryPlan(input, options).segments;
}

export { takeBoundaryParsedState };
