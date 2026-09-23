/**
 * Backwards-compatible alias for the tokens module.
 *
 * Signed tokens started life here, because double opt-in was the first thing
 * that needed one. Meetings, password resets and campaign unsubscribe links
 * need the same primitive, so the implementation moved to `src/tokens` and this
 * file only re-exports it.
 *
 * It stays because `@ishan/ecosystem-core/subscribers` is a published subpath
 * that consumers import directly, and removing an export from it would be a
 * breaking change for a rename that no consumer asked for. New code should
 * import from `@ishan/ecosystem-core/tokens`.
 */
export type { MintTokenOptions, TokenPayload, TokenScheme, TokenVerifyReason, TokenVerifyResult, VerifyTokenCompatOptions, VerifyTokenOptions, } from '../tokens/index.js';
export { mintToken, verifyToken, verifyTokenCompat } from '../tokens/index.js';
//# sourceMappingURL=tokens.d.ts.map