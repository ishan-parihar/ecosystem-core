/**
 * The email service factory.
 *
 * `createEmailService(config)` is called **per request**, never at module
 * scope, because the Cloudflare email binding lives on `event.platform.env`
 * and therefore changes between requests. The hub's current
 * `export const emailProvider = EmailProviderFactory.getProvider()` is the
 * exact pattern this replaces.
 */

import type {
	BatchResult,
	EmailConfig,
	EmailContext,
	EmailLogger,
	EmailMessage,
	EmailProvider,
	ProviderName,
	ProviderStatus,
	SendResult,
} from './types.js';
import { EmailConfigError, silentLogger } from './types.js';
import { BUILT_IN_PROVIDERS, createMockProvider } from './providers.js';
import { isEmailAddress, listUnsubscribeHeaders, type RenderedEmail } from './render.js';

export interface EmailServiceOptions {
	/** Override or inject providers. The test suite uses this for the mock. */
	providers?: Partial<Record<ProviderName, EmailProvider>>;
	logger?: EmailLogger;
}

/** Options for sending an already-rendered template. */
export interface SendRenderedOptions {
	toBe: string;
	replyTo?: string;
	headers?: EmailMessage['headers'];
	tags?: EmailMessage['tags'];
	/** Adds RFC 8058 one-click headers. Required for bulk mail. */
	unsubscribeUrl?: string;
	unsubscribeMailto?: string;
}

export class EmailService {
	readonly provider: EmailProvider;
	private readonly context: EmailContext;

	constructor(provider: EmailProvider, context: EmailContext) {
		this.provider = provider;
		this.context = context;
	}

	/** Which transport this instance will use. */
	get providerName(): ProviderName {
		return this.provider.name;
	}

	async send(message: EmailMessage): Promise<SendResult> {
		if (!isEmailAddress(message.to)) {
			return { success: false, provider: this.provider.name, error: `Invalid recipient: ${message.to}` };
		}
		return this.provider.send(message, this.context);
	}

	async sendBulk(messages: EmailMessage[]): Promise<BatchResult> {
		return this.provider.sendBulk(messages, this.context);
	}

	/** Send a rendered template, wiring headers and defaults in one place. */
	async sendRendered(rendered: RenderedEmail, options: SendRenderedOptions): Promise<SendResult> {
		const headers: EmailMessage['headers'] = [...(options.headers ?? [])];
		if (options.unsubscribeUrl) {
			headers.push(
				...listUnsubscribeHeaders(options.unsubscribeUrl, options.unsubscribeMailto),
			);
		}

		const message: EmailMessage = {
			to: options.toBe,
			subject: rendered.subject,
			html: rendered.html,
			text: rendered.text,
			headers,
		};
		if (options.replyTo !== undefined) message.replyTo = options.replyTo;
		if (options.tags !== undefined) message.tags = options.tags;
		return this.send(message);
	}

	async getStatus(): Promise<ProviderStatus> {
		const configured = this.provider.isConfigured(this.context);
		return {
			provider: this.provider.name,
			configured,
			healthy: configured ? await this.provider.healthCheck(this.context) : false,
		};
	}

	async healthCheck(): Promise<boolean> {
		try {
			return await this.provider.healthCheck(this.context);
		} catch (error) {
			this.context.logger.error('Email health check threw', { error: String(error) });
			return false;
		}
	}
}

function resolveProvider(name: ProviderName, options: EmailServiceOptions | undefined): EmailProvider {
	const override = options?.providers?.[name];
	if (override) return override;

	if (name === 'mock') {
		throw new EmailConfigError(
			'mock',
			"The mock provider is never selected implicitly. Pass { providers: { mock: createMockProvider().provider } } to enable it.",
		);
	}
	return BUILT_IN_PROVIDERS[name];
}

function assertSender(provider: ProviderName, config: EmailConfig): void {
	if (!isEmailAddress(config.from)) {
		throw new EmailConfigError(provider, `EmailConfig.from is not a valid address: "${config.from}"`);
	}
	if (!isEmailAddress(config.replyTo)) {
		throw new EmailConfigError(
			provider,
			`EmailConfig.replyTo is not a valid address: "${config.replyTo}"`,
		);
	}
	if (!config.theme || !config.theme.accent || !config.theme.ink) {
		throw new EmailConfigError(provider, 'EmailConfig.theme is incomplete.');
	}
}

/**
 * Build an email service for one request.
 *
 * Throws {@link EmailConfigError} when the requested provider is missing
 * configuration. Failing here, at construction, is deliberate: a service that
 * constructs successfully and then drops mail is worse than one that refuses
 * to start.
 */
export function createEmailService(config: EmailConfig, options?: EmailServiceOptions): EmailService {
	const provider = resolveProvider(config.provider, options);
	assertSender(provider.name, config);

	const context: EmailContext = {
		config,
		logger: options?.logger ?? config.logger ?? silentLogger,
		fetchImpl: config.fetchImpl ?? globalThis.fetch,
	};

	if (!provider.isConfigured(context)) {
		throw new EmailConfigError(
			provider.name,
			`Provider "${provider.name}" is not configured. Provide the credentials it needs in EmailConfig.`,
		);
	}

	return new EmailService(provider, context);
}

/** Re-exported so an application can build a mock service without the registry. */
export { createMockProvider };
