import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['test/**/*.spec.ts'],
  setupFiles: ['experiments/boundary-planner/shadow.setup.ts'],
  testTimeout: 20000
} });
