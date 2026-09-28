# Changelog

All notable changes to `@ishan/ecosystem-core`. The injection contract is part
of the public API, so a release that forces a consumer to read its own
environment variables, or to construct a service at import scope, is recorded
as breaking.

## 0.5.0

**Breaking: two modules removed.** `./campaign` and `./security` are gone, along
with their subpath exports.

Removed rather than deprecated, because neither had a single consumer. Verified
by exported symbol *and* by subpath import across every surface in the ecosystem
- including the two that import the package root, which a subpath-only check
would miss. A package described as shared while carrying modules nothing imports
is not shared code; it is maintenance with no reader, and it makes the package
look more load-bearing than it is.

Breaking only on paper: nothing imports either path, so no consumer has to
change. A surface pinned to 0.4.0 keeps working, and 0.5.0 changes no existing
export's shape or default.

### Removed

- **`./campaign`** - `sendCampaign`, `createSupabaseRecipientSource`,
  `buildTagsFilter` and the recipient/batch types. The signed RFC 8058
  unsubscribe links it minted are *not* lost: they are built from `./tokens`,
  which remains. The capability was simply never adopted - campaign sending in
  the ecosystem builds its unsubscribe URLs inline, in three places.
- **`./security`** - the brute-force lockout.

  **The premise this rests on, stated so it is a decision and not an
  oversight:** the OTP-only control is request rate limiting (`./http`),
  and `@ishan/ecosystem-auth` - the identity sidecar that supplies the
  `SessionPorts` this core consumes - leaves `emailAndPassword` **off
  unless a surface explicitly enables it** (`emailAndPassword` is opt-in;
  the adapter sets it only when a surface asks). So while every current
  surface is OTP-only, `./http` is the correct control and lockout is
  dead weight.

  **Consequence for consumers:** a surface that turns on
  `emailAndPassword` **must** re-add an account lockout before it has
  password auth in production. That control was removed here *because* the
  default is OTP, not because password auth is impossible - a future
  `@ishan/ecosystem-auth` that defaults to password would invalidate this
  premise, and lockout is one `git checkout` away in the history.

Both remain in git history if either is wanted back.

## 0.4.0

Two new modules, `payments/` and `auth/`, which close the last two gaps between
this package and "everything the ecosystem had written twice".

Minor: additive only. No existing export changed shape or default, and no
consumer has to change how it calls in.

### Added

- **`./payments`** - `createRazorpayClient(config)` over the orders,
  subscriptions, plans and payments endpoints, plus
  `verifyPaymentSignature` and `verifyWebhookSignature`. Ported from the hub's
  Workers-hardened client, which exists because the official SDK calls
  `createRequire` and cannot load in a Worker. Three deliberate changes:
  credentials are injected per call instead of read from `$env`; the HMAC is
  `crypto.subtle` rather than `node:crypto` with a `Buffer` fallback, so the
  same code runs in a Worker and in Node; and API failures throw
  `RazorpayApiError` carrying `status`, `code` and `description` instead of a
  formatted string. The checkout signature comparison is now
  `timingSafeEqual`, since it is attacker-controlled input. Both verifiers
  return a boolean and never throw, and `verifyWebhookSignature` returns
  `false` and logs at `error` when no secret is configured - an unverified
  webhook must never read as verified.
- **`./auth`** - `resolveRole`, `isAdmin`, `hasPremiumAccess`,
  `hasPermission` as pure functions, and `createSessionService` for the
  orchestration, answering `requireUser` / `requireAdmin` / `requirePremium` /
  `requirePermission`. Data access arrives as ports (`loadUser`,
  `loadProfile`, optional `enrichProfile`), so the module carries no Supabase
  or SvelteKit dependency. `getSession` never throws: a port failure is an
  unauthenticated request. The hub's slim-profile-then-enrich behaviour is
  preserved behind `isProfileComplete`, and a failed enrichment degrades to
  the slim profile rather than failing the request.
- `payments` and `auth` subpath exports, and both re-exported from the root.

### Not added, deliberately

- **Supabase Auth itself.** The hub's identity engine is a managed service and
  its middleware is `RequestEvent` handling. Only the portable role/tier half
  moved. No cookies, no session store, no schema, no RLS.
- **Contact submission handling.** It stays put until the technical authority
  surface has built its own endpoint, so the shape being extracted is the one
  two surfaces actually need rather than one surface's guess.

## 0.3.0

Five new modules, and one behavioural fix that matters for consent.

