/**
 * The planner's loader against a real migrated schema: which menus count as a
 * sitting, what the filters hold back, and the body-profile round trip.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/lib/server/db/driver.ts';
import { createMemoryDb } from '../../src/lib/server/db/index.ts';
import { getAllergenProfile } from '../../src/lib/server/queries/allergens.ts';
import {
	deleteBodyProfile,
	getBodyProfile,
	getPlannerMenu,
	saveBodyProfile
} from '../../src/lib/server/queries/planner.ts';
import { getUnitBySlug } from '../../src/lib/server/queries/units.ts';
import { upsertUnit } from '../../src/lib/server/scraper/persist/units.ts';
import type { BodyProfile } from '../../src/lib/planner/targets.ts';

const NOW = 1_760_000_000;
const DATE = '2026-10-15';

let db: Db;
let userId: number;
let seq = 0;

function addMenu(unitId: number, meal: string, mealSort: number): number {
	return db
		.prepare(
			`INSERT INTO menu (unit_id, service_date, meal, meal_sort, nn_oid, first_seen_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
		.run(unitId, DATE, meal, mealSort, ++seq, NOW).lastInsertRowid;
}

function addDish(
	menuId: number,
	category: string,
	name: string,
	calories: number | null,
	traits: string[] = []
): number {
	const categoryId = db
		.prepare(
			`INSERT INTO menu_category (menu_id, nn_category_id, name, sort, scrape_run_id)
			 VALUES (?, ?, ?, 0, 1)`
		)
		.run(menuId, ++seq, category).lastInsertRowid;
	const itemId = db
		.prepare('INSERT INTO item (name_norm, name_display, slug, first_seen_at) VALUES (?, ?, ?, ?)')
		.run(name.toLowerCase(), name, `dish-${++seq}`, NOW).lastInsertRowid;
	const factId = db
		.prepare(
			`INSERT INTO nutrition_fact (content_hash, serving_size_text, serving_grams, calories,
			   protein_g, total_carb_g, total_fat_g, first_seen_at)
			 VALUES (?, '1 Cup (200g)', 200, ?, 20, 20, 5, ?)`
		)
		.run(`h${++seq}`, calories, NOW).lastInsertRowid;
	const menuItemId = db
		.prepare(
			`INSERT INTO menu_item (menu_id, category_id, item_id, nn_detail_oid, serving_size, sort,
			   nutrition_fact_id, label_fetched_at, scrape_run_id)
			 VALUES (?, ?, ?, ?, '1 Cup', 0, ?, ?, 1)`
		)
		.run(menuId, categoryId, itemId, ++seq, factId, NOW).lastInsertRowid;
	for (const slug of traits) {
		db.prepare(
			'INSERT INTO menu_item_trait (menu_item_id, trait_id) SELECT ?, id FROM trait WHERE slug = ?'
		).run(menuItemId, slug);
	}
	return menuItemId;
}

beforeEach(() => {
	db = createMemoryDb();
	seq = 0;
	userId = db
		.prepare('INSERT INTO user (email, created_at) VALUES (?, ?)')
		.run('student@illinois.edu', NOW).lastInsertRowid;

	const hall = upsertUnit(
		db,
		{ nnOid: 1, parentId: null, name: 'Ikenberry Dining Center (Ike)', kind: 'hall', sort: 0 },
		NOW
	);
	const diner = upsertUnit(
		db,
		{ nnOid: 2, parentId: hall, name: 'Gregory Drive Diner', kind: 'venue', sort: 0 },
		NOW
	);
	const byo = upsertUnit(
		db,
		{ nnOid: 3, parentId: hall, name: 'Build Your Own', kind: 'venue', sort: 1 },
		NOW
	);

	const lunch = addMenu(diner, 'Lunch', 30);
	const dinner = addMenu(diner, 'Dinner', 40);
	const salad = addMenu(byo, 'Salad Bar', 99);
	const iceCream = addMenu(byo, 'Ice Cream', 99);

	addDish(lunch, 'Entrees', 'Grilled Chicken', 200);
	addDish(lunch, 'Entrees', 'Cheese Pizza', 280, ['milk', 'wheat', 'vegetarian']);
	addDish(dinner, 'Entrees', 'Baked Salmon', 250);
	addDish(salad, 'Vegetables', 'Lettuce', 10, ['vegan', 'vegetarian']);
	addDish(iceCream, 'Desserts', 'Soft Serve', 110, ['milk', 'vegetarian']);
	addDish(lunch, 'Entrees', 'Unlabelled Thing', null);
	// No label at all: the inner join must drop it.
	db.prepare(
		`INSERT INTO menu_item (menu_id, category_id, item_id, nn_detail_oid, sort, scrape_run_id)
		 SELECT ?, category_id, item_id, 999999, 0, 1 FROM menu_item LIMIT 1`
	).run(lunch);
});

const names = (m: ReturnType<typeof getPlannerMenu>) => m.candidates.map((c) => c.name).sort();

describe('getPlannerMenu', () => {
	const load = (extra: Partial<Parameters<typeof getPlannerMenu>[1]> = {}) =>
		getPlannerMenu(db, {
			date: DATE,
			root: getUnitBySlug(db, 'ike')!,
			meal: 'Lunch',
			profile: getAllergenProfile(db, null),
			...extra
		});

	it('folds the all-day stations into a sitting, and leaves other sittings out', () => {
		const menu = load();
		expect(menu.sittings).toEqual(['Lunch', 'Dinner']);
		expect(menu.stations).toEqual(['Ice Cream', 'Salad Bar']);
		expect(names(menu)).toEqual([
			'Cheese Pizza',
			'Grilled Chicken',
			'Lettuce',
			'Soft Serve',
			'Unlabelled Thing'
		]);
		expect(menu.candidates.find((c) => c.name === 'Unlabelled Thing')!.nutrients).toBeNull();
	});

	it('defaults to a sitting that is served', () => {
		expect(load({ meal: 'Brunch', defaultMeal: (s) => s[1] }).meal).toBe('Dinner');
	});

	it('skips the salad bar on request', () => {
		const menu = load({ skipSaladBar: true });
		expect(names(menu)).not.toContain('Lettuce');
		expect(menu.saladBarHeld).toBe(1);
	});

	it('applies diet tags', () => {
		const menu = load({ diets: ['vegetarian'] });
		expect(names(menu)).toEqual(['Cheese Pizza', 'Lettuce', 'Soft Serve']);
	});

	it("holds back anything flagged for the user's allergens", () => {
		db.prepare(
			`INSERT INTO user_allergen (user_id, allergen_id, created_at)
			 SELECT ?, id, ? FROM allergen WHERE slug = 'milk'`
		).run(userId, NOW);
		const menu = load({ profile: getAllergenProfile(db, userId) });
		expect(names(menu)).not.toContain('Cheese Pizza');
		expect(names(menu)).not.toContain('Soft Serve');
		expect(menu.allergenHeld).toBeGreaterThanOrEqual(2);
	});
});

describe('body profile', () => {
	const profile: BodyProfile = {
		sex: 'female',
		age: 19,
		heightCm: 165.1,
		weightKg: 60.3,
		activity: 'light',
		goal: 'muscle',
		mealsPerDay: 4,
		units: 'metric',
		caloriesOverride: null,
		proteinOverride: 120
	};

	it('round-trips, updates in place, and deletes', () => {
		expect(getBodyProfile(db, userId)).toBeNull();
		saveBodyProfile(db, userId, profile, NOW);
		expect(getBodyProfile(db, userId)).toEqual(profile);

		saveBodyProfile(db, userId, { ...profile, weightKg: 62 }, NOW + 1);
		expect(getBodyProfile(db, userId)!.weightKg).toBe(62);

		deleteBodyProfile(db, userId);
		expect(getBodyProfile(db, userId)).toBeNull();
	});
});
