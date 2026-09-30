import { createHash } from 'node:crypto';
import type {
  DeleteInput,
  FilterValue,
  Page,
  ReadTupleQuery,
  Tuple,
  TupleStore,
  TupleStoreCapabilities,
  WriteInput,
} from '@tsbouncer/tsbouncer';
import { duplicateTupleMessage, StoreError, tupleKey } from '@tsbouncer/tsbouncer';
import type { RedisClientType } from 'redis';

/**
 * How tuples live in Redis. Plain commands only — no modules, no RediSearch —
 * so this runs against any Redis 7+ server:
 *
 *   <p>:t:<id>      STRING, the tuple as JSON. `<id>` is the tuple key.
 *   <p>:all         SET of every id. The match-all behind `read({})`.
 *   <p>:i:s:<sub>   SET of ids with this subject, and likewise
 *   <p>:i:r:<rel>   `:r:` for relation,
 *   <p>:i:o:<res>   `:o:` for resource.
 *
 * A filter is a conjunction of fields; each field is one value (one set) or
 * several (a union of sets). Matching, writing, and deleting all run as Lua
 * scripts, so every mutation is atomic and a reader never sees half a write.
 * Values are embedded raw in key names — keys are never parsed, only
 * constructed, so separators in ids cannot collide.
 */

export interface RedisStoreOptions {
  /** Key namespace. Defaults to `tsbouncer`. Isolate tests with a uuid. */
  readonly prefix?: string;
}

const CAPABILITIES: TupleStoreCapabilities = Object.freeze({
  atomicWrite: true,
  persistent: true,
  atomicReplace: true,
  pagination: true,
  transaction: false,
  watch: false,
});

type Row = {
  readonly id: string;
  readonly subject: string;
  readonly relation: string;
  readonly resource: string;
  readonly doc: string;
};

function rowOf(tuple: Tuple): Row {
  const stored: Record<string, unknown> = {
    subject: tuple.subject,
    relation: tuple.relation,
    resource: tuple.resource,
  };
  if (tuple.condition !== undefined) stored.condition = tuple.condition;
  if (tuple.context !== undefined) stored.context = tuple.context;
  return {
    id: createHash('sha256').update(tupleKey(tuple)).digest('hex'),
    subject: tuple.subject,
    relation: tuple.relation,
    resource: tuple.resource,
    doc: JSON.stringify(stored),
  };
}

function tupleOf(doc: string): Tuple {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(doc) as Record<string, unknown>;
  } catch (cause) {
    throw new StoreError('tuple has unparseable context JSON', { cause });
  }
  const tuple: Tuple = Object.freeze({
    subject: String(parsed.subject),
    relation: String(parsed.relation),
    resource: String(parsed.resource),
    ...(typeof parsed.condition === 'string' ? { condition: parsed.condition } : {}),
    ...(parsed.context !== undefined && parsed.context !== null
      ? { context: parsed.context as Record<string, unknown> }
      : {}),
  });
  return tuple;
}

/** Conjunction of unions, as 1-based indexes into KEYS (`KEYS[1]` is `:all`). */
function groupsFor(
  query: ReadTupleQuery,
  prefix: string,
): { readonly groups: readonly (readonly number[])[]; readonly keys: string[] } {
  const keys: string[] = [`${prefix}:all`];
  const groups: number[][] = [];
  const field = (value: FilterValue | undefined, kind: 's' | 'r' | 'o'): void => {
    if (value === undefined) return;
    const values = typeof value === 'string' ? [value] : [...value];
    const group: number[] = [];
    for (const v of values) {
      keys.push(`${prefix}:i:${kind}:${v}`);
      group.push(keys.length);
    }
    groups.push(group);
  };
  field(query.subject, 's');
  field(query.relation, 'r');
  field(query.resource, 'o');
  return { groups, keys };
}

/**
 * Match candidates and page them. Runs fully server-side: union each field's
 * sets, intersect the fields, sort for a stable order, then slice.
 *
 * ARGV = [prefix, groupsJson, limit(-1 for all), offset]. Returns
 * `[total, doc, doc, …]`.
 */
