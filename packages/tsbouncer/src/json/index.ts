import { existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, open, rename, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  DeleteInput,
  Page,
  ReadTupleQuery,
  Tuple,
  TupleStore,
  TupleStoreCapabilities,
  WriteInput,
} from '../kernel/index.js';
import {
  duplicateTupleMessage,
  matchesQuery,
  StoreError,
  tupleKey,
} from '../kernel/index.js';
import { FORMAT_VERSION } from './format.js';

export type { Document } from './format.js';
export { FORMAT_VERSION };

export interface JsonStore extends TupleStore {
  /** The resolved file this store persists to. */
  readonly file: string;
  /** Every tuple currently held, in insertion order. */
  snapshot(): readonly Tuple[];
  /** Re-read the file, discarding in-memory state. */
  reload(): Promise<void>;
}

const CAPABILITIES: TupleStoreCapabilities = Object.freeze({
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
 * A `TupleStore` over a single JSON file.
 *
 * The whole state is held in memory and the file is rewritten on every mutation,
 * which is the point: the file stays a human-readable, git-diffable, portable
 * representation of the authorization state rather than a build artifact.
 *
 * Three things make that safe. Every write goes to a temporary file in the *same
 * directory* and is then renamed over the target, so a reader never observes a
 * half-written file and a crash mid-write leaves the previous state intact.
 * Mutations are serialized through a promise chain, so two overlapping
 * read-modify-write cycles cannot interleave and lose one of them. And before a
 * mutation is applied the file is re-read if anything else has touched it, so a
 * second store on the same path extends rather than overwrites — without that,
 * instance A's next write silently deleted instance B's grant.
 *
 * The one thing this does not do is lock. Two *simultaneous* writers in
 * different processes can still interleave between the re-read and the rename,
 * because closing that window needs a lock file and locks have failure modes of
 * their own. One writer at a time is the supported shape; everything up to that
 * point is correct rather than best-effort.
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
  /** What the file looked like when we last read or wrote it. */
  let stamp: string | null = null;

  load();

  /**
   * mtime and size of the file, or `null` if it is not there.
   *
   * This is how a second writer is noticed. Two instances over one file is the
   * case that silently loses grants: without it, a later write replaces the file
   * wholesale and drops whatever the other instance put there.
   */
  function fingerprint(): string | null {
    try {
      const stats = statSync(file);
      return `${stats.mtimeMs}:${stats.size}`;
    } catch {
      return null;
    }
  }

  /**
   * Adopt whatever is on disk now, discarding in-memory state.
   *
   * Called on construction, on an observed external change, and before applying
   * a mutation. `createIfMissing` still governs a missing file: an application
   * that asked to be told about one will be told.
   */
  function load(): void {
    if (!existsSync(file)) {
      if (!createIfMissing) {
        throw new StoreError(`no such file: ${file}`);
      }
      tuples.clear();
      stamp = null;
      return;
    }

    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (cause) {
      throw new StoreError(`could not read ${file}`, { cause });
    }

    if (raw.trim().length === 0) {
      tuples.clear();
      stamp = fingerprint();
      return;
    }

    // A corrupt file is never silently reset. That would turn a typo or a
    // half-finished external write into an empty database, and the caller would
    // have no way to tell.
    const parsed = parseDocument(raw, file);
    tuples.clear();
    for (const tuple of parsed) tuples.set(tupleKey(tuple), Object.freeze({ ...tuple }));
    stamp = fingerprint();
  }

  /** Re-read if something other than this store touched the file. */
  function refresh(): void {
    if (fingerprint() !== stamp) load();
  }

  /**
   * Run `body` against a draft copy of the state, persist it, then adopt it.
   *
   * Chaining rather than awaiting a lock keeps callers independent: two `grant`
   * calls made without awaiting each other still both land.
   *
   * The draft matters. Mutating `tuples` first and persisting second left the
   * in-memory state changed when the persist failed, so a caller that saw a
   * rejected write would find it in `read()` anyway and have it land on disk at
   * the next successful write. Nothing is adopted until the bytes are on disk.
   */
  function enqueue<T>(body: (draft: Map<string, Tuple>) => T): Promise<T> {
    const next = queue.then(async () => {
      refresh();
      const draft = new Map(tuples);
      const result = body(draft);
      await persist(draft);
      tuples.clear();
      for (const [key, tuple] of draft) tuples.set(key, tuple);
      stamp = fingerprint();
      return result;
    });
    // Keep the chain alive even if this mutation rejects.
    queue = next.catch(() => undefined);
    return next;
  }

  async function persist(draft: Map<string, Tuple>): Promise<void> {
    const document = {
      version: FORMAT_VERSION,
      tuples: [...draft.values()].map(plain),
    };
    const text =
      JSON.stringify(document, undefined, indent) + (trailingNewline ? '\n' : '');

    // The temp file must be in the same directory as the target: `rename` is only
    // atomic within a filesystem, and `/tmp` is very often a different one.
    tempCounter += 1;
    const temp = `${file}.${process.pid}.${tempCounter}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      // `wx` refuses to open an existing path, so the temp file cannot be a
      // symlink planted by someone else in this directory — a plain `write`
      // would follow it and write through to whatever it points at. Authorization
      // state is not world-readable by default.
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(text, 'utf8');
      // Renaming is atomic; durability is not. Without this a crash can leave a
      // renamed file whose contents never reached the disk.
      await handle.sync();
      await handle.close();
      handle = undefined;
      await adoptExistingMode(temp);
      await rename(temp, file);
    } catch (cause) {
      await handle?.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      throw new StoreError(`could not persist ${file}`, { cause });
    }
  }

  /** Keep the permissions the file already had, rather than resetting them. */
  async function adoptExistingMode(temp: string): Promise<void> {
    try {
      await chmod(temp, (await stat(file)).mode & 0o7777);
    } catch {
      // No target yet: the temp file's own mode stands.
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
    return enqueue((draft) => {
      if (mode === 'insert') {
        // Checked against the draft *and* the rest of the batch, so two inserts
        // racing on the same key cannot both see an empty slot and both
        // "succeed", and one call cannot carry the same key twice either.
        const seen = new Set<string>();
        for (const tuple of input.tuples) {
          const key = tupleKey(tuple);
          if (draft.has(key) || seen.has(key)) {
            throw new StoreError(duplicateTupleMessage(tuple));
          }
          seen.add(key);
        }
      }
      for (const tuple of input.tuples) {
        draft.set(tupleKey(tuple), Object.freeze({ ...tuple }));
      }
    });
  }

  async function remove(input: DeleteInput): Promise<void> {
    if (input.kind === 'tuples') {
      return enqueue((draft) => {
        for (const tuple of input.tuples) draft.delete(tupleKey(tuple));
      });
    }

    if (input.kind === 'filter') {
      return enqueue((draft) => {
        for (const [key, tuple] of draft) {
          if (matchesQuery(tuple, input.query)) draft.delete(key);
        }
      });
    }

    return enqueue((draft) => {
      for (const [key, tuple] of draft) {
        if (matchesQuery(tuple, input.query)) draft.delete(key);
      }
      for (const tuple of input.tuples) {
        draft.set(tupleKey(tuple), Object.freeze({ ...tuple }));
      }
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
  if (version !== FORMAT_VERSION) {
    throw new StoreError(
      `${file} has format version ${JSON.stringify(version)}; this build understands ${FORMAT_VERSION}`,
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
