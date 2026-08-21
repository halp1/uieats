import { describe, expect, it } from 'vitest';
import { parseItemPanel } from '../../src/lib/server/scraper/parse/item-panel.ts';
import { parseNutritionLabel } from '../../src/lib/server/scraper/parse/nutrition-label.ts';
import { fixturePanel, loadFixture } from '../helpers/fixtures.ts';

/**
 * The two allergen sources must agree.
 *
 * Measured against live data across 10 venues (28/28 items): the trait icons on
 * an item row carry exactly the allergens the nutrition label's "Contains:"
 * line declares, plus dietary tags the label omits entirely.
 *
 * The app depends on that. The grid is what lets a menu page flag allergens
 * without fetching 150 labels, and the label is what resolves a group to a
 * species. If upstream ever breaks the agreement, the grid becomes unsafe to
 * render allergen chips from, and we need to find out from a test rather than
 * from a user.
 */

// Diet tags live only on the grid; they are not allergen declarations.
const DIET_TRAITS = new Set([
	'Vegan',
	'Vegetarian',
	'Halal',
	'Kosher',
	'Jain',
	'Local',
	'Sustainable Seafood'
]);

describe('grid traits vs label Contains:', () => {
	it('declare the same allergen set for the same item', () => {
		const panel = parseItemPanel(fixturePanel('itempanel-1440348.json', 'itemPanel'));
		const blondie = panel.items.find((i) => i.detailOid === 122098028);
		expect(blondie, 'fixture item missing').toBeDefined();

		const label = parseNutritionLabel(loadFixture('label-122098028.html'));

		const gridAllergens = blondie!.traits.filter((t) => !DIET_TRAITS.has(t)).sort();
		expect(gridAllergens).toEqual([...label.contains].sort());
	});

	it('the grid additionally carries diet tags the label never mentions', () => {
		const panel = parseItemPanel(fixturePanel('itempanel-1440348.json', 'itemPanel'));
		const blondie = panel.items.find((i) => i.detailOid === 122098028)!;
		const label = parseNutritionLabel(loadFixture('label-122098028.html'));

		expect(blondie.traits.filter((t) => DIET_TRAITS.has(t))).toEqual(['Vegetarian']);
		expect(label.contains).not.toContain('Vegetarian');
	});

	it('the label names a species the grid only reports as a group', () => {
		// This asymmetry is the entire reason nutrition labels are fetched at all.
		const label = parseNutritionLabel(loadFixture('label-122098028.html'));
		expect(label.contains).toContain('Gluten');
		// The grid never says "wheat flour"; the ingredient prose does.
		expect(label.ingredientsText?.toUpperCase()).toContain('WHEAT FLOUR');
	});
});
