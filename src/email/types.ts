/**
 * Email core: types, provider contract, and configuration.
 *
 * INJECTION CONTRACT (binding on every file in this package):
 *   - no `$env/*`, `$lib/*`, `$app/*`, `import.meta.env`
 *   - no `node:*` builtins
 *   - no module-level singletons that read configuration at import time
 *
 * Everything a provider needs arrives as an argument, because Cloudflare
 * bindings are per-request (`event.platform.env`), not per-process.
 */

import type { Logger } from '../internal/logger.js';

/** Which transport actually performs the send. */
export type ProviderName = 'cloudflare' | 'resend' | 'gmail' | 'mock';

/**
 * Per-surface branding. The theme is an argument, never a fork of the
 * renderer, so one template tree serves every surface with its own colours.
 */
export interface EmailTheme {
	/** Used for error messages and the mock provider's log prefix. */
	name: string;
	/** Accent colour, hex. Buttons and rules. */
	accent: string;
	/** Text colour placed on top of `accent`. */
	accentInk: string;
	/** Page background behind the panel. */
	ground: string;
	/** The message card itself. */
	panel: string;
	/** Body text. */
	ink: string;
	/** Secondary text. */
	inkMuted: string;
	/** Hairlines. */
	border: string;
	/** Wordmark shown in the header. */
	brandName: string;
	/** Small line under the wordmark. */
	brandTagline: string;
	/** One-line identity in the footer. */
	footerIdentity: string;
	/** Postal address for CAN-SPAM. Optional in development. */
	footerAddress?: string;
	/** Where a human reply should land. Bound to the Gmail mailbox. */
	replyTo: string;
	/** Absolute origin used to build unsubscribe links, no trailing slash. */
	siteUrl: string;
	fontStack?: string;
	monoStack?: string;
}

/** A single header pair, so the core stays free of DOM `Headers`. */
export interface EmailHeader {
	name: string;
	value: string;
}

/** One outbound message. `from`/`fromName`/`replyTo` default from config. */
export interface EmailMessage {
	to: string;
	subject: string;
	html: string;
	text?: string;
	from?: string;
	fromName?: string;
	replyTo?: string;
	headers?: EmailHeader[];
	/** Provider-side categorisation. Resend uses these; the others ignore them. */
	tags?: EmailHeader[];
}

export interface SendResult {
	success: boolean;
	provider: ProviderName;
	messageId?: string;
	error?: string;
}

export interface BatchResult {
	success: boolean;
	provider: ProviderName;
	sent: number;
	failed: number;
	failedRecipients: string[];
	results: SendResult[];
}

export interface ProviderStatus {
	provider: ProviderName;
	configured: boolean;
	healthy: boolean;
	detail?: string;
}

/** Gmail OAuth2 credentials. The API is used, never SMTP: the cap is per account. */
export interface GmailCredentials {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
	userEmail: string;
}

/**
 * The Cloudflare Email Service binding, `env.EMAIL`.
 *
 * Declared structurally so the package does not depend on `@cloudflare/workers-types`.
 * A `wrangler`-generated `SendEmail` binding satisfies this shape.
 */
export interface CloudflareEmailBinding {
	send(message: CloudflareEmailMessage): Promise<unknown>;
}

export interface CloudflareEmailMessage {
	from: string | { name: string; email: string };
	to: string | string[];
	subject: string;
	html?: string;
	text?: string;
	replyTo?: string;
	headers?: Record<string, string>;
}

/**
 * Injected logger.
 *
 * An alias for the package-wide `Logger` rather than its own interface, so a
 * consumer passes one logger object to email, rate limiting and data access
 * and it type-checks everywhere.
 */
export type EmailLogger = Logger;

/** Everything the email layer needs, supplied by the consuming application. */
export interface EmailConfig {
	provider: ProviderName;
	/** Envelope sender, e.g. `no-reply@tx.example.com`. Lane-scoped. */
	from: string;
	fromName: string;
	replyTo: string;
	theme: EmailTheme;
	/** Cloudflare Email Service binding, injected per request. */
	binding?: CloudflareEmailBinding;
	resendApiKey?: string;
	gmail?: GmailCredentials;
	logger?: EmailLogger;
	/** Swappable for tests. Defaults to the global `fetch`. */
	fetchImpl?: typeof fetch;
}

/** Resolved, non-optional context handed to every provider call. */
export interface EmailContext {
	config: EmailConfig;
	logger: EmailLogger;
	fetchImpl: typeof fetch;
}

/** The provider contract. Providers are stateless and receive the context. */
export interface EmailProvider {
	readonly name: ProviderName;
	/** True when this provider has everything it needs to attempt a send. */
	isConfigured(context: EmailContext): boolean;
	send(message: EmailMessage, context: EmailContext): Promise<SendResult>;
	sendBulk(messages: EmailMessage[], context: EmailContext): Promise<BatchResult>;
	healthCheck(context: EmailContext): Promise<boolean>;
}

/** Raised at construction, never at send time, so misconfiguration is loud. */
export class EmailConfigError extends Error {
	readonly provider: ProviderName;

	constructor(provider: ProviderName, message: string) {
		super(message);
		this.name = 'EmailConfigError';
		this.provider = provider;
	}
}

/** A logger that discards everything. Keeps the package silent by default. */
export { silentLogger } from '../internal/logger.js';
