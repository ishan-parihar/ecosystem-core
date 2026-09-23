import { describe, expect, it, vi } from 'vitest';

import { createEmailService, createMockProvider, type EmailProvider, type EmailTheme } from '../email/index.js';
import { TOKEN_PURPOSE_UNSUBSCRIBE } from '../subscribers/store.js';
import { verifyToken } from '../tokens/index.js';
import {
	buildTagsFilter,
	sendCampaign,
	type CampaignRecipient,
	type RecipientQuery,
	type RecipientSource,
} from './index.js';

const SECRET = 'campaign-token-secret-at-least-32-chars';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

const theme: EmailTheme = {
	name: 'test',
	accent: '#b06a1f',
	accentInk: '#ffffff',
	ground: '#eeeeee',
	panel: '#ffffff',
	ink: '#111111',
	inkMuted: '#666666',
	border: '#dddddd',
	brandName: 'Brand',
	brandTagline: 'tagline',
	footerIdentity: 'identity',
	replyTo: 'reply@example.com',
	siteUrl: 'https://example.com',
};

function mockService() {
	const mock = createMockProvider();
	const service = createEmailService(
		{ provider: 'mock', from: 'news@example.com', fromName: 'Brand', replyTo: 'reply@example.com', theme, logger: silent },
		{ providers: { mock: mock.provider }, logger: silent },
	);
	return { service, mock };
}

function sourceOf(recipients: CampaignRecipient[], onQuery?: (query: RecipientQuery) => void): RecipientSource {
	return {
		async list(query) {
			onQuery?.(query);
			return recipients;
		},
	};
}

const baseOptions = {
	theme,
	tokenSecret: SECRET,
	render: () => ({ subject: 'September notes', bodyHtml: '<p>Hello</p>' }),
	query: { source: 'technical-authority' },
	logger: silent,
};

/** Pull the unsubscribe URL out of a sent message's HTML. */
function unsubscribeUrlFrom(html: string): string {
	const match = /href="([^"]*\/newsletter\/unsubscribe\?token=[^"]*)"/.exec(html);
	if (match?.[1] === undefined) throw new Error('no unsubscribe link in message html');
	return match[1].replace(/&amp;/g, '&');
}

describe('sendCampaign: consent safety', () => {
	it('gives every recipient a signed unsubscribe token that verifies to their own address', async () => {
		// This is the defect the module exists to close: the CMS built an
		// unsigned `?email=` link, so anyone who knew an address could opt it out.
		const { service, mock } = mockService();
		const recipients = [{ email: 'a@x.co' }, { email: 'b@x.co' }, { email: 'c@x.co' }];

		await sendCampaign(service, sourceOf(recipients), baseOptions);

		expect(mock.sent).toHaveLength(3);
		for (const [index, message] of mock.sent.entries()) {
			const url = unsubscribeUrlFrom(message.html);
			const token = new URL(url).searchParams.get('token') ?? '';
			const verified = await verifyToken(token, { secret: SECRET, expectedPurpose: TOKEN_PURPOSE_UNSUBSCRIBE });
			expect(verified.valid).toBe(true);
			if (!verified.valid) continue;
			expect(verified.payload.email).toBe(recipients[index]?.email);
			expect(verified.scheme).toBe('canonical');
		}
	});

	it('mints a distinct token per recipient, so one opt-out cannot affect another', async () => {
		const { service, mock } = mockService();
		await sendCampaign(service, sourceOf([{ email: 'a@x.co' }, { email: 'b@x.co' }]), baseOptions);

		const tokens = mock.sent.map((m) => new URL(unsubscribeUrlFrom(m.html)).searchParams.get('token'));
		expect(new Set(tokens).size).toBe(2);
	});

	it('sends unsubscribe links that never expire', async () => {
		// A campaign email from two years ago must still be able to honour the
		// opt-out, so the unsubscribe token deliberately has no expiry.
		const { service, mock } = mockService();
		await sendCampaign(service, sourceOf([{ email: 'a@x.co' }]), baseOptions);

		const token = new URL(unsubscribeUrlFrom(mock.sent[0]?.html ?? '')).searchParams.get('token') ?? '';
		const far = Date.now() + 10 * 365 * 86_400_000;
		expect((await verifyToken(token, { secret: SECRET, nowMs: far })).valid).toBe(true);
	});

	it('sets both RFC 8058 headers on every message', async () => {
		const { service, mock } = mockService();
		await sendCampaign(service, sourceOf([{ email: 'a@x.co' }]), baseOptions);

		const headerNames = (mock.sent[0]?.headers ?? []).map((h) => h.name);
		expect(headerNames).toContain('List-Unsubscribe');
		expect(headerNames).toContain('List-Unsubscribe-Post');
		const post = (mock.sent[0]?.headers ?? []).find((h) => h.name === 'List-Unsubscribe-Post');
		expect(post?.value).toBe('List-Unsubscribe=One-Click');
	});

	it('always scopes the recipient query by source', async () => {
		const seen: RecipientQuery[] = [];
		const { service } = mockService();
		await sendCampaign(service, sourceOf([{ email: 'a@x.co' }], (q) => seen.push(q)), baseOptions);
		expect(seen[0]?.source).toBe('technical-authority');
	});
});

