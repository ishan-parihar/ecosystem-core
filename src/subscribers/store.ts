/**
 * The subscriber store.
 *
 * Carries the parts that must be identical on every surface: the double
 * opt-in state machine, the suppression policy, and the token rules. The
 * table itself is injected, so the same logic drives whichever database the
 * consuming application owns.
 */

import { isEmailAddress, normalizeEmail } from '../email/render.js';
import type {
	SubscribeInput,
	SubscribeOutcome,
	SubscriberListResult,
	SubscriberPatch,
	SubscriberQuery,
	SubscriberRecord,
	SubscriberStatus,
	SubscriberStoreOptions,
	SubscriberTable,
	ConfirmOutcome,
	UnsubscribeOutcome,
} from './types.js';
import { SUPPRESSED_STATUSES } from './types.js';
import { mintToken, verifyToken } from './tokens.js';

/** Token purposes. Checked on verify, so a confirm link cannot unsubscribe. */
export const TOKEN_PURPOSE_CONFIRM = 'newsletter_confirm';
export const TOKEN_PURPOSE_UNSUBSCRIBE = 'newsletter_unsubscribe';

/** Raised for input the store refuses to act on, before touching storage. */
export class SubscriberInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SubscriberInputError';
	}
}

function isSuppressed(
	status: SubscriberStatus,
): status is 'bounced' | 'complained' {
	return (SUPPRESSED_STATUSES as readonly string[]).includes(status);
}

export class SubscriberStore {
	private readonly table: SubscriberTable;
	private readonly options: SubscriberStoreOptions;

	constructor(table: SubscriberTable, options: SubscriberStoreOptions) {
		if (!options.tokenSecret || options.tokenSecret.length < 16) {
			throw new SubscriberInputError(
				'SubscriberStoreOptions.tokenSecret must be at least 16 characters.',
			);
		}
		this.table = table;
		this.options = options;
	}

	private nowMs(): number {
		return this.options.now ? this.options.now() : Date.now();
	}

	private nowIso(): string {
		return new Date(this.nowMs()).toISOString();
	}

	/** The double opt-in confirmation URL for an address. */
	async buildConfirmUrl(email: string): Promise<string> {
		const token = await mintToken(
			{ purpose: TOKEN_PURPOSE_CONFIRM, email: normalizeEmail(email) },
			{ secret: this.options.tokenSecret, expiresInSec: this.options.confirmTtlSec, nowMs: this.nowMs() },
		);
		return `${this.options.siteUrl}/newsletter/confirm?token=${encodeURIComponent(token)}`;
	}

	/** The tokenized unsubscribe URL a human clicks. */
	async buildUnsubscribeUrl(email: string): Promise<string> {
		return `${this.options.siteUrl}/newsletter/unsubscribe?token=${await this.mintUnsubscribeToken(email)}`;
	}

	/**
	 * The RFC 8058 one-click endpoint URL, for the `List-Unsubscribe` header.
	 *
	 * It carries the same token as the human page, so a mail client POSTing to
	 * it needs no confirmation step and no second secret.
	 */
	async buildOneClickUnsubscribeUrl(email: string): Promise<string> {
		const path = this.options.unsubscribeApiPath ?? '/api/newsletter/unsubscribe';
		return `${this.options.siteUrl}${path}?token=${await this.mintUnsubscribeToken(email)}`;
	}

	private async mintUnsubscribeToken(email: string): Promise<string> {
		const token = await mintToken(
			{ purpose: TOKEN_PURPOSE_UNSUBSCRIBE, email: normalizeEmail(email) },
			{
				secret: this.options.tokenSecret,
				expiresInSec: this.options.unsubscribeTtlSec,
				nowMs: this.nowMs(),
			},
		);
		return encodeURIComponent(token);
	}

	/**
	 * Subscribe an address, landing in `pending_confirmation`.
	 *
	 * Returning `suppressed` rather than a confirmation URL for a bounced or
	 * complained address is deliberate: re-confirming a known-bad address is
	 * what damages a sending domain, and no legitimate signup does it.
	 */
	async subscribe(input: SubscribeInput): Promise<SubscribeOutcome> {
		const email = normalizeEmail(input.email);
		if (!isEmailAddress(email)) {
			throw new SubscriberInputError(`Not a valid email address: "${input.email}"`);
		}

		const timestamp = this.nowIso();
		const existing = await this.table.findByEmail(email);

		if (existing) {
			if (isSuppressed(existing.status)) {
				return { kind: 'suppressed', record: existing, reason: existing.status };
			}
			if (existing.status === 'active') {
				return { kind: 'already_active', record: existing };
			}

			const patch: SubscriberPatch = {
				status: 'pending_confirmation',
				unsubscribed_at: null,
				updated_at: timestamp,
			};
			if (input.firstName !== undefined) patch.first_name = input.firstName;
			if (input.lastName !== undefined) patch.last_name = input.lastName;
			if (input.tags !== undefined) patch.tags = input.tags;
			if (input.interests !== undefined) patch.interests = input.interests;
			if (input.domainInterests !== undefined) patch.domain_interests = input.domainInterests;
			if (input.leadMagnet !== undefined) patch.lead_magnet = input.leadMagnet;
			if (input.source !== undefined) patch.source = input.source;
			if (input.subscriptionType !== undefined) patch.subscription_type = input.subscriptionType;

			const updated = await this.table.updateById(existing.id, patch);
			return {
				kind: 'pending_confirmation',
				// A failed update falls back to the row we already read. The caller
				// still gets a usable record and a fresh confirmation link.
				record: updated ?? existing,
				confirmUrl: await this.buildConfirmUrl(email),
				reused: true,
			};
		}

		const created = await this.table.insert({
			email,
			first_name: input.firstName ?? null,
			last_name: input.lastName ?? null,
			status: 'pending_confirmation',
			source: input.source ?? this.options.defaultSource,
			subscription_type: input.subscriptionType ?? this.options.defaultSubscriptionType ?? null,
			tags: input.tags ?? [],
			interests: input.interests ?? [],
			domain_interests: input.domainInterests ?? [],
			lead_magnet: input.leadMagnet ?? null,
			created_at: timestamp,
			updated_at: timestamp,
		});

		return {
			kind: 'pending_confirmation',
			record: created,
			confirmUrl: await this.buildConfirmUrl(email),
			reused: false,
		};
	}

