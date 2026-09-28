# Ecosystem Packages: Next Phases

> Canonical plan for `@ishan/ecosystem-core` and `@ishan/ecosystem-auth`. Written
> 2026-09-28. Ownership: the packages themselves. The per-surface integration
> decisions (identity, entitlement) are owned by each consuming surface and are
> NOT decided here.
>
> Each package's own `AGENTS.md` is the runbook for working *in* that package.
> This file is the roadmap for both and for what they unlock downstream.

## 0. Where things actually stand (measured 2026-09-28)

Both packages are public on GitHub and installable from a clean checkout. This
was proven end to end, not assumed: a fresh directory with only
`package.json` installed both by GitHub spec and then imported them. That proof
now runs in CI for **both** install paths - a packed tarball and a git spec -
because npm only runs lifecycle scripts for the git path, so the tarball proof
alone could never catch a `prepare` that broke every GitHub install.

| | `@ishan/ecosystem-core` | `@ishan/ecosystem-auth` |
|---|---|---|
| Repository | `github.com/ishan-parihar/ecosystem-core` (public) | `github.com/ishan-parihar/ecosystem-auth` (public) |
| Version | `0.5.0`, tagged and pushed | `0.1.0`, tagged and pushed |
| Tests | 242/242 | 28/28 |
| Typecheck | OK | OK |
| `dist` gate | PASS | PASS |
| Ghost detector | PASS | PASS |
| Semver gate | PASS (6/6 fault matrix) | PASS (6/6 fault matrix) |
| Consumer matrix | PASS (2 surfaces, 22 symbols) | n/a — core's own consumers |
| Runtime deps | none | `better-auth` |
| Peer on core | n/a | `>=0.4.0`, required, not optional |

Install specs that are proven to work today:

```jsonc
// a surface depends on core directly
"@ishan/ecosystem-core": "github:ishan-parihar/ecosystem-core#v0.5.0"

// a surface uses the auth adapter. core is a REQUIRED peer: npm does not
// install it, so a surface can never end up with two physical copies.
"@ishan/ecosystem-auth": "github:ishan-parihar/ecosystem-auth#v0.1.0",
"@ishan/ecosystem-core": "github:ishan-parihar/ecosystem-core#v0.5.0"
```

Both are public and require no credentials, which is the point: a surface can
install them in CI with no npm login, no publish step, and no secret in a repo.
Pin the tags. `#main` resolves, but it is a moving ref, and a surface that pins
it breaks whenever the package is edited - which is the failure mode section 2's
first item exists to make visible.

**Peer floor: `>=0.4.0`, and it is evidence, not caution.** It was briefly
raised to `>=0.5.0` on the reasoning that a higher floor was "safer". That was
unjustified and it cost something: both real consumers pin the v0.4.0 tarball, so
the bump would have forced them to cut a release for no reason. The floor is
`>=0.4.0` because core's 0.5.0 changelog states a 0.4.0-pinned surface keeps
working, `src/auth` shipped in 0.4.0, and the auth package's whole import set
(`Logger` from the root; `createSessionService`, `ProfileLike`, `SessionPorts`,
`SessionService`, `SessionUser` from `./auth`) is present there. The suite was
re-run against a real core **0.4.0** install - not 0.5.0 - and passes 28/28.

## 1. Why there is no npm release yet, and when to make one

`npm publish` is the right answer for a package other people consume. It is not
required to make these a dependency of this infrastructure, and it is not free:
the name on the registry is taken permanently, and every publish after the first
is a supply-chain event.

Not publishing is safe today because the GitHub spec is a real install. Two
things make it inferior at scale, and both are about the consumer, not us:

1. **No integrity lock across consumers.** A GitHub spec is a git ref. `#v0.5.0`
   is immutable in practice, but the resolution is a network clone per install
   and a consumer's `package-lock.json` records a commit, not a registry
   tarball hash. For a *shared infrastructure* package this is the difference
   between "every surface provably runs the same bytes" and "every surface runs
   whatever the ref pointed to when it installed".
2. **No deprecation, no `dist-tag`, no staged rollout.** A bad release can only be
   fixed by pushing a new tag, and there is no way to mark one bad.

Publish when either is true:

- a surface outside this infrastructure needs to install it, or
- more than one surface pins it and a version skew would be expensive to unwind.

If we publish, the requirements are: drop `"private": true`, set `license` to
something other than `UNLICENSED` (or keep it and say in the README that the
tag archive is the only consumption path and the code is all-rights-reserved -
but not both claims at once, because today the manifest says UNLICENSED while
the repository is public and the README documents a tag-archive install), add
`publishConfig.access: "public"`, and pass `--access public` explicitly, since a
scoped package otherwise defaults to restricted and 404s for every consumer. The
machine also has no npm credentials (`npm whoami` is `ENEEDAUTH`), so this is an
operator step. The `@ishan/ecosystem-core` and `@ishan/ecosystem-auth` names are
currently unclaimed on the registry (404), so the names are free.

