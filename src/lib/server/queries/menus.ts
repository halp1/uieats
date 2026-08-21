/**
 * The one loader behind all three browse levels.
 *
 * `getMenusForScope` returns the same shape whether the scope is a whole hall
 * or a single venue: the venue route passes a `venueId` (an array of one), the
 * hall route omits it (an array of N). Both render the same component and
 * differ only in the wrapper, which is what makes "the whole hall at once" --
 * the thing upstream cannot do at all -- cost nothing extra to offer.
 *
 * Cost is four statements for the menu tree plus five for allergen evidence,
 * regardless of how many items are in scope. Everything is grouped in
 * TypeScript afterwards. A hall-day is ~150 items across ~10 venues; doing it
 * per venue or per item would be dozens of round trips for data one statement
 * returns.
 */
import type { ItemAllergenSummary } from '../allergens/verdict.ts';
import type { Db } from '../db/driver.ts';
import { mealSort } from '../../dates.ts';
import { getAllergenSelection, getItemVerdicts, type AllergenSelection } from './allergens.ts';
import { placeholders } from './sql.ts';
import {
	getHoursFor,
	getUnitStatuses,
	getVenuesOf,
	type UnitRef,
	type VenueHours
} from './units.ts';

export interface TraitView {
	slug: string;
	label: string;
	isDiet: boolean;
}

export interface MenuItemView {
	menuItemId: number;
	itemId: number;
	slug: string;
	name: string;
	servingSize: string | null;
	calories: number | null;
	/** False means no nutrition label has been fetched for this instance yet. */
	hasLabel: boolean;
	traits: TraitView[];
	/** null for anonymous users, who see no chips at all. */
	allergens: ItemAllergenSummary | null;
	isFavorite: boolean;
}

export interface CategoryView {
	id: number;
	name: string;
	/**
	 * True when upstream gave this course no name.
	 *
	 * It marks an unnamed course with the sentinel id -1234 and the literal
	 * label "None", and persistence synthesizes an empty name if a heading is
	 * missing entirely. Either way the items are real and the heading is not, so
	 * the UI shows the dishes without one -- a category called "None" reads as a
	 * bug, and dropping the dishes to avoid it would be far worse.
	 */
	isUncategorised: boolean;
	items: MenuItemView[];
}

export interface MealView {
	menuId: number;
	meal: string;
	mealSort: number;
	/** Items actually returned, which is what a heading should count. */
	itemCount: number;
	categories: CategoryView[];
}

export interface VenueView {
	venue: UnitRef;
	status: { isOpen: boolean; observedAt: number } | null;
	hours: VenueHours;
	meals: MealView[];
}

export interface ScopeResult {
	date: string;
	/** The hall or standalone unit the scope is rooted at. */
	root: UnitRef;
	venues: VenueView[];
	/** Every distinct meal name in scope, ordered -- the hall view's tab bar. */
	meals: string[];
	itemCount: number;
}

export interface ScopeParams {
	date: string;
	root: UnitRef;
	/** Restrict to one venue. Omit for the whole hall. */
	venueId?: number;
	userId?: number | null;
	/** Pre-resolved selection, so a page rendering several scopes loads it once. */
	selection?: AllergenSelection[];
	/**
	 * Show only dishes carrying ALL of these diet trait slugs.
	 *
	 * Applied to items, not menus: a venue keeps its meals and categories even
	 * when nothing in them matches, because an empty category under a filter is
	 * information ("nothing vegan on the grill today") and a vanished one is not.
	 */
	diets?: string[];
}

interface MenuRow {
	menu_id: number;
	unit_id: number;
	meal: string;
	meal_sort: number;
	item_count: number;
}

interface ItemRow {
	menu_id: number;
	category_id: number;
	category_name: string;
	nn_category_id: number;
	category_sort: number;
	menu_item_id: number;
	item_id: number;
	slug: string;
	name_display: string;
	serving_size: string | null;
	sort: number;
	label_fetched_at: number | null;
	calories: number | null;
}

