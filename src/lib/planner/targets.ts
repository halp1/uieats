/**
 * Body info in, nutrient targets out.
 *
 * Pure and shared rather than server-only: the profile form shows the same
 * option lists the server validates against, and the planner page renders the
 * numbers this produces. Nothing here does I/O.
 *
 * The method is the standard one rather than anything clever, because a
 * planner whose targets cannot be checked against a textbook is not one anyone
 * should eat by:
 *
 *   - Resting energy from Mifflin-St Jeor, the equation the Academy of
 *     Nutrition and Dietetics recommends for healthy adults.
 *   - Times a conventional activity factor.
 *   - A goal adjustment that is deliberately modest, with a floor it will not
 *     go under however the numbers fall out.
 *   - Protein from grams per kilogram, fat as a share of energy, carbohydrate
 *     as the remainder. Fibre, sodium and saturated fat from the US Dietary
 *     Guidelines.
 *
 * These are estimates for planning a plate, not a prescription, and the page
 * that shows them says so.
 */

export type Sex = 'female' | 'male' | 'unspecified';
export type Activity = 'sedentary' | 'light' | 'moderate' | 'active' | 'very-active';
export type Goal = 'lose' | 'maintain' | 'gain' | 'muscle';
export type Units = 'imperial' | 'metric';

export interface BodyProfile {
	sex: Sex;
	age: number;
	heightCm: number;
	weightKg: number;
	activity: Activity;
	goal: Goal;
	/** How many sittings the day's targets are split across. */
	mealsPerDay: number;
	/** Display preference only. Storage is always metric. */
	units: Units;
	/** Daily calories, when the user already knows their number. */
	caloriesOverride: number | null;
	/** Daily protein grams, likewise. */
	proteinOverride: number | null;
}

export const SEX_OPTIONS: { value: Sex; label: string }[] = [
	{ value: 'female', label: 'Female' },
	{ value: 'male', label: 'Male' },
	{ value: 'unspecified', label: 'Prefer not to say' }
];

export const ACTIVITY_OPTIONS: {
	value: Activity;
	label: string;
	detail: string;
	factor: number;
}[] = [
	{
		value: 'sedentary',
		label: 'Mostly sitting',
		detail: 'Classes, desk, little exercise',
		factor: 1.2
	},
	{
		value: 'light',
		label: 'Lightly active',
		detail: 'Walking campus, exercise 1–3 days a week',
		factor: 1.375
	},
	{
		value: 'moderate',
		label: 'Moderately active',
		detail: 'Exercise 3–5 days a week',
		factor: 1.55
	},
	{ value: 'active', label: 'Very active', detail: 'Hard exercise 6–7 days a week', factor: 1.725 },
	{
		value: 'very-active',
		label: 'Athlete',
		detail: 'Training twice a day, or a physical job',
		factor: 1.9
	}
];

export const GOAL_OPTIONS: { value: Goal; label: string; detail: string }[] = [
	{ value: 'lose', label: 'Lose weight', detail: 'A moderate deficit, higher protein' },
	{ value: 'maintain', label: 'Maintain', detail: 'Eat about what you burn' },
	{ value: 'gain', label: 'Gain weight', detail: 'A modest surplus' },
	{ value: 'muscle', label: 'Build muscle', detail: 'A small surplus, high protein' }
];

/** Protein, grams per kilogram of body weight per day. */
const PROTEIN_PER_KG: Record<Goal, number> = {
	lose: 1.8,
	maintain: 1.4,
	gain: 1.6,
	muscle: 2.0
};

export const LIMITS = {
	age: { min: 14, max: 100 },
	heightCm: { min: 120, max: 230 },
	weightKg: { min: 35, max: 300 },
	mealsPerDay: { min: 2, max: 5 },
	calories: { min: 1000, max: 6000 },
	protein: { min: 30, max: 350 }
} as const;

export interface NutrientTargets {
	calories: number;
	proteinG: number;
	carbG: number;
	fatG: number;
	fiberG: number;
	/** Upper limits rather than goals. */
	sodiumMg: number;
	satFatG: number;
	sugarG: number;
}

export interface Targets {
	day: NutrientTargets;
	meal: NutrientTargets;
	/** null when the user overrode calories, so none of these were used. */
	bmr: number | null;
	tdee: number | null;
	bmi: number;
	/** Plain-language caveats the page shows next to the numbers. */
	notes: string[];
	/** True when no profile was given and a reference day is being used. */
	isReference: boolean;
}

