/**
 * Campaigns: pick the right people, then mail them without breaking consent.
 *
 * This module exists because the same bug was written twice. Both the hub's
 * `sendEmailCampaign` and the CMS's `sendCampaign` chunk a recipient list, send,
 * and tolerate partial failure, and both were reachable without a signed
 * unsubscribe link. The CMS's version built `?email=<address>`, so anybody who
 * knew an address could unsubscribe it, and it sent no `List-Unsubscribe`
 * headers at all, which is what Gmail and Yahoo require of a bulk sender.
 *
 * A campaign sender is the wrong place for that decision to be made
 * individually, so it is made once, here:
 *
 *   1. **Recipients are selected by `source` and `tags`, never by "all".** The
 *      shared `newsletter_subscribers` table holds every surface's list, so an
 *      unscoped send mails one brand's audience another brand's newsletter.
 *   2. **Only `active` rows are mailed.** `pending_confirmation` has not
 *      finished double opt-in, and `bounced`, `complained` and `unsubscribed`
 *      are terminal. Mailing any of them is either a consent breach or a
 *      deliverability hit.
 *   3. **Every message carries its own signed unsubscribe link**, plus the
 *      RFC 8058 headers. The token is minted per recipient, so one person
 *      opting out cannot affect another.
 *   4. **A failure is recorded per recipient**, not swallowed into a count.
 *
 * The renderer stays a callback so each surface keeps its own voice and
 * letterhead; the shell, the footer and the headers are added here so they
 * cannot drift between surfaces.
 */
import { type EmailService, type EmailTheme } from '../email/index.js';
import type { PostgrestClient } from '../data/postgrest.js';
import { type Logger } from '../internal/logger.js';
/** One address to mail. `id` is optional and only used for logging. */
export interface CampaignRecipient {
    email: string;
    id?: string;
}
/** How to select recipients. `source` is required: see the module note. */
export interface RecipientQuery {
    /** The surface whose list is being mailed. */
    source: string;
    /** Tag filter for niche campaigns. */
    tags?: string[];
    /** `any` matches a subscriber with at least one tag; `all` requires every tag. */
    match?: 'any' | 'all';
    /** Hard ceiling on how many to return. */
    limit?: number;
}
export interface RecipientSource {
    list(query: RecipientQuery): Promise<CampaignRecipient[]>;
    /** Optional per-recipient failure record, so a bounce can be suppressed later. */
    markFailed?(email: string, reason: string): Promise<void>;
}
export interface CampaignSendOptions {
    theme: EmailTheme;
    /** HMAC secret for unsubscribe tokens. Must match every surface that verifies them. */
    tokenSecret: string;
    /** Absolute path on the surface that hosts unsubscribe. Default `/newsletter/unsubscribe`. */
    unsubscribePath?: string;
    /** Batch size. Default 25, which is what both existing senders used. */
    batchSize?: number;
    /** Render this message for this recipient. The surface owns its voice. */
    render: (recipient: CampaignRecipient) => {
        subject: string;
        bodyHtml: string;
    };
    /** Build the message first, send nothing. */
    dryRun?: boolean;
    query: RecipientQuery;
    logger?: Logger;
    /** Injectable for tests. Defaults to `globalThis.fetch` through the provider. */
    fetchImpl?: typeof fetch;
}
export interface CampaignFailure {
    email: string;
    error: string;
}
export interface CampaignSendResult {
    attempted: number;
    sent: number;
    failed: number;
    failures: CampaignFailure[];
    batches: number;
    dryRun: boolean;
}
/** Cap a single send, so a mis-set tag cannot mail an entire table by accident. */
export declare const DEFAULT_CAMPAIGN_BATCH_SIZE = 25;
export declare const DEFAULT_MAX_RECIPIENTS = 5000;
/**
 * Build the PostgREST array filter for tags.
 *
 * PostgREST spells "contains all" as `cs` and "overlaps" as `ov`, both taking a
 * brace-delimited list. Elements are double quoted because a tag containing a
 * comma would otherwise be read as two tags.
 */
export declare function buildTagsFilter(tags: string[], match: 'any' | 'all'): string;
export interface SupabaseRecipientSourceOptions {
    table?: string;
    /** Page size for the recipient scan. */
    pageSize?: number;
    logger?: Logger;
}
/**
 * A recipient source over the shared Supabase project.
 *
 * Reads only `active` rows, always scoped by `source`, and paginates so a large
 * list is not truncated by PostgREST's default row cap.
 */
export declare function createSupabaseRecipientSource(client: PostgrestClient | null, options?: SupabaseRecipientSourceOptions): RecipientSource | null;
/**
 * Send a campaign.
 *
 * Returns counts rather than throwing: a campaign to a thousand people where
 * twelve addresses hard-bounced is a success with twelve records, not a failed
 * send. The caller decides what to do with `failures`.
 */
export declare function sendCampaign(service: EmailService, source: RecipientSource, options: CampaignSendOptions): Promise<CampaignSendResult>;
//# sourceMappingURL=index.d.ts.map