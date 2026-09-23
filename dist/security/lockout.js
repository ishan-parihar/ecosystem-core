/**
 * Brute-force lockout.
 *
 * Escalating protection for credential and mail-sending endpoints: count
 * failures per key inside a window, and once the threshold is crossed refuse
 * until a cooldown elapses. A successful attempt clears the record.
 *
 * ## What this replaces
 *
 * The hub's `auth/account-lockout.ts` does this, and it has three problems that
 * a shared implementation should not inherit:
 *
 * 1. **It is hard-wired to one table.** Every query names `login_attempts` and
 *    the hub's Supabase client, so no other surface can use it, and the table
 *    schema has become an accidental API.
 * 2. **It is typed `any` throughout.** `LoginAttempt`, the Supabase response
 *    casts, and the row payloads all opt out of the type system, which is how
 *    the `Database['public']['Tables']['login_attempts']['Update']` cast and the
 *    `as any` ended up in the same function.
 * 3. **It fails open without saying so.** Every catch returns
 *    `{ locked: false, attempts: 0 }`, which is the right default and an
 *    invisible one.
 *
 * The rules are kept identical in behaviour, because they are sensible. What
 * changes is that the storage is injected, the types are real, and a decision
 * is reported rather than guessed at.
 *
 * ## Storage is a decision, not an assumption
 *
 * A lockout wants durable state: an attacker retrying across isolates must meet
 * the same counter every time, so an in-isolate map is the wrong store and KV is
 * the right one. `createCacheLockoutStore` satisfies that with the cache module.
 * A surface that would rather keep this in Postgres implements `LockoutStore`
 * itself, which is a small interface on purpose.
 */
import { resolveLogger } from '../internal/logger.js';
/**
 * Named policies, so surfaces share the numbers.
 *
 * `authPassword` matches the hub's existing defaults, so adopting this does not
 * change behaviour for a surface already using the lockout.
 */
export const LOCKOUT_POLICIES = {
    /** The hub's current default: 5 failures in 15 minutes, locked for 15. */
    authPassword: { maxAttempts: 5, windowMs: 15 * 60 * 1000, lockoutMs: 15 * 60 * 1000 },
    /** Magic links and resets: each attempt sends mail, so tolerance is lower. */
    authEmail: { maxAttempts: 3, windowMs: 60 * 60 * 1000, lockoutMs: 60 * 60 * 1000 },
    /** Turnstile or a captcha repeatedly rejected. */
    captcha: { maxAttempts: 8, windowMs: 30 * 60 * 1000, lockoutMs: 30 * 60 * 1000 },
};
export function resolveLockoutPolicy(name, overrides = {}) {
    const base = LOCKOUT_POLICIES[name];
    return {
        maxAttempts: overrides.maxAttempts ?? base.maxAttempts,
        windowMs: overrides.windowMs ?? base.windowMs,
        lockoutMs: overrides.lockoutMs ?? base.lockoutMs,
    };
}
/** Key a lockout on an identity plus, optionally, where it came from. */
export function lockoutKey(scope, subject, ip) {
    const normalized = subject.trim().toLowerCase();
    // The IP is included when present so one address cannot lock out a whole
    // organisation, and omitted when absent rather than becoming the string
    // "undefined", which would pool every anonymous attempt together.
    return ip ? `${scope}:${normalized}:${ip}` : `${scope}:${normalized}`;
}
/**
 * A lockout over an injected store.
 *
 * Every method fails open on a store error and logs the reason. A lockout that
 * cannot read its own state must not refuse legitimate traffic: the alternative
 * is that a storage blip locks every user out of the surface at once.
 */
