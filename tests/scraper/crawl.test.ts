import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDb } from '../../src/lib/server/db/index.ts';
import type { Db } from '../../src/lib/server/db/driver.ts';
import { runScrape } from '../../src/lib/server/scraper/crawl/run.ts';
import type { ScraperConfig } from '../../src/lib/server/scraper/config.ts';
import { FakeTransport } from './fake-transport.ts';
import { snapshotDb } from '../helpers/snapshot-db.ts';

const CONFIG: ScraperConfig = {
	baseUrl: 'https://example.test/NetNutrition/46',
	userAgent: 'uieats-test/0.1',
	daysBehind: 1,
	daysAhead: 21,
	concurrency: 3,
	minIntervalMs: 0,
	timeoutMs: 5000,
	maxAttempts: 1,
	recipeMode: 'full',
	dryRun: false,
	maxRequests: undefined
};

// The fixtures cover Ikenberry (a hall) and Field of Greens (standalone).
const ROUTES = {
	'Unit/SelectUnitFromUnitsList?unitOid=1': 'select-unit-1.hall.json',
	'Unit/SelectUnitFromUnitsList?unitOid=32': 'select-unit-32.standalone.json',
	'Unit/SelectUnitFromChildUnitsList': 'select-childunit-2.menulist.json',
	'Menu/SelecUnitAndtMenu': 'itempanel-1440348.json',
	'NutritionDetail/ShowItemNutritionLabel': 'label-122098028.html'
};

// The fixtures were captured on 2026-08-20, so "today" is pinned to keep the
// date window over real data instead of drifting out of range as time passes.
const TODAY = '2026-08-20';
let clock = 1_000_000;
const now = () => clock++;

let db: Db;
beforeEach(() => {
	db = createMemoryDb();
	clock = 1_000_000;
});

describe('runScrape unit discovery', () => {
	it('classifies a hall by its childUnitsPanel and records its venues', async () => {
		const transport = new FakeTransport({ routes: ROUTES });
		await runScrape(db, transport, CONFIG, {
			onlyUnits: [1],
			today: TODAY,
			now,
			skipLabels: true
		});

		const hall = db.prepare<{ kind: string }>('SELECT kind FROM unit WHERE nn_oid = 1').get();
		expect(hall?.kind).toBe('hall');

		const venues = db
			.prepare<{ c: number }>("SELECT COUNT(*) AS c FROM unit WHERE kind = 'venue'")
			.get();
		expect(venues?.c).toBe(9);
	});

	it('classifies a childless unit as standalone and skips the redundant call', async () => {
		// This is the branch 8 of 12 top-level units take. A crawler that assumed
		// every unit is a hall would drop all of them silently.
		const transport = new FakeTransport({ routes: ROUTES });
		await runScrape(db, transport, CONFIG, {
			onlyUnits: [32],
			today: TODAY,
			now,
			skipLabels: true
		});

		const unit = db.prepare<{ kind: string }>('SELECT kind FROM unit WHERE nn_oid = 32').get();
		expect(unit?.kind).toBe('standalone');

		// Its menu list came back with the unit probe, so no child-list call.
		expect(transport.calls.some((c) => c.action === 'SelectUnitFromChildUnitsList')).toBe(false);
	});

	it('records the open/closed badge as an observation', async () => {
		const transport = new FakeTransport({ routes: ROUTES });
		await runScrape(db, transport, CONFIG, { onlyUnits: [1], today: TODAY, now, skipLabels: true });

		const statuses = db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM unit_status').get();
		expect(statuses?.c).toBe(9);
	});
});

describe('runScrape menu window', () => {
	it('keeps only menus inside the configured date window', async () => {
		const transport = new FakeTransport({ routes: ROUTES });
		await runScrape(db, transport, CONFIG, {
			onlyUnits: [1],
			today: TODAY,
			daysAhead: 2,
			now,
			skipLabels: true
		});

		const dates = db
			.prepare<{ service_date: string }>('SELECT DISTINCT service_date FROM menu ORDER BY 1')
			.all()
			.map((r) => r.service_date);

		expect(dates.length).toBeGreaterThan(0);
		for (const d of dates) {
			expect(d >= '2026-08-19').toBe(true);
			expect(d <= '2026-08-22').toBe(true);
		}
	});

	it('fetches a shared menu once but keeps it on every venue that serves it', async () => {
		// "Build Your Own" is published under four halls with identical menu
		// oids. Fetching it per venue wastes ~588 requests; deduping the
		// PERSISTENCE instead would make it vanish from three of its four halls.
		// So: fetch once, store per venue.
		const transport = new FakeTransport({ routes: ROUTES });
		await runScrape(db, transport, CONFIG, {
			onlyUnits: [1],
			today: TODAY,
			daysAhead: 1,
			now,
			skipLabels: true
		});

		// All nine fixture venues return the same menu list, so each menu oid is
		// fetched exactly once...
		const fetched = transport.calls.filter((c) => c.action === 'SelecUnitAndtMenu');
		const distinctOids = new Set(fetched.map((c) => c.body.menuOid));
		expect(fetched).toHaveLength(distinctOids.size);

		// ...but every venue still has its own menu rows.
		const venuesWithMenus = db
			.prepare<{ c: number }>('SELECT COUNT(DISTINCT unit_id) AS c FROM menu')
			.get();
		expect(venuesWithMenus?.c).toBe(9);
	});
});

