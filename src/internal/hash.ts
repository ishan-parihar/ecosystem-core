/**
 * Hashing helpers built on WebCrypto.
 *
 * `crypto.subtle` rather than `node:crypto`: the Workers runtime exposes the
 * Web Crypto API and the package must not depend on `nodejs_compat`, which is
 * configured per application and can differ between surfaces.
 */

import { utf8Encode } from './base64.js';

/**
 * Lowercase hex SHA-256 of a string, optionally truncated.
 *
 * Used for anonymised identifiers such as a hashed client IP, where the digest
 * is stored precisely so the original value cannot be recovered from it.
 */
export async function sha256Hex(value: string, length?: number): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', utf8Encode(value));
	const hex = Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	return length === undefined ? hex : hex.slice(0, length);
}

/**
 * Constant-time string comparison.
 *
 * `crypto.subtle.verify` covers HMAC comparisons, but comparing two plain
 * strings (an API token, a webhook signature supplied as hex) has no WebCrypto
 * equivalent and a `===` on those leaks length and prefix through timing.
 */
export function timingSafeEqual(a: string, b: string): boolean {
	const left = utf8Encode(a);
	const right = utf8Encode(b);
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let i = 0; i < left.length; i += 1) {
		diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
	}
	return diff === 0;
}
