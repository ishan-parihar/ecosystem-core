import { describe, expect, it } from 'vitest';

import { decodeBase64Url, utf8Decode } from '../internal/base64.js';
import {
	contactNotificationEmail,
	confirmSubscriptionEmail,
	escapeHtml,
	isEmailAddress,
	listUnsubscribeHeaders,
	normalizeEmail,
	renderEmailShell,
	wrapCampaignContent,
} from './render.js';
import { cloudflareProvider, createMockProvider, gmailProvider, resendProvider } from './providers.js';
import { createEmailService } from './service.js';
import { EmailConfigError, silentLogger } from './types.js';
import type {
	CloudflareEmailBinding,
	EmailConfig,
	EmailContext,
	EmailMessage,
	EmailTheme,
} from './types.js';

const theme: EmailTheme = {
	name: 'test',
	accent: '#E8A33D',
	accentInk: '#0a0c0f',
	ground: '#0a0c0f',
	panel: '#14181d',
	ink: '#e8ecef',
	inkMuted: '#7d8894',
	border: '#242a31',
	brandName: 'Ishan Parihar',
	brandTagline: 'Agentic Systems',
	footerIdentity: 'Ishan Parihar, independent systems engineer.',
	footerAddress: 'Bengaluru, India',
	replyTo: 'contact@ishanparihar.com',
	siteUrl: 'https://tech.test',
};

const baseConfig: EmailConfig = {
	provider: 'mock',
	from: 'news@news.ishanparihar.com',
	fromName: 'Ishan Parihar',
	replyTo: 'contact@ishanparihar.com',
	theme,
	logger: silentLogger,
};

function context(overrides: Partial<EmailConfig>): EmailContext {
	return { config: { ...baseConfig, ...overrides }, logger: silentLogger, fetchImpl: globalThis.fetch };
}

/** Capture a fetch call and return a canned response. */
function stubFetch(
	response: { status?: number; body?: string },
): { calls: Array<{ url: string; init: RequestInit | undefined }>; impl: typeof fetch } {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), init });
		return new Response(response.body ?? '{}', { status: response.status ?? 200 });
	}) as unknown as typeof fetch;
	return { calls, impl };
}

/* -------------------------------------------------------------------------- */
/* Escaping and validation                                                    */
/* -------------------------------------------------------------------------- */

describe('escapeHtml', () => {
	it('neutralises every HTML-significant character', () => {
		expect(escapeHtml(`<script>"x" & 'y'</script>`)).toBe(
			'&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;',
		);
	});

	it('escapes ampersands before the entities it introduces', () => {
		expect(escapeHtml('&lt;')).toBe('&amp;lt;');
	});
});

describe('isEmailAddress', () => {
	it.each(['a@b.co', 'first.last+tag@sub.example.com'])('accepts %s', (value) => {
		expect(isEmailAddress(value)).toBe(true);
	});

	it.each(['', 'no-at', 'a@b', 'a b@c.co', 'a@.co', 'a@b.'])('rejects %s', (value) => {
		expect(isEmailAddress(value)).toBe(false);
	});

	it('normalises case and whitespace', () => {
		expect(normalizeEmail('  Mixed@Case.COM ')).toBe('mixed@case.com');
	});
});

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

describe('renderEmailShell', () => {
	it('uses the injected theme rather than a hardcoded palette', () => {
		const cta = { label: 'Go', url: 'https://tech.test/x' };
		const dark = renderEmailShell({ theme, title: 'Hello', bodyHtml: '<p>Body</p>', cta });
		const light = renderEmailShell({
			theme: { ...theme, accent: '#111111', accentInk: '#ffffff', ground: '#ffffff', ink: '#000000' },
			title: 'Hello',
			bodyHtml: '<p>Body</p>',
			cta,
		});
		expect(dark).toContain(theme.accent);
		expect(dark).toContain(theme.ground);
		expect(dark).toContain('Ishan Parihar');
		// The palette must come from the argument, not from a constant in the renderer.
		expect(light).toContain('#ffffff');
		expect(dark).not.toBe(light);
	});

	it('omits the call to action when none is supplied', () => {
		const html = renderEmailShell({ theme, title: 'Hello', bodyHtml: '<p>Body</p>' });
		expect(html).not.toContain(theme.accent);
	});

	it('escapes the title', () => {
		const html = renderEmailShell({ theme, title: '<img onerror=x>', bodyHtml: '' });
		expect(html).not.toContain('<img onerror=x>');
		expect(html).toContain('&lt;img onerror=x&gt;');
	});

	it('renders the unsubscribe footer only when a URL is supplied', () => {
		const without = renderEmailShell({ theme, title: 'T', bodyHtml: '' });
		expect(without).not.toContain('Unsubscribe');
		const withUrl = renderEmailShell({
			theme,
			title: 'T',
			bodyHtml: '',
			unsubscribeUrl: 'https://tech.test/u?t=1',
		});
		expect(withUrl).toContain('Unsubscribe');
		expect(withUrl).toContain('https://tech.test/u?t=1');
	});
});

