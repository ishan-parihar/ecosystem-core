/**
 * @ishan/ecosystem-core
 *
 * The shared core for the Ishan Parihar ecosystem surfaces. It carries the
 * infrastructure every surface would otherwise rewrite: email transport, the
 * subscriber state machine and its signed tokens, the PostgREST client, the
 * Supabase subscriber adapter, and the abuse-handling primitives.
 *
 * The injection contract, binding on every file in this package:
 *
 *   - no `$env/*`, `$lib/*`, `$app/*`, `import.meta.env`
 *   - no `node:*` builtins
 *   - no module-level singletons that read configuration at import time
 *   - every factory takes a plain config object and is called per request,
 *     because Cloudflare bindings live on `platform.env` and change between
 *     requests
 *
 * Read `README.md` for the consumption model and `docs/SHARED-CORE.md` in the
 * consuming repositories for the migration order.
 */
export * from './email/index.js';
export * from './subscribers/index.js';
export * from './data/index.js';
export * from './http/index.js';
export { resolveLogger, silentLogger } from './internal/logger.js';
export { sha256Hex, timingSafeEqual } from './internal/hash.js';
//# sourceMappingURL=index.js.map