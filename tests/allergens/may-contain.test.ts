/**
 * Cross-contact advisories, told apart from ingredients.
 *
 * The bug: Assorted Dinner Rolls is flour, water, yeast and salt, and the app
 * warned for tree nuts, because its label ends
 * "MAY CONTAIN: Sesame, Soy, Milk, Eggs, Tree Nuts." and the matcher read the
 * whole text. This is the OVER-warning direction, which is why it matters: a
 * chip that fires on a dish with no nuts in it is how a user learns to stop
 * reading the chips at all.
 *
 * It must not vanish either -- "may contain" is exactly what a severe allergy
 * needs to know -- so it becomes its own tier.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { verdictFor, type AllergenRef } from '../../src/lib/server/allergens/verdict.ts';
import type { Db } from '../../src/lib/server/db/driver.ts';
import { createMemoryDb } from '../../src/lib/server/db/index.ts';
import { matchAdvisory, matchIngredients } from '../../src/lib/server/allergens/match.ts';
import { splitIngredientAdvisory } from '../../src/lib/server/scraper/parse/nutrition-label.ts';
import { persistLabel } from '../../src/lib/server/scraper/persist/nutrition.ts';
import { parseNutritionLabel } from '../../src/lib/server/scraper/parse/nutrition-label.ts';
import { loadFixture } from '../helpers/fixtures.ts';

const NOW = 1_760_000_000;

describe('splitIngredientAdvisory', () => {
	it('separates a trailing advisory from the ingredients', () => {
		const s = splitIngredientAdvisory(
			'ENRICHED WHEAT FLOUR, WATER, YEAST, SALT. MAY CONTAIN: Sesame, Soy, Milk, Eggs, Tree Nuts.'
		);
		expect(s.advisory).toBe('MAY CONTAIN: Sesame, Soy, Milk, Eggs, Tree Nuts.');
		expect(s.body).toBe('ENRICHED WHEAT FLOUR, WATER, YEAST, SALT.');
		expect(s.body).not.toMatch(/tree nut/i);
	});

	it('keeps an advisory nested inside a component, and the components after it', () => {
		// Most advisories in the corpus are nested like this -- only 13 of 64 sit at
		// the top level -- so paren depth is not the discriminator.
		const s = splitIngredientAdvisory(
			'Chopped Peanuts (GFS: Dry Roasted Peanuts. MAY CONTAIN: Tree Nuts.), Light Soy Sauce (WATER, SOYBEANS)'
		);
		expect(s.advisory).toBe('MAY CONTAIN: Tree Nuts.');
		// Peanuts are a real ingredient here and must stay one.
		expect(s.body).toMatch(/Dry Roasted Peanuts/);
		// And nothing after the advisory may be swallowed.
		expect(s.body).toMatch(/Light Soy Sauce/);
		expect(s.body).not.toMatch(/tree nut/i);
	});

	it('does NOT treat an ingredient substitution as an advisory', () => {
		// "One or more of the following" means the oil genuinely is one of these,
		// so every name is a real possible ingredient.
		const s = splitIngredientAdvisory(
			'Potatoes, Vegetable Oil (May Contain One or More of the Following: Canola Oil, Sunflower Oil), Salt.'
		);
		expect(s.advisory).toBeNull();
		expect(s.body).toMatch(/Canola Oil/);
	});

	it('reads the shared-facility wordings too', () => {
		for (const text of [
			'SUGAR, COCOA. MANUFACTURED ON SHARED EQUIPMENT THAT PROCESSES TREE NUTS.',
			'OATS, HONEY. Contains traces of tree nuts, almonds.',
			'FLOUR. Produced in a facility that also handles peanuts.'
		]) {
			const s = splitIngredientAdvisory(text);
			expect(s.advisory, text).not.toBeNull();
		}
	});

	it('never unbalances the brackets it leaves behind', () => {
		// The body is re-parsed into recipe components, so a stray unclosed paren
		// would corrupt the item page.
		const text = 'Sauce (WATER, SPICES.MAY CONTAIN: Egg, Fish, Milk), Green Onions (Green Onions)';
		const s = splitIngredientAdvisory(text);
		const balance = (x: string) =>
			[...x].reduce((d, c) => d + (c === '(' ? 1 : c === ')' ? -1 : 0), 0);
		expect(balance(s.body ?? '')).toBe(balance(text));
		expect(s.body).toMatch(/Green Onions/);
	});

	it('leaves a label with no advisory completely alone', () => {
		const text = 'WATER, WHEAT FLOUR, YEAST, SALT.';
		expect(splitIngredientAdvisory(text)).toEqual({ body: text, advisory: null });
	});

	it('does not fire on "may" inside a longer word', () => {
		expect(splitIngredientAdvisory('MAYONNAISE, MAYO, SALT.').advisory).toBeNull();
	});
});

describe('the verdict tier', () => {
	const TREE_NUTS: AllergenRef = {
		id: 14,
		slug: 'tree-nuts',
		label: 'Tree Nuts',
		coveredByTraitVocabulary: true
	};

	const advisory = verdictFor({
		allergen: TREE_NUTS,
		hasLabel: true,
		hasIngredientText: true,
		evidence: [
			{
				source: 'may-contain',
				slug: 'tree-nuts',
				label: 'Tree Nuts',
				text: 'MAY CONTAIN: Sesame, Soy, Milk, Eggs, Tree Nuts.'
			}
		]
	});

	it('is its own verdict, not a declaration', () => {
		expect(advisory.verdict).toBe('flagged-may-contain');
	});

	it('still reads as a warning, because for a severe allergy it is one', () => {
		expect(advisory.isWarning).toBe(true);
	});

	it('says "may contain" in words, not only in border style', () => {
		expect(advisory.chipLabel).toBe('May contain Tree Nuts');
	});

	it('quotes upstream so the claim can be checked', () => {
		expect(advisory.basis).toContain('MAY CONTAIN');
	});

	it('ranks below a real ingredient hit and above our own guess', () => {
		const base = { allergen: TREE_NUTS, hasLabel: true, hasIngredientText: true };
		const ingredient = verdictFor({
			...base,
			evidence: [
				{
					source: 'ingredient',
					slug: 'tree-nuts',
					label: 'Tree Nuts',
					text: 'ingredients: WALNUTS'
				}
			]
		});
		const name = verdictFor({
			...base,
			evidence: [
				{ source: 'name', slug: 'tree-nuts', label: 'Tree Nuts', text: 'item name: Nut Bar' }
			]
		});

		expect(ingredient.severityRank).toBeGreaterThan(advisory.severityRank);
		expect(advisory.severityRank).toBeGreaterThan(name.severityRank);
	});

	it('loses to a real ingredient hit for the same allergen', () => {
		// If the prose names it AND the advisory mentions it, the stronger claim
		// is the one shown.
		const both = verdictFor({
			allergen: TREE_NUTS,
			hasLabel: true,
			hasIngredientText: true,
			evidence: [
				{
					source: 'may-contain',
					slug: 'tree-nuts',
					label: 'Tree Nuts',
					text: 'MAY CONTAIN: Tree Nuts.'
				},
				{
					source: 'ingredient',
					slug: 'tree-nuts',
					label: 'Tree Nuts',
					text: 'ingredients: WALNUTS'
				}
			]
		});
		expect(both.verdict).toBe('flagged-likely');
	});
});

describe('an advisory is matched against the FULL vocabulary', () => {
	let db: Db;
	beforeEach(() => {
		db = createMemoryDb();
	});

	it('finds the 18 upstream declares, which ingredient matching skips', () => {
		// The distinction that makes this feature work at all. Ingredient matching
		// deliberately ignores milk, eggs, soy and sesame -- upstream's "Contains:"
		// line is authoritative for those, and re-deriving them from prose would
		// only add false positives. But "Contains:" says nothing about
		// cross-contact, so for an advisory its own line is the ONLY source. Before
		// this, "MAY CONTAIN: Sesame, Soy, Milk, Eggs, Tree Nuts" surfaced tree nuts
		// alone -- the four the user most likely cared about were dropped.
		const found = matchAdvisory(db, 'MAY CONTAIN: Sesame, Soy, Milk, Eggs, Tree Nuts.').map(
			(m) => m.slug
		);
		expect(found).toContain('milk');
		expect(found).toContain('eggs');
		expect(found).toContain('soy');
		expect(found).toContain('sesame');
		expect(found).toContain('tree-nuts');
	});

	it('still leaves those out of ordinary ingredient matching', () => {
		// The old reasoning holds for the ingredient body, and must not regress.
		const found = matchIngredients(db, 'WATER, MILK, SUGAR, EGGS.').map((m) => m.slug);
		expect(found).not.toContain('milk');
		expect(found).not.toContain('eggs');
	});
});

describe('persisting a label with an advisory', () => {
	let db: Db;
	beforeEach(() => {
		db = createMemoryDb();
	});

	/** The reported case, using a real captured label as the base. */
	const rolls = () => {
		const base = parseNutritionLabel(loadFixture('label-122098028.html'));
		return {
			...base,
			contentHash: 'synthetic-dinner-rolls',
			contains: ['Gluten', 'Wheat'],
			ingredientsText:
				'ENRICHED WHEAT FLOUR, WATER, YEAST, SALT. MAY CONTAIN: Sesame, Soy, Milk, Eggs, Tree Nuts.'
		};
	};

	function rows(factId: number) {
		return db
			.prepare<{ slug: string; source: string; evidence: string }>(
				`SELECT a.slug, na.source, na.evidence FROM nutrition_allergen na
				 JOIN allergen a ON a.id = na.allergen_id
				 WHERE na.nutrition_fact_id = ? ORDER BY na.source, a.slug`
			)
			.all(factId);
	}

	it('records tree nuts as an advisory, not as an ingredient', () => {
		const { nutritionFactId } = persistLabel(db, rolls(), NOW);
		const treeNuts = rows(nutritionFactId).find((r) => r.slug === 'tree-nuts');

		expect(treeNuts, 'the advisory was not recorded at all').toBeDefined();
		expect(treeNuts!.source).toBe('may-contain');
	});

	it('stores the advisory text for the item page to quote', () => {
		const { nutritionFactId } = persistLabel(db, rolls(), NOW);
		expect(
			db
				.prepare<{ may_contain_text: string | null }>(
					'SELECT may_contain_text FROM nutrition_fact WHERE id = ?'
				)
				.get(nutritionFactId)!.may_contain_text
		).toBe('MAY CONTAIN: Sesame, Soy, Milk, Eggs, Tree Nuts.');
	});

	it('still finds a real ingredient in the same label', () => {
		// The body must keep being matched -- the fix must not switch matching off.
		const label = {
			...rolls(),
			contentHash: 'synthetic-with-barley',
			ingredientsText: 'WHEAT FLOUR, MALTED BARLEY FLOUR, WATER. MAY CONTAIN: Tree Nuts.'
		};
		const found = rows(persistLabel(db, label, NOW).nutritionFactId);

		expect(found.find((r) => r.slug === 'barley')?.source).toBe('ingredient');
		expect(found.find((r) => r.slug === 'tree-nuts')?.source).toBe('may-contain');
	});

	it('does not count an advisory term toward the umbrella-source advisory', () => {
		const label = {
			...rolls(),
			contentHash: 'synthetic-spices-in-advisory',
			ingredientsText: 'CHICKEN, WATER. MAY CONTAIN: Spices, Tree Nuts.'
		};
		const { nutritionFactId } = persistLabel(db, label, NOW);
		expect(
			db
				.prepare<{ hidden_sources: string | null }>(
					'SELECT hidden_sources FROM nutrition_fact WHERE id = ?'
				)
				.get(nutritionFactId)!.hidden_sources
		).toBeNull();
	});
});
