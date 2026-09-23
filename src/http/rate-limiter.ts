/**
 * Store-backed rate limiting, plus the shared policy table.
 *
 * `rate-limit.ts` holds the original `InMemoryRateLimiter`, which is
 * synchronous and per isolate. It is still exported and still fine for the case
 * it was written for, but it cannot throttle a burst spread across isolates, and
 * a Worker surface almost always runs several. This module is the durable
 * version: the same fixed-window algorithm over an injected `CacheStore`, so the
 * counter can live in Cloudflare KV.
 *
 * ## The honest limitation
 *
 * Fixed-window over KV is a read-modify-write, so two requests landing in the
 * same millisecond can both read the same count and both be allowed. The window
 * is therefore a *speed bump*, not an invariant: under real concurrency the
 * effective limit is the configured one plus whatever raced. That is an
 * acceptable trade for form spam, and it is the wrong tool for anything that
 * has to be exactly-once. When it must be exact, the counter belongs in a
 * Durable Object, whose storage is single-threaded per key. Nothing in the
 * signature changes if that swap happens: only the `CacheStore` does.
 *
 * ## Why an async interface rather than extending the existing class
 *
 * KV reads are asynchronous, so a durable limiter cannot have the synchronous
 * `consume` the in-memory one has. Rather than change that signature and break
 * every existing call site, this module introduces `RateLimiter` as its own
 * interface. A consumer adopts it when it wants durability, and the in-memory
 * class stays exactly as it was for the consumers that do not.
 */

import { resolveCache, type CacheOptions, type CacheStore } from '../cache/index.js';
import { resolveLogger, type Logger } from '../internal/logger.js';

export interface RateLimitResult {
	allowed: boolean;
	/** Units left in this window. `0` when the request was refused. */
	remaining: number;
	/** Seconds until the window resets. `0` when the request was allowed. */
	retryAfterSec: number;
	/** The limit that applied, so a caller can build a `Retry-After` or a header set. */
	limit: number;
}

export interface RateLimiter {
	consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
	reset(): Promise<void>;
}

/**
 * A named allowance, so surfaces do not each invent their own numbers.
 *
 * The values are deliberately conservative on the write paths. A genuine
 * enquiry or a genuine signup is a considered act; if a real person trips one of
 * these, the message says so and offers the email address, which is what makes a
 * tight limit safe to ship.
 */
export const RATE_LIMIT_POLICIES = {
	/** A person typing a message. Five an hour is generous for a human. */
	publicForm: { limit: 5, windowMs: 60 * 60 * 1000 },
	/** Newsletter signup. Separate from the contact form so one cannot exhaust the other. */
	newsletterSubscribe: { limit: 5, windowMs: 60 * 60 * 1000 },
	/** Failed sign-ins before lockout concern. Tighter window, so a lockout is short. */
	authAttempt: { limit: 10, windowMs: 15 * 60 * 1000 },
	/** Password reset and magic-link requests. Tight, because each one sends mail. */
	authEmail: { limit: 3, windowMs: 60 * 60 * 1000 },
	/** A campaign send, which is expensive and irreversible. */
	campaignSend: { limit: 10, windowMs: 60 * 60 * 1000 },
	/** Read-only JSON endpoints, which a page may legitimately hit often. */
	apiRead: { limit: 120, windowMs: 60 * 1000 },
	/** Anything unclassified. Chosen to be safe rather than permissive. */
	default: { limit: 30, windowMs: 60 * 1000 },
} as const;

export type RateLimitPolicyName = keyof typeof RATE_LIMIT_POLICIES;

export interface RateLimitPolicy {
	limit: number;
	windowMs: number;
}

/**
 * Resolve a named policy, with per-surface overrides.
 *
 * Overrides exist so a surface can tighten a shared policy without forking the
 * table. Loosening one is possible too, which is deliberate: the operator owns
 * the trade-off, and a surface that needs 50 messages an hour should be able to
 * say so in one place rather than in a private copy of the numbers.
 */
export function resolvePolicy(
	name: RateLimitPolicyName,
	overrides: Partial<RateLimitPolicy> = {},
): RateLimitPolicy {
	const base = RATE_LIMIT_POLICIES[name];
	return {
		limit: overrides.limit ?? base.limit,
		windowMs: overrides.windowMs ?? base.windowMs,
	};
}

interface Window {
	count: number;
	/** Epoch milliseconds when this window opened. */
	startedAt: number;
}

