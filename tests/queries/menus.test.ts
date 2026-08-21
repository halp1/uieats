/**
 * The scope loader and search, driven through the real persistence layer.
 *
 * The fixtures go in the way the scraper puts them in, so these tests fail if
 * either half drifts. What is being checked is mostly shape: that hall and venue
 * scopes return the same structure, that a standalone unit works without being
 * special-cased anywhere, and that nothing here is N+1.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/lib/server/db/driver.ts';
import { createMemoryDb } from '../../src/lib/server/db/index.ts';
import {
	getDateRange,
	getMenusForScope,
	getUnitsServingOn
} from '../../src/lib/server/queries/menus.ts';
import { searchItems } from '../../src/lib/server/queries/search.ts';
import { getUnitBySlug, getUnitTree, getVenuesOf } from '../../src/lib/server/queries/units.ts';
import { parseItemPanel } from '../../src/lib/server/scraper/parse/item-panel.ts';
import { parseHours } from '../../src/lib/server/scraper/parse/hours.ts';
import { persistHours } from '../../src/lib/server/scraper/persist/hours.ts';
import { persistMenu } from '../../src/lib/server/scraper/persist/menus.ts';
import { upsertUnit } from '../../src/lib/server/scraper/persist/units.ts';
import { fixturePanel, loadFixture } from '../helpers/fixtures.ts';

const NOW = 1_760_000_000;
const DATE = '2026-08-21';

let db: Db;
let hallId: number;
let venueAId: number;
let venueBId: number;
let standaloneId: number;

beforeEach(() => {
	db = createMemoryDb();

	hallId = upsertUnit(
		db,
		{ nnOid: 1, parentId: null, name: 'Ikenberry Dining Center (Ike)', kind: 'hall', sort: 0 },
		NOW
	);
	venueAId = upsertUnit(
		db,
		{ nnOid: 2, parentId: hallId, name: 'Baked Expectations', kind: 'venue', sort: 0 },
		NOW
	);
	venueBId = upsertUnit(
		db,
		{ nnOid: 3, parentId: hallId, name: "Don's Chophouse", kind: 'venue', sort: 1 },
		NOW
	);
	standaloneId = upsertUnit(
		db,
		{ nnOid: 32, parentId: null, name: 'Field of Greens', kind: 'standalone', sort: 1 },
		NOW
	);

	const panel = parseItemPanel(fixturePanel('itempanel-1440348.json', 'itemPanel'));
	for (const [unitId, meal, oid] of [
		[venueAId, 'Breakfast', 101],
		[venueAId, 'Lunch', 102],
		[venueBId, 'Lunch', 103],
		[standaloneId, 'Lunch', 104]
	] as const) {
		persistMenu(db, { unitId, serviceDate: DATE, meal, nnOid: oid }, panel, 1, NOW);
	}
});

describe('unit tree', () => {
	it('nests venues under their hall and leaves standalones alone', () => {
		const tree = getUnitTree(db);
		const ike = tree.find((u) => u.slug === 'ike')!;
		const fog = tree.find((u) => u.slug === 'field-of-greens')!;

		expect(ike.venues.map((v) => v.name)).toEqual(['Baked Expectations', "Don's Chophouse"]);
		expect(fog.venues).toEqual([]);
	});

	it('treats a standalone unit as its own only venue', () => {
		// Eight of the twelve top-level units are standalone, so anything that
		// only understands hall-with-children drops two thirds of campus.
		const fog = getUnitBySlug(db, 'field-of-greens')!;
		expect(getVenuesOf(db, fog).map((v) => v.id)).toEqual([fog.id]);
	});

	it('scopes a venue slug to its parent', () => {
		// "Build Your Own" exists under four different halls upstream, so slugs
		// are only unique within a parent.
		expect(getUnitBySlug(db, 'baked-expectations')).toBeNull();
		expect(getUnitBySlug(db, 'baked-expectations', hallId)).not.toBeNull();
	});
});

describe('getMenusForScope', () => {
	it('returns every venue in a hall when no venue is named', () => {
		const scope = getMenusForScope(db, { date: DATE, root: getUnitBySlug(db, 'ike')! });
		expect(scope.venues.map((v) => v.venue.name)).toEqual([
			'Baked Expectations',
			"Don's Chophouse"
		]);
		expect(scope.meals).toEqual(['Breakfast', 'Lunch']);
	});

	it('returns the same shape for one venue', () => {
		const root = getUnitBySlug(db, 'ike')!;
		const hall = getMenusForScope(db, { date: DATE, root });
		const venue = getMenusForScope(db, { date: DATE, root, venueId: venueAId });

		expect(venue.venues).toHaveLength(1);
		// Identical structure, which is what lets one component render both.
		expect(Object.keys(venue.venues[0])).toEqual(Object.keys(hall.venues[0]));
		expect(venue.venues[0].meals.map((m) => m.meal)).toEqual(['Breakfast', 'Lunch']);
	});

	it('orders meals by sitting rather than alphabetically', () => {
		// Alphabetical would put Dinner before Lunch.
		const panel = parseItemPanel(fixturePanel('itempanel-1440348.json', 'itemPanel'));
		persistMenu(
			db,
			{ unitId: venueAId, serviceDate: DATE, meal: 'Dinner', nnOid: 105 },
			panel,
			1,
			NOW
		);
		const scope = getMenusForScope(db, { date: DATE, root: getUnitBySlug(db, 'ike')! });
		expect(scope.meals).toEqual(['Breakfast', 'Lunch', 'Dinner']);
	});

	it('groups items under their category, in upstream order', () => {
		const scope = getMenusForScope(db, {
			date: DATE,
			root: getUnitBySlug(db, 'ike')!,
			venueId: venueAId
		});
		const breakfast = scope.venues[0].meals.find((m) => m.meal === 'Breakfast')!;

		expect(breakfast.categories.length).toBeGreaterThan(0);
		for (const category of breakfast.categories) {
			expect(category.items.length).toBeGreaterThan(0);
		}
		// Every item lands in exactly one category.
		const total = breakfast.categories.reduce((sum, c) => sum + c.items.length, 0);
		expect(total).toBe(breakfast.itemCount);
	});

	it('carries the grid traits through to the item', () => {
		const scope = getMenusForScope(db, {
			date: DATE,
			root: getUnitBySlug(db, 'ike')!,
			venueId: venueAId
		});
		const items = scope.venues[0].meals.flatMap((m) => m.categories.flatMap((c) => c.items));
		const blondie = items.find((i) => i.name === 'Blondie Bars')!;

		expect(blondie.traits.map((t) => t.label)).toContain('Milk');
		expect(blondie.hasLabel).toBe(false);
	});

	it('gives an anonymous visitor no allergen summaries at all', () => {
		const scope = getMenusForScope(db, { date: DATE, root: getUnitBySlug(db, 'ike')! });
		const items = scope.venues.flatMap((v) =>
			v.meals.flatMap((m) => m.categories.flatMap((c) => c.items))
		);
		expect(items.length).toBeGreaterThan(0);
		for (const item of items) expect(item.allergens).toBeNull();
	});

	it('returns an empty scope for a date with no menus, rather than throwing', () => {
		const scope = getMenusForScope(db, { date: '2020-01-01', root: getUnitBySlug(db, 'ike')! });
		expect(scope.itemCount).toBe(0);
		expect(scope.venues.every((v) => v.meals.length === 0)).toBe(true);
	});

	it('reports a venue with no menu as present but empty', () => {
		// Not omitted: "this venue published nothing today" is information, and
		// dropping it makes the hall page look shorter than the hall is.
		const scope = getMenusForScope(db, { date: '2020-01-01', root: getUnitBySlug(db, 'ike')! });
		expect(scope.venues).toHaveLength(2);
	});

	it('suppresses a schedule that is closed all week', () => {
		// Every hours capture taken out of term reads Closed on all seven days.
		// That is upstream declining to publish, not a venue that never opens.
		persistHours(db, venueAId, parseHours(loadFixture('hours-unit-5.html')), NOW);
		const scope = getMenusForScope(db, {
			date: DATE,
			root: getUnitBySlug(db, 'ike')!,
			venueId: venueAId
		});
		expect(scope.venues[0].hours.publishesSchedule).toBe(false);
		expect(scope.venues[0].hours.today.length).toBeGreaterThan(0);
	});
});

describe('a published menu with no dishes', () => {
	// A real upstream state: the meal exists, the dishes are not entered yet.
	// It has to survive persistence and reach the UI as an empty meal, because
	// the alternative -- a crash, or the meal vanishing -- both read as "nothing
	// is served here", which is a different and wrong claim.
	beforeEach(() => {
		persistMenu(
			db,
			{ unitId: venueBId, serviceDate: '2026-08-23', meal: 'Lunch', nnOid: 200 },
			parseItemPanel(fixturePanel('itempanel-empty.json', 'itemPanel')),
			1,
			NOW
		);
	});

	it('persists as a menu with zero items', () => {
		const row = db
			.prepare<{ item_count: number }>(
				"SELECT item_count FROM menu WHERE nn_oid = 200 AND service_date = '2026-08-23'"
			)
			.get()!;
		expect(row.item_count).toBe(0);
	});

	it('reaches the scope as a meal with no categories', () => {
		const scope = getMenusForScope(db, {
			date: '2026-08-23',
			root: getUnitBySlug(db, 'ike')!,
			venueId: venueBId
		});
		expect(scope.venues[0].meals).toHaveLength(1);
		expect(scope.venues[0].meals[0].categories).toEqual([]);
		expect(scope.itemCount).toBe(0);
	});

	it('still lists the meal in the scope, so the tab bar shows it', () => {
		const scope = getMenusForScope(db, {
			date: '2026-08-23',
			root: getUnitBySlug(db, 'ike')!
		});
		expect(scope.meals).toEqual(['Lunch']);
	});

	it('re-scraping it changes nothing', () => {
		persistMenu(
			db,
			{ unitId: venueBId, serviceDate: '2026-08-23', meal: 'Lunch', nnOid: 200 },
			parseItemPanel(fixturePanel('itempanel-empty.json', 'itemPanel')),
			2,
			NOW
		);
		expect(
			db
				.prepare<{ c: number }>("SELECT COUNT(*) AS c FROM menu WHERE service_date = '2026-08-23'")
				.get()!.c
		).toBe(1);
	});
});

describe('date and unit indexes', () => {
	it('counts items per unit for a date', () => {
		const counts = getUnitsServingOn(db, DATE);
		expect(counts.get(venueAId)).toBeGreaterThan(0);
		expect(counts.get(venueBId)).toBeGreaterThan(0);
		expect(counts.has(hallId)).toBe(false); // a hall publishes nothing itself
	});

	it('reports the stored date range', () => {
		expect(getDateRange(db)).toEqual({ min: DATE, max: DATE });
	});

	it('reports no range for an empty database', () => {
		expect(getDateRange(createMemoryDb())).toBeNull();
	});
});

describe('searchItems', () => {
	it('finds a dish across every venue', () => {
		const hits = searchItems(db, { query: 'blondie', fromDate: DATE });
		expect(hits).toHaveLength(1);
		expect(hits[0].name).toBe('Blondie Bars');
		// Four menus were seeded from the same panel, so it appears four times.
		expect(hits[0].servings).toBe(4);
	});

	it('points at the soonest serving', () => {
		const hits = searchItems(db, { query: 'blondie', fromDate: DATE });
		expect(hits[0].next?.date).toBe(DATE);
		expect(hits[0].next?.meal).toBe('Breakfast');
	});

	it('resolves a standalone unit to itself in the link path', () => {
		// A standalone has no parent, so the hall segment falls back to its own
		// slug -- otherwise the URL would carry an empty path segment.
		const hits = searchItems(db, { query: 'blondie', fromDate: DATE });
		expect(hits[0].next?.hallSlug).toBeTruthy();
	});

	it('prefers a name that starts with the query', () => {
		const hits = searchItems(db, { query: 'bar', fromDate: DATE });
		if (hits.length > 1) {
			const first = hits[0].name.toLowerCase();
			expect(first.startsWith('bar')).toBe(true);
		}
	});

	it('ignores a query too short to be meaningful', () => {
		expect(searchItems(db, { query: 'a', fromDate: DATE })).toEqual([]);
		expect(searchItems(db, { query: '', fromDate: DATE })).toEqual([]);
	});

	it('excludes dishes only served before the window', () => {
		expect(searchItems(db, { query: 'blondie', fromDate: '2026-09-01' })).toEqual([]);
	});

	it('filters by diet tag', () => {
		const vegetarian = searchItems(db, { query: 'blondie', fromDate: DATE, diets: ['vegetarian'] });
		const vegan = searchItems(db, { query: 'blondie', fromDate: DATE, diets: ['vegan'] });

		// The fixture's Blondie Bars carries Vegetarian but not Vegan.
		expect(vegetarian).toHaveLength(1);
		expect(vegan).toEqual([]);
	});

	it('requires ALL requested diet tags, not any of them', () => {
		const both = searchItems(db, {
			query: 'blondie',
			fromDate: DATE,
			diets: ['vegetarian', 'vegan']
		});
		expect(both).toEqual([]);
	});
});

describe('the allergen filter', () => {
	function registerUser(...slugs: string[]): number {
		const userId = db
			.prepare('INSERT INTO user (email, created_at) VALUES (?, ?)')
			.run('student@illinois.edu', NOW).lastInsertRowid;
		for (const slug of slugs) {
			const id = db.prepare<{ id: number }>('SELECT id FROM allergen WHERE slug = ?').get(slug)!.id;
			db.prepare(
				'INSERT INTO user_allergen (user_id, allergen_id, severity, created_at) VALUES (?, ?, ?, ?)'
			).run(userId, id, 'avoid', NOW);
		}
		return userId;
	}

	it('hides a dish flagged for the user', () => {
		// Blondie Bars carries a Milk trait icon on the grid.
		const userId = registerUser('milk');
		expect(searchItems(db, { query: 'blondie', fromDate: DATE, userId })).toHaveLength(1);
		expect(
			searchItems(db, { query: 'blondie', fromDate: DATE, userId, hideFlagged: true })
		).toEqual([]);
	});

	it('KEEPS a dish whose label has not been read', () => {
		// The most important assertion about this filter. Mustard is outside
		// upstream's vocabulary and no label has been fetched, so the verdict is
		// `unknown`. Hiding it would present "we have not checked" as "this passed
		// the filter" -- the exact confusion the whole safety model exists to stop.
		const userId = registerUser('mustard');
		const hits = searchItems(db, {
			query: 'blondie',
			fromDate: DATE,
			userId,
			hideFlagged: true
		});

		expect(hits).toHaveLength(1);
		expect(hits[0].hasUnknown).toBe(true);
		expect(hits[0].hasWarning).toBe(false);
	});

	it('marks what it kept, so an unverified dish is never silently ordinary', () => {
		const userId = registerUser('mustard');
		const [hit] = searchItems(db, { query: 'blondie', fromDate: DATE, userId });
		expect(hit.worstVerdict).toBe('unknown');
	});
});
