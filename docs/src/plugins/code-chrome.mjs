/**
 * Wrap every code block in a figure with a header bar.
 *
 * Standard docs sites put two things above a snippet: what language it is, and a
 * copy button. Neither is worth a plugin dependency, and the language is already
 * in the tree — Shiki puts `language-ts` on the inner `<code>` — so this reads it
 * from there rather than re-parsing the markdown.
 *
 * The `<pre>` element itself is preserved untouched. Shiki's inline custom
 * properties drive the light/dark swap, so a wrapper that rebuilt the element
 * would be a wrapper that eventually breaks the highlighting.
 *
 * No `unist-util-visit`: the tree is a few hundred nodes, and a dependency to
 * walk it is not one worth taking in a site that has none.
 */

const LABELS = {
  ts: 'TypeScript',
  typescript: 'TypeScript',
  js: 'JavaScript',
  javascript: 'JavaScript',
  jsx: 'JSX',
  tsx: 'TSX',
  bash: 'Shell',
  sh: 'Shell',
  shell: 'Shell',
  json: 'JSON',
  css: 'CSS',
  html: 'HTML',
  astro: 'Astro',
  mdx: 'MDX',
  yaml: 'YAML',
  yml: 'YAML',
  plaintext: 'Text',
  text: 'Text',
  txt: 'Text',
  console: 'Shell',
};

const el = (tagName, properties, children) => ({
  type: 'element',
  tagName,
  properties,
  children,
});
const text = (value) => ({ type: 'text', value });

function classList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(' ').filter(Boolean);
  return [];
}

function languageOf(pre) {
  // Astro's Shiki pass puts the language on the `<pre>` as `data-language`, and
  // leaves the inner `<code>` with no class at all. Older pipelines put
  // `language-*` on the `<code>`, so both are read.
  const fromPre = pre.properties?.dataLanguage ?? pre.properties?.['data-language'];
  if (typeof fromPre === 'string' && fromPre !== '') return fromPre.trim().toLowerCase();

  const code = (pre.children ?? []).find(
    (child) => child.type === 'element' && child.tagName === 'code',
  );
  const found = classList(code?.properties?.className).find((c) =>
    c.startsWith('language-'),
  );
  return found ? found.slice('language-'.length).trim().toLowerCase() : '';
}

/** Collect the `<pre>` elements, then replace them. Mutating during a walk loses nodes. */
function collectPres(node, found) {
  if (node.type === 'element' && node.tagName === 'pre') found.push(node);
  for (const child of node.children ?? []) collectPres(child, found);
  return found;
}

function replacePres(node, target, replacement) {
  if (!node.children) return;
  const at = node.children.indexOf(target);
  if (at !== -1) {
    node.children[at] = replacement;
    return;
  }
  for (const child of node.children) replacePres(child, target, replacement);
}

export function codeChrome() {
  return (tree) => {
    for (const pre of collectPres(tree, [])) {
      const language = languageOf(pre);
      const label = LABELS[language] ?? (language || '');

      // Progressive enhancement: without JavaScript the button would do nothing,
      // so the layout script reveals it only once it has attached a handler.
      const bar = el('figcaption', { className: ['code-block__bar'] }, [
        el('span', { className: ['code-block__lang'] }, [text(label)]),
        el(
          'button',
          {
            type: 'button',
            className: ['code-block__copy'],
            'data-copy': '',
            hidden: true,
            'aria-label': 'Copy this code to the clipboard',
          },
          [text('Copy')],
        ),
      ]);

      const figure = el('figure', { className: ['code-block'] }, [bar, pre]);
      replacePres(tree, pre, figure);
    }
  };
}
