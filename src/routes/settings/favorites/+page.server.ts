import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { getAllergenSelection } from '$lib/server/queries/allergens';
import { getFavoritesServedFrom } from '$lib/server/queries/search';
import { addDays, campusToday } from '$lib/server/time';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) redirect(303, '/auth/login?next=/settings/favorites');

	const db = getDb();
	const today = campusToday();
	const selection = getAllergenSelection(db, locals.user.id);

	// A week ahead: "your favourites today" is the point of saving a dish, and
	// the few days after are what make it worth checking again tomorrow.
	const upcoming = getFavoritesServedFrom(db, locals.user.id, today, addDays(today, 7), selection);

	// Saved dishes that are not on any upcoming menu still need listing --
	// otherwise the page looks like the save silently failed.
	const scheduledIds = new Set(upcoming.map((f) => f.itemId));
	const dormant = db
		.prepare<{ item_id: number; slug: string; name_display: string }>(
			`SELECT f.item_id, i.slug, i.name_display
			 FROM favorite f JOIN item i ON i.id = f.item_id
			 WHERE f.user_id = ? ORDER BY i.name_display`
		)
		.all(locals.user.id)
		.filter((row) => !scheduledIds.has(row.item_id));

	return { today, upcoming, dormant };
};

export const actions: Actions = {
	remove: async ({ locals, request }) => {
		if (!locals.user) redirect(303, '/auth/login?next=/settings/favorites');

		const form = await request.formData();
		const itemId = Number(form.get('itemId'));
		if (!Number.isInteger(itemId)) return fail(400, { message: 'Unknown dish.' });

		getDb()
			.prepare('DELETE FROM favorite WHERE user_id = ? AND item_id = ?')
			.run(locals.user.id, itemId);
		return { removed: true };
	}
};
