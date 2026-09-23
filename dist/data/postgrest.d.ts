/**
 * A minimal PostgREST client.
 *
 * Deliberately not `@supabase/supabase-js`. Every surface in the ecosystem
 * needs the same handful of query shapes, all of which are plain HTTP against
 * the REST endpoint Supabase exposes. The SDK would add a dependency and a
 * bundle for no extra capability inside a Worker, and it brings its own
 * module-level client construction, which the injection contract bans.
 *
 * Service-role only. Nothing here is reachable from the browser, and the key
 * arrives as an argument rather than being read from the environment.
 */
import type { Logger } from '../internal/logger.js';
export interface PostgrestConfig {
    /** Project URL, e.g. `https://abcdefgh.supabase.co`. */
    url: string;
    /** Service-role key. Never the anon key: these queries bypass RLS by design. */
    serviceRoleKey: string;
    /** Injected so a test can drive the client without a network. */
    fetchImpl?: typeof fetch;
    /** Injected logger. Defaults to silent. */
    logger?: Logger;
}
/** Raised for any non-2xx response. Carries the status so callers can branch. */
export declare class PostgrestError extends Error {
    readonly status: number;
    readonly detail: string;
    constructor(operation: string, status: number, detail: string);
}
export interface SelectResult<T> {
    rows: T[];
    /** Row count ignoring pagination, when `Prefer: count=exact` was requested. */
    total: number | null;
}
export declare class PostgrestClient {
    private readonly config;
    private readonly logger;
    constructor(config: PostgrestConfig);
    private endpoint;
    private headers;
    private request;
    /** Select rows, optionally with an exact count of the unpaginated set. */
    select<T>(table: string, params?: Record<string, string>, withCount?: boolean): Promise<SelectResult<T>>;
    /**
     * Select a single row, or null when there is none.
     *
     * Uses a plain select with `limit=1` rather than the singular
     * `application/vnd.pgrst.object+json` accept header, because that header
     * turns "no rows" into a 406 error, and a missing row is an ordinary
     * outcome rather than a failure.
     */
    selectOne<T>(table: string, params: Record<string, string>): Promise<T | null>;
    /** Count rows matching `params`, without transferring them. */
    count(table: string, params?: Record<string, string>): Promise<number>;
    /** Insert one row and return the stored representation. */
    insert<T>(table: string, row: Record<string, unknown>): Promise<T>;
    /**
     * Insert several rows in one request.
     *
     * One request rather than a loop: PostgREST accepts an array body, so a
     * batch is a single round trip and a single transaction.
     */
    insertMany<T>(table: string, rows: Record<string, unknown>[]): Promise<T[]>;
    /** Patch every row matching `match`, returning the updated rows. */
    update<T>(table: string, match: Record<string, string>, patch: Record<string, unknown>): Promise<T[]>;
    /** Delete every row matching `match`. Returns the number removed. */
    remove(table: string, match: Record<string, string>): Promise<number>;
    /**
     * Call a Postgres function exposed through PostgREST.
     *
     * The response shape depends entirely on the function, so the caller names
     * the type. Functions that return void still answer with a body, which is
     * why this does not try to interpret it.
     */
    rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T>;
}
/**
 * Build a client, or `null` when the project is not configured.
 *
 * Returning `null` rather than throwing keeps the caller in charge of the
 * response: a missing database is a misconfiguration the operator needs to
 * see, not a crash on a page that otherwise renders fine.
 */
export declare function createPostgrest(config: {
    url: string | undefined;
    serviceRoleKey: string | undefined;
    fetchImpl?: typeof fetch;
    logger?: Logger;
}): PostgrestClient | null;
/**
 * Escape a value for use inside a PostgREST filter expression.
 *
 * PostgREST parses `()`, `,`, `"` and `\` inside a filter, so an unescaped
 * user-supplied string can change the shape of the query rather than act as a
 * value. Everything dangerous is removed, not encoded, because PostgREST's
 * filter grammar has no escape sequence for these.
 */
export declare function filterValue(value: string): string;
/**
 * Build a PostgREST `ilike` pattern from a user search term.
 *
 * `*` and `%` are stripped so a caller cannot widen the match, and the term is
 * wrapped in `*` for a substring match.
 */
export declare function likePattern(term: string): string;
//# sourceMappingURL=postgrest.d.ts.map