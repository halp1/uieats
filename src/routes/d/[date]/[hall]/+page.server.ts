/**
 * A whole hall for a day -- every venue, every meal, in one page.
 *
 * This is the view upstream cannot offer at all: there, seeing nine venues
 * means eighteen round trips and a nutrition label click per dish. Here it is
 * one query, because `getMenusForScope` takes an optional venue filter and the
 * hall route simply omits it.
 *
 * A standalone unit (eight of the twelve top-level units are one) resolves to
 * itself as its only venue, so this route renders those too without branching.
 */
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { getAllergenSelection } from '$lib/server/queries/allergens';
import { getMenusForScope } from '$lib/server/queries/menus';
import { getUnitBySlug } from '$lib/server/queries/units';
import { campusToday } from '$lib/server/time';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const load: PageServerLoad = ({ params, locals }) => {
	if (!DATE_PATTERN.test(params.date)) error(400, 'Dates look like 2026-08-21.');

	const db = getDb();
	const root = getUnitBySlug(db, params.hall);
	if (!root) error(404, 'No dining location with that name.');

	const userId = locals.user?.id ?? null;
	const scope = getMenusForScope(db, {
		date: params.date,
		root,
		userId,
		selection: getAllergenSelection(db, userId)
	});

	return { date: params.date, today: campusToday(), scope };
};
