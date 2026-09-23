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
/**
 * Read the global Turnstile API.
 *
 * Read through `globalThis` rather than a global `Window` augmentation, so the
 * package does not impose an ambient declaration on every consumer.
 */
function turnstileGlobal() {
    return globalThis.turnstile;
}
const SCRIPT_SELECTOR = 'script[data-turnstile]';
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let scriptPromise = null;
/** Load `api.js` once per document, resolving immediately on the server. */
export function loadTurnstileScript() {
    if (typeof document === 'undefined')
        return Promise.resolve();
    if (turnstileGlobal())
        return Promise.resolve();
    if (scriptPromise)
        return scriptPromise;
    scriptPromise = new Promise((resolve) => {
        const existing = document.querySelector(SCRIPT_SELECTOR);
        if (existing) {
            existing.addEventListener('load', () => resolve(), { once: true });
            // Already executed before this listener attached.
            if (turnstileGlobal())
                resolve();
            return;
        }
        const script = document.createElement('script');
        script.src = SCRIPT_SRC;
        script.async = true;
        script.defer = true;
        script.dataset.turnstile = 'true';
        script.addEventListener('load', () => resolve(), { once: true });
        document.head.appendChild(script);
    });
    return scriptPromise;
}
/**
 * Render a Turnstile widget into `container`.
 *
 * Returns a teardown function suitable for `onMount`. `onToken` receives an
 * empty string when the token expires or errors, which is what tells the form
 * to stop trusting the token it holds.
 */
export function mountTurnstile(container, siteKey, onToken) {
    let widgetId = null;
    let cancelled = false;
    void loadTurnstileScript().then(() => {
        const api = turnstileGlobal();
        if (cancelled || !api)
            return;
        widgetId = api.render(container, {
            sitekey: siteKey,
            theme: 'dark',
            callback: onToken,
            'expired-callback': () => onToken(''),
            'error-callback': () => onToken(''),
        });
    });
    return () => {
        cancelled = true;
        const id = widgetId;
        if (id === null)
            return;
        try {
            turnstileGlobal()?.remove?.(id);
        }
        catch {
            // A widget already torn down by a client-side navigation is not an error.
        }
    };
}
/** Reset the script cache. Test-only. */
export function resetTurnstileScriptCache() {
    scriptPromise = null;
}
//# sourceMappingURL=turnstile-widget.js.map