/** Mifflin-St Jeor resting energy, kcal/day. */
export function restingEnergy(
	p: Pick<BodyProfile, 'sex' | 'age' | 'heightCm' | 'weightKg'>
): number {
	const base = 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age;
	// The equation has two constants and no neutral one. The midpoint is the
	// honest choice for someone who would rather not say.
	const offset = p.sex === 'male' ? 5 : p.sex === 'female' ? -161 : -78;
	return base + offset;
}

export function bodyMassIndex(heightCm: number, weightKg: number): number {
	const m = heightCm / 100;
	return weightKg / (m * m);
}

function round(n: number, step = 1): number {
	return Math.round(n / step) * step;
}

/** Builds a full set from a calorie and protein figure, by the shared rules. */
function fromEnergy(calories: number, proteinG: number): NutrientTargets {
	// Fat at 28% sits inside the 20-35% the Dietary Guidelines allow, with room
	// either side. Carbohydrate takes what is left.
	const fatG = (calories * 0.28) / 9;
	const carbG = Math.max(0, (calories - proteinG * 4 - fatG * 9) / 4);
	return {
		calories,
		proteinG,
		carbG,
		fatG,
		// 14 g per 1,000 kcal, the Dietary Guidelines figure.
		fiberG: (calories / 1000) * 14,
		sodiumMg: 2300,
		satFatG: (calories * 0.1) / 9,
		// Total sugars, not added: the labels only give the total, and fruit and
		// milk would trip an added-sugar limit they do not deserve.
		sugarG: (calories * 0.2) / 4
	};
}

export function scaleTargets(t: NutrientTargets, factor: number): NutrientTargets {
	return {
		calories: t.calories * factor,
		proteinG: t.proteinG * factor,
		carbG: t.carbG * factor,
		fatG: t.fatG * factor,
		fiberG: t.fiberG * factor,
		sodiumMg: t.sodiumMg * factor,
		satFatG: t.satFatG * factor,
		sugarG: t.sugarG * factor
	};
}

/**
 * The 2,000-calorie day the nutrition label itself is written against.
 *
 * Used when someone has not entered anything, so the planner still works -- but
 * the page says that is what it is doing rather than passing it off as theirs.
 */
export function referenceTargets(mealsPerDay = 3): Targets {
	const day = fromEnergy(2000, 75);
	return {
		day,
		meal: scaleTargets(day, 1 / mealsPerDay),
		bmr: null,
		tdee: null,
		bmi: 0,
		notes: [],
		isReference: true
	};
}

export function computeTargets(p: BodyProfile): Targets {
	const notes: string[] = [];
	const bmi = bodyMassIndex(p.heightCm, p.weightKg);
	const bmr = restingEnergy(p);
	const factor = ACTIVITY_OPTIONS.find((a) => a.value === p.activity)?.factor ?? 1.375;
	const tdee = bmr * factor;

	let goal = p.goal;
	if (goal === 'lose' && bmi < 18.5) {
		// A deficit for someone already underweight is not something a menu app
		// should be helping with.
		goal = 'maintain';
		notes.push(
			'Your BMI is under 18.5, so the planner will not set a calorie deficit. It is planning to maintain instead.'
		);
	}

	let calories: number;
	if (p.caloriesOverride !== null) {
		calories = p.caloriesOverride;
	} else {
		const adjustment =
			goal === 'lose'
				? -Math.min(tdee * 0.2, 750)
				: goal === 'gain'
					? Math.min(tdee * 0.12, 500)
					: goal === 'muscle'
						? 250
						: 0;
		calories = tdee + adjustment;

		// Never under resting energy, and never under the conventional floors.
		// Below those a diet stops being something to plan from a dining hall.
		const floor = Math.max(bmr, p.sex === 'male' ? 1500 : 1200);
		if (calories < floor) {
			calories = floor;
			notes.push(
				'The deficit was limited so the daily target stays above your estimated resting energy.'
			);
		}
	}

	let proteinG: number;
	if (p.proteinOverride !== null) {
		proteinG = p.proteinOverride;
	} else {
		// Grams per kilogram over-shoots for a heavier body, where much of the
		// extra weight is not muscle. Capping the weight used at a BMI of 27 keeps
		// the target in a range a plate can actually reach.
		const m = p.heightCm / 100;
		const weightForProtein = Math.min(p.weightKg, 27 * m * m);
		proteinG = weightForProtein * PROTEIN_PER_KG[goal];
	}
	// Protein above 35% of energy squeezes everything else out of the meal.
	const proteinCap = (calories * 0.35) / 4;
	if (proteinG > proteinCap) {
		proteinG = proteinCap;
		if (p.proteinOverride !== null) {
			notes.push('Protein was capped at 35% of your calories so the rest of the meal has room.');
		}
	}

	if (p.age < 18) {
		notes.push(
			'These equations are built for adults. Under 18, growth changes what you need, so treat the numbers as a rough guide.'
		);
	}

	const day = fromEnergy(round(calories, 10), round(proteinG));
	return {
		day,
		meal: scaleTargets(day, 1 / p.mealsPerDay),
		bmr: round(bmr, 10),
		tdee: round(tdee, 10),
		bmi: Math.round(bmi * 10) / 10,
		notes,
		isReference: false
	};
}