describe('sendCampaign: delivery', () => {
	it('reports zero for an empty recipient list without sending', async () => {
		const { service, mock } = mockService();
		const result = await sendCampaign(service, sourceOf([]), baseOptions);
		expect(result).toMatchObject({ attempted: 0, sent: 0, failed: 0, batches: 0 });
		expect(mock.sent).toHaveLength(0);
	});

	it('chunks by batch size and counts batches', async () => {
		const { service, mock } = mockService();
		const recipients = Array.from({ length: 5 }, (_, i) => ({ email: `r${i}@x.co` }));
		const result = await sendCampaign(service, sourceOf(recipients), { ...baseOptions, batchSize: 2 });

		expect(result.sent).toBe(5);
		expect(result.batches).toBe(3);
		expect(mock.sent).toHaveLength(5);
	});

	it('sends nothing on a dry run, but still reports who would have been mailed', async () => {
		const { service, mock } = mockService();
		const result = await sendCampaign(service, sourceOf([{ email: 'a@x.co' }, { email: 'b@x.co' }]), {
			...baseOptions,
			dryRun: true,
		});
		expect(result).toMatchObject({ attempted: 2, sent: 0, dryRun: true });
		expect(mock.sent).toHaveLength(0);
	});

	it('attributes a failure to the exact address, not to the batch', async () => {
		// `results` is index-aligned with the batch, which is what makes this
		// possible; matching on error text would misattribute when a whole batch
		// failed for one shared reason.
		const failing: EmailProvider = {
			name: 'mock',
			isConfigured: () => true,
			async send(message) {
				return message.to === 'b@x.co'
					? { success: false, provider: 'mock', error: 'mailbox full' }
					: { success: true, provider: 'mock', messageId: `id-${message.to}` };
			},
			async sendBulk(messages) {
				const results = [];
				for (const message of messages) results.push(await this.send(message));
				const failed = results.filter((r) => !r.success).length;
				return {
					success: failed === 0,
					provider: 'mock',
					sent: results.length - failed,
					failed,
					failedRecipients: messages.filter((_, i) => !results[i]?.success).map((m) => m.to),
					results,
				};
			},
			async healthCheck() {
				return true;
			},
		};

		const service = createEmailService(
			{ provider: 'mock', from: 'news@example.com', fromName: 'B', replyTo: 'r@x.co', theme, logger: silent },
			{ providers: { mock: failing }, logger: silent },
		);

		const result = await sendCampaign(service, sourceOf([{ email: 'a@x.co' }, { email: 'b@x.co' }, { email: 'c@x.co' }]), baseOptions);

		expect(result).toMatchObject({ attempted: 3, sent: 2, failed: 1 });
		expect(result.failures).toEqual([{ email: 'b@x.co', error: 'mailbox full' }]);
	});

	it('reports the per-recipient failure to the source, and survives the source failing', async () => {
		const markFailed = vi.fn(async () => {
			throw new Error('record store is down');
		});
		const failing: EmailProvider = {
			name: 'mock',
			isConfigured: () => true,
			async send() {
				return { success: false, provider: 'mock', error: 'bounced' };
			},
			async sendBulk(messages) {
				const results = await Promise.all(messages.map(() => this.send()));
				return {
					success: false,
					provider: 'mock',
					sent: 0,
					failed: results.length,
					failedRecipients: messages.map((m) => m.to),
					results,
				};
			},
			async healthCheck() {
				return true;
			},
		};
		const service = createEmailService(
			{ provider: 'mock', from: 'n@x.co', fromName: 'B', replyTo: 'r@x.co', theme, logger: silent },
			{ providers: { mock: failing }, logger: silent },
		);

		const result = await sendCampaign(
			service,
			{ list: async () => [{ email: 'a@x.co' }], markFailed },
			baseOptions,
		);

		expect(markFailed).toHaveBeenCalledWith('a@x.co', 'bounced');
		// The source throwing must not abort the campaign.
		expect(result.failed).toBe(1);
	});
});

