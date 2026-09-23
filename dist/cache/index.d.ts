/**
 * Cache stores.
 *
 * Two backends behind one interface, because the Worker and the developer
 * machine need different answers to the same question:
 *
 * - **KV** is the real one. It survives isolate recycling and is shared across
 *   every isolate serving a surface, which is exactly what a rate limiter and a
 *   cached page fragment need and what an in-isolate `Map` cannot provide.
 * - **Memory** is the fallback. It works with no binding at all, so `vite dev`,
 *   a unit test and a preview deployment behave like production in shape even
 *   when they cannot behave like it in scale.
 *
 * ## Why this is not a singleton
 *
 * The hub's original implementation held a module-level instance keyed on the KV
 * binding, with a guard to rebuild it when the binding appeared later. That is a
 * violation of the injection contract: a Cloudflare binding lives on
 * `event.platform.env` and is per request, so a module-level holder either
 * pins the first request's binding or needs the guard that led to the bug it
 * was working around.
 *
 * `createCache` therefore returns a store, and the consumer decides how long to
 * hold it. The application already does this for the rate limiter: one instance
 * per isolate, constructed in the application's own module. Keeping that
 * decision in the application is what lets the same package serve a Worker, a
 * Node CLI and a test.
 */
import { type Logger } from '../internal/logger.js';
/** The subset of the Cloudflare KV binding this module needs. Structural, so no `@cloudflare/workers-types` dependency. */
export interface KvNamespaceLike {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: {
        expirationTtl?: number;
    }): Promise<void>;
    delete(key: string): Promise<void>;
}
export interface CacheStore {
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
    delete(key: string): Promise<void>;
}
export interface MemoryCacheOptions {
    maxEntries?: number;
    logger?: Logger;
}
/**
 * An in-isolate cache with TTL and bounded size.
 *
 * `maxEntries` matters more than it looks. A Worker isolate is long-lived
 * enough to serve many thousands of requests, so an unbounded map keyed by
 * client IP or by a user-supplied string is a memory leak that only shows up
 * under traffic. Eviction is oldest-first, which is the right policy for the
 * burst-throttling and short-lived-fragment work this serves.
 */
export declare class MemoryCache implements CacheStore {
    private readonly entries;
    private readonly maxEntries;
    private readonly logger;
    private sequence;
    constructor(options?: MemoryCacheOptions);
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
    delete(key: string): Promise<void>;
    /** Remove expired entries. Call from a cron route, not per request. */
    sweep(): number;
    /** Current entry count. For tests and diagnostics. */
    get size(): number;
    private evictIfNeeded;
}
export interface KvCacheOptions {
    kv: KvNamespaceLike;
    keyPrefix?: string;
    logger?: Logger;
}
/**
 * A cache over Cloudflare KV.
 *
 * Failures are logged and swallowed, never thrown. A cache is an optimisation:
 * a request that could have been served from KV must still be served when KV is
 * down, and turning a cache outage into an endpoint outage is the one failure
 * mode a cache must not introduce. The caller sees a miss.
 */
export declare class KvCache implements CacheStore {
    private readonly kv;
    private readonly keyPrefix;
    private readonly logger;
    constructor(options: KvCacheOptions);
    private key;
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
    delete(key: string): Promise<void>;
}
export type CacheBackend = 'kv' | 'memory';
export interface CacheOptions {
    /** `auto` picks KV when a binding is injected, memory otherwise. Default: `auto`. */
    backend?: CacheBackend | 'auto';
    kv?: KvNamespaceLike | null;
    keyPrefix?: string;
    /** Bound on the memory backend. Ignored by KV. */
    maxEntries?: number;
    logger?: Logger;
}
/** What the caller actually got, so a surface can log or assert its real backend. */
export interface ResolvedCache {
    store: CacheStore;
    backend: CacheBackend;
    /** Why the requested backend could not be used, when it could not be. */
    degradedReason?: string;
}
/**
 * Resolve a cache for the current request.
 *
 * Returns the pair rather than the store alone because "which backend am I
 * actually on" is the question that answers most cache bugs, and inferring it
 * from the outside is not possible once the store is behind an interface.
 */
export declare function resolveCache(options: CacheOptions): ResolvedCache;
/**
 * Cache-aside: read, and on a miss run `produce`, store, and return.
 *
 * `produce` is only called on a miss, so a cache that cannot be written to
 * (KV rejected the put, memory is full) still returns the fresh value instead
 * of turning a cache problem into a correctness problem.
 */
export declare function getOrSet<T>(store: CacheStore, key: string, ttlSeconds: number, produce: () => Promise<T>): Promise<T>;
//# sourceMappingURL=index.d.ts.map