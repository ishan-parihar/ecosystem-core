import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { mintToken, verifyToken, verifyTokenCompat } from './index.js';

const SECRET = 'a-shared-secret-value-at-least-32-chars';

/**
 * Reproduce the hub's signing scheme **independently**, with `node:crypto`.
 *
 * This is the whole point of the legacy branch: if the test used the module's
 * own legacy helper to build its fixtures, it would only prove the helper
 * agrees with itself. `node:crypto` is a different implementation of HMAC, and
 * the hub uses it directly, so a fixture built here is genuinely the artifact
 * the hub produces.
 */
function hubSign(payload: Record<string, unknown>, secret = SECRET): string {
	const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
	const signature = createHmac('sha256', secret).update(payloadB64).digest('base64url');
	return `${payloadB64}.${signature}`;
}

describe('mintToken / verifyToken (canonical)', () => {
	it('round-trips a token', async () => {
		const token = await mintToken(
			{ purpose: 'newsletter_confirm', email: 'a@b.co' },
			{ secret: SECRET, expiresInSec: 60 },
		);
		const result = await verifyToken(token, { secret: SECRET });
		expect(result.valid).toBe(true);
		if (!result.valid) return;
		expect(result.payload.email).toBe('a@b.co');
		expect(result.payload.purpose).toBe('newsletter_confirm');
		expect(result.scheme).toBe('canonical');
	});

	it('carries extra signed claims through', async () => {
		const token = await mintToken(
			{ purpose: 'unsubscribe', email: 'a@b.co', source: 'technical-authority', tags: ['ai'] },
			{ secret: SECRET, expiresInSec: 0 },
		);
		const result = await verifyToken(token, { secret: SECRET });
		expect(result.valid).toBe(true);
		if (!result.valid) return;
		expect(result.payload.source).toBe('technical-authority');
		expect(result.payload.tags).toEqual(['ai']);
	});

	it('omits exp when `expiresInSec` is 0, so the token never expires', async () => {
		const token = await mintToken({ purpose: 'unsubscribe', email: 'a@b.co' }, { secret: SECRET, expiresInSec: 0 });
		const result = await verifyToken(token, { secret: SECRET, nowMs: Date.now() + 10 * 365 * 86_400_000 });
		expect(result.valid).toBe(true);
	});

	it('cannot have `exp` overridden through the payload', async () => {
		const token = await mintToken(
			{ purpose: 'confirm', email: 'a@b.co', exp: 99_999_999_999 },
			{ secret: SECRET, expiresInSec: 60 },
		);
		// The caller-supplied `exp` must be dropped and the option honoured.
		const result = await verifyToken(token, { secret: SECRET, nowMs: Date.now() + 61_000 });
		expect(result.valid).toBe(false);
		if (result.valid) return;
		expect(result.reason).toBe('expired');
	});

	it('rejects a tampered signature', async () => {
		const token = await mintToken({ purpose: 'confirm', email: 'a@b.co' }, { secret: SECRET, expiresInSec: 60 });
		const forged = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
		const result = await verifyToken(forged, { secret: SECRET });
		expect(result.valid).toBe(false);
		if (result.valid) return;
		expect(result.reason).toBe('bad_signature');
	});

	it('rejects a valid signature made with another secret', async () => {
		const token = await mintToken({ purpose: 'confirm', email: 'a@b.co' }, { secret: 'other-secret', expiresInSec: 60 });
		const result = await verifyToken(token, { secret: SECRET });
		expect(result.valid).toBe(false);
	});

	it('rejects a token presented for another purpose', async () => {
		const token = await mintToken({ purpose: 'confirm', email: 'a@b.co' }, { secret: SECRET, expiresInSec: 60 });
		const result = await verifyToken(token, { secret: SECRET, expectedPurpose: 'unsubscribe' });
		expect(result.valid).toBe(false);
		if (result.valid) return;
		expect(result.reason).toBe('wrong_purpose');
	});

	it('enforces expiry', async () => {
		const issuedAt = Date.now();
		const token = await mintToken(
			{ purpose: 'confirm', email: 'a@b.co' },
			{ secret: SECRET, expiresInSec: 60, nowMs: issuedAt },
		);
		expect((await verifyToken(token, { secret: SECRET, nowMs: issuedAt + 30_000 })).valid).toBe(true);
		expect((await verifyToken(token, { secret: SECRET, nowMs: issuedAt + 60_000 })).valid).toBe(false);
	});

	it('rejects malformed input without throwing', async () => {
		for (const bad of ['', 'no-dot', '.', 'a.', '.b', 'not base64!.sig', 'e30=.zz']) {
			const result = await verifyToken(bad, { secret: SECRET });
			expect(result.valid).toBe(false);
		}
	});

	it('refuses to sign with an empty secret', async () => {
		await expect(
			mintToken({ purpose: 'confirm', email: 'a@b.co' }, { secret: '', expiresInSec: 60 }),
		).rejects.toThrow(/secret must not be empty/);
	});
});

