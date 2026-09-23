/**
 * Email rendering.
 *
 * One renderer, many themes. `EmailTheme` is an argument, so the hub's
 * serif/gold letterhead and this surface's graphite/amber letterhead come
 * from the same template tree instead of two drifting copies.
 */
import type { EmailHeader, EmailTheme } from './types.js';
/**
 * Escape text for interpolation into HTML.
 *
 * Every user-supplied value that reaches a template must pass through this.
 * A contact form is attacker-controlled input flowing into an email body.
 */
export declare function escapeHtml(value: string): string;
/** Collapse whitespace and strip control characters from a header value. */
export declare function sanitizeHeaderValue(value: string): string;
/** Minimal well-formedness check. Deliberately permissive; the provider is authoritative. */
export declare function isEmailAddress(value: string): boolean;
/** Normalise an address for storage and comparison. */
export declare function normalizeEmail(value: string): string;
/** RFC 8058 requires these two headers on bulk mail. */
export declare function listUnsubscribeHeaders(unsubscribeUrl: string, mailto?: string): EmailHeader[];
export interface ShellInput {
    theme: EmailTheme;
    /** Shown in the panel heading. */
    title: string;
    /** Inner HTML, already built and already escaped where needed. */
    bodyHtml: string;
    /** Optional hidden preheader line. */
    preheader?: string;
    /** When present, renders the compliance footer. */
    unsubscribeUrl?: string;
    preferencesUrl?: string;
    /** Optional primary call to action rendered under the body. */
    cta?: {
        label: string;
        url: string;
    };
}
/**
 * The shared email shell: header wordmark, content panel, footer.
 *
 * Table-free and inline-styled on purpose: email clients strip `<style>`
 * unpredictably, but every client honours inline styles and a max-width div.
 */
export declare function renderEmailShell(input: ShellInput): string;
export interface RenderedEmail {
    subject: string;
    html: string;
    text: string;
}
/**
 * Wrap campaign content with the theme and a per-recipient unsubscribe footer.
 *
 * The unsubscribe URL is per recipient, so this is called once per address.
 * Doing it here, rather than in each surface's campaign loop, is why a
 * compliance bug cannot exist on one surface and not the other.
 */
export declare function wrapCampaignContent(contentHtml: string, input: {
    theme: EmailTheme;
    unsubscribeUrl: string;
    preferencesUrl?: string;
}): string;
/** Double opt-in confirmation. */
export declare function confirmSubscriptionEmail(input: {
    theme: EmailTheme;
    confirmUrl: string;
    ttlDays: number;
}): RenderedEmail;
export interface ContactNotificationInput {
    theme: EmailTheme;
    name: string;
    email: string;
    /** Which intent route the sender picked, e.g. "Hiring full-time". */
    intent: string;
    message: string;
    /** ISO timestamp, passed in rather than read from the clock. */
    submittedAt: string;
    /** Extra labelled facts, already stringified. */
    context?: Record<string, string>;
}
/**
 * The operator-facing notification for a website contact submission.
 *
 * Sent in the transactional lane to the operator's mailbox, with the
 * submitter's address in `Reply-To` so answering is a normal reply.
 */
export declare function contactNotificationEmail(input: ContactNotificationInput): RenderedEmail;
//# sourceMappingURL=render.d.ts.map