describe('runScrape resilience', () => {
	it('records an error and keeps going when one call fails', async () => {
		const transport = new FakeTransport({ routes: ROUTES, failCalls: [2] });
		const summary = await runScrape(db, transport, CONFIG, {
			onlyUnits: [1],
			today: TODAY,
			daysAhead: 1,
			now,
			skipLabels: true
		});

		expect(summary.errorCount).toBeGreaterThan(0);
		expect(summary.status).toBe('partial');
		expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM scrape_error').get()?.c).toBe(
			summary.errorCount
		);
		// Work after the failure still happened.
		expect(summary.menusScraped).toBeGreaterThan(0);
	});

	it('writes a scrape_run row summarising what happened', async () => {
		const transport = new FakeTransport({ routes: ROUTES });
		const summary = await runScrape(db, transport, CONFIG, {
			onlyUnits: [1],
			today: TODAY,
			daysAhead: 1,
			now,
			skipLabels: true
		});

		const row = db
			.prepare<{ status: string; menus_scraped: number; finished_at: number }>(
				'SELECT status, menus_scraped, finished_at FROM scrape_run WHERE id = ?'
			)
			.get(summary.runId);

		expect(row?.status).toBe('ok');
		expect(row?.menus_scraped).toBe(summary.menusScraped);
		expect(row?.finished_at).toBeGreaterThan(0);
	});
});

describe('runScrape nutrition backfill', () => {
	it('fetches labels and links them to their menu items', async () => {
		const transport = new FakeTransport({ routes: ROUTES });
		const summary = await runScrape(db, transport, CONFIG, {
			onlyUnits: [1],
			today: TODAY,
			daysAhead: 1,
			now
		});

		expect(summary.labelsFetched).toBeGreaterThan(0);
		const linked = db
			.prepare<{ c: number }>(
				'SELECT COUNT(*) AS c FROM menu_item WHERE nutrition_fact_id IS NOT NULL'
			)
			.get();
		expect(linked?.c).toBe(summary.labelsFetched);
	});

	it('collapses identical labels onto one content-addressed row', async () => {
		const transport = new FakeTransport({ routes: ROUTES });
		await runScrape(db, transport, CONFIG, { onlyUnits: [1], today: TODAY, daysAhead: 1, now });

		// Every item resolves to the same fixture label, so despite many fetches
		// there is exactly one stored fact.
		expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM nutrition_fact').get()?.c).toBe(1);
	});

	it('records the Contains: line as declared-confidence allergens', async () => {
		const transport = new FakeTransport({ routes: ROUTES });
		await runScrape(db, transport, CONFIG, { onlyUnits: [1], today: TODAY, daysAhead: 1, now });

		const allergens = db
			.prepare<{ slug: string; confidence: string }>(
				`SELECT a.slug, na.confidence FROM nutrition_allergen na
				 JOIN allergen a ON a.id = na.allergen_id ORDER BY a.slug`
			)
			.all();

		expect(allergens.map((a) => a.slug)).toEqual([
			'corn',
			'eggs',
			'gluten-grains',
			'milk',
			'soy',
			'wheat'
		]);
		for (const a of allergens) expect(a.confidence).toBe('declared');
	});

	it('does not re-fetch a label on the next run', async () => {
		// label_fetched_at IS NULL is the queue; a second run must find it empty,
		// which is what keeps the nightly cost at ~10 minutes instead of 90.
		const first = new FakeTransport({ routes: ROUTES });
		await runScrape(db, first, CONFIG, { onlyUnits: [1], today: TODAY, daysAhead: 1, now });

		const second = new FakeTransport({ routes: ROUTES });
		const summary = await runScrape(db, second, CONFIG, {
			onlyUnits: [1],
			today: TODAY,
			daysAhead: 1,
			now
		});

		expect(summary.labelsFetched).toBe(0);
		expect(second.calls.some((c) => c.action === 'ShowItemNutritionLabel')).toBe(false);
	});

	it('is resumable: a run cut short by budget continues from where it stopped', async () => {
		const a = new FakeTransport({ routes: ROUTES });
		const first = await runScrape(db, a, CONFIG, {
			onlyUnits: [1],
			today: TODAY,
			daysAhead: 1,
			now,
			labelBudget: 1
		});
		expect(first.labelsFetched).toBe(1);

		const b = new FakeTransport({ routes: ROUTES });
		const second = await runScrape(db, b, CONFIG, {
			onlyUnits: [1],
			today: TODAY,
			daysAhead: 1,
			now
		});
		expect(second.labelsFetched).toBeGreaterThan(0);

		expect(
			db
				.prepare<{ c: number }>(
					'SELECT COUNT(*) AS c FROM menu_item WHERE label_fetched_at IS NULL'
				)
				.get()?.c
		).toBe(0);
	});
});

describe('runScrape idempotency end to end', () => {
	it('produces identical data when the whole crawl is repeated', async () => {
		await runScrape(db, new FakeTransport({ routes: ROUTES }), CONFIG, {
			onlyUnits: [1, 32],
			today: TODAY,
			daysAhead: 3,
			now
		});
		const first = snapshotDb(db);

		await runScrape(db, new FakeTransport({ routes: ROUTES }), CONFIG, {
			onlyUnits: [1, 32],
			today: TODAY,
			daysAhead: 3,
			now
		});

		expect(snapshotDb(db)).toEqual(first);
	});
});
