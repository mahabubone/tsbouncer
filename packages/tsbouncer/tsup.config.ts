import { defineConfig } from 'tsup';

export default defineConfig({
  // One entry per import subpath, so an app that needs only the kernel never
  // loads the JSON store's `node:fs` — and one that needs only `memory` never
  // loads either. Each entry bundles what it reaches; shared code is not split
  // into chunks, so every subpath stays a single file.
  entry: {
    index: 'src/index.ts',
    memory: 'src/memory/index.ts',
    json: 'src/json/index.ts',
    defaults: 'src/defaults.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'neutral',
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  minify: false,
});
