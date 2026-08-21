import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDb } from '../../src/lib/server/db/index.ts';
import type { Db } from '../../src/lib/server/db/driver.ts';
import { matchIngredients, matchItemName } from '../../src/lib/server/allergens/match.ts';

let db: Db;
beforeEach(() => {
	db = createMemoryDb();
});

const slugs = (text: string) =>
	matchIngredients(db, text)
		.map((m) => m.slug)
		.sort();

describe('resolving a declared group to a species', () => {
	it('finds macadamia in prose that upstream only labelled "Tree Nuts"', () => {
		// This is the case the whole feature exists for. The grid and the
		// Contains: line both say Tree Nuts; only the ingredient text names it.
		const real =
			'ENRICHED BLEACHED FLOUR, SUGAR, WHITE CHOCOLATE CHIPS, MARGARINE, EGGS, MACADAMIA NUTS, BUTTER, SALT.';
		expect(slugs(real)).toContain('macadamia');
	});

	it('rates a species under a declared group as likely, not merely possible', () => {
		const treeNuts = db
			.prepare<{ id: number }>("SELECT id FROM allergen WHERE slug = 'tree-nuts'")
			.get()!;
		const [hit] = matchIngredients(db, 'SUGAR, MACADAMIA NUTS.', new Set([treeNuts.id]));
		expect(hit.slug).toBe('macadamia');
		expect(hit.confidence).toBe('likely');
	});

	it('rates a species with nothing declared behind it as only possible', () => {
		const [hit] = matchIngredients(db, 'SUGAR, MACADAMIA NUTS.');
		expect(hit.confidence).toBe('possible');
	});

	it('quotes the surrounding text as evidence, so the claim can be audited', () => {
		const [hit] = matchIngredients(db, 'SUGAR, BUTTER, MACADAMIA NUTS, SALT.');
		expect(hit.evidence.toUpperCase()).toContain('MACADAMIA');
	});
});

describe('false positives that must never fire', () => {
	// Each of these is a real ingredient string that a naive "contains nut"
	// check would flag, sending someone with a tree-nut allergy away from food
	// that is safe -- or worse, teaching them to ignore the warnings.
	it.each([
		['nutmeg', 'SUGAR, CINNAMON, NUTMEG, CLOVES.'],
		['nutritional yeast', 'VEGAN SAUCE (NUTRITIONAL YEAST, SALT, GARLIC).'],
		['butternut squash', 'ROASTED BUTTERNUT SQUASH, OLIVE OIL.'],
		['water chestnut', 'STIR FRY VEGETABLES (WATER CHESTNUTS, SNOW PEAS).'],
		['coconut', 'COCONUT MILK, RICE, SALT.']
	])('does not read %s as a tree nut', (_label, text) => {
		const found = slugs(text);
		const treeNutFamily = db
			.prepare<{ slug: string }>(
				`WITH RECURSIVE d(id) AS (
				   SELECT id FROM allergen WHERE slug = 'tree-nuts'
				   UNION ALL SELECT a.id FROM allergen a JOIN d ON a.parent_id = d.id
				 ) SELECT slug FROM allergen WHERE id IN (SELECT id FROM d)`
			)
			.all()
			.map((r) => r.slug);

		for (const slug of found) expect(treeNutFamily).not.toContain(slug);
	});

	it('does not treat peanuts as a tree nut -- they are a legume', () => {
		const found = slugs('PEANUT BUTTER, SUGAR, SALT.');
		expect(found).not.toContain('tree-nuts');
		expect(found).not.toContain('almond');
	});

	it('does not derive milk from cocoa butter or peanut butter', () => {
		// Milk is in upstream's authoritative vocabulary, so it is never
		// ingredient-matched at all -- which removes this entire class of error.
		expect(slugs('COCOA BUTTER, SUGAR.')).not.toContain('milk');
		expect(slugs('PEANUT BUTTER, HONEY.')).not.toContain('milk');
	});

	it('does not re-derive allergens upstream already declares authoritatively', () => {
		// Contains: is authoritative for these 18; inferring them from prose adds
		// only noise.
		const found = slugs('WHOLE MILK, EGGS, SOY LECITHIN, CORN SYRUP, SESAME SEEDS.');
		for (const declared of ['milk', 'eggs', 'soy', 'corn', 'sesame']) {
			expect(found).not.toContain(declared);
		}
	});
});

describe('"free from" claims', () => {
	it('does not flag an allergen a label is advertising the absence of', () => {
		// "CASHEW-FREE SAUCE" reassures the exact person a false hit would alarm.
		expect(slugs('CASHEW-FREE SAUCE (NUTRITIONAL YEAST, SALT).')).not.toContain('cashew');
		expect(slugs('CERTIFIED NUT FREE CHOCOLATE, SUGAR.')).not.toContain('tree-nuts');
	});
});

describe('allergens upstream never reports', () => {
	// These have no trait icon and never appear in Contains:, so ingredient
	// text is the only signal there is.
	it('finds mustard', () => {
		expect(slugs('VINEGAR, MUSTARD SEED, TURMERIC.')).toContain('mustard');
	});

	it('finds celery', () => {
		expect(slugs('CHICKEN STOCK (WATER, CELERY, ONION).')).toContain('celery');
	});

	it('finds anchovy hidden inside Worcestershire sauce', () => {
		expect(slugs('WORCESTERSHIRE SAUCE, GARLIC, PEPPER.')).toContain('anchovy');
	});
});

describe('matchItemName', () => {
	it('flags a dish whose name names an allergen', () => {
		const found = matchItemName(db, 'Dang Cold Noodle Salad w/ Peanuts').map((m) => m.slug);
		expect(found).toContain('peanuts');
	});

	it('never rises above possible, because a name is the weakest signal', () => {
		for (const m of matchItemName(db, 'Peanut Sauce')) {
			expect(m.confidence).toBe('possible');
		}
	});

	it('does not flag a dish merely for containing a substring', () => {
		// "Butternut Squash Soup" is not a tree nut dish.
		const found = matchItemName(db, 'Butternut Squash Soup').map((m) => m.slug);
		expect(found).not.toContain('chestnut');
		expect(found).not.toContain('tree-nuts');
	});

	it('returns nothing for an unremarkable name', () => {
		expect(matchItemName(db, 'Steamed White Rice')).toEqual([]);
	});
});

describe('degenerate input', () => {
	it('returns nothing for empty text rather than throwing', () => {
		expect(matchIngredients(db, '')).toEqual([]);
		expect(matchIngredients(db, '   ')).toEqual([]);
		expect(matchItemName(db, '')).toEqual([]);
	});

	it('matches a plural where the alias is stored singular', () => {
		// Aliases are singular; upstream writes "MACADAMIA NUTS", "Peanuts".
		expect(slugs('SUGAR, WALNUTS, SALT.')).toContain('walnut');
		expect(matchItemName(db, 'Cookies with Pecans').map((m) => m.slug)).toContain('pecan');
	});

	it('reports each allergen at most once however often it appears', () => {
		const found = matchIngredients(db, 'WALNUTS, SUGAR, WALNUTS, WALNUT OIL.');
		expect(found.filter((m) => m.slug === 'walnut')).toHaveLength(1);
	});
});
