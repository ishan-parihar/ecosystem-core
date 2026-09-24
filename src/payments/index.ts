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
import { resolveLogger, type Logger } from '../internal/logger.js';

const API_BASE = 'https://api.razorpay.com/v1';

/** Razorpay's error envelope, as returned in non-2xx JSON bodies. */
export interface RazorpayErrorBody {
	code?: string;
	description?: string;
	reason?: string;
	source?: string;
	step?: string;
	[key: string]: unknown;
}

/** An API-level failure, with the HTTP status and Razorpay's own error fields. */
export class RazorpayApiError extends Error {
	readonly status: number;
	readonly code?: string;
	readonly description?: string;
	readonly reason?: string;

	constructor(status: number, body: RazorpayErrorBody | null, fallback: string) {
		const description = body?.description ?? body?.reason ?? fallback;
		super(description);
		this.name = 'RazorpayApiError';
		this.status = status;
		this.code = body?.code;
		this.description = body?.description;
		this.reason = body?.reason;
	}
}

export interface RazorpayConfig {
	/** The API key id, `rzp_…`. Required for every API call. */
	keyId: string;
	/** The API key secret. Required for every API call. */
	keySecret: string;
	/**
	 * The webhook secret. Required only by `verifyWebhookSignature`; when
	 * absent that verifier returns `false` and logs, rather than throwing.
	 */
	webhookSecret?: string;
	logger?: Logger;
	/** Injectable transport. Defaults to the global `fetch`. */
	fetch?: typeof fetch;
}

export interface CreateOrderOptions {
	/** Amount in the currency's smallest unit (paise for INR). Rounded to an integer. */
	amount: number;
	currency: string;
	receipt?: string;
	notes?: Record<string, string>;
}

/** The subset of Razorpay's order object every consumer relies on. */
export interface RazorpayOrder {
	id: string;
	amount: number;
	currency: string;
	status: string;
	receipt?: string;
	[key: string]: unknown;
}

export interface CreateSubscriptionOptions {
	plan_id: string;
	total_count: number;
	quantity?: number;
	customer_notify?: boolean;
	notes?: Record<string, string>;
}

export interface RazorpaySubscription {
	id: string;
	status: string;
	plan_id: string;
	[key: string]: unknown;
}

export interface CreatePlanOptions {
	period: 'daily' | 'weekly' | 'monthly' | 'yearly';
	interval: number;
	item: {
		name: string;
		amount: number;
		currency: string;
		description?: string;
	};
	notes?: Record<string, string>;
}

export interface RazorpayPlan {
	id: string;
	status: string;
	[key: string]: unknown;
}

export interface RazorpayPayment {
	id: string;
	status: string;
	order_id?: string;
	amount: number;
	[key: string]: unknown;
}

function requireCredentials(config: RazorpayConfig): { keyId: string; keySecret: string } {
	const keyId = config.keyId.trim();
	const keySecret = config.keySecret.trim();
	if (keyId.length === 0 || keySecret.length === 0) {
		throw new Error('Razorpay credentials not configured');
	}
	return { keyId, keySecret };
}

function basicAuth(keyId: string, keySecret: string): string {
	// `encodeBase64` over UTF-8 bytes rather than `btoa`, which throws on
	// non-Latin1 input — and a key secret is exactly the kind of value that
	// can carry such characters when pasted from a dashboard.
	return `Basic ${encodeBase64(utf8Encode(`${keyId}:${keySecret}`))}`;
}

function hexFromDigest(digest: ArrayBuffer): string {
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

async function hmacHex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		utf8Encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	return hexFromDigest(await crypto.subtle.sign('HMAC', key, utf8Encode(message)));
}

async function parseErrorBody(response: Response): Promise<RazorpayErrorBody | null> {
	try {
		const parsed: unknown = await response.json();
		if (typeof parsed !== 'object' || parsed === null) return null;
		const error = (parsed as { error?: unknown }).error;
		if (typeof error !== 'object' || error === null) return null;
		return error as RazorpayErrorBody;
	} catch {
		return null;
	}
}

export interface RazorpayClient {
	createOrder(options: CreateOrderOptions): Promise<RazorpayOrder>;
	createSubscription(options: CreateSubscriptionOptions): Promise<RazorpaySubscription>;
	createPlan(options: CreatePlanOptions): Promise<RazorpayPlan>;
	cancelSubscription(subscriptionId: string, cancelAtCycleEnd?: boolean): Promise<RazorpaySubscription>;
	fetchPayment(paymentId: string): Promise<RazorpayPayment>;
	/** HMAC-SHA256 over `orderId|paymentId`, hex, compared to `signature`. */
	verifyPaymentSignature(orderId: string, paymentId: string, signature: string): Promise<boolean>;
	/** HMAC-SHA256 over the raw webhook body, hex, compared to `signature`. */
	verifyWebhookSignature(body: string, signature: string): Promise<boolean>;
}

/**
 * Build a Razorpay client. Called per request: the config object comes from
 * the caller (typically `platform.env`), so nothing here can outlive the
 * request or capture a binding at import time.
 */
export function createRazorpayClient(config: RazorpayConfig): RazorpayClient {
	const doFetch = config.fetch ?? fetch;
	const logger = resolveLogger(config.logger);

	async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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

		return (await response.json()) as T;
	}

	return {
		async createOrder(options) {
			// Razorpay rejects fractional amounts for most currencies; round here
			// so a caller passing a rupee float does not discover it as a 400.
			return request<RazorpayOrder>('POST', '/orders', {
				...options,
				amount: Math.round(options.amount),
			});
		},

		async createSubscription(options) {
			return request<RazorpaySubscription>('POST', '/subscriptions', options);
		},

		async createPlan(options) {
			return request<RazorpayPlan>('POST', '/plans', options);
		},

		async cancelSubscription(subscriptionId, cancelAtCycleEnd = false) {
			const suffix = cancelAtCycleEnd ? '/cancel_at_cycle_end' : '/cancel';
			return request<RazorpaySubscription>('POST', `/subscriptions/${encodeURIComponent(subscriptionId)}${suffix}`);
		},

		async fetchPayment(paymentId) {
			return request<RazorpayPayment>('GET', `/payments/${encodeURIComponent(paymentId)}`);
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
