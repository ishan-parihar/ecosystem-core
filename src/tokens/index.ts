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

import { decodeBase64Url, encodeBase64Url, utf8Decode, utf8Encode, type Bytes } from '../internal/base64.js';
import { timingSafeEqual } from '../internal/hash.js';

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

export type TokenVerifyResult =
	| { valid: true; payload: TokenPayload; scheme: TokenScheme }
	| { valid: false; reason: TokenVerifyReason };

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
 * Field aliases.
 *
 * `emailToken.ts` writes `{ p, e, x }`. `auth/tokens.ts` writes whatever the
 * caller passed, which for newsletter links is `{ purpose, email, exp }` already.
 * Reading both shapes is what lets one verifier retire three schemes.
 */
const PURPOSE_KEYS = ['purpose', 'p'];
const EMAIL_KEYS = ['email', 'e'];
const EXPIRY_KEYS = ['exp', 'x'];

async function importHmacKey(secret: string): Promise<CryptoKey> {
	if (secret.length === 0) throw new Error('token secret must not be empty');
	return crypto.subtle.importKey(
		'raw',
		utf8Encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	);
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value.length > 0) return value;
	}
	return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'number' && Number.isFinite(value)) return value;
	}
	return undefined;
}

/** Normalise a decoded payload into the canonical shape, or `null` when it has no identity. */
function normalisePayload(record: Record<string, unknown>): TokenPayload | null {
	const purpose = firstString(record, PURPOSE_KEYS);
	const email = firstString(record, EMAIL_KEYS);
	if (purpose === undefined || email === undefined) return null;

	const payload: TokenPayload = { ...record, purpose, email };
	const exp = firstNumber(record, EXPIRY_KEYS);
	if (exp !== undefined) payload.exp = exp;
	return payload;
}

/**
 * Mint a signed token using the canonical scheme.
 *
 * The payload is signed as raw JSON bytes. A secret shorter than 32 characters
 * is accepted; entropy policy belongs to the deployment, not to a library.
 */
export async function mintToken(payload: TokenPayload, options: MintTokenOptions): Promise<string> {
	const nowMs = options.nowMs ?? Date.now();

	// Rebuilt rather than spread, so `exp` cannot be smuggled in by a caller
	// that also passed `expiresInSec`.
	const body: TokenPayload = { purpose: payload.purpose, email: payload.email };
	for (const [key, value] of Object.entries(payload)) {
		if (key === 'purpose' || key === 'email' || key === 'exp') continue;
		body[key] = value;
	}
	if (options.expiresInSec > 0) {
		body.exp = Math.floor(nowMs / 1000) + options.expiresInSec;
	}

	const payloadBytes = utf8Encode(JSON.stringify(body));
	const signature = await crypto.subtle.sign('HMAC', await importHmacKey(options.secret), payloadBytes);
	return `${encodeBase64Url(payloadBytes)}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/** Split a token into its two base64url parts, or `null` when malformed. */
function splitToken(token: string): { payloadPart: string; signaturePart: string } | null {
	if (typeof token !== 'string' || token.length === 0) return null;
	// `lastIndexOf` so a payload containing a dot cannot shift the boundary.
	const dotIndex = token.lastIndexOf('.');
	if (dotIndex <= 0 || dotIndex === token.length - 1) return null;
	return { payloadPart: token.slice(0, dotIndex), signaturePart: token.slice(dotIndex + 1) };
}

function decodePayload(payloadPart: string): Record<string, unknown> | null {
	let bytes: Bytes;
	try {
		bytes = decodeBase64Url(payloadPart);
	} catch {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(utf8Decode(bytes));
		if (typeof parsed !== 'object' || parsed === null) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** Canonical signature check: HMAC over the raw payload bytes. */
async function canonicalSignatureIsValid(
	payloadPart: string,
	signaturePart: string,
	secret: string,
): Promise<boolean> {
	let payloadBytes: Bytes;
	let signatureBytes: Bytes;
	try {
		payloadBytes = decodeBase64Url(payloadPart);
		signatureBytes = decodeBase64Url(signaturePart);
	} catch {
		return false;
	}
	// `verify` is the constant-time comparison. Do not replace it with `===`.
	return (await crypto.subtle.verify('HMAC', await importHmacKey(secret), signatureBytes, payloadBytes)) === true;
}

/** Legacy signature check: HMAC over the base64url payload string. */
async function legacySignatureIsValid(
	payloadPart: string,
	signaturePart: string,
	secret: string,
): Promise<boolean> {
	const digest = await crypto.subtle.sign('HMAC', await importHmacKey(secret), utf8Encode(payloadPart));
	return timingSafeEqual(encodeBase64Url(new Uint8Array(digest)), signaturePart);
}

interface Verified {
	payload: TokenPayload;
	scheme: TokenScheme;
}

/**
 * The shared rule set, so purpose and expiry cannot drift between the two
 * public verifiers.
 */
async function check(
	token: string,
	options: VerifyTokenCompatOptions,
): Promise<{ valid: false; reason: TokenVerifyReason } | Verified> {
	const parts = splitToken(token);
	if (parts === null) return { valid: false, reason: 'malformed' };

	const raw = decodePayload(parts.payloadPart);
	if (raw === null) return { valid: false, reason: 'malformed' };

	let scheme: TokenScheme | null = null;
	if (await canonicalSignatureIsValid(parts.payloadPart, parts.signaturePart, options.secret)) {
		scheme = 'canonical';
	} else if (
		options.acceptLegacy === true &&
		(await legacySignatureIsValid(parts.payloadPart, parts.signaturePart, options.secret))
	) {
		scheme = 'legacy-base64url';
	}
	// The signature is checked before the payload is trusted for anything at all.
	if (scheme === null) return { valid: false, reason: 'bad_signature' };

	const payload = normalisePayload(raw);
	if (payload === null) return { valid: false, reason: 'malformed' };

	if (options.expectedPurpose !== undefined && payload.purpose !== options.expectedPurpose) {
		return { valid: false, reason: 'wrong_purpose' };
	}

	// `exp === 0` means **never expires**, not "expired at the epoch".
	//
	// The hub's signers write `exp: 0` deliberately for links that must stay
	// actionable forever, and unsubscribe is the canonical example: a campaign
	// email from two years ago still has to be able to honour the opt-out. Reading
	// a zero as an absolute timestamp marks every such link expired, which would
	// silently break the one flow a privacy regime actually checks.
	if (typeof payload.exp === 'number' && payload.exp > 0) {
		const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
		if (nowSec >= payload.exp) return { valid: false, reason: 'expired' };
	}

	return { payload, scheme };
}

/** Verify a canonical token. Rejects the legacy signing input. */
export async function verifyToken(
	token: string,
	options: VerifyTokenOptions,
): Promise<TokenVerifyResult> {
	const result = await check(token, options);
	if ('valid' in result && result.valid === false) return result;
	const verified = result as Verified;
	return { valid: true, payload: verified.payload, scheme: verified.scheme };
}

/**
 * Verify a canonical **or** legacy token.
 *
 * The migration path described at the top of the module. It reports which
 * scheme matched so a caller can log it, watch it fall to zero, and then delete
 * the legacy branch rather than leaving it in place forever.
 */
export async function verifyTokenCompat(
	token: string,
	options: VerifyTokenCompatOptions,
): Promise<TokenVerifyResult> {
	const result = await check(token, { ...options, acceptLegacy: options.acceptLegacy ?? true });
	if ('valid' in result && result.valid === false) return result;
	const verified = result as Verified;
	return { valid: true, payload: verified.payload, scheme: verified.scheme };
}
