import mdx from '@astrojs/mdx';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { codeChrome } from './src/plugins/code-chrome.mjs';

// Static output on purpose: the whole site is markdown and a build step, so there
// is nothing to run and nothing to keep patched.
export default defineConfig({
  site: 'https://tsbouncer.dev',
  output: 'static',
  trailingSlash: 'never',
  // MDX rather than markdown alone, so a page can import a component — a callout
  // for a warning, a table for a reference.
  integrations: [mdx()],
  markdown: {
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
