/** Only instrumented experiment bundles update these counters. No production dependency. */
export const stats = { clauseCalls: 0, speculativeProbes: 0, lexicalCalls: 0, chartCalls: 0, chartTruncations: 0,
  chartSigns: 0, agendaItems: 0, combinationAttempts: 0, cacheHits: 0 };
export function resetStats(): void { for (const key of Object.keys(stats) as (keyof typeof stats)[]) stats[key] = 0; }
export function getStats(): typeof stats { return { ...stats }; }
