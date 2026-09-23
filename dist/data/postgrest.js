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
import { silentLogger } from '../internal/logger.js';
/** Raised for any non-2xx response. Carries the status so callers can branch. */
export class PostgrestError extends Error {
    status;
    detail;
    constructor(operation, status, detail) {
        super(`PostgREST ${operation} failed with ${status}: ${detail}`);
        this.name = 'PostgrestError';
        this.status = status;
        this.detail = detail;
    }
}
/**
 * Parse PostgREST's `Content-Range` header.
 *
 * PostgREST returns `0-9/42` for a paginated set, and a star before the slash
 * (as in `*` followed by `/0`) when the set is empty.
 */
function parseTotal(contentRange) {
    if (!contentRange)
        return null;
    const afterSlash = contentRange.split('/')[1];
    if (afterSlash === undefined)
        return null;
    const total = Number.parseInt(afterSlash, 10);
    return Number.isNaN(total) ? null : total;
}
export class PostgrestClient {
    config;
    logger;
    constructor(config) {
        this.config = config;
        this.logger = config.logger ?? silentLogger;
    }
    endpoint(table, params) {
        const url = new URL(`${this.config.url.replace(/\/+$/, '')}/rest/v1/${table}`);
        for (const [key, value] of Object.entries(params ?? {})) {
            url.searchParams.set(key, value);
        }
        return url;
    }
    headers(extra) {
        return {
            apikey: this.config.serviceRoleKey,
            Authorization: `Bearer ${this.config.serviceRoleKey}`,
            'Content-Type': 'application/json',
            ...(extra ?? {}),
        };
    }
    async request(url, init, operation) {
        const doFetch = this.config.fetchImpl ?? globalThis.fetch;
        const response = await doFetch(url, init);
        if (!response.ok) {
            const detail = await response.text();
            this.logger.error('PostgREST request failed', {
                operation,
                status: response.status,
                detail: detail.slice(0, 500),
            });
            throw new PostgrestError(operation, response.status, detail.slice(0, 500));
        }
        return response;
    }
    /** Select rows, optionally with an exact count of the unpaginated set. */
    async select(table, params = {}, withCount = false) {
        const headers = withCount ? this.headers({ Prefer: 'count=exact' }) : this.headers();
        const response = await this.request(this.endpoint(table, params), { method: 'GET', headers }, `select ${table}`);
        const payload = (await response.json());
        return {
            rows: Array.isArray(payload) ? payload : [],
            total: withCount ? parseTotal(response.headers.get('content-range')) : null,
        };
    }
    /**
     * Select a single row, or null when there is none.
     *
     * Uses a plain select with `limit=1` rather than the singular
     * `application/vnd.pgrst.object+json` accept header, because that header
     * turns "no rows" into a 406 error, and a missing row is an ordinary
     * outcome rather than a failure.
     */
    async selectOne(table, params) {
        const { rows } = await this.select(table, { ...params, limit: '1' });
        return rows[0] ?? null;
    }
    /** Count rows matching `params`, without transferring them. */
    async count(table, params = {}) {
        const { total } = await this.select(table, { ...params, select: 'id', limit: '1' }, true);
        return total ?? 0;
    }
    /** Insert one row and return the stored representation. */
    async insert(table, row) {
        const response = await this.request(this.endpoint(table), {
            method: 'POST',
            headers: this.headers({ Prefer: 'return=representation' }),
            body: JSON.stringify(row),
        }, `insert ${table}`);
        const payload = (await response.json());
        const created = payload[0];
        if (!created)
            throw new PostgrestError(`insert ${table}`, 500, 'no row returned');
        return created;
    }
    /**
     * Insert several rows in one request.
     *
     * One request rather than a loop: PostgREST accepts an array body, so a
     * batch is a single round trip and a single transaction.
     */
    async insertMany(table, rows) {
        if (rows.length === 0)
            return [];
        const response = await this.request(this.endpoint(table), {
            method: 'POST',
            headers: this.headers({ Prefer: 'return=representation' }),
            body: JSON.stringify(rows),
        }, `insert ${table}`);
        const payload = (await response.json());
        return Array.isArray(payload) ? payload : [];
    }
    /** Patch every row matching `match`, returning the updated rows. */
    async update(table, match, patch) {
        const response = await this.request(this.endpoint(table, match), {
            method: 'PATCH',
            headers: this.headers({ Prefer: 'return=representation' }),
            body: JSON.stringify(patch),
        }, `update ${table}`);
        const payload = (await response.json());
        return Array.isArray(payload) ? payload : [];
    }
    /** Delete every row matching `match`. Returns the number removed. */
    async remove(table, match) {
        const response = await this.request(this.endpoint(table, match), { method: 'DELETE', headers: this.headers({ Prefer: 'return=representation' }) }, `delete ${table}`);
        const payload = (await response.json());
        return Array.isArray(payload) ? payload.length : 0;
    }
    /**
     * Call a Postgres function exposed through PostgREST.
     *
     * The response shape depends entirely on the function, so the caller names
     * the type. Functions that return void still answer with a body, which is
     * why this does not try to interpret it.
     */
    async rpc(fn, args = {}) {
        const response = await this.request(new URL(`${this.config.url.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`), {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify(args),
        }, `rpc ${fn}`);
        return (await response.json());
    }
}
/**
 * Build a client, or `null` when the project is not configured.
 *
 * Returning `null` rather than throwing keeps the caller in charge of the
 * response: a missing database is a misconfiguration the operator needs to
 * see, not a crash on a page that otherwise renders fine.
 */
export function createPostgrest(config) {
    if (!config.url || !config.serviceRoleKey)
        return null;
    return new PostgrestClient({
        url: config.url,
        serviceRoleKey: config.serviceRoleKey,
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
        ...(config.logger ? { logger: config.logger } : {}),
    });
}
/**
 * Escape a value for use inside a PostgREST filter expression.
 *
 * PostgREST parses `()`, `,`, `"` and `\` inside a filter, so an unescaped
 * user-supplied string can change the shape of the query rather than act as a
 * value. Everything dangerous is removed, not encoded, because PostgREST's
 * filter grammar has no escape sequence for these.
 */
export function filterValue(value) {
    return value.replace(/[(),"\\]/g, '');
}
/**
 * Build a PostgREST `ilike` pattern from a user search term.
 *
 * `*` and `%` are stripped so a caller cannot widen the match, and the term is
 * wrapped in `*` for a substring match.
 */
export function likePattern(term) {
    return `*${term.replace(/[*(),"%\\]/g, '').trim()}*`;
}
//# sourceMappingURL=postgrest.js.map