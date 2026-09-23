import { describe, expect, it } from 'vitest';

import { PostgrestClient } from '../data/postgrest.js';
import {
	asSubscriberStatus,
	createSupabaseSubscriberTable,
	DEFAULT_SUBSCRIBER_COLUMNS,
	DEFAULT_SUBSCRIBER_TABLE,
	SupabaseSubscriberTable,
	toSubscriberRecord,
} from './supabase-table.js';

interface Call {
	url: string;
	method: string;
	body: string | null;
}

function recordingFetch(responses: unknown[], contentRange = '0-0/1') {
	const calls: Call[] = [];
	let index = 0;
	const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({
			url: String(input),
			method: init?.method ?? 'GET',
			body: typeof init?.body === 'string' ? init.body : null,
		});
		const body = responses[index] ?? null;
		index += 1;
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'Content-Type': 'application/json', 'Content-Range': contentRange },
		});
	}) as typeof fetch;
	return { impl, calls };
}

function client(responses: unknown[], contentRange?: string) {
	const { impl, calls } = recordingFetch(responses, contentRange);
	return { client: new PostgrestClient({ url: 'https://p.supabase.co', serviceRoleKey: 'k', fetchImpl: impl }), calls };
}

const ROW = {
	id: 'abc',
	email: 'a@b.co',
	first_name: 'A',
	last_name: null,
	status: 'active',
	source: 'technical-authority',
	subscription_type: 'general',
	tags: ['x', 'y'],
	interests: null,
	domain_interests: [],
	lead_magnet: null,
	lead_score: 7,
	created_at: '2026-09-01T00:00:00Z',
	updated_at: '2026-09-02T00:00:00Z',
	unsubscribed_at: null,
	confirmed_at: '2026-09-01T01:00:00Z',
};

describe('toSubscriberRecord', () => {
	it('maps a full row', () => {
		const record = toSubscriberRecord(ROW);

		expect(record).toMatchObject({
			id: 'abc',
			email: 'a@b.co',
			status: 'active',
			source: 'technical-authority',
			tags: ['x', 'y'],
			lead_score: 7,
			confirmed_at: '2026-09-01T01:00:00Z',
		});
	});

	it('coerces a non-array array column to an empty list rather than throwing', () => {
		expect(toSubscriberRecord({ ...ROW, tags: 'not-an-array' }).tags).toEqual([]);
	});

	it('drops non-string entries from an array column', () => {
		expect(toSubscriberRecord({ ...ROW, tags: ['ok', 5, null] }).tags).toEqual(['ok']);
	});

	it('defaults a missing numeric column to zero', () => {
		expect(toSubscriberRecord({ ...ROW, lead_score: undefined }).lead_score).toBe(0);
	});

	it('stringifies the id so a numeric primary key still yields a string', () => {
		expect(toSubscriberRecord({ ...ROW, id: 42 }).id).toBe('42');
	});
});

describe('asSubscriberStatus', () => {
	it('accepts each known status', () => {
		for (const status of ['active', 'unsubscribed', 'bounced', 'complained', 'pending_confirmation']) {
			expect(asSubscriberStatus(status)).toBe(status);
		}
	});

	it('reads an unknown status as pending_confirmation, the safest default', () => {
		// An unrecognised value must not become a sendable status by assertion.
		expect(asSubscriberStatus('some_future_status')).toBe('pending_confirmation');
		expect(asSubscriberStatus(null)).toBe('pending_confirmation');
		expect(asSubscriberStatus(7)).toBe('pending_confirmation');
	});
});

