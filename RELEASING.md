# Release runbook

> How to cut a release of `@ishan/ecosystem-core` or `@ishan/ecosystem-auth`.
> Both packages follow the same procedure. Written 2026-09-28, after the 0.5.0
> and 0.1.0 releases, because the first one shipped two removed subpaths with
> nothing objecting and the second one shipped a `prepare` that broke every
> install from GitHub.

Each package's `AGENTS.md` covers how to *work* in it. This covers how to ship
it. The plan in `PLAN.md` says which properties are enforced and which are open.

## What a tag means

A tag is a consumer's pin. It is the only thing that makes a release visible to
the surfaces that depend on it, and it is effectively irreversible: the tag name
is taken, and a moving tag is a moving dependency.

The two properties that make that safe are both enforced now, so neither is
optional to run:

- **`check:semver`** fails a release that removes or renames a published subpath
  or a root value export without the bump that declares it. While the major is
  `0`, that means a minor bump.
- **`check:ghosts`** fails a stale or polluted `dist/`, which ships as a runtime
  bug rather than a build error.

## Before you tag

Run every gate, in this order. All of them must be green.

```bash
npm ci
npm run verify          # contract + typecheck + build + test
npm run check:semver    # breaking surface change vs the bump
npm run check:ghosts    # no orphaned build output
npm run check:dist      # index-relative dist gate
```

`npm run check:dist` is `npm run build && git add -A dist && git diff --quiet
-- dist`. The staging matters: `git diff --quiet -- dist` on its own compares
against HEAD, so a correct release rebuild that is not yet committed reads as a
phantom failure. CI runs on a clean checkout, where the short form is right.

Then confirm the tree is exactly what you intend to ship:

```bash
git status --porcelain   # should be empty after the commit
```

## Choosing the version

At `0.x`, npm treats the **minor** as the breaking boundary. Concretely:

| Change | Bump |
|---|---|
| a bug fix, no surface change | patch |
| a new subpath, a new export, a new option | minor |
| **a removed subpath, a renamed export, a changed default** | **minor** |

The last row is the one that is easy to get wrong, because the edit to
`package.json` looks identical in all three rows. `check:semver` is what
distinguishes them; do not override it by hand.

Prefer additive. A deprecation is cheaper than a removal: an export can be
marked deprecated and left in place for one release, so consumers get a warning
and a migration window instead of a resolution error at their next upgrade.

## The sequence

```bash
# 1. everything green, tree clean (see above)
# 2. version + changelog, committed together
npm version <patch|minor> --no-git-tag-version
$EDITOR CHANGELOG.md
npm run check:semver        # the bump now declares whatever changed
npm run build && git add -A dist && git diff --quiet -- dist
git commit -am "Release X.Y.Z: <what changed and why>"

# 3. tag the COMMITTED state, and say what the release means
git tag -a vX.Y.Z -m "<one paragraph: what changed, and what a consumer must do>"

# 4. publish
git push origin main
git push origin vX.Y.Z
```

Tag after the commit, never before. A tag pointing at an uncommitted state is a
release nobody can reproduce.

## After you push

CI runs on the tag and proves the published shape, not just the repository's.
Wait for it: a release whose tag job is red is a release nobody should depend on.

```bash
gh run watch --repo ishan-parihar/ecosystem-core
```

If it is red, the fix is a new patch release. Do not move a published tag.

## When you depend on the other package

`ecosystem-auth` has a **required, non-optional peer** on
`@ishan/ecosystem-core`. Two rules follow, and both have already been paid for
once:

- **A core release that changes what auth imports requires an auth release.** The
  peer range is a range, so a consumer will not notice; the typecheck is what
  catches it, in auth's CI, on the commit that bumps core.
- **The peer floor is evidence, not caution.** It is `>=0.4.0` because that is
  what auth's imports need, proven by running auth's suite against a real core
  0.4.0 install. Raising it "to be safe" blocks the two v0.4.0-pinned consumers
  into cutting releases for nothing. Do not raise a floor without running the
  suite against the version you are naming.

## A release checklist you can paste

```bash
npm ci && npm run verify && npm run check:semver && npm run check:ghosts \
  && npm run check:dist && git status --porcelain && echo "GREEN"
```

An empty `git status --porcelain` is part of the pass. A dirty tree that passed
every gate has not shipped what the gates checked.
