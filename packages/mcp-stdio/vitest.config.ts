import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    // The tests start a real daemon app (daemon/test/harness.ts), which imports core.
    alias: {
      '@brsorganizer/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'mcp-stdio',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
