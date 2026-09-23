/**
 * The email service factory.
 *
 * `createEmailService(config)` is called **per request**, never at module
 * scope, because the Cloudflare email binding lives on `event.platform.env`
 * and therefore changes between requests. The hub's current
 * `export const emailProvider = EmailProviderFactory.getProvider()` is the
 * exact pattern this replaces.
 */
import { EmailConfigError, silentLogger } from './types.js';
import { BUILT_IN_PROVIDERS, createMockProvider } from './providers.js';
import { isEmailAddress, listUnsubscribeHeaders } from './render.js';
export class EmailService {
    provider;
    context;
    constructor(provider, context) {
        this.provider = provider;
        this.context = context;
    }
    /** Which transport this instance will use. */
    get providerName() {
        return this.provider.name;
    }
    async send(message) {
        if (!isEmailAddress(message.to)) {
            return { success: false, provider: this.provider.name, error: `Invalid recipient: ${message.to}` };
        }
        return this.provider.send(message, this.context);
    }
    async sendBulk(messages) {
        return this.provider.sendBulk(messages, this.context);
    }
    /** Send a rendered template, wiring headers and defaults in one place. */
    async sendRendered(rendered, options) {
        const headers = [...(options.headers ?? [])];
        if (options.unsubscribeUrl) {
            headers.push(...listUnsubscribeHeaders(options.unsubscribeUrl, options.unsubscribeMailto));
        }
        const message = {
            to: options.toBe,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            headers,
        };
        if (options.replyTo !== undefined)
            message.replyTo = options.replyTo;
        if (options.tags !== undefined)
            message.tags = options.tags;
        return this.send(message);
    }
    async getStatus() {
        const configured = this.provider.isConfigured(this.context);
        return {
            provider: this.provider.name,
            configured,
            healthy: configured ? await this.provider.healthCheck(this.context) : false,
        };
    }
    async healthCheck() {
        try {
            return await this.provider.healthCheck(this.context);
        }
        catch (error) {
            this.context.logger.error('Email health check threw', { error: String(error) });
            return false;
        }
    }
}
function resolveProvider(name, options) {
    const override = options?.providers?.[name];
    if (override)
        return override;
    if (name === 'mock') {
        throw new EmailConfigError('mock', "The mock provider is never selected implicitly. Pass { providers: { mock: createMockProvider().provider } } to enable it.");
    }
    return BUILT_IN_PROVIDERS[name];
}
function assertSender(provider, config) {
    if (!isEmailAddress(config.from)) {
        throw new EmailConfigError(provider, `EmailConfig.from is not a valid address: "${config.from}"`);
    }
    if (!isEmailAddress(config.replyTo)) {
        throw new EmailConfigError(provider, `EmailConfig.replyTo is not a valid address: "${config.replyTo}"`);
    }
    if (!config.theme || !config.theme.accent || !config.theme.ink) {
        throw new EmailConfigError(provider, 'EmailConfig.theme is incomplete.');
    }
}
/**
 * Build an email service for one request.
 *
 * Throws {@link EmailConfigError} when the requested provider is missing
 * configuration. Failing here, at construction, is deliberate: a service that
 * constructs successfully and then drops mail is worse than one that refuses
 * to start.
 */
export function createEmailService(config, options) {
    const provider = resolveProvider(config.provider, options);
    assertSender(provider.name, config);
    const context = {
        config,
        logger: options?.logger ?? config.logger ?? silentLogger,
        fetchImpl: config.fetchImpl ?? globalThis.fetch,
    };
    if (!provider.isConfigured(context)) {
        throw new EmailConfigError(provider.name, `Provider "${provider.name}" is not configured. Provide the credentials it needs in EmailConfig.`);
    }
    return new EmailService(provider, context);
}
/** Re-exported so an application can build a mock service without the registry. */
export { createMockProvider };
//# sourceMappingURL=service.js.map