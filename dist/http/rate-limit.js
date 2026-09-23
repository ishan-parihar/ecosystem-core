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
import { sha256Hex } from '../internal/hash.js';
import { silentLogger } from '../internal/logger.js';
/**
 * A fixed-window counter.
 *
 * Fixed windows rather than sliding so the map holds one entry per key. A
 * boundary burst of up to 2x is acceptable for a contact form and a newsletter
 * signup; the alternative costs an entry per request.
 */
export class InMemoryRateLimiter {
    windows = new Map();
    maxKeys;
    now;
    logger;
    constructor(options = {}) {
        this.maxKeys = options.maxKeys ?? 5_000;
        this.now = options.now ?? Date.now;
        this.logger = options.logger ?? silentLogger;
    }
    /** Number of tracked keys. Exposed for tests and diagnostics. */
    get size() {
        return this.windows.size;
    }
    /** Consume one unit from the key's current window. */
    consume(key, limit, windowMs) {
        const now = this.now();
        this.evictIfOversized(now, windowMs);
        const current = this.windows.get(key);
        if (!current || now - current.startedAt >= windowMs) {
            this.windows.set(key, { count: 1, startedAt: now });
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
        current.count += 1;
        return { allowed: true, remaining: Math.max(0, limit - current.count), retryAfterSec: 0, limit };
    }
    evictIfOversized(now, windowMs) {
        if (this.windows.size <= this.maxKeys)
            return;
        for (const [existingKey, window] of this.windows) {
            if (now - window.startedAt >= windowMs)
                this.windows.delete(existingKey);
        }
        // Still oversized after eviction: drop everything rather than grow.
        // A burst of throughput is recoverable; unbounded memory is not.
        if (this.windows.size > this.maxKeys) {
            this.windows.clear();
            this.logger.warn('Rate limiter map evicted wholesale', { maxKeys: this.maxKeys });
        }
    }
    /** Drop every window. Test-only, and useful as a manual circuit reset. */
    reset() {
        this.windows.clear();
    }
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
export async function hashIp(ip, salt, logger) {
    if (!ip)
        return null;
    try {
        return await sha256Hex(`${salt ?? 'no-salt'}:${ip}`, 32);
    }
    catch (error) {
        (logger ?? silentLogger).warn('IP hashing failed', { error: String(error) });
        return null;
    }
}
/**
 * Read the client IP the edge supplies.
 *
 * `CF-Connecting-IP` is set by Cloudflare and cannot be spoofed by a browser
 * on a proxied request. It is absent in local dev, which is why `null` is a
 * normal outcome rather than an error.
 */
export function clientIp(request) {
    return (request.headers.get('cf-connecting-ip') ??
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        null);
}
const TURNSTILE_ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/**
 * Verify a Turnstile token, when the surface has a secret configured.
 *
 * Fails **open** on a transport error and **closed** on a rejection. Turnstile
 * being unreachable should not cost a real lead, and the rate limiter is still
 * in the path; a token Cloudflare actively rejected is a different signal and
 * is honoured.
 */
export async function verifyTurnstile(options) {
    const { secretKey, token, ip } = options;
    const logger = options.logger ?? silentLogger;
    if (!secretKey)
        return { ok: true, skipped: true };
    if (!token)
        return { ok: false, skipped: false, error: 'missing-token' };
    try {
        const body = new URLSearchParams({ secret: secretKey, response: token });
        if (ip)
            body.set('remoteip', ip);
        const doFetch = options.fetchImpl ?? globalThis.fetch;
        const response = await doFetch(TURNSTILE_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });
        if (!response.ok) {
            return { ok: false, skipped: false, error: `http-${response.status}` };
        }
        const payload = (await response.json());
        return payload.success === true
            ? { ok: true, skipped: false }
            : { ok: false, skipped: false, error: 'rejected' };
    }
    catch (error) {
        logger.error('Turnstile verification errored', { error: String(error) });
        return { ok: true, skipped: false, error: 'transport-error' };
    }
}
//# sourceMappingURL=rate-limit.js.map