**Do not publish as a prerequisite for quant-signals.** The GitHub spec is a
sufficient dependency mechanism today, and publishing is a separate,
operator-owned, irreversible decision.

## 2. Phase A: release hardening — all four items DONE

Every item below is enforced in CI in both packages, and every check was
fault-injected before being wired in. A check that cannot fail is not evidence.

### A1. Semver discipline — DONE

`0.5.0` removed two published subpaths (`./campaign`, `./security`). Nothing
objected, because a removal is a legal edit to `package.json`: the tag went out,
and a consumer importing either discovered it at their own upgrade.

`scripts/check-semver.mjs` fails a release that removes a published subpath,
changes a subpath target, or removes a root value export without the bump that
declares it. While the major is `0`, the minor is the breaking boundary npm
enforces, so a removal requires a minor bump.

Three ways it was vacuous first, each found by injecting faults rather than by
reading the code — all three would have shipped as permanent green checks:

1. Comparing against "the most recent tag" is a tag against itself whenever HEAD
   is tagged, so it reported "no breaking change" for a commit that had removed a
   subpath. The base is now `HEAD^`.
2. The root export list cannot be read from `dist/index.d.ts`, which is only
   `export * from './<sub>/index.js'` lines and declares no names, so a regex over
   it matches nothing and reports "no change" for any removal. The built
   `dist/index.js` is the only artifact stating the real runtime surface.
3. `git describe HEAD^` fails when the parent predates every tag, and the catch
   turned that into a silent "no prior release" pass — which is the state
   ecosystem-auth was in when its gate was first wired into CI.

An unresolvable base now fails loudly rather than reporting "no breaking change"
for a comparison that never ran. It also failed in CI for a fourth reason that
no local test could have caught: `actions/checkout` defaults to `fetch-depth: 1`,
so there is no `HEAD^` on a runner. Fixed with `fetch-depth: 0`. **A local green
is evidence about the local machine, not about CI.**

Fault matrix, verified in both packages on a clean committed tree: clean tree
passes, a removed subpath fails, a renamed root export fails, a removal paired
with the bump that declares it passes, an additive subpath passes, restore
returns to green.

The gate also earned its keep during development: it flagged `./email` missing
from the working tree's exports map, a real corruption introduced by a
fault-injection harness that a passing run had hidden.

### A2. The dist invariant — DONE, including the hazard

`dist/` is committed and shipped in `files`, so a stale `dist/` reaches every
consumer as a runtime bug rather than a build error. Both packages enforce it
after a real build, as a content check, never a filename comparison. In a
working repo the check must be index-relative (`npm run check:dist`), or a
correct uncommitted rebuild reads as a phantom failure; CI runs on a clean
checkout, so the short form is right there.

The hazard the content gate cannot see is now closed by its own check.
`tsc` does not clean `dist/`, so removing a module leaves its compiled output
committed and shipped — and the content gate cannot catch it, because a ghost is
present in *both* the committed tree and a fresh build. `scripts/check-dist-ghosts.mjs`
fails on a ghost, and on the inverse (a `src` module with no output, which is a
real bug: the consumer gets a resolution error instead of the feature). A missing
`dist/` is an error, not a clean pass.

`workflow_dispatch` was added so the gates can be run on demand. It is
deliberately its own trigger rather than a `paths:` filter on `push`: a paths
filter there would also stop the gates running for a push that touches only a
workflow file, which is exactly the push that changes a gate.

### A3. Consumer matrix — DONE

The two existing consumers are on the v0.4.0 tarball, and nothing was proving
the current core still works for them. `scripts/check-consumer-matrix.mjs` asserts
every symbol a real surface actually calls: 22 runtime symbols across 10
subpaths, extracted **from the two surfaces** rather than from a list written in
the package. A failure names the affected consumer.

| Surface | Imports |
|---|---|
| `ishanparihar-svelte` | `./auth ./cache ./email ./http ./monitoring ./payments ./tokens` |
| `technical-authority-website` | root, plus `./data ./http ./subscribers` |

The subpath-level consumer proof was not enough: it says a module resolves, not
that the function a consumer calls is still there, which is precisely how 0.5.0
removed two subpaths with CI green.

This check was also vacuous on first run: it parsed `export { a, b }` and
`export * from`, but a compiled module declares its own symbols as
`export async function f`, so every directly-declaring subpath — which is most of
them — resolved to zero names. And a zero-name parse is indistinguishable from
"nothing was removed", so an empty set is now an error naming `npm run build`.

### A4. Release runbook — DONE

