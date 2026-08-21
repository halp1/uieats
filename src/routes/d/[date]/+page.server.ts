/**
 * Every dining location for one day.
 *
 * This page deliberately does not load menus -- twelve halls of items is a lot
 * of rows for a page whose only job is "which building". It loads counts, so a
 * closed or unpublished venue is visibly empty rather than a dead link.
 */
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { getDateRange, getUnitsServingOn } from '$lib/server/queries/menus';
import { getUnitStatuses, getUnitTree } from '$lib/server/queries/units';
import { campusToday } from '$lib/dates';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const load: PageServerLoad = ({ params }) => {
	if (!DATE_PATTERN.test(params.date)) {
		error(400, 'Dates look like 2026-08-21.');
	}

	const db = getDb();
	const halls = getUnitTree(db);
	const itemCounts = getUnitsServingOn(db, params.date);
	const statuses = getUnitStatuses(
		db,
		halls.flatMap((h) => [h.id, ...h.venues.map((v) => v.id)])
	);

	return {
		date: params.date,
		today: campusToday(),
		range: getDateRange(db),
		halls: halls.map((hall) => ({
			...hall,
			// A standalone unit publishes menus against itself; a hall's items all
			// live under its venues. Summing both covers each without branching.
			items:
				(itemCounts.get(hall.id) ?? 0) +
				hall.venues.reduce((sum, v) => sum + (itemCounts.get(v.id) ?? 0), 0),
			venues: hall.venues.map((venue) => ({
				...venue,
				items: itemCounts.get(venue.id) ?? 0,
				status: statuses.get(venue.id) ?? null
			})),
			status: statuses.get(hall.id) ?? null
		}))
	};
};
