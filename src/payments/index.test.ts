import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { createRazorpayClient, RazorpayApiError } from './index.js';

const KEY_ID = 'rzp_test_keyid';
const KEY_SECRET = 'test_secret_value';
const WEBHOOK_SECRET = 'whsec_test_value';

/** A successful Razorpay JSON response. */
function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

function errorResponse(status: number, error: Record<string, unknown>): Response {
	return jsonResponse({ error }, status);
}

/**
 * The expected signature, computed with `node:crypto`.
 *
 * Deliberately the reference implementation rather than a re-derived WebCrypto
 * call: this is the check that proves the package's `crypto.subtle` HMAC
 * matches the algorithm Razorpay (and the hub's original `createHmac` client)
 * actually uses.
 */
function hmacHex(secret: string, message: string): string {
	return createHmac('sha256', secret).update(message).digest('hex');
}

function client(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
	return createRazorpayClient({
		keyId: KEY_ID,
		keySecret: KEY_SECRET,
		fetch: fetchImpl,
		...extra,
	});
}

describe('createRazorpayClient', () => {
	it('posts an order to the orders endpoint with Basic auth and a rounded amount', async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({ id: 'order_1', amount: 50000, currency: 'INR', status: 'created' }),
		);

		const order = await client(fetchImpl as unknown as typeof fetch).createOrder({
			amount: 49999.6,
			currency: 'INR',
			receipt: 'rcpt_1',
		});

		expect(order).toMatchObject({ id: 'order_1', status: 'created' });
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://api.razorpay.com/v1/orders');
		expect(init.method).toBe('POST');
		expect((init.headers as Record<string, string>).Authorization).toBe(
			`Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`,
		);
		expect(JSON.parse(String(init.body))).toMatchObject({ amount: 50000, currency: 'INR' });
	});

	it('encodes a non-Latin1 key secret without throwing', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ id: 'order_2', amount: 1, currency: 'INR', status: 'created' }));

		// `btoa` rejects this outright; the package's base64 helper does not.
		const nonAscii = 'sécret-密钥';
		await createRazorpayClient({
			keyId: KEY_ID,
			keySecret: nonAscii,
			fetch: fetchImpl as unknown as typeof fetch,
		}).createOrder({ amount: 100, currency: 'INR' });

		const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect((init.headers as Record<string, string>).Authorization).toBe(
			`Basic ${Buffer.from(`${KEY_ID}:${nonAscii}`, 'utf8').toString('base64')}`,
		);
	});

	it('throws a structured error carrying the status and Razorpay codes', async () => {
		const fetchImpl = vi.fn(async () =>
			errorResponse(400, { code: 'BAD_REQUEST_ERROR', description: 'Amount is invalid' }),
		);

		const error = await client(fetchImpl as unknown as typeof fetch)
			.createOrder({ amount: 1, currency: 'INR' })
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(RazorpayApiError);
		const apiError = error as RazorpayApiError;
		expect(apiError.status).toBe(400);
		expect(apiError.code).toBe('BAD_REQUEST_ERROR');
		expect(apiError.message).toBe('Amount is invalid');
	});

	it('refuses to call the API without credentials', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({}));
		const unconfigured = createRazorpayClient({
			keyId: '  ',
			keySecret: '',
			fetch: fetchImpl as unknown as typeof fetch,
		});

		await expect(unconfigured.createOrder({ amount: 1, currency: 'INR' })).rejects.toThrow(
			'Razorpay credentials not configured',
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('cancels immediately or at cycle end by path', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ id: 'sub_1', status: 'cancelled', plan_id: 'plan_1' }));
		const razorpay = client(fetchImpl as unknown as typeof fetch);

		await razorpay.cancelSubscription('sub_1');
		await razorpay.cancelSubscription('sub_1', true);

		expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.razorpay.com/v1/subscriptions/sub_1/cancel');
		expect(fetchImpl.mock.calls[1]?.[0]).toBe(
			'https://api.razorpay.com/v1/subscriptions/sub_1/cancel_at_cycle_end',
		);
	});

	it('fetches a payment by id', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ id: 'pay_1', status: 'captured', amount: 50000 }));
		const payment = await client(fetchImpl as unknown as typeof fetch).fetchPayment('pay_1');

		expect(payment).toMatchObject({ id: 'pay_1', status: 'captured' });
		expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.razorpay.com/v1/payments/pay_1');
	});
});

describe('signature verification', () => {
	it('accepts the checkout HMAC and rejects a wrong one', async () => {
		const razorpay = client(vi.fn() as unknown as typeof fetch);
		const signature = hmacHex(KEY_SECRET, 'order_1|pay_1');

		expect(await razorpay.verifyPaymentSignature('order_1', 'pay_1', signature)).toBe(true);
		expect(await razorpay.verifyPaymentSignature('order_1', 'pay_1', `${signature}0`)).toBe(false);
		expect(await razorpay.verifyPaymentSignature('order_2', 'pay_1', signature)).toBe(false);
	});

	it('accepts the webhook HMAC over the raw body', async () => {
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		const razorpay = client(fetchImpl, { webhookSecret: WEBHOOK_SECRET });
		const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1' } } } });

		expect(await razorpay.verifyWebhookSignature(body, hmacHex(WEBHOOK_SECRET, body))).toBe(true);
		expect(await razorpay.verifyWebhookSignature(body, 'deadbeef')).toBe(false);
	});

	it('refuses to verify a webhook with no secret, and says so', async () => {
		const logged: string[] = [];
		const razorpay = createRazorpayClient({
			keyId: KEY_ID,
			keySecret: KEY_SECRET,
			fetch: (async () => jsonResponse({})) as unknown as typeof fetch,
			logger: {
				info: () => undefined,
				warn: () => undefined,
				error: (message) => logged.push(message),
			},
		});

		// A missing webhook secret must not fall through to `true`: an
		// unverified webhook is a forged payment notification.
		expect(await razorpay.verifyWebhookSignature('{}', hmacHex('', '{}'))).toBe(false);
		expect(logged.join(' ')).toContain('webhook secret not configured');
	});
});
