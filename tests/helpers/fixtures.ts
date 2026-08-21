import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'netnutrition');
const MANIFEST = join(DIR, 'manifest.json');

const cache = new Map<string, string>();

export function loadFixture(name: string): string {
	let hit = cache.get(name);
	if (hit === undefined) {
		const path = join(DIR, name);
		if (!existsSync(path)) {
			throw new Error(
				`Fixture "${name}" is missing. Re-capture with \`node scripts/capture-fixtures.ts\`.`
			);
		}
		hit = readFileSync(path, 'utf8');
		cache.set(name, hit);
	}
	return hit;
}

/** Panels out of a NetNutrition JSON envelope, for tests that want raw HTML. */
export function fixturePanel(name: string, panelId: string): string {
	const parsed = JSON.parse(loadFixture(name)) as { panels: { id: string; html: string }[] };
	const panel = parsed.panels.find((p) => p.id === panelId);
	if (!panel) throw new Error(`Fixture "${name}" has no panel "${panelId}"`);
	return panel.html;
}

export function fixtureDigest(name: string): string {
	return createHash('sha256').update(loadFixture(name)).digest('hex').slice(0, 16);
}

/**
 * Fixtures are the expectations. If one is edited by accident -- reformatted,
 * re-captured, partially overwritten -- the parser tests would quietly start
 * asserting whatever the new bytes say. This makes that fail loudly instead.
 */
export function assertFixturesUnchanged(): void {
	const expected = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, string>;
	const drifted: string[] = [];
	for (const [name, digest] of Object.entries(expected)) {
		if (fixtureDigest(name) !== digest) drifted.push(name);
	}
	if (drifted.length) {
		throw new Error(
			`Fixture(s) changed since the manifest was written: ${drifted.join(', ')}.\n` +
				`If this was intentional, re-run \`node scripts/write-fixture-manifest.ts\` and re-check the expectations.`
		);
	}
}
