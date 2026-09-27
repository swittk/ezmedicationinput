import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['experiments/boundary-planner/*.spec.ts'], testTimeout: 20000 } });
