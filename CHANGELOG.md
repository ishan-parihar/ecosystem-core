# Changelog

All notable changes to `@ishan/ecosystem-core`. The injection contract is part
of the public API, so a release that forces a consumer to read its own
environment variables, or to construct a service at import scope, is recorded
as breaking.

## 0.2.0

Promoted from a pilot that one surface consumed to the ecosystem's shared
infrastructure, and lifted out of the consuming repository into its own.

### Added

- `data/postgrest` — a minimal PostgREST client with an injected logger:
  `select`, `selectOne`, `count`, `insert`, `insertMany`, `update`, `remove`
  and `rpc`. Returns `null` from `createPostgrest` when the project is not
  configured, rather than throwing.
- `data/postgrest` — `filterValue` and `likePattern`, so a user-supplied search
  term cannot change the shape of a PostgREST filter expression.
- `subscribers/supabase-table` — `SupabaseSubscriberTable` and
  `createSupabaseSubscriberTable`. This is the mapping every surface was going
  to write for itself: the shared column list, the status narrowing, and the
  `undefined`-elision rule that keeps "leave the column alone" distinct from
  "clear the column".
- `http/rate-limit` — `InMemoryRateLimiter`, a fixed-window counter with bounded
  memory. A class rather than a module-level map, so a surface can swap the
  backing store without changing the call site.
- `http/rate-limit` — `hashIp`, `clientIp`, and `verifyTurnstile`.
- `internal/hash` — `sha256Hex` and `timingSafeEqual`.
- `internal/logger` — one `Logger` type shared by every module, so a consumer
  passes a single logger and it type-checks across email, data and HTTP.
- `npm run contract` — an enforced check for the injection contract, with a
  negative test proving it fires. Comments are stripped before scanning, so a
  doc comment may discuss the banned modules.
- Subpath exports: `/email`, `/subscribers`, `/data`, `/http`.
- `http/turnstile-widget` — the lazy script loader and `mountTurnstile`, moved
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

- `email/` — the provider contract, the renderer with a theme argument, and
  four providers: `cloudflare`, `resend`, `gmail`, `mock`.
- `subscribers/` — the double opt-in state machine, HMAC-signed confirm and
  unsubscribe tokens, and the `SubscriberTable` storage contract.
- 64 unit tests.
