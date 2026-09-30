import { StoreError } from '@tsbouncer/tsbouncer';
import { createClient, type RedisClientType } from 'redis';
import { describe, expect, it } from 'vitest';
import { redisStore } from '../src/index.js';
import { REDIS_URL } from './db.js';

/**
 * A client that answers from a script instead of a socket. Every reply below
 * is a shape the protocol allows but no honest server sends in that spot, so
 * these tests pin the store's defensive branches — the ones live traffic can
 * never reach precisely because the Lua scripts are correct.
 */
interface ScriptCall {
  readonly keys: string[];
  readonly args: (string | number)[];
}

function scriptedClient(
  replies: readonly unknown[],
  log?: ScriptCall[],
): RedisClientType {
  let calls = 0;
  return {
    isOpen: true,
    async connect() {},
    destroy() {},
    async eval(
      _script: unknown,
      options: { keys?: string[]; arguments?: (string | number)[] },
    ) {
      log?.push({ keys: options.keys ?? [], args: options.arguments ?? [] });
      const reply = calls < replies.length ? replies[calls] : replies[replies.length - 1];
      calls += 1;
      return reply;
    },
  } as unknown as RedisClientType;
}

function failingClient(cause: unknown): RedisClientType {
  return {
    isOpen: false,
    async connect() {
      throw cause;
    },
    destroy() {},
    async eval(): Promise<unknown> {
      throw new Error('unreachable');
    },
  } as unknown as RedisClientType;
}

function throwingClient(error: unknown): RedisClientType {
  return {
    isOpen: true,
    async connect() {},
    destroy() {},
    async eval(): Promise<unknown> {
      throw error;
    },
  } as unknown as RedisClientType;
}

/**
 * Offline unit tests — no server. Everything here must hold without a
 * connection, which is also what makes each one a precise statement about
 * where validation lives: cursors and capabilities are decided locally,
 * tuples are decided in Lua.
 */
