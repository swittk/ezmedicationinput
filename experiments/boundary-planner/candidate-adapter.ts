import { planBoundaries } from './planner';
import { stats } from './stats';
import type { ParseOptions } from '../../src/types';
export function createBoundaryPlan(input: string, options?: ParseOptions) {
  const plan = planBoundaries(input, options);
  stats.speculativeProbes += plan.metrics.clauseProbes;
  stats.cacheHits += plan.metrics.probeCacheHits;
  return plan;
}
export function parseSigSegments(input: string, options?: ParseOptions) {
  return createBoundaryPlan(input, options).segments;
}
