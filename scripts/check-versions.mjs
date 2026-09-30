#!/usr/bin/env node
/**
 * Every published package is one version, and it is the one in the root.
 *
 * Six packages drifting to five versions is how a consumer ends up with two
 * copies of the kernel and a type error that reads like a TypeScript bug. There is
 * no release tooling in this repo, so this is the guard: zero dependencies, and it
 * runs in the existing CI job rather than adding one.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Walk `packages/`, which is two levels deep: `tsbouncer`, `testkit`, and `stores/<name>`. */
function packageDirs() {
  const dirs = [];
  for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const direct = join(root, 'packages', entry.name);
    dirs.push(direct);
    for (const nested of readdirSync(direct, { withFileTypes: true })) {
      if (nested.isDirectory()) dirs.push(join(direct, nested.name));
    }
  }
  return dirs;
}

const rootPkg = read(join(root, 'package.json'));
const expected = rootPkg.version;
const problems = [];
const found = [];

for (const dir of packageDirs()) {
  let pkg;
  try {
    pkg = read(join(dir, 'package.json'));
  } catch {
    continue; // not a package
  }
  if (pkg.private === true) {
    problems.push(`${pkg.name} is private but lives in packages/ — move it out`);
    continue;
  }
  found.push(pkg.name);
  if (pkg.version !== expected) {
    problems.push(`${pkg.name} is ${pkg.version}, expected ${expected}`);
  }
}

if (found.length === 0) problems.push('no published packages found under packages/');

if (problems.length > 0) {
  console.error(`\nVersion check failed (root is ${expected}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`${found.length} packages at ${expected}: ${found.sort().join(', ')}`);
