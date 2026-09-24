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
import { createSupabaseRecipientSource } from '@ishan/ecosystem-core/campaign';
import {
	getOrSet,
	MemoryCache,
	resolveCache,
	type CacheStore,
	type KvNamespaceLike,
} from '@ishan/ecosystem-core/cache';
import { PostgrestClient } from '@ishan/ecosystem-core/data';
import { createRateLimiter, mountTurnstile, RATE_LIMIT_POLICIES } from '@ishan/ecosystem-core/http';
import { summarizeDelivery, summarizeByLane } from '@ishan/ecosystem-core/monitoring';
import { createCacheLockoutStore, Lockout, lockoutKey } from '@ishan/ecosystem-core/security';
import { mintToken, verifyToken } from '@ishan/ecosystem-core/subscribers';
import { verifyTokenCompat } from '@ishan/ecosystem-core/tokens';
import {
	createRazorpayClient,
	RazorpayApiError,
	type RazorpayClient,
} from '@ishan/ecosystem-core/payments';
import {
	createSessionService,
	hasPermission,
	hasPremiumAccess,
	resolveRole,
	type ProfileLike,
	type SessionUser,
} from '@ishan/ecosystem-core/auth';

declare const platformEnv: {
	EMAIL?: { send(message: unknown): Promise<unknown> };
	KV?: KvNamespaceLike;
	RAZORPAY_WEBHOOK_SECRET?: string;
};
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

/**
 * Exercise every added subpath, so a release that does not ship one of them
 * fails here rather than in whichever surface adopts it first.
 */
export async function exerciseModules(): Promise<string[]> {
	const notes: string[] = [];

	const cache: CacheStore = new MemoryCache({ maxEntries: 10 });
	notes.push(`cache:${(await resolveCache({ kv: platformEnv.KV })).backend}`);
	notes.push(`cached:${await getOrSet(cache, 'k', 60, async () => 'v')}`);

	const { limiter, backend } = createRateLimiter({ kv: platformEnv.KV });
	notes.push(`limiter:${backend}:${(await limiter.check('publicForm', 'ip')).limit}`);
	notes.push(`policies:${Object.keys(RATE_LIMIT_POLICIES).length}`);

	const lockout = new Lockout({ store: createCacheLockoutStore(cache), policy: 'authPassword' });
	notes.push(`lockout:${(await lockout.recordFailure(lockoutKey('auth', 'a@b.co', '1.2.3.4'))).remainingAttempts}`);

	const samples = [{ at: Date.now(), success: true, lane: 'transactional' as const }];
	notes.push(`metrics:${summarizeDelivery(samples, { thresholds: { minSamples: 1 } }).successRate}`);
	notes.push(`lanes:${Object.keys(summarizeByLane(samples).lanes).length}`);

	// Legacy scheme accepted only when asked for; canonical always.
	const canonical = await mintToken({ purpose: 'confirm', email: 'a@b.co' }, { secret: 's', expiresInSec: 0 });
	const compat = await verifyTokenCompat(canonical, { secret: 's' });
	notes.push(`compat:${compat.valid ? compat.scheme : 'rejected'}`);

	notes.push(`recipients:${createSupabaseRecipientSource(db) ? 'ok' : 'null'}`);

	notes.push(
		`payments:${await razorpay.verifyPaymentSignature('order_1', 'pay_1', 'deadbeef')}`,
	);
	notes.push(
		`webhook:${await razorpay.verifyWebhookSignature('{}', 'deadbeef')}`,
	);

	const session = await sessionFor({ id: 'user_1', email: 'a@b.co' }).requirePremium();
	notes.push(`session:${session ? session.role : 'none'}`);
	return notes;
}

/*
 * Payments: credentials injected per request, never read from an environment.
 * `platformEnv` here stands in for `event.platform.env`.
 */
export const razorpay: RazorpayClient = createRazorpayClient({
	keyId: 'rzp_injected_key_id',
	keySecret: 'injected_key_secret',
	webhookSecret: platformEnv.RAZORPAY_WEBHOOK_SECRET,
	logger,
});

export function describePaymentError(error: unknown): string {
	if (error instanceof RazorpayApiError) return `${error.status}:${error.code ?? 'unknown'}`;
	return 'unknown';
}

/*
 * Auth: the surface supplies the session, the package supplies the rules.
 * Nothing here reaches for Supabase - these ports are pure fixtures, which is
 * the point of taking data access as an argument.
 */
export function sessionFor(user: SessionUser | null): ReturnType<typeof createSessionService> {
	return createSessionService({
		loadUser: async () => user,
		loadProfile: async (userId) =>
			({ id: userId, email: user?.email, tier: 'sovereign' }) satisfies ProfileLike,
		logger,
	});
}

export const access = (profile: ProfileLike | null): string =>
	`${resolveRole(profile)}:${hasPremiumAccess(profile)}:${hasPermission(profile, 'publish')}`;

export async function roundTrip(email: string): Promise<boolean> {
	const token = await mintToken(
		{ purpose: 'confirm', email },
		{ secret: 'injected-secret', expiresInSec: 60 },
	);
	const verified = await verifyToken(token, { secret: 'injected-secret', expectedPurpose: 'confirm' });
	const turnstile = await verifyTurnstile({ secretKey: undefined, token: undefined });
	return verified.valid && turnstile.ok;
}
