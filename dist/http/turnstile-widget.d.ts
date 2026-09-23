/**
 * Lazy Cloudflare Turnstile loading, browser side.
 *
 * Optional by design: with no site key the script is never fetched and no
 * form pays for it. With one, every form on every surface renders a widget,
 * because the server verifies a token whenever a secret is configured and a
 * form without a widget would be rejected every time.
 *
 * The script loads once per document, deduped through a module-level promise,
 * so two forms on one page cannot race each other into two copies of `api.js`.
 *
 * This file touches the DOM only inside functions, never at import scope, so
 * importing it in a server context is inert. It carries no framework
 * dependency on purpose: the same loader serves SvelteKit, a plain script tag,
 * and a test.
 */
export interface TurnstileRenderOptions {
    sitekey: string;
    theme?: 'light' | 'dark' | 'auto';
    callback?: (token: string) => void;
    'expired-callback'?: () => void;
    'error-callback'?: () => void;
}
export interface TurnstileApi {
    render(container: HTMLElement, options: TurnstileRenderOptions): string;
    reset(widgetId?: string): void;
    remove?(widgetId?: string): void;
}
/** Load `api.js` once per document, resolving immediately on the server. */
export declare function loadTurnstileScript(): Promise<void>;
/**
 * Render a Turnstile widget into `container`.
 *
 * Returns a teardown function suitable for `onMount`. `onToken` receives an
 * empty string when the token expires or errors, which is what tells the form
 * to stop trusting the token it holds.
 */
export declare function mountTurnstile(container: HTMLElement, siteKey: string, onToken: (token: string) => void): () => void;
/** Reset the script cache. Test-only. */
export declare function resetTurnstileScriptCache(): void;
//# sourceMappingURL=turnstile-widget.d.ts.map