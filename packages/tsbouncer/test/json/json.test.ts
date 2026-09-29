import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { jsonStore } from '../../src/json/index.js';
import { cleanup, freshStore, tempFile } from './helpers.js';

afterAll(cleanup);

const T = (subject: string, relation: string, resource: string) => ({
  subject,
  relation,
  resource,
});

describe('the on-disk document', () => {
  it('is a versioned object with a tuples array', async () => {
    const file = tempFile();
    const store = jsonStore({ file });
    await store.write({ tuples: [T('user:alice', 'viewer', 'document:1')] });

    const document = JSON.parse(readFileSync(file, 'utf8'));
    expect(document.version).toBe(1);
    expect(document.tuples).toEqual([T('user:alice', 'viewer', 'document:1')]);
  });

  it('omits absent optional fields rather than writing null', async () => {
    const file = tempFile();
    const store = jsonStore({ file });
    await store.write({ tuples: [T('user:alice', 'viewer', 'document:1')] });
    const [tuple] = JSON.parse(readFileSync(file, 'utf8')).tuples;
    expect(tuple).not.toHaveProperty('condition');
    expect(tuple).not.toHaveProperty('context');
  });

  it('round-trips a condition and its context', async () => {
    const file = tempFile();
    await jsonStore({ file }).write({
      tuples: [
        {
          ...T('user:alice', 'viewer', 'document:1'),
          condition: 'inRegion',
          context: { region: 'eu', tier: 'pro' },
        },
      ],
    });
    const reopened = jsonStore({ file });
    expect((await reopened.read()).items[0]).toEqual({
      subject: 'user:alice',
      relation: 'viewer',
      resource: 'document:1',
      condition: 'inRegion',
      context: { region: 'eu', tier: 'pro' },
    });
  });

  it('ends with a newline and is indented by default', async () => {
    const file = tempFile();
    await jsonStore({ file }).write({
      tuples: [T('user:alice', 'viewer', 'document:1')],
    });
    const text = readFileSync(file, 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "version"');
  });

  it('honours indent and trailingNewline', async () => {
    const file = tempFile();
    await jsonStore({ file, indent: 0, trailingNewline: false }).write({
      tuples: [T('user:alice', 'viewer', 'document:1')],
    });
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('\n  ');
    expect(text.endsWith('}')).toBe(true);
  });

  it('is stable across a store instance, so state survives a restart', async () => {
    const file = tempFile();
    const first = jsonStore({ file });
    await first.write({ tuples: [T('user:alice', 'viewer', 'document:1')] });
    await first.delete({ kind: 'filter', query: { subject: 'user:alice' } });
    await first.write({ tuples: [T('user:bob', 'viewer', 'document:1')] });

    expect((await jsonStore({ file }).read()).items.map((t) => t.subject)).toEqual([
      'user:bob',
    ]);
  });

  it('treats an empty file as an empty store', async () => {
    const file = tempFile();
    writeFileSync(file, '');
    expect((await jsonStore({ file }).read()).items).toEqual([]);
  });

  it('treats a missing file as empty by default', () => {
    expect(jsonStore({ file: tempFile('absent.json') }).snapshot()).toEqual([]);
  });

  it('can refuse a missing file', () => {
    expect(() =>
      jsonStore({ file: tempFile('absent.json'), createIfMissing: false }),
    ).toThrow(/no such file/);
  });

  it('exposes the resolved path', () => {
    const file = tempFile();
    expect(jsonStore({ file }).file).toBe(file);
  });
});

describe('refusing to lose data', () => {
  it('does not reset a file that is not valid JSON', () => {
    const file = tempFile();
    writeFileSync(file, '{ this is not json');
    expect(() => jsonStore({ file })).toThrow(/not valid JSON; refusing to reset/);
    // The file is still there, untouched.
    expect(readFileSync(file, 'utf8')).toBe('{ this is not json');
  });

  it('rejects a document whose version it does not understand', () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ version: 99, tuples: [] }));
    expect(() => jsonStore({ file })).toThrow(/format version 99/);
  });

  it('rejects a document that is not an object', () => {
    const file = tempFile();
    writeFileSync(file, '[]');
    expect(() => jsonStore({ file })).toThrow(/does not contain a JSON object/);
  });

  it('rejects a document with no tuples array', () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ version: 1 }));
    expect(() => jsonStore({ file })).toThrow(/no `tuples` array/);
  });

  it('names the offending tuple when the shape is wrong', () => {
    const file = tempFile();
    writeFileSync(
      file,
      JSON.stringify({ version: 1, tuples: [{ subject: 'user:a', relation: 'b' }] }),
    );
    expect(() => jsonStore({ file })).toThrow(/tuple 0 is missing a string resource/);
  });

  it('rejects a non-string condition', () => {
    const file = tempFile();
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        tuples: [{ subject: 'user:a', relation: 'b', resource: 'c', condition: 7 }],
      }),
    );
    expect(() => jsonStore({ file })).toThrow(/tuple 0 has a non-string condition/);
  });

  it('rejects context with no condition', () => {
    const file = tempFile();
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        tuples: [{ subject: 'user:a', relation: 'b', resource: 'c', context: { a: 1 } }],
      }),
    );
    expect(() => jsonStore({ file })).toThrow(/context but no condition/);
  });

  it('rejects context that is not an object', () => {
    const file = tempFile();
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        tuples: [
          {
            subject: 'user:a',
            relation: 'b',
            resource: 'c',
            condition: 'x',
            context: 'nope',
          },
        ],
      }),
    );
    expect(() => jsonStore({ file })).toThrow(/context that is not an object/);
  });

  it('rejects a tuple entry that is not an object', () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ version: 1, tuples: ['nope'] }));
    expect(() => jsonStore({ file })).toThrow(/tuple 0 is not an object/);
  });
});

