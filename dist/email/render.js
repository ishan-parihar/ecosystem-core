/**
 * Email rendering.
 *
 * One renderer, many themes. `EmailTheme` is an argument, so the hub's
 * serif/gold letterhead and this surface's graphite/amber letterhead come
 * from the same template tree instead of two drifting copies.
 */
const DEFAULT_FONTS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const DEFAULT_MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
/**
 * Escape text for interpolation into HTML.
 *
 * Every user-supplied value that reaches a template must pass through this.
 * A contact form is attacker-controlled input flowing into an email body.
 */
export function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
/** Collapse whitespace and strip control characters from a header value. */
export function sanitizeHeaderValue(value) {
    // Header injection is the risk: CR/LF terminate a header line.
    return value.replace(/[\r\n\u0000]+/g, ' ').trim();
}
/** Minimal well-formedness check. Deliberately permissive; the provider is authoritative. */
export function isEmailAddress(value) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > 254)
        return false;
    if (/\s/.test(trimmed))
        return false;
    const at = trimmed.lastIndexOf('@');
    if (at <= 0 || at === trimmed.length - 1)
        return false;
    const domain = trimmed.slice(at + 1);
    return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}
/** Normalise an address for storage and comparison. */
export function normalizeEmail(value) {
    return value.trim().toLowerCase();
}
/** RFC 8058 requires these two headers on bulk mail. */
export function listUnsubscribeHeaders(unsubscribeUrl, mailto) {
    const targets = mailto ? [`<${unsubscribeUrl}>`, `<mailto:${mailto}>`] : [`<${unsubscribeUrl}>`];
    return [
        { name: 'List-Unsubscribe', value: targets.join(', ') },
        { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
    ];
}
/**
 * The shared email shell: header wordmark, content panel, footer.
 *
 * Table-free and inline-styled on purpose: email clients strip `<style>`
 * unpredictably, but every client honours inline styles and a max-width div.
 */
export function renderEmailShell(input) {
    const { theme } = input;
    const fontStack = theme.fontStack ?? DEFAULT_FONTS;
    const preheader = input.preheader
        ? `<div style="display:none;font-size:1px;color:${theme.ground};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(input.preheader)}</div>`
        : '';
    const cta = input.cta
        ? `<p style="margin:32px 0 0 0;">
			<a href="${escapeHtml(input.cta.url)}" style="display:inline-block;padding:14px 28px;background-color:${theme.accent};color:${theme.accentInk};text-decoration:none;font-weight:600;font-size:15px;border-radius:3px;">${escapeHtml(input.cta.label)}</a>
		</p>`
        : '';
    const footerLinks = [
        input.unsubscribeUrl
            ? `<a href="${escapeHtml(input.unsubscribeUrl)}" style="color:${theme.inkMuted};text-decoration:underline;">Unsubscribe</a>`
            : null,
        input.preferencesUrl
            ? `<a href="${escapeHtml(input.preferencesUrl)}" style="color:${theme.inkMuted};text-decoration:underline;">Update preferences</a>`
            : null,
    ]
        .filter((entry) => entry !== null)
        .join(' &nbsp;|&nbsp; ');
    const addressLine = theme.footerAddress
        ? `<br>${escapeHtml(theme.footerAddress)}`
        : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta name="color-scheme" content="light dark">
	<title>${escapeHtml(input.title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${theme.ground};font-family:${fontStack};color:${theme.ink};-webkit-font-smoothing:antialiased;">
	${preheader}
	<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${theme.ground};">
		<tr>
			<td align="center" style="padding:32px 16px;">
				<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
					<tr>
						<td style="padding-bottom:20px;border-bottom:1px solid ${theme.border};">
							<div style="font-size:15px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${theme.ink};">${escapeHtml(theme.brandName)}</div>
							<div style="margin-top:4px;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${theme.inkMuted};font-family:${theme.monoStack ?? DEFAULT_MONO};">${escapeHtml(theme.brandTagline)}</div>
						</td>
					</tr>
					<tr>
						<td style="padding:32px 0 0 0;">
							<h1 style="margin:0 0 20px 0;font-size:26px;line-height:1.25;font-weight:600;color:${theme.ink};">${escapeHtml(input.title)}</h1>
							${input.bodyHtml}
							${cta}
						</td>
					</tr>
					<tr>
						<td style="padding-top:36px;">
							<div style="border-top:1px solid ${theme.border};padding-top:18px;font-size:12px;line-height:1.6;color:${theme.inkMuted};">
								${escapeHtml(theme.footerIdentity)}${addressLine}
								${footerLinks ? `<br>${footerLinks}` : ''}
							</div>
						</td>
					</tr>
				</table>
			</td>
		</tr>
	</table>
</body>
</html>`;
}
/**
 * Wrap campaign content with the theme and a per-recipient unsubscribe footer.
 *
 * The unsubscribe URL is per recipient, so this is called once per address.
 * Doing it here, rather than in each surface's campaign loop, is why a
 * compliance bug cannot exist on one surface and not the other.
 */
export function wrapCampaignContent(contentHtml, input) {
    return renderEmailShell({
        theme: input.theme,
        title: input.theme.brandName,
        bodyHtml: `<div style="font-size:16px;line-height:1.65;color:${input.theme.ink};">${contentHtml}</div>`,
        unsubscribeUrl: input.unsubscribeUrl,
        preferencesUrl: input.preferencesUrl,
    });
}
/** Double opt-in confirmation. */
export function confirmSubscriptionEmail(input) {
    const { theme } = input;
    const subject = `Confirm your subscription to ${theme.brandName}`;
    const html = renderEmailShell({
        theme,
        title: 'Confirm your subscription',
        preheader: `One click to confirm, the link is valid for ${input.ttlDays} days.`,
        bodyHtml: `<p style="margin:0 0 16px 0;font-size:16px;line-height:1.65;color:${theme.ink};">You are one click away from the list. Confirming proves the address is yours, so nobody is subscribed without asking.</p>
			<p style="margin:0 0 8px 0;font-size:16px;line-height:1.65;color:${theme.ink};">This link is valid for ${input.ttlDays} days.</p>
			<p style="margin:0;font-size:13px;line-height:1.6;color:${theme.inkMuted};">If you did not subscribe, ignore this message and nothing further will be sent.</p>`,
        cta: { label: 'Confirm my subscription', url: input.confirmUrl },
    });
    const text = `Confirm your subscription to ${theme.brandName}\n\nOpen this link to confirm (valid ${input.ttlDays} days):\n${input.confirmUrl}\n\nIf you did not subscribe, ignore this email.`;
    return { subject, html, text };
}
/**
 * The operator-facing notification for a website contact submission.
 *
 * Sent in the transactional lane to the operator's mailbox, with the
 * submitter's address in `Reply-To` so answering is a normal reply.
 */
export function contactNotificationEmail(input) {
    const { theme } = input;
    const safeName = input.name.trim() || 'Unnamed sender';
    const subject = `[${input.intent}] ${safeName} via ${theme.brandName}`;
    const extraRows = Object.entries(input.context ?? {})
        .map(([key, value]) => `<tr><td style="padding:6px 0;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${theme.inkMuted};font-family:${theme.monoStack ?? DEFAULT_MONO};">${escapeHtml(key)}</td><td style="padding:6px 0;font-size:14px;color:${theme.ink};">${escapeHtml(value)}</td></tr>`)
        .join('');
    const html = renderEmailShell({
        theme,
        title: `New enquiry: ${input.intent}`,
        preheader: `${safeName} sent a message through the site.`,
        bodyHtml: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-bottom:24px;">
				<tr><td style="padding:6px 0;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${theme.inkMuted};">From</td><td style="padding:6px 0;font-size:14px;color:${theme.ink};">${escapeHtml(safeName)} &lt;${escapeHtml(input.email)}&gt;</td></tr>
				<tr><td style="padding:6px 0;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${theme.inkMuted};">Intent</td><td style="padding:6px 0;font-size:14px;color:${theme.ink};">${escapeHtml(input.intent)}</td></tr>
				<tr><td style="padding:6px 0;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${theme.inkMuted};">Received</td><td style="padding:6px 0;font-size:14px;color:${theme.ink};">${escapeHtml(input.submittedAt)}</td></tr>
				${extraRows}
			</table>
			<div style="border-top:1px solid ${theme.border};padding-top:20px;font-size:15px;line-height:1.65;color:${theme.ink};white-space:pre-wrap;">${escapeHtml(input.message)}</div>
			<p style="margin:24px 0 0 0;font-size:13px;line-height:1.6;color:${theme.inkMuted};">Reply directly to this message to answer ${escapeHtml(safeName)}.</p>`,
        cta: { label: `Reply to ${safeName}`, url: `mailto:${input.email}?subject=${encodeURIComponent(`Re: ${subject}`)}` },
    });
    const text = [
        `New enquiry: ${input.intent}`,
        '',
        `From: ${safeName} <${input.email}>`,
        `Received: ${input.submittedAt}`,
        ...Object.entries(input.context ?? {}).map(([key, value]) => `${key}: ${value}`),
        '',
        input.message,
    ].join('\n');
    return { subject, html, text };
}
//# sourceMappingURL=render.js.map