describe('listUnsubscribeHeaders', () => {
	it('produces the RFC 8058 pair', () => {
		const headers = listUnsubscribeHeaders('https://tech.test/u?t=1');
		expect(headers).toEqual([
			{ name: 'List-Unsubscribe', value: '<https://tech.test/u?t=1>' },
			{ name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
		]);
	});

	it('adds the mailto target when supplied', () => {
		const headers = listUnsubscribeHeaders('https://tech.test/u', 'unsub@tech.test');
		expect(headers[0]?.value).toBe('<https://tech.test/u>, <mailto:unsub@tech.test>');
	});
});

describe('templates', () => {
	it('builds a confirmation email carrying the link in html and text', () => {
		const rendered = confirmSubscriptionEmail({
			theme,
			confirmUrl: 'https://tech.test/newsletter/confirm?token=abc',
			ttlDays: 7,
		});
		expect(rendered.subject).toContain('Confirm your subscription');
		expect(rendered.html).toContain('token=abc');
		expect(rendered.text).toContain('token=abc');
		expect(rendered.text).toContain('7 days');
	});

	it('escapes contact-form content in the notification email', () => {
		const rendered = contactNotificationEmail({
			theme,
			name: '<b>Bold</b> Sender',
			email: 'sender@example.com',
			intent: 'Hiring full-time',
			message: '<script>alert(1)</script>',
			submittedAt: '2026-09-23T00:00:00.000Z',
			context: { Role: 'Staff engineer' },
		});
		expect(rendered.html).not.toContain('<script>');
		expect(rendered.html).toContain('&lt;script&gt;');
		expect(rendered.subject).toBe('[Hiring full-time] <b>Bold</b> Sender via Ishan Parihar');
		expect(rendered.text).toContain('Staff engineer');
	});

	it('wraps campaign content with a per-recipient unsubscribe link', () => {
		const html = wrapCampaignContent('<p>Essay</p>', {
			theme,
			unsubscribeUrl: 'https://tech.test/newsletter/unsubscribe?token=xyz',
		});
		expect(html).toContain('<p>Essay</p>');
		expect(html).toContain('token=xyz');
	});
});

/* -------------------------------------------------------------------------- */
/* Providers                                                                  */
/* -------------------------------------------------------------------------- */

describe('cloudflare provider', () => {
	it('calls the injected binding with the resolved envelope', async () => {
		const calls: unknown[] = [];
		const binding: CloudflareEmailBinding = {
			async send(message) {
				calls.push(message);
				return { messageId: 'cf-1' };
			},
		};
		const result = await cloudflareProvider.send(
			{ to: 'a@b.co', subject: 'Hi', html: '<p>x</p>' },
			context({ provider: 'cloudflare', binding }),
		);

		expect(result.success).toBe(true);
		expect(result.messageId).toBe('cf-1');
		expect(calls).toHaveLength(1);
		const payload = calls[0] as { from: { name: string; email: string }; to: string; replyTo: string };
		expect(payload.from).toEqual({ name: 'Ishan Parihar', email: 'news@news.ishanparihar.com' });
		expect(payload.to).toBe('a@b.co');
		expect(payload.replyTo).toBe('contact@ishanparihar.com');
	});

	it('reports failure instead of throwing when the binding rejects', async () => {
		const binding: CloudflareEmailBinding = {
			async send() {
				throw new Error('binding exploded');
			},
		};
		const result = await cloudflareProvider.send(
			{ to: 'a@b.co', subject: 'Hi', html: 'x' },
			context({ provider: 'cloudflare', binding }),
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain('binding exploded');
	});

	it('is unconfigured without a binding', () => {
		expect(cloudflareProvider.isConfigured(context({ provider: 'cloudflare' }))).toBe(false);
		expect(
			cloudflareProvider.isConfigured(
				context({ provider: 'cloudflare', binding: { async send() {} } }),
			),
		).toBe(true);
	});
});

describe('resend provider', () => {
	it('posts the resolved payload to the Resend endpoint', async () => {
		const { calls, impl } = stubFetch({ body: JSON.stringify({ id: 're-1' }) });
		const result = await resendProvider.send(
			{ to: 'a@b.co', subject: 'Hi', html: '<p>x</p>', text: 'x' },
			context({ provider: 'resend', resendApiKey: 're_key', fetchImpl: impl }),
		);

		expect(result.success).toBe(true);
		expect(result.messageId).toBe('re-1');
		expect(calls[0]?.url).toBe('https://api.resend.com/emails');
		const headers = calls[0]?.init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer re_key');
		const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
		expect(body.from).toBe('Ishan Parihar <news@news.ishanparihar.com>');
		expect(body.to).toEqual(['a@b.co']);
		expect(body.reply_to).toBe('contact@ishanparihar.com');
	});

	it('surfaces a non-2xx response as a failure', async () => {
		const { impl } = stubFetch({ status: 422, body: 'domain not verified' });
		const result = await resendProvider.send(
			{ to: 'a@b.co', subject: 'Hi', html: 'x' },
			context({ provider: 'resend', resendApiKey: 're_key', fetchImpl: impl }),
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain('422');
	});

	it('is unconfigured without an API key', () => {
		expect(resendProvider.isConfigured(context({ provider: 'resend' }))).toBe(false);
	});
});

describe('gmail provider', () => {
	it('refreshes a token then sends base64url MIME', async () => {
		const { calls, impl } = stubFetch({});
		// First call is the token exchange, second is the send.
		const sequence = [
			new Response(JSON.stringify({ access_token: 'ya29.token' }), { status: 200 }),
			new Response(JSON.stringify({ id: 'gm-1' }), { status: 200 }),
		];
		let index = 0;
		const sequencedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(input), init });
			const next = sequence[index] ?? new Response('{}', { status: 200 });
			index += 1;
			return next;
		}) as unknown as typeof fetch;
		void impl;

		const result = await gmailProvider.send(
			{ to: 'a@b.co', subject: 'Ünicode subject', html: '<p>héllo</p>', text: 'hello' },
			context({
				provider: 'gmail',
				gmail: {
					clientId: 'cid',
					clientSecret: 'csecret',
					refreshToken: 'rtoken',
					userEmail: 'contact@ishanparihar.com',
				},
				fetchImpl: sequencedFetch,
			}),
		);

		expect(result.success).toBe(true);
		expect(result.messageId).toBe('gm-1');
		expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/token');
		expect(calls[1]?.url).toBe(
			'https://gmail.googleapis.com/gmail/v1/users/contact%40ishanparihar.com/messages/send',
		);

		const sendBody = JSON.parse(String(calls[1]?.init?.body)) as { raw: string };
		const mime = utf8Decode(decodeBase64Url(sendBody.raw));
		expect(mime).toContain('multipart/alternative');
		expect(mime).toContain('Reply-To: contact@ishanparihar.com');
		// Non-ASCII subjects must be RFC 2047 encoded.
		expect(mime).toContain('Subject: =?UTF-8?B?');
	});

	it('reports a token failure without attempting a send', async () => {
		const calls: string[] = [];
		const impl = (async (input: RequestInfo | URL) => {
			calls.push(String(input));
			return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
		}) as unknown as typeof fetch;

		const result = await gmailProvider.send(
			{ to: 'a@b.co', subject: 'S', html: 'x' },
			context({
				provider: 'gmail',
				gmail: { clientId: 'c', clientSecret: 's', refreshToken: 'r', userEmail: 'u@e.co' },
				fetchImpl: impl,
			}),
		);
		expect(result.success).toBe(false);
		expect(calls).toHaveLength(1);
	});
});