export class Lockout {
    store;
    policy;
    now;
    retentionSlackSec;
    logger;
    constructor(options) {
        this.store = options.store;
        this.policy =
            typeof options.policy === 'string' ? resolveLockoutPolicy(options.policy) : options.policy;
        this.now = options.now ?? Date.now;
        this.retentionSlackSec = options.retentionSlackSec ?? 0;
        this.logger = resolveLogger(options.logger);
    }
    ttlSec() {
        return Math.ceil((this.policy.windowMs + this.policy.lockoutMs) / 1000) + this.retentionSlackSec;
    }
    /** Read the current state without changing it. */
    async check(key) {
        let record = null;
        try {
            record = await this.store.read(key);
        }
        catch (error) {
            this.logger.warn('Lockout read failed; treating the key as unlocked', {
                key,
                error: String(error),
            });
            return this.unlockedState(0);
        }
        return this.project(record);
    }
    /**
     * Count a failure and return the resulting state.
     *
     * A failure outside the window starts a new window: an attacker who gives up
     * for an hour should not be one attempt from a lock when they return.
     */
    async recordFailure(key) {
        const now = this.now();
        let record = null;
        try {
            record = await this.store.read(key);
        }
        catch (error) {
            this.logger.warn('Lockout read failed; not recording a failure', { key, error: String(error) });
            return this.unlockedState(0);
        }
        // A record that is already locked is deliberately not "in window": its
        // count has done its job, and the lock expiry is carried forward below.
        const prior = record;
        const inWindow = prior !== null && prior.lockedUntilMs === null && now - prior.firstAttemptAtMs < this.policy.windowMs;
        const attempts = inWindow && prior !== null ? prior.attempts + 1 : 1;
        const firstAttemptAtMs = inWindow && prior !== null ? prior.firstAttemptAtMs : now;
        // An already-locked key stays locked until its existing expiry. Extending
        // on every attempt would let an attacker hold a legitimate user out
        // indefinitely, which turns a defence into a denial-of-service tool.
        const alreadyLockedUntil = record?.lockedUntilMs ?? null;
        const lockEngaged = attempts >= this.policy.maxAttempts;
        const lockedUntilMs = alreadyLockedUntil !== null && alreadyLockedUntil > now
            ? alreadyLockedUntil
            : lockEngaged
                ? now + this.policy.lockoutMs
                : null;
        const next = {
            attempts,
            firstAttemptAtMs,
            lastAttemptAtMs: now,
            lockedUntilMs,
        };
        try {
            await this.store.write(key, next, this.ttlSec());
        }
        catch (error) {
            this.logger.warn('Lockout write failed; the failure was not recorded', {
                key,
                error: String(error),
            });
        }
        if (lockedUntilMs !== null && alreadyLockedUntil === null) {
            this.logger.warn('Lockout engaged', {
                key,
                attempts,
                lockoutMs: this.policy.lockoutMs,
            });
        }
        return this.project(next);
    }
    /** Clear the record after a successful attempt. */
    async recordSuccess(key) {
        try {
            await this.store.clear(key);
        }
        catch (error) {
            // Not fatal: the record expires on its own. Reported because a
            // silently failing clear means the next failure starts from a
            // higher count than the operator believes.
            this.logger.warn('Lockout clear failed; the record will expire instead', {
                key,
                error: String(error),
            });
        }
    }
    unlockedState(attempts) {
        return {
            locked: false,
            attempts,
            remainingAttempts: Math.max(0, this.policy.maxAttempts - attempts),
            retryAfterSec: 0,
            lockedUntilMs: null,
        };
    }
    project(record) {
        const now = this.now();
        if (record === null)
            return this.unlockedState(0);
        const locked = record.lockedUntilMs !== null && record.lockedUntilMs > now;
        if (locked && record.lockedUntilMs !== null) {
            return {
                locked: true,
                attempts: record.attempts,
                remainingAttempts: 0,
                retryAfterSec: Math.max(1, Math.ceil((record.lockedUntilMs - now) / 1000)),
                lockedUntilMs: record.lockedUntilMs,
            };
        }
        // A lock that has elapsed, or a window that has rolled over, resets the count.
        const withinWindow = now - record.firstAttemptAtMs < this.policy.windowMs;
        const attempts = withinWindow ? record.attempts : 0;
        return this.unlockedState(attempts);
    }
}
/**
 * A `LockoutStore` over any `CacheStore`.
 *
 * Serialises the record as JSON, which is what makes KV workable: KV has no
 * atomic increment, so the read-modify-write in `recordFailure` is inherently
 * racy under concurrency. The consequence is bounded and acceptable here: a
 * simultaneous burst may undercount by a few, so the lock engages slightly
 * later than the policy says. A lockout that is a second late is a working
 * lockout; the alternative (a Durable Object per key) is a real cost for a
 * defence that only needs to blunt repetition.
 */
export function createCacheLockoutStore(cache, keyPrefix = 'lockout:') {
    return {
        read: (key) => cache.get(`${keyPrefix}${key}`),
        write: (key, record, ttlSec) => cache.set(`${keyPrefix}${key}`, record, ttlSec),
        clear: (key) => cache.delete(`${keyPrefix}${key}`),
    };
}
//# sourceMappingURL=lockout.js.map