const MATCH = `
local groups = cjson.decode(ARGV[2])
local limit = tonumber(ARGV[3])
local offset = tonumber(ARGV[4])
local prefix = ARGV[1]
local result = nil
for _, group in ipairs(groups) do
  local union = {}
  for _, kidx in ipairs(group) do
    for _, m in ipairs(redis.call('SMEMBERS', KEYS[kidx])) do
      union[m] = true
    end
  end
  if result == nil then
    result = union
  else
    for m in pairs(result) do
      if not union[m] then result[m] = nil end
    end
  end
end
if result == nil then
  result = {}
  for _, m in ipairs(redis.call('SMEMBERS', KEYS[1])) do
    result[m] = true
  end
end
local sorted = {}
for m in pairs(result) do sorted[#sorted + 1] = m end
table.sort(sorted)
local total = #sorted
local out = {total}
local last = total
if limit >= 0 then last = math.min(offset + limit, total) end
for i = offset + 1, last do
  local doc = redis.call('GET', prefix .. ':t:' .. sorted[i])
  if doc then out[#out + 1] = doc end
end
return out
`;

/**
 * Insert or upsert a batch, atomically. ARGV = [prefix, mode, rowsJson] where
 * each row carries its id, fields, and serialized doc. Insert pre-checks every
 * key first, so a duplicate aborts the whole batch rather than half of it;
 * the error names the 1-based offender for the caller's message.
 */
const WRITE = `
local prefix = ARGV[1]
local mode = ARGV[2]
local rows = cjson.decode(ARGV[3])
if mode == 'insert' then
  local seen = {}
  for i, t in ipairs(rows) do
    if redis.call('EXISTS', prefix .. ':t:' .. t.id) == 1 or seen[t.id] then
      return redis.error_reply('TSB_DUPLICATE:' .. i)
    end
    seen[t.id] = true
  end
end
for _, t in ipairs(rows) do
  redis.call('SET', prefix .. ':t:' .. t.id, t.doc)
  redis.call('SADD', prefix .. ':all', t.id)
  redis.call('SADD', prefix .. ':i:s:' .. t.subject, t.id)
  redis.call('SADD', prefix .. ':i:r:' .. t.relation, t.id)
  redis.call('SADD', prefix .. ':i:o:' .. t.resource, t.id)
end
return #rows
`;

/**
 * Delete by identity, by filter, or replace-scoped — one script, so `replace`
 * is atomic. ARGV = [prefix, op, payloadJson]:
 *
 *   tuples  payload is [{id, subject, relation, resource}…]; absent rows are
 *           no-ops, matching every other store.
 *   filter  payload is {groups}; every match is removed with its indexes.
 *   replace payload is {groups, rows}; the match is removed, then the rows are
 *           added in `insert` mode, so a clash with a survivor still rejects.
 */
const DELETE = `
local prefix = ARGV[1]
local op = ARGV[2]
local payload = cjson.decode(ARGV[3])
local function drop(id, subject, relation, resource)
  redis.call('DEL', prefix .. ':t:' .. id)
  redis.call('SREM', prefix .. ':all', id)
  redis.call('SREM', prefix .. ':i:s:' .. subject, id)
  redis.call('SREM', prefix .. ':i:r:' .. relation, id)
  redis.call('SREM', prefix .. ':i:o:' .. resource, id)
end
if op == 'tuples' then
  for _, t in ipairs(payload) do
    drop(t.id, t.subject, t.relation, t.resource)
  end
  return #payload
end
local groups = payload.groups
local result = nil
for _, group in ipairs(groups) do
  local union = {}
  for _, kidx in ipairs(group) do
    for _, m in ipairs(redis.call('SMEMBERS', KEYS[kidx])) do
      union[m] = true
    end
  end
  if result == nil then
    result = union
  else
    for m in pairs(result) do
      if not union[m] then result[m] = nil end
    end
  end
end
if result == nil then
  result = {}
  for _, m in ipairs(redis.call('SMEMBERS', KEYS[1])) do
    result[m] = true
  end
end
for id in pairs(result) do
  local doc = redis.call('GET', prefix .. ':t:' .. id)
  if doc then
    local t = cjson.decode(doc)
    drop(id, t.subject, t.relation, t.resource)
  end
end
if op == 'replace' then
  for i, t in ipairs(payload.rows) do
    if redis.call('EXISTS', prefix .. ':t:' .. t.id) == 1 then
      return redis.error_reply('TSB_DUPLICATE:' .. i)
    end
  end
  for _, t in ipairs(payload.rows) do
    redis.call('SET', prefix .. ':t:' .. t.id, t.doc)
    redis.call('SADD', prefix .. ':all', t.id)
    redis.call('SADD', prefix .. ':i:s:' .. t.subject, t.id)
    redis.call('SADD', prefix .. ':i:r:' .. t.relation, t.id)
    redis.call('SADD', prefix .. ':i:o:' .. t.resource, t.id)
  end
end
return 1
`;

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^(0|[1-9][0-9]*)$/.test(cursor)) {
    throw new StoreError(`invalid cursor ${JSON.stringify(cursor)}`);
  }
  return Number(cursor);
}

