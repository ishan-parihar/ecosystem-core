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
import { listUnsubscribeHeaders, normalizeEmail, wrapCampaignContent } from '../email/index.js';
import { resolveLogger } from '../internal/logger.js';
import { TOKEN_PURPOSE_UNSUBSCRIBE } from '../subscribers/store.js';
import { mintToken } from '../tokens/index.js';
/** Cap a single send, so a mis-set tag cannot mail an entire table by accident. */
export const DEFAULT_CAMPAIGN_BATCH_SIZE = 25;
export const DEFAULT_MAX_RECIPIENTS = 5_000;
/**
 * Build the PostgREST array filter for tags.
 *
 * PostgREST spells "contains all" as `cs` and "overlaps" as `ov`, both taking a
 * brace-delimited list. Elements are double quoted because a tag containing a
 * comma would otherwise be read as two tags.
 */
export function buildTagsFilter(tags, match) {
    const operator = match === 'all' ? 'cs' : 'ov';
    const quoted = tags.map((tag) => `"${tag.replace(/"/g, '\\"')}"`).join(',');
    return `${operator}.{${quoted}}`;
}
/**
 * A recipient source over the shared Supabase project.
 *
 * Reads only `active` rows, always scoped by `source`, and paginates so a large
 * list is not truncated by PostgREST's default row cap.
 */
export function createSupabaseRecipientSource(client, options = {}) {
    if (!client)
        return null;
    const table = options.table ?? 'newsletter_subscribers';
    const pageSize = options.pageSize ?? 1_000;
    const logger = resolveLogger(options.logger);
    return {
        async list(query) {
            const params = {
                select: 'id,email',
                // Terminal and unconfirmed statuses are excluded here rather than
                // filtered later, so a mis-set caller cannot mail them at all.
                status: 'eq.active',
                source: `eq.${query.source}`,
                order: 'id.asc',
            };
            if (query.tags !== undefined && query.tags.length > 0) {
                params.tags = buildTagsFilter(query.tags, query.match ?? 'any');
            }
            const ceiling = query.limit ?? DEFAULT_MAX_RECIPIENTS;
            const collected = [];
            for (let offset = 0; offset < ceiling; offset += pageSize) {
                const take = Math.min(pageSize, ceiling - offset);
                const { rows } = await client.select(table, {
                    ...params,
                    limit: String(take),
                    offset: String(offset),
                });
                for (const row of rows) {
                    collected.push({ email: normalizeEmail(row.email), id: row.id });
                }
                if (rows.length < take)
                    break;
            }
            logger.info('Campaign recipient scan complete', {
                source: query.source,
                tags: query.tags ?? [],
                count: collected.length,
            });
            return collected;
        },
    };
}
/**
 * Send a campaign.
 *
 * Returns counts rather than throwing: a campaign to a thousand people where
 * twelve addresses hard-bounced is a success with twelve records, not a failed
 * send. The caller decides what to do with `failures`.
 */
export async function sendCampaign(service, source, options) {
    const logger = resolveLogger(options.logger);
    const batchSize = options.batchSize ?? DEFAULT_CAMPAIGN_BATCH_SIZE;
    const unsubscribePath = options.unsubscribePath ?? '/newsletter/unsubscribe';
    const recipients = await source.list(options.query);
    const result = {
        attempted: recipients.length,
        sent: 0,
        failed: 0,
        failures: [],
        batches: 0,
        dryRun: options.dryRun === true,
    };
    if (recipients.length === 0) {
        logger.info('Campaign had no recipients', { source: options.query.source });
        return result;
    }
    // One token per recipient. Minting once and reusing it would let one
    // person's link unsubscribe everybody it was sent to.
    const prepared = [];
    for (const recipient of recipients) {
        const token = await mintToken({ purpose: TOKEN_PURPOSE_UNSUBSCRIBE, email: recipient.email }, { secret: options.tokenSecret, expiresInSec: 0 });
        const unsubscribeUrl = `${options.theme.siteUrl.replace(/\/+$/, '')}${unsubscribePath}?token=${encodeURIComponent(token)}`;
        const { subject, bodyHtml } = options.render(recipient);
        prepared.push({
            to: recipient.email,
            subject,
            html: wrapCampaignContent(bodyHtml, { theme: options.theme, unsubscribeUrl }),
            headers: listUnsubscribeHeaders(unsubscribeUrl, options.theme.replyTo),
        });
    }
    if (result.dryRun) {
        logger.info('Campaign dry run: nothing sent', { prepared: prepared.length });
        return result;
    }
    for (let index = 0; index < prepared.length; index += batchSize) {
        const batch = prepared.slice(index, index + batchSize);
        result.batches += 1;
        const batchResult = await service.sendBulk(batch);
        result.sent += batchResult.sent;
        result.failed += batchResult.failed;
        // `results` is index-aligned with the batch, so the error can be attributed
        // to the exact address it belongs to. Matching on the error text instead
        // would misattribute every failure in a batch that shared one reason.
        for (let position = 0; position < batch.length; position += 1) {
            const outcome = batchResult.results[position];
            if (outcome === undefined || outcome.success)
                continue;
            const email = batch[position]?.to ?? '';
            const error = outcome.error ?? 'send failed';
            result.failures.push({ email, error });
            // Best effort: a source that cannot record the failure must not abort
            // the rest of the campaign.
            if (source.markFailed) {
                try {
                    await source.markFailed(email, error);
                }
                catch (markError) {
                    logger.warn('Could not record campaign failure', { email, error: String(markError) });
                }
            }
        }
        logger.info('Campaign batch complete', {
            batch: result.batches,
            sent: batchResult.sent,
            failed: batchResult.failed,
        });
    }
    return result;
}
//# sourceMappingURL=index.js.map