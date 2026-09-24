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

import { resolveLogger, type Logger } from '../internal/logger.js';

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
export const DEFAULT_PREMIUM_TIERS: readonly string[] = ['sovereign'];

/**
 * A profile's role, normalised to one value.
 *
 * Admin outranks tier: an admin whose `tier` is `free` is still an admin. The
 * fallback is `user`, so a missing or unknown tier never reads as privileged.
 */
export function resolveRole(profile: ProfileLike | null | undefined): string {
	if (!profile) return 'user';
	if (profile.is_admin === true) return 'admin';
	const tier = typeof profile.tier === 'string' ? profile.tier.trim() : '';
	if (tier.length > 0) return tier;
	const role = typeof profile.role === 'string' ? profile.role.trim() : '';
	return role.length > 0 ? role : 'user';
}

export function isAdmin(profile: ProfileLike | null | undefined): boolean {
	return profile?.is_admin === true;
}

/** Premium means: an explicit admin, or a tier in the premium set. */
export function hasPremiumAccess(
	profile: ProfileLike | null | undefined,
	options: AuthOptions = {},
): boolean {
	if (isAdmin(profile)) return true;
	const tier = typeof profile?.tier === 'string' ? profile.tier.trim() : '';
	if (tier.length === 0) return false;
	const tiers = options.premiumTiers ?? DEFAULT_PREMIUM_TIERS;
	return tiers.includes(tier);
}

/**
 * A named permission check.
 *
 * The hub stores `permissions` as either a string array or a record of flags,
 * and both shapes are in use, so both are accepted. `admin` short-circuits.
 */
export function hasPermission(profile: ProfileLike | null | undefined, permission: string): boolean {
	if (isAdmin(profile)) return true;
	const permissions = profile?.permissions;
	if (Array.isArray(permissions)) return permissions.includes(permission);
	if (typeof permissions === 'object' && permissions !== null) {
		return (permissions as Record<string, unknown>)[permission] === true;
	}
	return false;
}

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
	enrichProfile?(
		profile: P | null,
		user: SessionUser,
	): Promise<P | null>;
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

function defaultIsProfileComplete(profile: ProfileLike): boolean {
	return Object.prototype.hasOwnProperty.call(profile, 'is_admin');
}

/**
 * Build a session service. Called per request, or once per isolate when the
 * ports carry no request state - the ports are the caller's, so the lifetime is
 * the caller's to choose.
 */
export function createSessionService<P extends ProfileLike = ProfileLike>(
	ports: SessionPorts<P>,
): SessionService<P> {
	const logger = resolveLogger(ports.logger);
	const isComplete = ports.isProfileComplete ?? defaultIsProfileComplete;

	async function getSession(): Promise<AuthSession<P> | null> {
		try {
			const user = await ports.loadUser();
			if (!user) return null;

			let profile = await ports.loadProfile(user.id);

			// A slim profile cannot answer access questions: the hub's hook
			// caches `{ id, email, name, role, permissions, tier_rank }`, so
			// `is_admin` and `tier` are missing until the full row lands.
			if (profile && !isComplete(profile) && ports.enrichProfile) {
				try {
					profile = (await ports.enrichProfile(profile, user)) ?? profile;
				} catch (error) {
					// A failed enrichment degrades to the slim profile rather
					// than failing the request: role resolution still works.
					logger.warn('auth: profile enrichment failed', {
						userId: user.id,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}

			return {
				user,
				profile,
				role: resolveRole(profile),
				isAdmin: isAdmin(profile),
				isPremium: hasPremiumAccess(profile, { premiumTiers: ports.premiumTiers }),
			};
		} catch (error) {
			logger.error('auth: session loading failed', {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	async function guard(
		check: (session: AuthSession<P>) => boolean,
	): Promise<AuthSession<P> | null> {
		const session = await getSession();
		if (!session) return null;
		return check(session) ? session : null;
	}

	return {
		getSession,
		requireUser: () => guard(() => true),
		requireAdmin: () => guard((session) => session.isAdmin),
		requirePremium: () => guard((session) => session.isPremium),
		requirePermission: (permission) =>
			guard((session) => hasPermission(session.profile, permission)),
	};
}
