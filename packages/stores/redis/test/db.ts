import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import type { TupleStore } from 'tsbouncer';
import { redisStore } from '../src/index.js';

/**
 * Live Redis, namespaced per handle. Every key the store touches starts with
 * the prefix, so teardown is a prefix scan — never a `FLUSHDB`, which would
 * delete data that is not ours.
 *
 * There is no local fallback: without `TSBUNCER_REDIS_URL` the suites using
 * this file skip. CI never sets it, on purpose.
 */
export const REDIS_URL = process.env.TSBUNCER_REDIS_URL;

export interface Handle {
  store: TupleStore;
  client: RedisClientType;
  prefix: string;
  destroy(): Promise<void>;
}

export async function createDb(): Promise<Handle> {
  const client: RedisClientType = createClient({ url: REDIS_URL as string });
  await client.connect();
  const prefix = `tsbouncer:qa:${randomUUID()}`;
  const store = redisStore(client, { prefix });

  return {
    store,
    client,
    prefix,
    async destroy() {
      try {
        for await (const keys of client.scanIterator({
          MATCH: `${prefix}:*`,
          COUNT: 500,
        })) {
          if (keys.length > 0) await client.del(keys);
        }
      } finally {
        await client.destroy();
      }
    },
  };
}