`RELEASING.md` in both packages: the gate order, the version table for `0.x`, the
commit-then-tag sequence, and what to do when CI is red on a tag (a new patch
release, never move a published tag). Its own checklist was executed before being
written down, and it failed the first time because the runbook was untracked —
which is the point of the clean-tree assertion at the end of it. It now returns
GREEN in both packages.

## 3. Phase B: the identity decision (blocking quant-signals, not the packages)

The packages are ready. What is not decided is whether a surface should use
them, and that is a per-surface decision with a real cost either way. This
section states the fork; it does not take it.

The fork, for quant-signals specifically:

- **Do not** add core to quant-signals until its identity model is decided.
  quant-signals has no web account. Its entitlement is a tranche ladder
  arbitrated by `qs_claim_seat` in Postgres, and a member is a Telegram id.
  Core's session layer is per-profile with a `DEFAULT_PREMIUM_TIERS` that is
  another surface's vocabulary. A member with no seat must not read as
  entitled, so entitlement has to be mapped explicitly from seat and serial
  status to a profile, and the package default must never be inherited.
- The auth adapter is a **Better Auth** adapter. Adopting it means adopting
  Better Auth's data model, which is a different member identity from Telegram.
  This is a real migration with a real cost, not an import.

The `scripts/track-ecosystem-core.mjs` in quant-signals already refuses to
claim success when the dependency is absent, precisely so that this decision
cannot be made by accident.

## 4. Phase C: what the packages still do not cover

Named so they are not mistaken for done:

- **No token rotation story.** `mintToken`/`verifyToken` exist; rotating the
  signing secret invalidates every outstanding token at once, with no overlap
  window and no dual-key verification. Any surface with long-lived sessions needs
  this before it holds a real user.
- **No rate-limit persistence.** The `http` rate limiter is in-memory. On
  Workers, that is per-isolate, so the effective limit is a multiple of the
  configured one and a burst can exceed it. This is the OTP control that the
  `./security` removal in 0.5.0 leaned on, so the assumption is load-bearing and
  should be stated as a per-isolate limit or backed by a shared store.
- **No audit log surface.** A shared package that touches payments and identity
  should emit a structured, non-PII audit event, and none of it does.
- **Supabase is optional in name only.** `data` speaks PostgREST, which is
  Supabase-shaped but not Supabase-specific. Worth stating in the docs, because
  consumers assume otherwise and then hit the differences.

## 5. Sequencing

Phase A is complete. Ordered by what unblocks what, not by effort.

1. **A1 + A2 + A3 + A4** — DONE and enforced in CI in both packages. Every check
   has a demonstrated failure mode, and the runbook's own checklist returns
   GREEN.
2. **Section 1 publish decision.** Operator-owned, irreversible, and explicitly
   not a prerequisite. Nothing in the packages depends on it.
3. **Phase B identity fork** is owned by each surface, not here, and nothing in
   the packages blocks it from being decided. This is the next thing that
   unblocks a deployable surface.
4. **Phase C gaps** are per-need: the token rotation story is required before a
   surface holds real sessions; the per-isolate rate-limit ceiling should be
   documented regardless.

## 6. Rules that keep holding

These are the load-bearing properties. They are restated here because a
roadmap that drops them is how a foundation becomes a liability.

- **Core has zero runtime dependencies and must keep it.** It is what lets a
  surface adopt one module without adopting a tree.
- **No singletons in either package.** A surface constructs its own instances.
  This is what makes the same package usable by two surfaces in one process.
- **`dist/` is committed and must match `src/`.** A shipped build, not a build
  the consumer runs.
- **A check is evidence only if it can fail.** A typecheck that cannot fail
  because nothing imports the target is not a pass. The consumer-resolution
  steps in both CIs assert the real runtime export list of every subpath
  (9 subpaths, 32 value exports) specifically because the previous version
  asserted names that had never been checked against the built output. The
  semver gate was three separate permanent greens before it was fault-tested.
- **Both install paths must be proven.** npm runs lifecycle scripts for a git
  dependency and not for a tarball, so a `prepare` that fails on every GitHub
  install is invisible to a tarball-only proof. That is how a `prepare` that
  could not resolve its peer shipped to a public repository. Both CI steps now
  install a real consumer and assert the runtime exports.
- **A breaking change is invisible until a consumer upgrades.** The tarball and
  tag pins are the only safety mechanism, so the changelog and the version bump
  are the contract. Both are now enforced by `check:semver`.

## 7. Explicitly not doing

- Not publishing to npm. Not creating a monorepo. Not adding a bundler. Not
  adding a framework. Not adding runtime dependencies to core.
- Not adding an identity or entitlement model to the packages. That belongs to
  the surfaces, and putting it in the shared package is how a shared package
  starts making decisions for its consumers.
- Not touching quant-signals. Its `AGENTS.md` holds uncommitted operator work,
  and its identity decision is unresolved.
