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
`package.json` installed both by GitHub spec and then imported them.

| | `@ishan/ecosystem-core` | `@ishan/ecosystem-auth` |
|---|---|---|
| Repository | `github.com/ishan-parihar/ecosystem-core` (public) | `github.com/ishan-parihar/ecosystem-auth` (public) |
| Version | `0.5.0`, tagged and pushed | `0.1.0`, `main` pushed |
| Tests | 242/242 | 28/28 |
| Typecheck | OK | OK |
| `dist` gate | PASS | PASS |
| Runtime deps | none | `better-auth` |
| Peer on core | n/a | `>=0.5.0`, required, not optional |

Install specs that are proven to work today:

```jsonc
// a surface depends on core directly
"@ishan/ecosystem-core": "github:ishan-parihar/ecosystem-core#v0.5.0"

// a surface uses the auth adapter
"@ishan/ecosystem-auth": "github:ishan-parihar/ecosystem-auth#main",
"@ishan/ecosystem-core": "github:ishan-parihar/ecosystem-core#v0.5.0"  // required peer
```

Both are public and require no credentials, which is the point: a surface can
install them in CI with no npm login, no publish step, and no secret in a repo.

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

**If we publish**, the requirements are: `publishConfig.access: public` (both
packages currently have no `publishConfig`, so a publish would default to
private and silently fail to be installable), an npm login on this machine
(`npm whoami` is currently `ENEEDAUTH`), and the `@ishan` scope claimed or
verified as ours. The `@ishan/ecosystem-core` and `@ishan/ecosystem-auth` names
are currently unclaimed on the registry (404), so the names are free.

**Do not publish as a prerequisite for quant-signals.** The GitHub spec is a
sufficient dependency mechanism today, and publishing is a separate,
operator-owned, irreversible decision.

## 2. Phase A: release hardening (blocking all adoption)

These are the properties that make a shared package safe to depend on. None of
them exist yet, and every one of them is a real defect waiting to be paid for.

### A1. Semver discipline is currently unenforced

`0.5.0` removed two published subpaths (`./campaign`, `./security`). Every
existing consumer that imported them breaks on upgrade, and nothing in the
toolchain would have told us before the tag. A consumer pinning `#v0.4.0` is
protected only by its own pin; a consumer tracking `main` breaks silently.

- Add a CI check that diffs the published `exports` map and the root export
  names between the previous tag and HEAD, and fails on a removal or a rename
  unless the `package.json` version carries a major (or, while the version is
  `0.x`, the minor) bump. The `0.x` rule matters: at `0.x` npm treats the minor
  as the breaking boundary, so the tool must too.
- Add the check to the `published-artifact` job, which currently only runs on a
  tag. That job is the only place the *published* shape is proven, and it is the
  only place a consumer sees.

### A2. The dist invariant is a convention, not a gate

`dist/` is committed and shipped, and a stale `dist/` ships to every consumer as
a runtime bug rather than a build error. The content gate exists in both
repositories and both pass, but it is a step in a workflow, not a check on
every commit that touches `src/`. Tighten it to run whenever `src/` changes, and
make the failure message name the fix.

Known hazard, already documented in core's `AGENTS.md`: `tsc` does not clean
`dist/`, so removing a module leaves ghost output. A consumer can import a path
that no longer exists in `src/`. The `exports` map hides this for well-behaved
consumers, so it is a packaging-hygiene issue rather than a live bug.

### A3. No compatibility matrix against real consumers

The two existing consumers (`ishanparihar-svelte`, `technical-authority-website`)
are on the `v0.4.0` tarball. Nothing in CI proves the current core still works
for them, or that the auth adapter works for a surface that has both. Add a
job that installs the current core into a scratch project, imports every
published subpath, and asserts the entry points each known consumer calls. The
symbol map already written into core's CI is the seed for this; it should name
the consumer, not just the subpath.

### A4. Release process is undocumented as a procedure

Each package has an `AGENTS.md` covering how to *work* in it. Neither has a
release runbook: what the tag sequence is, what must be green before tagging,
what a rollback looks like. A tag is a public, effectively-irreversible act and
the person doing it should not be reconstructing the steps.

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

Ordered by what unblocks what, not by effort.

1. **A1 + A2** (semver check, dist gate on every `src/` change). Small, and they
   are the two properties whose absence is a latent defect rather than a
   missing feature.
2. **A4** (release runbook). Write it before the next tag, not after a bad one.
3. **A3** (consumer matrix). Depends on knowing who the consumers are; that is
   known.
4. **Section 1 publish decision.** Operator-owned, irreversible, and explicitly
   not a prerequisite.
5. **Phase B identity fork** is owned by the surface, not here, and nothing in
   the packages blocks it from being decided.
6. **Phase C gaps** are per-need: the token rotation story is required before a
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
  asserted names that had never been checked against the built output.
- **A breaking change is invisible until a consumer upgrades.** The tarball and
  tag pins are the only safety mechanism, so the changelog and the version bump
  are the contract. Neither package has an automated check for this yet (A1).

## 7. Explicitly not doing

- Not publishing to npm. Not creating a monorepo. Not adding a bundler. Not
  adding a framework. Not adding runtime dependencies to core.
- Not adding an identity or entitlement model to the packages. That belongs to
  the surfaces, and putting it in the shared package is how a shared package
  starts making decisions for its consumers.
- Not touching quant-signals. Its `AGENTS.md` holds uncommitted operator work,
  and its identity decision is unresolved.
