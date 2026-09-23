import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	loadTurnstileScript,
	mountTurnstile,
	resetTurnstileScriptCache,
	type TurnstileApi,
} from './turnstile-widget.js';

interface FakeScript {
	src: string;
	async: boolean;
	defer: boolean;
	dataset: Record<string, string>;
	addEventListener: (name: string, handler: () => void, options?: unknown) => void;
	fire: (name: string) => void;
}

const globals = globalThis as { document?: unknown; turnstile?: TurnstileApi };

/** A DOM stub just large enough to observe what the loader does. */
function installFakeDom() {
	const appended: FakeScript[] = [];
	const listeners = new Map<string, () => void>();

	const document = {
		querySelector: () => null,
		createElement: () => {
			const script: FakeScript = {
				src: '',
				async: false,
				defer: false,
				dataset: {},
				addEventListener: (name, handler) => listeners.set(name, handler),
				fire: (name) => listeners.get(name)?.(),
			};
			appended.push(script);
			return script;
		},
		head: { appendChild: (script: FakeScript) => script.fire('load') },
	};

	globals.document = document;
	return { appended, document };
}

function teardownDom() {
	delete globals.document;
	delete globals.turnstile;
	resetTurnstileScriptCache();
}

afterEach(teardownDom);

describe('loadTurnstileScript', () => {
	it('resolves immediately without a document, so a server import is inert', async () => {
		delete globals.document;
		await expect(loadTurnstileScript()).resolves.toBeUndefined();
	});

	it('injects the explicit-render script once', async () => {
		const { appended } = installFakeDom();

		await loadTurnstileScript();

		expect(appended).toHaveLength(1);
		expect(appended[0]?.src).toBe(
			'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
		);
		expect(appended[0]?.dataset.turnstile).toBe('true');
	});

	it('dedupes concurrent calls so two forms cannot load two copies', async () => {
		const { appended } = installFakeDom();

		await Promise.all([loadTurnstileScript(), loadTurnstileScript(), loadTurnstileScript()]);

		expect(appended).toHaveLength(1);
	});

	it('does not inject at all once the API is already present', async () => {
		const { appended } = installFakeDom();
		globals.turnstile = { render: () => 'w', reset: () => undefined };

		await loadTurnstileScript();

		expect(appended).toHaveLength(0);
	});
});

describe('mountTurnstile', () => {
	it('returns a teardown that is safe before the widget exists', () => {
		installFakeDom();
		const teardown = mountTurnstile({} as HTMLElement, 'site-key', () => undefined);
		expect(() => teardown()).not.toThrow();
	});

	it('renders into the container with the site key and reports tokens', async () => {
		installFakeDom();
		const render = vi.fn(() => 'widget-1');
		globals.turnstile = { render, reset: vi.fn() };
		const onToken = vi.fn();

		mountTurnstile({} as HTMLElement, 'my-site-key', onToken);
		await Promise.resolve();
		await Promise.resolve();

		expect(render).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ sitekey: 'my-site-key' }),
		);
		const options = render.mock.calls[0]?.[1] as { callback?: (t: string) => void };
		options.callback?.('token-abc');
		expect(onToken).toHaveBeenCalledWith('token-abc');
	});

	it('reports an empty token when the widget expires', async () => {
		installFakeDom();
		const render = vi.fn(() => 'widget-1');
		globals.turnstile = { render, reset: vi.fn() };
		const onToken = vi.fn();

		mountTurnstile({} as HTMLElement, 'k', onToken);
		await Promise.resolve();
		await Promise.resolve();

		const options = render.mock.calls[0]?.[1] as { 'expired-callback'?: () => void };
		options['expired-callback']?.();
		expect(onToken).toHaveBeenCalledWith('');
	});

	it('removes the widget on teardown', async () => {
		installFakeDom();
		const remove = vi.fn();
		globals.turnstile = { render: () => 'widget-9', reset: vi.fn(), remove };

		const teardown = mountTurnstile({} as HTMLElement, 'k', () => undefined);
		await Promise.resolve();
		await Promise.resolve();
		teardown();

		expect(remove).toHaveBeenCalledWith('widget-9');
	});

	it('does not render after teardown, so a fast unmount cannot leak a widget', async () => {
		installFakeDom();
		const render = vi.fn(() => 'widget-1');
		globals.turnstile = { render, reset: vi.fn() };

		const teardown = mountTurnstile({} as HTMLElement, 'k', () => undefined);
		teardown();
		await Promise.resolve();
		await Promise.resolve();

		expect(render).not.toHaveBeenCalled();
	});
});
