import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDb } from '../../src/lib/server/db/index.ts';
import type { Db } from '../../src/lib/server/db/driver.ts';
import { persistMenu } from '../../src/lib/server/scraper/persist/menus.ts';
import { upsertUnit } from '../../src/lib/server/scraper/persist/units.ts';
import { parseItemPanel } from '../../src/lib/server/scraper/parse/item-panel.ts';
import type { ParsedItemPanel } from '../../src/lib/server/scraper/parse/item-panel.ts';
import { fixturePanel } from '../helpers/fixtures.ts';
import { snapshotDb } from '../helpers/snapshot-db.ts';

const IDENTITY_BASE = { serviceDate: '2026-08-18', meal: 'Lunch', nnOid: 1440348 };

function seedUnit(db: Db): number {
	const hall = upsertUnit(
		db,
		{ nnOid: 1, parentId: null, name: 'Ikenberry', kind: 'hall', sort: 0 },
		1000
	);
	return upsertUnit(
		db,
		{ nnOid: 2, parentId: hall, name: 'Baked Expectations', kind: 'venue', sort: 0 },
		1000
	);
}

function newRun(db: Db, at: number): number {
	return db
		.prepare("INSERT INTO scrape_run (kind, started_at, status) VALUES ('full', ?, 'running')")
		.run(at).lastInsertRowid;
}

let db: Db;
let unitId: number;
let panel: ParsedItemPanel;

beforeEach(() => {
	db = createMemoryDb();
	unitId = seedUnit(db);
	panel = parseItemPanel(fixturePanel('itempanel-1440348.json', 'itemPanel'));
});

