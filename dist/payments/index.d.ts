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
import { type Logger } from '../internal/logger.js';
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
export declare class RazorpayApiError extends Error {
    readonly status: number;
    readonly code?: string;
    readonly description?: string;
    readonly reason?: string;
    constructor(status: number, body: RazorpayErrorBody | null, fallback: string);
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
export declare function createRazorpayClient(config: RazorpayConfig): RazorpayClient;
//# sourceMappingURL=index.d.ts.map