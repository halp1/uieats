/**
 * Upstream-drift detection. Opt-in, five real requests.
 *
 *   LIVE_SCRAPE_TEST=1 bun run test:live
 *
 * This is NOT a correctness test -- the fixture tests do that, offline and
 * deterministically. Its only job is to notice that a 2017-era ASP.NET app with
 * no version, no API contract and no changelog has changed shape, before a user
 * notices for us. So it asserts INVARIANTS, never values: "at least eight
 * units", not "twelve units named these things". A menu that gains a dish must
 * not turn this red.
 *
 * It stays out of the default suite because it depends on a university server
 * being up, and a red build caused by someone else's outage teaches people to
 * ignore red builds.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/lib/server/scraper/config.ts';
import * as endpoints from '../../src/lib/server/scraper/endpoints.ts';
import { RAW_PANEL, panelOrThrow, readPanels } from '../../src/lib/server/scraper/panels.ts';
import { parseItemPanel } from '../../src/lib/server/scraper/parse/item-panel.ts';
import { parseMenuList } from '../../src/lib/server/scraper/parse/menu-list.ts';
import { parseNutritionLabel } from '../../src/lib/server/scraper/parse/nutrition-label.ts';
import { parseChildUnits, parseUnits } from '../../src/lib/server/scraper/parse/units.ts';
import { NetNutritionClient } from '../../src/lib/server/scraper/transport/client.ts';

const enabled = process.env.LIVE_SCRAPE_TEST === '1';

describe.skipIf(!enabled)('live upstream shape', () => {
	// One session for the whole file. The nutrition-label endpoint is
	// session-stateful, so the walk has to happen in order on one client.
	const config = loadConfig();
	const client = new NetNutritionClient(config);

	let landing: string;
	let hallOid: number;
	let venueOid: number;
	let menuOid: number;
	let detailOid: number;

	it('serves a landing page listing at least eight top-level units', async () => {
		landing = await client.bootstrap();
		const units = parseUnits(landing);

		// Twelve today. Asserting the count exactly would fail the day the
		// university opens or closes a dining hall, which is not drift.
		expect(units.length).toBeGreaterThanOrEqual(8);
		for (const unit of units) {
			expect(unit.oid).toBeGreaterThan(0);
			expect(unit.name.length).toBeGreaterThan(0);
			// The decode-once rule: no raw entity may survive into a parsed name.
			expect(unit.name).not.toMatch(/[&<>]/);
		}

		hallOid = units[0].oid;
	});

	it('answers a unit selection with either children or a menu list', async () => {
		const panels = readPanels(await endpoints.selectUnit(client, hallOid));
		const children = panels.get('childUnitsPanel');

		if (children) {
			const venues = parseChildUnits(children);
			expect(venues.length).toBeGreaterThan(0);
			venueOid = venues[0].oid;
		} else {
			// The standalone branch. Eight of twelve units take it, and a crawler
			// that only understands halls silently drops all of them.
			expect(panels.has('menuPanel')).toBe(true);
			venueOid = hallOid;
		}
		expect(venueOid).toBeGreaterThan(0);
	});

	it('lists menus with dates in our storage format', async () => {
		const html =
			venueOid === hallOid
				? panelOrThrow(readPanels(await endpoints.selectUnit(client, hallOid)), 'menuPanel')
				: panelOrThrow(readPanels(await endpoints.selectChildUnit(client, venueOid)), 'menuPanel');

		const menus = parseMenuList(html);
		expect(menus.length).toBeGreaterThan(0);
		for (const menu of menus) {
			expect(menu.serviceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(menu.meal.length).toBeGreaterThan(0);
		}
		menuOid = menus[0].oid;
	});

	it('returns a menu with at least one category and one item', async () => {
		const panel = panelOrThrow(
			readPanels(await endpoints.selectMenu(client, venueOid, menuOid)),
			'itemPanel'
		);
		const parsed = parseItemPanel(panel);

		expect(parsed.categories.length).toBeGreaterThanOrEqual(1);
		expect(parsed.items.length).toBeGreaterThanOrEqual(1);

		// Every item must belong to a heading that actually appeared, or the FK in
		// persistence would drop it.
		const categoryIds = new Set(parsed.categories.map((c) => c.nnCategoryId));
		for (const item of parsed.items) {
			expect(categoryIds.has(item.nnCategoryId)).toBe(true);
			expect(item.detailOid).toBeGreaterThan(0);
			expect(item.name).not.toMatch(/[&<>]/);
		}

		detailOid = parsed.items[0].detailOid;
	});

	it('returns a nutrition label with a numeric calorie value', async () => {
		// The menu was selected by the previous test, which this endpoint requires:
		// out of session it returns a ~350-byte stub with HTTP 200.
		const body = await endpoints.itemNutritionLabel(client, detailOid, menuOid);
		const label = parseNutritionLabel(readPanels(body).get(RAW_PANEL) ?? body);

		expect(label.name).not.toBeNull();
		expect(typeof label.nutrients.calories).toBe('number');
		expect(label.contentHash).toHaveLength(64);

		// Not every dish declares an allergen, so `contains` may be empty -- but
		// it must be an array, and every entry must be a non-empty string.
		expect(Array.isArray(label.contains)).toBe(true);
		for (const token of label.contains) expect(token.length).toBeGreaterThan(0);
	});

	it('made only the requests it needed', () => {
		// A regression that re-bootstraps or re-fetches per call would show up
		// here as a request count far above the five this file performs.
		expect(client.requestCount).toBeLessThanOrEqual(8);
	});
});
