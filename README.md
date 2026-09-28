# @ishan/ecosystem-core

Shared infrastructure for the Ishan Parihar ecosystem surfaces. One source of
truth for the utilities that would otherwise be rewritten in every repository:
email transport, the subscriber store with its signed tokens, a PostgREST
client, the Supabase subscriber adapter, the abuse-handling primitives, a
Razorpay client with its signature verifications, and role/tier resolution.

```text
src/
  email/          providers (cloudflare, resend, gmail, mock), renderer, service
  subscribers/    state machine, Supabase adapter, store contract
  tokens/         signed links: confirm, unsubscribe, reset, guest access
  campaign/       recipient selection by source and tag, batched send
  cache/          KV and in-isolate stores behind one interface
  http/           rate limiters, Turnstile, IP hashing
  security/       brute-force lockout
  monitoring/     delivery metrics, as a pure function
  data/           PostgREST client
  payments/       Razorpay orders, subscriptions, plans, checkout + webhook HMAC
  auth/           role and tier resolution, session orchestration over ports
  internal/       base64, hashing, logger
```

Each module exists because the same code had already been written more than
once, in more than one repository. Two are worth calling out:

- **`tokens/`** replaces **three** incompatible implementations. They are not
  interchangeable even with a shared secret: this package signs the raw payload
  bytes while the hub signs `base64url(payload)`, so each rejects the other with
  `bad_signature`. `verifyTokenCompat` accepts both during migration and reports
  which scheme matched.
- **`campaign/`** exists because an unsigned `?email=<address>` unsubscribe link
  was written **twice**. Every campaign message now carries its own signed
  token plus the RFC 8058 headers.

## Payments and auth: what moved, and what deliberately did not

Both of these were challenged as missing, so the boundary is worth stating
precisely rather than by omission.

**`payments/` is a real extraction.** The hub's `payments/razorpay.ts` is 345
lines of Workers-hardened fetch client written because the official Razorpay SDK
calls `createRequire` and cannot load in a Cloudflare Worker. Non-trivial,
portable, and the second surface that takes money should not write it again. The
port changes three things:

| Hub original | Here |
|---|---|
| reads `$env/dynamic/private` per call | credentials injected per `createRazorpayClient(config)` |
| `node:crypto` `createHmac`, with a `Buffer` fallback | `crypto.subtle`, identical in a Worker and in Node |
| `new Error(string)` on API failure | `RazorpayApiError` with `status`, `code`, `description` |
| `===` on the checkout signature | `timingSafeEqual` - it is attacker-controlled input |

Both verifications return a boolean and never throw. A bad signature is a
business answer, not an exception, and a missing webhook secret returns `false`
and logs at `error` - never `true`, because an unverified webhook is a forged
payment notification.

**`auth/` is the portable *half* of session handling, and that is not a
shortfall.** The hub's identity engine is **Supabase Auth**, a managed service -
the session validation is `supabase.auth.getUser()` plus a profile read, and the
rest of `session-validation.ts` is `RequestEvent` handling and `redirect()`.
Pulling it in wholesale would import SvelteKit types into a framework-agnostic
package, which is the one contract this package will not break. What *is*
portable, and *was* written more than once, is the question "given this profile
row, what is this person allowed to do?" - so that is what is here:

- `resolveRole`, `isAdmin`, `hasPremiumAccess`, `hasPermission` - pure, no I/O
- `createSessionService({ loadUser, loadProfile, enrichProfile? })` - the
  orchestration, with data access passed in, answering `requireUser`,
  `requireAdmin`, `requirePremium`, `requirePermission`

`createSessionService` never throws: a port failure is an unauthenticated
request, not an exception for a route handler to catch. And `loadUser` is
intended to reuse the work the request already did - the hub validates the
session once in `hooks.server.ts` with a cookie-aware client, and a port that
re-validates per call doubles auth latency for no security gain.

