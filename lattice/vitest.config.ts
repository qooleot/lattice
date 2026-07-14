import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
    globalSetup: './test/global-setup.ts', include: ['test/**/*.test.ts', 'golden/**/*.test.ts', 'src/**/*.test.ts'], testTimeout: 120_000, fileParallelism: false } });
