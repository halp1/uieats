/**
 * Shell data: who the visitor is, and how stale the menus are.
 *
 * Freshness is in the layout rather than on individual pages because it
 * qualifies everything, not one screen. A menu page that silently shows
 * three-day-old data is worse than one that shows nothing.
 */
import type { LayoutServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { getFreshness } from '$lib/server/health';
import { getAllergenSelection } from '$lib/server/queries/allergens';
import { campusToday } from '$lib/dates';

export const load: LayoutServerLoad = ({ locals }) => {
	const db = getDb();
	const { lastSuccessAt, isStale } = getFreshness(db);

	return {
		user: locals.user,
		today: campusToday(),
		lastUpdated: lastSuccessAt,
		isStale,
		// The count, not the selection: the nav shows "3 allergens" and the
		// browse pages load the full objects themselves.
		allergenCount: getAllergenSelection(db, locals.user?.id ?? null).length
	};
};