interface TraitRow {
	menu_item_id: number;
	slug: string;
	label: string;
	is_diet: number;
}

export function getMenusForScope(db: Db, params: ScopeParams): ScopeResult {
	const { date, root } = params;
	const userId = params.userId ?? null;

	const allVenues = getVenuesOf(db, root);
	const venues =
		params.venueId === undefined ? allVenues : allVenues.filter((v) => v.id === params.venueId);

	if (venues.length === 0) {
		return { date, root, venues: [], meals: [], itemCount: 0 };
	}

	const unitIds = venues.map((v) => v.id);
	const list = placeholders(unitIds.length);

	const menuRows = db
		.prepare<MenuRow>(
			`SELECT id AS menu_id, unit_id, meal, meal_sort, item_count
			 FROM menu
			 WHERE service_date = ? AND unit_id IN (${list})
			 ORDER BY meal_sort, meal`
		)
		.all(date, ...unitIds);

	const menuIds = menuRows.map((m) => m.menu_id);

	// One statement for every item on every menu in scope. The left join to
	// nutrition_fact is what tells the UI whether a label exists at all --
	// label_fetched_at IS NULL is the difference between "no milk declared" and
	// "we have not looked".
	const itemRows =
		menuIds.length === 0
			? []
			: db
					.prepare<ItemRow>(
						`SELECT mi.menu_id, mc.id AS category_id, mc.name AS category_name,
						        mc.nn_category_id, mc.sort AS category_sort,
						        mi.id AS menu_item_id, i.id AS item_id, i.slug, i.name_display,
						        mi.serving_size, mi.sort, mi.label_fetched_at, nf.calories
						 FROM menu_item mi
						 JOIN menu_category mc ON mc.id = mi.category_id
						 JOIN item i ON i.id = mi.item_id
						 LEFT JOIN nutrition_fact nf ON nf.id = mi.nutrition_fact_id
						 WHERE mi.menu_id IN (${placeholders(menuIds.length)})
						 ORDER BY mi.menu_id, mc.sort, mi.sort`
					)
					.all(...menuIds);

	const menuItemIds = itemRows.map((r) => r.menu_item_id);

	const traitRows =
		menuItemIds.length === 0
			? []
			: db
					.prepare<TraitRow>(
						`SELECT mit.menu_item_id, t.slug, t.label, t.is_diet
						 FROM menu_item_trait mit JOIN trait t ON t.id = mit.trait_id
						 WHERE mit.menu_item_id IN (${placeholders(menuItemIds.length)})
						 ORDER BY t.is_diet, t.label`
					)
					.all(...menuItemIds);

	const favorites = new Set<number>();
	if (userId !== null) {
		for (const row of db
			.prepare<{ item_id: number }>('SELECT item_id FROM favorite WHERE user_id = ?')
			.all(userId)) {
			favorites.add(row.item_id);
		}
	}

	const selection = params.selection ?? getAllergenSelection(db, userId);
	const verdicts = getItemVerdicts(db, selection, menuItemIds);

	const traitsByItem = new Map<number, TraitView[]>();
	for (const row of traitRows) {
		const bucket = traitsByItem.get(row.menu_item_id) ?? [];
		bucket.push({ slug: row.slug, label: row.label, isDiet: row.is_diet === 1 });
		traitsByItem.set(row.menu_item_id, bucket);
	}

	// Diet filtering happens here rather than in SQL: the trait rows are already
	// loaded, and doing it in the query would need a HAVING over a join that the
	// allergen pass then has to repeat.
	const diets = params.diets ?? [];
	const matchesDiet = (menuItemId: number) => {
		if (diets.length === 0) return true;
		const traits = traitsByItem.get(menuItemId);
		if (!traits) return false;
		return diets.every((slug) => traits.some((t) => t.slug === slug));
	};

	// Group into menu -> category -> item, preserving the SQL ordering.
	const categoriesByMenu = new Map<number, Map<number, CategoryView>>();
	for (const row of itemRows) {
		if (!matchesDiet(row.menu_item_id)) continue;

		let categories = categoriesByMenu.get(row.menu_id);
		if (!categories) {
			categories = new Map();
			categoriesByMenu.set(row.menu_id, categories);
		}
		let category = categories.get(row.category_id);
		if (!category) {
			category = {
				id: row.category_id,
				name: row.category_name,
				isUncategorised:
					row.nn_category_id < 0 || row.category_name.trim() === '' || row.category_name === 'None',
				items: []
			};
			categories.set(row.category_id, category);
		}

		category.items.push({
			menuItemId: row.menu_item_id,
			itemId: row.item_id,
			slug: row.slug,
			name: row.name_display,
			servingSize: row.serving_size,
			calories: row.calories,
			hasLabel: row.label_fetched_at !== null,
			traits: traitsByItem.get(row.menu_item_id) ?? [],
			allergens: verdicts.get(row.menu_item_id) ?? null,
			isFavorite: favorites.has(row.item_id)
		});
	}

	const menusByUnit = new Map<number, MealView[]>();
	for (const menu of menuRows) {
		const bucket = menusByUnit.get(menu.unit_id) ?? [];
		const categories = [...(categoriesByMenu.get(menu.menu_id)?.values() ?? [])];
		bucket.push({
			menuId: menu.menu_id,
			meal: menu.meal,
			mealSort: menu.meal_sort,
			// Counted from what is being returned, not from menu.item_count: under
			// a diet filter the stored total would over-report, and a heading that
			// says 14 items above 3 rows is worse than no heading.
			itemCount: categories.reduce((sum, c) => sum + c.items.length, 0),
			categories
		});
		menusByUnit.set(menu.unit_id, bucket);
	}

	const hours = getHoursFor(db, unitIds, date);
	const statuses = getUnitStatuses(db, unitIds);

	const venueViews: VenueView[] = venues.map((venue) => ({
		venue,
		status: statuses.get(venue.id) ?? null,
		hours: hours.get(venue.id) ?? { today: [], publishesSchedule: false },
		meals: menusByUnit.get(venue.id) ?? []
	}));

	// The hall view's tab bar spans venues: not every venue serves every meal,
	// and a tab per venue-meal would be unusable.
	const mealNames = [...new Set(menuRows.map((m) => m.meal))].sort(
		(a, b) => mealSort(a) - mealSort(b) || a.localeCompare(b)
	);

	return {
		date,
		root,
		venues: venueViews,
		meals: mealNames,
		// Post-filter, so the heading counts what is actually on screen.
		itemCount: venueViews.reduce(
			(sum, v) =>
				sum +
				v.meals.reduce(
					(mealSum, m) => mealSum + m.categories.reduce((c, cat) => c + cat.items.length, 0),
					0
				),
			0
		)
	};
}

/** Which units have any menu at all on a date -- the date-index page. */
export function getUnitsServingOn(db: Db, date: string): Map<number, number> {
	const out = new Map<number, number>();
	for (const row of db
		.prepare<{ unit_id: number; menus: number; items: number }>(
			`SELECT unit_id, COUNT(*) AS menus, COALESCE(SUM(item_count), 0) AS items
			 FROM menu WHERE service_date = ? GROUP BY unit_id`
		)
		.all(date)) {
		out.set(row.unit_id, row.items);
	}
	return out;
}

/** The dates we actually hold menus for, for the date picker's bounds. */
export function getDateRange(db: Db): { min: string; max: string } | null {
	const row = db
		.prepare<{ min: string | null; max: string | null }>(
			'SELECT MIN(service_date) AS min, MAX(service_date) AS max FROM menu'
		)
		.get();
	if (!row?.min || !row.max) return null;
	return { min: row.min, max: row.max };
}