/**
 * Room saved for something off the menu -- a coffee later, a snack, a
 * dessert somewhere else.
 *
 * Taken out of calories, carbohydrate and fat in proportion and not out of
 * protein: whatever someone is saving room for is almost never a protein
 * source, and cutting protein would leave the meal short of the one thing it
 * most needs to supply.
 */
export function reserveCalories(t: NutrientTargets, reserve: number): NutrientTargets {
	if (reserve <= 0) return t;
	const remaining = Math.max(t.calories - reserve, t.proteinG * 4);
	const nonProtein = t.calories - t.proteinG * 4;
	const ratio = nonProtein <= 0 ? 0 : Math.max(0, remaining - t.proteinG * 4) / nonProtein;
	return {
		...t,
		calories: remaining,
		carbG: t.carbG * ratio,
		fatG: t.fatG * ratio,
		satFatG: t.satFatG * ratio,
		sugarG: t.sugarG * ratio
	};
}

// ---------------------------------------------------------------------------
// Form parsing
// ---------------------------------------------------------------------------

export type ProfileErrors = Partial<Record<string, string>>;

const LB_PER_KG = 2.20462;
const CM_PER_IN = 2.54;

function num(raw: FormDataEntryValue | null | undefined): number | null {
	if (raw === null || raw === undefined) return null;
	const text = String(raw).trim();
	if (text === '') return null;
	const n = Number(text);
	return Number.isFinite(n) ? n : NaN;
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[]): T | null {
	return allowed.includes(raw as T) ? (raw as T) : null;
}

/**
 * Reads the profile form, converting whatever unit system it was filled in.
 *
 * Every error is worded as what to type instead, keyed by field so the form
 * can show it in place.
 */
