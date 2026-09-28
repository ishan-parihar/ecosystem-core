#!/usr/bin/env node
// Consumer matrix: every symbol a real surface imports from this package must
// still be exported by the current build.
//
// Why this exists. A subpath-level check says "the module resolves". It does
// not say the thing the consumer actually calls is still there. 0.5.0 removed
// two subpaths and the existing consumer check passed, because it asserted
// names chosen at the time of writing rather than the names a real surface
// depends on.
//
// So this list is extracted FROM the consumers, not invented here. The two
// surfaces tracked in this plan:
//
//   ishanparihar-svelte          pins the v0.4.0 tarball; imports
//                                ./auth ./cache ./email ./http ./monitoring
//                                ./payments ./tokens
//   technical-authority-website  pins the v0.4.0 tarball; imports the root
//                                plus ./data ./http ./subscribers
//
// If a surface is added, on or off this list, add it here with a comment. A
// symbol removed from this package without a version bump fails the semver
// gate; a symbol that never existed here fails this one.
//
// Usage: node scripts/check-consumer-matrix.mjs

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// surface -> { subpath: [value exports that surface calls at runtime] }
// Only runtime VALUES are listed. Type-only imports are erased at runtime and
// are the typecheck's job, not this one's.
const CONSUMERS = {
  'ishanparihar-svelte': {
    './auth': ['hasPremiumAccess', 'resolveRole'],
    './cache': ['KvCache', 'MemoryCache'],
    './email': ['createEmailService', 'createMockProvider'],
    './http': ['FixedWindowRateLimiter'],
    './monitoring': ['summarizeDelivery'],
    './payments': ['createRazorpayClient'],
    './tokens': ['mintToken', 'verifyTokenCompat'],
  },
  'technical-authority-website': {
    '.': [
      'confirmSubscriptionEmail',
      'contactNotificationEmail',
      'createEmailService',
      'createMockProvider',
      'isEmailAddress',
      'normalizeEmail',
      'verifyToken',
    ],
    './data': ['createPostgrest'],
    './http': ['mountTurnstile', 'verifyTurnstile'],
    './subscribers': ['createSupabaseSubscriberTable'],
  },
};

/** The dist file a subpath resolves to, from the exports map. */
function targetFile(subpath) {
  const entry = pkg.exports?.[subpath];
  if (!entry) return null;
  const js = typeof entry === 'string' ? entry : entry.default;
  return js ? join(root, js) : null;
}

/** Runtime export names, following `export * from` so a barrel is not a hole. */
function runtimeExports(file, seen = new Set()) {
  if (!file || seen.has(file)) return new Set();
  seen.add(file);
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    return new Set();
  }
  const names = new Set();

  // `export * from './x.js'` - recurse, because a re-export barrel declares no
  // names of its own and a regex that ignores it sees an empty surface.
  for (const m of src.matchAll(/export\s*\*\s*from\s*['"]([^'"]+)['"]/g)) {
    const target = join(dirname(file), m[1]);
    for (const n of runtimeExports(target, seen)) names.add(n);
  }
  // `export { a, b as c }` and `export { a } from './x.js'`
  for (const m of src.matchAll(/export\s*\{([^}]*)\}(?:\s*from\s*['"][^'"]+['"])?\s*;?/g)) {
    for (const part of m[1].split(',')) {
      const alias = part.trim().split(/\s+as\s+/);
      const name = (alias[1] ?? alias[0] ?? '').replace(/^type\s+/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  // `export function f`, `export async function f`, `export const c`, and the
  // `export class C` / `export type T` forms. A compiled module uses the inline
  // declarations for its own symbols and the brace form only for re-exports, so
  // matching only the braces sees ZERO names in a real file and the check
  // degrades into reporting every consumer symbol as removed.
  for (const m of src.matchAll(
    /export\s+(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|abstract\s+class)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    names.add(m[1]);
  }
  return names;
}

const fail = (msg) => {
  console.error(`\n  consumer matrix: ${msg}\n`);
  process.exit(1);
};

let checked = 0;
const problems = [];

for (const [surface, subpaths] of Object.entries(CONSUMERS)) {
  for (const [subpath, names] of Object.entries(subpaths)) {
    const file = targetFile(subpath);
    if (!file) {
      problems.push(`${surface}: subpath ${subpath} is not in the exports map at all`);
      continue;
    }
    if (!existsSync(file)) {
      problems.push(`${surface}: ${subpath} -> ${relative(root, file)} does not exist`);
      continue;
    }
    const actual = runtimeExports(file);

    // An empty parse is indistinguishable from "nothing was removed", and that
    // is the failure this check exists to prevent. Refuse to trust it.
    if (actual.size === 0) {
      problems.push(
        `${surface}: ${subpath} resolved to ${relative(root, file)} but exported 0 names - ` +
          `the build is stale or the parse failed; run \`npm run build\``,
      );
      continue;
    }
    for (const name of names) {
      checked += 1;
      if (!actual.has(name)) {
        problems.push(`${surface}: ${subpath} no longer exports ${name}`);
      }
    }
  }
}

if (problems.length) {
  fail(
    `a real surface depends on something this package no longer exports:\n` +
      problems.map((p) => `    - ${p}`).join('\n') +
      `\n    If this is a deliberate removal, bump the version and update this file.`,
  );
}

const surfaces = Object.keys(CONSUMERS).length;
const subpaths = new Set(
  Object.values(CONSUMERS).flatMap((s) => Object.keys(s)),
).size;
console.log(
  `  consumer matrix: OK (${surfaces} surfaces, ${subpaths} subpaths, ${checked} runtime symbols)`,
);
