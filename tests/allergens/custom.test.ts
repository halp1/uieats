/**
 * Allergens the seeded taxonomy does not have.
 *
 * The 63 seeded allergens cover what upstream declares plus the common
 * omissions. They cannot cover kiwi, nightshades, buckwheat or a specific
 * additive, and "your allergy is not on our list" is a bad answer from an app
 * whose whole purpose is telling you what you can eat.
 *
 * The property that matters most: a custom allergen can never be softened by a
 * missing trait icon, because upstream has no icon for it. With no label read,
 * the answer has to be `unknown`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/lib/server/db/driver.ts';
import { createMemoryDb } from '../../src/lib/server/db/index.ts';
import {
	getAllergenProfile,
	getCustomAllergens,
	getItemVerdicts
} from '../../src/lib/server/queries/allergens.ts';
import { unixNow } from '../../src/lib/dates.ts';

const NOW = 1_760_000_000;

let db: Db;
let userId: number;

beforeEach(() => {
	db = createMemoryDb();
	userId = db
		.prepare('INSERT INTO user (email, created_at) VALUES (?, ?)')
		.run('student@illinois.edu', NOW).lastInsertRowid;
});

function addCustom(label: string, terms: string[]): void {
	db.prepare(
		'INSERT INTO user_custom_allergen (user_id, label, terms, created_at) VALUES (?, ?, ?, ?)'
	).run(userId, label, terms.join('|'), unixNow());
}

/** A dish with an optional label, so the no-label path can be exercised. */
function seedItem(options: { ingredients?: string | null; withLabel?: boolean } = {}): number {
	const unitId = db
		.prepare(
			`INSERT INTO unit (nn_oid, parent_id, name, slug, kind, first_seen_at, last_seen_at)
			 VALUES (1, NULL, 'Test', 'test', 'standalone', ?, ?)`
		)
		.run(NOW, NOW).lastInsertRowid;
	const menuId = db
		.prepare(
			`INSERT INTO menu (unit_id, service_date, meal, meal_sort, nn_oid, first_seen_at)
			 VALUES (?, '2026-08-21', 'Lunch', 30, 99, ?)`
		)
		.run(unitId, NOW).lastInsertRowid;
	const categoryId = db
		.prepare(
			`INSERT INTO menu_category (menu_id, nn_category_id, name, sort, scrape_run_id)
			 VALUES (?, 1, 'Entrees', 0, 1)`
		)
		.run(menuId).lastInsertRowid;
	const itemId = db
		.prepare('INSERT INTO item (name_norm, name_display, slug, first_seen_at) VALUES (?, ?, ?, ?)')
		.run('test dish', 'Test Dish', 'test-dish', NOW).lastInsertRowid;

	let factId: number | null = null;
	if (options.withLabel !== false) {
		factId = db
			.prepare(
				`INSERT INTO nutrition_fact (content_hash, ingredients_text, first_seen_at)
				 VALUES (?, ?, ?)`
			)
			.run(
				`hash-${Math.trunc(Math.random() * 1e9)}`,
				options.ingredients ?? null,
				NOW
			).lastInsertRowid;
	}

	return db
		.prepare(
			`INSERT INTO menu_item (menu_id, category_id, item_id, nn_detail_oid, sort, scrape_run_id,
			                        nutrition_fact_id, label_fetched_at)
			 VALUES (?, ?, ?, 1000, 0, 1, ?, ?)`
		)
		.run(menuId, categoryId, itemId, factId, factId === null ? null : NOW).lastInsertRowid;
}

describe('storing them', () => {
	it('reads back the terms as a list', () => {
		addCustom('Kiwi', ['kiwi', 'kiwifruit']);
		expect(getCustomAllergens(db, userId)).toEqual([
			{ id: expect.any(Number), label: 'Kiwi', terms: ['kiwi', 'kiwifruit'] }
		]);
	});

	it('gives them negative ids, so they can never collide with a seeded allergen', () => {
		// `allergen.id` and `user_custom_allergen.id` are separate autoincrements
		// and would otherwise overlap while meaning entirely different things.
		addCustom('Kiwi', ['kiwi']);
		expect(getCustomAllergens(db, userId)[0].id).toBeLessThan(0);
	});

	it("keeps one person's list out of another's", () => {
		const other = db
			.prepare('INSERT INTO user (email, created_at) VALUES (?, ?)')
			.run('other@illinois.edu', NOW).lastInsertRowid;
		addCustom('Kiwi', ['kiwi']);
		expect(getCustomAllergens(db, other)).toEqual([]);
	});

	it('gives an anonymous visitor nothing', () => {
		expect(getCustomAllergens(db, null)).toEqual([]);
	});

	it('goes away with the account', () => {
		addCustom('Kiwi', ['kiwi']);
		db.prepare('DELETE FROM user WHERE id = ?').run(userId);
		expect(
			db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM user_custom_allergen').get()!.c
		).toBe(0);
	});
});

