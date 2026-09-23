import { describe, expect, it } from 'vitest';

import { encodeBase64Url, utf8Encode } from '../internal/base64.js';
import { mintToken, verifyToken } from './tokens.js';
import { SubscriberInputError, SubscriberStore, TOKEN_PURPOSE_CONFIRM } from './store.js';
import type {
	SubscriberInsert,
	SubscriberPatch,
	SubscriberQuery,
	SubscriberRecord,
	SubscriberTable,
} from './types.js';

const SECRET = 'test-secret-that-is-long-enough-for-hmac';

/* -------------------------------------------------------------------------- */
/* In-memory table                                                            */
/* -------------------------------------------------------------------------- */

class MemoryTable implements SubscriberTable {
	rows: SubscriberRecord[] = [];
	private sequence = 0;

	async findByEmail(email: string): Promise<SubscriberRecord | null> {
		return this.rows.find((row) => row.email === email) ?? null;
	}

	async insert(row: SubscriberInsert): Promise<SubscriberRecord> {
		this.sequence += 1;
		const record: SubscriberRecord = {
			id: `row-${this.sequence}`,
			email: row.email,
			first_name: row.first_name ?? null,
			last_name: row.last_name ?? null,
			status: row.status,
			source: row.source ?? null,
			subscription_type: row.subscription_type ?? null,
			tags: row.tags ?? [],
			interests: row.interests ?? [],
			domain_interests: row.domain_interests ?? [],
			lead_magnet: row.lead_magnet ?? null,
			lead_score: 0,
			created_at: row.created_at,
			updated_at: row.updated_at,
			unsubscribed_at: null,
			confirmed_at: null,
		};
		this.rows.push(record);
		return record;
	}

	async updateById(id: string, patch: SubscriberPatch): Promise<SubscriberRecord | null> {
		const index = this.rows.findIndex((row) => row.id === id);
		if (index === -1) return null;
		const current = this.rows[index];
		if (!current) return null;
		const next: SubscriberRecord = { ...current, ...patch } as SubscriberRecord;
		this.rows[index] = next;
		return next;
	}

	async updateByEmail(email: string, patch: SubscriberPatch): Promise<SubscriberRecord | null> {
		const row = await this.findByEmail(email);
		return row ? this.updateById(row.id, patch) : null;
	}

	async list(query: SubscriberQuery): Promise<{ rows: SubscriberRecord[]; total: number | null }> {
		let rows = [...this.rows];
		if (query.status && query.status !== 'all') rows = rows.filter((r) => r.status === query.status);
		if (query.source) rows = rows.filter((r) => r.source === query.source);
		if (query.search) rows = rows.filter((r) => r.email.includes(query.search ?? ''));
		const offset = query.offset ?? 0;
		const limit = query.limit ?? 50;
		return { rows: rows.slice(offset, offset + limit), total: rows.length };
	}

	async countActive(source?: string): Promise<number> {
		return this.rows.filter((r) => r.status === 'active' && (!source || r.source === source)).length;
	}
}

function makeStore(overrides?: { now?: () => number }) {
	const table = new MemoryTable();
	const store = new SubscriberStore(table, {
		tokenSecret: SECRET,
		confirmTtlSec: 7 * 24 * 60 * 60,
		unsubscribeTtlSec: 0,
		siteUrl: 'https://example.test',
		defaultSource: 'technical-authority',
		defaultSubscriptionType: 'general',
		...(overrides?.now ? { now: overrides.now } : {}),
	});
	return { table, store };
}

/* -------------------------------------------------------------------------- */
/* Tokens                                                                     */
/* -------------------------------------------------------------------------- */

