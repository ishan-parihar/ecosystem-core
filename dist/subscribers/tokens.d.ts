/**
 * Signed subscriber tokens.
 *
 * Used for double opt-in confirmation and one-click unsubscribe. The secret is
 * injected; the purpose and TTL are parameters. Confirmation expires, the
 * unsubscribe link does not, which is the combination most privacy regimes
 * expect: a stale confirm link is harmless, a stale unsubscribe link is a
 * compliance problem.
 *
 * Signing uses WebCrypto HMAC-SHA256 and verification uses
 * `crypto.subtle.verify`, which is constant-time, so a token cannot be
 * recovered by timing the comparison.
 */
export interface TokenPayload {
    /** Which link this token authorises. Checked on verify. */
    purpose: string;
    /** The bound address. */
    email: string;
    /** Epoch seconds. Absent means the token never expires. */
    exp?: number;
    [key: string]: unknown;
}
export type TokenVerifyReason = 'malformed' | 'bad_signature' | 'expired' | 'wrong_purpose';
export type TokenVerifyResult = {
    valid: true;
    payload: TokenPayload;
} | {
    valid: false;
    reason: TokenVerifyReason;
};
export interface MintTokenOptions {
    secret: string;
    /** Seconds until expiry. `0` or negative means the token never expires. */
    expiresInSec: number;
    /** Injectable clock in milliseconds. Defaults to `Date.now`. */
    nowMs?: number;
}
export interface VerifyTokenOptions {
    secret: string;
    /** When set, a token minted for another purpose is rejected. */
    expectedPurpose?: string;
    /** Injectable clock in milliseconds. Defaults to `Date.now`. */
    nowMs?: number;
}
/**
 * Mint a signed token.
 *
 * A secret shorter than 32 characters is accepted but the caller is expected
 * to validate its own environment; the package cannot know the deployment's
 * entropy policy.
 */
export declare function mintToken(payload: TokenPayload, options: MintTokenOptions): Promise<string>;
/** Verify a token's signature, purpose and expiry, in that order. */
export declare function verifyToken(token: string, options: VerifyTokenOptions): Promise<TokenVerifyResult>;
//# sourceMappingURL=tokens.d.ts.map