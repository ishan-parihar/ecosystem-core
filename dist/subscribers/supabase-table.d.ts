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
import type { PostgrestClient } from '../data/postgrest.js';
import type { SubscriberInsert, SubscriberListResult, SubscriberPatch, SubscriberQuery, SubscriberRecord, SubscriberStatus, SubscriberTable } from './types.js';
/**
 * Columns read back into a record.
 *
 * Listed explicitly rather than `*` so a schema change cannot silently widen
 * the shape the store validates. It must stay in sync with `SubscriberRecord`.
 */
export declare const DEFAULT_SUBSCRIBER_COLUMNS: readonly string[];
export declare const DEFAULT_SUBSCRIBER_TABLE = "newsletter_subscribers";
export interface SupabaseSubscriberTableOptions {
    /** Table name. Defaults to `newsletter_subscribers`. */
    table?: string;
    /** Columns to select. Defaults to `DEFAULT_SUBSCRIBER_COLUMNS`. */
    columns?: readonly string[];
}
/**
 * Validate the stored status.
 *
 * A switch rather than a cast: an unrecognised value from the database should
 * not be able to become a `SubscriberStatus` by assertion. An unknown status is
 * read as `pending_confirmation`, which is the safest interpretation, because
 * it means the address receives nothing until it is explicitly confirmed.
 */
export declare function asSubscriberStatus(value: unknown): SubscriberStatus;
/** Map a stored row into a `SubscriberRecord`. */
export declare function toSubscriberRecord(row: Record<string, unknown>): SubscriberRecord;
export declare class SupabaseSubscriberTable implements SubscriberTable {
    private readonly db;
    private readonly table;
    private readonly columns;
    constructor(db: PostgrestClient, options?: SupabaseSubscriberTableOptions);
    findByEmail(email: string): Promise<SubscriberRecord | null>;
    insert(row: SubscriberInsert): Promise<SubscriberRecord>;
    updateById(id: string, patch: SubscriberPatch): Promise<SubscriberRecord | null>;
    updateByEmail(email: string, patch: SubscriberPatch): Promise<SubscriberRecord | null>;
    list(query: SubscriberQuery): Promise<SubscriberListResult>;
    countActive(source?: string): Promise<number>;
}
/**
 * Build the adapter from a client, or `null` when there is no client.
 *
 * Mirrors `createPostgrest`: a missing database is a configuration state the
 * caller reports, not an exception it has to catch.
 */
export declare function createSupabaseSubscriberTable(db: PostgrestClient | null, options?: SupabaseSubscriberTableOptions): SupabaseSubscriberTable | null;
//# sourceMappingURL=supabase-table.d.ts.map