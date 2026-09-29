import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Every TypeScript block in these docs is type-checked.
 *
 * A snippet that does not compile is a snippet that misleads: the reader copies
 * it, it does not work, and the docs are worse than no docs. This repo's READMEs
 * carried unverified snippets for months, which is the failure this exists to
 * stop.
 *
 * Blocks come in four shapes, and the checker *classifies* them rather than
 * trusting a tag, because a mis-tagged snippet that silently stops being checked
 * is worse than no checker at all:
 *
 *   statement  `await authz.write([...])`               — emitted as-is
 *   fragment   `permissions: { read: ... }`             — wrapped as an object
 *              property, so the expression is still checked
 *   declaration  `interface Decision { ... }`          — emitted as-is
 *   signature  `defineModel(...): Model`                — a documentation
 *              signature, not code. Not checked, and must say so with `ts-skip`
 *
 * A block that fits none of them is a **failure**, not a skip. Silently ignoring
 * it is how a checker starts lying.
 *
 * A page may declare one ```` ```ts setup ```` block, prepended to every other
 * block on that page, so `authz` and `model` exist without each snippet
 * re-declaring them.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CONTENT = join(here, '..', 'src', 'content', 'docs');
const TSC = join(here, '..', 'node_modules', 'typescript', 'bin', 'tsc');
const DIST = join(here, '..', '..', 'packages', 'tsbouncer', 'dist');
const TSBOUNCER = join(DIST, 'index.d.ts');
// Every published subpath ships its own declarations. Snippets import
// `tsbouncer/memory` and friends, so a dist with only the root entry would
// compile the wrong thing — or nothing — while this assertion stayed green.
const SUBPATHS = ['memory.d.ts', 'json.d.ts', 'defaults.d.ts'].map((f) => join(DIST, f));

type Shape = 'statement' | 'fragment' | 'declaration' | 'signature';

interface Block {
  readonly lang: string;
  readonly meta: string;
  readonly code: string;
  readonly line: number;
}

interface Snippet {
  readonly file: string;
  readonly line: number;
  readonly code: string;
  readonly shape: Exclude<Shape, 'signature'>;
}

function mdxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return mdxFiles(full);
    return /\.mdx?$/.test(name) ? [full] : [];
  });
}

function fenced(source: string): Block[] {
  const lines = source.split('\n');
  const blocks: Block[] = [];
  let open: { lang: string; meta: string; start: number; body: string[] } | undefined;

  for (const [index, line] of lines.entries()) {
    const fence = /^```(\w*)\s*(.*)$/.exec(line);
    if (open === undefined) {
      if (fence) {
        open = { lang: fence[1] ?? '', meta: fence[2] ?? '', start: index + 1, body: [] };
      }
      continue;
    }
    if (/^```\s*$/.test(line)) {
      blocks.push({
        lang: open.lang,
        meta: open.meta,
        code: open.body.join('\n'),
        line: open.start,
      });
      open = undefined;
      continue;
    }
    open.body.push(line);
  }
  return blocks;
}

/** Does this parse as a sequence of TypeScript statements? */
function parses(code: string): boolean {
  const file = ts.createSourceFile('snippet.ts', code, ts.ScriptTarget.ES2023, true);
  // `parseDiagnostics` is internal but is the only way to ask without a Program.
  const diagnostics = (file as unknown as { parseDiagnostics?: ts.Diagnostic[] })
    .parseDiagnostics;
  return (diagnostics ?? []).length === 0;
}

function classify(block: Block): Shape {
  // An explicit tag always wins, so an author can force a reading.
  if (/\bts-skip\b/.test(block.meta)) return 'signature';
  if (/\bts-fragment\b/.test(block.meta)) return 'fragment';
  if (/\bts-decl\b/.test(block.meta)) return 'declaration';

  const body = block.code.replace(/;\s*$/, '');

  if (parses(block.code)) return 'statement';
  if (parses(`const __fragment = {\n${body}\n};`)) return 'fragment';
  if (parses(block.code) || parses(`type __x = ${body}`)) return 'declaration';
  return 'signature';
}

function snippetsIn(file: string): {
  checked: Snippet[];
  skipped: number;
  setup: string;
  unclassified: string[];
} {
  const blocks = fenced(readFileSync(file, 'utf8')).filter(
    (b) => b.lang === 'ts' || b.lang === 'typescript',
  );
  const setup = blocks.find((b) => /\bsetup\b/.test(b.meta))?.code ?? '';
  const checked: Snippet[] = [];
  const unclassified: string[] = [];
  let skipped = 0;

  for (const block of blocks) {
    if (/\bsetup\b/.test(block.meta)) continue;
    if (block.code.trim() === '') continue;

    const shape = classify(block);
    // A block that is neither code nor a documentation signature. It is almost
    // always a fragment in the wrong shape, and skipping it quietly is how the
    // coverage number becomes fiction.
    // A documentation signature is the one thing not checked, so it must be
    // marked. Anything the classifier cannot place is a failure rather than a
    // skip — otherwise the checked count becomes fiction over time.
    if (shape === 'signature') {
      if (!/\bts-skip\b/.test(block.meta)) {
        const first = block.code.split('\n')[0]?.slice(0, 60) ?? '';
        unclassified.push(`line ${block.line}: ${first}`);
      }
      skipped += 1;
      continue;
    }

    checked.push({ file, line: block.line, code: block.code, shape });
  }

  return { checked, skipped, setup, unclassified };
}

function render(snippets: readonly Snippet[]): string {
  return snippets
    .map((s, at) => {
      if (s.shape === 'fragment') {
        return `const __fragment_${at} = {\n${s.code.replace(/;\s*$/, '')}\n};`;
      }
      return s.code;
    })
    .join('\n\n');
}

describe('documentation snippets', () => {
  const files = mdxFiles(CONTENT);
  const work = mkdtempSync(join(here, '..', '.snippet-check-'));

  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it('has documentation to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('classifies every snippet, so nothing is silently ignored', () => {
    const problems: string[] = [];
    for (const file of files) {
      for (const item of snippetsIn(file).unclassified) {
        problems.push(`${relative(CONTENT, file)} ${item}`);
      }
    }
    expect(
      problems,
      `unclassifiable snippet(s). Either make it valid TypeScript, mark it \`ts-fragment\`, or — if it is a documentation signature — mark it \`ts-skip\`:\n\n${problems.join('\n')}`,
    ).toEqual([]);
  });

  it('every TypeScript snippet compiles against the real package', () => {
    expect(exists(TSBOUNCER), `${TSBOUNCER} is missing — build the workspace first`).toBe(
      true,
    );
    for (const entry of SUBPATHS) {
      expect(exists(entry), `${entry} is missing — build the workspace first`).toBe(true);
    }

    const failures: string[] = [];
    let checked = 0;
    let skipped = 0;

    files.forEach((file, index) => {
      const { checked: snippets, skipped: skipCount, setup } = snippetsIn(file);
      skipped += skipCount;
      if (snippets.length === 0) return;

      const target = join(work, `snippet-${index}.ts`);
      writeFileSync(target, `${setup}\n\n${render(snippets)}\n`, 'utf8');
      checked += snippets.length;

      try {
        execFileSync(
          process.execPath,
          [
            TSC,
            '--noEmit',
            '--strict',
            '--target',
            'ES2023',
            '--module',
            'esnext',
            '--moduleResolution',
            'bundler',
            '--skipLibCheck',
            target,
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
      } catch (error) {
        const out = String(
          (error as { stdout?: unknown }).stdout ?? (error as Error).message,
        );
        failures.push(
          `${relative(CONTENT, file)}\n${out
            .split('\n')
            .filter((l) => l.includes('error TS'))
            .join('\n')}`,
        );
      }
    });

    expect(
      failures,
      `${failures.length} page(s) had snippets that do not compile:\n\n${failures.join('\n\n')}`,
    ).toEqual([]);
    // A checker that quietly stopped finding snippets would report success.
    expect(checked).toBeGreaterThan(20);
    process.stdout.write(
      `  checked ${checked} snippet(s) across ${files.length} page(s), skipped ${skipped}\n`,
    );
  }, 120_000);
});

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