describe('concurrent mutations', () => {
  it('serializes overlapping writes so neither is lost', async () => {
    // Both are issued without awaiting the first. If the read-modify-write were
    // not serialized, the second would flush a snapshot that predates the first.
    const store = freshStore();
    await Promise.all([
      store.write({ tuples: [T('user:alice', 'viewer', 'document:1')] }),
      store.write({ tuples: [T('user:bob', 'viewer', 'document:1')] }),
    ]);
    expect(store.snapshot().map((t) => t.subject)).toEqual(['user:alice', 'user:bob']);
  });

  it('serializes many overlapping writes', async () => {
    const store = freshStore();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.write({ tuples: [T(`user:u${i}`, 'viewer', 'document:1')] }),
      ),
    );
    expect(store.snapshot()).toHaveLength(25);
    // And it is on disk, not just in memory.
    expect(JSON.parse(readFileSync(store.file, 'utf8')).tuples).toHaveLength(25);
  });

  it('still rejects a duplicate when two inserts race for the same key', async () => {
    const store = freshStore();
    const tuple = T('user:alice', 'viewer', 'document:1');
    const results = await Promise.allSettled([
      store.write({ tuples: [tuple] }),
      store.write({ tuples: [tuple] }),
    ]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(store.snapshot()).toHaveLength(1);
  });

  it('names the one-param-set rule when a re-binding is rejected', async () => {
    const store = freshStore();
    const first = {
      ...T('user:alice', 'viewer', 'document:1'),
      condition: 'inRegion',
      context: { region: 'eu' },
    };
    await store.write({ tuples: [first] });
    await expect(
      store.write({ tuples: [{ ...first, context: { region: 'us' } }] }),
    ).rejects.toThrow(/one param-set per condition/);
    expect(store.snapshot()).toEqual([first]);
  });

  it('keeps working after a rejected write', async () => {
    const store = freshStore();
    await store.write({ tuples: [T('user:alice', 'viewer', 'document:1')] });
    await expect(
      store.write({ tuples: [T('user:alice', 'viewer', 'document:1')] }),
    ).rejects.toThrow(/unique constraint/);
    await store.write({ tuples: [T('user:bob', 'viewer', 'document:1')] });
    expect(store.snapshot()).toHaveLength(2);
  });
});

