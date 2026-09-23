/**
 * The email service factory.
 *
 * `createEmailService(config)` is called **per request**, never at module
 * scope, because the Cloudflare email binding lives on `event.platform.env`
 * and therefore changes between requests. The hub's current
 * `export const emailProvider = EmailProviderFactory.getProvider()` is the
 * exact pattern this replaces.
 */
import type { BatchResult, EmailConfig, EmailContext, EmailLogger, EmailMessage, EmailProvider, ProviderName, ProviderStatus, SendResult } from './types.js';
import { createMockProvider } from './providers.js';
import { type RenderedEmail } from './render.js';
export interface EmailServiceOptions {
    /** Override or inject providers. The test suite uses this for the mock. */
    providers?: Partial<Record<ProviderName, EmailProvider>>;
    logger?: EmailLogger;
}
/** Options for sending an already-rendered template. */
export interface SendRenderedOptions {
    toBe: string;
    replyTo?: string;
    headers?: EmailMessage['headers'];
    tags?: EmailMessage['tags'];
    /** Adds RFC 8058 one-click headers. Required for bulk mail. */
    unsubscribeUrl?: string;
    unsubscribeMailto?: string;
}
export declare class EmailService {
    readonly provider: EmailProvider;
    private readonly context;
    constructor(provider: EmailProvider, context: EmailContext);
    /** Which transport this instance will use. */
    get providerName(): ProviderName;
    send(message: EmailMessage): Promise<SendResult>;
    sendBulk(messages: EmailMessage[]): Promise<BatchResult>;
    /** Send a rendered template, wiring headers and defaults in one place. */
    sendRendered(rendered: RenderedEmail, options: SendRenderedOptions): Promise<SendResult>;
    getStatus(): Promise<ProviderStatus>;
    healthCheck(): Promise<boolean>;
}
/**
 * Build an email service for one request.
 *
 * Throws {@link EmailConfigError} when the requested provider is missing
 * configuration. Failing here, at construction, is deliberate: a service that
 * constructs successfully and then drops mail is worse than one that refuses
 * to start.
 */
export declare function createEmailService(config: EmailConfig, options?: EmailServiceOptions): EmailService;
/** Re-exported so an application can build a mock service without the registry. */
export { createMockProvider };
//# sourceMappingURL=service.d.ts.map