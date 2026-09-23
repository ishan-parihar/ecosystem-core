/**
 * The four email providers.
 *
 * Every provider is stateless: it receives an {@link EmailContext} and reads
 * configuration from it. None of them touch `process.env`, a module-level
 * singleton, or a Node builtin, so all four run unchanged in Cloudflare Workers.
 */

import type {
	BatchResult,
	CloudflareEmailMessage,
	EmailContext,
	EmailMessage,
	EmailProvider,
	ProviderName,
	SendResult,
} from './types.js';
import { EmailConfigError } from './types.js';
import { sanitizeHeaderValue } from './render.js';
import { encodeBase64, encodeBase64Url, utf8Encode, wrapBase64 } from '../internal/base64.js';

function resolveFetch(context: EmailContext): typeof fetch {
	const impl = context.config.fetchImpl ?? globalThis.fetch;
	if (typeof impl !== 'function') {
		throw new EmailConfigError(
			context.config.provider,
			'No fetch implementation available. Pass EmailConfig.fetchImpl.',
		);
	}
	return impl;
}

function formatSender(name: string, email: string): string {
	const safeName = sanitizeHeaderValue(name);
	const safeEmail = sanitizeHeaderValue(email);
	if (safeName.length === 0) return safeEmail;
	// Quote the display name when it contains characters that would break the header.
	return /[",;:<>@\\]/.test(safeName) ? `"${safeName.replace(/"/g, '')}" <${safeEmail}>` : `${safeName} <${safeEmail}>`;
}

function headerRecord(headers: EmailMessage['headers']): Record<string, string> {
	const out: Record<string, string> = {};
	for (const header of headers ?? []) {
		out[sanitizeHeaderValue(header.name)] = sanitizeHeaderValue(header.value);
	}
	return out;
}

function failure(provider: ProviderName, error: unknown): SendResult {
	return {
		success: false,
		provider,
		error: error instanceof Error ? error.message : String(error),
	};
}

/* -------------------------------------------------------------------------- */
/* Mock                                                                        */
/* -------------------------------------------------------------------------- */

export interface MockProviderHandle {
	provider: EmailProvider;
	/** Every message handed to the mock, in order. */
	sent: EmailMessage[];
	reset(): void;
}

/**
 * A provider that sends nothing and records everything.
 *
 * This is what development and the test suite use. It is explicitly NOT
 * selected by environment detection: the application must ask for it, so a
 * misconfigured production environment can never silently fall back to
 * dropping mail.
 */
export function createMockProvider(): MockProviderHandle {
	const sent: EmailMessage[] = [];

	const provider: EmailProvider = {
		name: 'mock',
		isConfigured: () => true,
		async send(message) {
			sent.push(message);
			return { success: true, provider: 'mock', messageId: `mock-${sent.length}` };
		},
		async sendBulk(messages) {
			const results: SendResult[] = [];
			for (const message of messages) {
				results.push(await provider.send(message, {} as EmailContext));
			}
			const failed = results.filter((result) => !result.success).length;
			return {
				success: failed === 0,
				provider: 'mock',
				sent: results.length - failed,
				failed,
				failedRecipients: messages.filter((_, index) => !results[index]?.success).map((m) => m.to),
				results,
			};
		},
		async healthCheck() {
			return true;
		},
	};

	return {
		provider,
		sent,
		reset: () => {
			sent.length = 0;
		},
	};
}

/* -------------------------------------------------------------------------- */
/* Cloudflare Email Service (env.EMAIL binding)                                */
/* -------------------------------------------------------------------------- */

/**
 * Sends through the Cloudflare Email Service binding, `env.EMAIL`.
 *
 * No API key, because the binding carries its own authorisation, and SPF,
 * DKIM and DMARC are configured by Cloudflare when the domain is onboarded.
 * It is also the only provider reachable from an agent over MCP without
 * managing a secret, which is why it is the preferred target.
 */
export const cloudflareProvider: EmailProvider = {
	name: 'cloudflare',

	isConfigured(context) {
		return typeof context.config.binding?.send === 'function';
	},

	async send(message, context) {
		const binding = context.config.binding;
		if (!binding) {
			return failure('cloudflare', new Error('Cloudflare email binding is not available'));
		}

		const payload: CloudflareEmailMessage = {
			from: {
				name: sanitizeHeaderValue(message.fromName ?? context.config.fromName),
				email: sanitizeHeaderValue(message.from ?? context.config.from),
			},
			to: sanitizeHeaderValue(message.to),
			subject: sanitizeHeaderValue(message.subject),
			html: message.html,
			replyTo: sanitizeHeaderValue(message.replyTo ?? context.config.replyTo),
			headers: headerRecord(message.headers),
		};
		if (message.text !== undefined) payload.text = message.text;
		// The binding rejects an empty headers object on some versions.
		if (Object.keys(payload.headers ?? {}).length === 0) delete payload.headers;

		try {
			const result = await binding.send(payload);
			const messageId =
				typeof result === 'object' && result !== null && 'messageId' in result
					? String((result as { messageId: unknown }).messageId)
					: undefined;
			return messageId === undefined
				? { success: true, provider: 'cloudflare' }
				: { success: true, provider: 'cloudflare', messageId };
		} catch (error) {
			context.logger.error('Cloudflare email send failed', { error: String(error) });
			return failure('cloudflare', error);
		}
	},

	async sendBulk(messages, context) {
		const results: SendResult[] = [];
		for (const message of messages) {
			results.push(await cloudflareProvider.send(message, context));
		}
		const failedIndexes = results
			.map((result, index) => (result.success ? -1 : index))
			.filter((index) => index >= 0);
		return {
			success: failedIndexes.length === 0,
			provider: 'cloudflare',
			sent: results.length - failedIndexes.length,
			failed: failedIndexes.length,
			failedRecipients: failedIndexes.map((index) => messages[index]?.to ?? ''),
			results,
		};
	},

	async healthCheck(context) {
		return cloudflareProvider.isConfigured(context);
	},
};

/* -------------------------------------------------------------------------- */
/* Resend (REST)                                                               */
/* -------------------------------------------------------------------------- */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export const resendProvider: EmailProvider = {
	name: 'resend',

	isConfigured(context) {
		return typeof context.config.resendApiKey === 'string' && context.config.resendApiKey.length > 0;
	},

	async send(message, context) {
		const apiKey = context.config.resendApiKey;
		if (!apiKey) {
			return failure('resend', new Error('RESEND_API_KEY is not configured'));
		}

		const body: Record<string, unknown> = {
			from: formatSender(message.fromName ?? context.config.fromName, message.from ?? context.config.from),
			to: [sanitizeHeaderValue(message.to)],
			subject: sanitizeHeaderValue(message.subject),
			html: message.html,
			reply_to: sanitizeHeaderValue(message.replyTo ?? context.config.replyTo),
		};
		if (message.text !== undefined) body.text = message.text;
		const headers = headerRecord(message.headers);
		if (Object.keys(headers).length > 0) body.headers = headers;
		if (message.tags && message.tags.length > 0) body.tags = message.tags;

		try {
			const response = await resolveFetch(context)(RESEND_ENDPOINT, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${apiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
			});

			const raw = await response.text();
			if (!response.ok) {
				return failure('resend', new Error(`Resend responded ${response.status}: ${raw.slice(0, 300)}`));
			}
			let messageId: string | undefined;
			try {
				const parsed = JSON.parse(raw) as { id?: unknown };
				if (typeof parsed.id === 'string') messageId = parsed.id;
			} catch {
				messageId = undefined;
			}
			return messageId === undefined
				? { success: true, provider: 'resend' }
				: { success: true, provider: 'resend', messageId };
		} catch (error) {
			context.logger.error('Resend send failed', { error: String(error) });
			return failure('resend', error);
		}
	},

	async sendBulk(messages, context) {
		const results: SendResult[] = [];
		for (const message of messages) {
			results.push(await resendProvider.send(message, context));
		}
		const failedIndexes = results
			.map((result, index) => (result.success ? -1 : index))
			.filter((index) => index >= 0);
		return {
			success: failedIndexes.length === 0,
			provider: 'resend',
			sent: results.length - failedIndexes.length,
			failed: failedIndexes.length,
			failedRecipients: failedIndexes.map((index) => messages[index]?.to ?? ''),
			results,
		};
	},

	async healthCheck(context) {
		return resendProvider.isConfigured(context);
	},
};

/* -------------------------------------------------------------------------- */
/* Gmail via the Gmail API                                                     */
/* -------------------------------------------------------------------------- */

const GMAIL_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users';

/** Encode a header value, switching to RFC 2047 when it contains non-ASCII. */
function encodeHeaderValue(value: string): string {
	const safe = sanitizeHeaderValue(value);
	if (/^[\x20-\x7e]*$/.test(safe)) return safe;
	return `=?UTF-8?B?${encodeBase64(utf8Encode(safe))}?=`;
}

function buildMime(message: EmailMessage, context: EmailContext): string {
	const from = formatSender(message.fromName ?? context.config.fromName, message.from ?? context.config.from);
	const to = sanitizeHeaderValue(message.to);
	const replyTo = sanitizeHeaderValue(message.replyTo ?? context.config.replyTo);
	const boundary = `ta-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

	const headers: string[] = [
		`From: ${from}`,
		`To: ${to}`,
		`Subject: ${encodeHeaderValue(message.subject)}`,
		`Reply-To: ${replyTo}`,
		'MIME-Version: 1.0',
	];
	for (const header of message.headers ?? []) {
		headers.push(`${sanitizeHeaderValue(header.name)}: ${sanitizeHeaderValue(header.value)}`);
	}

	const textBody = message.text ?? '';
	const parts = [
		`--${boundary}`,
		'Content-Type: text/plain; charset="UTF-8"',
		'Content-Transfer-Encoding: base64',
		'',
		wrapBase64(encodeBase64(utf8Encode(textBody))),
		`--${boundary}`,
		'Content-Type: text/html; charset="UTF-8"',
		'Content-Transfer-Encoding: base64',
		'',
		wrapBase64(encodeBase64(utf8Encode(message.html))),
		`--${boundary}--`,
		'',
	];

	return `${headers.join('\r\n')}\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n${parts.join('\r\n')}`;
}

interface GmailTokenResponse {
	access_token?: unknown;
	error?: unknown;
	error_description?: unknown;
}

/**
 * Sends through the Gmail API.
 *
 * The API rather than SMTP, deliberately: Google's documented daily cap is
 * per user and shared across every client, so SMTP reaches exactly the same
 * ceiling with more moving parts. Used for the conversational lane, and as a
 * fallback only.
 */
export const gmailProvider: EmailProvider = {
	name: 'gmail',

	isConfigured(context) {
		const gmail = context.config.gmail;
		return Boolean(gmail?.clientId && gmail.clientSecret && gmail.refreshToken && gmail.userEmail);
	},

	async send(message, context) {
		const gmail = context.config.gmail;
		if (!gmail) {
			return failure('gmail', new Error('Gmail OAuth2 credentials are not configured'));
		}
		const doFetch = resolveFetch(context);

		try {
			const tokenResponse = await doFetch(GMAIL_TOKEN_ENDPOINT, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'refresh_token',
					client_id: gmail.clientId,
					client_secret: gmail.clientSecret,
					refresh_token: gmail.refreshToken,
				}).toString(),
			});

			const tokenBody = (await tokenResponse.json()) as GmailTokenResponse;
			if (!tokenResponse.ok || typeof tokenBody.access_token !== 'string') {
				const detail =
					typeof tokenBody.error_description === 'string'
						? tokenBody.error_description
						: typeof tokenBody.error === 'string'
							? tokenBody.error
							: `HTTP ${tokenResponse.status}`;
				return failure('gmail', new Error(`Gmail token refresh failed: ${detail}`));
			}

			const mime = buildMime(message, context);
			const sendResponse = await doFetch(
				`${GMAIL_SEND_ENDPOINT}/${encodeURIComponent(gmail.userEmail)}/messages/send`,
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${tokenBody.access_token}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ raw: encodeBase64Url(utf8Encode(mime)) }),
				},
			);

			const raw = await sendResponse.text();
			if (!sendResponse.ok) {
				return failure('gmail', new Error(`Gmail responded ${sendResponse.status}: ${raw.slice(0, 300)}`));
			}
			let messageId: string | undefined;
			try {
				const parsed = JSON.parse(raw) as { id?: unknown };
				if (typeof parsed.id === 'string') messageId = parsed.id;
			} catch {
				messageId = undefined;
			}
			return messageId === undefined
				? { success: true, provider: 'gmail' }
				: { success: true, provider: 'gmail', messageId };
		} catch (error) {
			context.logger.error('Gmail send failed', { error: String(error) });
			return failure('gmail', error);
		}
	},

	async sendBulk(messages, context) {
		const results: SendResult[] = [];
		for (const message of messages) {
			results.push(await gmailProvider.send(message, context));
		}
		const failedIndexes = results
			.map((result, index) => (result.success ? -1 : index))
			.filter((index) => index >= 0);
		return {
			success: failedIndexes.length === 0,
			provider: 'gmail',
			sent: results.length - failedIndexes.length,
			failed: failedIndexes.length,
			failedRecipients: failedIndexes.map((index) => messages[index]?.to ?? ''),
			results,
		};
	},

	async healthCheck(context) {
		return gmailProvider.isConfigured(context);
	},
};

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

/** The built-in providers, keyed by name. Callers may override any of them. */
export const BUILT_IN_PROVIDERS: Readonly<Record<Exclude<ProviderName, 'mock'>, EmailProvider>> = {
	cloudflare: cloudflareProvider,
	resend: resendProvider,
	gmail: gmailProvider,
};
