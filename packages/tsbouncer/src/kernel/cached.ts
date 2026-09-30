import type { Cache } from './cache.js';
import { canonicalJson } from './cache.js';
import type {
  Authz,
  CheckOptions,
  CheckRequest,
  Decision,
  GrantInput,
} from './client.js';
import { CacheError } from './errors.js';
import type { DeleteInput, Tuple, TupleStore, WriteMode } from './store.js';

export interface CachedAuthzOptions {
  /**
   * Pass `ttlMs` to every cache write. Requires a cache with the `ttl`
   * capability — otherwise the bound is silently absent, which is exactly the
   * staleness bug this option exists to prevent.
   */
  readonly ttlMs?: number;
  /**
   * Required. Namespaces memo entries (`<namespace>:<resource>:…`), so two
   * applications sharing one cache backend can never read each other's
   * decisions — identical keys under different models would otherwise answer
   * from the wrong graph. Version it with the model (`docs-api-v1`) so a model
   * rollout invalidates by renaming rather than by flushing.
   */
  readonly namespace: string;
}

/**
 * Memoize `can`/`check` through a `Cache`, returning an `Authz`.
 *
 * Hits serve validated values only: a boolean for `can`, an
 * `{allowed, truncated}` object for `check`. Anything else — a miss, a corrupt
 * entry, a throwing backend — falls through to evaluation, so a broken cache
 * costs latency, never correctness. A cached denial stays a denial, including
 * a cached `truncated` one, which the evaluator could only ever produce as
 * not-allowed.
 *
 * Every mutation invalidates by resource: grants name theirs, writes name
 * each tuple's, deletes name what their scope names. A scope without one
 * concrete resource string — an absent filter field, or an array-valued one —
 * clears the whole namespace instead of guessing.
 * If invalidation itself fails, caching disables itself from then on rather
 * than risk serving a stale allow: reads go straight to the engine, writes
 * skip invalidation, and nothing throws. A grant that landed must never report
 * itself as failed because the cache blinked.
 *
 * `explain`, `expand`, and the list queries are not memoized — trees and sets
 * are the debugging surface, and caching them would trade the thing being
 * debugged for speed. `withStore` drops the layer entirely: transactional
 * reads must never hit a cache shared with committed state.
 */
export function withCache(
  authz: Authz,
  cache: Cache,
  options: CachedAuthzOptions,
): Authz {
  if (typeof options.namespace !== 'string' || options.namespace.length === 0) {
    throw new CacheError('withCache requires a non-empty namespace');
  }
  if (options.ttlMs !== undefined && !cache.capabilities.ttl) {
    throw new CacheError('withCache was given ttlMs, but the cache has no ttl support');
  }
  const namespace = options.namespace;
  const ttlMs = options.ttlMs;
  let broken = false;

  const keyFor = (
    subject: string,
    permission: string,
    resource: string,
    context: unknown,
  ): string =>
    `${namespace}:${resource}:${permission}:${subject}:${canonicalJson(context ?? null)}`;

  const prefixFor = (resource: string): string => `${namespace}:${resource}:`;

  async function invalidate(resources: readonly (string | undefined)[]): Promise<void> {
    if (broken) return;
    try {
      if (resources.some((resource) => resource === undefined)) {
        await cache.clear(`${namespace}:`);
        return;
      }
      const distinct = [...new Set(resources as readonly string[])];
      await Promise.all(distinct.map((resource) => cache.clear(prefixFor(resource))));
    } catch {
      broken = true;
    }
  }

  function resourceOf(query: { readonly resource?: unknown }): string | undefined {
    return typeof query.resource === 'string' ? query.resource : undefined;
  }

  async function recall(key: string): Promise<unknown> {
    if (broken) return undefined;
    try {
      return await cache.get(key);
    } catch {
      return undefined;
    }
  }

  async function remember(key: string, value: unknown): Promise<void> {
    if (broken) return;
    try {
      await cache.set(key, value, ttlMs === undefined ? undefined : { ttlMs });
    } catch {
      // A memo that cannot persist is a miss next time, not an error now.
    }
  }

  async function can(
    subject: string,
    permission: string,
    resource: string,
    options?: CheckOptions,
  ): Promise<boolean> {
    const key = keyFor(subject, permission, resource, options?.context);
    const hit = await recall(key);
    if (typeof hit === 'boolean') return hit;
    const allowed = await authz.can(subject, permission, resource, options);
    await remember(key, allowed);
    return allowed;
  }

  async function check(request: CheckRequest, options?: CheckOptions): Promise<Decision> {
    const key = keyFor(
      request.subject,
      request.permission,
      request.resource,
      options?.context,
    );
    const hit = await recall(key);
    if (
      typeof hit === 'object' &&
      hit !== null &&
      typeof (hit as { allowed?: unknown }).allowed === 'boolean' &&
      typeof (hit as { truncated?: unknown }).truncated === 'boolean'
    ) {
      return {
        allowed: (hit as { allowed: boolean }).allowed,
        subject: request.subject,
        permission: request.permission,
        resource: request.resource,
        truncated: (hit as { truncated: boolean }).truncated,
      };
    }
    const decision = await authz.check(request, options);
    await remember(key, { allowed: decision.allowed, truncated: decision.truncated });
    return decision;
  }

  async function grant(input: GrantInput): Promise<void> {
    await authz.grant(input);
    await invalidate([input.resource]);
  }

  async function revoke(input: GrantInput): Promise<void> {
    await authz.revoke(input);
    await invalidate([input.resource]);
  }

  async function write(tuples: readonly Tuple[], mode?: WriteMode): Promise<void> {
    await authz.write(tuples, mode);
    await invalidate(tuples.map((tuple) => tuple.resource));
  }

  async function remove(input: DeleteInput): Promise<void> {
    await authz.delete(input);
    if (input.kind === 'tuples') {
      await invalidate(input.tuples.map((tuple) => tuple.resource));
      return;
    }
    const scoped = resourceOf(input.query);
    if (input.kind === 'filter') {
      await invalidate(scoped === undefined ? [undefined] : [scoped]);
      return;
    }
    const targets: (string | undefined)[] = scoped === undefined ? [undefined] : [scoped];
    for (const tuple of input.tuples) targets.push(tuple.resource);
    await invalidate(targets);
  }

  return Object.freeze({
    ...authz,
    can,
    check,
    grant,
    revoke,
    write,
    delete: remove,
    withStore(store: TupleStore): Authz {
      return authz.withStore(store);
    },
  });
}
