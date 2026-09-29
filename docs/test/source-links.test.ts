import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The guides claim their examples are the source of truth. This is what makes that
 * a checked claim rather than a slogan.
 *
 * The catalog in `guides/` links to individual files in `examples/`, and this test
 * resolves every one of those links against the working tree. A file that is renamed,
 * moved or deleted fails here — at the same commit that broke the link — instead of
 * quietly leaving the documentation pointing at nothing.
 *
 * Nothing else in this site would notice. A snippet that no longer matches the
 * application it describes still compiles perfectly well on its own, which is the
 * whole reason this test exists rather than more snippets.
 *
 * Links are matched by pattern, not by a list, so a new source link is checked the
 * moment somebody writes it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CONTENT = join(here, '..', 'src', 'content', 'docs');
const ROOT = join(here, '..', '..');
const EXAMPLES = join(ROOT, 'examples');

/** The repository these links point into, as a prefix that is stripped to a path. */
const REPO = 'https://github.com/tsbouncer/tsbouncer/blob/main/';

function mdxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return mdxFiles(full);
    return name.endsWith('.mdx') ? [full] : [];
  });
}

interface SourceLink {
  readonly file: string;
  readonly line: number;
  readonly target: string;
}

function sourceLinks(file: string): SourceLink[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, index) => {
      const found = [
        ...line.matchAll(
          new RegExp(
            `${REPO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(examples/[^)\\s]+)`,
            'g',
          ),
        ),
      ];
      return found.map((match) => ({
        file,
        line: index + 1,
        target: match[1] as string,
      }));
    });
}

describe('guides point at example files that exist', () => {
  const guides = mdxFiles(CONTENT).filter((file) => file.includes(`${'guides'}`));
  const links = guides.flatMap(sourceLinks);

  it('the guides actually link to example source', () => {
    // A regex that quietly stops matching is a suite that passes forever.
    expect(guides.length).toBeGreaterThanOrEqual(3);
    expect(links.length).toBeGreaterThanOrEqual(10);
  });

  it('every source link resolves to a file on disk', () => {
    const missing: string[] = [];
    for (const link of links) {
      const path = join(ROOT, link.target);
      let exists = false;
      try {
        exists = statSync(path).isFile();
      } catch {
        exists = false;
      }
      if (!exists) {
        missing.push(`${relative(CONTENT, link.file)}:${link.line} → ${link.target}`);
      }
    }
    expect(missing, `dead source link(s):\n\n${missing.join('\n')}`).toEqual([]);
  });

  it('every source link points inside examples/', () => {
    // A link to a package source is a different kind of claim, and this suite is
    // only evidence for the examples.
    for (const link of links) {
      expect(link.target.startsWith('examples/')).toBe(true);
    }
  });

  it('the examples the guides name are the examples the repository has', () => {
    const named = new Set(links.map((l) => l.target.split('/')[1] as string));
    const present = readdirSync(EXAMPLES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    // Every example package is documented, so a third example cannot be added
    // without either a guide for it or a deliberate edit here.
    expect([...present].sort()).toEqual([...named].sort());
  });
});
