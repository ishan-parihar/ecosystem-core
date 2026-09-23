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

import { resolveLogger, type Logger } from '../internal/logger.js';

/** The subset of the Cloudflare KV binding this module needs. Structural, so no `@cloudflare/workers-types` dependency. */
export interface KvNamespaceLike {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
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

interface MemoryEntry {
	value: unknown;
	/** Absolute expiry in milliseconds. `0` means never. */
	expiresAtMs: number;
	/** Insertion order, for eviction. */
	seq: number;
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
export class MemoryCache implements CacheStore {
	private readonly entries = new Map<string, MemoryEntry>();
	private readonly maxEntries: number;
	private readonly logger: Logger;
	private sequence = 0;

	constructor(options: MemoryCacheOptions = {}) {
		this.maxEntries = options.maxEntries ?? 5_000;
		this.logger = resolveLogger(options.logger);
	}

	async get<T>(key: string): Promise<T | null> {
		const entry = this.entries.get(key);
		if (entry === undefined) return null;
		if (entry.expiresAtMs > 0 && Date.now() >= entry.expiresAtMs) {
			this.entries.delete(key);
			return null;
		}
		return entry.value as T;
	}

	async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
		this.sequence += 1;
		this.entries.set(key, {
			value,
			expiresAtMs: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0,
			seq: this.sequence,
		});
		this.evictIfNeeded();
	}

	async delete(key: string): Promise<void> {
		this.entries.delete(key);
	}

	/** Remove expired entries. Call from a cron route, not per request. */
	sweep(): number {
		const now = Date.now();
		let removed = 0;
		for (const [key, entry] of this.entries) {
			if (entry.expiresAtMs > 0 && now >= entry.expiresAtMs) {
				this.entries.delete(key);
				removed += 1;
			}
		}
		this.logger.info('Cache sweep complete', { removed, size: this.entries.size });
		return removed;
	}

	/** Current entry count. For tests and diagnostics. */
	get size(): number {
		return this.entries.size;
	}

	private evictIfNeeded(): void {
		while (this.entries.size > this.maxEntries) {
			// Map iteration is insertion-ordered, so the first key is the oldest.
			const oldest = this.entries.keys().next();
			if (oldest.done === true) return;
			this.entries.delete(oldest.value);
		}
	}
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
export class KvCache implements CacheStore {
	private readonly kv: KvNamespaceLike;
	private readonly keyPrefix: string;
	private readonly logger: Logger;

	constructor(options: KvCacheOptions) {
		this.kv = options.kv;
		this.keyPrefix = options.keyPrefix ?? 'cache:';
		this.logger = resolveLogger(options.logger);
	}

	private key(key: string): string {
		return `${this.keyPrefix}${key}`;
	}

	async get<T>(key: string): Promise<T | null> {
		const full = this.key(key);
		try {
			const raw = await this.kv.get(full);
			if (raw === null) return null;
			return JSON.parse(raw) as T;
		} catch (error) {
			this.logger.warn('Cache read failed', { key: full, error: String(error) });
			return null;
		}
	}

	async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
		const full = this.key(key);
		try {
			// KV rejects a TTL below 60 seconds, so a shorter request is rounded up
			// rather than rejected. A caller asking for 30s gets 60s of staleness,
			// which is strictly better than an exception at the call site.
			const ttl = ttlSeconds > 0 ? Math.max(60, Math.ceil(ttlSeconds)) : undefined;
			await this.kv.put(full, JSON.stringify(value), ttl === undefined ? {} : { expirationTtl: ttl });
		} catch (error) {
			this.logger.warn('Cache write failed', { key: full, error: String(error) });
		}
	}

	async delete(key: string): Promise<void> {
		const full = this.key(key);
		try {
			await this.kv.delete(full);
		} catch (error) {
			this.logger.warn('Cache delete failed', { key: full, error: String(error) });
		}
	}
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
export function resolveCache(options: CacheOptions): ResolvedCache {
	const backend = options.backend ?? 'auto';
	const logger = resolveLogger(options.logger);

	if (backend === 'memory') {
		return { store: new MemoryCache({ ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }), logger }), backend: 'memory' };
	}

	if (backend === 'kv' && !options.kv) {
		// Explicitly requested and unavailable: fall back, but say so. Silent
		// degradation to a weaker backend is how a rate limiter becomes decorative.
		logger.warn('KV cache requested but no binding was injected; using memory', {
			keyPrefix: options.keyPrefix,
		});
		return {
			store: new MemoryCache({ ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }), logger }),
			backend: 'memory',
			degradedReason: 'kv-backend-without-binding',
		};
	}

	if (options.kv) {
		return {
			store: new KvCache({
				kv: options.kv,
				...(options.keyPrefix === undefined ? {} : { keyPrefix: options.keyPrefix }),
				logger,
			}),
			backend: 'kv',
		};
	}

	return { store: new MemoryCache({ ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }), logger }), backend: 'memory' };
}

/**
 * Cache-aside: read, and on a miss run `produce`, store, and return.
 *
 * `produce` is only called on a miss, so a cache that cannot be written to
 * (KV rejected the put, memory is full) still returns the fresh value instead
 * of turning a cache problem into a correctness problem.
 */
export async function getOrSet<T>(
	store: CacheStore,
	key: string,
	ttlSeconds: number,
	produce: () => Promise<T>,
): Promise<T> {
	const cached = await store.get<T>(key);
	if (cached !== null) return cached;
	const value = await produce();
	await store.set(key, value, ttlSeconds);
	return value;
}
