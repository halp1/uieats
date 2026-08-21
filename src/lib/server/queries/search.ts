/**
 * Cross-hall dish search.
 *
 * The question this answers is one upstream cannot: "where can I get this, and
 * can I eat it?" Upstream search is per-venue, per-day, so finding a dish means
 * opening thirty-six menus.
 *
 * Matching is a plain LIKE against the normalized name. No FTS table: the
 * catalogue is a few thousand rows, a scan is sub-millisecond, and an FTS index
 * would need rebuilding on every scrape for no measurable gain. Conservative
 * normalization is also a safety property -- see the note on `item.name_norm`.
 */
import type { Db } from '../db/driver.ts';
import { getAllergenProfile, getItemVerdicts, type AllergenProfile } from './allergens.ts';
import { placeholders } from './sql.ts';

export interface SearchHit {
	itemId: number;
	slug: string;
	name: string;
	isFavorite: boolean;
	/** The soonest upcoming serving, which is what a user is deciding about. */
	next: {
		menuItemId: number;
		date: string;
		meal: string;
		venueName: string;
		venueSlug: string;
		hallSlug: string;
		hasLabel: boolean;
	} | null;
	/** Verdicts for that soonest serving. */
	worstVerdict: string | null;
	hasWarning: boolean;
	hasUnknown: boolean;
	/** How many upcoming servings in total. */
	servings: number;
}

export interface SearchParams {
	query: string;
	fromDate: string;
	userId?: number | null;
	profile?: AllergenProfile;
	/** Hide anything with a warning for the user's own allergens. */
	hideFlagged?: boolean;
	/** Only dishes carrying all of these diet trait slugs. */
	diets?: string[];
	limit?: number;
}

interface HitRow {
	item_id: number;
	slug: string;
	name_display: string;
	servings: number;
	menu_item_id: number;
	service_date: string;
	meal: string;
	venue_name: string;
	venue_slug: string;
	hall_slug: string | null;
	label_fetched_at: number | null;
}

export function searchItems(db: Db, params: SearchParams): SearchHit[] {
	const query = params.query.trim().toLowerCase();
	if (query.length < 2) return [];

	const limit = params.limit ?? 60;
	const userId = params.userId ?? null;
	const diets = params.diets ?? [];

	// One row per item: the soonest serving, plus a count of all of them.
	// Correlated subqueries rather than a window function, because the count and
	// the pick are over different orderings and SQLite plans this fine at this
	// scale.
	const dietFilter =
		diets.length === 0
			? ''
			: `AND (
			     SELECT COUNT(DISTINCT t.slug) FROM menu_item_trait mit
			     JOIN trait t ON t.id = mit.trait_id
			     WHERE mit.menu_item_id = soonest.id AND t.slug IN (${placeholders(diets.length)})
			   ) = ${diets.length}`;

	const rows = db
		.prepare<HitRow>(
			`SELECT i.id AS item_id, i.slug, i.name_display,
			        (SELECT COUNT(*) FROM menu_item mi2 JOIN menu m2 ON m2.id = mi2.menu_id
			         WHERE mi2.item_id = i.id AND m2.service_date >= ?) AS servings,
			        soonest.id AS menu_item_id, soonest.service_date, soonest.meal,
			        soonest.venue_name, soonest.venue_slug, soonest.hall_slug, soonest.label_fetched_at
			 FROM item i
			 JOIN (
			   SELECT mi.id, mi.item_id, m.service_date, m.meal, m.meal_sort,
			          u.name AS venue_name, u.slug AS venue_slug, p.slug AS hall_slug,
			          mi.label_fetched_at,
			          ROW_NUMBER() OVER (
			            PARTITION BY mi.item_id ORDER BY m.service_date, m.meal_sort, u.name
			          ) AS rn
			   FROM menu_item mi
			   JOIN menu m ON m.id = mi.menu_id
			   JOIN unit u ON u.id = m.unit_id
			   LEFT JOIN unit p ON p.id = u.parent_id
			   WHERE m.service_date >= ?
			 ) soonest ON soonest.item_id = i.id AND soonest.rn = 1
			 WHERE i.name_norm LIKE ? ${dietFilter}
			 ORDER BY
			   -- A name that starts with the query is almost always what was meant.
			   CASE WHEN i.name_norm LIKE ? THEN 0 ELSE 1 END,
			   LENGTH(i.name_norm),
			   i.name_norm
			 LIMIT ?`
		)
		.all(
			params.fromDate,
			params.fromDate,
			`%${query}%`,
			...diets,
			`${query}%`,
			// Over-fetch, because the allergen filter is applied after: it needs
			// verdicts, and verdicts need the rows.
			params.hideFlagged ? limit * 4 : limit
		);

	const profile = params.profile ?? getAllergenProfile(db, userId);
	const verdicts = getItemVerdicts(
		db,
		profile,
		rows.map((r) => r.menu_item_id)
	);

	const favorites = new Set<number>();
	if (userId !== null) {
		for (const row of db
			.prepare<{ item_id: number }>('SELECT item_id FROM favorite WHERE user_id = ?')
			.all(userId)) {
			favorites.add(row.item_id);
		}
	}

	const hits: SearchHit[] = [];
	for (const row of rows) {
		const summary = verdicts.get(row.menu_item_id) ?? null;

		// The filter hides warnings only. An item whose verdict is `unknown` is
		// deliberately KEPT: hiding it would quietly present "we have not checked"
		// as "this passed the filter", which is the one confusion this whole
		// codebase is built to avoid.
		if (params.hideFlagged && summary?.hasWarning) continue;

		hits.push({
			itemId: row.item_id,
			slug: row.slug,
			name: row.name_display,
			isFavorite: favorites.has(row.item_id),
			next: {
				menuItemId: row.menu_item_id,
				date: row.service_date,
				meal: row.meal,
				venueName: row.venue_name,
				venueSlug: row.venue_slug,
				hallSlug: row.hall_slug ?? row.venue_slug,
				hasLabel: row.label_fetched_at !== null
			},
			worstVerdict: summary?.worst?.verdict ?? null,
			hasWarning: summary?.hasWarning ?? false,
			hasUnknown: summary?.hasUnknown ?? false,
			servings: row.servings
		});

		if (hits.length >= limit) break;
	}

	return hits;
}