describe('SupabaseSubscriberTable', () => {
	it('defaults to the shared table and column set', async () => {
		const { client: db, calls } = client([[ROW]]);
		const table = new SupabaseSubscriberTable(db);

		await table.findByEmail('a@b.co');

		const url = new URL(calls[0]?.url ?? '');
		expect(url.pathname).toBe(`/rest/v1/${DEFAULT_SUBSCRIBER_TABLE}`);
		expect(url.searchParams.get('select')).toBe(DEFAULT_SUBSCRIBER_COLUMNS.join(','));
		expect(url.searchParams.get('email')).toBe('eq.a@b.co');
	});

	it('honours a custom table name for a surface with its own table', async () => {
		const { client: db, calls } = client([[ROW]]);
		const table = new SupabaseSubscriberTable(db, { table: 'custom_subscribers' });

		await table.findByEmail('a@b.co');

		expect(new URL(calls[0]?.url ?? '').pathname).toBe('/rest/v1/custom_subscribers');
	});

	it('returns null when no row matches', async () => {
		const { client: db } = client([[]]);
		expect(await new SupabaseSubscriberTable(db).findByEmail('nobody@b.co')).toBeNull();
	});

	it('omits undefined fields from an insert so a column default survives', async () => {
		const { client: db, calls } = client([[ROW]]);
		const table = new SupabaseSubscriberTable(db);

		await table.insert({
			email: 'a@b.co',
			status: 'pending_confirmation',
			created_at: 'now',
			updated_at: 'now',
			first_name: undefined,
		});

		const body = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>;
		expect(body).not.toHaveProperty('first_name');
		expect(body.email).toBe('a@b.co');
	});

	it('preserves an explicit null in a patch, which clears the column', async () => {
		const { client: db, calls } = client([[ROW]]);
		const table = new SupabaseSubscriberTable(db);

		await table.updateByEmail('a@b.co', { first_name: null, status: 'active' });

		const body = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>;
		expect(body).toHaveProperty('first_name', null);
		expect(body.status).toBe('active');
	});

	it('omits undefined fields from a patch so the column is left alone', async () => {
		const { client: db, calls } = client([[ROW]]);
		const table = new SupabaseSubscriberTable(db);

		await table.updateById('abc', { status: 'unsubscribed', confirmed_at: undefined });

		const body = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>;
		expect(body).not.toHaveProperty('confirmed_at');
	});

	it('returns null from updateById when the row does not exist', async () => {
		const { client: db } = client([[]]);
		expect(await new SupabaseSubscriberTable(db).updateById('nope', { status: 'active' })).toBeNull();
	});

	it('applies status, source, paging and ordering to a list', async () => {
		const { client: db, calls } = client([[ROW]], '0-0/1');
		const table = new SupabaseSubscriberTable(db);

		await table.list({ status: 'active', source: 'technical-authority', limit: 10, offset: 20 });

		const params = new URL(calls[0]?.url ?? '').searchParams;
		expect(params.get('status')).toBe('eq.active');
		expect(params.get('source')).toBe('eq.technical-authority');
		expect(params.get('limit')).toBe('10');
		expect(params.get('offset')).toBe('20');
		expect(params.get('order')).toBe('created_at.desc');
	});

	it('omits the status filter for "all" rather than sending an impossible value', async () => {
		const { client: db, calls } = client([[ROW]]);
		await new SupabaseSubscriberTable(db).list({ status: 'all' });
		expect(new URL(calls[0]?.url ?? '').searchParams.has('status')).toBe(false);
	});

	it('defaults paging rather than sending an unbounded query', async () => {
		const { client: db, calls } = client([[ROW]]);
		await new SupabaseSubscriberTable(db).list({});
		const params = new URL(calls[0]?.url ?? '').searchParams;
		expect(params.get('limit')).toBe('50');
		expect(params.get('offset')).toBe('0');
	});

	it('builds a search across email and both name columns', async () => {
		const { client: db, calls } = client([[ROW]]);
		await new SupabaseSubscriberTable(db).list({ search: 'ishan' });
		expect(new URL(calls[0]?.url ?? '').searchParams.get('or')).toBe(
			'(email.ilike.*ishan*,first_name.ilike.*ishan*,last_name.ilike.*ishan*)',
		);
	});

	it('does not add a search filter for a blank term', async () => {
		const { client: db, calls } = client([[ROW]]);
		await new SupabaseSubscriberTable(db).list({ search: '   ' });
		expect(new URL(calls[0]?.url ?? '').searchParams.has('or')).toBe(false);
	});

	it('reports the unpaginated total from a list', async () => {
		const { client: db } = client([[ROW]], '0-0/128');
		expect((await new SupabaseSubscriberTable(db).list({})).total).toBe(128);
	});

	it('counts only active subscribers, scoped to a source when given', async () => {
		const { client: db, calls } = client([[]], '*/42');

		expect(await new SupabaseSubscriberTable(db).countActive('technical-authority')).toBe(42);
		const params = new URL(calls[0]?.url ?? '').searchParams;
		expect(params.get('status')).toBe('eq.active');
		expect(params.get('source')).toBe('eq.technical-authority');
	});

	it('counts every active subscriber when no source is given', async () => {
		const { client: db, calls } = client([[]], '*/42');
		await new SupabaseSubscriberTable(db).countActive();
		expect(new URL(calls[0]?.url ?? '').searchParams.has('source')).toBe(false);
	});
});

describe('createSupabaseSubscriberTable', () => {
	it('returns null when there is no client, matching createPostgrest', () => {
		expect(createSupabaseSubscriberTable(null)).toBeNull();
	});

	it('builds the adapter when a client is present', () => {
		const { client: db } = client([[ROW]]);
		expect(createSupabaseSubscriberTable(db)).toBeInstanceOf(SupabaseSubscriberTable);
	});
});
