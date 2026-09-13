import { defineConfig } from 'vitest/config';

// base is relative so the built app works when served from a GitHub Pages
// project subpath (see ARCHITECTURE-SPINE AD-9).
export default defineConfig({
  base: './',
  test: {
    // Default DOM environment for UI tests (src/ui/**) so a new test file
    // doesn't need a per-file `// @vitest-environment` pragma to see `document`.
    environment: 'happy-dom',
  },
});
