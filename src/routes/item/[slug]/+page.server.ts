import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { getAllergenSelection } from '$lib/server/queries/allergens';
import { getItemBySlug, getItemDetail } from '$lib/server/queries/items';
import { addDays, campusToday, unixNow } from '$lib/server/time';

export const load: PageServerLoad = ({ params, locals }) => {
	const db = getDb();
	const item = getItemBySlug(db, params.slug);
	if (!item) error(404, 'No dish with that name.');

	const userId = locals.user?.id ?? null;
	const today = campusToday();

	return {
		today,
		detail: getItemDetail(db, item, {
			// Yesterday onwards: what a dish's label said the last time it was
			// served is useful, a term of history is not.
			fromDate: addDays(today, -1),
			userId,
			selection: getAllergenSelection(db, userId)
		})
	};
};

export const actions: Actions = {
	/** Toggle this dish as a favourite. Progressive: works without JS. */
	favorite: async ({ params, locals, request }) => {
		if (!locals.user) redirect(303, `/auth/login?next=/item/${params.slug}`);

		const db = getDb();
		const item = getItemBySlug(db, params.slug);
		if (!item) return fail(404, { message: 'No dish with that name.' });

		const form = await request.formData();
		if (form.get('on') === 'true') {
			db.prepare(
				'INSERT OR IGNORE INTO favorite (user_id, item_id, created_at) VALUES (?, ?, ?)'
			).run(locals.user.id, item.id, unixNow());
		} else {
			db.prepare('DELETE FROM favorite WHERE user_id = ? AND item_id = ?').run(
				locals.user.id,
				item.id
			);
		}

		return { ok: true };
	}
};
