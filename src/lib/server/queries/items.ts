/**
 * One dish, and where to find it.
 *
 * An `item` is the canonical dish; a `menu_item` is one appearance of it on one
 * menu at one venue. The distinction matters here more than anywhere else in
 * the app, because nutrition and allergens are recorded per APPEARANCE. The
 * same name can be a different recipe at a different venue, and collapsing
 * those would let one inherit the other's allergens -- a safety bug, not a data
 * bug.
 *
 * So this page shows appearances, each with its own label, rather than one
 * merged summary of a dish.
 */
import type { ItemAllergenSummary } from '../allergens/verdict.ts';
import type { Db } from '../db/driver.ts';
import { getAllergenProfile, getItemVerdicts, type AllergenProfile } from './allergens.ts';
import type { TraitView } from './menus.ts';
import { placeholders } from './sql.ts';

export interface ItemIdentity {
	id: number;
	slug: string;
	name: string;
}

export interface NutritionFacts {
	servingSizeText: string | null;
	servingGrams: number | null;
	calories: number | null;
	calFromFat: number | null;
	totalFatG: number | null;
	satFatG: number | null;
	transFatG: number | null;
	polyFatG: number | null;
	monoFatG: number | null;
	cholesterolMg: number | null;
	sodiumMg: number | null;
	potassiumMg: number | null;
	totalCarbG: number | null;
	fiberG: number | null;
	fiberIsLessThan: boolean;
	sugarsG: number | null;
	proteinG: number | null;
	vitADv: number | null;
	vitCDv: number | null;
	calciumDv: number | null;
	ironDv: number | null;
	ingredientsText: string | null;
	containsText: string | null;
	/** Upstream's cross-contact advisory, verbatim, or null. */
	mayContainText: string | null;
	hiddenSources: string[];
	components: { componentName: string; ingredientText: string | null }[];
}

export interface Appearance {
	menuItemId: number;
	date: string;
	meal: string;
	venueName: string;
	venueSlug: string;
	hallSlug: string;
	servingSize: string | null;
	hasLabel: boolean;
	traits: TraitView[];
	allergens: ItemAllergenSummary | null;
	nutrition: NutritionFacts | null;
}

export interface ItemDetail {
	item: ItemIdentity;
	isFavorite: boolean;
	appearances: Appearance[];
	/** The nutrition to show at the top: the soonest appearance that has any. */
	primary: Appearance | null;
	nextServed: Appearance | null;
}

interface AppearanceRow {
	menu_item_id: number;
	service_date: string;
	meal: string;
	meal_sort: number;
	venue_name: string;
	venue_slug: string;
	hall_slug: string | null;
	serving_size: string | null;
	label_fetched_at: number | null;
	fact_id: number | null;
	serving_size_text: string | null;
	serving_grams: number | null;
	calories: number | null;
	cal_from_fat: number | null;
	total_fat_g: number | null;
	sat_fat_g: number | null;
	trans_fat_g: number | null;
	poly_fat_g: number | null;
	mono_fat_g: number | null;
	cholesterol_mg: number | null;
	sodium_mg: number | null;
	potassium_mg: number | null;
	total_carb_g: number | null;
	fiber_g: number | null;
	fiber_is_lt: number;
	sugars_g: number | null;
	protein_g: number | null;
	vit_a_dv: number | null;
	vit_c_dv: number | null;
	calcium_dv: number | null;
	iron_dv: number | null;
	ingredients_text: string | null;
	contains_text: string | null;
	may_contain_text: string | null;
	hidden_sources: string | null;
}

function toFacts(
	row: AppearanceRow,
	components: { componentName: string; ingredientText: string | null }[]
): NutritionFacts {
	return {
		servingSizeText: row.serving_size_text,
		servingGrams: row.serving_grams,
		calories: row.calories,
		calFromFat: row.cal_from_fat,
		totalFatG: row.total_fat_g,
		satFatG: row.sat_fat_g,
		transFatG: row.trans_fat_g,
		polyFatG: row.poly_fat_g,
		monoFatG: row.mono_fat_g,
		cholesterolMg: row.cholesterol_mg,
		sodiumMg: row.sodium_mg,
		potassiumMg: row.potassium_mg,
		totalCarbG: row.total_carb_g,
		fiberG: row.fiber_g,
		fiberIsLessThan: row.fiber_is_lt === 1,
		sugarsG: row.sugars_g,
		proteinG: row.protein_g,
		vitADv: row.vit_a_dv,
		vitCDv: row.vit_c_dv,
		calciumDv: row.calcium_dv,
		ironDv: row.iron_dv,
		ingredientsText: row.ingredients_text,
		containsText: row.contains_text,
		mayContainText: row.may_contain_text,
		hiddenSources: row.hidden_sources ? row.hidden_sources.split('|') : [],
		components
	};
}

export function getItemBySlug(db: Db, slug: string): ItemIdentity | null {
	const row = db
		.prepare<{ id: number; slug: string; name_display: string }>(
			'SELECT id, slug, name_display FROM item WHERE slug = ?'
		)
		.get(slug);
	return row ? { id: row.id, slug: row.slug, name: row.name_display } : null;
}

