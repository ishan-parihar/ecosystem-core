import { describe, expect, it, vi } from 'vitest';

import { MemoryCache, type CacheStore, type KvNamespaceLike } from '../cache/index.js';
import {
	createRateLimiter,
	FixedWindowRateLimiter,
	RATE_LIMIT_POLICIES,
	resolvePolicy,
	retryAfterHeader,
} from './rate-limiter.js';

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

function fakeKv() {
	const store = new Map<string, string>();
	const kv: KvNamespaceLike = {
		async get(key) {
			return store.get(key) ?? null;
		},
		async put(key, value) {
			store.set(key, value);
		},
		async delete(key) {
			store.delete(key);
		},
	};
	return { kv, store };
}

/** A store whose reads always fail, to exercise the fail-open path. */
const brokenStore: CacheStore = {
	async get() {
		throw new Error('store is down');
	},
	async set() {
		return undefined;
	},
	async delete() {
		return undefined;
	},
};

describe('FixedWindowRateLimiter', () => {
	it('allows exactly `limit` requests then refuses', async () => {
		const limiter = new FixedWindowRateLimiter({ store: new MemoryCache({ logger: silent }), logger: silent });
		for (let i = 1; i <= 3; i += 1) {
			const result = await limiter.consume('ip', 3, 60_000);
			expect(result.allowed).toBe(true);
			expect(result.remaining).toBe(3 - i);
		}
		const refused = await limiter.consume('ip', 3, 60_000);
		expect(refused.allowed).toBe(false);
		expect(refused.remaining).toBe(0);
		expect(refused.limit).toBe(3);
	});

	it('reports a positive Retry-After on a refusal', async () => {
		const now = 1_000_000;
		const limiter = new FixedWindowRateLimiter({
			store: new MemoryCache({ logger: silent }),
			now: () => now,
			logger: silent,
		});
		await limiter.consume('ip', 1, 60_000);
		const refused = await limiter.consume('ip', 1, 60_000);
		expect(refused.retryAfterSec).toBe(60);
		expect(retryAfterHeader(refused)).toEqual({ 'Retry-After': '60' });
	});

	it('adds no Retry-After when the request was allowed', async () => {
		const limiter = new FixedWindowRateLimiter({ store: new MemoryCache({ logger: silent }), logger: silent });
		expect(retryAfterHeader(await limiter.consume('ip', 1, 60_000))).toEqual({});
	});

	it('opens a fresh window once the previous one has elapsed', async () => {
		let now = 1_000_000;
		const limiter = new FixedWindowRateLimiter({
			store: new MemoryCache({ logger: silent }),
			now: () => now,
			logger: silent,
		});
		await limiter.consume('ip', 1, 60_000);
		expect((await limiter.consume('ip', 1, 60_000)).allowed).toBe(false);
		now += 60_000;
		expect((await limiter.consume('ip', 1, 60_000)).allowed).toBe(true);
	});

	it('keeps keys independent', async () => {
		const limiter = new FixedWindowRateLimiter({ store: new MemoryCache({ logger: silent }), logger: silent });
		await limiter.consume('a', 1, 60_000);
		expect((await limiter.consume('a', 1, 60_000)).allowed).toBe(false);
		expect((await limiter.consume('b', 1, 60_000)).allowed).toBe(true);
	});

	it('fails open, and says so, when the store is unreachable', async () => {
		// A KV outage must not take the write endpoints down with it.
		const warn = vi.fn();
		const limiter = new FixedWindowRateLimiter({ store: brokenStore, logger: { ...silent, warn } });
		const result = await limiter.consume('ip', 1, 60_000);
		expect(result.allowed).toBe(true);
		expect(warn).toHaveBeenCalledWith('Rate limit read failed; allowing the request', expect.anything());
	});

	it('namespaces keys with the prefix, composed with the store\u2019s own', async () => {
		// Two namespaces deliberately: the limiter's so two limiters in one
		// namespace cannot collide, and the cache's so rate-limit counters cannot
		// collide with ordinary cached values. Neither prefix replaces the other.
		const { kv, store } = fakeKv();
		const { KvCache } = await import('../cache/index.js');
		const limiter = new FixedWindowRateLimiter({
			store: new KvCache({ kv, logger: silent }),
			keyPrefix: 'rl:',
			logger: silent,
		});
		await limiter.consume('ip', 1, 60_000);
		expect([...store.keys()]).toEqual(['cache:rl:ip']);
	});
});

