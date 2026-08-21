/**
 * Nothing on a menu may disappear.
 *
 * Both bugs these tests pin were found by comparing the app against the live
 * site, not by reading code, and both lost food off a menu silently:
 *
 *   1. Upstream marks a course with no name using the sentinel id -1234. The
 *      oid regex could not read a negative number, so the heading never
 *      arrived, and persistence dropped every dish underneath.
 *   2. One menu can list the same dish name twice, same course, same serving
 *      size, as two different products with DIFFERENT ALLERGENS. The old
 *      menu_item key collapsed them and kept whichever came last in the markup.
 *
 * The second is the one that matters most: in an 82-menu audit every single
 * collision lost a real allergen difference, and the survivor was arbitrary.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/lib/server/db/driver.ts';
import { createMemoryDb } from '../../src/lib/server/db/index.ts';
import {
	parseItemPanel,
	type ParsedItemPanel
} from '../../src/lib/server/scraper/parse/item-panel.ts';
import { persistMenu } from '../../src/lib/server/scraper/persist/menus.ts';
import { upsertUnit } from '../../src/lib/server/scraper/persist/units.ts';
import { fixturePanel } from '../helpers/fixtures.ts';

const NOW = 1_760_000_000;
const DATE = '2026-08-21';

let db: Db;
let unitId: number;

beforeEach(() => {
	db = createMemoryDb();
	unitId = upsertUnit(
		db,
		{ nnOid: 18, parentId: null, name: 'Saporito Pizza', kind: 'standalone', sort: 0 },
		NOW
	);
});

function persist(panel: ParsedItemPanel, runId = 1) {
	return persistMenu(
		db,
		{ unitId, serviceDate: DATE, meal: 'Lunch', nnOid: 1440624 },
		panel,
		runId,
		NOW
	);
}

function storedNames(): string[] {
	return db
		.prepare<{ name_display: string }>(
			`SELECT i.name_display FROM menu_item mi JOIN item i ON i.id = mi.item_id
			 ORDER BY mi.sort`
		)
		.all()
		.map((r) => r.name_display);
}

describe('a course upstream gave no name', () => {
	const panel = parseItemPanel(fixturePanel('itempanel-nocategory.json', 'itemPanel'));

	it('stores every dish the panel parsed', () => {
		// The strongest form of this assertion: not "stores the two we know about"
		// but "loses nothing at all".
		const result = persist(panel);
		expect(result.itemsUpserted).toBe(panel.items.length);
		expect(storedNames()).toHaveLength(panel.items.length);
	});

	it('keeps the dishes that used to vanish', () => {
		persist(panel);
		expect(storedNames()).toContain('Cocktail Sauce');
		expect(storedNames()).toContain('Fried Popcorn Shrimp');
	});

	it('records the course, so the item has somewhere to hang', () => {
		persist(panel);
		const row = db
			.prepare<{ name: string }>('SELECT name FROM menu_category WHERE nn_category_id = -1234')
			.get();
		expect(row?.name).toBe('None');
	});

	it('re-scraping changes nothing', () => {
		const first = persist(panel, 1);
		const second = persist(panel, 2);
		expect(second.itemsUpserted).toBe(first.itemsUpserted);
		expect(second.itemsRemoved).toBe(0);
		expect(storedNames()).toHaveLength(panel.items.length);
	});
});

describe('a dish listed twice with different allergens', () => {
	/**
	 * Modelled on a real observed pair, from Build Your Own's Deli & Bagel Bar:
	 *
	 *   Ketchup  Tablespoon  oid 122224598  [Corn, Local, Vegan, Vegetarian]
	 *   Ketchup  Tablespoon  oid 122235987  [Kosher, Vegan, Vegetarian]
	 *
	 * Two different products under one name. Note the direction of the old bug:
	 * the survivor was the LAST in markup -- the one that does NOT declare corn.
	 * Someone avoiding corn was told "no Corn declared" for a serving line
	 * carrying a corn-containing ketchup.
	 */
	const twoKetchups: ParsedItemPanel = {
		header: { hall: null, venue: 'Build Your Own', serviceDate: DATE, meal: 'Lunch' },
		categories: [{ nnCategoryId: 7, name: 'Dressings & Condiments', sort: 0 }],
		items: [
			{
				detailOid: 122224598,
				name: 'Ketchup',
				servingSize: 'Tablespoon',
				traits: ['Corn', 'Local', 'Vegan', 'Vegetarian'],
				nnCategoryId: 7,
				sort: 0
			},
			{
				detailOid: 122235987,
				name: 'Ketchup',
				servingSize: 'Tablespoon',
				traits: ['Kosher', 'Vegan', 'Vegetarian'],
				nnCategoryId: 7,
				sort: 1
			}
		]
	};

	it('stores both, rather than one overwriting the other', () => {
		const result = persist(twoKetchups);
		expect(result.itemsUpserted).toBe(2);
		expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM menu_item').get()!.c).toBe(2);
	});

	it('gives each one its own detail oid', () => {
		persist(twoKetchups);
		const oids = db
			.prepare<{ nn_detail_oid: number }>(
				'SELECT nn_detail_oid FROM menu_item ORDER BY nn_detail_oid'
			)
			.all()
			.map((r) => r.nn_detail_oid);
		expect(oids).toEqual([122224598, 122235987]);
	});

	it('keeps them pointing at one canonical dish', () => {
		// They are the same DISH by name -- `item` is the dish registry -- and two
		// distinct instances of it. Splitting the item too would fork the name.
		persist(twoKetchups);
		expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM item').get()!.c).toBe(1);
	});

	it("keeps each one's own declared allergens", () => {
		// The whole point. Corn is declared on exactly one of the two, and that
		// fact has to survive.
		persist(twoKetchups);
		const rows = db
			.prepare<{ nn_detail_oid: number; traits: string }>(
				`SELECT mi.nn_detail_oid, GROUP_CONCAT(t.label) AS traits
				 FROM menu_item mi
				 JOIN menu_item_trait mit ON mit.menu_item_id = mi.id
				 JOIN trait t ON t.id = mit.trait_id
				 GROUP BY mi.id ORDER BY mi.nn_detail_oid`
			)
			.all();

		const byOid = new Map(rows.map((r) => [r.nn_detail_oid, r.traits.split(',')]));
		expect(byOid.get(122224598)).toContain('Corn');
		expect(byOid.get(122235987)).not.toContain('Corn');
		expect(byOid.get(122235987)).toContain('Kosher');
	});

	it('re-scraping is still idempotent', () => {
		persist(twoKetchups, 1);
		const second = persist(twoKetchups, 2);
		expect(second.itemsRemoved).toBe(0);
		expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM menu_item').get()!.c).toBe(2);
	});

	it('follows an instance that moves course, rather than orphaning it', () => {
		persist(twoKetchups, 1);
		const moved: ParsedItemPanel = {
			...twoKetchups,
			categories: [{ nnCategoryId: 9, name: 'Sauces', sort: 0 }],
			items: twoKetchups.items.map((i) => ({ ...i, nnCategoryId: 9 }))
		};
		const result = persist(moved, 2);

		expect(result.itemsUpserted).toBe(2);
		expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM menu_item').get()!.c).toBe(2);
		expect(
			db
				.prepare<{ name: string }>(
					`SELECT mc.name FROM menu_item mi JOIN menu_category mc ON mc.id = mi.category_id LIMIT 1`
				)
				.get()!.name
		).toBe('Sauces');
	});

	it('drops an instance that upstream stops listing', () => {
		persist(twoKetchups, 1);
		const onlyOne: ParsedItemPanel = { ...twoKetchups, items: [twoKetchups.items[0]] };
		const result = persist(onlyOne, 2);

		expect(result.itemsRemoved).toBe(1);
		const oids = db
			.prepare<{ nn_detail_oid: number }>('SELECT nn_detail_oid FROM menu_item')
			.all()
			.map((r) => r.nn_detail_oid);
		expect(oids).toEqual([122224598]);
	});
});
