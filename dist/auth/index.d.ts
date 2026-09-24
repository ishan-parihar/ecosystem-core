/**
 * Auth.
 *
 * The portable half of session handling: role and tier resolution as pure
 * functions, and session orchestration over **injected ports**.
 *
 * What is *not* here, deliberately: Supabase Auth itself, and any SvelteKit
 * glue. The hub's `auth-supabase/session-validation.ts` is a thin adapter over
 * a managed identity service - the engine is Supabase, not our code - and the
 * rest of that file is `RequestEvent` handling and `redirect()`. Extracting
 * the middleware wholesale would import SvelteKit types into a
 * framework-agnostic package, which is the one contract this package will not
 * break.
 *
 * What *is* portable is the part that got written more than once: the answer
 * to "given this profile row, what is this person allowed to do?" and the
 * orchestration that produces that row. Both are here, with the data access
 * passed in by the caller, so the same code runs against Supabase, a fixture,
 * or a future provider.
 *
 * Every port returns a promise and `getSession` never throws: a failure to
 * load a profile is an unauthenticated request, not an exception for the route
 * handler to catch.
 */
import { type Logger } from '../internal/logger.js';
/** The minimum a session needs to expose. Structurally compatible with Supabase's `User`. */
export interface SessionUser {
    id: string;
    email?: string | null;
    [key: string]: unknown;
}
/**
 * The profile fields these helpers read. Every one is optional and unknown
 * fields are preserved, because the hub's `profiles` table carries more than
 * this (`username`, `metadata`, `name`, …) and callers pass the whole row.
 */
export interface ProfileLike {
    id?: string | null;
    is_admin?: boolean | null;
    tier?: string | null;
    role?: string | null;
    permissions?: unknown;
    [key: string]: unknown;
}
/** A resolved session: the user, the (possibly enriched) profile, and the derived role. */
export interface AuthSession<P extends ProfileLike = ProfileLike> {
    user: SessionUser;
    profile: P | null;
    role: string;
    isAdmin: boolean;
    isPremium: boolean;
}
export interface AuthOptions {
    /** Tiers that grant premium access. Defaults to `['sovereign']`. */
    premiumTiers?: readonly string[];
    logger?: Logger;
}
/** The tier that has always meant "paid" in the hub. Kept as the default, not a hardcode. */
export declare const DEFAULT_PREMIUM_TIERS: readonly string[];
/**
 * A profile's role, normalised to one value.
 *
 * Admin outranks tier: an admin whose `tier` is `free` is still an admin. The
 * fallback is `user`, so a missing or unknown tier never reads as privileged.
 */
export declare function resolveRole(profile: ProfileLike | null | undefined): string;
export declare function isAdmin(profile: ProfileLike | null | undefined): boolean;
/** Premium means: an explicit admin, or a tier in the premium set. */
export declare function hasPremiumAccess(profile: ProfileLike | null | undefined, options?: AuthOptions): boolean;
/**
 * A named permission check.
 *
 * The hub stores `permissions` as either a string array or a record of flags,
 * and both shapes are in use, so both are accepted. `admin` short-circuits.
 */
export declare function hasPermission(profile: ProfileLike | null | undefined, permission: string): boolean;
/**
 * The caller's identity provider.
 *
 * `loadUser` is the only port that talks to the session layer, and it is
 * expected to reuse whatever the request already did - the hub calls Supabase
 * `getUser()` once in `hooks.server.ts` with a cookie-aware client, and repeats
 * nothing here. A port that re-validates the session on every call doubles
 * auth latency for no security gain.
 */
export interface SessionPorts<P extends ProfileLike = ProfileLike> {
    /** The authenticated user for this request, or `null`. */
    loadUser(): Promise<SessionUser | null>;
    /** The profile row for a user id, or `null`. */
    loadProfile(userId: string): Promise<P | null>;
    /**
     * Whether a loaded profile is complete enough to answer access questions.
     * Defaults to "has an `is_admin` field", which is how the hub detects the
     * slim profile its hook caches and fetches the full row instead.
     */
    isProfileComplete?(profile: P): boolean;
    /** Fetch the full profile when `isProfileComplete` says no. */
    enrichProfile?(profile: P | null, user: SessionUser): Promise<P | null>;
    logger?: Logger;
    premiumTiers?: readonly string[];
}
export interface SessionService<P extends ProfileLike = ProfileLike> {
    /** `null` when unauthenticated. Never throws. */
    getSession(): Promise<AuthSession<P> | null>;
    /** The session only when a user is present - the common guard. */
    requireUser(): Promise<AuthSession<P> | null>;
    requireAdmin(): Promise<AuthSession<P> | null>;
    requirePremium(): Promise<AuthSession<P> | null>;
    /** The session only when the profile carries `permission`. */
    requirePermission(permission: string): Promise<AuthSession<P> | null>;
}
/**
 * Build a session service. Called per request, or once per isolate when the
 * ports carry no request state - the ports are the caller's, so the lifetime is
 * the caller's to choose.
 */
export declare function createSessionService<P extends ProfileLike = ProfileLike>(ports: SessionPorts<P>): SessionService<P>;
//# sourceMappingURL=index.d.ts.map