describe('cross-scheme compatibility', () => {
	const hubToken = hubSign({ purpose: 'newsletter_unsubscribe', email: 'a@b.co', exp: 0 });

	it('the hub fixture is self-consistent under the hub algorithm', () => {
		// Guards the fixture: if this is wrong, every assertion below is meaningless.
		const payloadB64 = hubToken.split('.')[0] ?? '';
		const expected = createHmac('sha256', SECRET).update(payloadB64).digest('base64url');
		expect(hubToken.split('.')[1]).toBe(expected);
	});

	it('verifyToken REJECTS a hub-minted token, even with the same secret', async () => {
		const result = await verifyToken(hubToken, { secret: SECRET });
		expect(result.valid).toBe(false);
		if (result.valid) return;
		expect(result.reason).toBe('bad_signature');
	});

	it('verifyTokenCompat ACCEPTS a hub-minted token and reports the scheme', async () => {
		const result = await verifyTokenCompat(hubToken, { secret: SECRET });
		expect(result.valid).toBe(true);
		if (!result.valid) return;
		expect(result.scheme).toBe('legacy-base64url');
		expect(result.payload.email).toBe('a@b.co');
		expect(result.payload.purpose).toBe('newsletter_unsubscribe');
	});

	it('verifyTokenCompat reads the short field aliases ({ p, e, x })', async () => {
		const legacy = hubSign({ p: 'schedule-manage', e: 'guest@example.com', x: 0 });
		const result = await verifyTokenCompat(legacy, { secret: SECRET, expectedPurpose: 'schedule-manage' });
		expect(result.valid).toBe(true);
		if (!result.valid) return;
		expect(result.payload.purpose).toBe('schedule-manage');
		expect(result.payload.email).toBe('guest@example.com');
		expect(result.scheme).toBe('legacy-base64url');
	});

	it('treats `exp: 0` as never-expiring, which is the hub convention', async () => {
		// The hub writes `exp: 0` explicitly for links that must stay actionable,
		// and unsubscribe relies on it. Reading a zero as an absolute timestamp
		// marks every such link expired, so this is the compliance-critical case.
		const token = hubSign({ purpose: 'newsletter_unsubscribe', email: 'a@b.co', exp: 0 });
		const farFuture = Date.now() + 10 * 365 * 86_400_000;
		const result = await verifyTokenCompat(token, { secret: SECRET, nowMs: farFuture });
		expect(result.valid).toBe(true);
		if (!result.valid) return;
		expect(result.payload.email).toBe('a@b.co');
	});

	it('treats `x: 0` as never-expiring on a legacy short-field token', async () => {
		const token = hubSign({ p: 'schedule-manage', e: 'guest@example.com', x: 0 });
		const result = await verifyTokenCompat(token, {
			secret: SECRET,
			expectedPurpose: 'schedule-manage',
			nowMs: Date.now() + 10 * 365 * 86_400_000,
		});
		expect(result.valid).toBe(true);
	});

	it('honours `x` as an expiry on a legacy token', async () => {
		const issuedAt = Math.floor(Date.now() / 1000);
		const live = hubSign({ p: 'confirm', e: 'a@b.co', x: issuedAt + 3600 });
		const dead = hubSign({ p: 'confirm', e: 'a@b.co', x: issuedAt - 1 });
		expect((await verifyTokenCompat(live, { secret: SECRET })).valid).toBe(true);

		const expired = await verifyTokenCompat(dead, { secret: SECRET });
		expect(expired.valid).toBe(false);
		if (expired.valid) return;
		expect(expired.reason).toBe('expired');
	});

	it('still enforces purpose on the legacy branch', async () => {
		const result = await verifyTokenCompat(hubToken, { secret: SECRET, expectedPurpose: 'newsletter_confirm' });
		expect(result.valid).toBe(false);
		if (result.valid) return;
		expect(result.reason).toBe('wrong_purpose');
	});

	it('rejects a legacy token signed with another secret', async () => {
		const foreign = hubSign({ purpose: 'confirm', email: 'a@b.co' }, 'a-different-secret');
		const result = await verifyTokenCompat(foreign, { secret: SECRET });
		expect(result.valid).toBe(false);
	});

	it('reports `canonical` for a canonical token, so the legacy count can reach zero', async () => {
		const token = await mintToken({ purpose: 'confirm', email: 'a@b.co' }, { secret: SECRET, expiresInSec: 60 });
		const result = await verifyTokenCompat(token, { secret: SECRET });
		expect(result.valid).toBe(true);
		if (!result.valid) return;
		expect(result.scheme).toBe('canonical');
	});

	it('`acceptLegacy: false` narrows the verifier back to canonical only', async () => {
		const result = await verifyTokenCompat(hubToken, { secret: SECRET, acceptLegacy: false });
		expect(result.valid).toBe(false);
		if (result.valid) return;
		expect(result.reason).toBe('bad_signature');
	});

	it('accepts a canonical token and a legacy token side by side, which is what migration requires', async () => {
		const canonical = await mintToken({ purpose: 'newsletter_unsubscribe', email: 'new@b.co' }, { secret: SECRET, expiresInSec: 0 });
		const old = hubSign({ purpose: 'newsletter_unsubscribe', email: 'old@b.co', exp: 0 });

		const a = await verifyTokenCompat(canonical, { secret: SECRET });
		const b = await verifyTokenCompat(old, { secret: SECRET });
		expect(a.valid && b.valid).toBe(true);
		if (!a.valid || !b.valid) return;
		expect([a.scheme, b.scheme]).toEqual(['canonical', 'legacy-base64url']);
		expect([a.payload.email, b.payload.email]).toEqual(['new@b.co', 'old@b.co']);
	});
});
