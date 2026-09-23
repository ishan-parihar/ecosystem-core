export type { BatchResult, CloudflareEmailBinding, CloudflareEmailMessage, EmailConfig, EmailContext, EmailHeader, EmailLogger, EmailMessage, EmailProvider, EmailTheme, GmailCredentials, ProviderName, ProviderStatus, SendResult, } from './types.js';
export { EmailConfigError, silentLogger } from './types.js';
export { contactNotificationEmail, confirmSubscriptionEmail, escapeHtml, isEmailAddress, listUnsubscribeHeaders, normalizeEmail, renderEmailShell, sanitizeHeaderValue, wrapCampaignContent, } from './render.js';
export type { ContactNotificationInput, RenderedEmail, ShellInput } from './render.js';
export { BUILT_IN_PROVIDERS, cloudflareProvider, createMockProvider, gmailProvider, resendProvider, } from './providers.js';
export type { MockProviderHandle } from './providers.js';
export { EmailService, createEmailService } from './service.js';
export type { EmailServiceOptions, SendRenderedOptions } from './service.js';
//# sourceMappingURL=index.d.ts.map