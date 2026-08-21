import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/lib/server/db/driver.ts';
import { loadMigrations, migrate } from '../../src/lib/server/db/migrate.ts';
import { createMemoryDb } from '../../src/lib/server/db/index.ts';

function tableNames(db: ReturnType<typeof openDatabase>) {
	return db
		.prepare<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
		)
		.all()
		.map((r) => r.name);
}

describe('migrations', () => {
	it('applies cleanly to an empty database and sets user_version', () => {
		const db = openDatabase(':memory:');
		const result = migrate(db);

		expect(result.from).toBe(0);
		expect(result.to).toBe(loadMigrations().length);
		expect(result.applied).toEqual(loadMigrations().map((m) => m.name));
		db.close();
	});

	it('is a no-op when re-applied', () => {
		const db = openDatabase(':memory:');
		migrate(db);
		const before = tableNames(db);

		const second = migrate(db);
		expect(second.applied).toEqual([]);
		expect(second.from).toBe(second.to);
		expect(tableNames(db)).toEqual(before);
		db.close();
	});

	it('creates every table the app expects', () => {
		const db = createMemoryDb();
		const expected = [
			'allergen',
			'allergen_alias',
			'favorite',
			'item',
			'item_allergen',
			'login_code',
			'menu',
			'menu_category',
			'menu_item',
			'menu_item_trait',
			'nutrition_allergen',
			'nutrition_fact',
			'recipe_ingredient',
			'scrape_error',
			'scrape_lock',
			'scrape_run',
			'trait',
			'trait_allergen',
			'unit',
			'unit_hours',
			'unit_status',
			'user',
			'user_allergen',
			'user_session',
			'webauthn_challenge',
			'webauthn_credential'
		];
		expect(tableNames(db)).toEqual(expected);
		db.close();
	});

	it('enforces foreign keys and STRICT typing', () => {
		const db = createMemoryDb();

		// FK violation: no such user.
		expect(() =>
			db
				.prepare('INSERT INTO favorite (user_id, item_id, created_at) VALUES (?, ?, ?)')
				.run(999, 1, 0)
		).toThrow();

		// STRICT rejects a string in an INTEGER column.
		expect(() =>
			db
				.prepare('INSERT INTO scrape_run (kind, started_at, status) VALUES (?, ?, ?)')
				.run('full', 'not-a-number', 'running')
		).toThrow();

		db.close();
	});

	it('rolls back a failed migration whole', () => {
		const db = openDatabase(':memory:');
		expect(() =>
			migrate(db, [
				{
					version: 1,
					name: '0001_x.sql',
					sql: 'CREATE TABLE a (x INTEGER) STRICT; SELECT bad_fn();'
				}
			])
		).toThrow();

		expect(db.pragma<number>('user_version')).toBe(0);
		expect(tableNames(db)).toEqual([]);
		db.close();
	});
});

describe('allergen seed', () => {
	it('seeds the taxonomy with exactly the 18 upstream-covered allergens', () => {
		const db = createMemoryDb();
		const covered = db
			.prepare<{ slug: string }>(
				'SELECT slug FROM allergen WHERE covered_by_trait_vocabulary = 1 ORDER BY slug'
			)
			.all()
			.map((r) => r.slug);

		// These 18 are the ones upstream tags on every item row, so their absence
		// carries (weak) meaning. Any other allergen absent from a label is
		// `unknown`, never "no declared X". Changing this list changes safety
		// behaviour -- see allergens/verdict.ts.
		expect(covered).toEqual([
			'alcohol',
			'coconut',
			'corn',
			'eggs',
			'fish',
			'gelatin',
			'gluten-grains',
			'milk',
			'msg',
			'peanuts',
			'pork',
			'red-dye',
			'sesame',
			'shellfish',
			'soy',
			'sulfites',
			'tree-nuts',
			'wheat'
		]);
		db.close();
	});

	it('resolves tree nuts to its species via a recursive closure', () => {
		const db = createMemoryDb();
		const members = db
			.prepare<{ slug: string }>(
				`WITH RECURSIVE closure(id) AS (
				   SELECT id FROM allergen WHERE slug = 'tree-nuts'
				   UNION ALL
				   SELECT a.id FROM allergen a JOIN closure c ON a.parent_id = c.id
				 )
				 SELECT slug FROM allergen WHERE id IN (SELECT id FROM closure) ORDER BY slug`
			)
			.all()
			.map((r) => r.slug);

		expect(members).toContain('macadamia');
		expect(members).toContain('walnut');
		// Coconut is grouped with tree nuts by FDA labelling but is not one.
		expect(members).not.toContain('coconut');
		// Peanuts are legumes.
		expect(members).not.toContain('peanuts');
		db.close();
	});

	it('never aliases a bare "nut", which is what makes nutmeg a false positive', () => {
		const db = createMemoryDb();
		const aliases = db
			.prepare<{ alias: string }>(
				"SELECT alias FROM allergen_alias WHERE match_kind = 'ingredient'"
			)
			.all()
			.map((r) => r.alias);

		expect(aliases).not.toContain('nut');
		expect(aliases).not.toContain('nuts');
		// "water chestnut" must be vetoed off the chestnut alias.
		const chestnut = db
			.prepare<{ negative_prefixes: string | null }>(
				`SELECT aa.negative_prefixes FROM allergen_alias aa
				 JOIN allergen a ON a.id = aa.allergen_id
				 WHERE a.slug = 'chestnut' AND aa.alias = 'chestnut' AND aa.match_kind = 'ingredient'`
			)
			.get();
		expect(chestnut?.negative_prefixes).toBe('water');
		db.close();
	});
});
