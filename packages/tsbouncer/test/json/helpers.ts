import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonStore } from '../../src/json/index.js';
import { jsonStore } from '../../src/json/index.js';

const dirs: string[] = [];

export function tempFile(name = 'tsbouncer.json'): string {
  const dir = mkdtempSync(join(tmpdir(), 'tsbouncer-json-'));
  dirs.push(dir);
  return join(dir, name);
}

export function cleanup(): void {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
}

export function freshStore(name?: string): JsonStore {
  return jsonStore({ file: tempFile(name) });
}
