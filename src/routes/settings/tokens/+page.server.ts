import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import {
	MAX_TOKEN_NAME,
	TokenError,
	createApiToken,
	listApiTokens,
	revokeApiToken
} from '$lib/server/auth/tokens';

export const load: PageServerLoad = ({ locals, url }) => {
	if (!locals.user) redirect(303, '/auth/login?next=/settings/tokens');
	return {
		tokens: listApiTokens(getDb(), locals.user.id),
		mcpUrl: `${url.origin}/mcp`,
		maxName: MAX_TOKEN_NAME
	};
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		if (!locals.user) redirect(303, '/auth/login?next=/settings/tokens');

		const name = String((await request.formData()).get('name') ?? '');
		try {
			const { token } = createApiToken(getDb(), locals.user.id, name);
			// Returned once and never again: only its hash is stored.
			return { created: { name: name.trim(), token } };
		} catch (err) {
			if (err instanceof TokenError) return fail(400, { message: err.message, name });
			throw err;
		}
	},

	revoke: async ({ locals, request }) => {
		if (!locals.user) redirect(303, '/auth/login?next=/settings/tokens');

		const id = Number((await request.formData()).get('id'));
		if (!Number.isInteger(id) || !revokeApiToken(getDb(), locals.user.id, id)) {
			return fail(404, { message: 'That token is already gone.' });
		}
		return { revoked: true };
	}
};
