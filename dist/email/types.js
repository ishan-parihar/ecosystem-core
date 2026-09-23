/**
 * Email core: types, provider contract, and configuration.
 *
 * INJECTION CONTRACT (binding on every file in this package):
 *   - no `$env/*`, `$lib/*`, `$app/*`, `import.meta.env`
 *   - no `node:*` builtins
 *   - no module-level singletons that read configuration at import time
 *
 * Everything a provider needs arrives as an argument, because Cloudflare
 * bindings are per-request (`event.platform.env`), not per-process.
 */
/** Raised at construction, never at send time, so misconfiguration is loud. */
export class EmailConfigError extends Error {
    provider;
    constructor(provider, message) {
        super(message);
        this.name = 'EmailConfigError';
        this.provider = provider;
    }
}
/** A logger that discards everything. Keeps the package silent by default. */
export { silentLogger } from '../internal/logger.js';
//# sourceMappingURL=types.js.map