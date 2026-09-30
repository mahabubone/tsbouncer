import { defineConfig } from 'tsup';

export default defineConfig({
  // One entry: the kernel and the ports. Backends live in adapter packages, so
  // importing the root never loads storage, `node:fs`, or anything an app did
  // not ask for.
  entry: {
    index: 'src/index.ts',
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
