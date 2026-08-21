/**
 * Shell data: who the visitor is, and how stale the menus are.
 *
 * Freshness is in the layout rather than on individual pages because it
 * qualifies everything, not one screen. A menu page that silently shows
 * three-day-old data is worse than one that shows nothing.
 */
import type { LayoutServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { getAllergenSelection } from '$lib/server/queries/allergens';
import { STALE_AFTER_SECONDS, campusToday, unixNow } from '$lib/server/time';

export const load: LayoutServerLoad = ({ locals }) => {
	const db = getDb();

	const lastRun = db
		.prepare<{ finished_at: number | null }>(
			`SELECT finished_at FROM scrape_run
			 WHERE status IN ('ok', 'partial') AND finished_at IS NOT NULL
			 ORDER BY finished_at DESC LIMIT 1`
		)
		.get();

	const lastUpdated = lastRun?.finished_at ?? null;

	return {
		user: locals.user,
		today: campusToday(),
		lastUpdated,
		isStale: lastUpdated === null || unixNow() - lastUpdated > STALE_AFTER_SECONDS,
		// The count, not the selection: the nav shows "3 allergens" and the
		// browse pages load the full objects themselves.
		allergenCount: getAllergenSelection(db, locals.user?.id ?? null).length
	};
};
