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

if (violations.length === 0) {
	console.log(`injection contract: OK (${filesChecked} files checked, 0 violations)`);
	process.exit(0);
}

console.error(`injection contract: FAILED (${violations.length} violation(s))\n`);
for (const v of violations) {
	console.error(`  ${v.file}:${v.line}  [${v.rule}]`);
	console.error(`    ${v.text}`);
	console.error(`    fix: ${v.hint}\n`);
}
process.exit(1);