describe('buildTagsFilter', () => {
	it('uses `ov` for any-of and `cs` for all-of', () => {
		expect(buildTagsFilter(['ai'], 'any')).toBe('ov.{"ai"}');
		expect(buildTagsFilter(['ai'], 'all')).toBe('cs.{"ai"}');
	});

	it('quotes every element, so a comma cannot split one tag into two', () => {
		expect(buildTagsFilter(['ai', 'systems'], 'any')).toBe('ov.{"ai","systems"}');
	});

	it('escapes an embedded quote rather than producing a broken filter', () => {
		expect(buildTagsFilter(['a"b'], 'any')).toBe('ov.{"a\\"b"}');
	});
});

describe('createSupabaseRecipientSource', () => {
	it('returns null without a client, so a caller can fail closed', async () => {
		const { createSupabaseRecipientSource } = await import('./index.js');
		expect(createSupabaseRecipientSource(null)).toBeNull();
	});

	it('always requests only active rows, scoped by source', async () => {
		const { createSupabaseRecipientSource } = await import('./index.js');
		const calls: Array<Record<string, string>> = [];
		const client = {
			async select(_table: string, params: Record<string, string>) {
				calls.push(params);
				return { rows: [] as Array<{ id: string; email: string }> };
			},
		};
		const source = createSupabaseRecipientSource(client as never, { pageSize: 10 });
		await source?.list({ source: 'technical-authority' });

		expect(calls[0]?.status).toBe('eq.active');
		expect(calls[0]?.source).toBe('eq.technical-authority');
		expect(calls[0]?.tags).toBeUndefined();
	});

	it('adds the tag filter only when tags were given', async () => {
		const { createSupabaseRecipientSource } = await import('./index.js');
		const calls: Array<Record<string, string>> = [];
		const client = {
			async select(_table: string, params: Record<string, string>) {
				calls.push(params);
				return { rows: [] as Array<{ id: string; email: string }> };
			},
		};
		const source = createSupabaseRecipientSource(client as never, { pageSize: 10 });
		await source?.list({ source: 's', tags: ['ai', 'law'], match: 'all' });
		expect(calls[0]?.tags).toBe('cs.{"ai","law"}');
	});

	it('normalises addresses to lowercase on the way out', async () => {
		const { createSupabaseRecipientSource } = await import('./index.js');
		const client = {
			async select() {
				return { rows: [{ id: '1', email: 'Mixed@Case.CO' }] };
			},
		};
		const source = createSupabaseRecipientSource(client as never, { pageSize: 10 });
		expect(await source?.list({ source: 's' })).toEqual([{ email: 'mixed@case.co', id: '1' }]);
	});
});
