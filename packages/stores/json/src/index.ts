import { existsSync, readFileSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  DeleteInput,
  KeymanStore,
  KeymanStoreCapabilities,
  Page,
  ReadTupleQuery,
  Tuple,
  WriteInput,
} from '@tsbouncer/core';
import { matchesQuery, StoreError, tupleKey } from '@tsbouncer/core';

export type { Document } from './format.js';
export { FORMAT_VERSION } from './format.js';

export interface JsonStore extends KeymanStore {
  /** The resolved file this store persists to. */
  readonly file: string;
  /** Every tuple currently held, in insertion order. */
  snapshot(): readonly Tuple[];
  /** Re-read the file, discarding in-memory state. */
  reload(): Promise<void>;
}

const CAPABILITIES: KeymanStoreCapabilities = Object.freeze({
  atomicWrite: true,
  persistent: true,
  atomicReplace: true,
  pagination: false,
  transaction: false,
  watch: false,
});

export interface JsonStoreOptions {
  /** Defaults to `./tsbouncer.json`. */
  readonly file?: string;
  /**
   * Treat a missing file as an empty store. Default true, because it is what
   * makes `jsonStore` usable for a first run and for a checked-in fixture.
   */
  readonly createIfMissing?: boolean;
  /** Newline at the end of the file. Default true, so it is git-friendly. */
  readonly trailingNewline?: boolean;
  /** Indent for the serialized file. Default 2. */
  readonly indent?: number;
}

let tempCounter = 0;

/**
 * A `KeymanStore` over a single JSON file.
 *
 * The whole state is held in memory and the file is rewritten on every mutation,
 * which is the point: the file stays a human-readable, git-diffable, portable
 * representation of the authorization state rather than a build artifact.
 *
 * Two things make that safe. Every write goes to a temporary file in the *same
 * directory* and is then renamed over the target, so a reader never observes a
 * half-written file and a crash mid-write leaves the previous state intact. And
 * mutations are serialized through a promise chain, so two overlapping
 * read-modify-write cycles cannot interleave and lose one of them.
 *
 * This is the right shape for local development, fixtures, tests, examples, and
 * small tools. It is not a database: every mutation rewrites the whole file, so
 * it should not be pointed at a large graph.
 */