describe('token mint and verify', () => {
	it('round-trips a payload', async () => {
		const token = await mintToken(
			{ purpose: 'newsletter_confirm', email: 'a@b.co' },
			{ secret: SECRET, expiresInSec: 60 },
		);
		const result = await verifyToken(token, { secret: SECRET });
		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.payload.email).toBe('a@b.co');
			expect(result.payload.purpose).toBe('newsletter_confirm');
			expect(typeof result.payload.exp).toBe('number');
		}
	});

	it('rejects a token minted for another purpose', async () => {
		const token = await mintToken(
			{ purpose: 'newsletter_unsubscribe', email: 'a@b.co' },
			{ secret: SECRET, expiresInSec: 0 },
		);
		const result = await verifyToken(token, { secret: SECRET, expectedPurpose: TOKEN_PURPOSE_CONFIRM });
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.reason).toBe('wrong_purpose');
	});

	it('rejects a tampered payload', async () => {
		const token = await mintToken(
			{ purpose: 'newsletter_confirm', email: 'a@b.co' },
			{ secret: SECRET, expiresInSec: 0 },
		);
		const forged = encodeBase64Url(
			utf8Encode(JSON.stringify({ purpose: 'newsletter_confirm', email: 'evil@b.co' })),
		);
		const signature = token.split('.')[1];
		const result = await verifyToken(`${forged}.${signature}`, { secret: SECRET });
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.reason).toBe('bad_signature');
	});

	it('rejects a token signed with another secret', async () => {
		const token = await mintToken(
			{ purpose: 'newsletter_confirm', email: 'a@b.co' },
			{ secret: 'a-completely-different-secret-value' },
		);
		const result = await verifyToken(token, { secret: SECRET });
		expect(result.valid).toBe(false);
	});

	it('expires a token once its lifetime passes', async () => {
		const issuedAt = 1_700_000_000_000;
		const token = await mintToken(
			{ purpose: 'newsletter_confirm', email: 'a@b.co' },
			{ secret: SECRET, expiresInSec: 60, nowMs: issuedAt },
		);
		const stillValid = await verifyToken(token, { secret: SECRET, nowMs: issuedAt + 30_000 });
		expect(stillValid.valid).toBe(true);

		const expired = await verifyToken(token, { secret: SECRET, nowMs: issuedAt + 61_000 });
		expect(expired.valid).toBe(false);
		if (!expired.valid) expect(expired.reason).toBe('expired');
	});

	it('never expires a zero-TTL token', async () => {
		const token = await mintToken(
			{ purpose: 'newsletter_unsubscribe', email: 'a@b.co' },
			{ secret: SECRET, expiresInSec: 0, nowMs: 0 },
		);
		const result = await verifyToken(token, { secret: SECRET, nowMs: Date.now() + 10 * 365 * 864e5 });
		expect(result.valid).toBe(true);
	});

	it.each(['', 'no-dot', 'a.b.c', '!!!.@@@'])('rejects malformed input %j', async (input) => {
		const result = await verifyToken(input, { secret: SECRET });
		expect(result.valid).toBe(false);
	});
});

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

describe('SubscriberStore.subscribe', () => {
	it('inserts a new address as pending_confirmation with the surface source', async () => {
		const { store, table } = makeStore();
		const outcome = await store.subscribe({ email: 'New@Example.com' });
		expect(outcome.kind).toBe('pending_confirmation');
		expect(table.rows).toHaveLength(1);
		expect(table.rows[0]?.email).toBe('new@example.com');
		expect(table.rows[0]?.status).toBe('pending_confirmation');
		expect(table.rows[0]?.source).toBe('technical-authority');
		expect(table.rows[0]?.subscription_type).toBe('general');
	});

	it('returns a confirm URL bound to the address', async () => {
		const { store } = makeStore();
		const outcome = await store.subscribe({ email: 'new@example.com' });
		expect(outcome.kind).toBe('pending_confirmation');
		if (outcome.kind !== 'pending_confirmation') return;
		expect(outcome.confirmUrl.startsWith('https://example.test/newsletter/confirm?token=')).toBe(true);
		expect(outcome.reused).toBe(false);
	});

	it('is idempotent while a confirmation is outstanding', async () => {
		const { store, table } = makeStore();
		await store.subscribe({ email: 'new@example.com' });
		const second = await store.subscribe({ email: 'new@example.com', firstName: 'Ada' });
		expect(second.kind).toBe('pending_confirmation');
		if (second.kind === 'pending_confirmation') expect(second.reused).toBe(true);
		expect(table.rows).toHaveLength(1);
		expect(table.rows[0]?.first_name).toBe('Ada');
	});

	it('reports an already-active subscriber without resetting them', async () => {
		const { store, table } = makeStore();
		await store.subscribe({ email: 'new@example.com' });
		await table.updateByEmail('new@example.com', { status: 'active' });
		const outcome = await store.subscribe({ email: 'new@example.com' });
		expect(outcome.kind).toBe('already_active');
		expect(table.rows[0]?.status).toBe('active');
	});

	it.each(['bounced', 'complained'] as const)(
		'refuses to re-subscribe a %s address',
		async (status) => {
			const { store, table } = makeStore();
			await store.subscribe({ email: 'gone@example.com' });
			await table.updateByEmail('gone@example.com', { status });
			const outcome = await store.subscribe({ email: 'gone@example.com' });
			expect(outcome.kind).toBe('suppressed');
			if (outcome.kind === 'suppressed') expect(outcome.reason).toBe(status);
			expect(table.rows[0]?.status).toBe(status);
		},
	);

	it('re-subscribes a previously unsubscribed address through double opt-in', async () => {
		const { store, table } = makeStore();
		await store.subscribe({ email: 'back@example.com' });
		await table.updateByEmail('back@example.com', {
			status: 'unsubscribed',
			unsubscribed_at: new Date().toISOString(),
		});
		const outcome = await store.subscribe({ email: 'back@example.com' });
		expect(outcome.kind).toBe('pending_confirmation');
		expect(table.rows[0]?.status).toBe('pending_confirmation');
		expect(table.rows[0]?.unsubscribed_at).toBeNull();
	});

	it('rejects a malformed address before touching storage', async () => {
		const { store, table } = makeStore();
		await expect(store.subscribe({ email: 'not-an-email' })).rejects.toBeInstanceOf(
			SubscriberInputError,
		);
		expect(table.rows).toHaveLength(0);
	});
});

