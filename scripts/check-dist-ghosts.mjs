#!/usr/bin/env node
// Ghost-output detector: a directory in dist/ with no counterpart in src/.
//
// `tsc` does not clean dist/. Removing a module therefore leaves its compiled
// output behind, and because dist/ is committed and shipped, that output
// reaches every consumer. A consumer cannot import it through the exports map,
// so it is a packaging-hygiene issue rather than a live bug - but it is
// invisible, it accumulates, and it makes `git diff -- dist` after a removal
// look non-empty for no reason a reader can explain.
//
// The same shape catches the inverse, which is a real bug: a module in src/
// with no dist/ output means the build is stale, and the consumer gets a
// resolution error rather than the feature.
//
// Usage: node scripts/check-dist-ghosts.mjs

import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const dist = join(root, 'dist');

const fail = (msg) => {
  console.error(`\n  dist: ${msg}\n`);
  process.exit(1);
};

if (!existsSync(dist)) {
  // No dist at all means the build has not run, which is not this check's
  // business - the dist gate and the build step cover that. Reporting "clean"
  // here would be a pass for a condition that was never examined.
  fail('dist/ does not exist. Run `npm run build` first.');
}

const dirs = (p) =>
  new Set(
    readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name),
  );

const srcDirs = dirs(src);
const distDirs = dirs(dist);

// `internal` is compiled but not published through the exports map; it is
// still real output for a real source directory, so it counts on both sides.
const ghosts = [...distDirs].filter((d) => !srcDirs.has(d));
const missing = [...srcDirs].filter((d) => !distDirs.has(d));

if (ghosts.length) {
  fail(
    `dist/ contains output with no source: ${ghosts.join(', ')}.\n` +
      `    tsc does not clean dist/. Delete these directories and commit the\n` +
      `    removal, or a consumer receives orphaned build output forever.`,
  );
}
if (missing.length) {
  fail(
    `src/ has modules with no build output: ${missing.join(', ')}.\n` +
      `    The build is stale. Run \`npm run build\` and commit dist/.`,
  );
}

console.log(
  `  dist: ${distDirs.size} module(s) in sync with src/ (no ghosts, nothing missing)`,
);