No cookies, no session store, no RLS, no schema. Those stay with the surface and
with Supabase.

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
| `@ishan/ecosystem-core/subscribers` | store and Supabase adapter |
| `@ishan/ecosystem-core/tokens` | signed links and the legacy verifier |
| `@ishan/ecosystem-core/cache` | KV or in-memory store, and `getOrSet` |
| `@ishan/ecosystem-core/http` | rate limiting, policies, Turnstile |
| `@ishan/ecosystem-core/monitoring` | delivery metrics |
| `@ishan/ecosystem-core/data` | PostgREST client |
| `@ishan/ecosystem-core/payments` | Razorpay client and signature verification |
| `@ishan/ecosystem-core/auth` | role/tier resolution and session guards |

Subpath exports are the configuration mechanism: a surface imports the modules
it enables and nothing else, so a surface with no newsletter never pulls in the
subscriber store. Where behaviour needs to vary, it is an argument rather than a
branch inside the package: `resolveCache({ backend })`,
`resolvePolicy(name, overrides)`, `verifyToken(token, { acceptLegacy })`.

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

## Consumers that are not Cloudflare Pages

Nothing here imports a framework module, and `node:` builtins are banned, so
the same package runs in a Workers isolate and in a plain Node process. That is
the point: two different kinds of consumer share one implementation.

- **A SvelteKit surface on Cloudflare Pages** reads its configuration from
  `platform.env` per request and uses the whole stack - providers, renderer,
  store, Supabase adapter.
- **A Node process** (`ishanparihar-cms` is a CLI and an MCP server) reads
  `process.env` once at startup and usually wants only part of it.

The second case is typically the token and rendering half. A campaign sender
does **not** want the subscriber store; it needs to mint an unsubscribe link
that the receiving surface can verify, and to render the body in the same shell
so the letterhead matches:

```ts
import {
  mintToken, createEmailService, wrapCampaignContent, listUnsubscribeHeaders, silentLogger,
} from '@ishan/ecosystem-core';

const secret = process.env.NEWSLETTER_TOKEN_SECRET ?? '';
if (!secret) throw new Error('NEWSLETTER_TOKEN_SECRET is required to mint unsubscribe links');

// expiresInSec: 0 means the link never expires. That is the contract for
// unsubscribe, and the opposite of the confirm token.
const unsubscribeUrl = `https://<surface>/newsletter/unsubscribe?token=${encodeURIComponent(
  await mintToken({ purpose: 'newsletter_unsubscribe', email: address }, { secret, expiresInSec: 0 }),
)}`;

const html = wrapCampaignContent(bodyHtml, { theme, unsubscribeUrl });
const service = createEmailService({
  provider: 'resend', from, fromName, replyTo, theme,
  resendApiKey: process.env.RESEND_API_KEY, logger: silentLogger,
});
await service.send({
  to: address,
  subject,
  html,
  headers: listUnsubscribeHeaders(unsubscribeUrl),
});
```

Two rules make the split across processes safe:

- `purpose` is inside the signed payload, so a confirm token cannot be
  presented as an unsubscribe token, or the reverse.
- `NEWSLETTER_TOKEN_SECRET` must be **identical** in the process that mints a
  link and the surface that verifies it. A per-surface value silently breaks
  every campaign unsubscribe while leaving the link looking valid.

Verified on Node 24, outside Workers: token mint and verify, cross-purpose and
tamper rejection, shell rendering, RFC 8058 headers, the mock provider, the rate
limiter, and the contact template. A consumer that only typechecks is not proven.

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

- Session or auth cookies, analytics identifiers, or user-visible chrome. Role
  and tier *resolution* lives in `auth/`; the session store and the cookie
  plumbing stay in the surface, because they are per-framework
- Database ownership, RLS policies, or migrations. The package consumes a
  client and never owns a schema
- Anything from The Undercurrent, or anything coupling a different owner's
  practice to this ecosystem

## Tests

276 unit tests across every module, all offline. The email provider suite drives
a stub Cloudflare binding; the data and payments suites drive a recording
`fetch`, so every query and request shape is asserted against what would
actually be sent; the widget suite drives a minimal DOM stub, so the
two-forms-one-page race is asserted rather than assumed; and the payments and
tokens suites recompute their HMACs with `node:crypto`, so the WebCrypto
implementations are checked against the reference algorithm rather than against
themselves.
