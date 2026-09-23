/**
 * Signed tokens.
 *
 * Stateless, tamper-evident links: double opt-in confirmation, one-click
 * unsubscribe, guest meeting manage and cancel, password resets. It is one
 * primitive with a different `purpose`, which is why it lives here rather than
 * inside `subscribers`.
 *
 * ## Why there are two verification schemes
 *
 * The ecosystem grew three independent implementations of this primitive, and
 * they are **not** interchangeable even when they share a secret:
 *
 * | Implementation           | Input signed         | Payload fields            |
 * |--------------------------|----------------------|---------------------------|
 * | this package (canonical) | the raw JSON bytes   | `purpose`, `email`, `exp` |
 * | hub `auth/tokens.ts`     | `base64url(payload)` | `purpose`, `email`, `exp` |
 * | hub `emailToken.ts`      | `base64url(payload)` | `p`, `e`, `x`             |
 *
 * Signing a base64url *string* and signing the underlying *bytes* are different
 * HMAC inputs, so a token minted by one is `bad_signature` to the other. That
 * was verified rather than assumed: given an identical secret, the hub's
 * `signToken` output is rejected by this package's `verifyToken`, and the
 * reverse holds as well.
 *
 * `verifyTokenCompat` closes the gap. It tries the canonical scheme, then the
 * legacy signing input, and normalises the legacy field aliases. That turns the
 * migration into three steps instead of a flag day:
 *
 *   1. consumers switch to `mintToken` and `verifyTokenCompat`
 *   2. links already sent keep working, because the legacy branch verifies them
 *   3. once no live link predates the switch, drop `acceptLegacy`
 *
 * Nothing here reads an environment variable. The secret is an argument, which
 * is what lets a Cloudflare Worker, a Node CLI and a test share one module.
 */
/** Which signing input produced a token. Reported so the migration is measurable. */
export type TokenScheme = 'canonical' | 'legacy-base64url';
export interface TokenPayload {
    /** Which link this token authorises. Checked on verify. */
    purpose: string;
    /** The bound address. The hub's meeting, reset and newsletter links all bind one. */
    email: string;
    /** Epoch seconds. Absent means the token never expires. */
    exp?: number;
    /** Any further signed claim, e.g. a subscriber id or a plan code. */
    [key: string]: unknown;
}
export type TokenVerifyReason = 'malformed' | 'bad_signature' | 'expired' | 'wrong_purpose';
export type TokenVerifyResult = {
    valid: true;
    payload: TokenPayload;
    scheme: TokenScheme;
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
export interface VerifyTokenCompatOptions extends VerifyTokenOptions {
    /**
     * Also accept the legacy `base64url(payload)` signing input and the hub's
     * short field aliases (`p`, `e`, `x`).
     *
     * Defaults to `false`. A verifier that accepts two signing inputs forever is
     * a verifier whose legacy branch never gets deleted; a caller opts in during
     * migration and then stops.
     */
    acceptLegacy?: boolean;
}
/**
 * Mint a signed token using the canonical scheme.
 *
 * The payload is signed as raw JSON bytes. A secret shorter than 32 characters
 * is accepted; entropy policy belongs to the deployment, not to a library.
 */
export declare function mintToken(payload: TokenPayload, options: MintTokenOptions): Promise<string>;
/** Verify a canonical token. Rejects the legacy signing input. */
export declare function verifyToken(token: string, options: VerifyTokenOptions): Promise<TokenVerifyResult>;
/**
 * Verify a canonical **or** legacy token.
 *
 * The migration path described at the top of the module. It reports which
 * scheme matched so a caller can log it, watch it fall to zero, and then delete
 * the legacy branch rather than leaving it in place forever.
 */
export declare function verifyTokenCompat(token: string, options: VerifyTokenCompatOptions): Promise<TokenVerifyResult>;
//# sourceMappingURL=index.d.ts.map