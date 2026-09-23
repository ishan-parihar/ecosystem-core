/**
 * The Supabase implementation of `SubscriberTable`.
 *
 * This lives in the package rather than in each application because it is pure
 * mapping: the shared `newsletter_subscribers` table has one shape, so every
 * surface that reads it was going to write the same column list, the same
 * status narrowing and the same `undefined`-elision rules. Only the table name
 * and the column set are parameters.
 *
 * The client arrives as a handle. This module never constructs one and never
 * reads an environment variable.
 */
import { likePattern } from '../data/postgrest.js';
/**
 * Columns read back into a record.
 *
 * Listed explicitly rather than `*` so a schema change cannot silently widen
 * the shape the store validates. It must stay in sync with `SubscriberRecord`.
 */
export const DEFAULT_SUBSCRIBER_COLUMNS = [
    'id',
    'email',
    'first_name',
    'last_name',
    'status',
    'source',
    'subscription_type',
    'tags',
    'interests',
    'domain_interests',
    'lead_magnet',
    'lead_score',
    'created_at',
    'updated_at',
    'unsubscribed_at',
    'confirmed_at',
];
export const DEFAULT_SUBSCRIBER_TABLE = 'newsletter_subscribers';
function asString(value) {
    return typeof value === 'string' ? value : null;
}
function asStringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((entry) => typeof entry === 'string');
}
/**
 * Validate the stored status.
 *
 * A switch rather than a cast: an unrecognised value from the database should
 * not be able to become a `SubscriberStatus` by assertion. An unknown status is
 * read as `pending_confirmation`, which is the safest interpretation, because
 * it means the address receives nothing until it is explicitly confirmed.
 */
export function asSubscriberStatus(value) {
    switch (value) {
        case 'active':
            return 'active';
        case 'unsubscribed':
            return 'unsubscribed';
        case 'bounced':
            return 'bounced';
        case 'complained':
            return 'complained';
        case 'pending_confirmation':
            return 'pending_confirmation';
        default:
            return 'pending_confirmation';
    }
}
/** Map a stored row into a `SubscriberRecord`. */
export function toSubscriberRecord(row) {
    return {
        id: String(row.id ?? ''),
        email: String(row.email ?? ''),
        first_name: asString(row.first_name),
        last_name: asString(row.last_name),
        status: asSubscriberStatus(row.status),
        source: asString(row.source),
        subscription_type: asString(row.subscription_type),
        tags: asStringArray(row.tags),
        interests: asStringArray(row.interests),
        domain_interests: asStringArray(row.domain_interests),
        lead_magnet: asString(row.lead_magnet),
        lead_score: typeof row.lead_score === 'number' ? row.lead_score : 0,
        created_at: String(row.created_at ?? ''),
        updated_at: String(row.updated_at ?? ''),
        unsubscribed_at: asString(row.unsubscribed_at),
        confirmed_at: asString(row.confirmed_at),
    };
}
/**
 * Drop `undefined` entries so an omitted field is never written as null.
 *
 * This is the difference between "leave the column alone" and "clear the
 * column", and it is why a patch is typed as a partial rather than a record.
 */
function definedEntries(source) {
    const out = {};
    for (const [key, value] of Object.entries(source)) {
        if (value !== undefined)
            out[key] = value;
    }
    return out;
}
export class SupabaseSubscriberTable {
    db;
    table;
    columns;
    constructor(db, options = {}) {
        this.db = db;
        this.table = options.table ?? DEFAULT_SUBSCRIBER_TABLE;
        this.columns = (options.columns ?? DEFAULT_SUBSCRIBER_COLUMNS).join(',');
    }
    async findByEmail(email) {
        const row = await this.db.selectOne(this.table, {
            select: this.columns,
            email: `eq.${email}`,
        });
        return row ? toSubscriberRecord(row) : null;
    }
    async insert(row) {
        const created = await this.db.insert(this.table, definedEntries(row));
        return toSubscriberRecord(created);
    }
    async updateById(id, patch) {
        const rows = await this.db.update(this.table, { id: `eq.${id}` }, definedEntries(patch));
        const first = rows[0];
        return first ? toSubscriberRecord(first) : null;
    }
    async updateByEmail(email, patch) {
        const rows = await this.db.update(this.table, { email: `eq.${email}` }, definedEntries(patch));
        const first = rows[0];
        return first ? toSubscriberRecord(first) : null;
    }
    async list(query) {
        const params = {
            select: this.columns,
            order: 'created_at.desc',
            limit: String(query.limit ?? 50),
            offset: String(query.offset ?? 0),
        };
        if (query.status && query.status !== 'all')
            params.status = `eq.${query.status}`;
        if (query.source)
            params.source = `eq.${query.source}`;
        const term = query.search?.trim();
        if (term) {
            const pattern = likePattern(term);
            params.or = `(email.ilike.${pattern},first_name.ilike.${pattern},last_name.ilike.${pattern})`;
        }
        const { rows, total } = await this.db.select(this.table, params, true);
        return { rows: rows.map(toSubscriberRecord), total };
    }
    async countActive(source) {
        const params = { status: 'eq.active' };
        if (source)
            params.source = `eq.${source}`;
        return this.db.count(this.table, params);
    }
}
/**
 * Build the adapter from a client, or `null` when there is no client.
 *
 * Mirrors `createPostgrest`: a missing database is a configuration state the
 * caller reports, not an exception it has to catch.
 */
export function createSupabaseSubscriberTable(db, options) {
    return db ? new SupabaseSubscriberTable(db, options) : null;
}
//# sourceMappingURL=supabase-table.js.map