export interface FavoriteToday {
	itemId: number;
	slug: string;
	name: string;
	date: string;
	meal: string;
	venueName: string;
	venueSlug: string;
	hallSlug: string;
	hasWarning: boolean;
	hasUnknown: boolean;
}

/** "Your favourites today" -- the reason to save a dish in the first place. */
export function getFavoritesServedFrom(
	db: Db,
	userId: number,
	fromDate: string,
	toDate: string,
	profile?: AllergenProfile
): FavoriteToday[] {
	const rows = db
		.prepare<{
			item_id: number;
			slug: string;
			name_display: string;
			menu_item_id: number;
			service_date: string;
			meal: string;
			venue_name: string;
			venue_slug: string;
			hall_slug: string | null;
		}>(
			`SELECT i.id AS item_id, i.slug, i.name_display, mi.id AS menu_item_id,
			        m.service_date, m.meal, u.name AS venue_name, u.slug AS venue_slug, p.slug AS hall_slug
			 FROM favorite f
			 JOIN item i ON i.id = f.item_id
			 JOIN menu_item mi ON mi.item_id = i.id
			 JOIN menu m ON m.id = mi.menu_id
			 JOIN unit u ON u.id = m.unit_id
			 LEFT JOIN unit p ON p.id = u.parent_id
			 WHERE f.user_id = ? AND m.service_date BETWEEN ? AND ?
			 ORDER BY m.service_date, m.meal_sort, u.name, i.name_display`
		)
		.all(userId, fromDate, toDate);

	const resolved = profile ?? getAllergenProfile(db, userId);
	const verdicts = getItemVerdicts(
		db,
		resolved,
		rows.map((r) => r.menu_item_id)
	);

	return rows.map((row) => {
		const summary = verdicts.get(row.menu_item_id);
		return {
			itemId: row.item_id,
			slug: row.slug,
			name: row.name_display,
			date: row.service_date,
			meal: row.meal,
			venueName: row.venue_name,
			venueSlug: row.venue_slug,
			hallSlug: row.hall_slug ?? row.venue_slug,
			hasWarning: summary?.hasWarning ?? false,
			hasUnknown: summary?.hasUnknown ?? false
		};
	});
}
