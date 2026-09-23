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
import { type CacheOptions, type CacheStore } from '../cache/index.js';
import { type Logger } from '../internal/logger.js';
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
export declare const RATE_LIMIT_POLICIES: {
    /** A person typing a message. Five an hour is generous for a human. */
    readonly publicForm: {
        readonly limit: 5;
        readonly windowMs: number;
    };
    /** Newsletter signup. Separate from the contact form so one cannot exhaust the other. */
    readonly newsletterSubscribe: {
        readonly limit: 5;
        readonly windowMs: number;
    };
    /** Failed sign-ins before lockout concern. Tighter window, so a lockout is short. */
    readonly authAttempt: {
        readonly limit: 10;
        readonly windowMs: number;
    };
    /** Password reset and magic-link requests. Tight, because each one sends mail. */
    readonly authEmail: {
        readonly limit: 3;
        readonly windowMs: number;
    };
    /** A campaign send, which is expensive and irreversible. */
    readonly campaignSend: {
        readonly limit: 10;
        readonly windowMs: number;
    };
    /** Read-only JSON endpoints, which a page may legitimately hit often. */
    readonly apiRead: {
        readonly limit: 120;
        readonly windowMs: number;
    };
    /** Anything unclassified. Chosen to be safe rather than permissive. */
    readonly default: {
        readonly limit: 30;
        readonly windowMs: number;
    };
};
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
export declare function resolvePolicy(name: RateLimitPolicyName, overrides?: Partial<RateLimitPolicy>): RateLimitPolicy;
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
export declare class FixedWindowRateLimiter implements RateLimiter {
    private readonly store;
    private readonly keyPrefix;
    private readonly now;
    private readonly logger;
    constructor(options: FixedWindowRateLimiterOptions);
    /**
     * Consume one unit from `key`'s current window.
     *
     * A store failure fails **open**, like Turnstile's transport error: a KV
     * outage must not take the write endpoints down with it. The failure is
     * logged, so a silent degradation is still visible to an operator.
     */
    consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
    /** Consume one unit against a named policy. The call shape most sites want. */
    check(policy: RateLimitPolicyName, key: string, overrides?: Partial<RateLimitPolicy>): Promise<RateLimitResult>;
    /** Best effort: a store without a bulk delete cannot be fully cleared. */
    reset(): Promise<void>;
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
export declare function createRateLimiter(options?: CacheOptions & {
    keyPrefix?: string;
}): ResolvedRateLimiter;
/**
 * Build a `Retry-After` header value from a refusal.
 *
 * Kept here so every surface reports a refusal identically. Clients and crawlers
 * honour this, and hand-rolling the seconds at each call site is how they end up
 * disagreeing with the message in the body.
 */
export declare function retryAfterHeader(result: RateLimitResult): Record<string, string>;
//# sourceMappingURL=rate-limiter.d.ts.map