describe('matching them', () => {
	it('finds one named in the ingredient text', () => {
		addCustom('Kiwi', ['kiwi']);
		const menuItemId = seedItem({ ingredients: 'WATER, SUGAR, KIWI PUREE, CITRIC ACID.' });

		const summary = getItemVerdicts(db, getAllergenProfile(db, userId), [menuItemId]).get(
			menuItemId
		)!;
		expect(summary.worst?.verdict).toBe('flagged-likely');
		expect(summary.worst?.chipLabel).toBe('Kiwi');
		expect(summary.worst?.basis).toContain('KIWI');
	});

	it('matches any one of several terms', () => {
		// "nightshade" appears on no label; the family members do.
		addCustom('Nightshades', ['tomato', 'potato', 'aubergine', 'paprika']);
		const menuItemId = seedItem({ ingredients: 'BEEF, ONION, SMOKED PAPRIKA, SALT.' });

		expect(
			getItemVerdicts(db, getAllergenProfile(db, userId), [menuItemId]).get(menuItemId)!.worst
				?.verdict
		).toBe('flagged-likely');
	});

	it('is unknown when no label has been read', () => {
		// THE property. Upstream has no icon for a custom allergen, so a missing
		// icon says nothing at all and this can never read as clear.
		addCustom('Kiwi', ['kiwi']);
		const menuItemId = seedItem({ withLabel: false });

		const summary = getItemVerdicts(db, getAllergenProfile(db, userId), [menuItemId]).get(
			menuItemId
		)!;
		expect(summary.worst?.verdict).toBe('unknown');
		expect(summary.allChecked).toBe(false);
	});

	it('is no-declared once an ingredient list has been read without a hit', () => {
		addCustom('Kiwi', ['kiwi']);
		const menuItemId = seedItem({ ingredients: 'WATER, WHEAT FLOUR, YEAST, SALT.' });

		expect(
			getItemVerdicts(db, getAllergenProfile(db, userId), [menuItemId]).get(menuItemId)!.worst
				?.verdict
		).toBe('no-declared');
	});

	it('reports an advisory hit as an advisory, not as an ingredient', () => {
		addCustom('Kiwi', ['kiwi']);
		const menuItemId = seedItem({
			ingredients: 'WATER, SUGAR, APPLE. MAY CONTAIN: Kiwi, Mango.'
		});

		const summary = getItemVerdicts(db, getAllergenProfile(db, userId), [menuItemId]).get(
			menuItemId
		)!;
		expect(summary.worst?.verdict).toBe('flagged-may-contain');
		expect(summary.worst?.chipLabel).toBe('May contain Kiwi');
	});

	it('inherits the false-positive guards rather than having its own matcher', () => {
		// "KIWI-FREE" advertises the absence of the thing. A second, laxer matcher
		// for user terms would be a quiet source of false positives in the one
		// place a user cannot inspect.
		addCustom('Kiwi', ['kiwi']);
		const menuItemId = seedItem({ ingredients: 'SORBET (KIWI-FREE FORMULA), SUGAR.' });

		expect(
			getItemVerdicts(db, getAllergenProfile(db, userId), [menuItemId]).get(menuItemId)!.worst
				?.verdict
		).toBe('no-declared');
	});

	it('matches on a word boundary, not a substring', () => {
		addCustom('Yam', ['yam']);
		const menuItemId = seedItem({ ingredients: 'TERIYAKI SAUCE, RICE, SESAME.' });

		expect(
			getItemVerdicts(db, getAllergenProfile(db, userId), [menuItemId]).get(menuItemId)!.worst
				?.verdict
		).toBe('no-declared');
	});

	it('sits alongside the seeded allergens rather than replacing them', () => {
		const milk = db.prepare<{ id: number }>("SELECT id FROM allergen WHERE slug = 'milk'").get()!;
		db.prepare(
			'INSERT INTO user_allergen (user_id, allergen_id, severity, created_at) VALUES (?, ?, ?, ?)'
		).run(userId, milk.id, 'avoid', NOW);
		addCustom('Kiwi', ['kiwi']);

		const menuItemId = seedItem({ ingredients: 'WATER, KIWI PUREE.' });
		const summary = getItemVerdicts(db, getAllergenProfile(db, userId), [menuItemId]).get(
			menuItemId
		)!;

		expect(summary.verdicts).toHaveLength(2);
		expect(summary.verdicts.map((v) => v.allergen.label).sort()).toEqual(['Kiwi', 'Milk']);
	});

	it('costs nothing when the user has none', () => {
		const menuItemId = seedItem({ ingredients: 'WATER, KIWI PUREE.' });
		expect(getItemVerdicts(db, getAllergenProfile(db, userId), [menuItemId]).size).toBe(0);
	});
});