describe('cross-isolate behaviour', () => {
	it('the in-memory store cannot share a counter, the KV store can', async () => {
		// This is the difference the durable limiter exists for: a Worker surface
		// runs several isolates, and a counter that lives inside one of them
		// throttles almost nothing.
		const memory = new MemoryCache({ logger: silent });
		const a1 = new FixedWindowRateLimiter({ store: memory, logger: silent });
		const a2 = new FixedWindowRateLimiter({ store: new MemoryCache({ logger: silent }), logger: silent });
		await a1.consume('ip', 1, 60_000);
		// A separate memory cache knows nothing about the first, which is exactly
		// the bug a per-isolate limiter has in production.
		expect((await a2.consume('ip', 1, 60_000)).allowed).toBe(true);

		const { kv } = fakeKv();
		const { KvCache } = await import('../cache/index.js');
		const shared = new KvCache({ kv, logger: silent });
		const b1 = new FixedWindowRateLimiter({ store: shared, logger: silent });
		const b2 = new FixedWindowRateLimiter({ store: new KvCache({ kv, logger: silent }), logger: silent });
		await b1.consume('ip', 1, 60_000);
		expect((await b2.consume('ip', 1, 60_000)).allowed).toBe(false);
	});
});

describe('policies', () => {
	it('exposes a policy for every classified endpoint class', () => {
		expect(Object.keys(RATE_LIMIT_POLICIES)).toEqual(
			expect.arrayContaining([
				'publicForm',
				'newsletterSubscribe',
				'authAttempt',
				'authEmail',
				'campaignSend',
				'apiRead',
				'default',
			]),
		);
	});

	it('resolves a named policy unchanged', () => {
		expect(resolvePolicy('publicForm')).toEqual({ limit: 5, windowMs: 3_600_000 });
	});

	it('applies overrides without forking the table', () => {
		expect(resolvePolicy('publicForm', { limit: 20 })).toEqual({ limit: 20, windowMs: 3_600_000 });
		expect(resolvePolicy('authEmail', { windowMs: 60_000 })).toEqual({ limit: 3, windowMs: 60_000 });
	});

	it('applies the policy in `check`', async () => {
		const limiter = new FixedWindowRateLimiter({ store: new MemoryCache({ logger: silent }), logger: silent });
		for (let i = 0; i < 3; i += 1) {
			expect((await limiter.check('authEmail', 'ip')).allowed).toBe(true);
		}
		expect((await limiter.check('authEmail', 'ip')).allowed).toBe(false);
	});

	it('honours a per-call override in `check`', async () => {
		const limiter = new FixedWindowRateLimiter({ store: new MemoryCache({ logger: silent }), logger: silent });
		expect((await limiter.check('authEmail', 'ip', { limit: 1 })).allowed).toBe(true);
		expect((await limiter.check('authEmail', 'ip', { limit: 1 })).allowed).toBe(false);
	});

	it('keeps the two public write policies independent of each other', async () => {
		const limiter = new FixedWindowRateLimiter({ store: new MemoryCache({ logger: silent }), logger: silent });
		await limiter.check('publicForm', 'contact:ip');
		await limiter.check('publicForm', 'contact:ip');
		await limiter.check('publicForm', 'contact:ip');
		await limiter.check('publicForm', 'contact:ip');
		await limiter.check('publicForm', 'contact:ip');
		expect((await limiter.check('publicForm', 'contact:ip')).allowed).toBe(false);
		// Exhausting the contact form must not exhaust the newsletter.
		expect((await limiter.check('newsletterSubscribe', 'newsletter:ip')).allowed).toBe(true);
	});
});

describe('createRateLimiter', () => {
	it('resolves memory when no binding is injected', () => {
		const resolved = createRateLimiter({ logger: silent });
		expect(resolved.backend).toBe('memory');
	});

	it('resolves KV when a binding is injected, and the counter is shared', async () => {
		const { kv } = fakeKv();
		const first = createRateLimiter({ kv, logger: silent });
		const second = createRateLimiter({ kv, logger: silent });
		expect(first.backend).toBe('kv');
		await first.limiter.consume('ip', 1, 60_000);
		expect((await second.limiter.consume('ip', 1, 60_000)).allowed).toBe(false);
	});

	it('reports why it degraded', () => {
		const resolved = createRateLimiter({ backend: 'kv', kv: null, logger: silent });
		expect(resolved.backend).toBe('memory');
		expect(resolved.degradedReason).toBe('kv-backend-without-binding');
	});
});
