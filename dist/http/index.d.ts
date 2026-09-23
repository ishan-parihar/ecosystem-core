/**
 * Abuse handling and browser-side integration.
 *
 * Two limiters live here and both are exported, because they answer different
 * questions:
 *
 * - `InMemoryRateLimiter` is synchronous and per isolate. No binding, no
 *   awaiting, and it throttles a burst hitting one isolate. Fine for
 *   low-traffic surfaces and for tests.
 * - `FixedWindowRateLimiter` takes a `CacheStore`, so the counter can live in
 *   Cloudflare KV and therefore be shared across every isolate. It is
 *   asynchronous, because a KV read is.
 *
 * `createRateLimiter` resolves one from cache configuration, and
 * `RATE_LIMIT_POLICIES` holds the numbers so surfaces stop inventing them.
 *
 * `RateLimitResult` is defined once, in `rate-limiter.ts`, and both limiters
 * return it. Keeping a second copy here would let the two drift, and a caller
 * switching limiters should not have to touch its handling of a refusal.
 */
export type { RateLimiterOptions, TurnstileResult, VerifyTurnstileOptions } from './rate-limit.js';
export { clientIp, hashIp, InMemoryRateLimiter, verifyTurnstile } from './rate-limit.js';
export type { FixedWindowRateLimiterOptions, RateLimitPolicy, RateLimitPolicyName, RateLimitResult, RateLimiter, ResolvedRateLimiter, } from './rate-limiter.js';
export { createRateLimiter, FixedWindowRateLimiter, RATE_LIMIT_POLICIES, resolvePolicy, retryAfterHeader, } from './rate-limiter.js';
export type { TurnstileApi, TurnstileRenderOptions } from './turnstile-widget.js';
export { loadTurnstileScript, mountTurnstile, resetTurnstileScriptCache, } from './turnstile-widget.js';
//# sourceMappingURL=index.d.ts.map