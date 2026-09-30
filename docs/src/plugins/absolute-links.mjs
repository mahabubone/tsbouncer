import path from 'node:path';

/**
 * Rewrite relative Markdown links to absolute site paths at build time.
 *
 * Relative links (`./model`, `../api/client`) resolve against the *browser
 * URL*, not the file tree — so a page served with a trailing slash
 * (`/docs/getting-started/`) sends `./concepts/model` to
 * `/docs/getting-started/concepts/model`, a 404. Absolute links have no such
 * ambiguity: they resolve identically with or without the slash.
 *
 * Source stays portable (relative), output is robust (absolute, base-aware).
 * Same-page anchors (`#section`), protocol URLs, and `mailto:` pass through.
 *
 * `contentDir` is the content collection root; `base` is the Astro base, used
 * verbatim as the URL prefix.
 */
export function absoluteLinks({ base = '/', contentDir = '' } = {}) {
  const prefix = `/${String(base).replace(/^\/|\/$/g, '')}`;
  const root = prefix === '/' ? '' : prefix;

  const absolutize = (url, routeDir) => {
    if (url === undefined || url === '') return url;
    if (
      url.startsWith('#') ||
      url.startsWith('/') ||
      /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) ||
      url.startsWith('//')
    ) {
      return url;
    }
    const [pathPart, hash] = url.split('#');
    const resolved = path.posix.normalize(path.posix.join(routeDir, pathPart || '.'));
    return `${root}${resolved === '/' ? '' : resolved}${hash === undefined ? '' : `#${hash}`}`;
  };

  // Route for a content file: `index.mdx` is the docs home at `/docs`,
  // everything else is `/docs/<id>`.
  const routeOf = (filePath) => {
    const rel = path.relative(contentDir, filePath).replace(/\\/g, '/');
    const id = rel.replace(/\.mdx?$/, '');
    return id === 'index' ? '/docs' : `/docs/${id}`;
  };

  const visit = (node, routeDir) => {
    if (node === null || typeof node !== 'object') return;
    if (
      (node.type === 'link' || node.type === 'image' || node.type === 'definition') &&
      typeof node.url === 'string'
    ) {
      node.url = absolutize(node.url, routeDir);
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child, routeDir);
    }
  };

  return (tree, file) => {
    const filePath = file?.path ?? file?.history?.[0] ?? '';
    const routeDir = path.posix.dirname(routeOf(String(filePath)));
    visit(tree, routeDir);
  };
}