	/**
	 * Complete double opt-in.
	 *
	 * Only a `pending_confirmation` row is promoted. An `unsubscribed` address
	 * is not resurrected by a stale link: it has to subscribe again, because
	 * consent after a withdrawal must be affirmative, not incidental.
	 */
	async confirm(token: string): Promise<ConfirmOutcome> {
		const verified = await verifyToken(token, {
			secret: this.options.tokenSecret,
			expectedPurpose: TOKEN_PURPOSE_CONFIRM,
			nowMs: this.nowMs(),
		});
		if (!verified.valid) return { kind: 'invalid_token', reason: verified.reason };

		const email = normalizeEmail(verified.payload.email);
		const existing = await this.table.findByEmail(email);
		if (!existing) return { kind: 'not_found' };
		if (existing.status === 'active') return { kind: 'already_confirmed', record: existing };
		if (existing.status !== 'pending_confirmation') return { kind: 'not_found' };

		const timestamp = this.nowIso();
		const updated = await this.table.updateById(existing.id, {
			status: 'active',
			confirmed_at: timestamp,
			unsubscribed_at: null,
			updated_at: timestamp,
		});
		if (!updated) return { kind: 'not_found' };
		return { kind: 'confirmed', record: updated };
	}

	/** Unsubscribe from a tokenized link, or from the RFC 8058 one-click POST. */
	async unsubscribeWithToken(token: string): Promise<UnsubscribeOutcome> {
		const verified = await verifyToken(token, {
			secret: this.options.tokenSecret,
			expectedPurpose: TOKEN_PURPOSE_UNSUBSCRIBE,
			nowMs: this.nowMs(),
		});
		if (!verified.valid) return { kind: 'invalid_token', reason: verified.reason };
		return this.unsubscribe(verified.payload.email);
	}

	/** Unsubscribe an address. Idempotent, and never fails on a missing row loudly. */
	async unsubscribe(rawEmail: string): Promise<UnsubscribeOutcome> {
		const email = normalizeEmail(rawEmail);
		if (!isEmailAddress(email)) {
			throw new SubscriberInputError(`Not a valid email address: "${rawEmail}"`);
		}

		const existing = await this.table.findByEmail(email);
		if (!existing) return { kind: 'not_found' };
		if (existing.status === 'unsubscribed') {
			return { kind: 'unsubscribed', record: existing, alreadyUnsubscribed: true };
		}
		// A bounce or complaint is stickier than an unsubscribe: keep the
		// suppression reason so the address is never mailed again.
		if (isSuppressed(existing.status)) {
			return { kind: 'unsubscribed', record: existing, alreadyUnsubscribed: true };
		}

		const timestamp = this.nowIso();
		const updated = await this.table.updateById(existing.id, {
			status: 'unsubscribed',
			unsubscribed_at: timestamp,
			updated_at: timestamp,
		});
		if (!updated) return { kind: 'not_found' };
		return { kind: 'unsubscribed', record: updated, alreadyUnsubscribed: false };
	}

	/** Record a provider delivery event. Used by the suppression path. */
	async markUndeliverable(
		rawEmail: string,
		kind: 'bounced' | 'complained',
	): Promise<SubscriberRecord | null> {
		const email = normalizeEmail(rawEmail);
		const existing = await this.table.findByEmail(email);
		if (!existing) return null;
		return this.table.updateById(existing.id, { status: kind, updated_at: this.nowIso() });
	}

	async list(query: SubscriberQuery = {}): Promise<SubscriberListResult> {
		return this.table.list(query);
	}

	/** Active subscriber count, optionally scoped to one surface. */
	async countActive(source?: string): Promise<number> {
		return this.table.countActive(source);
	}

	/** The default `source` written for this surface. */
	get defaultSource(): string {
		return this.options.defaultSource;
	}
}
