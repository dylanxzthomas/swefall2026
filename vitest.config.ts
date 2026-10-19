import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { maxWorkers: 4, environment: 'edge-runtime', include: ['convex/**/*.test.ts', 'shared/**/*.test.ts', 'web/src/daymark/**/*.test.tsx'], server: { deps: { inline: ['@convex-dev/workflow', '@convex-dev/workpool'] } } } })
