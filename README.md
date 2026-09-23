# @ishan/ecosystem-core

Shared infrastructure for the Ishan Parihar ecosystem surfaces. One source of
truth for the utilities that would otherwise be rewritten in every repository:
email transport, the subscriber store with its signed tokens, a PostgREST
client, the Supabase subscriber adapter, and the abuse-handling primitives.

```text
src/
  email/          providers (cloudflare, resend, gmail, mock), renderer, service
  subscribers/    state machine, tokens, Supabase adapter, store contract
  data/           PostgREST client
  http/           rate limiter, Turnstile, IP hashing
  internal/       base64, hashing, logger
```

## Why this exists

Every consumer surface is SvelteKit on `@sveltejs/adapter-cloudflare`, deployed
to Cloudflare Pages. That gives three hard constraints, and they are the reason
a copied `src/lib` folder cannot work:

| Constraint | Consequence |
|---|---|
| `$lib`, `$env/*`, `$app/*` are SvelteKit virtual modules, scoped to one application | The package imports none of them. Configuration arrives as an argument |
| Cloudflare bindings arrive on `event.platform.env`, so they are **per request**, not per process | The package exposes factories, never a module-level singleton |
| Applications deploy separately and can be at different versions | The package is versioned and pinned, not a directory link |

## The injection contract

Binding on every file. Enforced by `npm run contract`, which fails the build.

| Banned | Instead |
|---|---|
| `$env/static/*`, `$env/dynamic/*` | the caller passes a config object |
| `$lib/*`, `$app/*` | relative imports within the package |
| `import.meta.env` | a config object |
| `node:*` and bare Node builtins | Web APIs: `fetch`, `crypto.subtle`, `TextEncoder` |
| module-level `new SomeClient(...)` or any factory call at import scope | `createX(config)`, called per request |

## Consuming it

The canonical source is this repository. Consumers pin a tag, so a change here
reaches an application only when that application asks for it.

```jsonc
// package.json
{
	"dependencies": {
		"@ishan/ecosystem-core": "https://github.com/ishan-parihar/ecosystem-core/archive/refs/tags/v0.2.1.tar.gz"
	}
}
```

Use the **tag archive URL**, not the `github:owner/repo#tag` shorthand. Two
reasons, both found by trying it:

1. npm rewrites every GitHub git specifier to `git+ssh`, even when you write
   `git+https` explicitly. That resolves on a developer machine with an SSH key
   and fails on a CI runner without one, which is the worst way for a
   dependency to be wrong.
2. The archive URL is plain HTTPS over a public repository. No credentials, no
   SSH key, no git installed at all.

Avoid `github:ishan-parihar/ecosystem-core#v0.2.0` in particular: that release
cannot be installed. See the changelog.

A `github:` dependency resolves on Cloudflare Pages with **no extra CI
configuration**, because `dist/` is committed. A consumer installs JavaScript
and type declarations directly and needs neither TypeScript nor a build step,
and **no install script has to run** at all.

That last part is deliberate. npm currently runs dependency install scripts by
default but prints an `allow-scripts` review notice, and the npm documentation
states plainly that "a future release will block unreviewed install scripts". A
package that depends on `prepare` running at a consumer's install time would
break on that release, on every consumer at once. Committing the build removes
the dependency on that behaviour entirely.

The cost is drift, and it is paid for in CI: `npm run build` must leave `dist/`
unchanged, or the build fails with `dist/ is stale`. Contributors run
`npm run build` and commit `dist/` alongside `src/`.

During local development against an unpublished change, point at a checkout
instead - but **never commit a `file:` reference**, because Cloudflare Pages
builds from the repository root and a sibling directory will not exist there:

```jsonc
{ "dependencies": { "@ishan/ecosystem-core": "file:../ecosystem-core" } }
```

| Subpath | Use |
|---|---|
| `@ishan/ecosystem-core` | everything |
| `@ishan/ecosystem-core/email` | providers and rendering only |
| `@ishan/ecosystem-core/subscribers` | store, tokens, Supabase adapter |
| `@ishan/ecosystem-core/data` | PostgREST client |
| `@ishan/ecosystem-core/http` | rate limiting and Turnstile |

## Usage

```ts
import { createEmailService, createPostgrest, createSupabaseSubscriberTable, InMemoryRateLimiter } from '@ishan/ecosystem-core';

// Per request. The Cloudflare binding lives on platform.env.
function emailFor(platform: App.Platform | undefined) {
  return createEmailService({
    provider: 'cloudflare',
    from: 'no-reply@tx.example.com',
    fromName: 'Example',
    replyTo: 'hello@example.com',
    theme,
    binding: platform?.env?.EMAIL,
  });
}

const db = createPostgrest({ url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY });
const table = createSupabaseSubscriberTable(db);
```

The theme is data, not a fork: one renderer serves every surface, and each
surface supplies its own colours. That is how brand sovereignty stays real
without duplicating code.

## Scripts

```bash
npm run contract    # enforce the injection contract
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist
npm run test        # vitest
npm run verify      # all four, in order
```

## Verifying a release reaches consumers

`consumer-smoke/` is a throwaway project that knows nothing about this
repository. It is the only check here that tests the artifact rather than the
source: it installs the package from a published tag and typechecks every
subpath against it under `strict`.

```bash
cd consumer-smoke
npm install --no-audit --no-fund \
  https://github.com/ishan-parihar/ecosystem-core/archive/refs/tags/v0.2.1.tar.gz
../node_modules/.bin/tsc -p tsconfig.json
```

CI runs exactly this on every tag. To confirm the check is not vacuous, hide the
installed package and re-run: it must fail with `TS2307: Cannot find module`.
It does.

### One trap worth knowing about

Run consumer experiments in a directory whose name is a **valid package name**.
`npm init -y` fails with `Invalid name: ".consumer-test"` when the directory
starts with a dot, and npm then resolves `npm install` against the nearest
`package.json` *upward* - which silently adds the dependency to this package
instead. That is not hypothetical; it is exactly how the unusable `v0.2.0`
release was created. `npm run contract` now fails on the resulting manifest, so
the mistake is caught before it can be committed again.

## Versioning

Semantic versioning, with one house rule: **the injection contract is part of
the public API.** A release that requires a consumer to read an environment
variable, or to construct a service at import scope, is a breaking change even
if no signature moved.

| Bump | When |
|---|---|
| patch | bug fix, no signature change |
| minor | new module, new optional field, new provider |
| major | a factory signature changes, a default changes, or a consumer must change how it calls in |

Each release gets a `CHANGELOG.md` entry and a git tag `vX.Y.Z`.

## What must never be added here

- Session or auth cookies, analytics identifiers, or user-visible chrome
- Database ownership, RLS policies, or migrations. The package consumes a
  client and never owns a schema
- Anything from The Undercurrent, or anything coupling a different owner's
  practice to this ecosystem

## Tests

147 unit tests across the six modules, all offline. The email provider suite
drives a stub Cloudflare binding; the data suite drives a recording `fetch`, so
every query shape is asserted against the actual request that would be sent;
and the widget suite drives a minimal DOM stub, so the two-forms-one-page race
is asserted rather than assumed.
