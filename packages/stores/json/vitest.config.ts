import { defineConfig } from 'vitest/config';
import { sharedCoverage } from '../../../vitest.shared.js';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: sharedCoverage(),
  },
});
