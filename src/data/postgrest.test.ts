import { describe, expect, it, vi } from 'vitest';

import {
	createPostgrest,
	filterValue,
	likePattern,
	PostgrestClient,
	PostgrestError,
} from './postgrest.js';

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string | null;
}

/**
 * A fetch stub that records calls and answers from a queue.
 *
 * A real `Response` is returned rather than a hand-rolled object so the
 * client's `response.ok`, `response.json()` and `response.headers` calls are
 * exercised against the actual web API the Worker would see.
 */
function recordingFetch(responses: Array<{ status?: number; body?: unknown; contentRange?: string }>) {
	const calls: Call[] = [];
	let index = 0;

	const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		calls.push({
			url: String(input),
			method: init?.method ?? 'GET',
			headers: Object.fromEntries(headers.entries()),
			body: typeof init?.body === 'string' ? init.body : null,
		});
		const spec = responses[index] ?? {};
		index += 1;
		const initHeaders: Record<string, string> = {
			'Content-Type': 'application/json',
		};
		if (spec.contentRange) initHeaders['Content-Range'] = spec.contentRange;
		return new Response(spec.body === undefined ? 'null' : JSON.stringify(spec.body), {
			status: spec.status ?? 200,
			headers: initHeaders,
		});
	}) as typeof fetch;

	return { impl, calls };
}

const CONFIG = { url: 'https://project.supabase.co', serviceRoleKey: 'service-role-key' };

