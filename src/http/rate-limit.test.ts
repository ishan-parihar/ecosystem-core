import { describe, expect, it, vi } from 'vitest';

import { clientIp, hashIp, InMemoryRateLimiter, verifyTurnstile } from './rate-limit.js';

function clock(start = 1_000_000) {
	let now = start;
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe('InMemoryRateLimiter', () => {
	it('allows up to the limit and then refuses', () => {
		const limiter = new InMemoryRateLimiter();

		expect(limiter.consume('k', 2, 1000).allowed).toBe(true);
		expect(limiter.consume('k', 2, 1000).allowed).toBe(true);
		expect(limiter.consume('k', 2, 1000).allowed).toBe(false);
	});

	it('reports remaining quota counting down to zero', () => {
		const limiter = new InMemoryRateLimiter();

		expect(limiter.consume('k', 3, 1000).remaining).toBe(2);
		expect(limiter.consume('k', 3, 1000).remaining).toBe(1);
		expect(limiter.consume('k', 3, 1000).remaining).toBe(0);
		expect(limiter.consume('k', 3, 1000).remaining).toBe(0);
	});

	it('tracks keys independently', () => {
		const limiter = new InMemoryRateLimiter();

		limiter.consume('a', 1, 1000);
		expect(limiter.consume('a', 1, 1000).allowed).toBe(false);
		expect(limiter.consume('b', 1, 1000).allowed).toBe(true);
	});

	it('resets the window once it has elapsed', () => {
		const c = clock();
		const limiter = new InMemoryRateLimiter({ now: c.now });

		limiter.consume('k', 1, 1000);
		expect(limiter.consume('k', 1, 1000).allowed).toBe(false);

		c.advance(1000);
		expect(limiter.consume('k', 1, 1000).allowed).toBe(true);
	});

	it('never returns a retryAfter below one second', () => {
		const c = clock();
		const limiter = new InMemoryRateLimiter({ now: c.now });

		limiter.consume('k', 1, 1000);
		c.advance(999);
		expect(limiter.consume('k', 1, 1000).retryAfterSec).toBe(1);
	});

	it('reports retryAfter as the time left in the window', () => {
		const c = clock();
		const limiter = new InMemoryRateLimiter({ now: c.now });

		limiter.consume('k', 1, 10_000);
		c.advance(4_000);
		expect(limiter.consume('k', 1, 10_000).retryAfterSec).toBe(6);
	});

	it('reports zero retryAfter on a permitted request', () => {
		const limiter = new InMemoryRateLimiter();
		expect(limiter.consume('k', 5, 1000).retryAfterSec).toBe(0);
	});

	it('evicts expired windows before growing past maxKeys', () => {
		const c = clock();
		const limiter = new InMemoryRateLimiter({ maxKeys: 2, now: c.now });

		limiter.consume('a', 1, 1000);
		limiter.consume('b', 1, 1000);
		// Both windows are stale now, so the next insert can drop them.
		c.advance(2000);
		limiter.consume('c', 1, 1000);
		limiter.consume('d', 1, 1000);

		expect(limiter.size).toBe(2);
	});

	it('drops the map wholesale and warns when eviction cannot keep up', () => {
		const warn = vi.fn();
		const limiter = new InMemoryRateLimiter({ maxKeys: 2, logger: { info: vi.fn(), warn, error: vi.fn() } });

		// All within one window, so none of them is evictable.
		limiter.consume('a', 1, 60_000);
		limiter.consume('b', 1, 60_000);
		limiter.consume('c', 1, 60_000);
		limiter.consume('d', 1, 60_000);

		expect(warn).toHaveBeenCalledWith(
			'Rate limiter map evicted wholesale',
			expect.objectContaining({ maxKeys: 2 }),
		);
	});

	it('clears every window on reset', () => {
		const limiter = new InMemoryRateLimiter();
		limiter.consume('a', 1, 1000);
		limiter.consume('b', 1, 1000);

		limiter.reset();

		expect(limiter.size).toBe(0);
		expect(limiter.consume('a', 1, 1000).allowed).toBe(true);
	});
});

describe('hashIp', () => {
	it('returns null for a missing address rather than a hash of nothing', async () => {
		expect(await hashIp(null, 'salt')).toBeNull();
	});

	it('is stable for the same address and salt', async () => {
		const a = await hashIp('203.0.113.7', 'salt');
		const b = await hashIp('203.0.113.7', 'salt');
		expect(a).toBe(b);
	});

	it('changes when the salt changes, so hashes are not portable across deployments', async () => {
		const a = await hashIp('203.0.113.7', 'salt-one');
		const b = await hashIp('203.0.113.7', 'salt-two');
		expect(a).not.toBe(b);
	});

	it('truncates to 32 hex characters', async () => {
		expect((await hashIp('203.0.113.7', 'salt'))?.length).toBe(32);
	});

	it('does not contain the original address', async () => {
		expect(await hashIp('203.0.113.7', 'salt')).not.toContain('203');
	});
});

describe('clientIp', () => {
	it('prefers the Cloudflare header', () => {
		const request = new Request('https://x.co', {
			headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '10.0.0.1' },
		});
		expect(clientIp(request)).toBe('203.0.113.7');
	});

	it('falls back to the first x-forwarded-for entry', () => {
		const request = new Request('https://x.co', {
			headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
		});
		expect(clientIp(request)).toBe('203.0.113.7');
	});

	it('returns null when neither header is present, as in local dev', () => {
		expect(clientIp(new Request('https://x.co'))).toBeNull();
	});
});

describe('verifyTurnstile', () => {
	it('skips without a secret, so an unconfigured surface is not blocked', async () => {
		const result = await verifyTurnstile({ secretKey: undefined, token: 'x' });
		expect(result).toEqual({ ok: true, skipped: true });
	});

	it('fails when a secret is set and the token is missing', async () => {
		const result = await verifyTurnstile({ secretKey: 's', token: undefined });
		expect(result).toMatchObject({ ok: false, skipped: false, error: 'missing-token' });
	});

	it('passes on a success payload', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true })));
		const result = await verifyTurnstile({ secretKey: 's', token: 't', fetchImpl: fetchImpl as typeof fetch });
		expect(result).toEqual({ ok: true, skipped: false });
	});

	it('fails on a rejection payload', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: false })));
		const result = await verifyTurnstile({ secretKey: 's', token: 't', fetchImpl: fetchImpl as typeof fetch });
		expect(result).toMatchObject({ ok: false, error: 'rejected' });
	});

	it('fails closed on a non-2xx response from Turnstile', async () => {
		const fetchImpl = vi.fn(async () => new Response('nope', { status: 502 }));
		const result = await verifyTurnstile({ secretKey: 's', token: 't', fetchImpl: fetchImpl as typeof fetch });
		expect(result).toMatchObject({ ok: false, error: 'http-502' });
	});

	it('fails open on a transport error, because the limiter is still in the path', async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error('network down');
		});
		const result = await verifyTurnstile({
			secretKey: 's',
			token: 't',
			fetchImpl: fetchImpl as typeof fetch,
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		});
		expect(result).toMatchObject({ ok: true, error: 'transport-error' });
	});

	it('posts the secret, the token and the ip as a form body', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true })));
		await verifyTurnstile({
			secretKey: 'my-secret',
			token: 'my-token',
			ip: '203.0.113.7',
			fetchImpl: fetchImpl as typeof fetch,
		});

		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
		const body = new URLSearchParams(String(init.body));
		expect(body.get('secret')).toBe('my-secret');
		expect(body.get('response')).toBe('my-token');
		expect(body.get('remoteip')).toBe('203.0.113.7');
	});
});