export function parseProfileForm(form: {
	get(name: string): FormDataEntryValue | null;
}): { profile: BodyProfile } | { errors: ProfileErrors } {
	const errors: ProfileErrors = {};
	const units = oneOf(form.get('units'), ['imperial', 'metric'] as const) ?? 'imperial';

	const sex = oneOf(
		form.get('sex'),
		SEX_OPTIONS.map((o) => o.value)
	);
	if (!sex) errors.sex = 'Pick one. "Prefer not to say" works fine.';

	const age = num(form.get('age'));
	if (age === null || Number.isNaN(age)) errors.age = 'Enter your age in years.';
	else if (age < LIMITS.age.min || age > LIMITS.age.max)
		errors.age = `Ages ${LIMITS.age.min} to ${LIMITS.age.max} only.`;

	let heightCm: number | null = null;
	let weightKg: number | null = null;
	if (units === 'imperial') {
		const ft = num(form.get('heightFt'));
		const inches = num(form.get('heightIn')) ?? 0;
		if (ft === null || Number.isNaN(ft) || Number.isNaN(inches)) {
			errors.height = 'Enter your height in feet and inches.';
		} else {
			heightCm = (ft * 12 + inches) * CM_PER_IN;
		}
		const lb = num(form.get('weightLb'));
		if (lb === null || Number.isNaN(lb)) errors.weight = 'Enter your weight in pounds.';
		else weightKg = lb / LB_PER_KG;
	} else {
		const cm = num(form.get('heightCm'));
		if (cm === null || Number.isNaN(cm)) errors.height = 'Enter your height in centimetres.';
		else heightCm = cm;
		const kg = num(form.get('weightKg'));
		if (kg === null || Number.isNaN(kg)) errors.weight = 'Enter your weight in kilograms.';
		else weightKg = kg;
	}
	if (heightCm !== null && (heightCm < LIMITS.heightCm.min || heightCm > LIMITS.heightCm.max)) {
		errors.height = 'That height is outside what the equations cover.';
	}
	if (weightKg !== null && (weightKg < LIMITS.weightKg.min || weightKg > LIMITS.weightKg.max)) {
		errors.weight = 'That weight is outside what the equations cover.';
	}

	const activity = oneOf(
		form.get('activity'),
		ACTIVITY_OPTIONS.map((o) => o.value)
	);
	if (!activity) errors.activity = 'Pick the closest match.';

	const goal = oneOf(
		form.get('goal'),
		GOAL_OPTIONS.map((o) => o.value)
	);
	if (!goal) errors.goal = 'Pick a goal.';

	const meals = num(form.get('mealsPerDay')) ?? 3;
	if (
		Number.isNaN(meals) ||
		!Number.isInteger(meals) ||
		meals < LIMITS.mealsPerDay.min ||
		meals > LIMITS.mealsPerDay.max
	) {
		errors.mealsPerDay = `Between ${LIMITS.mealsPerDay.min} and ${LIMITS.mealsPerDay.max}.`;
	}

	const caloriesOverride = num(form.get('caloriesOverride'));
	if (
		caloriesOverride !== null &&
		(Number.isNaN(caloriesOverride) ||
			caloriesOverride < LIMITS.calories.min ||
			caloriesOverride > LIMITS.calories.max)
	) {
		errors.caloriesOverride = `Leave it blank, or ${LIMITS.calories.min.toLocaleString()} to ${LIMITS.calories.max.toLocaleString()}.`;
	}

	const proteinOverride = num(form.get('proteinOverride'));
	if (
		proteinOverride !== null &&
		(Number.isNaN(proteinOverride) ||
			proteinOverride < LIMITS.protein.min ||
			proteinOverride > LIMITS.protein.max)
	) {
		errors.proteinOverride = `Leave it blank, or ${LIMITS.protein.min} to ${LIMITS.protein.max} g.`;
	}

	if (Object.keys(errors).length > 0) return { errors };

	return {
		profile: {
			sex: sex!,
			age: Math.round(age!),
			heightCm: Math.round(heightCm! * 10) / 10,
			weightKg: Math.round(weightKg! * 10) / 10,
			activity: activity!,
			goal: goal!,
			mealsPerDay: meals,
			units,
			caloriesOverride: caloriesOverride === null ? null : Math.round(caloriesOverride),
			proteinOverride: proteinOverride === null ? null : Math.round(proteinOverride)
		}
	};
}

/** Height and weight as the form shows them, in the user's own units. */
export function displayMeasurements(p: BodyProfile): {
	heightFt: number;
	heightIn: number;
	weightLb: number;
	heightCm: number;
	weightKg: number;
} {
	const totalIn = p.heightCm / CM_PER_IN;
	let heightFt = Math.floor(totalIn / 12);
	let heightIn = Math.round(totalIn - heightFt * 12);
	if (heightIn === 12) {
		heightFt += 1;
		heightIn = 0;
	}
	return {
		heightFt,
		heightIn,
		weightLb: Math.round(p.weightKg * LB_PER_KG),
		heightCm: Math.round(p.heightCm),
		weightKg: Math.round(p.weightKg * 10) / 10
	};
}

/** Checks a stored or cookie-held profile still has the right shape. */
export function isBodyProfile(value: unknown): value is BodyProfile {
	if (typeof value !== 'object' || value === null) return false;
	const p = value as Record<string, unknown>;
	const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
	const nullableFinite = (v: unknown) => v === null || finite(v);
	return (
		SEX_OPTIONS.some((o) => o.value === p.sex) &&
		ACTIVITY_OPTIONS.some((o) => o.value === p.activity) &&
		GOAL_OPTIONS.some((o) => o.value === p.goal) &&
		(p.units === 'imperial' || p.units === 'metric') &&
		finite(p.age) &&
		finite(p.heightCm) &&
		finite(p.weightKg) &&
		finite(p.mealsPerDay) &&
		nullableFinite(p.caloriesOverride) &&
		nullableFinite(p.proteinOverride)
	);
}