describe('PostgrestClient', () => {
	it('sends the service-role key as both apikey and bearer', async () => {
		const { impl, calls } = recordingFetch([{ body: [] }]);
		const client = new PostgrestClient({ ...CONFIG, fetchImpl: impl });

		await client.select('t', { select: 'id' });

		expect(calls[0]?.headers.apikey).toBe('service-role-key');
		expect(calls[0]?.headers.authorization).toBe('Bearer service-role-key');
	});

	it('builds the table URL and applies every param', async () => {
		const { impl, calls } = recordingFetch([{ body: [] }]);
		const client = new PostgrestClient({ ...CONFIG, fetchImpl: impl });

		await client.select('subs', { select: 'id,email', limit: '5', offset: '10' });

		const url = new URL(calls[0]?.url ?? '');
		expect(url.pathname).toBe('/rest/v1/subs');
		expect(url.searchParams.get('select')).toBe('id,email');
		expect(url.searchParams.get('limit')).toBe('5');
		expect(url.searchParams.get('offset')).toBe('10');
	});

	it('strips a trailing slash from the project url', async () => {
		const { impl, calls } = recordingFetch([{ body: [] }]);
		const client = new PostgrestClient({ ...CONFIG, url: 'https://project.supabase.co/', fetchImpl: impl });

		await client.select('t');

		expect(calls[0]?.url).toContain('https://project.supabase.co/rest/v1/t');
		expect(calls[0]?.url).not.toContain('.co//rest');
	});

	it('parses the unpaginated total from Content-Range', async () => {
		const { impl } = recordingFetch([{ body: [{ id: 1 }], contentRange: '0-0/57' }]);
		const client = new PostgrestClient({ ...CONFIG, fetchImpl: impl });

		const result = await client.select<{ id: number }>('t', {}, true);

		expect(result.rows).toHaveLength(1);
		expect(result.total).toBe(57);
	});

	it('reads an empty set as a zero total rather than a parse failure', async () => {
		const { impl } = recordingFetch([{ body: [], contentRange: '*/0' }]);
		const client = new PostgrestClient({ ...CONFIG, fetchImpl: impl });

		const result = await client.select('t', {}, true);

		expect(result.total).toBe(0);
	});

	it('leaves total null when no count was requested', async () => {
		const { impl } = recordingFetch([{ body: [] }]);
		const client = new PostgrestClient({ ...CONFIG, fetchImpl: impl });

		expect((await client.select('t')).total).toBeNull();
	});

	it('returns null from selectOne instead of erroring on no rows', async () => {
		const { impl } = recordingFetch([{ body: [] }]);
		const client = new PostgrestClient({ ...CONFIG, fetchImpl: impl });

		expect(await client.selectOne('t', { email: 'eq.a@b.co' })).toBeNull();
	});

	it('forces limit=1 in selectOne', async () => {
		const { impl, calls } = recordingFetch([{ body: [{ id: 1 }] }]);
		const client = new PostgrestClient({ ...CONFIG, fetchImpl: impl });

		await client.selectOne('t', { email: 'eq.a@b.co' });

		expect(new URL(calls[0]?.url ?? '').searchParams.get('limit')).toBe('1');
	});

	it('sends a JSON body on insert and returns the stored row', async () => {
		const { impl, calls } = recordingFetch([{ body: [{ id: 'x', email: 'a@b.co' }] }]);
		const client = new PostgrestClient({ ...CONFIG, fetchImpl: impl });

		const created = await client.insert<{ id: string }>('t', { email: 'a@b.co' });

		expect(calls[0]?.method).toBe('POST');
		expect(calls[0]?.headers.prefer).toBe('return=representation');
		expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ email: 'a@b.co' });
		expect(created.id).toBe('x');
	});

	it('throws rather than returning a phantom row when insert returns nothing', async () => {
		const { impl } = recordingFetch([{ body: [] }]);
		const client = new PostgrestClient({ ...CONFIG, fetchImpl: impl });

		await expect(client.insert('t', {})).rejects.toBeInstanceOf(PostgrestError);
	});

	it('sends insertMany as one request with an array body', async () => {
		const { impl, calls } = recordingFetch([{ body: [{ id: 1 }, { id: 2 }] }]);
		const client = new PostgrestClient({ ...CONFIG, fetchImpl: impl });

		const rows = await client.insertMany('t', [{ a: 1 }, { a: 2 }]);

		expect(calls).toHaveLength(1);
		expect(JSON.parse(calls[0]?.body ?? '[]')).toHaveLength(2);
		expect(rows).toHaveLength(2);
	});

	it('skips the network entirely for an empty insertMany', async () => {
		const { impl, calls } = recordingFetch([]);
		const client = new PostgrestClient({ ...CONFIG, fetchImpl: impl });

		expect(await client.insertMany('t', [])).toEqual([]);
		expect(calls).toHaveLength(0);
	});

	it('patches with the match in the query string and returns updated rows', async () => {
		const { impl, calls } = recordingFetch([{ body: [{ id: '1', status: 'active' }] }]);
		const client = new PostgrestClient({ ...CONFIG, fetchImpl: impl });

		const rows = await client.update('t', { id: 'eq.1' }, { status: 'active' });

		expect(calls[0]?.method).toBe('PATCH');
		expect(new URL(calls[0]?.url ?? '').searchParams.get('id')).toBe('eq.1');
		expect(rows).toHaveLength(1);
	});

	it('reports the number of rows removed by a delete', async () => {
		const { impl } = recordingFetch([{ body: [{ id: 1 }, { id: 2 }] }]);
		const client = new PostgrestClient({ ...CONFIG, fetchImpl: impl });

		expect(await client.remove('t', { id: 'eq.1' })).toBe(2);
	});

	it('calls rpc at the rpc path with the args as the body', async () => {
		const { impl, calls } = recordingFetch([{ body: [{ ok: true }] }]);
		const client = new PostgrestClient({ ...CONFIG, fetchImpl: impl });

		const result = await client.rpc<{ ok: boolean }[]>('exec_sql', { sql: 'select 1' });

		expect(new URL(calls[0]?.url ?? '').pathname).toBe('/rest/v1/rpc/exec_sql');
		expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ sql: 'select 1' });
		expect(result[0]?.ok).toBe(true);
	});

	it('counts without transferring rows', async () => {
		const { impl, calls } = recordingFetch([{ body: [], contentRange: '*/9' }]);
		const client = new PostgrestClient({ ...CONFIG, fetchImpl: impl });

		expect(await client.count('t', { status: 'eq.active' })).toBe(9);
		expect(new URL(calls[0]?.url ?? '').searchParams.get('select')).toBe('id');
	});

	it('raises PostgrestError carrying the status and detail', async () => {
		const { impl } = recordingFetch([{ status: 409, body: { message: 'duplicate key' } }]);
		const client = new PostgrestClient({ ...CONFIG, fetchImpl: impl });

		await expect(client.insert('t', {})).rejects.toMatchObject({
			name: 'PostgrestError',
			status: 409,
		});
	});

	it('logs the operation name when a request fails, without the key', async () => {
		const error = vi.fn();
		const { impl } = recordingFetch([{ status: 500, body: 'boom' }]);
		const client = new PostgrestClient({
			...CONFIG,
			fetchImpl: impl,
			logger: { info: vi.fn(), warn: vi.fn(), error },
		});

		await expect(client.select('subs')).rejects.toBeInstanceOf(PostgrestError);

		expect(error).toHaveBeenCalledWith(
			'PostgREST request failed',
			expect.objectContaining({ operation: 'select subs', status: 500 }),
		);
		expect(JSON.stringify(error.mock.calls)).not.toContain('service-role-key');
	});
});

describe('createPostgrest', () => {
	it('returns null when the project is not configured', () => {
		expect(createPostgrest({ url: undefined, serviceRoleKey: undefined })).toBeNull();
	});

	it('returns null when only one half of the credentials is present', () => {
		expect(createPostgrest({ url: 'https://x.co', serviceRoleKey: undefined })).toBeNull();
		expect(createPostgrest({ url: undefined, serviceRoleKey: 'k' })).toBeNull();
	});

	it('builds a client when both halves are present', () => {
		expect(createPostgrest({ url: 'https://x.co', serviceRoleKey: 'k' })).toBeInstanceOf(
			PostgrestClient,
		);
	});
});

describe('filter escaping', () => {
	it('removes the characters PostgREST parses inside a filter expression', () => {
		expect(filterValue('a,b(c)"d\\e')).toBe('abcde');
	});

	it('leaves an ordinary value untouched', () => {
		expect(filterValue('a@b.co')).toBe('a@b.co');
	});

	it('wraps a search term as a substring pattern', () => {
		expect(likePattern('ishan')).toBe('*ishan*');
	});

	it('strips wildcards so a term cannot widen its own match', () => {
		expect(likePattern('%admin*')).toBe('*admin*');
		expect(likePattern('a,b(c)')).toBe('*abc*');
	});
});
