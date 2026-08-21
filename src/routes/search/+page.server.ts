import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { getAllergenSelection, getDietTags } from '$lib/server/queries/allergens';
import { searchItems } from '$lib/server/queries/search';
import { campusToday } from '$lib/server/time';

export const load: PageServerLoad = ({ url, locals }) => {
	const db = getDb();
	const userId = locals.user?.id ?? null;
	const query = url.searchParams.get('q') ?? '';
	const hideFlagged = url.searchParams.get('safe') === '1';
	const diets = url.searchParams.getAll('diet');

	const selection = getAllergenSelection(db, userId);

	return {
		query,
		hideFlagged,
		diets,
		dietTags: getDietTags(db),
		allergenCount: selection.length,
		hits: searchItems(db, {
			query,
			// Today onwards: search is for deciding what to eat next, and a dish
			// that was served yesterday is not a plan.
			fromDate: campusToday(),
			userId,
			selection,
			hideFlagged,
			diets
		})
	};
};
