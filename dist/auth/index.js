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
import { resolveLogger } from '../internal/logger.js';
/** The tier that has always meant "paid" in the hub. Kept as the default, not a hardcode. */
export const DEFAULT_PREMIUM_TIERS = ['sovereign'];
/**
 * A profile's role, normalised to one value.
 *
 * Admin outranks tier: an admin whose `tier` is `free` is still an admin. The
 * fallback is `user`, so a missing or unknown tier never reads as privileged.
 */
export function resolveRole(profile) {
    if (!profile)
        return 'user';
    if (profile.is_admin === true)
        return 'admin';
    const tier = typeof profile.tier === 'string' ? profile.tier.trim() : '';
    if (tier.length > 0)
        return tier;
    const role = typeof profile.role === 'string' ? profile.role.trim() : '';
    return role.length > 0 ? role : 'user';
}
export function isAdmin(profile) {
    return profile?.is_admin === true;
}
/** Premium means: an explicit admin, or a tier in the premium set. */
export function hasPremiumAccess(profile, options = {}) {
    if (isAdmin(profile))
        return true;
    const tier = typeof profile?.tier === 'string' ? profile.tier.trim() : '';
    if (tier.length === 0)
        return false;
    const tiers = options.premiumTiers ?? DEFAULT_PREMIUM_TIERS;
    return tiers.includes(tier);
}
/**
 * A named permission check.
 *
 * The hub stores `permissions` as either a string array or a record of flags,
 * and both shapes are in use, so both are accepted. `admin` short-circuits.
 */
export function hasPermission(profile, permission) {
    if (isAdmin(profile))
        return true;
    const permissions = profile?.permissions;
    if (Array.isArray(permissions))
        return permissions.includes(permission);
    if (typeof permissions === 'object' && permissions !== null) {
        return permissions[permission] === true;
    }
    return false;
}
function defaultIsProfileComplete(profile) {
    return Object.prototype.hasOwnProperty.call(profile, 'is_admin');
}
/**
 * Build a session service. Called per request, or once per isolate when the
 * ports carry no request state - the ports are the caller's, so the lifetime is
 * the caller's to choose.
 */
export function createSessionService(ports) {
    const logger = resolveLogger(ports.logger);
    const isComplete = ports.isProfileComplete ?? defaultIsProfileComplete;
    async function getSession() {
        try {
            const user = await ports.loadUser();
            if (!user)
                return null;
            let profile = await ports.loadProfile(user.id);
            // A slim profile cannot answer access questions: the hub's hook
            // caches `{ id, email, name, role, permissions, tier_rank }`, so
            // `is_admin` and `tier` are missing until the full row lands.
            if (profile && !isComplete(profile) && ports.enrichProfile) {
                try {
                    profile = (await ports.enrichProfile(profile, user)) ?? profile;
                }
                catch (error) {
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
        }
        catch (error) {
            logger.error('auth: session loading failed', {
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    }
    async function guard(check) {
        const session = await getSession();
        if (!session)
            return null;
        return check(session) ? session : null;
    }
    return {
        getSession,
        requireUser: () => guard(() => true),
        requireAdmin: () => guard((session) => session.isAdmin),
        requirePremium: () => guard((session) => session.isPremium),
        requirePermission: (permission) => guard((session) => hasPermission(session.profile, permission)),
    };
}
//# sourceMappingURL=index.js.map