import { defineConfig } from 'vitest/config';
import { candidatePlugin } from './integration.mjs';
export default defineConfig({ plugins: [candidatePlugin()], test: {
  include: ['test/**/*.spec.ts'],
  setupFiles: ['experiments/boundary-planner/shadow.setup.ts'],
  testTimeout: 20000
} });