describe('SubscriberStore.confirm', () => {
	it('promotes a pending subscriber to active', async () => {
		const { store, table } = makeStore();
		const outcome = await store.subscribe({ email: 'new@example.com' });
		if (outcome.kind !== 'pending_confirmation') throw new Error('expected pending');
		const token = new URL(outcome.confirmUrl).searchParams.get('token');
		const confirmed = await store.confirm(token ?? '');
		expect(confirmed.kind).toBe('confirmed');
		expect(table.rows[0]?.status).toBe('active');
		expect(table.rows[0]?.confirmed_at).not.toBeNull();
	});

	it('is idempotent', async () => {
		const { store } = makeStore();
		const outcome = await store.subscribe({ email: 'new@example.com' });
		if (outcome.kind !== 'pending_confirmation') throw new Error('expected pending');
		const token = new URL(outcome.confirmUrl).searchParams.get('token') ?? '';
		await store.confirm(token);
		expect((await store.confirm(token)).kind).toBe('already_confirmed');
	});

	it('does not resurrect an unsubscribed address from a stale link', async () => {
		const { store, table } = makeStore();
		const outcome = await store.subscribe({ email: 'new@example.com' });
		if (outcome.kind !== 'pending_confirmation') throw new Error('expected pending');
		const token = new URL(outcome.confirmUrl).searchParams.get('token') ?? '';
		await table.updateByEmail('new@example.com', { status: 'unsubscribed' });
		expect((await store.confirm(token)).kind).toBe('not_found');
		expect(table.rows[0]?.status).toBe('unsubscribed');
	});

	it('rejects an unsubscribe token presented as a confirm token', async () => {
		const { store } = makeStore();
		await store.subscribe({ email: 'new@example.com' });
		const unsubscribeUrl = await store.buildUnsubscribeUrl('new@example.com');
		const token = new URL(unsubscribeUrl).searchParams.get('token') ?? '';
		const result = await store.confirm(token);
		expect(result.kind).toBe('invalid_token');
		if (result.kind === 'invalid_token') expect(result.reason).toBe('wrong_purpose');
	});

	it('refuses to confirm once the link has expired', async () => {
		let clock = 1_700_000_000_000;
		const { store } = makeStore({ now: () => clock });
		const outcome = await store.subscribe({ email: 'new@example.com' });
		if (outcome.kind !== 'pending_confirmation') throw new Error('expected pending');
		const token = new URL(outcome.confirmUrl).searchParams.get('token') ?? '';
		clock += 8 * 24 * 60 * 60 * 1000;
		const result = await store.confirm(token);
		expect(result.kind).toBe('invalid_token');
		if (result.kind === 'invalid_token') expect(result.reason).toBe('expired');
	});
});

describe('SubscriberStore.unsubscribe', () => {
	it('unsubscribes from a tokenized link', async () => {
		const { store, table } = makeStore();
		await store.subscribe({ email: 'new@example.com' });
		const url = await store.buildUnsubscribeUrl('new@example.com');
		const token = new URL(url).searchParams.get('token') ?? '';
		const result = await store.unsubscribeWithToken(token);
		expect(result.kind).toBe('unsubscribed');
		expect(table.rows[0]?.status).toBe('unsubscribed');
		expect(table.rows[0]?.unsubscribed_at).not.toBeNull();
	});

	it('is idempotent', async () => {
		const { store } = makeStore();
		await store.subscribe({ email: 'new@example.com' });
		await store.unsubscribe('new@example.com');
		const second = await store.unsubscribe('new@example.com');
		expect(second.kind).toBe('unsubscribed');
		if (second.kind === 'unsubscribed') expect(second.alreadyUnsubscribed).toBe(true);
	});

	it('keeps a bounced address suppressed rather than downgrading it', async () => {
		const { store, table } = makeStore();
		await store.subscribe({ email: 'new@example.com' });
		await store.markUndeliverable('new@example.com', 'bounced');
		await store.unsubscribe('new@example.com');
		expect(table.rows[0]?.status).toBe('bounced');
	});

	it('reports a missing address without throwing', async () => {
		const { store } = makeStore();
		expect((await store.unsubscribe('missing@example.com')).kind).toBe('not_found');
	});

	it('rejects a confirm token presented as an unsubscribe token', async () => {
		const { store } = makeStore();
		const outcome = await store.subscribe({ email: 'new@example.com' });
		if (outcome.kind !== 'pending_confirmation') throw new Error('expected pending');
		const token = new URL(outcome.confirmUrl).searchParams.get('token') ?? '';
		const result = await store.unsubscribeWithToken(token);
		expect(result.kind).toBe('invalid_token');
	});
});

describe('SubscriberStore construction', () => {
	it('refuses a token secret that is too short', () => {
		expect(
			() =>
				new SubscriberStore(new MemoryTable(), {
					tokenSecret: 'short',
					confirmTtlSec: 60,
					unsubscribeTtlSec: 0,
					siteUrl: 'https://example.test',
					defaultSource: 'test',
				}),
		).toThrow(SubscriberInputError);
	});
});
