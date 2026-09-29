import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Guides don't just compile — their assertion blocks execute.
 *
 * `snippets.test.ts` proves every TypeScript block type-checks, but a snippet
 * that type-checks and asserts the wrong thing is a guide teaching a lie with a
 * green build. So each guide page is rendered to a standalone script — its
 * `ts setup` plus every checked block, exactly as the checker concatenates
 * them — and run with `tsx` in an empty directory. A refused assertion throws,
 * the process exits non-zero, and the page fails here rather than in a reader's
 * terminal.
 *
 * The empty directory matters: the Hono guide boots a `jsonStore` against a
 * relative file, and running it inside the repo would leave an `authz.json`
 * behind (or worse, read one).
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const CONTENT = join(ROOT, 'src', 'content', 'docs');
const PAGES = ['guides/hono-rbac.mdx', 'guides/express-drizzle.mdx'];
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');

const work = mkdtempSync(join(ROOT, '.guide-exec-'));

afterAll(() => rmSync(work, { recursive: true, force: true }));

function checkedTs(source: string): string {
  const lines = source.split('\n');
  let open: { lang: string; meta: string; body: string[] } | undefined;
  const setups: string[] = [];
  const codes: string[] = [];
  for (const line of lines) {
    const fence = /^```(\w*)\s*(.*)$/.exec(line);
    if (open === undefined) {
      if (fence) open = { lang: fence[1] ?? '', meta: fence[2] ?? '', body: [] };
      continue;
    }
    if (/^```\s*$/.test(line)) {
      if (open.lang === 'ts' && !/\bts-skip\b/.test(open.meta)) {
        (/\bsetup\b/.test(open.meta) ? setups : codes).push(open.body.join('\n'));
      }
      open = undefined;
      continue;
    }
    open.body.push(line);
  }
  return [...setups, ...codes].join('\n\n');
}

describe('guide assertions execute', () => {
  for (const page of PAGES) {
    it(`${page} decisions hold`, () => {
      const source = readFileSync(join(CONTENT, page), 'utf8');
      const target = join(work, `${page.replace('/', '-')}.ts`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, checkedTs(source));
      // An empty cwd, so file-backed stores land in scratch, not in the repo.
      const dir = mkdtempSync(join(tmpdir(), 'tsbouncer-guide-'));
      try {
        execFileSync(TSX, [target], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
      } catch (error) {
        const err = error as { stdout?: unknown; stderr?: unknown; message?: string };
        const out = [err.stdout, err.stderr].filter(Boolean).join('\n');
        expect.unreachable(
          `${relative(CONTENT, join(CONTENT, page))} asserts failed:\n${String(
            out || err.message,
          )
            .split('\n')
            .filter((l) => l.includes('AssertionError') || l.includes('assert'))
            .join('\n')}`,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