export function getItemDetail(
	db: Db,
	item: ItemIdentity,
	options: { fromDate: string; userId?: number | null; profile?: AllergenProfile }
): ItemDetail {
	const userId = options.userId ?? null;

	// Recent past plus everything ahead. A dish served yesterday is worth
	// showing -- it says what the label said last time -- but a term of history
	// is not, and the label is per-appearance anyway.
	const rows = db
		.prepare<AppearanceRow>(
			`SELECT mi.id AS menu_item_id, m.service_date, m.meal, m.meal_sort,
			        u.name AS venue_name, u.slug AS venue_slug, p.slug AS hall_slug,
			        mi.serving_size, mi.label_fetched_at, nf.id AS fact_id,
			        nf.serving_size_text, nf.serving_grams, nf.calories, nf.cal_from_fat,
			        nf.total_fat_g, nf.sat_fat_g, nf.trans_fat_g, nf.poly_fat_g, nf.mono_fat_g,
			        nf.cholesterol_mg, nf.sodium_mg, nf.potassium_mg, nf.total_carb_g,
			        nf.fiber_g, nf.fiber_is_lt, nf.sugars_g, nf.protein_g,
			        nf.vit_a_dv, nf.vit_c_dv, nf.calcium_dv, nf.iron_dv,
			        nf.ingredients_text, nf.contains_text, nf.may_contain_text, nf.hidden_sources
			 FROM menu_item mi
			 JOIN menu m ON m.id = mi.menu_id
			 JOIN unit u ON u.id = m.unit_id
			 LEFT JOIN unit p ON p.id = u.parent_id
			 LEFT JOIN nutrition_fact nf ON nf.id = mi.nutrition_fact_id
			 WHERE mi.item_id = ? AND m.service_date >= ?
			 ORDER BY m.service_date, m.meal_sort, u.name`
		)
		.all(item.id, options.fromDate);

	const menuItemIds = rows.map((r) => r.menu_item_id);
	const profile = options.profile ?? getAllergenProfile(db, userId);
	const verdicts = getItemVerdicts(db, profile, menuItemIds);

	const traitRows =
		menuItemIds.length === 0
			? []
			: db
					.prepare<{ menu_item_id: number; slug: string; label: string; is_diet: number }>(
						`SELECT mit.menu_item_id, t.slug, t.label, t.is_diet
						 FROM menu_item_trait mit JOIN trait t ON t.id = mit.trait_id
						 WHERE mit.menu_item_id IN (${placeholders(menuItemIds.length)})
						 ORDER BY t.is_diet, t.label`
					)
					.all(...menuItemIds);

	const traitsByItem = new Map<number, TraitView[]>();
	for (const row of traitRows) {
		const bucket = traitsByItem.get(row.menu_item_id) ?? [];
		bucket.push({ slug: row.slug, label: row.label, isDiet: row.is_diet === 1 });
		traitsByItem.set(row.menu_item_id, bucket);
	}

	// Recipe components, once per distinct fact rather than per appearance.
	const factIds = [
		...new Set(rows.map((r) => r.fact_id).filter((id): id is number => id !== null))
	];
	const componentsByFact = new Map<
		number,
		{ componentName: string; ingredientText: string | null }[]
	>();
	if (factIds.length > 0) {
		for (const row of db
			.prepare<{
				nutrition_fact_id: number;
				component_name: string;
				ingredient_text: string | null;
			}>(
				`SELECT nutrition_fact_id, component_name, ingredient_text FROM recipe_ingredient
				 WHERE nutrition_fact_id IN (${placeholders(factIds.length)}) ORDER BY nutrition_fact_id, sort`
			)
			.all(...factIds)) {
			const bucket = componentsByFact.get(row.nutrition_fact_id) ?? [];
			bucket.push({ componentName: row.component_name, ingredientText: row.ingredient_text });
			componentsByFact.set(row.nutrition_fact_id, bucket);
		}
	}

	const appearances: Appearance[] = rows.map((row) => ({
		menuItemId: row.menu_item_id,
		date: row.service_date,
		meal: row.meal,
		venueName: row.venue_name,
		venueSlug: row.venue_slug,
		// A standalone unit is its own hall in the URL, so fall back to itself.
		hallSlug: row.hall_slug ?? row.venue_slug,
		servingSize: row.serving_size,
		hasLabel: row.label_fetched_at !== null,
		traits: traitsByItem.get(row.menu_item_id) ?? [],
		allergens: verdicts.get(row.menu_item_id) ?? null,
		nutrition: row.fact_id === null ? null : toFacts(row, componentsByFact.get(row.fact_id) ?? [])
	}));

	const isFavorite =
		userId !== null &&
		db
			.prepare<{ item_id: number }>(
				'SELECT item_id FROM favorite WHERE user_id = ? AND item_id = ?'
			)
			.get(userId, item.id) !== undefined;

	return {
		item,
		isFavorite,
		appearances,
		primary: appearances.find((a) => a.nutrition !== null) ?? null,
		nextServed: appearances[0] ?? null
	};
}
