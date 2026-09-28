# AGENTS.md - `@ishan/ecosystem-core`

Operational manual for humans and AI agents maintaining this package. Read before
editing. The short version: this is the **dependency-free core** the ecosystem shares, and
its main risk is not a bug in a consumer, it is a *breaking change that no consumer knows
about* because the package is versioned, tagged and installed as a tarball.

---

## 1. What this package is

Shared, injected core for the Ishan Parihar ecosystem surfaces: role/tier session
resolution (`auth/`), HMAC tokens (`tokens/`), the subscriber store (`subscribers/`), a
PostgREST client (`data/`), KV cache (`cache/`), HTTP + rate limiting (`http/`), Razorpay
(`payments/`), email (`email/`), and delivery metrics (`monitoring/`).

Three properties are load-bearing and must not be traded away for convenience:

1. **Zero runtime dependencies.** `package.json` has no `dependencies`. A consumer drops
   this into a Cloudflare Worker without inheriting anything.
2. **No SvelteKit virtual modules, no module-level singletons.** Everything is injected
   through a config or a port interface, so the same code runs in a Worker, in Node, and in
   a test.
3. **`dist/` is committed.** Consumers install from a git tag, and the committed build is
   what they get. This is why the CI dist gate exists and why it is not optional.

## 2. The contract gate

`npm run contract` (`scripts/verify-contract.mjs`) enforces the injection contract: no
module reaches for a framework, an env var, or a global it was not handed. It runs first
in CI, before typecheck, because a contract break should never be discovered as a
typecheck error downstream.

**Never make a module import anything not injected.** That is the whole design. If you find
yourself wanting a module-level `import { env } from '$env/dynamic/private'`, the value
belongs in the caller's config.

## 3. Breaking-change discipline (the important section)

This package is consumed as a **pinned git-tag tarball**
(`https://github.com/ishan-parihar/ecosystem-core/archive/refs/tags/vX.Y.Z.tar.gz`). A
consumer's `package.json` names an exact version and its `node_modules` carries a build
that cannot be patched underneath it. So:

- **A breaking change is invisible to every consumer until they deliberately upgrade.**
  There is no runtime warning, no semver-range catch, nothing. The only signal is the
  changelog and the version number. Treat that as the whole safety mechanism.
- **Additive by default; a version bump is required and deliberate.** Adding a new export
  or a new optional config field is a minor. Removing or reshaping an export, or changing
  a default, is a major. There is no "deprecated but still exported" middle ground here -
  either it is in the changelog as removed, or it is still there.
- **Before removing anything, prove nothing imports it.** Verify by *exported symbol* AND
  by *subpath import*, across every surface in the ecosystem, including the surfaces that
  import the package root (a subpath-only check misses those). The 0.5.0 removal of
  `campaign` and `security` was justified exactly this way.
- **Never silently change a default.** A default that changes is a breaking change even
  when no export is touched. `DEFAULT_PREMIUM_TIERS`, the `http` rate-limit windows, and
  the `tokens` expiry are all defaults other surfaces depend on at runtime.
- **State the premise behind a removal in the changelog**, not just the fact. A removal
  justified by "no consumer uses it" is safe; a removal justified by a premise about how
  consumers *authenticate* is only safe while that premise holds, and the changelog has to
  say so and say what to do when it stops holding. The `0.5.0` `./security` entry is the
  worked example of this rule.
- **The removal commit and the version bump are one commit.** A changelog entry without the
  `package.json` bump, or a bump without the entry, is an incomplete release.

## 4. The `dist/` invariant

`dist/` is committed, so it must match `src/` exactly. CI proves this the only way that is
actually trustworthy - by content, after a real build, not by comparing filenames:

```
npm run build && git add -A dist && git diff --quiet -- dist
```

**Use the index-relative form in a working repo.** `git diff --quiet -- dist` compares
against HEAD, so any legitimate, not-yet-committed release rebuild reads as "stale" until
you commit it - a false failure that is not a defect. Staging first makes the comparison
"does a fresh rebuild differ from what is staged", which is the question you actually mean.
CI itself runs on a clean checkout where index-vs-HEAD is correct, so CI can use the short
form.

**If that check still fails, `dist/` is stale and the release is not shippable** - fix it
with `npm run build` and commit `dist/` in the same commit as the source change. Do not
hand-edit `dist/`, and do not "clean up" the gate: a stale `dist/` ships to every consumer
as a silent bug, not as a build error. Note that `tsc` does not clean `dist/`, so a removed
module's build output must be deleted by hand or it ships as a ghost next to an `exports`
map that no longer names it.

Because `npm pack` ships the committed `dist/`, the file listing in `package.json`
`files` and the subpath `exports` must both be updated in the same commit as any module
add/remove, or an import that typechecks locally 404s in a consumer.

## 5. Test and build commands

```
npm run contract    # injection contract (scripts/verify-contract.mjs)
npm run typecheck   # tsc --noEmit
npm run build       # tsc -p tsconfig.json (emits dist/)
npm run test        # vitest run
npm run verify      # all four, in that order - run this before any commit
```

A change is not done until `npm run verify` is green **and** the `dist/` gate passes. New
behaviour needs a test that can actually fail - not a test that re-pins a default or
asserts a mock echoes.

## 6. Multi-surface blast radius

This package is shared. Before any change, know which surfaces consume it and at which
version - a change that is additive for the newest consumer may still be breaking for one
pinned to an older tag. In the ecosystem the consumers are the storefront
(`ishanparihar-svelte`), the technical-authority site, and the identity sidecar
`@ishan/ecosystem-auth` (which consumes this package via `file:` and must keep passing its
own contract check).

## 7. Version control and release

This repo is versioned on `main` and released by pushing a `vX.Y.Z` tag; consumers pin the
tag tarball. The `0.5.0` release (removal of `campaign` and `security`) was developed in
the worktree and must be committed with its rebuilt `dist/`, its changelog entry, and its
`package.json` bump together - see section 3. A half-landed release - source deleted, dist
stale, changelog unwritten, version unbumped - is the specific failure this file exists to
prevent.
