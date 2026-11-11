/**
 * The optimiser, on a menu built from real Ikenberry labels (2026-10-15).
 *
 * What is asserted is the shape of a sensible plate, not a particular one:
 * the exact dishes chosen are allowed to change when the scoring is tuned,
 * but a plate with no vegetable, three starches, a dessert nobody asked for or
 * four servings of one thing must never come out.
 */
import { describe, expect, it } from 'vitest';
import { allowedSteps, planMeal, prepare } from '../../src/lib/planner/optimize.ts';
import { classify } from '../../src/lib/planner/roles.ts';
import { computeTargets, type BodyProfile } from '../../src/lib/planner/targets.ts';
import type { Candidate } from '../../src/lib/planner/types.ts';

let nextId = 1;
function dish(
	name: string,
	category: string,
	serving: string,
	grams: number,
	[calories, proteinG, carbG, fatG, fiberG = 0]: number[],
	station = 'Lunch'
): Candidate {
	const id = nextId++;
	return {
		menuItemId: id,
		itemId: id,
		slug: name.toLowerCase().replace(/\W+/g, '-'),
		name,
		venue: station === 'Lunch' ? 'Gregory Drive Diner' : 'Build Your Own',
		station,
		category,
		servingText: serving,
		servingGrams: grams,
		nutrients: {
			calories,
			proteinG,
			carbG,
			fatG,
			fiberG,
			sugarG: 2,
			sodiumMg: calories * 1.2,
			satFatG: fatG / 4
		},
		traits: []
	};
}

const MENU: Candidate[] = [
	dish('Grilled Chicken Breast', 'Entrees', '1 Each', 112, [180, 21, 0, 11]),
	dish('Greek Chicken Breast', 'Entrees', 'Piece', 113, [120, 21, 1, 4.5]),
	dish('Beef Bulgogi', 'Entrees', '1/2 Cup', 148, [130, 24, 0, 4]),
	dish('Smoked Tofu Steak', 'Entrees', 'Each', 114, [120, 10, 6, 6, 2]),
	dish('Penne Pasta', 'Starches', 'Cup', 131, [180, 6, 37, 1, 2]),
	dish('Jasmine Rice', 'Starches', '1/2 Cup', 85, [110, 2, 24, 0]),
	dish('Wedge-Cut Fries', 'Starches', '1/2 Cup', 125, [250, 3, 27, 15, 3]),
	dish('Baked Sweet Potato', 'Starches', 'Each', 128, [110, 2, 26, 0, 4]),
	dish('Sauteed Green Beans', 'Vegetables', '1 Cup', 79, [60, 0.5, 5, 3.5, 2]),
	dish('Sauteed Squash Medley', 'Vegetables', '1/2 Cup', 104, [40, 1, 6, 1.5, 2]),
	dish('Fresh Cantaloupe', 'Fruits', '1 Cup', 113, [40, 0.5, 9, 0, 1]),
	dish('Chocolate Chip Cookies', 'Desserts', 'Each', 38, [170, 2, 23, 8, 1]),
	dish('Ranch Dressing', 'Dressings & Condiments', '2 Tablespoons', 28, [100, 0.5, 0.5, 10]),
	// The two broken labels.
	dish('Black Beans', 'Appetizers & Sides', '1/2 Cup', 17, [15, 0.5, 2, 0]),
	dish('Roasted Sweet Potato & White Bean Salad', 'Entrees', '1/2 Cup', 247, [240, 9, 40, 5, 10]),
	// The all-day stations.
	dish('Ice Cream Vanilla Soft Serve', 'Desserts', '1/2 Cup', 80, [110, 3, 17, 3], 'Ice Cream'),
	dish('Hard Cooked Eggs', 'Proteins', 'Each', 50, [70, 6, 0, 5], 'Salad Bar'),
	dish('Cottage Cheese', 'Cheeses', '1/2 Cup', 105, [110, 13, 3, 4.5], 'Salad Bar')
];

const profile: BodyProfile = {
	sex: 'male',
	age: 20,
	heightCm: 178,
	weightKg: 75,
	activity: 'moderate',
	goal: 'maintain',
	mealsPerDay: 3,
	units: 'imperial',
	caloriesOverride: null,
	proteinOverride: null
};
const targets = computeTargets(profile).meal;
const byName = (name: string) => MENU.find((c) => c.name === name)!;

function plan(extra: Partial<Parameters<typeof planMeal>[0]> = {}) {
	return planMeal({ candidates: MENU, targets, meal: 'Lunch', ...extra });
}

