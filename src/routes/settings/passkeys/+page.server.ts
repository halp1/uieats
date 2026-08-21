import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { deleteCredential, listCredentials } from '$lib/server/auth/webauthn';
import { getDb } from '$lib/server/db';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) redirect(303, '/auth/login?next=/settings/passkeys');
	return { credentials: listCredentials(getDb(), locals.user.id) };
};

export const actions: Actions = {
	remove: async ({ locals, request }) => {
		if (!locals.user) redirect(303, '/auth/login?next=/settings/passkeys');

		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		// Scoped to this user inside the query, so a guessed id cannot remove
		// anyone else's key.
		if (!deleteCredential(getDb(), locals.user.id, id)) {
			return fail(404, { message: 'That passkey is no longer on your account.' });
		}

		return { removed: true };
	}
};
