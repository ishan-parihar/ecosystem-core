/**
 * Payments.
 *
 * A Razorpay client for the orders, subscriptions, plans and payments
 * endpoints, plus the two HMAC verifications a payment flow needs: the
 * checkout signature and the webhook signature. Ported from the hub's
 * Workers-hardened client, which exists because the official SDK calls
 * `createRequire` and cannot load in a Cloudflare Worker.
 *
 * Contract notes, relative to the hub original:
 *
 *   - credentials are injected per request, never read from an environment
 *   - HMAC verification is Web Crypto (`crypto.subtle`), not `node:crypto`,
 *     so the module runs identically in a Worker and in Node
 *   - API failures throw a structured `RazorpayApiError` carrying the HTTP
 *     status and Razorpay's error fields, instead of stringly-typed messages
 *   - `fetch` is injectable, so tests exercise the real request shapes
 *
 * The verification functions return booleans and never throw: a bad
 * signature is a business answer, not an exceptional one.
 */
import { encodeBase64, utf8Encode } from '../internal/base64.js';
import { timingSafeEqual } from '../internal/hash.js';
import { resolveLogger } from '../internal/logger.js';
const API_BASE = 'https://api.razorpay.com/v1';
/** An API-level failure, with the HTTP status and Razorpay's own error fields. */
export class RazorpayApiError extends Error {
    status;
    code;
    description;
    reason;
    constructor(status, body, fallback) {
        const description = body?.description ?? body?.reason ?? fallback;
        super(description);
        this.name = 'RazorpayApiError';
        this.status = status;
        this.code = body?.code;
        this.description = body?.description;
        this.reason = body?.reason;
    }
}
function requireCredentials(config) {
    const keyId = config.keyId.trim();
    const keySecret = config.keySecret.trim();
    if (keyId.length === 0 || keySecret.length === 0) {
        throw new Error('Razorpay credentials not configured');
    }
    return { keyId, keySecret };
}
function basicAuth(keyId, keySecret) {
    // `encodeBase64` over UTF-8 bytes rather than `btoa`, which throws on
    // non-Latin1 input — and a key secret is exactly the kind of value that
    // can carry such characters when pasted from a dashboard.
    return `Basic ${encodeBase64(utf8Encode(`${keyId}:${keySecret}`))}`;
}
function hexFromDigest(digest) {
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}
async function hmacHex(secret, message) {
    const key = await crypto.subtle.importKey('raw', utf8Encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hexFromDigest(await crypto.subtle.sign('HMAC', key, utf8Encode(message)));
}
async function parseErrorBody(response) {
    try {
        const parsed = await response.json();
        if (typeof parsed !== 'object' || parsed === null)
            return null;
        const error = parsed.error;
        if (typeof error !== 'object' || error === null)
            return null;
        return error;
    }
    catch {
        return null;
    }
}
/**
 * Build a Razorpay client. Called per request: the config object comes from
 * the caller (typically `platform.env`), so nothing here can outlive the
 * request or capture a binding at import time.
 */
export function createRazorpayClient(config) {
    const doFetch = config.fetch ?? fetch;
    const logger = resolveLogger(config.logger);
    async function request(method, path, body) {
        const { keyId, keySecret } = requireCredentials(config);
        const response = await doFetch(`${API_BASE}${path}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Authorization: basicAuth(keyId, keySecret),
                'User-Agent': '@ishan/ecosystem-core',
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!response.ok) {
            const errorBody = await parseErrorBody(response);
            logger.error('razorpay: API error', {
                path,
                status: response.status,
                code: errorBody?.code,
                description: errorBody?.description,
            });
            throw new RazorpayApiError(response.status, errorBody, `Razorpay error (${response.status})`);
        }
        return (await response.json());
    }
    return {
        async createOrder(options) {
            // Razorpay rejects fractional amounts for most currencies; round here
            // so a caller passing a rupee float does not discover it as a 400.
            return request('POST', '/orders', {
                ...options,
                amount: Math.round(options.amount),
            });
        },
        async createSubscription(options) {
            return request('POST', '/subscriptions', options);
        },
        async createPlan(options) {
            return request('POST', '/plans', options);
        },
        async cancelSubscription(subscriptionId, cancelAtCycleEnd = false) {
            const suffix = cancelAtCycleEnd ? '/cancel_at_cycle_end' : '/cancel';
            return request('POST', `/subscriptions/${encodeURIComponent(subscriptionId)}${suffix}`);
        },
        async fetchPayment(paymentId) {
            return request('GET', `/payments/${encodeURIComponent(paymentId)}`);
        },
        async verifyPaymentSignature(orderId, paymentId, signature) {
            const { keySecret } = requireCredentials(config);
            const expected = await hmacHex(keySecret, `${orderId}|${paymentId}`);
            // `timingSafeEqual`, not `===`: the comparison input is attacker
            // controlled on the checkout callback.
            return timingSafeEqual(expected, signature);
        },
        async verifyWebhookSignature(body, signature) {
            const webhookSecret = config.webhookSecret?.trim() ?? '';
            if (webhookSecret.length === 0) {
                logger.error('razorpay: webhook secret not configured; refusing to verify', {});
                return false;
            }
            const expected = await hmacHex(webhookSecret, body);
            return timingSafeEqual(expected, signature);
        },
    };
}
//# sourceMappingURL=index.js.map