/**
 * What the meal planner may choose from, and the body profile it plans for.
 *
 * The menu half follows the same pattern as `getMenusForScope`: a handful of
 * set-based statements for the whole scope, grouped in TypeScript. It differs
 * in what it loads -- the full nutrient row rather than just calories -- and in
 * what "a meal" means. A student eating lunch at Ikenberry can take from the
 * lunch line AND from the all-day stations (deli, salad bar, ice cream), so a
 * sitting here is that sitting's menus plus every station open that day.
 *
 * Allergens are applied here, before the planner sees anything: a dish with
 * any warning for the user, or any allergen we could not check, never reaches
 * the optimiser. Recommending a dish is a stronger act than listing one, so
 * this is stricter than the browse pages, which show such dishes with chips.
 */
import type { Db } from '../db/driver.ts';
import { isBodyProfile, type BodyProfile } from '../../planner/targets.ts';
import type { Candidate } from '../../planner/types.ts';
import { mealSort, unixNow } from '../../dates.ts';
import { getItemVerdicts, isEmptyProfile, type AllergenProfile } from './allergens.ts';
import { placeholders, selectByIds } from './sql.ts';
import { getVenuesOf, type UnitRef } from './units.ts';

export interface PlannerMenuParams {
	date: string;
	root: UnitRef;
	/** A sitting ("Lunch"), or null to let `defaultMeal` choose. */
	meal: string | null;
	/** Picks a sitting when `meal` is absent or not served. Defaults to the first. */
	defaultMeal?: (sittings: string[]) => string | null;
	profile: AllergenProfile;
	/** Diet trait slugs a dish must carry ALL of. */
	diets?: string[];
	skipSaladBar?: boolean;
}

export interface PlannerMenu {
	/** Sittings served in scope that day, in order. The planner's tabs. */
	sittings: string[];
	/** All-day stations folded into every sitting. */
	stations: string[];
	/** The sitting actually used, after defaulting. */
	meal: string | null;
	candidates: Candidate[];
	/** Dishes held back for the user's allergens, flagged or unverified. */
	allergenHeld: number;
	/** Dishes held back by the salad-bar filter. */
	saladBarHeld: number;
	/** Dishes held back by the diet filter. */
	dietHeld: number;
}

interface Row {
	menu_item_id: number;
	item_id: number;
	slug: string;
	name_display: string;
	venue_name: string;
	meal: string;
	category_name: string;
	serving_size: string | null;
	serving_size_text: string | null;
	serving_grams: number | null;
	calories: number | null;
	protein_g: number | null;
	total_carb_g: number | null;
	total_fat_g: number | null;
	fiber_g: number | null;
	sugars_g: number | null;
	sodium_mg: number | null;
	sat_fat_g: number | null;
}

/**
 * "Salad Bar" the station, not every course with "salad" in its name: a deli's
 * prepared tuna salad is a plated dish, and the self-serve bar is what people
 * mean by skipping it.
 */
export function isSaladBar(c: { venue: string; station: string; category: string }): boolean {
	return (
		/salad bar/i.test(c.station) || /salad bar/i.test(c.venue) || /^salad bar$/i.test(c.category)
	);
}