describe('atomicity', () => {
  it('leaves no temp files behind after a successful write', async () => {
    const store = freshStore();
    await store.write({ tuples: [T('user:alice', 'viewer', 'document:1')] });
    const entries = await readdir(store.file.replace(/[^/]+$/, ''));
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('writes the previous state intact when a mutation fails', async () => {
    const file = tempFile();
    const store = jsonStore({ file });
    await store.write({ tuples: [T('user:alice', 'viewer', 'document:1')] });
    const before = readFileSync(file, 'utf8');

    await expect(
      store.delete({
        kind: 'tuples',
        tuples: [{ subject: 'x', relation: 'y', resource: 'z' }],
      }),
    ).resolves.toBeUndefined();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('reload', () => {
  it('picks up a change written by someone else', async () => {
    const file = tempFile();
    const mine = jsonStore({ file });
    await mine.write({ tuples: [T('user:alice', 'viewer', 'document:1')] });

    // Something else edits the file directly.
    const document = JSON.parse(readFileSync(file, 'utf8'));
    document.tuples.push(T('user:bob', 'viewer', 'document:1'));
    writeFileSync(file, JSON.stringify(document, null, 2));

    expect(mine.snapshot()).toHaveLength(1);
    await mine.reload();
    expect(mine.snapshot()).toHaveLength(2);
  });

  it('is a no-op on a store that has never been written', async () => {
    const store = freshStore();
    await store.reload();
    expect(store.snapshot()).toEqual([]);
  });
});

describe('store metadata', () => {
  it('reports a file-backed capability set', () => {
    const store = freshStore();
    expect(store.capabilities).toMatchObject({
      persistent: true,
      atomicWrite: true,
      atomicReplace: true,
      pagination: false,
      transaction: false,
      watch: false,
    });
  });

  it('defaults to tsbouncer.json in the working directory', () => {
    expect(jsonStore().file.endsWith('tsbouncer.json')).toBe(true);
  });
});

describe('two stores on one file', () => {
  it('extends what the other instance wrote instead of overwriting it', async () => {
    const file = tempFile();
    const a = jsonStore({ file });
    await a.write({ tuples: [T('user:alice', 'viewer', 'document:1')] });

    const b = jsonStore({ file });
    await b.write({ tuples: [T('user:bob', 'viewer', 'document:2')] });

    // A has never seen bob's tuple in memory. Writing through A must not drop it.
    await a.write({ tuples: [T('user:carol', 'viewer', 'document:3')] });

    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as {
      tuples: { subject: string }[];
    };
    expect(onDisk.tuples.map((t) => t.subject).sort()).toEqual([
      'user:alice',
      'user:bob',
      'user:carol',
    ]);
  });

  it('still serves its own view until reload, which is what reload is for', async () => {
    const file = tempFile();
    const a = jsonStore({ file });
    await a.write({ tuples: [T('user:alice', 'viewer', 'document:1')] });

    const b = jsonStore({ file });
    await b.write({ tuples: [T('user:bob', 'viewer', 'document:2')] });

    expect(a.snapshot()).toHaveLength(1);
    await a.reload();
    expect(a.snapshot()).toHaveLength(2);
  });
});

describe('a rejected persist', () => {
  it('leaves no tuple in memory for a later write to pick up', async () => {
    const file = tempFile('missing-dir/tsbouncer.json');
    const store = jsonStore({ file });

    await expect(
      store.write({ tuples: [T('user:alice', 'viewer', 'document:1')] }),
    ).rejects.toThrow(/could not persist/);

    expect(store.snapshot()).toHaveLength(0);
    expect((await store.read()).items).toHaveLength(0);
    expect(existsSync(file)).toBe(false);
  });
});

describe('file permissions', () => {
  it('keeps the mode the file already had rather than widening it', async () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ version: 1, tuples: [] }));
    chmodSync(file, 0o600);

    const store = jsonStore({ file });
    await store.write({ tuples: [T('user:alice', 'viewer', 'document:1')] });

    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('creates a new file private to its owner', async () => {
    const store = freshStore();
    await store.write({ tuples: [T('user:alice', 'viewer', 'document:1')] });
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
  });
});