Minor rather than major: every existing export keeps its signature. The one
additive change is that `RateLimitResult` now also reports `limit`, and it is
declared once instead of twice.

### Added

- **`./tokens`** - the signed-link primitive, lifted out of `subscribers` and
generalised, plus `verifyTokenCompat`. The ecosystem had grown **three**
implementations of this and they are **not** interchangeable even with a shared
secret: this package signs the raw payload bytes, while the hub's
`auth/tokens.ts` and `emailToken.ts` sign `base64url(payload)`. Verified rather
than inferred - given an identical secret, each rejects the other's output with
`bad_signature`. `verifyTokenCompat` accepts the canonical scheme, then the
legacy one, and normalises the hub's short field aliases (`p`, `e`, `x`), so
migration is: mint canonical, verify both, then drop `acceptLegacy`. It reports
which scheme matched, so the legacy count can be watched to zero.
- **`./cache`** - `MemoryCache` and `KvCache` behind one `CacheStore`, resolved
by `resolveCache`. The hub's version was a module-level singleton keyed on the
KV binding, which is a contract violation: a binding lives on
`event.platform.env` and is per request. `resolveCache` reports both the backend
it chose and why it degraded.
- **`./campaign`** - recipient selection by `source` and `tags`, batched sending,
and a **per-recipient signed unsubscribe link** with the RFC 8058 headers. This
closes a live defect: the CMS built an unsigned `?email=<address>` link, so
anyone who knew an address could unsubscribe it, and it sent no
`List-Unsubscribe` headers at all. That bug had been written twice, in the hub
and in the CMS, which is the argument for it existing once. Only `active` rows
are selected, and `source` is not optional.
- **`./security`** - brute-force lockout behind an injected `LockoutStore`. The
hub's version is hard-wired to one table and typed `any` throughout. Behaviour
is preserved, including the deliberate refusal to extend an active lock on
further attempts: extending would let an attacker hold a legitimate user out
indefinitely.
- **`./monitoring`** - `summarizeDelivery`, a pure aggregator over injected
samples. The hub's monitor is a module singleton that calls `setInterval` and
registers `process.on('SIGTERM')`; none of that is valid in a Worker isolate.
`summarizeByLane` keeps transactional and campaign delivery separate, because
averaged together a transactional outage hides inside healthy campaign volume.
- `FixedWindowRateLimiter` with `createRateLimiter`, over any `CacheStore`,
plus `RATE_LIMIT_POLICIES` and `resolvePolicy` so surfaces stop inventing their
own numbers. Asynchronous, because a KV read is; the existing synchronous
`InMemoryRateLimiter` is unchanged and still exported.
- `consumer-smoke/` - a throwaway consumer project that installs the package
  from a published tag and strict-typechecks every subpath. It is the only
  check that tests the artifact rather than the source. Verified not to be
  vacuous: hiding the installed package makes it fail with `TS2307`.
- A `published-artifact` CI job, run on tag pushes only, that installs the tag
  over plain HTTPS with no credentials and typechecks it. A release can no
  longer be published broken without a red run.

### Fixed

- **`exp: 0` no longer reads as expired.** Both the hub's signers and the
  hub's own documentation use `exp: 0` to mean *never expires*, and unsubscribe
  links rely on it, because a campaign email from two years ago must still be
  able to honour the opt-out. Treating any numeric `exp` as an absolute time
  made `nowSec >= 0` always true, so every such link read as expired. Caught by
  the token test that reproduces the hub's algorithm with `node:crypto`.
- A consumer wanting durability had no way to get it: the only limiter was
  per-isolate. `FixedWindowRateLimiter` over `KvCache` shares one counter across
  every isolate, which is the case a Worker surface actually has.

### Changed

- Consumption documentation now specifies the **tag archive URL** rather than
  the `github:owner/repo#tag` shorthand. npm rewrites every GitHub git
  specifier to `git+ssh`, even an explicit `git+https`, which resolves on a
  machine with an SSH key and fails in CI without one.
- `RateLimitResult` is declared once, in `rate-limiter.ts`, and both limiters
  return it. It gains a `limit` field so a caller can build a correct
  `Retry-After` without re-deriving the policy. Additive only.
- Documentation now covers the **Node consumer** as well as the Cloudflare one.
  A `node:` import is banned, so the same code runs in a Workers isolate and in
  a plain process; `ishanparihar-cms` is a Node CLI and MCP server and needs the
token and rendering half rather than the subscriber store. That recipe is also
the body of `buildCampaignEmail` in the harness, so it is typechecked on every
run instead of drifting.

## 0.2.1

