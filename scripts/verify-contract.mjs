#!/usr/bin/env node
/**
 * Enforce the injection contract.
 *
 * Every rule below exists because violating it produces a package that works
 * in one application and breaks in the next. The check is a script rather than
 * a note in a document because a rule nobody runs is a rule that regresses the
 * first time someone is in a hurry.
 *
 * Comments are stripped before scanning, so a doc comment may discuss the
 * banned modules without tripping the gate.
 *
 * Usage: node scripts/verify-contract.mjs
 * Exit code 1 on any violation.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

/**
 * Patterns that must never appear in shipped code.
 *
 * Each is an import or a runtime read, not a bare word, so prose that names
 * the module is unaffected once comments are stripped.
 */
const BANNED = [
	{
		name: 'SvelteKit virtual module ($env/$lib/$app)',
		re: /(?:from|import)\s*\(?\s*['"`]\$(?:env|lib|app)\b/,
		hint: 'Pass the value in as an argument, or as a handle from the caller.',
	},
	{
		name: 'import.meta.env',
		re: /import\.meta\.env/,
		hint: 'Vite-specific and configured differently per application. Accept a config object.',
	},
	{
		name: 'node: builtin',
		re: /(?:from|import)\s*\(?\s*['"`]node:|\brequire\s*\(\s*['"`]node:/,
		hint: 'The Workers runtime exposes Web APIs. Use fetch, crypto.subtle, TextEncoder.',
	},
	{
		name: 'bare Node builtin import',
		re: /(?:from|require\s*\()\s*['"`](?:fs|path|os|crypto|http|https|stream|buffer|events|util)(?:\/|['"`])/,
		hint: 'Use the Web API equivalent, or move the code out of the package.',
	},
];

/**
 * Module-level construction of a service, which reads configuration at import
 * time and therefore cannot accept a per-request Cloudflare binding.
 */
const MODULE_SINGLETON = {
	name: 'module-level service construction',
	// An exported or plain top-level const/let assigned a factory call.
	re: /^(?:export\s+)?(?:const|let)\s+\w+\s*=\s*(?:await\s+)?(?:createEmailService|createPostgrest|createSupabaseSubscriberTable|new\s+PostgrestClient|new\s+SubscriberStore|new\s+SupabaseSubscriberTable)\s*\(/m,
	hint: 'Expose a factory and call it per request. Cloudflare bindings live on platform.env.',
};

/** Remove block comments and line comments, preserving line numbering. */
function stripComments(source) {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/gm, (match, prefix) => prefix + ' '.repeat(match.length - prefix.length));
}

function walk(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			walk(full, out);
			continue;
		}
		if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
			out.push(full);
		}
	}
	return out;
}

const violations = [];
let filesChecked = 0;

for (const file of walk(SRC)) {
	filesChecked += 1;
	const raw = readFileSync(file, 'utf8');
	const code = stripComments(raw);
	const lines = code.split('\n');
	const rel = relative(ROOT, file);

	for (const rule of BANNED) {
		for (const [index, line] of lines.entries()) {
			if (rule.re.test(line)) {
				violations.push({ file: rel, line: index + 1, rule: rule.name, hint: rule.hint, text: line.trim() });
			}
		}
	}

	if (MODULE_SINGLETON.re.test(code)) {
		const index = lines.findIndex((line) => MODULE_SINGLETON.re.test(line + '\n'));
		violations.push({
			file: rel,
			line: index === -1 ? 1 : index + 1,
			rule: MODULE_SINGLETON.name,
			hint: MODULE_SINGLETON.hint,
			text: (lines[index] ?? '').trim(),
		});
	}
}

/*
 * Manifest invariants.
 *
 * The package is dependency-free at runtime, and that is not an accident worth
 * leaving unguarded. A bare `npm install <tarball>` run in this directory adds
 * a self-dependency to `package.json`, and the resulting lockfile then makes
 * every consumer's install fail with an ENOENT on a path that only exists on
 * the machine that ran it. That happened once; this check is why it cannot
 * happen twice.
 */
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const dependencyFields = ['dependencies', 'peerDependencies', 'optionalDependencies'];

for (const field of dependencyFields) {
	const entries = Object.entries(manifest[field] ?? {});
	if (entries.length > 0) {
		violations.push({
			file: 'package.json',
			line: 1,
			rule: `runtime ${field}`,
			hint: 'This package is dependency-free by design. Move the dependency to the consumer.',
			text: `${field}: ${JSON.stringify(manifest[field])}`,
		});
	}
}

// A `file:` specifier anywhere makes a consumer depend on a local checkout,
// and a self-reference additionally breaks the lockfile.
const manifestText = readFileSync(join(ROOT, 'package.json'), 'utf8');
if (/"file:/.test(manifestText)) {
	violations.push({
		file: 'package.json',
		line: 1,
		rule: 'file: dependency specifier',
		hint: 'A file: reference cannot resolve for any other checkout. Use a git tag.',
		text: manifestText.split('\n').find((l) => l.includes('"file:'))?.trim() ?? '',
	});
}

const lockPath = join(ROOT, 'package-lock.json');
if (statSync(lockPath, { throwIfNoEntry: false })) {
	const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
	const selfRefs = Object.keys(lock.packages ?? {}).filter((k) => k.includes('ecosystem-core'));
	if (selfRefs.length > 0 || JSON.stringify(lock.packages?.['']?.dependencies ?? {}).includes('file:')) {
		violations.push({
			file: 'package-lock.json',
			line: 1,
			rule: 'self-referential lockfile',
			hint: 'Delete package-lock.json and run `npm install` after fixing package.json.',
			text: selfRefs.join(', '),
		});
	}
}

// The consumer harness must not declare the package it is testing.
//
// It exists to typecheck the artifact a published tag actually contains, and CI
// installs that tag with an explicit `npm install <tag-url>` (see
// .github/workflows/ci.yml). If the manifest ever gains a `dependencies` entry,
// npm resolves that pinned version instead, the harness silently stops testing
// the tag under test, and it still reports PASS. That is a harness that lies,
// which is worse than no harness; a passing typecheck must mean the tag works.
const smokeManifestPath = join(ROOT, 'consumer-smoke', 'package.json');
if (statSync(smokeManifestPath, { throwIfNoEntry: false })) {
	const smoke = JSON.parse(readFileSync(smokeManifestPath, 'utf8'));
	const pinned = ['dependencies', 'devDependencies', 'peerDependencies'].filter(
		(field) => Object.keys(smoke[field] ?? {}).length > 0,
	);
	if (pinned.length > 0) {
		violations.push({
			file: 'consumer-smoke/package.json',
			line: 1,
			rule: 'consumer harness pins a version',
			hint: 'Remove the dependency. CI installs the published tag with an explicit `npm install <tag-url>`; a declared entry shadows it and the harness stops testing the release.',
			text: pinned.map((field) => `${field}: ${JSON.stringify(smoke[field])}`).join(' '),
		});
	}
}

// dist/ must stay committed, because a consumer installs this package without
// running any install script.
const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
if (/^\s*dist\s*$/m.test(gitignore)) {
	violations.push({
		file: '.gitignore',
		line: 1,
		rule: 'dist is gitignored',
		hint: 'dist/ is committed so consumers need no build step. Remove it from .gitignore.',
		text: 'dist',
	});
}

if (violations.length === 0) {
	console.log(
		`contract: OK (${filesChecked} source files, manifest invariants, 0 violations)`,
	);
	process.exit(0);
}

console.error(`contract: FAILED (${violations.length} violation(s))\n`);
for (const v of violations) {
	console.error(`  ${v.file}:${v.line}  [${v.rule}]`);
	console.error(`    ${v.text}`);
	console.error(`    fix: ${v.hint}\n`);
}
process.exit(1);
