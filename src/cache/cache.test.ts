import { describe, expect, it, vi } from 'vitest';

import { getOrSet, KvCache, MemoryCache, resolveCache, type KvNamespaceLike } from './index.js';

/** An in-memory stand-in for the Cloudflare KV binding, recording what was written. */
function fakeKv(options: { failGet?: boolean; failPut?: boolean } = {}) {
	const store = new Map<string, string>();
	const puts: Array<{ key: string; options: { expirationTtl?: number } | undefined }> = [];
	const kv: KvNamespaceLike = {
		async get(key) {
			if (options.failGet === true) throw new Error('kv get exploded');
			return store.get(key) ?? null;
		},
		async put(key, value, putOptions) {
			if (options.failPut === true) throw new Error('kv put exploded');
			store.set(key, value);
			puts.push({ key, options: putOptions });
		},
		async delete(key) {
			store.delete(key);
		},
	};
	return { kv, store, puts };
}

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('MemoryCache', () => {
	it('round-trips a value', async () => {
		const cache = new MemoryCache({ logger: silent });
		await cache.set('k', { a: 1 }, 60);
		expect(await cache.get<{ a: number }>('k')).toEqual({ a: 1 });
	});

	it('returns null for a miss', async () => {
		const cache = new MemoryCache({ logger: silent });
		expect(await cache.get('absent')).toBeNull();
	});

	it('deletes', async () => {
		const cache = new MemoryCache({ logger: silent });
		await cache.set('k', 1, 60);
		await cache.delete('k');
		expect(await cache.get('k')).toBeNull();
	});

	it('expires after the ttl', async () => {
		vi.useFakeTimers();
		try {
			const cache = new MemoryCache({ logger: silent });
			await cache.set('k', 'v', 10);
			vi.advanceTimersByTime(9_000);
			expect(await cache.get('k')).toBe('v');
			vi.advanceTimersByTime(2_000);
			expect(await cache.get('k')).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it('treats ttl 0 as never expiring', async () => {
		vi.useFakeTimers();
		try {
			const cache = new MemoryCache({ logger: silent });
			await cache.set('k', 'v', 0);
			vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000);
			expect(await cache.get('k')).toBe('v');
		} finally {
			vi.useRealTimers();
		}
	});

	it('bounds memory by evicting the oldest entry first', async () => {
		// A Worker isolate serves many thousands of requests, so an unbounded map
		// keyed by client IP is a leak that only appears under real traffic.
		const cache = new MemoryCache({ maxEntries: 3, logger: silent });
		for (const key of ['a', 'b', 'c']) await cache.set(key, key, 60);
		await cache.set('d', 'd', 60);
		expect(cache.size).toBe(3);
		expect(await cache.get('a')).toBeNull();
		expect(await cache.get('d')).toBe('d');
	});

	it('sweeps expired entries and reports the count', async () => {
		vi.useFakeTimers();
		try {
			const cache = new MemoryCache({ logger: silent });
			await cache.set('live', 1, 100);
			await cache.set('dead', 2, 5);
			await cache.set('forever', 3, 0);
			vi.advanceTimersByTime(10_000);
			expect(cache.sweep()).toBe(1);
			expect(cache.size).toBe(2);
			expect(await cache.get('forever')).toBe(3);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('KvCache', () => {
	it('round-trips through the binding with a key prefix', async () => {
		const { kv, store } = fakeKv();
		const cache = new KvCache({ kv, keyPrefix: 'rl:', logger: silent });
		await cache.set('ip:1', { count: 2 }, 120);
		expect(store.has('rl:ip:1')).toBe(true);
		expect(await cache.get<{ count: number }>('ip:1')).toEqual({ count: 2 });
	});

	it('rounds a sub-60s ttl up, because KV rejects anything lower', async () => {
		const { kv, puts } = fakeKv();
		const cache = new KvCache({ kv, logger: silent });
		await cache.set('k', 'v', 30);
		expect(puts[0]?.options?.expirationTtl).toBe(60);
	});

	it('omits the ttl entirely for a never-expiring entry', async () => {
		const { kv, puts } = fakeKv();
		const cache = new KvCache({ kv, logger: silent });
		await cache.set('k', 'v', 0);
		expect(puts[0]?.options).toEqual({});
	});

	it('returns null instead of throwing when the binding read fails', async () => {
		// A cache outage must not become an endpoint outage.
		const { kv } = fakeKv({ failGet: true });
		const cache = new KvCache({ kv, logger: silent });
		await expect(cache.get('k')).resolves.toBeNull();
	});

	it('swallows a failed write and logs it', async () => {
		const { kv } = fakeKv({ failPut: true });
		const warn = vi.fn();
		const cache = new KvCache({ kv, logger: { ...silent, warn } });
		await expect(cache.set('k', 'v', 60)).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledWith('Cache write failed', expect.objectContaining({ key: 'cache:k' }));
	});

	it('returns null on unparseable stored JSON rather than throwing', async () => {
		const { kv, store } = fakeKv();
		store.set('cache:k', 'not json');
		const cache = new KvCache({ kv, logger: silent });
		expect(await cache.get('k')).toBeNull();
	});
});

describe('resolveCache', () => {
	it('uses KV under `auto` when a binding is present', () => {
		const { kv } = fakeKv();
		const resolved = resolveCache({ kv, logger: silent });
		expect(resolved.backend).toBe('kv');
		expect(resolved.store).toBeInstanceOf(KvCache);
	});

	it('uses memory under `auto` with no binding', () => {
		const resolved = resolveCache({ logger: silent });
		expect(resolved.backend).toBe('memory');
		expect(resolved.store).toBeInstanceOf(MemoryCache);
	});

	it('degrades loudly when KV is required but absent, and says why', () => {
		const warn = vi.fn();
		const resolved = resolveCache({ backend: 'kv', kv: null, logger: { ...silent, warn } });
		expect(resolved.backend).toBe('memory');
		expect(resolved.degradedReason).toBe('kv-backend-without-binding');
		expect(warn).toHaveBeenCalled();
	});

	it('honours an explicit memory backend even when a binding exists', () => {
		const { kv } = fakeKv();
		expect(resolveCache({ backend: 'memory', kv, logger: silent }).backend).toBe('memory');
	});
});

describe('getOrSet', () => {
	it('calls the producer once and serves the rest from cache', async () => {
		const cache = new MemoryCache({ logger: silent });
		const produce = vi.fn(async () => ({ value: 7 }));
		expect(await getOrSet(cache, 'k', 60, produce)).toEqual({ value: 7 });
		expect(await getOrSet(cache, 'k', 60, produce)).toEqual({ value: 7 });
		expect(produce).toHaveBeenCalledTimes(1);
	});

	it('returns the fresh value even when the store cannot be written to', async () => {
		const { kv } = fakeKv({ failPut: true });
		const cache = new KvCache({ kv, logger: silent });
		expect(await getOrSet(cache, 'k', 60, async () => 'fresh')).toBe('fresh');
	});

	it('does not cache a null the producer returned', async () => {
		// `null` is the miss sentinel, so a legitimately empty result is produced
		// again rather than being indistinguishable from an absent entry.
		const cache = new MemoryCache({ logger: silent });
		const produce = vi.fn(async () => null as string | null);
		await getOrSet(cache, 'k', 60, produce);
		await getOrSet(cache, 'k', 60, produce);
		expect(produce).toHaveBeenCalledTimes(2);
	});
});