### Fixed

- **`v0.2.0` cannot be installed. Use `v0.2.1` or later.** `package.json` in
  v0.2.0 carried a `dependencies` block pointing at
  `file:.consumer-test/ishan-ecosystem-core-0.2.0.tgz`, a local test tarball,
  and `package-lock.json` recorded the matching self-reference. npm clones a
  git dependency and honours its committed lock, so every consumer install
  failed with an `ENOENT` for a path that existed only on the machine that
  created it. The tag is left in place rather than rewritten; it is marked here
  so it is not picked up by mistake.
- Root cause and prevention: the package declares **no runtime dependencies by
  design**, which is now enforced. `npm run contract` fails when `package.json`
  gains a `dependencies`, `peerDependencies` or `optionalDependencies` entry,
  when any `file:` specifier appears in the manifest, when the lockfile records
  a self-reference, or when `dist` is added back to `.gitignore`. The guard was
  verified to fire on the exact defect above, not merely to pass when clean.

## 0.2.0

Promoted from a pilot that one surface consumed to the ecosystem's shared
infrastructure, and lifted out of the consuming repository into its own.

### Added

- `data/postgrest` - a minimal PostgREST client with an injected logger:
  `select`, `selectOne`, `count`, `insert`, `insertMany`, `update`, `remove`
  and `rpc`. Returns `null` from `createPostgrest` when the project is not
  configured, rather than throwing.
- `data/postgrest` - `filterValue` and `likePattern`, so a user-supplied search
  term cannot change the shape of a PostgREST filter expression.
- `subscribers/supabase-table` - `SupabaseSubscriberTable` and
  `createSupabaseSubscriberTable`. This is the mapping every surface was going
  to write for itself: the shared column list, the status narrowing, and the
  `undefined`-elision rule that keeps "leave the column alone" distinct from
  "clear the column".
- `http/rate-limit` - `InMemoryRateLimiter`, a fixed-window counter with bounded
  memory. A class rather than a module-level map, so a surface can swap the
  backing store without changing the call site.
- `http/rate-limit` - `hashIp`, `clientIp`, and `verifyTurnstile`.
- `internal/hash` - `sha256Hex` and `timingSafeEqual`.
- `internal/logger` - one `Logger` type shared by every module, so a consumer
  passes a single logger and it type-checks across email, data and HTTP.
- `npm run contract` - an enforced check for the injection contract, with a
  negative test proving it fires. Comments are stripped before scanning, so a
  doc comment may discuss the banned modules.
- Subpath exports: `/email`, `/subscribers`, `/data`, `/http`.
- `http/turnstile-widget` - the lazy script loader and `mountTurnstile`, moved
  out of the consuming application because every surface with a form needs the
  same dedupe. It reads the browser global structurally instead of augmenting
  `Window`, so it imposes no ambient declaration on consumers.
- `dist/` is committed, so a consumer installs this package without running any
  install script. CI fails the build when `dist/` drifts from `src/`.

### Changed

- **Breaking.** The package no longer lives inside a consuming repository. It
  is consumed as `github:ishan-parihar/ecosystem-core#vX.Y.Z`; a `file:`
  reference is for local development only and must never be committed, because
  Cloudflare Pages builds from the repository root.
- **Breaking.** `EmailLogger` is now an alias for the package-wide `Logger`.
  The shape is unchanged, so this is source-compatible in practice.
- `silentLogger` is now the single default for every module, not just email.

### Corrected, from the Cloudflare documentation

Verified 2026-09-23, replacing figures that were previously second-hand:

- Cloudflare Email **Sending** requires the **Workers Paid** plan. It is not
  available on the Free plan.
- Included quota is **3,000 outbound emails per month**, then **$0.35 per
  1,000**. The transport is usage-priced, not unlimited.
- Hard-bounced and accepted emails **count** toward the quota; sends blocked by
  the suppression list **do not**.
- Cloudflare provides a **native suppression list** API (one active entry per
  address). A surface should push hard bounces there rather than treating
  suppression as solely its own responsibility.
- Sends to verified destination addresses are free on every plan.

## 0.1.0

The pilot. Extracted from `ishanparihar-svelte` so the technical authority
surface would not duplicate a newsletter system that already existed.

- `email/` - the provider contract, the renderer with a theme argument, and
  four providers: `cloudflare`, `resend`, `gmail`, `mock`.
- `subscribers/` - the double opt-in state machine, HMAC-signed confirm and
  unsubscribe tokens, and the `SubscriberTable` storage contract.
- 64 unit tests.