export interface FixedWindowRateLimiterOptions {
	store: CacheStore;
	/** Namespace so two limiters cannot collide in one KV namespace. */
	keyPrefix?: string;
	/** Injectable clock in milliseconds. */
	now?: () => number;
	logger?: Logger;
}

/**
 * A fixed window counter over any `CacheStore`.
 *
 * Fixed windows rather than sliding, for one reason: the store holds a single
 * entry per key, so memory and KV usage stay proportional to the number of
 * distinct keys rather than to the request rate. The cost is the classic
 * boundary burst, where a caller can spend a full allowance at the end of one
 * window and another at the start of the next. For form spam that is fine.
 */
export class FixedWindowRateLimiter implements RateLimiter {
	private readonly store: CacheStore;
	private readonly keyPrefix: string;
	private readonly now: () => number;
	private readonly logger: Logger;

	constructor(options: FixedWindowRateLimiterOptions) {
		this.store = options.store;
		this.keyPrefix = options.keyPrefix ?? 'ratelimit:';
		this.now = options.now ?? Date.now;
		this.logger = resolveLogger(options.logger);
	}

	/**
	 * Consume one unit from `key`'s current window.
	 *
	 * A store failure fails **open**, like Turnstile's transport error: a KV
	 * outage must not take the write endpoints down with it. The failure is
	 * logged, so a silent degradation is still visible to an operator.
	 */
	async consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
		const now = this.now();
		const full = `${this.keyPrefix}${key}`;

		let current: Window | null = null;
		try {
			current = await this.store.get<Window>(full);
		} catch (error) {
			this.logger.warn('Rate limit read failed; allowing the request', {
				key: full,
				error: String(error),
			});
			return { allowed: true, remaining: limit, retryAfterSec: 0, limit };
		}

		if (current === null || now - current.startedAt >= windowMs) {
			// TTL is the window length so an idle key disappears on its own; a
			// store that never expires entries would grow without bound.
			await this.store.set(full, { count: 1, startedAt: now }, Math.ceil(windowMs / 1000));
			return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterSec: 0, limit };
		}

		if (current.count >= limit) {
			const elapsed = now - current.startedAt;
			return {
				allowed: false,
				remaining: 0,
				retryAfterSec: Math.max(1, Math.ceil((windowMs - elapsed) / 1000)),
				limit,
			};
		}

		const next: Window = { count: current.count + 1, startedAt: current.startedAt };
		await this.store.set(full, next, Math.ceil(windowMs / 1000));
		return { allowed: true, remaining: Math.max(0, limit - next.count), retryAfterSec: 0, limit };
	}

	/** Consume one unit against a named policy. The call shape most sites want. */
	async check(
		policy: RateLimitPolicyName,
		key: string,
		overrides: Partial<RateLimitPolicy> = {},
	): Promise<RateLimitResult> {
		const resolved = resolvePolicy(policy, overrides);
		return this.consume(key, resolved.limit, resolved.windowMs);
	}

	/** Best effort: a store without a bulk delete cannot be fully cleared. */
	async reset(): Promise<void> {
		await this.store.delete(this.keyPrefix);
	}
}

export interface ResolvedRateLimiter {
	limiter: FixedWindowRateLimiter;
	/** The backend actually in use, so a surface can log or assert it. */
	backend: 'kv' | 'memory';
	degradedReason?: string;
}

/**
 * Resolve a rate limiter from cache configuration.
 *
 * Takes `CacheOptions` directly rather than its own option bag, because the
 * limiter *is* a cache consumer and duplicating the backend vocabulary would let
 * the two disagree about what `kv` means.
 */
export function createRateLimiter(options: CacheOptions & { keyPrefix?: string } = {}): ResolvedRateLimiter {
	const resolved = resolveCache(options);
	const limiter = new FixedWindowRateLimiter({
		store: resolved.store,
		...(options.keyPrefix === undefined ? {} : { keyPrefix: options.keyPrefix }),
		...(options.logger === undefined ? {} : { logger: options.logger }),
	});
	return {
		limiter,
		backend: resolved.backend,
		...(resolved.degradedReason === undefined ? {} : { degradedReason: resolved.degradedReason }),
	};
}

/**
 * Build a `Retry-After` header value from a refusal.
 *
 * Kept here so every surface reports a refusal identically. Clients and crawlers
 * honour this, and hand-rolling the seconds at each call site is how they end up
 * disagreeing with the message in the body.
 */
export function retryAfterHeader(result: RateLimitResult): Record<string, string> {
	return result.allowed ? {} : { 'Retry-After': String(result.retryAfterSec) };
}
