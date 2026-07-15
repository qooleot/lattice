import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/conform-capture.ts'],
    globalSetup: ['test/conform-global-setup.ts'],
  },
});
