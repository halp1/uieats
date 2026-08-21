import { describe, expect, it } from 'vitest';
import { parseNutritionLabel } from './nutrition-label.ts';
import { loadFixture } from '../../../../../tests/helpers/fixtures.ts';

const label = parseNutritionLabel(loadFixture('label-122098028.html'));

describe('parseNutritionLabel identity', () => {
	it('reads the dish name and serving size', () => {
		expect(label.name).toBe('Blondie Bars');
		expect(label.servingSizeText).toBe('Slice (1/96) (42g)');
		expect(label.servingGrams).toBe(42);
	});
});

describe('parseNutritionLabel nutrients', () => {
	it('reads the values upstream actually reports', () => {
		expect(label.nutrients).toMatchObject({
			calories: 180,
			calFromFat: 72,
			totalFatG: 8,
			satFatG: 4.5,
			monoFatG: 1,
			cholesterolMg: 30,
			sodiumMg: 150,
			potassiumMg: 1,
			totalCarbG: 25,
			sugarsG: 17,
			proteinG: 2,
			calciumDv: 0,
			ironDv: 4
		});
	});

	it('maps "NA" to null rather than zero', () => {
		// Trans Fat and Polyunsaturated Fat both render as NA on this label.
		// Storing them as 0 would state a fact upstream never asserted, and a
		// user avoiding trans fat could act on it.
		expect(label.nutrients.transFatG).toBeNull();
		expect(label.nutrients.polyFatG).toBeNull();
	});

	it('maps an empty percentage cell to null rather than zero', () => {
		// Vitamin A and C render as a bare nbsp on this label, while Calcium
		// genuinely reports 0%. Those must not collapse to the same value.
		expect(label.nutrients.vitADv).toBeNull();
		expect(label.nutrients.vitCDv).toBeNull();
		expect(label.nutrients.calciumDv).toBe(0);
	});

	it('reads "< 1g" as a bounded value rather than discarding the bound', () => {
		expect(label.nutrients.fiberG).toBe(0.5);
		expect(label.nutrients.fiberIsLessThan).toBe(true);
	});
});

describe('parseNutritionLabel allergens', () => {
	it('reads the Contains: line, which is the authoritative allergen source', () => {
		expect(label.contains).toEqual(['Corn', 'Eggs', 'Gluten', 'Milk', 'Soy', 'Wheat']);
	});

	it('strips the nbsp separators upstream uses between allergens', () => {
		for (const a of label.contains) {
			expect(a).toBe(a.trim());
			expect(a).not.toMatch(/&[a-z#]+;|\u00a0/i);
		}
	});
});

describe('parseNutritionLabel ingredients', () => {
	it('keeps the full ingredient text, which is the only sub-allergen source', () => {
		expect(label.ingredientsText).toContain('SOY LECITHIN');
		expect(label.ingredientsText).toContain('ENRICHED FLOUR BLEACHED');
	});

	it('splits sub-recipes into components with their parenthesised bodies', () => {
		expect(label.components).toHaveLength(6);
		expect(label.components[0].componentName).toBe('Mix Cake Yellow Gold Medal');
		expect(label.components[0].ingredientText).toContain('SUGAR');
		expect(label.components.at(-1)?.componentName).toBe('Oil Pan Release Spray Soy-Free');
	});

	it('does not split on commas inside a component body', () => {
		// Component bodies are comma-heavy; splitting naively shatters them.
		for (const c of label.components) {
			expect(c.componentName).not.toMatch(/^[A-Z ,]+$/);
			expect(c.componentName.length).toBeLessThan(60);
		}
	});
});

describe('parseNutritionLabel content hash', () => {
	it('is stable for identical input', () => {
		const again = parseNutritionLabel(loadFixture('label-122098028.html'));
		expect(again.contentHash).toBe(label.contentHash);
		expect(label.contentHash).toHaveLength(64);
	});

	it('differs when the nutrition content differs', () => {
		const altered = loadFixture('label-122098028.html').replace('Blondie Bars', 'Blondie Squares');
		expect(parseNutritionLabel(altered).contentHash).not.toBe(label.contentHash);
	});
});

describe('parseNutritionLabel degenerate input', () => {
	it('returns nulls rather than throwing when the label is unrecognisable', () => {
		const empty = parseNutritionLabel('<div>Nutrition information unavailable</div>');
		expect(empty.contains).toEqual([]);
		expect(empty.components).toEqual([]);
		expect(empty.nutrients.calories).toBeNull();
	});
});
