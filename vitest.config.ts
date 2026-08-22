import { defineConfig } from 'vitest/config';

// Without an explicit root/include, vitest's default glob picks up test
// files anywhere under cwd — including the vendored repos cloned into
// research/vendor/ for RESEARCH.md (gitignored, not ours, but still on
// disk). Scope discovery to this project's own tests.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'research'],
  },
});
