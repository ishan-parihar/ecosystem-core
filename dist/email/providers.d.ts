/**
 * The four email providers.
 *
 * Every provider is stateless: it receives an {@link EmailContext} and reads
 * configuration from it. None of them touch `process.env`, a module-level
 * singleton, or a Node builtin, so all four run unchanged in Cloudflare Workers.
 */
import type { EmailMessage, EmailProvider, ProviderName } from './types.js';
export interface MockProviderHandle {
    provider: EmailProvider;
    /** Every message handed to the mock, in order. */
    sent: EmailMessage[];
    reset(): void;
}
/**
 * A provider that sends nothing and records everything.
 *
 * This is what development and the test suite use. It is explicitly NOT
 * selected by environment detection: the application must ask for it, so a
 * misconfigured production environment can never silently fall back to
 * dropping mail.
 */
export declare function createMockProvider(): MockProviderHandle;
/**
 * Sends through the Cloudflare Email Service binding, `env.EMAIL`.
 *
 * No API key, because the binding carries its own authorisation, and SPF,
 * DKIM and DMARC are configured by Cloudflare when the domain is onboarded.
 * It is also the only provider reachable from an agent over MCP without
 * managing a secret, which is why it is the preferred target.
 */
export declare const cloudflareProvider: EmailProvider;
export declare const resendProvider: EmailProvider;
/**
 * Sends through the Gmail API.
 *
 * The API rather than SMTP, deliberately: Google's documented daily cap is
 * per user and shared across every client, so SMTP reaches exactly the same
 * ceiling with more moving parts. Used for the conversational lane, and as a
 * fallback only.
 */
export declare const gmailProvider: EmailProvider;
/** The built-in providers, keyed by name. Callers may override any of them. */
export declare const BUILT_IN_PROVIDERS: Readonly<Record<Exclude<ProviderName, 'mock'>, EmailProvider>>;
//# sourceMappingURL=providers.d.ts.map