export function getPlannerMenu(db: Db, params: PlannerMenuParams): PlannerMenu {
	const venues = getVenuesOf(db, params.root);
	const empty: PlannerMenu = {
		sittings: [],
		stations: [],
		meal: null,
		candidates: [],
		allergenHeld: 0,
		saladBarHeld: 0,
		dietHeld: 0
	};
	if (venues.length === 0) return empty;

	const unitIds = venues.map((v) => v.id);
	const menus = db
		.prepare<{ id: number; meal: string; meal_sort: number }>(
			`SELECT id, meal, meal_sort FROM menu
			 WHERE service_date = ? AND unit_id IN (${placeholders(unitIds.length)})`
		)
		.all(params.date, ...unitIds);

	const byOrder = (a: string, b: string) => mealSort(a) - mealSort(b) || a.localeCompare(b);
	const sittings = [...new Set(menus.filter((m) => m.meal_sort < 99).map((m) => m.meal))].sort(
		byOrder
	);
	const stations = [...new Set(menus.filter((m) => m.meal_sort >= 99).map((m) => m.meal))].sort(
		byOrder
	);

	// With no sittings at all -- a station-only unit -- plan from everything.
	const meal =
		params.meal !== null && sittings.includes(params.meal)
			? params.meal
			: (params.defaultMeal?.(sittings) ?? sittings[0] ?? null);
	const menuIds = menus
		.filter((m) => m.meal_sort >= 99 || meal === null || m.meal === meal)
		.map((m) => m.id);
	if (menuIds.length === 0) return { ...empty, sittings, stations, meal };

	const rows = selectByIds<Row>(
		db,
		(list) => `SELECT mi.id AS menu_item_id, i.id AS item_id, i.slug, i.name_display,
		                  u.name AS venue_name, m.meal, mc.name AS category_name,
		                  mi.serving_size, nf.serving_size_text, nf.serving_grams,
		                  nf.calories, nf.protein_g, nf.total_carb_g, nf.total_fat_g,
		                  nf.fiber_g, nf.sugars_g, nf.sodium_mg, nf.sat_fat_g
		           FROM menu_item mi
		           JOIN menu m ON m.id = mi.menu_id
		           JOIN unit u ON u.id = m.unit_id
		           JOIN menu_category mc ON mc.id = mi.category_id
		           JOIN item i ON i.id = mi.item_id
		           JOIN nutrition_fact nf ON nf.id = mi.nutrition_fact_id
		           WHERE mi.menu_id IN (${list})
		           ORDER BY m.meal_sort, u.sort, u.name, mc.sort, mi.sort`,
		menuIds
	);
	// Inner join to nutrition_fact on purpose: a dish with no label has nothing
	// to plan with, and it cannot be checked for allergens either.

	const ids = rows.map((r) => r.menu_item_id);
	const traits = new Map<number, string[]>();
	for (const row of selectByIds<{ menu_item_id: number; slug: string }>(
		db,
		(list) => `SELECT mit.menu_item_id, t.slug FROM menu_item_trait mit
		           JOIN trait t ON t.id = mit.trait_id
		           WHERE t.is_diet = 1 AND mit.menu_item_id IN (${list})`,
		ids
	)) {
		const bucket = traits.get(row.menu_item_id) ?? [];
		bucket.push(row.slug);
		traits.set(row.menu_item_id, bucket);
	}

	const verdicts = isEmptyProfile(params.profile)
		? new Map()
		: getItemVerdicts(db, params.profile, ids);
	const diets = params.diets ?? [];

	let allergenHeld = 0;
	let saladBarHeld = 0;
	let dietHeld = 0;
	const candidates: Candidate[] = [];

	for (const r of rows) {
		const servingText =
			r.serving_size ?? r.serving_size_text?.replace(/\s*\(\d+(\.\d+)?\s*g\)\s*$/i, '') ?? null;
		const candidate: Candidate = {
			menuItemId: r.menu_item_id,
			itemId: r.item_id,
			slug: r.slug,
			name: r.name_display,
			venue: r.venue_name,
			station: r.meal,
			category: r.category_name,
			servingText,
			servingGrams: r.serving_grams,
			nutrients:
				r.calories === null ||
				r.protein_g === null ||
				r.total_carb_g === null ||
				r.total_fat_g === null
					? null
					: {
							calories: r.calories,
							proteinG: r.protein_g,
							carbG: r.total_carb_g,
							fatG: r.total_fat_g,
							fiberG: r.fiber_g,
							sugarG: r.sugars_g,
							sodiumMg: r.sodium_mg,
							satFatG: r.sat_fat_g
						},
			traits: traits.get(r.menu_item_id) ?? []
		};

		const summary = verdicts.get(r.menu_item_id);
		if (summary && (summary.hasWarning || summary.hasUnknown)) {
			allergenHeld++;
			continue;
		}
		if (params.skipSaladBar && isSaladBar(candidate)) {
			saladBarHeld++;
			continue;
		}
		if (diets.length > 0 && !diets.every((d) => candidate.traits.includes(d))) {
			dietHeld++;
			continue;
		}
		candidates.push(candidate);
	}

	return { sittings, stations, meal, candidates, allergenHeld, saladBarHeld, dietHeld };
}

// ---------------------------------------------------------------------------
// Body profile
// ---------------------------------------------------------------------------

interface ProfileRow {
	sex: string;
	age: number;
	height_cm: number;
	weight_kg: number;
	activity: string;
	goal: string;
	meals_per_day: number;
	units: string;
	calories_override: number | null;
	protein_override: number | null;
}

export function getBodyProfile(db: Db, userId: number): BodyProfile | null {
	const row = db
		.prepare<ProfileRow>(
			`SELECT sex, age, height_cm, weight_kg, activity, goal, meals_per_day, units,
			        calories_override, protein_override
			 FROM body_profile WHERE user_id = ?`
		)
		.get(userId);
	if (!row) return null;
	const profile = {
		sex: row.sex,
		age: row.age,
		heightCm: row.height_cm,
		weightKg: row.weight_kg,
		activity: row.activity,
		goal: row.goal,
		mealsPerDay: row.meals_per_day,
		units: row.units,
		caloriesOverride: row.calories_override,
		proteinOverride: row.protein_override
	};
	return isBodyProfile(profile) ? profile : null;
}

export function saveBodyProfile(db: Db, userId: number, p: BodyProfile, now = unixNow()): void {
	db.prepare(
		`INSERT INTO body_profile (user_id, sex, age, height_cm, weight_kg, activity, goal,
		                           meals_per_day, units, calories_override, protein_override, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
		   sex = excluded.sex, age = excluded.age, height_cm = excluded.height_cm,
		   weight_kg = excluded.weight_kg, activity = excluded.activity, goal = excluded.goal,
		   meals_per_day = excluded.meals_per_day, units = excluded.units,
		   calories_override = excluded.calories_override,
		   protein_override = excluded.protein_override, updated_at = excluded.updated_at`
	).run(
		userId,
		p.sex,
		p.age,
		p.heightCm,
		p.weightKg,
		p.activity,
		p.goal,
		p.mealsPerDay,
		p.units,
		p.caloriesOverride,
		p.proteinOverride,
		now
	);
}

export function deleteBodyProfile(db: Db, userId: number): void {
	db.prepare('DELETE FROM body_profile WHERE user_id = ?').run(userId);
}
