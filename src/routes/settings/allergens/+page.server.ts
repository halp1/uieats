import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { getAllergenTree, getDietTags } from '$lib/server/queries/allergens';
import { unixNow } from '$lib/server/time';

export const load: PageServerLoad = ({ locals, url }) => {
	if (!locals.user) redirect(303, '/auth/login?next=/settings/allergens');

	const db = getDb();
	const selected = new Set(
		db
			.prepare<{ allergen_id: number; severity: string }>(
				'SELECT allergen_id, severity FROM user_allergen WHERE user_id = ?'
			)
			.all(locals.user.id)
			.map((r) => r.allergen_id)
	);

	return {
		welcome: url.searchParams.get('welcome') === '1',
		tree: getAllergenTree(db),
		dietTags: getDietTags(db),
		selected: [...selected]
	};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/auth/login?next=/settings/allergens');

		const form = await request.formData();
		const chosen = form
			.getAll('allergen')
			.map((v) => Number(v))
			.filter((n) => Number.isInteger(n) && n > 0);

		const db = getDb();
		db.transaction(() => {
			// Replace the whole set rather than diffing. An unchecked box must
			// actually remove the allergen, and a form that only ever adds would
			// leave a stale warning the user thought they had turned off.
			db.prepare('DELETE FROM user_allergen WHERE user_id = ?').run(locals.user!.id);

			const now = unixNow();
			for (const id of new Set(chosen)) {
				// The FK does the validation: an id that is not a real allergen
				// throws rather than silently storing rubbish.
				db.prepare(
					'INSERT OR IGNORE INTO user_allergen (user_id, allergen_id, severity, created_at) VALUES (?, ?, ?, ?)'
				).run(locals.user!.id, id, 'avoid', now);
			}
		});

		return { saved: true, count: new Set(chosen).size };
	}
};
