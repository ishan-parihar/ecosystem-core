/**
 * Hashing helpers built on WebCrypto.
 *
 * `crypto.subtle` rather than `node:crypto`: the Workers runtime exposes the
 * Web Crypto API and the package must not depend on `nodejs_compat`, which is
 * configured per application and can differ between surfaces.
 */
/**
 * Lowercase hex SHA-256 of a string, optionally truncated.
 *
 * Used for anonymised identifiers such as a hashed client IP, where the digest
 * is stored precisely so the original value cannot be recovered from it.
 */
export declare function sha256Hex(value: string, length?: number): Promise<string>;
/**
 * Constant-time string comparison.
 *
 * `crypto.subtle.verify` covers HMAC comparisons, but comparing two plain
 * strings (an API token, a webhook signature supplied as hex) has no WebCrypto
 * equivalent and a `===` on those leaks length and prefix through timing.
 */
export declare function timingSafeEqual(a: string, b: string): boolean;
//# sourceMappingURL=hash.d.ts.map