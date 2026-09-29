import mdx from '@astrojs/mdx';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

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
      wrap: true,
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