/**
 * A `TupleStore` over an application-owned Redis client.
 *
 * Pass a client you already use — `redisStore(client)` never connects,
 * disconnects, or selects a database. Point it at a keyspace your application
 * owns (or a `prefix` of one): every key the store touches starts with the
 * prefix, and teardown is a prefix scan, never a `FLUSHDB`.
 *
 * Two deployment shapes, one implementation. As the *primary* store it holds
 * the whole access graph durably; as the *hot* store it holds the working set
 * your checks actually walk, with a database of record behind it. Either way
 * the contract is identical — the conformance suite cannot tell which role a
 * given instance plays.
 */
export function redisStore(
  client: RedisClientType,
  options: RedisStoreOptions = {},
): TupleStore {
  const prefix = options.prefix ?? 'tsbouncer';

  async function ensureConnected(): Promise<void> {
    if (client.isOpen) return;
    try {
      await client.connect();
    } catch (cause) {
      throw new StoreError(
        `could not connect to Redis: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  }

  async function evalScript(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<unknown> {
    await ensureConnected();
    try {
      return await client.eval(script, {
        keys,
        arguments: args.map(String),
      });
    } catch (cause) {
      throw asStoreError(cause);
    }
  }

  function duplicateAt(rows: readonly Row[], cause: unknown): Error {
    const match = /TSB_DUPLICATE:(\d+)/.exec(
      cause instanceof Error ? cause.message : String(cause),
    );
    const row = match === null ? undefined : rows[Number(match[1]) - 1];
    if (row === undefined) return asStoreError(cause);
    return new StoreError(
      duplicateTupleMessage({
        subject: row.subject,
        relation: row.relation,
        resource: row.resource,
        condition: (JSON.parse(row.doc) as { condition?: string }).condition,
      }),
    );
  }

  function asStoreError(cause: unknown): Error {
    if (cause instanceof StoreError) return cause;
    return new StoreError(
      `Redis operation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  async function read(query: ReadTupleQuery = {}): Promise<Page<Tuple>> {
    const offset = decodeCursor(query.cursor);
    if (query.limit !== undefined && query.limit <= 0) {
      return Object.freeze({ items: Object.freeze([]) });
    }
    const { groups, keys } = groupsFor(query, prefix);
    let reply: unknown;
    try {
      reply = await evalScript(MATCH, keys, [
        prefix,
        JSON.stringify(groups),
        query.limit ?? -1,
        offset,
      ]);
    } catch (cause) {
      throw asStoreError(cause);
    }
    if (!Array.isArray(reply)) {
      throw new StoreError('unexpected reply shape from Redis');
    }
    const [totalRaw, ...docs] = reply;
    const total = typeof totalRaw === 'number' ? totalRaw : Number(totalRaw ?? 0);
    const items = docs.flatMap((doc) => (typeof doc === 'string' ? [tupleOf(doc)] : []));
    const lastIndex = offset + items.length;
    const hasMore = query.limit !== undefined && lastIndex < total;
    return Object.freeze({
      items: Object.freeze(items),
      cursor: hasMore ? String(lastIndex) : undefined,
    });
  }

  async function write(input: WriteInput): Promise<void> {
    if (input.tuples.length === 0) return;
    const mode = input.mode ?? 'insert';
    const rows = input.tuples.map(rowOf);
    try {
      await evalScript(WRITE, [`${prefix}:all`], [prefix, mode, JSON.stringify(rows)]);
    } catch (cause) {
      throw duplicateAt(rows, cause);
    }
  }

  async function remove(input: DeleteInput): Promise<void> {
    if (input.kind === 'tuples') {
      const rows = input.tuples.map(rowOf);
      if (rows.length === 0) return;
      try {
        await evalScript(
          DELETE,
          [`${prefix}:all`],
          [prefix, 'tuples', JSON.stringify(rows)],
        );
      } catch (cause) {
        throw asStoreError(cause);
      }
      return;
    }

    if (input.kind === 'filter') {
      const { groups, keys } = groupsFor(input.query, prefix);
      try {
        await evalScript(DELETE, keys, [prefix, 'filter', JSON.stringify({ groups })]);
      } catch (cause) {
        throw asStoreError(cause);
      }
      return;
    }

    const { groups, keys } = groupsFor(input.query, prefix);
    const rows = input.tuples.map(rowOf);
    try {
      await evalScript(DELETE, keys, [
        prefix,
        'replace',
        JSON.stringify({ groups, rows }),
      ]);
    } catch (cause) {
      throw duplicateAt(rows, cause);
    }
  }

  return Object.freeze({ capabilities: CAPABILITIES, read, write, delete: remove });
}
