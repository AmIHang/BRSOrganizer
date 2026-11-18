import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineProject } from 'vitest/config';

export default defineProject({
  // Compiles runes in *.svelte.ts modules.
  plugins: [svelte()],
  test: {
    name: 'app',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
