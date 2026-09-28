#!/usr/bin/env node
// Semver gate: fail a release that removes or renames a published subpath or
// a root export without the version bump that declares it breaking.
//
// Why this exists. 0.5.0 removed ./campaign and ./security. Nothing in the
// toolchain objected, because a removal is a legal edit to package.json: the
// tag went out, and a consumer importing either path discovered it at their
// own upgrade. Consumers pin a tag, so the only mechanism that can warn them
// is the changelog plus the version number. This script makes the version
// number an enforced claim rather than a remembered one.
//
// The 0.x rule. While the major is 0, npm treats the MINOR as the breaking
// boundary. So a removed subpath must come with a minor bump, and the script
// enforces that rather than pretending a patch bump was enough.
//
// Usage: node scripts/check-semver.mjs [baseRef]
//   baseRef defaults to the most recent tag reachable from HEAD. With no tag
//   at all (a first release) there is nothing to compare against and the
//   script reports that and exits 0 - it has no failure mode, so it must not
//   pretend to be a pass that is really a skip.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8' }).trim();

const fail = (msg) => {
  console.error(`\n  semver: ${msg}\n`);
  process.exit(1);
};

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const current = pkg.version;

/**
 * Subpath -> exported name list, from the `exports` map.
 * `ref` is a git ref, so this reads the RELEASED state.
 */
function exportsAt(ref) {
  const raw = git('show', `${ref}:package.json`);
  const p = JSON.parse(raw);
  const out = new Map();
  for (const [key, value] of Object.entries(p.exports ?? {})) {
    if (key === '.') continue;
    out.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return out;
}

/** The exports map as it stands in the WORKING TREE, not at HEAD. */
function exportsNow() {
  const p = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const out = new Map();
  for (const [key, value] of Object.entries(p.exports ?? {})) {
    if (key === '.') continue;
    out.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return out;
}

/**
 * Root VALUE export names, read by parsing the built JavaScript.
 *
 * The declaration file cannot answer this. dist/index.d.ts is a list of
 * `export * from './<sub>/index.js'` lines and declares no names of its own, so
 * a regex over it matches nothing and a check built on it would report "no
 * change" for any removal - a gate that cannot fail. Worse, the honest-looking
 * alternative (grepping each subpath's .d.ts) is equally wrong: index.d.ts
 * re-exports, so the functions live in sub-files and a reader checking only
 * the entry concludes the export is missing.
 *
 * The built JS is the only artifact that states the real runtime surface, so
 * that is what this reads. It also covers a renamed subpath's exports, which
 * the entry .d.ts never showed.
 */
function rootValueExports() {
  const js = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8');
  const names = new Set();
  for (const m of js.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      // "a as b" exports b; "a" exports a.
      const alias = part.trim().split(/\s+as\s+/);
      const name = (alias[1] ?? alias[0] ?? '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

function rootValueExportsAt(ref) {
  try {
    const js = git('show', `${ref}:dist/index.js`);
    const names = new Set();
    for (const m of js.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const alias = part.trim().split(/\s+as\s+/);
        const name = (alias[1] ?? alias[0] ?? '').trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
      }
    }
    return names;
  } catch {
    return new Set();
  }
}

// Compare against the state a consumer on the previous release does NOT have.
//
// `git describe --tags --abbrev=0` is wrong here: when HEAD is itself tagged it
// returns that same tag, so the comparison is a tag against itself - empty, and
// the gate reported "no breaking change" for a commit that had in fact removed
// a subpath. That is the vacuous-pass shape this gate exists to prevent.
//
// So when HEAD is tagged, the base is HEAD^: the commit just before the release.
// It is deliberately NOT resolved through `describe`, because on a first tagged
// release the parent predates every tag and `git describe HEAD^` fails outright
// - which previously sent this gate down its "no prior release" path and left it
// a permanent, silent pass.
//
// The base is therefore a COMMIT ref, which works for a tag or a commit, and
// the base version is read from package.json at that ref rather than parsed out
// of a ref name. On a first release that ref is not a tag and has no version in
// its name at all.
const headIsTagged = (() => {
  try {
    return git('tag', '--points-at', 'HEAD').split('\n').filter(Boolean).length > 0;
  } catch {
    return false;
  }
})();

const base = process.argv[2] || (headIsTagged ? 'HEAD^' : (() => {
  try {
    return git('describe', '--tags', '--abbrev=0');
  } catch {
    // No tag reachable: compare against the previous commit, which is still a
    // real comparison rather than none.
    return 'HEAD^';
  }
})());

/**
 * The version declared at a ref, so the bump is measured against the state
 * actually being compared against. The base is a COMMIT on a first tagged
 * release, not a tag, so its name cannot be parsed as a version.
 */
function versionAt(ref) {
  try {
    return JSON.parse(git('show', `${ref}:package.json`)).version;
  } catch {
    return null;
  }
}

const baseVersion = versionAt(base);
if (!baseVersion) {
  // An unresolvable base is NOT a pass. Reporting "no breaking change" for a
  // comparison that never happened is the vacuous-pass shape this gate exists
  // to prevent, so fail loudly instead.
  fail(`cannot read package.json at base ref "${base}" - nothing was compared`);
}
const [baseMajor, baseMinor] = baseVersion.split('.').map(Number);
const [curMajor, curMinor] = current.split('.').map(Number);
const bump = curMajor > baseMajor ? 'major' : curMinor > baseMinor ? 'minor' : 'patch';
// At 0.x the minor IS the breaking boundary npm enforces.
const breakingBumps = curMajor > 0 ? ['major'] : ['major', 'minor'];
const breakingIsDeclared = breakingBumps.includes(bump);

console.log(`  semver: v${baseVersion} (${base}) -> v${current}  (${bump} bump)`);

const prevExports = exportsAt(base);
const nowExports = exportsNow();
const removedPaths = [...prevExports.keys()].filter((k) => !nowExports.has(k));
const addedPaths = [...nowExports.keys()].filter((k) => !prevExports.has(k));
const changedPaths = [...prevExports.keys()].filter(
  (k) => nowExports.has(k) && nowExports.get(k) !== prevExports.get(k),
);

const prevRoot = rootValueExportsAt(base);
const nowRoot = rootValueExports();
const removedRoot = [...prevRoot].filter((n) => !nowRoot.has(n));

const breaking = [];
if (removedPaths.length) breaking.push(`removed subpath(s): ${removedPaths.join(', ')}`);
if (changedPaths.length) breaking.push(`changed subpath target(s): ${changedPaths.join(', ')}`);
if (removedRoot.length) breaking.push(`removed root export(s): ${removedRoot.join(', ')}`);

if (addedPaths.length) console.log(`  semver: added subpath(s): ${addedPaths.join(', ')}`);

if (!breaking.length) {
  console.log('  semver: no breaking surface change');
  process.exit(0);
}

console.log(`\n  BREAKING: ${breaking.join('; ')}\n`);
if (!breakingIsDeclared) {
  fail(
    `v${current} is a ${bump} bump, which declares no breaking change. ` +
      `At ${curMajor === 0 ? '0.x' : 'major >= 1'} a removal requires ` +
      `${breakingBumps.join(' or ')}. Either bump the version or restore the ` +
      `exports. A consumer pinned to ${baseVersion} will break at their upgrade, and ` +
      `nothing else tells them.`,
  );
}
console.log(`  semver: OK - the ${bump} bump declares this removal. Update CHANGELOG.md.`);
