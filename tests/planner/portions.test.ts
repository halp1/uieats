/**
 * Serving parsing and label checks, against serving lines and labels copied
 * from a real Ikenberry day (2026-10-15). The two bad labels here are the ones
 * that motivated the checks: both passed through upstream unremarked.
 */
import { describe, expect, it } from 'vitest';
import {
	checkLabel,
	describePortion,
	formatAmount,
	parseServing,
	portionSteps
} from '../../src/lib/planner/portions.ts';
import type { Candidate } from '../../src/lib/planner/types.ts';

function dish(
	name: string,
	serving: string,
	grams: number | null,
	[calories, proteinG, carbG, fatG]: [number, number, number, number],
	category = 'Entrees'
): Candidate {
	return {
		menuItemId: 1,
		itemId: 1,
		slug: 'x',
		name,
		venue: 'Venue',
		station: 'Lunch',
		category,
		servingText: serving,
		servingGrams: grams,
		nutrients: {
			calories,
			proteinG,
			carbG,
			fatG,
			fiberG: 0,
			sugarG: 0,
			sodiumMg: 0,
			satFatG: 0
		},
		traits: []
	};
}

describe('parseServing', () => {
	it.each([
		['1/2 Cup', 'volume', 0.5, 'cup'],
		['1 Cup', 'volume', 1, 'cup'],
		['2 Tablespoons', 'volume', 2, 'tbsp'],
		['2 TB', 'volume', 2, 'tbsp'],
		['12 fl oz', 'volume', 12, 'fl oz'],
		['Fluid Oz', 'volume', 1, 'fl oz'],
		['6 Ounce', 'weight', 6, 'oz'],
		['3oz Serving', 'weight', 3, 'oz'],
		['Each', 'count', 1, 'each'],
		['5 Each', 'count', 5, 'each'],
		['1oz Slice', 'count', 1, 'slice'],
		['4oz Bagel', 'count', 1, 'bagel'],
		['Sausage', 'count', 1, 'sausage'],
		['Serving', 'other', 1, 'serving']
	])('%s', (text, kind, amount, unit) => {
		const s = parseServing(text);
		expect(s.kind).toBe(kind);
		expect(s.amount).toBeCloseTo(amount);
		expect(s.unit).toBe(unit);
	});

	it('reads "1/12 Slice" as one slice of a pie, not a twelfth of a slice', () => {
		const s = parseServing('1/12 Slice');
		expect(s).toMatchObject({ kind: 'count', amount: 1, unit: 'slice' });
	});

	it('drops parentheticals: "Slice (1/96)" is one slice', () => {
		expect(parseServing('Slice (1/96)')).toMatchObject({
			kind: 'count',
			amount: 1,
			label: 'Slice'
		});
	});
});

describe('checkLabel', () => {
	it('passes ordinary labels', () => {
		const chicken = dish('Grilled Chicken Breast', '1 Each', 112, [180, 21, 0, 11]);
		expect(checkLabel(chicken, parseServing('1 Each'), 'protein').ok).toBe(true);
		const pasta = dish('Penne Pasta', 'Cup', 131, [180, 6, 37, 1], 'Starches');
		expect(checkLabel(pasta, parseServing('Cup'), 'starch').ok).toBe(true);
	});

	it('rejects half a cup of beans weighing 17 g', () => {
		const beans = dish('Black Beans', '1/2 Cup', 17, [15, 0.5, 2, 0], 'Appetizers & Sides');
		const check = checkLabel(beans, parseServing('1/2 Cup'), 'starch');
		expect(check.ok).toBe(false);
		expect(check.reason).toMatch(/too light/);
	});

	it('rejects 247 g in half a cup', () => {
		const salad = dish('Roasted Sweet Potato & White Bean Salad', '1/2 Cup', 247, [240, 9, 40, 5]);
		const check = checkLabel(salad, parseServing('1/2 Cup'), 'starch');
		expect(check.ok).toBe(false);
		expect(check.reason).toMatch(/does not fit/);
	});

	it('does not reject leaves for being light', () => {
		const spinach = dish('Fresh Spinach', '1/2 Cup', 15, [10, 1, 1, 0], 'Vegetables');
		expect(checkLabel(spinach, parseServing('1/2 Cup'), 'veg').ok).toBe(true);
	});

	it('rejects calories the macros cannot account for', () => {
		const odd = dish('Mystery Bake', 'Each', 200, [900, 5, 20, 5]);
		expect(checkLabel(odd, parseServing('Each'), 'starch').reason).toMatch(/do not match/);
	});

	it('tolerates rounding and fibre', () => {
		// Raisin Bran: 190 cal on the label, ~241 by naive 4-4-9.
		const bran = dish('Raisin Bran', '1 Cup', 59, [190, 11, 47, 1], 'Cereals');
		expect(checkLabel(bran, parseServing('1 Cup'), 'cereal').ok).toBe(true);
	});

	it('rejects more energy than fat carries', () => {
		const d = dish('Thing', 'Each', 10, [200, 0, 0, 22]);
		expect(checkLabel(d, parseServing('Each'), 'side').reason).toMatch(/pure fat/);
	});

	it('rejects a whole batch dressed up as a serving', () => {
		const d = dish('Lasagna', 'Each', null, [2400, 120, 240, 106]);
		expect(checkLabel(d, parseServing('Each'), 'protein').reason).toMatch(/whole batch/);
	});

	it('rejects raw mixes', () => {
		const d = dish('Mix Soft Serve Dole Strawberry', '1/2 Cup', 22, [90, 0, 21, 0], 'Desserts');
		expect(checkLabel(d, parseServing('1/2 Cup'), 'dessert').reason).toMatch(/raw mix/);
	});

	it('rejects a label with no macros', () => {
		const d = { ...dish('Bi Bim Bap Bar', 'Serving', 113, [0, 0, 0, 0]), nutrients: null };
		expect(checkLabel(d, parseServing('Serving'), 'protein').ok).toBe(false);
	});
});

describe('portions', () => {
	it('never offers half of a counted thing', () => {
		expect(portionSteps(parseServing('Each'))).toEqual([1, 2, 3, 4]);
		expect(portionSteps(parseServing('6 Each'))).toEqual([0.5, 1, 1.5, 2]);
		expect(portionSteps(parseServing('5 Each'))).toEqual([1, 2]);
	});

	it('does not go under a quarter cup', () => {
		expect(portionSteps(parseServing('1/4 Cup'))).not.toContain(0.5);
		expect(portionSteps(parseServing('1 Cup'))).toContain(0.5);
	});

	it('describes portions the way someone would scoop them', () => {
		expect(describePortion(parseServing('1/2 Cup'), 2)).toBe('1 cup');
		expect(describePortion(parseServing('1/2 Cup'), 3)).toBe('1 1/2 cups');
		expect(describePortion(parseServing('Each'), 2)).toBe('2 each');
		expect(describePortion(parseServing('Slice'), 2)).toBe('2 slices');
		expect(describePortion(parseServing('Patty'), 2)).toBe('2 patties');
		expect(describePortion(parseServing('6 Ounce'), 1.5)).toBe('9 oz');
		expect(describePortion(parseServing('Medium 3" Diameter'), 2)).toBe('2 × Medium 3" Diameter');
	});

	it('formats fractions', () => {
		expect(formatAmount(0.75)).toBe('3/4');
		expect(formatAmount(1 / 3)).toBe('1/3');
		expect(formatAmount(2)).toBe('2');
		expect(formatAmount(1.5)).toBe('1 1/2');
	});
});