describe('classify', () => {
	it.each([
		['Grilled Chicken Breast', 'protein'],
		['Penne Pasta', 'starch'],
		['Sauteed Green Beans', 'veg'],
		['Fresh Cantaloupe', 'fruit'],
		['Chocolate Chip Cookies', 'dessert'],
		['Ice Cream Vanilla Soft Serve', 'dessert'],
		['Ranch Dressing', 'condiment'],
		['Hard Cooked Eggs', 'protein'],
		['Cottage Cheese', 'dairy']
	])('%s is %s', (name, role) => {
		expect(classify(byName(name))).toBe(role);
	});
});

describe('planMeal', () => {
	const result = plan();
	const lines = result.plan!.lines;

	it('builds a balanced plate: a protein, a vegetable, at most one starch', () => {
		const roles = lines.map((l) => l.item.role);
		expect(roles).toContain('protein');
		expect(roles).toContain('veg');
		expect(roles.filter((r) => r === 'starch').length).toBeLessThanOrEqual(1);
	});

	it('lands near the targets', () => {
		const t = result.plan!.totals;
		expect(Math.abs(t.calories - targets.calories) / targets.calories).toBeLessThan(0.15);
		expect(t.proteinG).toBeGreaterThan(targets.proteinG * 0.85);
	});

	it('never chooses a dessert or a condiment by itself', () => {
		for (const l of lines) expect(['dessert', 'condiment', 'drink']).not.toContain(l.item.role);
	});

	it('never puts a ridiculous amount of one thing on the plate', () => {
		for (const l of lines) {
			expect(l.multiplier).toBeLessThanOrEqual(3);
			expect(l.nutrients.calories).toBeLessThanOrEqual(targets.calories * 0.5 + 1);
			expect(l.grams ?? 0).toBeLessThanOrEqual(500);
		}
	});

	it('sets broken labels aside with a reason, and never plans them', () => {
		const skipped = result.skipped.map((s) => s.item.name);
		expect(skipped).toContain('Black Beans');
		expect(skipped).toContain('Roasted Sweet Potato & White Bean Salad');
		for (const name of skipped) {
			for (let option = 0; option < result.optionCount; option++) {
				const names = plan({ option }).plan!.lines.map((l) => l.item.name);
				expect(names).not.toContain(name);
			}
		}
	});

	it('re-plans without a removed dish', () => {
		const first = lines.find((l) => l.item.role === 'protein')!.item;
		const again = plan({ excludedItemIds: [first.itemId] }).plan!;
		expect(again.lines.map((l) => l.item.itemId)).not.toContain(first.itemId);
		expect(again.lines.map((l) => l.item.role)).toContain('protein');
	});

	it('plans around a dessert the user wants, rather than on top of it', () => {
		const softServe = byName('Ice Cream Vanilla Soft Serve');
		const withTreat = plan({ wanted: [{ menuItemId: softServe.menuItemId, multiplier: 2 }] }).plan!;
		const wantedLine = withTreat.lines.find((l) => l.item.menuItemId === softServe.menuItemId)!;
		expect(wantedLine.wanted).toBe(true);
		expect(wantedLine.nutrients.calories).toBe(220);
		// The rest shrinks to make room: the total is still near the target.
		expect(Math.abs(withTreat.totals.calories - targets.calories) / targets.calories).toBeLessThan(
			0.15
		);
	});

	it('offers genuinely different alternatives', () => {
		expect(result.optionCount).toBeGreaterThan(1);
		const a = new Set(plan({ option: 0 }).plan!.lines.map((l) => l.item.itemId));
		const b = plan({ option: 1 }).plan!.lines.map((l) => l.item.itemId);
		expect(b.filter((id) => !a.has(id)).length).toBeGreaterThanOrEqual(1);
	});

	it('wraps the option index', () => {
		expect(plan({ option: result.optionCount }).option).toBe(0);
	});

	it('returns no plan from an empty menu', () => {
		expect(planMeal({ candidates: [], targets, meal: 'Lunch' }).plan).toBeNull();
	});
});

describe('allowedSteps', () => {
	const [prepared] = prepare([
		dish('Greek Chicken Breast', 'Entrees', 'Piece', 113, [120, 21, 1, 4.5])
	]);

	it('caps a lean protein by weight, however well it would fit the numbers', () => {
		// 3 pieces would be 339 g of chicken: over the ~9 oz cap.
		expect(Math.max(...allowedSteps(prepared, 900))).toBe(2);
	});

	it('caps any one dish at half the meal', () => {
		expect(allowedSteps(prepared, 300)).toEqual([1]);
		expect(allowedSteps(prepared, 200)).toEqual([]);
	});
});
