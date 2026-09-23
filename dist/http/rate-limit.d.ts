/**
 * Abuse handling for public write endpoints.
 *
 * Layered deliberately, weakest to strongest:
 *
 *   1. honeypot and dwell-time checks, handled by the caller
 *   2. this rate limiter, best-effort and in-isolate
 *   3. Cloudflare Turnstile, when a secret is configured
 *
 * The rate limiter is honest about what it is. A Worker isolate is ephemeral
 * and there can be several of them, so an in-isolate map throttles bursts
 * hitting one isolate and nothing more. It is a speed bump, not a security
 * boundary. Swapping it for a durable counter is a matter of implementing the
 * same `consume` signature against KV or Durable Objects, which is why the
 * class shape is fixed even though the default is in-memory.
 */
import type { Logger } from '../internal/logger.js';
import type { RateLimitResult } from './rate-limiter.js';
export interface RateLimiterOptions {
    /** Upper bound on tracked keys, so a flood of unique keys cannot grow memory. */
    maxKeys?: number;
    /** Injectable clock in milliseconds. */
    now?: () => number;
    /** Called when the map is evicted under pressure. */
    logger?: Logger;
}
/**
 * A fixed-window counter.
 *
 * Fixed windows rather than sliding so the map holds one entry per key. A
 * boundary burst of up to 2x is acceptable for a contact form and a newsletter
 * signup; the alternative costs an entry per request.
 */
export declare class InMemoryRateLimiter {
    private readonly windows;
    private readonly maxKeys;
    private readonly now;
    private readonly logger;
    constructor(options?: RateLimiterOptions);
    /** Number of tracked keys. Exposed for tests and diagnostics. */
    get size(): number;
    /** Consume one unit from the key's current window. */
    consume(key: string, limit: number, windowMs: number): RateLimitResult;
    private evictIfOversized;
    /** Drop every window. Test-only, and useful as a manual circuit reset. */
    reset(): void;
}
/**
 * Hash a client IP for storage.
 *
 * Stored hashed rather than raw: it is enough to spot a repeat sender or to
 * rate limit, and a table holding plaintext IPs is a liability with no matching
 * benefit. Salted so the hash is not reversible by a rainbow table across
 * deployments. Returns `null` when there is nothing to hash or hashing fails,
 * because a missing identifier must never block the request.
 */
export declare function hashIp(ip: string | null, salt: string | undefined, logger?: Logger): Promise<string | null>;
/**
 * Read the client IP the edge supplies.
 *
 * `CF-Connecting-IP` is set by Cloudflare and cannot be spoofed by a browser
 * on a proxied request. It is absent in local dev, which is why `null` is a
 * normal outcome rather than an error.
 */
export declare function clientIp(request: Request): string | null;
export interface TurnstileResult {
    /** False only when verification actively failed. */
    ok: boolean;
    skipped: boolean;
    error?: string;
}
export interface VerifyTurnstileOptions {
    /** Absent means the surface has not enabled Turnstile; the check is skipped. */
    secretKey: string | undefined;
    token: string | undefined;
    ip?: string | null;
    fetchImpl?: typeof fetch;
    logger?: Logger;
}
/**
 * Verify a Turnstile token, when the surface has a secret configured.
 *
 * Fails **open** on a transport error and **closed** on a rejection. Turnstile
 * being unreachable should not cost a real lead, and the rate limiter is still
 * in the path; a token Cloudflare actively rejected is a different signal and
 * is honoured.
 */
export declare function verifyTurnstile(options: VerifyTurnstileOptions): Promise<TurnstileResult>;
//# sourceMappingURL=rate-limit.d.ts.map