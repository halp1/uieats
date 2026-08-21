/**
 * One venue for a day.
 *
 * Identical loader to the hall route, plus a `venueId`. That is the whole
 * difference: the query returns the same shape either way, so both render the
 * same component.
 */
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { getAllergenSelection, getDietTags } from '$lib/server/queries/allergens';
import { getMenusForScope } from '$lib/server/queries/menus';
import { getUnitBySlug } from '$lib/server/queries/units';
import { campusToday } from '$lib/dates';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const load: PageServerLoad = ({ params, locals, url }) => {
	if (!DATE_PATTERN.test(params.date)) error(400, 'Dates look like 2026-08-21.');

	const db = getDb();
	const root = getUnitBySlug(db, params.hall);
	if (!root) error(404, 'No dining location with that name.');

	// Venue slugs are unique within a parent, not globally -- "Build Your Own"
	// exists under four different halls -- so the lookup is scoped.
	const venue = getUnitBySlug(db, params.venue, root.id);
	if (!venue) error(404, `${root.name} has no venue with that name.`);

	const userId = locals.user?.id ?? null;
	// Diet filters live in the URL, not in component state: "Ike, vegan, today"
	// is a link worth sending someone, and it costs no client JavaScript.
	const diets = url.searchParams.getAll('diet');

	const scope = getMenusForScope(db, {
		date: params.date,
		root,
		diets,
		venueId: venue.id,
		userId,
		selection: getAllergenSelection(db, userId)
	});

	return {
		date: params.date,
		today: campusToday(),
		scope,
		venue,
		diets,
		dietTags: getDietTags(db)
	};
};
