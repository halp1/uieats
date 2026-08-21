#!/usr/bin/env node
/** Records a digest per fixture so accidental edits fail loudly. */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'tests', 'fixtures', 'netnutrition');
const manifest: Record<string, string> = {};

for (const name of readdirSync(DIR).sort()) {
	if (name === 'manifest.json' || name === 'README.md') continue;
	manifest[name] = createHash('sha256')
		.update(readFileSync(join(DIR, name)))
		.digest('hex')
		.slice(0, 16);
}

writeFileSync(join(DIR, 'manifest.json'), JSON.stringify(manifest, null, '\t') + '\n');
console.log(`wrote manifest for ${Object.keys(manifest).length} fixtures`);