export function jsonStore(options: JsonStoreOptions = {}): JsonStore {
  const file = resolve(options.file ?? './tsbouncer.json');
  const createIfMissing = options.createIfMissing ?? true;
  const trailingNewline = options.trailingNewline ?? true;
  const indent = options.indent ?? 2;

  const tuples = new Map<string, Tuple>();
  let queue: Promise<unknown> = Promise.resolve();

  load();

  function load(): void {
    if (!existsSync(file)) {
      if (!createIfMissing) {
        throw new StoreError(`no such file: ${file}`);
      }
      return;
    }

    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (cause) {
      throw new StoreError(`could not read ${file}`, { cause });
    }

    if (raw.trim().length === 0) return;

    // A corrupt file is never silently reset. That would turn a typo or a
    // half-finished external write into an empty database, and the caller would
    // have no way to tell.
    const parsed = parseDocument(raw, file);
    tuples.clear();
    for (const tuple of parsed) tuples.set(tupleKey(tuple), Object.freeze({ ...tuple }));
  }

  /**
   * Run `body` after every previously queued mutation, then persist.
   *
   * Chaining rather than awaiting a lock keeps callers independent: two `grant`
   * calls made without awaiting each other still both land.
   */
  function enqueue<T>(body: () => Promise<T>): Promise<T> {
    const next = queue.then(async () => {
      const result = await body();
      await persist();
      return result;
    });
    // Keep the chain alive even if this mutation rejects.
    queue = next.catch(() => undefined);
    return next;
  }

  async function persist(): Promise<void> {
    const document = {
      version: 1,
      tuples: [...tuples.values()].map(plain),
    };
    const text =
      JSON.stringify(document, undefined, indent) + (trailingNewline ? '\n' : '');

    // The temp file must be in the same directory as the target: `rename` is only
    // atomic within a filesystem, and `/tmp` is very often a different one.
    tempCounter += 1;
    const temp = `${file}.${process.pid}.${tempCounter}.tmp`;
    try {
      await writeFile(temp, text, 'utf8');
      await rename(temp, file);
    } catch (cause) {
      await unlink(temp).catch(() => undefined);
      throw new StoreError(`could not persist ${file}`, { cause });
    }
  }

  async function read(query: ReadTupleQuery = {}): Promise<Page<Tuple>> {
    const matched = [...tuples.values()].filter((t) => matchesQuery(t, query));
    return Object.freeze({
      items: Object.freeze(
        query.limit === undefined ? matched : matched.slice(0, query.limit),
      ),
    });
  }

  async function write(input: WriteInput): Promise<void> {
    if (input.tuples.length === 0) return;
    const mode = input.mode ?? 'insert';
    return enqueue(async () => {
      if (mode === 'insert') {
        // Checked inside the queue, so two inserts racing on the same key cannot
        // both see an empty slot and both "succeed".
        for (const tuple of input.tuples) {
          if (tuples.has(tupleKey(tuple))) {
            throw new StoreError(
              `write rejected by a unique constraint: ${tuple.subject}#${tuple.relation}@${tuple.resource} already exists`,
            );
          }
        }
      }
      for (const tuple of input.tuples) {
        tuples.set(tupleKey(tuple), Object.freeze({ ...tuple }));
      }
    });
  }

  async function remove(input: DeleteInput): Promise<void> {
    if (input.kind === 'tuples') {
      return enqueue(async () => {
        for (const tuple of input.tuples) tuples.delete(tupleKey(tuple));
      });
    }

    if (input.kind === 'filter') {
      return enqueue(async () => {
        for (const [key, tuple] of tuples) {
          if (matchesQuery(tuple, input.query)) tuples.delete(key);
        }
      });
    }

    return enqueue(async () => {
      const next = new Map(tuples);
      for (const [key, tuple] of next) {
        if (matchesQuery(tuple, input.query)) next.delete(key);
      }
      for (const tuple of input.tuples) {
        next.set(tupleKey(tuple), Object.freeze({ ...tuple }));
      }
      tuples.clear();
      for (const [key, tuple] of next) tuples.set(key, tuple);
    });
  }

  return Object.freeze({
    capabilities: CAPABILITIES,
    file,
    read,
    write,
    delete: remove,
    snapshot: () => Object.freeze([...tuples.values()]),
    async reload() {
      await queue;
      load();
    },
  });
}

function plain(tuple: Tuple): Record<string, unknown> {
  const row: Record<string, unknown> = {
    subject: tuple.subject,
    relation: tuple.relation,
    resource: tuple.resource,
  };
  if (tuple.condition !== undefined) row.condition = tuple.condition;
  if (tuple.context !== undefined) row.context = tuple.context;
  return row;
}

function parseDocument(raw: string, file: string): Tuple[] {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (cause) {
    throw new StoreError(`${file} is not valid JSON; refusing to reset it`, { cause });
  }

  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new StoreError(`${file} does not contain a JSON object`);
  }

  const { version, tuples } = document as { version?: unknown; tuples?: unknown };
  if (version !== 1) {
    throw new StoreError(
      `${file} has format version ${JSON.stringify(version)}; this build understands 1`,
    );
  }
  if (!Array.isArray(tuples)) {
    throw new StoreError(`${file} has no \`tuples\` array`);
  }

  return tuples.map((entry, index) => readTuple(entry, index, file));
}

function readTuple(entry: unknown, index: number, file: string): Tuple {
  if (typeof entry !== 'object' || entry === null) {
    throw new StoreError(`${file}: tuple ${index} is not an object`);
  }
  const row = entry as Record<string, unknown>;
  for (const field of ['subject', 'relation', 'resource'] as const) {
    if (typeof row[field] !== 'string') {
      throw new StoreError(`${file}: tuple ${index} is missing a string ${field}`);
    }
  }
  if (row.condition !== undefined && typeof row.condition !== 'string') {
    throw new StoreError(`${file}: tuple ${index} has a non-string condition`);
  }
  if (row.condition === undefined && row.context !== undefined) {
    throw new StoreError(`${file}: tuple ${index} has context but no condition`);
  }
  if (
    row.context !== undefined &&
    (typeof row.context !== 'object' || row.context === null)
  ) {
    throw new StoreError(`${file}: tuple ${index} has context that is not an object`);
  }

  return {
    subject: row.subject as string,
    relation: row.relation as string,
    resource: row.resource as string,
    condition: row.condition as string | undefined,
    context: row.context as Record<string, unknown> | undefined,
  };
}
