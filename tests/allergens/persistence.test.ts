/**
 * Matching is only worth having if it runs.
 *
 * `match.ts` was fully tested and entirely unreachable for a while: nothing
 * called it, so every stored label carried only upstream's own declarations and
 * the species resolution the app exists for never happened. These tests drive
 * the real persistence path with real captured labels and assert the rows come
 * out, so that gap cannot reopen silently.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { hiddenSourceTerms } from '../../src/lib/server/allergens/match.ts';
import type { Db } from '../../src/lib/server/db/driver.ts';
import { createMemoryDb } from '../../src/lib/server/db/index.ts';
import { parseItemPanel } from '../../src/lib/server/scraper/parse/item-panel.ts';
import { parseNutritionLabel } from '../../src/lib/server/scraper/parse/nutrition-label.ts';
import { persistMenu } from '../../src/lib/server/scraper/persist/menus.ts';
import { persistLabel } from '../../src/lib/server/scraper/persist/nutrition.ts';
import { upsertUnit } from '../../src/lib/server/scraper/persist/units.ts';
import { fixturePanel, loadFixture } from '../helpers/fixtures.ts';

let db: Db;
const NOW = 1_760_000_000;

beforeEach(() => {
	db = createMemoryDb();
});

interface AllergenRow {
	slug: string;
	source: string;
	confidence: string;
	evidence: string;
}

function factAllergens(db: Db, factId: number): AllergenRow[] {
	return db
		.prepare<AllergenRow>(
			`SELECT a.slug, na.source, na.confidence, na.evidence
			 FROM nutrition_allergen na JOIN allergen a ON a.id = na.allergen_id
			 WHERE na.nutrition_fact_id = ? ORDER BY a.slug, na.source`
		)
		.all(factId);
}

describe('persistLabel runs the full allergen pass', () => {
	it('records every Contains: token as declared', () => {
		const label = parseNutritionLabel(loadFixture('label-122098028.html'));
		const { nutritionFactId } = persistLabel(db, label, NOW);

		const declared = factAllergens(db, nutritionFactId).filter((r) => r.source === 'contains');
		expect(declared.map((r) => r.slug).sort()).toEqual([
			'corn',
			'eggs',
			'gluten-grains',
			'milk',
			'soy',
			'wheat'
		]);
		for (const row of declared) expect(row.confidence).toBe('declared');
		expect(declared[0].evidence).toMatch(/^Contains: /);
	});

	it('resolves a declared group down to a species from the ingredient prose', () => {
		// The whole point of the app in one assertion. Upstream declares only
		// "Tree Nuts"; the prose is the sole place the species is written.
		const base = parseNutritionLabel(loadFixture('label-122098028.html'));
		const withNuts = {
			...base,
			contentHash: 'synthetic-macadamia',
			contains: [...base.contains, 'Tree Nuts'],
			ingredientsText: 'ENRICHED FLOUR, SUGAR, MACADAMIA NUTS, BUTTER, SALT.'
		};

		const { nutritionFactId } = persistLabel(db, withNuts, NOW);
		const rows = factAllergens(db, nutritionFactId);

		const macadamia = rows.find((r) => r.slug === 'macadamia');
		expect(macadamia, 'species never resolved').toBeDefined();
		expect(macadamia!.source).toBe('ingredient');
		// `likely`, not `possible`: upstream declared the parent group, so this
		// is a resolution of a stated fact rather than a fresh guess.
		expect(macadamia!.confidence).toBe('likely');
		expect(macadamia!.evidence).toContain('MACADAMIA');
	});

	it('does not write a weaker duplicate for an allergen upstream declared', () => {
		const base = parseNutritionLabel(loadFixture('label-122098028.html'));
		const rows = factAllergens(db, persistLabel(db, base, NOW).nutritionFactId);

		const perAllergen = new Map<string, number>();
		for (const r of rows) perAllergen.set(r.slug, (perAllergen.get(r.slug) ?? 0) + 1);
		for (const [slug, count] of perAllergen) {
			expect(count, `${slug} recorded twice`).toBe(1);
		}
	});

	it('finds an allergen upstream has no vocabulary for at all', () => {
		const base = parseNutritionLabel(loadFixture('label-122098028.html'));
		const withMustard = {
			...base,
			contentHash: 'synthetic-mustard',
			ingredientsText: 'WATER, VINEGAR, MUSTARD SEED, CELERY SEED, TURMERIC.'
		};

		const rows = factAllergens(db, persistLabel(db, withMustard, NOW).nutritionFactId);
		expect(rows.map((r) => r.slug)).toContain('mustard');
		expect(rows.map((r) => r.slug)).toContain('celery');
	});

	it('stores the umbrella terms that weaken a "not found" reading', () => {
		const base = parseNutritionLabel(loadFixture('label-122098028.html'));
		const vague = {
			...base,
			contentHash: 'synthetic-vague',
			ingredientsText: 'CHICKEN, WATER, SPICES, NATURAL FLAVOR, SALT.'
		};

		const { nutritionFactId } = persistLabel(db, vague, NOW);
		const row = db
			.prepare<{ hidden_sources: string | null }>(
				'SELECT hidden_sources FROM nutrition_fact WHERE id = ?'
			)
			.get(nutritionFactId);
		expect(row!.hidden_sources).toBeTruthy();
		expect(row!.hidden_sources!.toUpperCase()).toContain('SPICES');
	});

	it('re-persisting an identical label writes no duplicate rows', () => {
		const label = parseNutritionLabel(loadFixture('label-122098028.html'));
		const first = persistLabel(db, label, NOW);
		const second = persistLabel(db, label, NOW + 86_400);

		expect(second.nutritionFactId).toBe(first.nutritionFactId);
		expect(second.created).toBe(false);
		expect(factAllergens(db, first.nutritionFactId)).toHaveLength(6);
	});
});

describe('persistMenu runs the item-name pass', () => {
	function seedMenu() {
		const unitId = upsertUnit(
			db,
			{ nnOid: 2, parentId: null, name: 'Test Venue', kind: 'standalone', sort: 0 },
			NOW
		);
		const panel = parseItemPanel(fixturePanel('itempanel-1440348.json', 'itemPanel'));
		return persistMenu(
			db,
			{ unitId, serviceDate: '2026-08-20', meal: 'Lunch', nnOid: 1440348 },
			panel,
			1,
			NOW
		);
	}

	it('flags a dish whose name names an allergen, with no label needed', () => {
		seedMenu();
		// Nothing has been fetched beyond the menu grid here -- no nutrition
		// label exists -- and the name signal still lands.
		const rows = db
			.prepare<{ name_display: string; slug: string; evidence: string }>(
				`SELECT i.name_display, a.slug, ia.evidence
				 FROM item_allergen ia
				 JOIN item i ON i.id = ia.item_id
				 JOIN allergen a ON a.id = ia.allergen_id`
			)
			.all();

		for (const row of rows) {
			// Every stored hit must be auditable against the name it came from.
			expect(row.evidence).toMatch(/^item name: /);
			expect(row.name_display.toLowerCase()).toContain(
				row.evidence.replace('item name: ', '').toLowerCase().split(' ')[0]
			);
		}
		expect(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM item').get()!.c).toBeGreaterThan(0);
	});

	it('is idempotent: re-scraping the same menu adds no name rows', () => {
		seedMenu();
		const before = db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM item_allergen').get()!.c;
		seedMenu();
		const after = db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM item_allergen').get()!.c;
		expect(after).toBe(before);
	});

	it('records only `possible`, the weakest confidence we assign', () => {
		seedMenu();
		const confidences = db
			.prepare<{ confidence: string }>('SELECT DISTINCT confidence FROM item_allergen')
			.all()
			.map((r) => r.confidence);
		for (const c of confidences) expect(c).toBe('possible');
	});
});

describe('hiddenSourceTerms', () => {
	it('finds umbrella terms as the label wrote them', () => {
		expect(hiddenSourceTerms('CHICKEN, SPICES, NATURAL FLAVOR.')).toEqual(
			expect.arrayContaining(['SPICES', 'NATURAL FLAVOR'])
		);
	});

	it('prefers the more specific term over the one inside it', () => {
		const found = hiddenSourceTerms('BEEF, SPICE BLEND, SALT.');
		expect(found).toContain('SPICE BLEND');
		expect(found).not.toContain('SPICE');
	});

	it('is empty for a label that actually names its ingredients', () => {
		expect(hiddenSourceTerms('WATER, WHEAT FLOUR, YEAST, SALT.')).toEqual([]);
		expect(hiddenSourceTerms(null)).toEqual([]);
	});

	it('does not fire on a word that merely contains a term', () => {
		expect(hiddenSourceTerms('SPICED APPLES, SUGAR.')).toEqual([]);
	});
});
