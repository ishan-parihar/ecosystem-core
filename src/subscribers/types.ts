/**
 * Subscriber core: types and the storage adapter contract.
 *
 * The adapter is an interface rather than a Supabase client on purpose. The
 * package carries the state machine, the token rules and the suppression
 * policy; the application supplies the table. That keeps the package free of
 * `@supabase/supabase-js` and free of `$env`, while the duplicated surface
 * stays at roughly forty lines of glue per application.
 */

/**
 * The double opt-in lifecycle.
 *
 * `bounced` and `complained` are terminal for sending purposes: those
 * addresses are never re-subscribed (see `SubscriberStore.subscribe`).
 */
export type SubscriberStatus =
	| 'pending_confirmation'
	| 'active'
	| 'unsubscribed'
	| 'bounced'
	| 'complained';

/** The statuses that must never receive another campaign. */
export const SUPPRESSED_STATUSES: readonly SubscriberStatus[] = ['bounced', 'complained'];

/** A row as stored. Mirrors the shared `newsletter_subscribers` table. */
export interface SubscriberRecord {
	id: string;
	email: string;
	first_name: string | null;
	last_name: string | null;
	status: SubscriberStatus;
	source: string | null;
	subscription_type: string | null;
	tags: string[];
	interests: string[];
	domain_interests: string[];
	lead_magnet: string | null;
	lead_score: number;
	created_at: string;
	updated_at: string;
	unsubscribed_at: string | null;
	confirmed_at: string | null;
}

/** The fields a caller may set when creating a subscriber. */
export interface SubscriberInsert {
	email: string;
	first_name?: string | null;
	last_name?: string | null;
	status: SubscriberStatus;
	source?: string | null;
	subscription_type?: string | null;
	tags?: string[];
	interests?: string[];
	domain_interests?: string[];
	lead_magnet?: string | null;
	created_at: string;
	updated_at: string;
}

/** A partial update. Only the listed keys are written. */
export interface SubscriberPatch {
	first_name?: string | null;
	last_name?: string | null;
	status?: SubscriberStatus;
	source?: string | null;
	subscription_type?: string | null;
	tags?: string[];
	interests?: string[];
	domain_interests?: string[];
	lead_magnet?: string | null;
	unsubscribed_at?: string | null;
	confirmed_at?: string | null;
	updated_at?: string;
}

export interface SubscriberQuery {
	status?: SubscriberStatus | 'all';
	/** Scope the list to one surface, e.g. `technical-authority`. */
	source?: string;
	search?: string;
	limit?: number;
	offset?: number;
}

export interface SubscriberListResult {
	rows: SubscriberRecord[];
	total: number | null;
}

/**
 * The storage adapter each application implements against its own table.
 *
 * Every method is scoped to a single table and returns plain records, so the
 * same package drives the hub's Supabase table and this surface's writes to it.
 */
export interface SubscriberTable {
	findByEmail(email: string): Promise<SubscriberRecord | null>;
	/** Insert a new row. Must fail rather than upsert, so callers stay explicit. */
	insert(row: SubscriberInsert): Promise<SubscriberRecord>;
	updateById(id: string, patch: SubscriberPatch): Promise<SubscriberRecord | null>;
	updateByEmail(email: string, patch: SubscriberPatch): Promise<SubscriberRecord | null>;
	list(query: SubscriberQuery): Promise<SubscriberListResult>;
	/** Active subscribers, optionally scoped to one surface. */
	countActive(source?: string): Promise<number>;
}

export interface SubscriberStoreOptions {
	/** HMAC secret for confirm and unsubscribe tokens. Injected, never read from env here. */
	tokenSecret: string;
	/** Confirm link lifetime in seconds. */
	confirmTtlSec: number;
	/** Unsubscribe links never expire by design; kept explicit for documentation. */
	unsubscribeTtlSec: number;
	/** Absolute origin for the confirm and unsubscribe routes, no trailing slash. */
	siteUrl: string;
	/**
	 * Path of the RFC 8058 one-click unsubscribe endpoint, relative to `siteUrl`.
	 *
	 * Separate from the human unsubscribe page because Gmail and Yahoo require a
	 * POST endpoint, and most frameworks cannot serve a POST and a page at the
	 * same URL.
	 */
	unsubscribeApiPath?: string;
	/** Written to `source` when a caller does not supply one. */
	defaultSource: string;
	/** Written to `subscription_type` when a caller does not supply one. */
	defaultSubscriptionType?: string;
	/** Injectable clock, so token expiry is testable. */
	now?: () => number;
}

/* -------------------------------------------------------------------------- */
/* Outcomes                                                                    */
/* -------------------------------------------------------------------------- */

export type SubscribeOutcome =
	| { kind: 'pending_confirmation'; record: SubscriberRecord; confirmUrl: string; reused: boolean }
	| { kind: 'already_active'; record: SubscriberRecord }
	| { kind: 'suppressed'; record: SubscriberRecord; reason: 'bounced' | 'complained' };

export type ConfirmOutcome =
	| { kind: 'confirmed'; record: SubscriberRecord }
	| { kind: 'already_confirmed'; record: SubscriberRecord }
	| { kind: 'not_found' }
	| { kind: 'invalid_token'; reason: string };

export type UnsubscribeOutcome =
	| { kind: 'unsubscribed'; record: SubscriberRecord; alreadyUnsubscribed: boolean }
	| { kind: 'not_found' }
	| { kind: 'invalid_token'; reason: string };

export interface SubscribeInput {
	email: string;
	firstName?: string | undefined;
	lastName?: string | undefined;
	tags?: string[] | undefined;
	interests?: string[] | undefined;
	domainInterests?: string[] | undefined;
	leadMagnet?: string | undefined;
	source?: string | undefined;
	subscriptionType?: string | undefined;
}
