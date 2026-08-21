import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listCredentials } from '$lib/server/auth/webauthn';
import { getDb } from '$lib/server/db';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) redirect(303, '/auth/login?next=/settings');

	const db = getDb();
	return {
		allergenCount: db
			.prepare<{ c: number }>(
				"SELECT COUNT(*) AS c FROM user_allergen ua JOIN allergen a ON a.id = ua.allergen_id WHERE ua.user_id = ? AND a.kind <> 'diet'"
			)
			.get(locals.user.id)!.c,
		dietCount: db
			.prepare<{ c: number }>(
				"SELECT COUNT(*) AS c FROM user_allergen ua JOIN allergen a ON a.id = ua.allergen_id WHERE ua.user_id = ? AND a.kind = 'diet'"
			)
			.get(locals.user.id)!.c,
		favoriteCount: db
			.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM favorite WHERE user_id = ?')
			.get(locals.user.id)!.c,
		passkeyCount: listCredentials(db, locals.user.id).length
	};
};
