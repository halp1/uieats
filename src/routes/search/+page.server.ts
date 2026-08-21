import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { getAllergenProfile, getDietTags } from '$lib/server/queries/allergens';
import { searchItems } from '$lib/server/queries/search';
import { campusToday } from '$lib/dates';

export const load: PageServerLoad = ({ url, locals }) => {
	const db = getDb();
	const userId = locals.user?.id ?? null;
	const query = url.searchParams.get('q') ?? '';
	const hideFlagged = url.searchParams.get('safe') === '1';
	const diets = url.searchParams.getAll('diet');

	const profile = getAllergenProfile(db, userId);

	return {
		query,
		hideFlagged,
		diets,
		dietTags: getDietTags(db),
		allergenCount: profile.selection.length + profile.custom.length,
		hits: searchItems(db, {
			query,
			// Today onwards: search is for deciding what to eat next, and a dish
			// that was served yesterday is not a plan.
			fromDate: campusToday(),
			userId,
			profile,
			hideFlagged,
			diets
		})
	};
};
