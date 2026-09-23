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
import { decodeBase64Url, encodeBase64Url, utf8Decode, utf8Encode, } from '../internal/base64.js';
async function importKey(secret) {
    return crypto.subtle.importKey('raw', utf8Encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
/**
 * Mint a signed token.
 *
 * A secret shorter than 32 characters is accepted but the caller is expected
 * to validate its own environment; the package cannot know the deployment's
 * entropy policy.
 */
export async function mintToken(payload, options) {
    const nowMs = options.nowMs ?? Date.now();
    const body = { purpose: payload.purpose, email: payload.email };
    for (const [key, value] of Object.entries(payload)) {
        if (key === 'purpose' || key === 'email' || key === 'exp')
            continue;
        body[key] = value;
    }
    if (options.expiresInSec > 0) {
        body.exp = Math.floor(nowMs / 1000) + options.expiresInSec;
    }
    const payloadBytes = utf8Encode(JSON.stringify(body));
    const signature = await crypto.subtle.sign('HMAC', await importKey(options.secret), payloadBytes);
    return `${encodeBase64Url(payloadBytes)}.${encodeBase64Url(new Uint8Array(signature))}`;
}
/** Verify a token's signature, purpose and expiry, in that order. */
export async function verifyToken(token, options) {
    const parts = token.split('.');
    if (parts.length !== 2)
        return { valid: false, reason: 'malformed' };
    const payloadPart = parts[0];
    const signaturePart = parts[1];
    if (payloadPart === undefined || signaturePart === undefined) {
        return { valid: false, reason: 'malformed' };
    }
    let payloadBytes;
    let signatureBytes;
    try {
        payloadBytes = decodeBase64Url(payloadPart);
        signatureBytes = decodeBase64Url(signaturePart);
    }
    catch {
        return { valid: false, reason: 'malformed' };
    }
    const key = await importKey(options.secret);
    // `verify` is the constant-time comparison; do not replace with a string compare.
    const signatureOk = await crypto.subtle.verify('HMAC', key, signatureBytes, payloadBytes);
    if (!signatureOk)
        return { valid: false, reason: 'bad_signature' };
    let parsed;
    try {
        parsed = JSON.parse(utf8Decode(payloadBytes));
    }
    catch {
        return { valid: false, reason: 'malformed' };
    }
    if (typeof parsed !== 'object' || parsed === null)
        return { valid: false, reason: 'malformed' };
    const record = parsed;
    if (typeof record.purpose !== 'string' || typeof record.email !== 'string') {
        return { valid: false, reason: 'malformed' };
    }
    if (options.expectedPurpose !== undefined && record.purpose !== options.expectedPurpose) {
        return { valid: false, reason: 'wrong_purpose' };
    }
    if (typeof record.exp === 'number') {
        const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
        if (nowSec >= record.exp)
            return { valid: false, reason: 'expired' };
    }
    return { valid: true, payload: record };
}
//# sourceMappingURL=tokens.js.map