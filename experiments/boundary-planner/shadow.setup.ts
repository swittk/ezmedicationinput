import { vi } from 'vitest';

// Test-only dependency substitution: production source and public exports remain untouched.
vi.mock('../../src/hpsg/segmenter', async () => {
  const planner = await import('./planner');
  return { parseSigSegments: planner.parseSigSegments };
});
