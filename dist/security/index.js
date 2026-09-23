/**
 * Security primitives.
 *
 * Deliberately narrow. Session cookies, auth tokens and CSRF belong to the
 * identity layer, which is not here yet; what lives here is the abuse defence
 * that sits in front of it and that every surface needs regardless of which auth
 * provider it ends up using.
 */
export { createCacheLockoutStore, LOCKOUT_POLICIES, lockoutKey, Lockout, resolveLockoutPolicy, } from './lockout.js';
//# sourceMappingURL=index.js.map