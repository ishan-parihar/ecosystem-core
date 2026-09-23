/**
 * The subscriber store.
 *
 * Carries the parts that must be identical on every surface: the double
 * opt-in state machine, the suppression policy, and the token rules. The
 * table itself is injected, so the same logic drives whichever database the
 * consuming application owns.
 */
import type { SubscribeInput, SubscribeOutcome, SubscriberListResult, SubscriberQuery, SubscriberRecord, SubscriberStoreOptions, SubscriberTable, ConfirmOutcome, UnsubscribeOutcome } from './types.js';
/** Token purposes. Checked on verify, so a confirm link cannot unsubscribe. */
export declare const TOKEN_PURPOSE_CONFIRM = "newsletter_confirm";
export declare const TOKEN_PURPOSE_UNSUBSCRIBE = "newsletter_unsubscribe";
/** Raised for input the store refuses to act on, before touching storage. */
export declare class SubscriberInputError extends Error {
    constructor(message: string);
}
export declare class SubscriberStore {
    private readonly table;
    private readonly options;
    constructor(table: SubscriberTable, options: SubscriberStoreOptions);
    private nowMs;
    private nowIso;
    /** The double opt-in confirmation URL for an address. */
    buildConfirmUrl(email: string): Promise<string>;
    /** The tokenized unsubscribe URL a human clicks. */
    buildUnsubscribeUrl(email: string): Promise<string>;
    /**
     * The RFC 8058 one-click endpoint URL, for the `List-Unsubscribe` header.
     *
     * It carries the same token as the human page, so a mail client POSTing to
     * it needs no confirmation step and no second secret.
     */
    buildOneClickUnsubscribeUrl(email: string): Promise<string>;
    private mintUnsubscribeToken;
    /**
     * Subscribe an address, landing in `pending_confirmation`.
     *
     * Returning `suppressed` rather than a confirmation URL for a bounced or
     * complained address is deliberate: re-confirming a known-bad address is
     * what damages a sending domain, and no legitimate signup does it.
     */
    subscribe(input: SubscribeInput): Promise<SubscribeOutcome>;
    /**
     * Complete double opt-in.
     *
     * Only a `pending_confirmation` row is promoted. An `unsubscribed` address
     * is not resurrected by a stale link: it has to subscribe again, because
     * consent after a withdrawal must be affirmative, not incidental.
     */
    confirm(token: string): Promise<ConfirmOutcome>;
    /** Unsubscribe from a tokenized link, or from the RFC 8058 one-click POST. */
    unsubscribeWithToken(token: string): Promise<UnsubscribeOutcome>;
    /** Unsubscribe an address. Idempotent, and never fails on a missing row loudly. */
    unsubscribe(rawEmail: string): Promise<UnsubscribeOutcome>;
    /** Record a provider delivery event. Used by the suppression path. */
    markUndeliverable(rawEmail: string, kind: 'bounced' | 'complained'): Promise<SubscriberRecord | null>;
    list(query?: SubscriberQuery): Promise<SubscriberListResult>;
    /** Active subscriber count, optionally scoped to one surface. */
    countActive(source?: string): Promise<number>;
    /** The default `source` written for this surface. */
    get defaultSource(): string;
}
//# sourceMappingURL=store.d.ts.map