import { describe, expect, it } from 'vitest';
import {
	computeTargets,
	displayMeasurements,
	parseProfileForm,
	reserveCalories,
	restingEnergy,
	type BodyProfile
} from '../../src/lib/planner/targets.ts';

const base: BodyProfile = {
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

function form(fields: Record<string, string>) {
	return { get: (name: string) => fields[name] ?? null };
}

describe('restingEnergy', () => {
	it('matches Mifflin-St Jeor by hand', () => {
		// 10*75 + 6.25*178 - 5*20 + 5 = 1767.5
		expect(restingEnergy(base)).toBeCloseTo(1767.5);
		expect(restingEnergy({ ...base, sex: 'female' })).toBeCloseTo(1601.5);
		expect(restingEnergy({ ...base, sex: 'unspecified' })).toBeCloseTo(1684.5);
	});
});

describe('computeTargets', () => {
	it('maintains at resting energy times activity', () => {
		const t = computeTargets(base);
		expect(t.day.calories).toBe(Math.round((1767.5 * 1.55) / 10) * 10);
		expect(t.day.proteinG).toBe(105);
		expect(t.meal.calories).toBeCloseTo(t.day.calories / 3);
	});

	it('splits energy: protein + carbs + fat add back up', () => {
		const { day } = computeTargets(base);
		expect(day.proteinG * 4 + day.carbG * 4 + day.fatG * 9).toBeCloseTo(day.calories);
	});

	it('runs a capped deficit for weight loss', () => {
		const t = computeTargets({ ...base, goal: 'lose' });
		const maintain = computeTargets(base).day.calories;
		expect(t.day.calories).toBeLessThan(maintain);
		expect(maintain - t.day.calories).toBeLessThanOrEqual(760);
	});

	it('never plans under resting energy', () => {
		const small: BodyProfile = {
			...base,
			sex: 'female',
			heightCm: 150,
			weightKg: 50,
			activity: 'sedentary',
			goal: 'lose'
		};
		const t = computeTargets(small);
		expect(t.day.calories).toBeGreaterThanOrEqual(Math.max(restingEnergy(small), 1200) - 5);
	});

	it('refuses a deficit when underweight', () => {
		const t = computeTargets({ ...base, weightKg: 52, goal: 'lose' });
		expect(t.notes.join(' ')).toMatch(/will not set a calorie deficit/);
		expect(t.day.calories).toBe(computeTargets({ ...base, weightKg: 52 }).day.calories);
	});

	it('uses overrides as given', () => {
		const t = computeTargets({ ...base, caloriesOverride: 2200, proteinOverride: 150 });
		expect(t.day.calories).toBe(2200);
		expect(t.day.proteinG).toBe(150);
	});

	it('caps protein from a very heavy weight', () => {
		const t = computeTargets({ ...base, weightKg: 150, goal: 'muscle' });
		// Weight used for protein tops out at BMI 27: 27 * 1.78^2 ≈ 85.5 kg.
		expect(t.day.proteinG).toBeLessThanOrEqual(Math.round(85.6 * 2));
	});
});

describe('reserveCalories', () => {
	it('takes the reserve out of carbs and fat but not protein', () => {
		const meal = computeTargets(base).meal;
		const r = reserveCalories(meal, 300);
		expect(r.calories).toBeCloseTo(meal.calories - 300);
		expect(r.proteinG).toBe(meal.proteinG);
		expect(r.carbG).toBeLessThan(meal.carbG);
		expect(r.proteinG * 4 + r.carbG * 4 + r.fatG * 9).toBeCloseTo(r.calories);
	});
});

describe('parseProfileForm', () => {
	const valid = {
		units: 'imperial',
		sex: 'female',
		age: '19',
		heightFt: '5',
		heightIn: '6',
		weightLb: '140',
		activity: 'light',
		goal: 'maintain',
		mealsPerDay: '3'
	};

	it('converts imperial to metric', () => {
		const result = parseProfileForm(form(valid));
		if (!('profile' in result)) throw new Error('expected a profile');
		expect(result.profile.heightCm).toBeCloseTo(167.6, 1);
		expect(result.profile.weightKg).toBeCloseTo(63.5, 1);
		expect(displayMeasurements(result.profile)).toMatchObject({
			heightFt: 5,
			heightIn: 6,
			weightLb: 140
		});
	});

	it('reads metric', () => {
		const result = parseProfileForm(
			form({ ...valid, units: 'metric', heightCm: '170', weightKg: '65' })
		);
		expect('profile' in result && result.profile.heightCm).toBe(170);
	});

	it('reports every bad field', () => {
		const result = parseProfileForm(form({ units: 'imperial', age: '7', weightLb: 'abc' }));
		if (!('errors' in result)) throw new Error('expected errors');
		expect(Object.keys(result.errors).sort()).toEqual(
			['activity', 'age', 'goal', 'height', 'sex', 'weight'].sort()
		);
	});

	it('rejects an out-of-range override but allows a blank one', () => {
		expect('errors' in parseProfileForm(form({ ...valid, caloriesOverride: '500' }))).toBe(true);
		expect('profile' in parseProfileForm(form({ ...valid, caloriesOverride: '' }))).toBe(true);
	});
});