describe('persistMenu idempotency', () => {
	it('produces identical rows when the same menu is scraped twice', () => {
		persistMenu(db, { unitId, ...IDENTITY_BASE }, panel, newRun(db, 1000), 1000);
		const first = snapshotDb(db);

		// Different run id and a later clock: neither may change the data.
		persistMenu(db, { unitId, ...IDENTITY_BASE }, panel, newRun(db, 2000), 2000);
		const second = snapshotDb(db);

		expect(second).toEqual(first);
	});

	it('does not accumulate duplicate rows across many runs', () => {
		for (let i = 0; i < 5; i++) {
			persistMenu(db, { unitId, ...IDENTITY_BASE }, panel, newRun(db, 1000 + i), 1000 + i);
		}

		const count = (t: string) =>
			Object.values(db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number })[0];
		expect(count('menu')).toBe(1);
		expect(count('menu_category')).toBe(panel.categories.length);
		expect(count('menu_item')).toBe(panel.items.length);
	});

	it('removes a dish that disappeared upstream, and nothing else', () => {
		persistMenu(db, { unitId, ...IDENTITY_BASE }, panel, newRun(db, 1000), 1000);
		const before = snapshotDb(db);

		const dropped = panel.items[0];
		const shorter: ParsedItemPanel = {
			...panel,
			items: panel.items.filter((i) => i.detailOid !== dropped.detailOid)
		};
		const result = persistMenu(db, { unitId, ...IDENTITY_BASE }, shorter, newRun(db, 2000), 2000);

		expect(result.itemsRemoved).toBe(1);

		const after = snapshotDb(db);
		expect(after.menu_item).toHaveLength(before.menu_item.length - 1);
		// The dish stays in the canonical registry -- it exists, it is just not
		// on this menu today.
		expect(after.item).toEqual(before.item);
		expect(after.menu_category).toEqual(before.menu_category);
	});

	it('brings a dish back when it reappears', () => {
		// Compared without surrogate ids: the row is genuinely deleted and
		// re-created, so its autoincrement key changes. Nothing outside the
		// cascade references menu_item.id, so only the content has to match.
		persistMenu(db, { unitId, ...IDENTITY_BASE }, panel, newRun(db, 1000), 1000);
		const original = snapshotDb(db, { ignoreIds: true });

		const shorter: ParsedItemPanel = { ...panel, items: panel.items.slice(1) };
		persistMenu(db, { unitId, ...IDENTITY_BASE }, shorter, newRun(db, 2000), 2000);
		persistMenu(db, { unitId, ...IDENTITY_BASE }, panel, newRun(db, 3000), 3000);

		expect(snapshotDb(db, { ignoreIds: true })).toEqual(original);
		// And the row count really did return to full strength.
		expect(db.prepare('SELECT COUNT(*) AS c FROM menu_item').get()).toMatchObject({
			c: panel.items.length
		});
	});

	it('follows a republished menu to its new oid instead of duplicating it', () => {
		// Menu identity is (unit, date, meal); the oid is a mutable handle.
		persistMenu(db, { unitId, ...IDENTITY_BASE }, panel, newRun(db, 1000), 1000);
		persistMenu(db, { unitId, ...IDENTITY_BASE, nnOid: 9999999 }, panel, newRun(db, 2000), 2000);

		const menus = db.prepare<{ id: number; nn_oid: number }>('SELECT id, nn_oid FROM menu').all();
		expect(menus).toHaveLength(1);
		expect(menus[0].nn_oid).toBe(9999999);
	});

	it('keeps a fetched nutrition label across a re-scrape', () => {
		// The backfill queue is `label_fetched_at IS NULL`. If re-scraping a menu
		// cleared that, the nightly run would re-fetch every label forever.
		persistMenu(db, { unitId, ...IDENTITY_BASE }, panel, newRun(db, 1000), 1000);

		const factId = db
			.prepare(
				"INSERT INTO nutrition_fact (content_hash, calories, first_seen_at) VALUES ('deadbeef', 180, 1000)"
			)
			.run().lastInsertRowid;
		db.prepare('UPDATE menu_item SET nutrition_fact_id = ?, label_fetched_at = ?').run(
			factId,
			1500
		);

		persistMenu(db, { unitId, ...IDENTITY_BASE }, panel, newRun(db, 2000), 2000);

		const rows = db
			.prepare<{ nutrition_fact_id: number | null; label_fetched_at: number | null }>(
				'SELECT nutrition_fact_id, label_fetched_at FROM menu_item'
			)
			.all();
		expect(rows.length).toBeGreaterThan(0);
		for (const r of rows) {
			expect(r.nutrition_fact_id).toBe(factId);
			expect(r.label_fetched_at).toBe(1500);
		}
	});

	it('keeps two meals on the same day apart', () => {
		persistMenu(db, { unitId, ...IDENTITY_BASE }, panel, newRun(db, 1000), 1000);
		persistMenu(
			db,
			{ unitId, serviceDate: '2026-08-18', meal: 'Dinner', nnOid: 1440349 },
			panel,
			newRun(db, 1000),
			1000
		);

		expect(db.prepare('SELECT COUNT(*) AS c FROM menu').get()).toMatchObject({ c: 2 });
	});

	it('records traits for every item that declares them', () => {
		persistMenu(db, { unitId, ...IDENTITY_BASE }, panel, newRun(db, 1000), 1000);

		const traits = db
			.prepare<{ label: string }>(
				`SELECT t.label FROM menu_item_trait mit
				 JOIN trait t ON t.id = mit.trait_id
				 JOIN menu_item mi ON mi.id = mit.menu_item_id
				 JOIN item i ON i.id = mi.item_id
				 WHERE i.name_display = 'Blondie Bars'
				 ORDER BY t.label`
			)
			.all()
			.map((r) => r.label);

		expect(traits).toEqual(['Corn', 'Eggs', 'Gluten', 'Milk', 'Soy', 'Vegetarian', 'Wheat']);
	});

	it('rolls the whole menu back if persistence fails partway', () => {
		const broken: ParsedItemPanel = {
			...panel,
			items: panel.items.map((i, idx) =>
				// A NULL name violates NOT NULL on item.name_display.
				idx === 1 ? { ...i, name: null as unknown as string } : i
			)
		};

		expect(() =>
			persistMenu(db, { unitId, ...IDENTITY_BASE }, broken, newRun(db, 1000), 1000)
		).toThrow();
		// Nothing half-written: no menu at all, rather than a menu missing dishes.
		expect(db.prepare('SELECT COUNT(*) AS c FROM menu').get()).toMatchObject({ c: 0 });
		expect(db.prepare('SELECT COUNT(*) AS c FROM menu_item').get()).toMatchObject({ c: 0 });
	});
});
