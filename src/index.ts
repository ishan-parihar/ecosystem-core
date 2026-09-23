/**
 * @ishan/ecosystem-core
 *
 * The shared core for the Ishan Parihar ecosystem surfaces. It carries the
 * infrastructure every surface would otherwise rewrite, and every one of these
 * modules exists because the same code had already been written more than once:
 *
 *   email/       transport, providers, and the one theme-driven renderer
 *   subscribers/ the double opt-in state machine and the Supabase adapter
 *   tokens/      signed links: confirm, unsubscribe, reset, guest access
 *   campaign/    recipient selection by source and tag, batched send
 *   cache/       KV and in-isolate stores behind one interface
 *   http/        rate limiting (both limiters), Turnstile, IP hashing
 *   security/    brute-force lockout
 *   monitoring/  delivery metrics as a pure function
 *   data/        PostgREST client
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
export * from './tokens/index.js';
export * from './cache/index.js';
export * from './campaign/index.js';
export * from './security/index.js';
export * from './monitoring/index.js';
export * from './data/index.js';
export * from './http/index.js';

export type { Logger } from './internal/logger.js';
export { resolveLogger, silentLogger } from './internal/logger.js';
export { sha256Hex, timingSafeEqual } from './internal/hash.js';
