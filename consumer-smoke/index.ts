/**
 * Standalone consumer typecheck.
 *
 * This file exists to prove the thing a package README cannot: that a brand
 * new TypeScript project, with no knowledge of this repository, resolves the
 * types for every subpath from the published tag and can call the factories
 * with the intended shapes.
 *
 * It is deliberately strict, and it deliberately exercises the injection
 * contract from the consumer side: config and handles are passed in, nothing is
 * read from an environment.
 */

import {
	createEmailService,
	createPostgrest,
	createSupabaseSubscriberTable,
	InMemoryRateLimiter,
	listUnsubscribeHeaders,
	SubscriberStore,
	silentLogger,
	verifyTurnstile,
	wrapCampaignContent,
	type EmailTheme,
	type Logger,
} from '@ishan/ecosystem-core';
import { PostgrestClient } from '@ishan/ecosystem-core/data';
import { mountTurnstile } from '@ishan/ecosystem-core/http';
import { mintToken, verifyToken } from '@ishan/ecosystem-core/subscribers';

declare const platformEnv: { EMAIL?: { send(message: unknown): Promise<unknown> }; KV?: unknown };
declare const container: HTMLElement;

const logger: Logger = silentLogger;

const theme: EmailTheme = {
	name: 'consumer-smoke',
	accent: '#111111',
	accentInk: '#ffffff',
	ground: '#f5f5f5',
	panel: '#ffffff',
	ink: '#111111',
	inkMuted: '#666666',
	border: '#dddddd',
	brandName: 'Consumer',
	brandTagline: 'typecheck only',
	footerIdentity: 'Consumer smoke test',
	replyTo: 'hello@example.com',
	siteUrl: 'https://example.com',
};

/* Email: the binding is injected, and the factory is called per request. */
export function emailFor(env: typeof platformEnv = platformEnv) {
	return createEmailService({
		provider: 'cloudflare',
		from: 'no-reply@tx.example.com',
		fromName: 'Consumer',
		replyTo: 'hello@example.com',
		theme,
		binding: env.EMAIL,
		logger,
	});
}

/* Data: a client for the shared project, built from injected values. */
const db = createPostgrest({
	url: 'https://project.supabase.co',
	serviceRoleKey: 'service-role-key',
	logger,
});

export const dbClient: PostgrestClient | null = db;

/* Subscribers: the package supplies the adapter, the caller supplies the handle. */
export const table = createSupabaseSubscriberTable(db);
export const store = table
	? new SubscriberStore(table, {
			tokenSecret: 'injected-secret',
			confirmTtlSec: 604_800,
			unsubscribeTtlSec: 0,
			siteUrl: 'https://example.com',
			defaultSource: 'consumer-smoke',
		})
	: null;

/* HTTP: the limiter is per isolate, the widget loader is per document. */
export const limiter = new InMemoryRateLimiter({ logger });
export const teardown = (): void => {
	mountTurnstile(container, 'site-key', () => undefined)();
};

/**
 * The non-Cloudflare consumer, same shape the README documents.
 *
 * `ishanparihar-cms` is a Node process, not a Workers isolate, and it needs the
 * token and rendering half of the package rather than the subscriber store: it
 * mints the unsubscribe link a surface will later verify. Keeping this here
 * means the README's Node recipe is compiled on every run instead of rotting.
 */
export async function buildCampaignEmail(input: {
	address: string;
	subject: string;
	bodyHtml: string;
	secret: string;
	surfaceUrl: string;
}): Promise<{ html: string; headers: ReturnType<typeof listUnsubscribeHeaders> }> {
	const token = await mintToken(
		{ purpose: 'newsletter_unsubscribe', email: input.address },
		{ secret: input.secret, expiresInSec: 0 },
	);
	const unsubscribeUrl = `${input.surfaceUrl}/newsletter/unsubscribe?token=${encodeURIComponent(token)}`;
	return {
		html: wrapCampaignContent(input.bodyHtml, { theme, unsubscribeUrl }),
		headers: listUnsubscribeHeaders(unsubscribeUrl),
	};
}

export async function roundTrip(email: string): Promise<boolean> {
	const token = await mintToken(
		{ purpose: 'confirm', email },
		{ secret: 'injected-secret', expiresInSec: 60 },
	);
	const verified = await verifyToken(token, { secret: 'injected-secret', expectedPurpose: 'confirm' });
	const turnstile = await verifyTurnstile({ secretKey: undefined, token: undefined });
	return verified.valid && turnstile.ok;
}
