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
import type { CacheStore } from '../cache/index.js';
import { type Logger } from '../internal/logger.js';
export interface LockoutRecord {
    /** Failures counted inside the current window. */
    attempts: number;
    /** Epoch milliseconds when the first failure in this window landed. */
    firstAttemptAtMs: number;
    /** Epoch milliseconds of the most recent failure. */
    lastAttemptAtMs: number;
    /** Epoch milliseconds until which this key is refused. `null` when not locked. */
    lockedUntilMs: number | null;
}
export interface LockoutStore {
    read(key: string): Promise<LockoutRecord | null>;
    write(key: string, record: LockoutRecord, ttlSec: number): Promise<void>;
    clear(key: string): Promise<void>;
}
export interface LockoutPolicy {
    /** Failures allowed inside `windowMs` before locking. */
    maxAttempts: number;
    /** How long a failure counts toward the threshold. */
    windowMs: number;
    /** How long the key stays refused once locked. */
    lockoutMs: number;
}
/**
 * Named policies, so surfaces share the numbers.
 *
 * `authPassword` matches the hub's existing defaults, so adopting this does not
 * change behaviour for a surface already using the lockout.
 */
export declare const LOCKOUT_POLICIES: {
    /** The hub's current default: 5 failures in 15 minutes, locked for 15. */
    readonly authPassword: {
        readonly maxAttempts: 5;
        readonly windowMs: number;
        readonly lockoutMs: number;
    };
    /** Magic links and resets: each attempt sends mail, so tolerance is lower. */
    readonly authEmail: {
        readonly maxAttempts: 3;
        readonly windowMs: number;
        readonly lockoutMs: number;
    };
    /** Turnstile or a captcha repeatedly rejected. */
    readonly captcha: {
        readonly maxAttempts: 8;
        readonly windowMs: number;
        readonly lockoutMs: number;
    };
};
export type LockoutPolicyName = keyof typeof LOCKOUT_POLICIES;
export declare function resolveLockoutPolicy(name: LockoutPolicyName, overrides?: Partial<LockoutPolicy>): LockoutPolicy;
export interface LockoutState {
    locked: boolean;
    /** Failures counted in the current window. */
    attempts: number;
    /** Attempts still available before a lock. `0` when already locked. */
    remainingAttempts: number;
    /** Seconds until the lock lifts. `0` when not locked. */
    retryAfterSec: number;
    /** Epoch milliseconds when the lock lifts. `null` when not locked. */
    lockedUntilMs: number | null;
}
/** Key a lockout on an identity plus, optionally, where it came from. */
export declare function lockoutKey(scope: string, subject: string, ip?: string | null): string;
export interface LockoutOptions {
    store: LockoutStore;
    policy: LockoutPolicy | LockoutPolicyName;
    /** Injectable clock in milliseconds. */
    now?: () => number;
    /** Extra seconds a record is retained beyond its window, so a stale read cannot unlock early. */
    retentionSlackSec?: number;
    logger?: Logger;
}
/**
 * A lockout over an injected store.
 *
 * Every method fails open on a store error and logs the reason. A lockout that
 * cannot read its own state must not refuse legitimate traffic: the alternative
 * is that a storage blip locks every user out of the surface at once.
 */
export declare class Lockout {
    private readonly store;
    private readonly policy;
    private readonly now;
    private readonly retentionSlackSec;
    private readonly logger;
    constructor(options: LockoutOptions);
    private ttlSec;
    /** Read the current state without changing it. */
    check(key: string): Promise<LockoutState>;
    /**
     * Count a failure and return the resulting state.
     *
     * A failure outside the window starts a new window: an attacker who gives up
     * for an hour should not be one attempt from a lock when they return.
     */
    recordFailure(key: string): Promise<LockoutState>;
    /** Clear the record after a successful attempt. */
    recordSuccess(key: string): Promise<void>;
    private unlockedState;
    private project;
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
export declare function createCacheLockoutStore(cache: CacheStore, keyPrefix?: string): LockoutStore;
//# sourceMappingURL=lockout.d.ts.map