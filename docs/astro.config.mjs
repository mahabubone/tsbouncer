import mdx from '@astrojs/mdx';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { absoluteLinks } from './src/plugins/absolute-links.mjs';
import { codeChrome } from './src/plugins/code-chrome.mjs';

const base = '/tsbouncer/';

// Static output on purpose: the whole site is markdown and a build step, so there
// is nothing to run and nothing to keep patched.
export default defineConfig({
  site: 'https://tsbouncer.dev',
  // Project-subpath hosting (GitHub Pages): the site is served from
  // /tsbouncer/, so every internal link must be relative or BASE_URL-aware —
  // Astro does not rewrite absolute `/…` links under `base`. Canonicals still
  // assume the custom domain; revisit them if Pages stays subpath-only.
  base,
  output: 'static',
  trailingSlash: 'never',
  // MDX rather than markdown alone, so a page can import a component — a callout
  // for a warning, a table for a reference.
  integrations: [mdx()],
  markdown: {
    // Relative content links are rewritten to absolute site paths so they
    // resolve identically with or without a trailing slash in the URL.
    remarkPlugins: [
      [
        absoluteLinks,
        {
          base,
          contentDir: new URL('./src/content/docs/', import.meta.url).pathname,
        },
      ],
    ],
    // Both themes are emitted as CSS variables and `.dark` picks between them, so
    // a code block is legible in either mode and there is no flash on toggle.
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
      // NOT `wrap: true`. Wrapping turns a long line into four short ones, which
      // makes a snippet both ugly and enormous — the block grows to six hundred
      // pixels for what is twenty lines of text. Long lines scroll horizontally,
      // which is what a code block is for.
      wrap: false,
    },
    // A language label and a copy button above every block. Written locally
    // rather than pulled in as a dependency, because the language is already in
    // the tree by the time the plugin sees it.
    rehypePlugins: [codeChrome],
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