describe('without a server', () => {
  it('declares honest capabilities', () => {
    const store = redisStore(createClient());
    expect(store.capabilities).toEqual({
      atomicWrite: true,
      persistent: true,
      atomicReplace: true,
      pagination: true,
      transaction: false,
      watch: false,
    });
  });

  it('rejects an invalid cursor before touching the network', async () => {
    const store = redisStore(createClient());
    await expect(store.read({ cursor: 'nope' })).rejects.toThrow(/invalid cursor/);
  });

  it('answers an empty page for a non-positive limit without I/O', async () => {
    const store = redisStore(createClient());
    const page = await store.read({ limit: 0 });
    expect(page.items).toEqual([]);
    expect(page.cursor).toBeUndefined();
  });

  it('ignores writes and deletes of nothing, without I/O', async () => {
    const store = redisStore(createClient());
    await store.write({ tuples: [] });
    await store.delete({ kind: 'tuples', tuples: [] });
  });

  it('rejects a reply shape the protocol allows but Lua never sends', async () => {
    const store = redisStore(scriptedClient([42]));
    await expect(store.read({})).rejects.toThrow(/unexpected reply shape/);
  });
  it('reads defensively: string totals, null totals, non-string entries', async () => {
    const doc = JSON.stringify({
      subject: 'user:alice',
      relation: 'viewer',
      resource: 'document:1',
    });
    const asStore = (replies: readonly unknown[]) => redisStore(scriptedClient(replies));

    const stringTotal = await asStore([['2', doc, 42]]).read({ limit: 2 });
    expect(stringTotal.items).toHaveLength(1);
    expect(stringTotal.cursor).toBe('1');

    const nullTotal = await asStore([[null]]).read({});
    expect(nullTotal.items).toEqual([]);

    const full = JSON.stringify({
      subject: 'user:alice',
      relation: 'viewer',
      resource: 'document:1',
      condition: 'inRegion',
      context: { region: 'eu' },
    });
    const conditioned = await asStore([[1, full]]).read({});
    expect(conditioned.items).toEqual([
      {
        subject: 'user:alice',
        relation: 'viewer',
        resource: 'document:1',
        condition: 'inRegion',
        context: { region: 'eu' },
      },
    ]);
  });

  it('reads a valid cursor without touching its meaning', async () => {
    const store = redisStore(scriptedClient([[0]]));
    const page = await store.read({ cursor: '0' });
    expect(page.items).toEqual([]);
    expect(page.cursor).toBeUndefined();
  });

  it('builds one index set per filtered value', async () => {
    const log: ScriptCall[] = [];
    const store = redisStore(scriptedClient([[0]], log));
    await store.read({ subject: ['user:alice', 'user:bob'], relation: 'viewer' });
    expect(log).toEqual([
      {
        keys: [
          'tsbouncer:all',
          'tsbouncer:i:s:user:alice',
          'tsbouncer:i:s:user:bob',
          'tsbouncer:i:r:viewer',
        ],
        args: ['tsbouncer', '[[2,3],[4]]', '-1', '0'],
      },
    ]);
  });

  it('encodes condition bindings into stored rows', async () => {
    const log: ScriptCall[] = [];
    const store = redisStore(scriptedClient([1], log));
    await store.write({
      tuples: [
        {
          subject: 'user:alice',
          relation: 'viewer',
          resource: 'document:1',
          condition: 'inRegion',
          context: { region: 'eu' },
        },
      ],
    });
    expect(log).toEqual([
      {
        keys: ['tsbouncer:all'],
        args: ['tsbouncer', 'insert', expect.any(String)],
      },
    ]);
    const payloads = log.map((entry) => entry.args[2]);
    expect(payloads).toHaveLength(1);
    const logged = JSON.parse(payloads[0] as string) as { doc: string }[];
    expect(logged).toHaveLength(1);
  });

  it('passes StoreErrors through untouched', async () => {
    const store = redisStore(throwingClient(new StoreError('inner', {})));
    await expect(store.read({})).rejects.toThrow('inner');
  });

  it('maps a string duplicate error to the one-param-set message', async () => {
    const store = redisStore(throwingClient('TSB_DUPLICATE:1'));
    await expect(
      store.write({
        tuples: [
          {
            subject: 'user:alice',
            relation: 'viewer',
            resource: 'document:1',
            condition: 'inRegion',
            context: { region: 'eu' },
          },
        ],
      }),
    ).rejects.toThrow(/one param-set per condition/);
  });

  it('wraps a non-error connection failure', async () => {
    const store = redisStore(failingClient('socket hung up'));
    await expect(store.read({})).rejects.toThrow(/socket hung up/);
  });

  it('writes and deletes through scripted replies', async () => {
    const tuple = { subject: 'user:alice', relation: 'viewer', resource: 'document:1' };
    const store = redisStore(scriptedClient([1, 1, 1, 1]));
    await store.write({ tuples: [tuple] });
    await store.write({ tuples: [tuple], mode: 'upsert' });
    await store.delete({ kind: 'tuples', tuples: [tuple] });
    await store.delete({ kind: 'filter', query: { relation: 'viewer' } });
    await store.delete({ kind: 'replace', query: {}, tuples: [tuple] });
  });

  it('reads a page through a scripted reply', async () => {
    const doc = JSON.stringify({
      subject: 'user:alice',
      relation: 'viewer',
      resource: 'document:1',
    });
    const store = redisStore(scriptedClient([[3, doc]]));
    const page = await store.read({ limit: 2 });
    expect(page.items).toHaveLength(1);
    expect(page.cursor).toBe('1');
  });

  it('connects lazily when closed', async () => {
    let connected = false;
    const fake = {
      isOpen: false,
      async connect() {
        connected = true;
        (this as { isOpen: boolean }).isOpen = true;
      },
      destroy() {},
      async eval(): Promise<unknown> {
        return [0];
      },
    } as unknown as RedisClientType;
    const store = redisStore(fake);
    const page = await store.read({});
    expect(page.items).toEqual([]);
    expect(connected).toBe(true);
  });

  it('wraps an unreachable server in StoreError on every operation', async () => {
    const client = createClient({
      url: 'redis://127.0.0.1:9',
      socket: { connectTimeout: 500, reconnectStrategy: false },
    });
    const store = redisStore(client);
    const tuple = {
      subject: 'user:alice',
      relation: 'viewer',
      resource: 'document:1',
    };
    try {
      await expect(store.read({})).rejects.toThrow(StoreError);
      await expect(store.write({ tuples: [tuple] })).rejects.toThrow(StoreError);
      await expect(store.delete({ kind: 'tuples', tuples: [tuple] })).rejects.toThrow(
        StoreError,
      );
      await expect(store.delete({ kind: 'filter', query: {} })).rejects.toThrow(
        StoreError,
      );
      await expect(
        store.delete({ kind: 'replace', query: {}, tuples: [tuple] }),
      ).rejects.toThrow(StoreError);
    } finally {
      // Never connected — destroy() on a closed client throws, so only clean
      // up a socket that actually opened.
      if (client.isOpen) client.destroy();
    }
  });
});

describe.skipIf(!REDIS_URL)('corrupt rows (redis)', () => {
  it('rejects externally corrupted rows instead of returning them', async () => {
    const { createDb } = await import('./db.js');
    const handle = await createDb();
    try {
      await handle.store.write({
        tuples: [{ subject: 'user:alice', relation: 'viewer', resource: 'document:1' }],
      });
      for await (const keys of handle.client.scanIterator({
        MATCH: `${handle.prefix}:t:*`,
      })) {
        for (const key of keys) await handle.client.set(key, '{not json');
      }
      await expect(handle.store.read({})).rejects.toThrow(/unparseable/);
    } finally {
      await handle.destroy();
    }
  });
});

describe.skipIf(!REDIS_URL)('duplicate message (redis)', () => {
  it('names the one-param-set rule on a re-binding', async () => {
    const { createDb } = await import('./db.js');
    const handle = await createDb();
    try {
      const first = {
        subject: 'user:alice',
        relation: 'viewer',
        resource: 'document:1',
        condition: 'inRegion',
        context: { region: 'eu' },
      };
      await handle.store.write({ tuples: [first] });
      await expect(
        handle.store.write({ tuples: [{ ...first, context: { region: 'us' } }] }),
      ).rejects.toThrow(/one param-set per condition/);
    } finally {
      await handle.destroy();
    }
  });
});