describe('mock provider', () => {
	it('records what was sent and never reaches the network', async () => {
		const mock = createMockProvider();
		const service = createEmailService(baseConfig, {
			providers: { mock: mock.provider },
			logger: silentLogger,
		});
		const result = await service.send({ to: 'a@b.co', subject: 'S', html: 'x' });
		expect(result.success).toBe(true);
		expect(mock.sent).toHaveLength(1);
		expect(mock.sent[0]?.to).toBe('a@b.co');
		mock.reset();
		expect(mock.sent).toHaveLength(0);
	});
});

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

describe('createEmailService', () => {
	it('refuses the mock provider unless it is injected explicitly', () => {
		expect(() => createEmailService(baseConfig)).toThrow(EmailConfigError);
	});

	it('throws at construction when the provider has no credentials', () => {
		expect(() => createEmailService({ ...baseConfig, provider: 'resend' })).toThrow(EmailConfigError);
		expect(() => createEmailService({ ...baseConfig, provider: 'cloudflare' })).toThrow(
			EmailConfigError,
		);
	});

	it('throws on an invalid envelope sender', () => {
		expect(() =>
			createEmailService({ ...baseConfig, provider: 'cloudflare', from: 'nope' }, {
				providers: { cloudflare: cloudflareProvider },
			}),
		).toThrow(EmailConfigError);
	});

	it('rejects an invalid recipient without calling the provider', async () => {
		const mock = createMockProvider();
		const service = createEmailService(baseConfig, { providers: { mock: mock.provider } });
		const result = await service.send({ to: 'not-an-email', subject: 'S', html: 'x' });
		expect(result.success).toBe(false);
		expect(mock.sent).toHaveLength(0);
	});

	it('adds the RFC 8058 headers when sending a rendered campaign message', async () => {
		const mock = createMockProvider();
		const service = createEmailService(baseConfig, { providers: { mock: mock.provider } });
		const sent: EmailMessage[] = mock.sent;
		await service.sendRendered(
			{ subject: 'Essay', html: '<p>x</p>', text: 'x' },
			{ toBe: 'a@b.co', unsubscribeUrl: 'https://tech.test/u?t=1' },
		);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.headers).toEqual(
			expect.arrayContaining([{ name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' }]),
		);
	});

	it('reports provider status', async () => {
		const mock = createMockProvider();
		const service = createEmailService(baseConfig, { providers: { mock: mock.provider } });
		const status = await service.getStatus();
		expect(status).toEqual({ provider: 'mock', configured: true, healthy: true });
	});
});
